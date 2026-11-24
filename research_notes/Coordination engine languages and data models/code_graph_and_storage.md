# Code graph models and embedded storage/query engines for a local coordination engine

Scope: (a) code graph representations and extractors, (b) embedded stores and query languages, for a local-first engine that re-parses on every agent write (tens of ms per file budget), keeps symbol spans/hashes, and answers "which symbols does this write change", "who holds leases/intents on callers of X", "which open branches touch symbols that depend on X".

Method note (read this first): researched 2026-11-24 with web search plus a few page fetches. The GitHub API (`gh`) was not enabled for this session, and direct fetches of aider.chat, glean.software and duckdb.org failed (hosts not allowed in this session's network). Maintenance status therefore comes from search-surfaced pages (cached GitHub pages, news, package indexes), not from live repo metadata. Where a status rests on a single secondary source, it is marked.

## Symbol extraction: tree-sitter, name resolution, edge confidence

### Takeaway
tree-sitter plus each grammar's `queries/tags.scm` is the de facto cheap symbol extractor (GitHub code navigation, Helix, Aider-style repo maps), and incremental reparse after a small edit is reported at roughly 0.1 ms, comfortably inside a tens-of-ms budget. Precise, tool-independent name resolution on top of tree-sitter (GitHub stack-graphs) was archived in September 2025, so a new tool should plan on heuristic name matching with explicit confidence labels, optionally upgraded by a precise indexer where one is available.

### Cited Findings
- `tree-sitter tags` "emits a textual dump of the interesting syntactic nodes in its file argument"; tag queries for a language live at `queries/tags.scm` in the grammar repo and can be tested with `tree-sitter test` (files under `test/tags/`) — [tree-sitter docs: Code Navigation](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html)
- The `tree-sitter-tags` Rust crate exposes `TagsConfiguration` and `TagsContext` to compute tags programmatically; API varies by version — [docs.rs tree-sitter-tags](https://docs.rs/tree-sitter-tags)
- `tags.scm` files are consumed by GitHub code navigation, Helix and the `tree-sitter tags` CLI (third-party crate docs) — [Helix tags guide](https://docs.helix-editor.com/master/guides/tags.html); [github/code-navigation](https://github.com/github/code-navigation) (lists a limited set of supported languages)
- Speed (no official per-file ms table found): Emacs developers' notes say incremental parsing of a few characters of edit "usually takes less than 0.1ms" — [Emacs admin/notes/tree-sitter/performance](https://sources.debian.org/src/emacs/1%3A30.1%2B1-6~bpo12%2B1/admin/notes/tree-sitter/performance)
- A 2020 emacs-devel post cites a presentation claiming a fresh parse of a 20,000-line JS file in 54 ms (secondhand anecdote) — [emacs-devel 2020-01](https://lists.gnu.org/archive/html/emacs-devel/2020-01/msg00341.html)
- gotreesitter (a pure-Go port) publishes its own comparison: native C full parse 1.76 ms, 1-byte incremental edit 102.3 µs, on an undescribed workload (author's own numbers) — [pkg.go.dev gotreesitter v0.9.1](https://pkg.go.dev/github.com/odvcencio/gotreesitter@v0.9.1)
- tree-sitter's CLI benchmark reports throughput per file in bytes/ms with averages and worst cases, filterable by language; it does not measure incremental reparse — [tree-sitter-cli benches/benchmark.rs](https://docs.rs/crate/tree-sitter-cli/latest/source/benches/benchmark.rs)
- github/stack-graphs: archived by the owner on 2025-09-09, read-only, "no longer supported or updated" by GitHub, fork recommended; dual Apache-2.0/MIT — [cached GitHub page via web.archive.org, 2026-06](https://web.archive.org/web/20260601045401/https://github.com/github/stack-graphs); [ecosyste.ms package index](https://packages.ecosyste.ms/api/v1/registries/crates.io/packages/tree-sitter-stack-graphs-java)
- Stack graphs extend Visser et al.'s scope graphs, are designed for incremental, build-tool-independent name resolution, power GitHub code navigation, and are written as tree-sitter-graph rules — [Creager & van Antwerpen, "Stack graphs" (EVCS 2023)](https://drops.dagstuhl.de/entities/document/10.4230/OASIcs.EVCS.2023.8); [arXiv 2211.01224](https://arxiv.org/abs/2211.01224v1); [GitHub blog: Introducing stack graphs](https://github.blog/open-source/introducing-stack-graphs)
- Scope graphs are "a uniform model for name resolution"; Statix is a constraint language for name resolution over scope graphs; query specialization made scope graph resolution up to 7.7x faster — [Zwaan et al., Specializing Scope Graph Resolution Queries, arXiv 2210.06121](https://arxiv.org/abs/2210.06121v1)
- A Rust `scopegraphs` crate exists (v0.2.0) — [docs.rs scopegraphs](https://docs.rs/crate/scopegraphs/0.2.0)

### Inferences
- With an incremental reparse near 0.1 ms and full parses in the low milliseconds for typical files, parsing is not the bottleneck in a tens-of-ms budget; the tags query, hashing spans and the DB write dominate. This needs measuring on Botbench's own files (tree-sitter's bench reports bytes/ms; convert).
- Because stack-graphs is archived and GitHub-only per-language rule sets (tree-sitter-stack-graphs-*) are no longer maintained, the safe design is: definitions and references from `tags.scm` (syntactic, high confidence for definitions), references resolved by name matching scoped by imports where cheap, and each edge labelled with a confidence level (e.g. `exact` from a precise indexer, `import-scoped`, `name-only`). This is my design inference, not a published standard.
- The archived stack-graphs code is still usable as a fork for languages where its rule sets exist, but taking it on means owning it.

### Gaps
- tree-sitter-graph (tree-sitter/tree-sitter-graph) maintenance status: not verified (search did not return the repo itself).
- Exact language coverage counts for tree-sitter grammars and for grammars that ship `tags.scm`: not found.
- No primary, workload-described benchmark of tree-sitter per-file parse time (C library) was found.

## Code index formats: SCIP, LSIF, Kythe, Glean, LSP; cost vs tree-sitter heuristics

### Takeaway
SCIP replaced LSIF at Sourcegraph (LSIF reading removed in Sourcegraph 4.6); SCIP indexers run at about the cost of the compiler's type check, which is minutes for real repos, so they cannot run per agent write. Glean (Meta, Angle over RocksDB, stacked immutable databases for incremental indexing) is the strongest published design for incremental fact stores but is a server system, not an embeddable library. Kythe appears to be in maintenance after 2024 layoffs (single secondary source).

### Cited Findings
- Sourcegraph recommends SCIP over LSIF for new indexers; the `scip` CLI can convert SCIP to LSIF v0.4.3 — [Sourcegraph: SCIP, a better code indexing format than LSIF](https://sourcegraph.com/blog/announcing-scip)
- "Support for reading LSIF-encoded data has been removed as of version 4.6"; migration is destructive — [Sourcegraph docs: LSIF to SCIP migration (4.5 -> 4.6)](https://sourcegraph.com/docs/admin/how-to/lsif_scip_migration)
- SCIP announcement frames incremental indexing ("our backend only needs to index the files that have changed") as a goal "once implemented"; no source confirmed it for scip-typescript — [Sourcegraph: announcing SCIP](https://sourcegraph.com/blog/announcing-scip)
- scip-typescript is built on the TypeScript type checker; indexing "should have roughly similar performance as type checking the codebase with tsc"; Sourcegraph's CI indexing went from ~40 minutes (12 parallel jobs, lsif-node) to ~5 minutes (1 job); a global cache is on by default and raises memory (`--no-global-caches` to disable) — [Sourcegraph: announcing scip-typescript](https://sourcegraph.com/blog/announcing-scip-typescript); [sourcegraph/scip-typescript](https://github.com/sourcegraph/scip-typescript)
- A fork `@anysphere/scip-typescript` is published on npm (Anysphere makes Cursor); its use inside Cursor is not documented in what I found — [unpkg @anysphere/scip-typescript README](https://unpkg.com/@anysphere/scip-typescript@0.3.15/README.md)
- Sourcegraph deprecated Language Server (LSP) based code intelligence in August 2021 in favour of precomputed indexes — [Sourcegraph: We're deprecating Language Server support](https://about.sourcegraph.com/blog/deprecating-lsp)
- Glean: open-sourced by Meta in 2021; collects facts about source code and serves them through Angle, "a declarative logic-based query language" — [Meta Engineering, Dec 2024: Glean open source code indexing](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)
- Glean storage is RocksDB; incremental indexing targets O(changes) rather than O(repository), bounded by fanout, via "stacked immutable databases" (layered additions/hides queried as one logical DB) — secondary summary of Meta's post: [sysdesign-wiki: Indexing code at scale with Glean](https://sysdesign-wiki.pages.dev/sources/2025-01-01-meta-indexing-code-at-scale-with-glean/); [stacked immutable databases](https://sysdesign-wiki.pages.dev/concepts/stacked-immutable-databases/) (unverified against the primary incremental-indexing post)
- Kythe: "pluggable, (mostly) language-agnostic ecosystem for building tools that work with code" — [Google Open Source Blog 2015](https://opensource.googleblog.com/2015/01/kythe-new-approach-to-making-developer.html?m=0); the US Google Kythe team was reportedly laid off in April 2024 and replaced with an India-based maintenance team — [Wikipedia: Google Kythe](https://en.wikipedia.org/wiki/Google_Kythe) (single secondary source, citing TechCrunch); mailing list still active with user questions in 2025 — [kythe Google Group](https://groups.google.com/g/kythe)

### Inferences
- For "every agent write, tens of ms", precise indexers (SCIP, Kythe, Glean indexers) are out of the hot path; they could run as an optional background pass (per branch or on idle) whose edges overwrite heuristic edges with `exact` confidence. SCIP is the most practical format to ingest because it is a single protobuf file per index and has indexers for many languages.
- Glean's stacked immutable databases map well onto "one layer per branch/worktree over a base commit", which is directly relevant to "which open branches touch symbols that depend on X". The idea can be reproduced in SQLite with a `layer`/`branch` column plus tombstones, without adopting Glean.

### Gaps
- Current release cadence of Kythe and Glean in 2026: not verified.
- Whether scip-python and others support incremental indexing: not found.
- Zed's and Cursor's indexing internals: no public primary source found. Codeium/Windsurf: not researched (no source found).

## Embedded stores and query languages: status and fit

### Takeaway
SQLite (WAL: concurrent readers, one writer; recursive CTEs for traversal) is the low-risk default and fits Botbench's existing `node:sqlite`, zero-runtime-dependency constraint. DuckDB is analytics-first with a single read-write process. The embedded graph database most often recommended, Kuzu, was archived in October 2025 after Apple acquired the company; CozoDB upstream appears dormant since 2024 with a community fork. Datalog engines (Datafrog, Ascent, Soufflé) are libraries/compilers for analysis, not stores.

### Cited Findings
- SQLite WAL: "writers and readers can run at the same time. However, since there is only one WAL file, there can only be one writer at a time"; some obscure cases can still return SQLITE_BUSY; old readers can block checkpoints — [sqlite.org: Write-Ahead Logging](https://www.sqlite.org/wal.html)
- SQLite recursive CTEs are the way to query trees/graphs; the recursive table must appear exactly once in the recursive SELECT's FROM; recursive SELECTs may not use aggregate or window functions; rows are produced and discarded rather than materialising the full result — [sqlite.org: The WITH clause](https://sqlite.org/lang_with.html)
- Without indexes on source and target columns, every CTE step becomes a full table scan — [sqlite-graph crate docs](https://docs.rs/crate/sqlite-graph/0.1.0)
- DuckDB: one process can read and write; within it, multiple writer threads use MVCC plus optimistic concurrency (second conflicting writer to the same row fails); other processes only in READ_ONLY; writing from multiple processes "is not supported automatically and is not a primary design goal"; the 1.5/2.0 docs describe a "Quack" protocol for multi-process access (beta in 1.5.2) and DuckLake with PostgreSQL catalog — [DuckDB docs: Concurrency (current/LTS)](https://duckdb.org/docs/current/connect/concurrency); [DuckDB 2.0 docs](https://duckdb.org/docs/2.0/connect/concurrency) (docs versions disagree on Quack maturity)
- Kuzu: repo archived 2025-10-10 with final release 0.11.3, "working on something new" — [The Register, 2025-10-14: KuzuDB abandoned](https://www.theregister.com/2025/10/14/kuzudb_abandoned/); Apple acquired Kuzu Inc. (deal reported as 2025-10-09; disclosed via EU filing Feb 2026) — [BetaKit](https://betakit.com/apple-strikes-deal-to-acquire-canadian-database-software-startup-kuzu/); [University of Waterloo](https://uwaterloo.ca/computer-science/news/waterloo-based-graph-database-start-up-kuzu-acquired-apple); [heise](https://heise.de/-11177751)
- Kuzu forks: RyuGraph (crate `ryugraph` 25.9.1) — [docs.rs ryugraph](https://docs.rs/crate/ryugraph/25.9.1); LadybugDB is claimed as a continuation only in a forum post (unverified) — [Julia Discourse](https://discourse.julialang.org/t/kuzudb-or-general-graphdbs/133139); ArcadeDB published a migration guide — [ArcadeDB blog](https://arcadedb.com/blog/from-kuzudb-to-arcadedb-migration-guide/)
- CozoDB: DBDB.io lists end year 2024, repo "not updated since 2024", considered abandoned (secondary) — [dbdb.io: CozoDB](https://dbdb.io/db/cozodb); last upstream feature release v0.7 (MinHash-LSH, FTS, JSON) — [cozodb/cozo README](https://raw.githubusercontent.com/cozodb/cozo/main/README.md); community fork `cozo-ng` continues from 0.7.6 (engine crate 0.12.2, SQLite/RocksDB backends) — [docs.rs cozo-ng](https://docs.rs/crate/cozo-ng/0.12.2)
- DDlog (differential-datalog): repo moved to `vmware-archive` org; a community fork `ddlog-dev/differential-datalog` exists — [ecosyste.ms: vmware-archive/differential-datalog](https://awesome.ecosyste.ms/projects/github.com%2Fvmware-archive%2Fdifferential-datalog); [ddlog-dev](https://github.com/ddlog-dev). No explicit deprecation notice found.
- Datafrog: embeddable Rust Datalog engine with no runtime; Polonius (Rust borrow checker in Datalog) runs on it — [rust-lang/datafrog](https://github.com/rust-lang/datafrog); [Polonius book](https://rust-lang.github.io/polonius/print.html); Frank McSherry's June 2025 Datalog-in-Rust post says they "aren't going to start from datafrog" but reuse its ideas — [McSherry blog 2025-06-03](https://github.com/frankmcsherry/blog/blob/master/posts/2025-06-03.md)
- Ascent: Rust Datalog via procedural macros; Polonius reimplemented in Ascent within ~1-4x of the Datafrog version with half the code; comparable to Datafrog and Soufflé (Soufflé compiles Datalog to C++) — [Sahebolamri et al., CC 2022](https://s-arash.github.io/ascent/cc22main-p95-seamless-deductive-inference-via-macros.pdf)
- Salsa: on-demand incremental computation (red-green algorithm, durability levels, early cutoff/backdating) behind rust-analyzer; before durability, any change to `src/lib.rs` re-checked std-library queries costing about 300 ms — [rust-analyzer blog: Durable Incrementality (2023)](https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html); [rustc-dev-guide: How Salsa works](https://rustc-dev-guide.rust-lang.org/salsa.html); [docs.rs salsa 0.28](https://docs.rs/salsa/=0.28.1/)

### Inferences
- Botbench's own rules (zero server runtime dependencies, Node 24 `node:sqlite`) already pick SQLite; every alternative here adds a native dependency, and the two graph-native embedded options (Kuzu, Cozo) are archived or dormant upstream, which is a costly-to-reverse risk.
- Salsa/Adapton and Datalog engines are Rust libraries; for a Node server they would mean a native addon. The useful ideas (early cutoff by content hash, durability tiers: vendored deps rarely change) can be applied directly: skip re-deriving edges when a symbol's span hash is unchanged.

### Gaps
- Oxigraph, SurrealDB embedded, Neo4j embedded (JVM), LMDB/RocksDB users: not researched within budget; no status claims made.
- Soufflé's and Ascent's 2026 release status: not verified.
- Adapton status: not found.
- CodeQL QL: not researched (it is a whole-database, build-time analysis; not a per-write engine).

## Data model for leases + append-only log + code graph; recursive CTE vs graph DB benchmarks

### Takeaway
No independent benchmark of SQLite recursive CTEs versus graph databases for 2-5 hop traversals at 10^5-10^6 edges was found; the only numbers are a competitor's self-published benchmark showing SQLite slower at 4 hops and timing out beyond it. A relational model in one SQLite file is the best fit for mixing transient leases, an append-only event log and a code graph, because all three share transactions; blast-radius depth should be bounded (2-3 hops) and measured on real repos.

### Cited Findings
- CongraphDB's self-published benchmark: SQLite recursive CTE ~10-13 ms at 4 hops versus 2-5 ms for CongraphDB, Neo4j, Kuzu, Graphology; lists "4-hop max before timeouts" for SQLite (vendor-run, methodology unverified) — [CongraphDB benchmark: SQLite](https://congraph-ai.github.io/congraphdb-benchmark/engines/sqlite); [traversal results](https://congraph-ai.github.io/congraphdb-benchmark/results/traversal)
- A practitioner write-up describes replacing Neo4j with SQLite recursive CTEs for an application graph (anecdotal, no controlled benchmark) — [DEV: SQLite as a graph database](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai)
- sqlitegraph crate ships Criterion k-hop (1-3 hop) benchmarks comparing SQLite and native backends; no published results found — [sqlitegraph benches/k_hop.rs](https://docs.rs/crate/sqlitegraph/3.3.1/source/benches/k_hop.rs)
- SQL/PGQ (graph queries in relational systems) is an active research direction — [arXiv 2505.07595](https://arxiv.org/html/2505.07595v1) (only the introduction was surfaced)

### Inferences
- Recursive CTE pitfalls that matter for blast radius: cycles in call graphs (use `UNION` not `UNION ALL`, or carry a depth limit), fan-out explosion through hub symbols (cap depth and rank), and no aggregation inside the recursion (aggregate outside). A materialised `reverse_deps` closure table per symbol is an option if measured CTE latency is too high, at the cost of write amplification on every parse.
- Leases with TTLs, an append-only log and graph edges in one SQLite DB let "who holds leases on callers of X" be one join over a CTE result inside one read transaction; split stores (graph DB + SQLite) would lose that atomicity.
- Datalog facts are the most expressive model for transitive "depends on" rules, but an embedded engine would be an extra dependency; SQLite recursive CTEs are semi-naive Datalog for linear rules, which covers these queries.

### Gaps
- A controlled 2-5 hop benchmark at 10^5-10^6 edges: not found; must be generated locally (the Botbench rule "nothing fake" implies running it on real repository graphs).

## How comparable tools store code graphs

### Takeaway
The small-tool pattern in 2025-2026 is tree-sitter extraction into SQLite exposed over MCP (codewiki, Treelines, optave codegraph). Cork's public README does not disclose its parser or store. Aider uses tree-sitter tags plus personalised PageRank (secondhand sources only, aider.chat unreachable here). Larger systems use precise indexes (Sourcegraph SCIP, Glean on RocksDB, rust-analyzer in-memory Salsa, GitHub stack-graphs now archived).

### Cited Findings
- Cork (corkcli/cork): "the coordination layer for multiplayer coding agents" for Claude Code, Codex, Cursor; hooks, MCP server, CLI, skills; local data in `~/.cork/local` served on `127.0.0.1`; hooks send "names, signatures, docstrings, who calls what, a hash per line"; "Writes that would clash are held"; a `blast_radius` MCP tool "from the same code graph the hooks keep"; engine built with Cargo; MIT for hooks/core/protocol/plugin/skills, FSL-1.1-MIT for the engine; 19 commits, 1 star at fetch time. The README does not mention tree-sitter, SQLite, or confidence-labelled edges, so those claims in the brief are unverified — [github.com/corkcli/cork](https://github.com/corkcli/cork)
- Note: when signed in, Cork's hooks "parse each file on your machine and send its structure" (i.e. structure leaves the machine in that mode) — [github.com/corkcli/cork](https://github.com/corkcli/cork)
- codewiki: local SQLite knowledge graph of functions/classes with typed edges (calls, imports) via MCP — [0xsyncroot/codewiki](https://github.com/0xsyncroot/codewiki); Treelines: Go/Python/Rust symbols and relationships in SQLite — [rpcarvs/treelines](https://github.com/rpcarvs/treelines); optave codegraph: tree-sitter into SQLite, MCP — [optave/ops-codegraph-tool wiki](https://github.com/optave/ops-codegraph-tool/wiki)
- Aider repo map: tree-sitter tag queries per language, a directed graph of definitions/references, personalised PageRank biased to files being edited (secondhand: a proposal issue in another project and a reimplementation spec) — [NousResearch/hermes-agent#535](https://github.com/NousResearch/hermes-agent/issues/535); [repo-mapper SPEC](https://docs.rs/crate/repo-mapper/0.0.1/source/SPEC.md); [RepoMapper](https://github.com/Cryect/RepoMapper)
- GitHub code navigation: stack-graphs for precise navigation (now archived), `tags.scm` for search-based navigation — [GitHub blog](https://github.blog/open-source/introducing-stack-graphs); [github/code-navigation](https://github.com/github/code-navigation)
- rust-analyzer: Salsa incremental query database in memory — [rust-analyzer blog](https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html)

### Inferences
- Recommendation for Botbench (inference from all sections):
  1. Extractor: tree-sitter with grammar `tags.scm` (vendor the query files, list in NOTICE), run on every agent write; store per symbol: id, file, kind, name, qualified name, byte/line span, content hash of the span. A write changes exactly the symbols whose span hash differs or whose span intersects the edited range.
  2. Edges: `references` from tags, resolved by name with import scoping, each with `confidence` (`exact` | `scoped` | `name`) and `source` (`tags` | `scip`); optional background SCIP ingest upgrades edges to `exact`.
  3. Store: one SQLite file (WAL, STRICT tables), tables `symbol`, `edge(src, dst, kind, confidence)` with indexes on both ends, `lease`/`intent` (holder, symbol, expires_at), append-only `event` log, plus `branch_touch(branch, symbol, base_sha)` per worktree, Glean-style layered over the base commit.
  4. Queries: bounded recursive CTE (depth 2-3, cycle-safe) for blast radius, joined to leases/intents and branch_touch in one read transaction; measure p95 on real repos before considering a closure table.
  5. Avoid: Kuzu (archived), CozoDB upstream (dormant), stack-graphs (archived) as hard dependencies; DuckDB only if analytics on the event log later justify a second, read-only store.
- Heuristic edges will over-report (same-name collisions) and under-report (dynamic dispatch); showing confidence on every edge keeps "blast radius" honest.

### Gaps
- Cork's actual parser/store/edge schema (needs reading `core/` and `protocol/` source, not done).
- Zed's code index, Cursor's/Codeium's indexing internals: no public primary sources found.
- Aider's own repo map docs (aider.chat) could not be fetched in this session; the host must be allowed to verify.
