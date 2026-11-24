# Build the hook native, keep one store

For a from-scratch Botbench coordination engine, the per-tool-call hook must be a native binary. In a local benchmark, C, Rust and Go hooks did the full stdin-to-socket-to-stdout round trip in **about 1.0-1.3 ms p50 and 2.1-3.2 ms p99**. Node 22 took **21-25 ms p50 and 30-35 ms p99**, and CPython 3.13 took **18-20 ms p50 and 29-38 ms p99**, so both miss a 25 ms p99 budget. Bun fits only when written against Bun-native APIs (about **11 ms p50, 18 ms p99**). The warm daemon is not where languages differ: every runtime answered small unix-socket requests with **sub-millisecond p99**, so memory, ecosystem and distribution decide that layer. My recommendation is **Rust across the hook, daemon, stdio MCP server and CLI**. Rust is the only ecosystem where tree-sitter is current (0.27.2), SQLite can be bundled statically, the hook is a 320 KB binary, and the most comparable tools (Codex CLI, Cork's engine, apparently Grok Build) made the same choice. The cost is development speed, and an MCP SDK that was not Tier 1 at the latest spec release.

The data model I recommend is **one local SQLite file** holding four things: the append-only event log (the source of truth), leases acquired as whole key sets in one `BEGIN IMMEDIATE` transaction with the event sequence as fencing token, git-derived change records, and a confidence-labelled symbol graph queried with bounded recursive CTEs. Work intents sit outside that file: each developer publishes them in a **single-writer log on their own git ref**, with no CRDT. That layout leaves three things unproven: macOS and Windows behaviour, whether GitHub accepts custom ref namespaces, and how fast graph traversals are on real repositories. A short list of measurements should settle them before anything is committed.

**How the evidence is graded.** Every figure tagged **LOCAL-2026-11-24** is a measurement made for this research. It ran on one Linux cloud VM (Xeon 2.30 GHz, 4 vCPU, 16 GB, kernel 6.18), with 300 spawns per variant, against a trivial Python daemon. **None of it was run on macOS or Windows**, and Deno, Zig and Node SEA were not installed. The benchmark sources are in `research_notes/Coordination engine languages and data models/bench/`. All other figures are published or vendor claims and are cited as such.

The session's network blocked a number of primary sources: modelcontextprotocol.io, developers.openai.com, cursor.com, docs.x.ai, bun.com, antonz.org, discord.com, tmdevlab.com, martin.kleppmann.com, git-scm.com, jj-vcs.github.io, aider.chat, glean.software and duckdb.org. The GitHub API was also unavailable. Several findings therefore come from search snippets, mirrors or secondary summaries, and the report flags them where they occur.

## The 25 ms hook budget eliminates Node and Python

Every agent CLI researched uses the same hook model: **spawn a process per event, pass JSON on stdin, read a JSON decision on stdout, and treat exit code 2 as a block**. That covers Claude Code ([hooks reference](https://code.claude.com/docs/en/hooks)), Gemini CLI ([docs](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md)), Cursor and Codex (those last two from snippets only). Grok Build even reads Claude Code's and Cursor's hook files ([docs.x.ai snippet](https://docs.x.ai/build/features/hooks)). Process start-up is therefore paid on every governed tool call, and it is the one place the language choice is decided by physics rather than taste.

| Hook variant (LOCAL-2026-11-24, n=300) | p50 ms | p99 ms | On disk | Peak RSS |
|---|---|---|---|---|
| C, static glibc | 0.99 | 2.47 | 786 KB | 0.7 MB |
| Go, `CGO_ENABLED=0` | 1.21 | 2.14 | 2.4 MB | 2.9 MB |
| Rust, std only, LTO, stripped | 1.25 | 3.17 | 320 KB | 2.0 MB |
| Bun `--compile`, Bun-native APIs | 10.94 | 17.94 | 104 MiB | 23-25 MB |
| Bun `--compile`, node-style `net` + stdin stream | 20.73 | 30.25 | 104 MiB | 23-25 MB |
| CPython 3.13 `-S -I` | 18.13 | 29.10 | n/a | 12.5 MB |
| Node 22, `readFileSync(0)` + `net` | 21.39 | 30.37 | n/a | 37-38 MB |
| `sh -c` wrapping the C hook | 2.06 | 3.28 | — | — |

The native rows leave **about 20 ms of a 25 ms budget** for real daemon work. Bun is the surprise. Its hello world starts in about 3 ms (LOCAL), but the same hook written with Node-compatible APIs costs twice as much as the Bun-native version. Inside Bun, the choice of API matters as much as the choice of runtime. Older published tables point the same way, with C, Rust and Go well under 1 ms and Node and Python in the tens of milliseconds ([bdrung/startup-time, 2018](https://github.com/bdrung/startup-time); [chocolateboy/startup-time](https://www.github.com/chocolateboy/startup-time)). Packaged Python is worse still: PyInstaller onefile is reported at about 150 ms per launch ([pistack.xyz, blog-grade](https://www.pistack.xyz/posts/2026-09-10-python-executable-packaging-pyinstaller-nuitka-cxfreeze-comparison/)). A Deno 2.9 cold start of 17 ms is a third-party claim, not confirmed against Deno's release notes ([byteiota](https://byteiota.com/deno-2-9-deno-desktop-ships-cold-startup-hits-17ms/)).

Three details of the hook contract shape the design:

- **Use exec form.** Claude Code runs a hook's `command` through `sh -c` unless `args` is set. Setting `args` makes it spawn the binary directly ([hooks reference](https://code.claude.com/docs/en/hooks)), and that saves about 1 ms (LOCAL: 2.06 ms vs 1.04 ms).
- **Fail closed on purpose.** A PreToolUse hook that times out does not block unless `"onFailure": "block"` is set ([hooks reference](https://code.claude.com/docs/en/hooks)). The other CLIs are inconsistent on failure:
  - Gemini CLI treats non-JSON output as allow.
  - Grok reportedly lets the action through when a hook crashes or times out (unverified).
  - Cursor has documented bugs in both directions, including a UTF-8 BOM on Windows stdin that makes guards silently allow ([Cursor forum](https://forum.cursor.com/t/on-windows-cursor-s-hook-stdin-json-payload-includes-a-utf-8-bom-that-breaks-standard-json-parse-causing-security-guards-to-silently-degrade-to-allowing-commands-across-all-agent-channels/166794)).

  "Broker failure = deny" therefore needs its own backstop for each CLI. The hook binary alone cannot guarantee it.
- **Avoid the spawn where possible.** Claude Code also offers an `http` hook type and `if` matchers, which avoid spawning at all for that CLI ([hooks reference](https://code.claude.com/docs/en/hooks)). The native shim is still needed for every other CLI.

On macOS, the first launch of a new or re-signed binary triggers syspolicyd's notarization check and an XProtect/YARA scan ([Eclectic Light](https://eclecticlight.co/2025/03/26/how-macos-sequoia-launches-an-app/); [mjtsai](https://mjtsai.com/blog/2025/04/30/why-some-apps-sometimes-launch-extremely-slowly/)). Tools installed from a signed installer package are checked once, at install time ([Apple Developer Forums](https://developer.apple.com/forums/thread/706379)). The practical rule is to ship stable, signed and notarized arm64 builds through a pkg installer and never re-sign them in place. A 104 MiB Bun binary also gives that malware scan far more to read than a 320 KB Rust binary does. That last point is an inference; it was not measured.

## Daemons tie on latency, so ecosystem decides

In the LOCAL daemon test, a client made 50,000 sequential requests, each on a new unix connection with about 140 B of JSON and a lock-map insert. **Go answered at 100 µs p50 / 248 µs p99, Node 22 at 53/185 µs, and Bun at 49/170 µs.** Every runtime shared the same ~3.3 ms maximum, which points to VM noise. Bun's p99.9 was the worst at 1.06 ms. Memory separated the runtimes more than latency did: **Go held 10 MB of RSS, against 49-55 MB for Node and Bun**. No Rust daemon and no concurrent or fsync-bound load were measured. Garbage collection is not a deciding factor at the scale of a lock table. Go's worst-case pauses have been under 100 µs since 2016 ([golang-dev](https://groups.google.com/g/golang-dev/c/Ab1sFeoZg_8)). Discord's well-known Go latency spikes came from a large LRU heap on a 2019-era collector, and the source for that was read only through snippets ([Discord blog](https://discord.com/blog/why-discord-is-switching-from-go-to-rust)). What will actually dominate daemon latency is the SQLite commit with fsync, which nobody has measured yet.

With latency a wash, the libraries decide, and they differ sharply by language:

| Need | Rust | Go | TypeScript (Node/Bun) | Python |
|---|---|---|---|---|
| MCP SDK | `rmcp` 3.11.0; spec 2026-07-28 only "in beta" at release, not Tier 1 | Official go-sdk v1.8.0, Tier 1 | Official 1.32.2, Tier 1 | `mcp` 2.3.0, Tier 1 |
| tree-sitter | 0.27.2, the core's own binding | Official cgo binding stuck at v0.24.0 (2024-10); pure-Go `gotreesitter` young | `web-tree-sitter` WASM 0.27.2 current; native addon 0.25.1 lags | 0.27.0 |
| SQLite | `rusqlite` 0.43.0, can bundle statically | cgo `mattn` (breaks easy cross-compile) or pure-Go `modernc` (10%-2x slower writes) | `node:sqlite`, `bun:sqlite`, `better-sqlite3` 13.2.0 | stdlib |
| git | `gix` 0.91.0 (push still unfinished per latest evidence), `git2` 0.21.0 | `go-git` v5.19.3 | `isomorphic-git` 1.44.19 | `pygit2` 1.21.0 |

Sources for the table: [MCP blog 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/); registry pages for [rmcp](https://crates.io/crates/rmcp), [go-sdk](https://proxy.golang.org/github.com/modelcontextprotocol/go-sdk/@latest), [TS SDK](https://registry.npmjs.org/@modelcontextprotocol/sdk), [tree-sitter crate](https://crates.io/crates/tree-sitter), [go-tree-sitter](https://proxy.golang.org/github.com/tree-sitter/go-tree-sitter/@latest), [web-tree-sitter](https://registry.npmjs.org/web-tree-sitter), [rusqlite](https://crates.io/crates/rusqlite), [modernc vs mattn](https://notes.billmill.org/blog/2024/09/Comparing_golang_sqlite_to_C_sqlite.html), [gix](https://crates.io/crates/gix), [gitoxide README](https://docs.rs/crate/gitoxide/0.49.0/source/README.md) and [go-git](https://proxy.golang.org/github.com/go-git/go-git/v5/@latest).

Go's problem is a combination. Its headline advantage is trivial static cross-compilation, which holds only with `CGO_ENABLED=0`. The two libraries this engine leans on hardest, tree-sitter and fast SQLite, both pull Go back to cgo or to slower, younger pure-Go ports. Git matters less than it looks, because the engine should **push only through the `git` binary** in every language. That keeps credentials with git, as Botbench requires, and follows the precedent of jj and Turborepo. That precedent is background knowledge that was not re-verified in this session.

For MCP, the 2026-07-28 spec dropped the initialize handshake and session ids ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)). A stateless stdio server comes down to newline-delimited JSON-RPC with `tools/list` and `tools/call`, which is a few hundred lines in any language. That makes Rust's weaker SDK tier a manageable risk rather than a blocker. The one published multi-language MCP benchmark measured HTTP rather than stdio and could only be read through a mirror ([TM Dev Lab via mirror](https://hn.jakechampion.name/reader/https://www.tmdevlab.com/mcp-server-performance-benchmark.html)), so it does not bear on this choice.

Comparable tools mostly chose Rust, but not all of them:

- **Codex CLI** rewrote from TypeScript to Rust to drop the Node 22+ requirement and to get a native sandbox and lower memory ([InfoQ](https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite)).
- **Cork**, the closest analogue (hooks, an MCP server, a `blast_radius` tool and held clashing writes), builds its engine with Cargo ([corkcli/cork](https://github.com/corkcli/cork)).
- **Grok Build** appears to be Rust, judging by its `crates/` paths. That is an inference from the repository layout.
- **Claude Code stayed on TypeScript** and ships as a Bun executable; Anthropic bought Bun ([Anthropic](https://www.anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone)).
- **Gemini CLI** is TypeScript on npm ([npm](https://registry.npmjs.org/@google/gemini-cli)).
- **Microsoft chose Go for the TypeScript compiler port**, for line-by-line fidelity to a cyclic, garbage-collected codebase ([The New Stack](https://thenewstack.io/microsoft-typescript-devs-explain-why-they-chose-go-over-rust-c/)).

That last rationale does not apply here, because nothing is being ported. Turborepo's move from Go to Rust was justified by sharing a Rust ecosystem ([Vercel](https://vercel.com/blog/turborepo-migration-go-rust)), which matches an engine built around tree-sitter much more closely. It also came with the warning that the port stalled feature work for about 15 months ([summary of Theo](https://rosetta.to/u/t3dotgg/was-porting-to-rust-a-mistake)).

Zig is excluded. It is pre-1.0, 0.16.0 shipped a breaking I/O redesign in April 2026, and there is no committed 1.0 date ([Zig 0.16.0 notes](https://ziglang.org/download/0.16.0/release-notes.html); [JetBrains](https://blog.jetbrains.com/blog/2026/06/05/why-zig-isn-t-1-0-yet/)).

The strongest alternative to all-Rust is **TypeScript on Bun for the daemon, MCP server and CLI, plus a roughly 300-line Rust or C hook shim**. That keeps the Tier 1 MCP SDK, current WASM tree-sitter and `bun:sqlite`, and moves faster. In exchange it ships two languages and a 104 MiB runtime per platform, and the daemon uses about 5x more memory than Go's in the LOCAL test. It is the right pick if development speed outranks a single small toolchain. The research does not settle that trade-off, because no source measured how well AI assistants write each language.

## Every record type gets the simplest model its writer count allows

The guiding idea is that a record with one writer never needs a merge algorithm. The table below gives each record its model, and the paragraphs after it explain the less obvious choices.

| Record | Scope | Model | Ordering / identity | Main caveat |
|---|---|---|---|---|
| Mutation lease | One machine, atomic | SQLite `lease` table; whole key set acquired in one `BEGIN IMMEDIATE` transaction | Fencing token = event-log sequence of the grant | Expiry relies on the wall clock; sleep or resume can outlive the TTL |
| Work intent | Shared across machines, advisory | Per-device single-writer log on `refs/botbench/intents/<device-id>`, fast-forward only | HLC per record; staleness shown as "seen N min ago, as of fetch at T" | Freshness is bounded by fetch interval; publishing needs an owner rule change |
| Optional exclusivity (later) | Shared | Create-only claim refs via `git push --force-with-lease=<ref>:`; `--atomic` for several areas | Claim commit sha as fencing token | Only as available as the remote; GitHub support unverified |
| Change record | Derived per machine | Recomputed from fetched refs, never replicated | `change-id` header, then `Change-Id:` trailer, then `git patch-id` | A plain `git rebase` outside Botbench drops the ids |
| Event log | Local source of truth | Append-only SQLite table (seq PK, HLC, kind, JSON payload); everything else is a projection | Integer sequence | Snapshots deferred until replay cost is measured |

**Leases** need fencing, not just TTLs. A lease alone cannot guarantee mutual exclusion, because a stalled holder can outlive its expiry. Safety comes from a strictly increasing token that the protected resource checks on every write. Kleppmann argues this ([Kleppmann, via search summary](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)), and etcd's own lock example concedes it ([etcd contrib/lock](https://chromium.googlesource.com/external/github.com/coreos/etcd/+/HEAD/contrib/lock/)). Locally, the hazard is a laptop sleeping, not clock skew between machines. The committer should therefore re-check the token in the same transaction that records the result.

The transaction type matters. A plain deferred transaction that reads and then writes can fail with `SQLITE_BUSY` when it upgrades to a writer, and `busy_timeout` does not help in that case ([taskchampion PR #412](https://github.com/GothenburgBitFactory/taskchampion/pull/412); [SQLite docs](https://www3.sqlite.org/lang_transaction.html)). `BEGIN IMMEDIATE` takes the write lock up front. Checking and writing the whole key set under that lock makes acquisition all-or-nothing and deadlock-free. Because the daemon is the only writer, SQLite's one-writer limit under WAL ([sqlite.org](https://www.sqlite.org/wal.html)) costs nothing. A local process can also check a holder's liveness directly, by pid plus process start time, which no distributed lock service can do.

**Intents** need no CRDT. CRDTs earn their cost when several writers edit the same object concurrently ([Shapiro et al., SSS 2011](https://link.springer.com/doi/10.1007/978-3-642-24550-3_29)). When each developer writes only their own intents, the global view is a union of single-writer logs, and each log merges by fast-forward. That is the shape git-bug uses with commit chains under `refs/bugs/*` and Lamport clocks ([git-bug model](https://www.github.com/MichaelMure/git-bug/blob/master/doc/model.md)), and Hypercore uses for signed append-only logs ([Hypercore](https://cdn.jsdelivr.net/gh/holepunchto/hypercore@main/README.md)). Using one ref per device avoids the fetch-merge-retry loop that a shared git-notes ref would force on concurrent pushers.

Hybrid logical clocks give both a causal order and a human-readable time ([Kulkarni et al.](https://www.cse.buffalo.edu//~demirbas/publications/hlc.pdf)). They do not remove clock skew; CockroachDB simply assumes a 500 ms bound ([Cockroach Labs](https://cockroachlabs.com/blog/living-without-atomic-clocks/)). An honest staleness display therefore uses the reader's own receive time, and treats any timestamp far in the future as suspect.

The CRDT libraries are not a reason to deviate. Automerge 3 and Loro 1.x are healthy, but cr-sqlite looks stalled upstream ([cr-sqlite releases](https://github.com/vlcn-io/cr-sqlite/releases)). None of them is needed unless multi-writer documents appear.

**Exclusivity** can reuse the git remote as its arbiter. `--force-with-lease=<ref>:` with an empty expected value is a create-only compare-and-swap that the remote executes, and `--atomic` makes a multi-ref push all-or-nothing ([git-push man page](https://manpages.debian.org/trixie/git-man/git-push.1.en.html)). Together they turn any git remote into a linearizable claim arbiter, with no Botbench server to run.

Two cautions apply to any cross-machine publishing. First, pushing refs that are not a task's own branch is a new data flow leaving the machine. Under the current hard rules, it needs an explicit owner setting, a rule change and a STRIDE entry. Second, the optional low-latency relay can be a dumb WebSocket fan-out of signed, end-to-end-encrypted per-device entries. Ink & Switch's Keyhive and Beelay target this problem but are still research ([Keyhive](https://www.inkandswitch.com/project/keyhive/)), and even with encryption the relay sees metadata ([Naisho](https://github.com/SerenityNotes/naisho)). The git refs stay authoritative either way.

**Change records** key a change across rebases with the `change-id` commit header that jj and GitButler standardised and Gerrit reads ([Gerrit design doc](https://www.gerritcodereview.com/design-docs/support-jujutsu-solution.html)). Botbench commits in its own worktrees, so it can write that header on every commit it makes. The local event log can copy jj's lesson: writes need no lock, and when two heads diverge, the tool surfaces the divergence instead of silently picking one ([jj concurrency.md](https://sources.debian.org/src/jujutsu/0.37.0-2/docs/technical/concurrency.md)).

## The code graph belongs in that same SQLite file

On the extraction side, tree-sitter with each grammar's `queries/tags.scm` is the standard cheap symbol extractor. It is what GitHub code navigation, Helix and Aider-style repository maps use ([tree-sitter docs](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html)). Incremental reparse after a small edit is reported at **under 0.1 ms** ([Emacs tree-sitter notes](https://sources.debian.org/src/emacs/1%3A30.1%2B1-6~bpo12%2B1/admin/notes/tree-sitter/performance)), so parsing is not what consumes a budget of tens of milliseconds per write. The tags query, hashing the spans and the database write are, and none of the three has been measured.

Precise cross-file name resolution is the gap. GitHub's stack-graphs, the one tool-independent option, was **archived on 2025-09-09** ([archived repo](https://web.archive.org/web/20260601045401/https://github.com/github/stack-graphs)). Precise indexers such as SCIP run at roughly the cost of a type check ([Sourcegraph](https://sourcegraph.com/blog/announcing-scip-typescript)), far too slow to run on every write. The workable design is to treat definitions from tags as reliable and resolve references by import-scoped name matching. **Every edge carries a confidence label**: `exact` from an optional background SCIP pass, `scoped` for import-scoped matches, and `name` for name-only matches. That keeps blast-radius answers honest about the cases where heuristic edges over-report (same-name collisions) and under-report (dynamic dispatch).

On storage, the graph-native embedded options are a reversibility risk:

- **Kuzu** was archived in October 2025 after Apple acquired the company ([The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/)).
- **CozoDB** upstream has been dormant since 2024 ([dbdb.io](https://dbdb.io/db/cozodb)).
- **DuckDB** allows only one read-write process ([DuckDB docs](https://duckdb.org/docs/current/connect/concurrency)).

Keeping the graph in the same SQLite file as leases, intents and the event log has a concrete payoff. A question such as "who holds leases on callers of X, and which open branches touch them" becomes **one recursive CTE joined to the lease and branch tables inside one read transaction**. That cross-store atomicity disappears if the graph moves to a separate database. Branches can be stored the way Glean layers its databases: one row set per worktree, stacked over a base commit, with tombstones for removed facts ([summary of Glean's design](https://sysdesign-wiki.pages.dev/concepts/stacked-immutable-databases/), secondary). The traversal needs indexes on both ends of every edge and a hard depth limit of two or three hops, and it must be cycle-safe, using `UNION` rather than `UNION ALL` ([sqlite.org WITH clause](https://sqlite.org/lang_with.html)).

The only number on SQLite's traversal speed is a competitor's self-published benchmark. It shows SQLite at about **10-13 ms at four hops, timing out beyond that** ([CongraphDB benchmark](https://congraph-ai.github.io/congraphdb-benchmark/engines/sqlite)). Treat it as a reason to measure on real repositories, not as a verdict. Small tools in this space (codewiki, Treelines, optave codegraph) already pair tree-sitter with SQLite behind MCP ([codewiki](https://github.com/0xsyncroot/codewiki)), which is weak but consistent precedent.

## Conclusion

The question splits more cleanly than expected. Only the hook is latency-critical, and it is decided by measurement: native or nothing. The daemon's latency is equal across runtimes, so the rest of the stack is decided by ecosystem. On ecosystem, Rust's current tree-sitter and statically bundled SQLite outweigh Go's simpler cross-compile, which cgo undoes, and TypeScript's faster development. The data model ends up less exotic than the problem sounds. No CRDT, graph database or consensus service is needed, because every record either has a single writer or can borrow an arbiter that already exists: SQLite's write lock locally, and the git remote's ref compare-and-swap across machines.

The real remaining risks are measurements nobody has taken, not design questions. Before committing, run eight checks:

1. **macOS and Windows hooks.** Measure the hook round trip on macOS arm64 with a signed and notarized pkg, including the first launch after install. On Windows, measure it over named pipes or AF_UNIX.
2. **Combined binary versus separate shim.** Find out whether one combined Rust binary, with grammars linked, still starts in about 1 ms, or whether the hook should be its own slim binary.
3. **Lease contention.** Measure the daemon's `BEGIN IMMEDIATE` lease-set acquire with fsync at p99, under parallel hooks.
4. **Per-write indexing.** Time parse, tags, span-hash and write per file on Botbench-sized and larger repositories.
5. **Blast-radius queries.** Measure the p95 of a two- and three-hop blast-radius CTE on real repository graphs.
6. **Custom refs on real remotes.** In a throwaway repository, check whether GitHub and GitLab accept `refs/botbench/*`, create-only `--force-with-lease`, `--atomic`, deletes, and large ref counts.
7. **MCP server start.** Measure the stdio MCP server's cold start and `tools/call` latency with `rmcp` against a hand-written server.
8. **Release pipeline.** Prove a reproducible cross-compile and signing pipeline for all six macOS, Linux and Windows targets (arm64 and x64), for example with cargo-zigbuild. That route is itself unverified.

If the first two checks go badly for Rust, or the owner rates development speed above a single toolchain, fall back to a Bun TypeScript daemon behind a native shim. Nothing in the data model changes if that happens.
