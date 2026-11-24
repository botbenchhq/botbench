# Ecosystem maturity and precedent for a local-first coordination engine (Rust, Go, TypeScript, Python, Zig)

Research date: 2026-11-24. Registry figures (versions, dates, download counts) were pulled live this day from crates.io, registry.npmjs.org, pypi.org and proxy.golang.org. The GitHub API was not available to this session, and these hosts could not be reached (outside the session's network allowlist): modelcontextprotocol.io, developers.openai.com, geminicli.com, cursor.com, docs.x.ai, devclass.com, tmdevlab.com. Claims about those pages come from search snippets and are marked as such. Items marked **[background, not re-verified]** are well-known facts from prior knowledge that were not re-fetched this session.

## MCP SDKs: official SDKs, maturity, spec version, transports, benchmarks, hand-written feasibility

### Takeaway
The current spec is **2026-07-28**, the largest revision since launch: the core is now stateless, with no initialize handshake and no session id. TypeScript, Python, Go and C# are the Tier 1 SDKs and supported it at release. Rust (`rmcp`) supported it only "in beta" at release, but `rmcp` is now at 3.11.0 and releases often. No published benchmark compares languages over stdio. For a local stdio server the language matters much less than process start-up and transport design.

### Cited Findings
- Spec 2026-07-28 was released on 2026-07-28. "MCP is transforming from a bidirectional stateful protocol into a request/response stateless protocol." The `initialize`/`initialized` exchange and the `Mcp-Session-Id` header are retired. Streamable HTTP now requires the `Mcp-Method`/`Mcp-Name` headers. Multi Round-Trip Requests replace server-initiated elicitation, sampling and roots. List results carry `ttlMs`/`cacheScope`. Tasks move into an extension, Roots, Sampling and Logging are deprecated, and legacy HTTP+SSE gets a one-year off-ramp — [MCP blog, 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- Tier 1 SDKs at release, all speaking 2026-07-28: **TypeScript, Python, Go, C#**. Rust supported the new spec "in beta" and is not listed as Tier 1. The previous spec was 2025-11-25 — [MCP blog, 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- Deprecated methods keep working in this release and in every spec version published within a year of it. The release has breaking changes and a formal extensions track, with MCP Apps as the first official extension — [search summary of MCP blog RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/); [AAIF migration post](https://aaif.io/blog/mcp-2026-07-28-whats-changing-and-how-to-migrate); [Claude blog](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
- The blog post fetched here does not say how stdio is affected. Stdio is a transport, so dropping the handshake should simplify it, but that is inference — [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- Latest versions as of 2026-11-24 (live registry queries):
  - TypeScript `@modelcontextprotocol/sdk`: **1.32.2**, published 2026-10-23, first published 2024-11-11 — [npm](https://registry.npmjs.org/@modelcontextprotocol/sdk)
  - Python `mcp`: **2.3.0**, 2026-10-02 — [PyPI](https://pypi.org/pypi/mcp/json). The third-party `fastmcp` is at **4.2.5** (2026-11-23) — [PyPI](https://pypi.org/pypi/fastmcp/json)
  - Rust `rmcp`: **3.11.0**, updated 2026-11-17, about 54.4M downloads — [crates.io](https://crates.io/crates/rmcp)
  - Go `github.com/modelcontextprotocol/go-sdk`: **v1.8.0**, 2026-09-04 — [Go proxy](https://proxy.golang.org/github.com/modelcontextprotocol/go-sdk/@latest). The third-party `mark3labs/mcp-go` is at **v1.6.0** (2026-11-18) — [Go proxy](https://proxy.golang.org/github.com/mark3labs/mcp-go/@latest)
  - The Java SDK has its own docs and blog site at java.sdk.modelcontextprotocol.io — [Java SDK blog](https://java.sdk.modelcontextprotocol.io/latest/blog/)
- Benchmarks:
  - A TM Dev Lab multi-language MCP benchmark, as summarised by search, reports average latency of 0.835 ms for Java and 0.855 ms for Go, both above 1,600 req/s. Node.js and Python were 10–30x slower; Python on single-worker uvicorn averaged 26.45 ms at 292 req/s. It appears to be an HTTP test (k6 over a Docker bridge), not stdio. The page could not be fetched to confirm — [TM Dev Lab via reader mirror](https://hn.jakechampion.name/reader/https://www.tmdevlab.com/mcp-server-performance-benchmark.html)
  - A Java SDK blog post (2026-02-15) claims "Java leads MCP server performance benchmarks with sub-millisecond latency." It is vendor self-reporting and was not fetched — [Java SDK blog](https://java.sdk.modelcontextprotocol.io/latest/blog/2026/02/15/java-leads-mcp-server-performance-benchmarks-with-sub-millisecond-latency/)
  - Stacklok compared transports with the same server in Kubernetes. By a secondary summary, stdio P50 was 145 ms against 108 ms for HTTP/SSE, and stdio collapsed under concurrency (process per connection) — [Stacklok on dev.to](https://dev.to/stacklok/performance-testing-mcp-servers-in-kubernetes-transport-choice-is-the-make-or-break-decision-for-1ffb)
  - Tool: `mcpbench` drives concurrent JSON-RPC over stdio or HTTP and reports p50/p95/p99 — [pkg.go.dev](https://pkg.go.dev/github.com/JSLEEKR/mcpbench@v1.0.0)

### Inferences
- **A hand-written server is reasonable for stdio.** Under 2026-07-28 a server needs JSON-RPC 2.0 framing (newline-delimited JSON on stdio), `tools/list`, `tools/call` and possibly `resources/*`, with no handshake state. That is a few hundred lines in any language. The costs are tracking spec churn (two breaking revisions in about 8 months: 2025-11-25 and 2026-07-28) and the auth and Streamable HTTP work you would need later for a relay. An official Tier 1 SDK (TS, Python, Go) carries that churn for you. Rust's `rmcp` lagged at the spec change.
- For a local stdio server that the agent CLI starts once per session, throughput figures do not matter. What matters is cold start (milliseconds for a native binary, against tens to hundreds of milliseconds for Node or Python start-up) and how long the server holds memory.

### Gaps
- Kotlin, C#, Java, Swift, Ruby and PHP SDK versions and tiers beyond what the blog states. GitHub releases and modelcontextprotocol.io/docs/sdk were blocked.
- No primary-source stdio latency comparison across languages exists that I could find.
- The exact word count or page count of the 2026-07-28 spec could not be checked.

## tree-sitter bindings per language, and stack-graphs / tree-sitter-graph

### Takeaway
Rust (the core's own bindings) and Node's WASM `web-tree-sitter` track the core in lockstep at 0.27.2, and Python's py-tree-sitter is at 0.27.0. The official Go bindings have not been tagged since v0.24.0 (2024-10). A pure-Go reimplementation, `gotreesitter`, exists and is active, but its maturity is unproven. `stack-graphs` is Rust-only and **archived by GitHub (2025-09-09)**. `tree-sitter-graph` has not been released since 2024-12.

### Cited Findings
- Rust `tree-sitter` **0.27.2** (2026-11-07), about 59.8M downloads — [crates.io](https://crates.io/crates/tree-sitter)
- Node: `web-tree-sitter` (WASM) **0.27.2** (2026-11-07), released the same day as the core. The native `tree-sitter` npm binding is **0.25.1** (2026-07-28), two minors behind — [npm web-tree-sitter](https://registry.npmjs.org/web-tree-sitter); [npm tree-sitter](https://registry.npmjs.org/tree-sitter)
- Python `tree-sitter` **0.27.0** (2026-11-23) — [PyPI](https://pypi.org/pypi/tree-sitter/json)
- Go:
  - The official `github.com/tree-sitter/go-tree-sitter` latest tag is **v0.24.0** (2024-10-14). It uses cgo — [Go proxy](https://proxy.golang.org/github.com/tree-sitter/go-tree-sitter/@latest)
  - The older `smacker/go-tree-sitter` was last updated 2024-08-27 — [Go proxy](https://proxy.golang.org/github.com/smacker/go-tree-sitter/@latest)
  - The cgo-free `github.com/odvcencio/gotreesitter` is at **v0.58.0** (2026-11-20). Its approach (pure-Go port, or a WASM runtime) and its grammar coverage were not verified — [Go proxy](https://proxy.golang.org/github.com/odvcencio/gotreesitter/@latest)
  - `malivvan/tree-sitter` (WASM via wazero, by name) v0.0.1 dates from 2025-01 — [Go proxy](https://proxy.golang.org/github.com/malivvan/tree-sitter/@latest)
- `stack-graphs` crate **0.14.1**, last released 2024-12-13. The GitHub repo was archived on Sep 9, 2025: "This repository is no longer supported or updated by GitHub… we recommend you fork it" — [crates.io](https://crates.io/crates/stack-graphs); [archived repo page](https://github.com/github/stack-graphs); [GitHub blog intro](https://github.blog/open-source/introducing-stack-graphs). The design paper is [EVCS 2023](https://drops.dagstuhl.de/entities/document/10.4230/OASIcs.EVCS.2023.8)
- `tree-sitter-graph` crate **0.12.0**, last released 2024-12-11 — [crates.io](https://crates.io/crates/tree-sitter-graph)
- Zig: tree-sitter is a C library, and Zig calls C directly with `@cImport`. The core's build has shipped a `build.zig` for some time **[background, not re-verified]**. I found no dedicated, maintained Zig binding package.

### Inferences
- Rust is the only language where you get the core API, the newest version and the (abandoned) stack-graphs tooling together. Anyone who needs cross-file name resolution should plan to fork stack-graphs or build lighter tags or queries-based resolution, in any language.
- In Go the choice is a cgo binding that lags upstream or a young pure-Go port. In Node, the WASM build is current and avoids native addon ABI problems, at some cost to parse speed (unmeasured here).

### Gaps
- No parse-speed benchmark of WASM against native, or of gotreesitter against cgo, was found this session.

## SQLite bindings per language and WAL notes

### Takeaway
Every candidate has a mature SQLite path. Rust (`rusqlite`, `sqlx`), Go (cgo `mattn`, pure-Go `modernc`, WASM-based `ncruces`), Node (`node:sqlite` built in, `better-sqlite3`, `bun:sqlite`), and Python's standard-library `sqlite3`. Pure-Go modernc costs roughly 10% to 2x on throughput, worst on inserts.

### Cited Findings
- Rust: `rusqlite` **0.43.0** (2026-11-15, about 165M downloads); `sqlx` **0.9.1** (2026-11-18, about 198M downloads) — [crates.io rusqlite](https://crates.io/crates/rusqlite); [crates.io sqlx](https://crates.io/crates/sqlx)
- Go:
  - `mattn/go-sqlite3` **v1.14.53** (2026-11-05, cgo) — [Go proxy](https://proxy.golang.org/github.com/mattn/go-sqlite3/@latest)
  - `modernc.org/sqlite` **v1.63.0** (2026-11-22, pure Go, translated from C) — [Go proxy](https://proxy.golang.org/modernc.org/sqlite/@latest)
  - `ncruces/go-sqlite3` **v0.38.0** (2026-11-21) — [Go proxy](https://proxy.golang.org/github.com/ncruces/go-sqlite3/@latest)
- Go performance:
  - One comparison measured inserts at 1380 ms for mattn against 4148 ms for modernc, and queries at 1036 ms against 966 ms — [billmill.org, 2024-09](https://notes.billmill.org/blog/2024/09/Comparing_golang_sqlite_to_C_sqlite.html)
  - A summary of that pure-Go translation puts it at "between twice as slow and 10% slower" — [billmill.org](https://notes.billmill.org/blog/2024/09/Comparing_golang_sqlite_to_C_sqlite.html)
  - Benchmark suites: [cvilsmeier/go-sqlite-bench](https://github.com/cvilsmeier/go-sqlite-bench), [ncruces/go-sqlite-bench](https://github.com/ncruces/go-sqlite-bench). The second is run by a driver author, so it is directional only.
- Node: `better-sqlite3` **13.2.0** (2026-11-14) — [npm](https://registry.npmjs.org/better-sqlite3). `node:sqlite` is built into Node and `bun:sqlite` into Bun **[background, not re-verified; node:sqlite's stability status in Node 24+ not checked]**. Botbench itself already runs on `node:sqlite` under Node 24+ (its CLAUDE.md).
- Python: `sqlite3` is in the standard library **[background]**.
- WAL **[background, not re-verified]**: one writer at a time with many concurrent readers, across processes on one host. It needs shared memory, so it does not work on network filesystems. Use `busy_timeout` and short write transactions.

### Inferences
- A daemon that owns the database and serialises writes behind one connection gets around WAL's single-writer limit in every language. The driver choice then matters little, except that Go must trade cgo (cross-compiling) against pure Go (about 2x slower writes).

### Gaps
- I found no recent (2026) comparison of node:sqlite, better-sqlite3 and bun:sqlite.

## Git libraries vs shelling out

### Takeaway
`gix` (gitoxide) is fast-moving and broad, but by the latest evidence it **still lacks push**. `git2`/libgit2 is complete but is a C dependency. `go-git` v5 is mature, with v6 in beta. `isomorphic-git` is active. For observation (status, log, refs, worktrees) the libraries are fine. For writes that must match the user's git exactly (hooks, credentials, worktrees, config), shelling out to `git` is the precedent.

### Cited Findings
- `gix` **0.91.0** (2026-11-22, about 58.6M downloads) — [crates.io](https://crates.io/crates/gix). The 0.49.0 README checklist shows `[ ] push` unchecked while status and commit are checked, and older `crate-status.md` lists push as unfinished. No 2026 statement was found — [docs.rs gitoxide README](https://docs.rs/crate/gitoxide/0.49.0/source/README.md); [crate-status.md](https://github.com/Byron/gitoxide/blob/c8bef2c39d4a6f8f547422405eb1827d520ea96d/crate-status.md)
- `git2` (libgit2 bindings) **0.21.0** (2026-10-06, about 130M downloads) — [crates.io](https://crates.io/crates/git2). Python `pygit2` **1.21.0** (2026-11-04) — [PyPI](https://pypi.org/pypi/pygit2/json)
- `go-git` v5 **v5.19.3** (2026-10-04); v6 **v6.0.0-beta.1** (2026-10-04) — [Go proxy v5](https://proxy.golang.org/github.com/go-git/go-git/v5/@latest); [v6](https://proxy.golang.org/github.com/go-git/go-git/v6/@latest)
- `isomorphic-git` **1.44.19** (2026-11-23) — [npm](https://registry.npmjs.org/isomorphic-git)
- Precedent **[background, not re-verified]**: jj (Jujutsu) uses gitoxide for much of its git backend and has historically shelled out to `git` for push and fetch. Turborepo and Botbench shell out to `git`.

### Inferences
- For a coordination engine: read with a library (or `git` plumbing with `--porcelain=v2 -z`), and push only through the `git` binary. That keeps credentials with git, as Botbench's hard rules require.

### Gaps
- I did not verify current gix push status from `crate-status.md` on main, or go-git's worktree support. GitHub was blocked.

## File watching

### Takeaway
All ecosystems have a maintained watcher. Rust `notify` 9.0.0 (2026-11-21), Go `fsnotify` v1.10.1 (2026-05), Node `chokidar` 6.0.0 (2026-10) and `@parcel/watcher` 2.6.0 (2026-07, native, with a Watchman backend), and Watchman's `fb-watchman` client 2.0.4.

### Cited Findings
- Rust `notify` **9.0.0** (2026-11-21, about 207M downloads) — [crates.io](https://crates.io/crates/notify)
- Go `fsnotify` **v1.10.1** (2026-05-04) — [Go proxy](https://proxy.golang.org/github.com/fsnotify/fsnotify/@latest)
- Node `chokidar` **6.0.0** (2026-10-19); `@parcel/watcher` **2.6.0** (2026-07-20); `fb-watchman` **2.0.4** (2026-10-09) — [npm chokidar](https://registry.npmjs.org/chokidar); [npm @parcel/watcher](https://registry.npmjs.org/@parcel/watcher); [npm fb-watchman](https://registry.npmjs.org/fb-watchman)
- **[background, not re-verified]** fsnotify does not watch recursively on Linux (inotify works per directory). `notify` and `@parcel/watcher` handle recursion. Watchman is C++ with a Rust client crate, and Sapling and Buck use it.

### Gaps
- No 2026 comparison of watcher reliability or CPU use was gathered.

## What comparable tools chose and why (including migration post-mortems)

### Takeaway
The agent CLIs split. Codex moved from TypeScript to Rust (mid-2025) to drop the Node requirement and for its sandbox, security and memory. Claude Code stayed on TypeScript but ships as a Bun single-file binary, and Anthropic bought Bun (2025-12). Gemini CLI is TypeScript on npm. Developer tooling has largely moved to Rust (Turborepo Go to Rust, ruff, uv, Biome, oxc, Zed, jj). Microsoft chose Go over Rust for the TypeScript compiler port, for port fidelity and garbage collection.

### Cited Findings
- **Codex CLI.** Announced around June 2025 as "Codex CLI is Going Native" by maintainer Fouad Matin. Reasons reported:
  - No Node v22+ requirement ("frustrating or a blocker for some")
  - Security, with a native Linux sandbox
  - Performance, and memory without garbage collection
  - A wire protocol so extensions can be written in other languages
  - Codex acting as both MCP client and server

  The TS version was "easy to whip up". The sources are secondary: the primary GitHub discussion was not fetched — [InfoQ](https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite); [heise](https://heise.de/-10425172); [DevClass](https://www.devclass.com/ai-ml/2025/06/02/nodejs-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/1619589). It is still distributed on npm as `@openai/codex` **0.172.0** (2026-11-24), first published 2025-04-16 — [npm](https://registry.npmjs.org/@openai/codex)
- **Claude Code.** Distributed as a Bun executable. Anthropic announced the Bun acquisition on 2025-12-02, saying the collaboration "directly drove" the native installer — [Anthropic](https://anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone); [Bun blog](https://bun.sh/blog/bun-joins-anthropic); [Simon Willison](https://simonwillison.net/2025/Dec/2/anthropic-acquires-bun/). npm `@anthropic-ai/claude-code` is at **2.1.331** (2026-11-23) — [npm](https://registry.npmjs.org/@anthropic-ai/claude-code)
- **Gemini CLI.** TypeScript on npm, `@google/gemini-cli` **0.71.1** (2026-11-24), first published 2025-06-25 — [npm](https://registry.npmjs.org/@google/gemini-cli)
- **Grok Build (xAI).** The repo path `xai-org/grok-build/crates/codegen/...` suggests a Rust codebase (inference from the path) — [grok-build docs (raw)](https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)
- **Turborepo, Go to Rust.** March 2023: Go "began to underserve" the project as it grew and merged with Turbopack. Rust's ecosystem allows "safe interfacing with native C libraries" and a good internal developer experience. Vercel chose an incremental port (from 1.7) over a rewrite, because rewrites halt feature work. It later announced the port finished — [Vercel: why migrating](https://vercel.com/blog/turborepo-migration-go-rust); [how porting](https://vercel.com/blog/how-turborepo-is-porting-from-go-to-rust); [continued](https://vercel.com/blog/how-we-continued-porting-turborepo-to-rust); [finished](https://vercel.com/blog/finishing-turborepos-migration-from-go-to-rust). Criticism: Theo (t3.gg) said "in these 15 months no meaningful features were shipped" — [summary](https://rosetta.to/u/t3dotgg/was-porting-to-rust-a-mistake). A claimed 2026 CEO remark that the ROI was "controversial" is **unverified** — [secondary](https://www.besthub.dev/articles/vercel-ceo-turborepo-go-rust-migration-roi-controversial-ai-agents-change-the-calculus-15ea3c0ed87c)
- **TypeScript native port (Project Corsa, typescript-go).** Go was chosen over Rust and C# because:
  - Go is the lowest-level language that still has a garbage collector
  - The compiler relies on cyclic data structures that Rust's borrow checker resists
  - The codebase is functions and structs, so a line-by-line port works
  - A Rust rewrite would take years; the Go port delivered about 10x sooner

  Ryan Cavanaugh: Rust meets its own goals, but "easy porting from this JavaScript codebase" was not one of them — [The New Stack](https://thenewstack.io/microsoft-typescript-devs-explain-why-they-chose-go-over-rust-c/); [InfoQ](https://www.infoq.com/news/2025/05/new-typescript-compiler-10x-fast); [DevClass](https://www.devclass.com/development/2025/03/12/typescript-compiler-ported-to-native-code-c-faithful-ask-why-go-was-used/1622506)
- **Cork (corkcli).** A coordination layer for coding agents: a live shared semantic map, hooks for Claude Code, Codex, Cursor and Hermes, and a remote MCP server. Installed with `npx corkcli` or a curl script. It claims "53% fewer tokens with 12 agents" (self-reported). Its implementation language was **not found**; the brief's "Rust" is unverified — [mcpservers.org listing](https://mcpservers.org/servers/corkcli)
- **[background, not re-verified]**
  - Rust: Zed, ripgrep, Jujutsu, Biome, oxc, ruff and uv, plus Deno (Rust with V8)
  - Go: esbuild
  - Zig: Bun
  - Mixed: Sapling (Rust, Python and C++); Watchman (C++ server, Rust client crate)

### Inferences
- For a hook shim spawned on every tool call, the Codex and Claude Code precedent points to one self-contained native binary with no runtime install. Rust, Go, Zig or a Bun-compiled binary all give that. Bun binaries are large and start slower than Rust or Go, though that is unmeasured here.
- The TypeScript port shows Go wins when the job is porting an existing GC-heavy, cyclic codebase. Turborepo shows Rust wins when the tool shares code with a Rust ecosystem (Turbopack, tree-sitter, gix). A new coordination engine that depends on tree-sitter and git resembles the second case more.

### Gaps
- No primary Codex announcement text. GitHub and developers.openai.com were blocked.
- I could not confirm Cursor's implementation language, or any first-party reason for Gemini CLI's TypeScript choice.

## Hook APIs per agent CLI (invocation and spawn cost)

### Takeaway
All five CLIs use the same model: **spawn a command per event, pass JSON on stdin, read a JSON decision on stdout, exit code 2 = block.** Grok Build even reads Claude Code and Cursor hook files. Every PreToolUse/BeforeTool call therefore costs one process spawn, which favours a tiny native shim that forwards to a resident daemon over the unix socket.

### Cited Findings
- **Claude Code**:
  - `command` hooks spawn one process per matching event (`sh -c`, or exec form with `args`). Input is JSON on stdin: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, plus `tool_name`, `tool_input` and `tool_use_id` for tool events. Matching hooks run in parallel.
  - Types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
  - Default timeout is 600 s for command, http and mcp_tool (30 s on UserPromptSubmit and model-switch events, 10 s on MessageDisplay), 30 s for prompt, 60 s for agent.
  - Exit codes: 0 means stdout is parsed as JSON; 2 blocks, with stderr as the reason; any other code is a non-blocking error. PreToolUse returns `hookSpecificOutput.permissionDecision` ∈ {allow, deny, ask, defer}.
  - `async: true` and `asyncRewake` run hooks in the background. About 33 events, including PreToolUse, PostToolUse, PostToolBatch, FileChanged and WorktreeCreate.
  - An `http` hook type exists, so a daemon could receive hooks with no spawn at all.

  Source: [code.claude.com hooks](https://code.claude.com/docs/en/hooks)
- **Codex CLI**: hooks live in `hooks.json` or inline `[hooks]` tables in `config.toml`, found next to active config layers. `timeout` is in seconds, default 600 s for most hooks; SessionEnd defaults to 1 s (max 3 s). PreToolUse examples set `"timeout": 30`. From search snippets; the page itself was not reachable — [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks)
- **Gemini CLI**:
  - 11 lifecycle events: session start and end, before and after the agent loop, before and after model calls, before and after tool use, before compression, notifications. The CLI runs each matching hook's command and waits for all of them.
  - Matchers are regex for tool events. Hooks are configured in `settings.json` at project, user, system and extension level. Default timeout is 60,000 ms.
  - Stdout must be pure JSON: non-JSON output defaults to *allow*. Exit codes: 0 means JSON is parsed; 2 is a "system block" with stderr as the reason; others are a warning.

  Source: [gemini-cli docs/hooks/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md)
- **Cursor**:
  - Hooks live in `.cursor/hooks.json` (project) or `~/.cursor/hooks.json`. JSON goes in on stdin and comes back on stdout, e.g. `beforeShellExecution` with `"command"`.
  - The timeout unit is ambiguous: the official example shows `"timeout": 30`, while a third-party reference says milliseconds.
  - Reported bugs: a UTF-8 BOM on stdin on Windows breaks `JSON.parse` and makes guards fail open; remote Linux workspaces get empty stdin; hooks silently hard-deny in Git Bash on Windows (2026-09).

  Sources: [cursor docs (snippet)](https://cursor.com/docs/agent/hooks); [BOM bug](https://forum.cursor.com/t/on-windows-cursor-s-hook-stdin-json-payload-includes-a-utf-8-bom-that-breaks-standard-json-parse-causing-security-guards-to-silently-degrade-to-allowing-commands-across-all-agent-channels/166794); [empty stdin](https://forum.cursor.com/t/pretooluse-hook-fires-with-empty-stdin-on-remote-linux-workspace-preventing-hooks-from-rewriting-shell-commands-e-g-rtk/164951); [Windows Git Bash](https://forum.cursor.com/t/hooks-never-run-in-cursor-agent-cli-on-windows-git-bash-the-failure-becomes-a-silent-hard-deny-still-repro-on-2026-09-02/170945); [GitButler deep dive](https://blog.gitbutler.com/cursor-hooks-deep-dive)
- **Grok Build (xAI)**:
  - Hooks live in `~/.grok/hooks/*.json` and `<project>/.grok/hooks/*.json`. It also reads `.claude/settings.json` and `.cursor/hooks.json` (including Cursor's camelCase event names).
  - PreToolUse decides via JSON on stdout. Environment variables: `GROK_HOOK_EVENT`, `GROK_HOOK_NAME`, `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT`. Project hooks need trust (`/hooks-trust` or `--trust`).
  - By secondary sources, a crash or timeout lets the action through (fail-open). That is unverified.

  Sources: [docs.x.ai hooks (snippet)](https://docs.x.ai/build/features/hooks); [flaviocopes glossary](https://flaviocopes.com/ai-glossary/hooks/). Note that `superagent-ai/grok-cli` is a different, community project.

### Inferences
- The spawn cost recurs on every tool call. A Rust, Go or Zig shim starts in a few milliseconds; a Node or Python shim takes tens to over a hundred milliseconds of runtime start-up per call. These are typical figures, not measured here, and worth measuring before choosing. Claude Code's `http` hook type removes the spawn for that one CLI.
- Fail-open behaviour differs: Gemini allows on bad output, Grok reportedly allows on timeout, and Cursor has documented fail-open and fail-closed bugs. A coordination engine cannot assume its hook denial is enforced uniformly, and a "deny on failure" design such as Botbench's needs a backstop per CLI.

### Gaps
- Codex's hook stdin schema and decision format, Cursor's timeout unit and full event list, and Grok's exit codes and default timeout could not be confirmed from primary pages. Those hosts were blocked.
- No published measurement of hook spawn overhead per CLI was found.
