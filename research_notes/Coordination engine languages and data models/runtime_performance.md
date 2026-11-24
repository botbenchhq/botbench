# Runtime performance of candidate languages for a hook binary plus a warm local daemon

Scope: (a) a process spawned on every coding-agent tool call (read small JSON on stdin, one unix-socket round trip to a local daemon, print JSON, exit; budget about 10-25 ms p99 end to end), and (b) a long-lived local daemon answering small unix-socket requests with an in-memory lock table. Researched 2026-11-24.

**About the sources.** Few published benchmarks put all candidates on one machine, and most public startup tables are years old. So this file adds a **local measurement made for this note** ("LOCAL-2026-11-24"). It ran in a Linux cloud VM: Intel Xeon @ 2.30 GHz, 4 vCPU, 16 GB, kernel 6.18, Ubuntu 24.04 userland. Toolchains were gcc 13.3, rustc 1.97.0, go 1.24.7, Node v22.23.5, Bun 1.4.4 and CPython 3.13.18. Deno and Zig were not installed, and nothing was measured on macOS. The scripts are in `/tmp/claude-0/-home-user/6cf8aea9-845a-5a3c-9b51-54fc3be56b32/scratchpad/bench/`. That scratchpad is temporary, so copy it into the repo if the numbers need to stay reproducible.

Method:
- A Python harness `posix_spawn`s each hook 300 times after 10 warm-up runs.
- It writes a roughly 170-byte Claude-Code-shaped PreToolUse JSON to stdin and reads stdout to EOF. Each run is checked for the expected answer.
- Times are wall clock from spawn to `wait4`.
- The daemon for the hook test is a single-threaded Python unix-socket server. It adds the same small cost to every row.

Some hosts were blocked by the session network, so these sources could not be read directly: antonz.org, bun.com and discord.com. Facts about them come from search snippets, and the notes say so where it applies.

## 1. Process cold start (hello world and the hook shape), macOS-specific costs

### Takeaway
On Linux, a native hook (C, Rust, Go) does the full round trip in about 1-1.3 ms p50 and 2-3 ms p99. That is one to two orders of magnitude inside the budget.
- Bun is about 3 ms for hello world. It reaches 11-14 ms p50 and 18-19 ms p99 for the hook, but only with Bun-native APIs. With node-style `net` and stdin streams it is 21-23 ms p50 and 29-38 ms p99.
- Node 22 is about 21 ms p50 for hello world and 21-25 ms p50 and 30-35 ms p99 for the hook. That fails a 25 ms p99 budget on this machine.
- CPython 3.13 is about 18-20 ms p50 and 29-38 ms p99.

On macOS the first run of a new or re-signed binary can add a one-time Gatekeeper/syspolicyd cost. Later runs of the same binary are cheaper.

### Cited Findings
- **LOCAL-2026-11-24, hook round trip (stdin JSON, then unix socket, then stdout, then exit), ms, n=300:**

  | Variant | mean | p50 | p95 | p99 | max |
  |---|---|---|---|---|---|
  | C (gcc -O2, dynamic glibc) | 1.13 | 1.04 | 1.48 | 2.70 | 4.17 |
  | C (static glibc) | 1.03 | 0.99 | 1.29 | 2.47 | 3.10 |
  | Rust (std only, LTO, panic=abort, stripped) | 1.35 | 1.25 | 1.76 | 3.17 | 6.25 |
  | Go (CGO_ENABLED=0, encoding/json, -s -w) | 1.26 | 1.21 | 1.58 | 2.14 | 2.60 |
  | Bun `bun run`, node `net` + stdin stream | 24.51 | 23.35 | 32.77 | 37.83 | 38.82 |
  | Bun `--compile`, node `net` + stdin stream | 22.05 | 20.73 | 28.59 | 30.25 | 31.77 |
  | Bun `--compile`, `readFileSync(0)` + node `net` | 18.55 | 17.33 | 25.22 | 28.97 | 29.73 |
  | Bun `--compile`, `Bun.stdin.text()` + `Bun.connect` | 11.37 | 10.94 | 14.58 | 17.94 | 25.90 |
  | Bun `bun run`, `Bun.stdin.text()` + `Bun.connect` | 13.74 | 13.03 | 17.29 | 18.66 | 23.49 |
  | Node 22, stdin stream + `net` | 25.28 | 24.41 | 31.29 | 34.76 | 35.87 |
  | Node 22, `readFileSync(0)` + `net` | 22.07 | 21.39 | 27.27 | 30.37 | 32.33 |
  | Node 22 + `NODE_COMPILE_CACHE` (via `sh` wrapper, so about +1 ms of shell) | 26.94 | 26.09 | 33.66 | 37.33 | 39.18 |
  | CPython 3.13 | 20.88 | 19.94 | 28.68 | 38.09 | 60.28 |
  | CPython 3.13 `-S -I` | 18.97 | 18.13 | 24.65 | 29.10 | 35.66 |
  | `/bin/sh -c <C hook>` (Claude Code's default shell form) | 2.16 | 2.06 | 2.81 | 3.28 | 4.36 |

  — local measurement, this note.
- **LOCAL-2026-11-24, hello world (print and exit), ms, n=200:**
  - C: p50 0.85, p99 1.40.
  - Go: p50 1.01, p99 4.84, with one 18.5 ms outlier that is probably VM noise.
  - `bun run`: p50 3.31, p99 4.95.
  - Bun `--compile`: p50 3.00, p99 8.40.
  - Node 22: p50 20.58, p99 30.22.
  - CPython 3.13: p50 10.30, p99 20.02.
  - CPython `-S -I`: p50 7.00, p99 10.42.

  — local measurement, this note.
- **Observation, LOCAL:** Bun's hello world is about 3 ms, but its node-compat `net` plus stdin-stream hook is about 21-23 ms. The Bun-native API version is about 11 ms. The language choice inside Bun matters as much as the runtime choice.
- **Observation, LOCAL:** Claude Code's default shell form (`sh -c`) adds about 1 ms p50 to a native hook (2.06 ms vs 1.04 ms). Exec form (`args`) avoids that — see section 7.
- **Older published tables, for context only:**
  - bdrung/startup-time, 2018-02-10, Intel Core i5-2400S, Ubuntu 17.10: C (gcc 7.2) 0.26 ms; Rust 1.21 0.51 ms; Go 1.8.3 0.41 ms; Python 3.6.3 25.84 ms (9.31 ms with `-S`); Python 2.7 9.43 ms. On a Raspberry Pi 3, Python 3 was 197.79 ms. — [bdrung/startup-time](https://github.com/bdrung/startup-time)
  - chocolateboy/startup-time hello world (date and hardware not captured; search snippet only): C 0.38 ms, Rust 0.64 ms, Go 0.88 ms, Deno 14.53 ms, Python 3 22.46 ms, Node.js 41.70 ms. — [chocolateboy/startup-time](https://www.github.com/chocolateboy/startup-time)
  - A hyperfine run of `bun run` on a trivial script gave 6.3 ms ± 0.7 ms (setup unspecified, gist). — [colinhacks gist](https://gist.github.com/colinhacks/436b6836cd13291a79dd50dcde2d45bf)
- **Deno:** a third-party report says Deno 2.9 (June 2026) cut cold startup from 34 ms to 17 ms. This is unconfirmed against Deno's release notes. — [byteiota](https://byteiota.com/deno-2-9-deno-desktop-ships-cold-startup-hits-17ms/); Deno's 2.9 notes claim "startup time" gains without a number in the snippet — [Deno 2.9 blog](https://deno.com/blog/v2.9)
- **Deno vendor benchmark:** Deno reports Express-app cold start in a GCP VM about 33% faster than Bun and 36% faster than Node (vendor claim; the workload differs from a hook). — [Deno blog: AWS Lambda coldstart benchmarks](https://deno.com/blog/aws-lambda-coldstart-benchmarks)
- **pkg project, single Linux x64 setup, hello world:** pkg binary 71 MB, 40 ms; Bun `--compile` 96 MB, 10 ms. — [yao-pkg: pkg vs Bun vs Deno](https://yao-pkg.github.io/pkg/guide/vs-bun-deno)
- **Python packagers:**
  - One Linux benchmark measured PyInstaller `--onefile` at about 150 ms vs about 36 ms for onedir, which is about 114 ms of unpack overhead per launch. Nuitka onefile was about 50 ms.
  - Nuitka standalone (folder) mode has no unpack step.
  - Sources are blog-grade. — [pistack.xyz comparison (2026-09-10)](https://www.pistack.xyz/posts/2026-09-10-python-executable-packaging-pyinstaller-nuitka-cxfreeze-comparison/); [PyInstaller discussion #8456](https://github.com/pyinstaller/pyinstaller/discussions/8456); [Nuitka user manual](https://pypi.org/project/Nuitka/)
- **macOS first-launch checks:**
  - On first launch, syspolicyd checks the notarization ticket online through CloudKit, while an XProtect/YARA malware scan runs. — [Eclectic Light: How macOS Sequoia launches an app](https://eclecticlight.co/2025/03/26/how-macos-sequoia-launches-an-app/)
  - Slow launches were traced to syspolicyd's `com.apple.security.syspolicy.yara` queue, which dominates CPU time. — [mjtsai, 2025-04-30](https://mjtsai.com/blog/2025/04/30/why-some-apps-sometimes-launch-extremely-slowly/)
  - When provenance data exists, evaluation skips the CloudKit check (macOS Tahoe testing). — [Eclectic Light: Is Tahoe quicker to launch apps first time?](https://eclecticlight.co/2025/10/13/is-tahoe-quicker-to-launch-apps-first-time/)
  - A tool installed from a signed installer package is checked once at install, and Gatekeeper then does no further checks on what it installed. — [Apple Developer Forums: Resolving Gatekeeper Problems](https://developer.apple.com/forums/thread/706379)
  - syspolicyd contacts apple-cloudkit.com on the first launch of command-line tools too. — [Apple Developer Forums thread 133358](https://developer.apple.com/forums/thread/133358)

### Inferences
- Native languages leave about 20 ms of the 25 ms budget for the daemon's work. Bun-native code fits the budget at p99 on this VM with about 6 ms to spare. Node and CPython are at or over the budget at p99 even with a trivial daemon. Laptop CPUs, especially Apple Silicon, are usually faster than a 2.3 GHz cloud Xeon, but that is unmeasured here.
- Rebuilding or re-signing the hook gives it a new code hash, which is likely to trigger the slow first-launch path on macOS again (inference). Ship stable, signed and notarized builds, ideally via pkg or an app bundle.
- Rosetta: an x86_64 binary on Apple Silicon is translated on first run and the translation is cached. No published hook-sized cost figure was found, so ship native arm64.

### Gaps
- No macOS measurement of any runtime in this note. dyld cost on macOS arm64 is not quantified.
- No local Deno, Zig or Node SEA measurement. Deno and Zig were not installed. Node 22 SEA needs `postject`, and the built-in `--build-sea` flag only exists from Node 25.5.
- Zig would be expected to match C (no runtime). That is inferred, not measured.
- antonz.org's "Timing 'Hello, world'" could not be fetched because the host was blocked.

## 2. Binary size and resident memory

### Takeaway
- Native hooks are 16 KB to 2.4 MB on disk and 0.7-3 MB RSS.
- A Bun-compiled hook is about 104 MiB on disk (109,123,760 bytes) and 23-25 MB RSS.
- Node 22 runs at about 37 MB RSS.
- Deno compile is reportedly 58 MB or more (hello world, Mac ARM, since 1.41).

### Cited Findings
- **LOCAL-2026-11-24, on-disk size (Linux x86_64):**
  - C dynamic: 16,368 B. C static glibc: 785,528 B.
  - Rust: 320,000 B (std, LTO, stripped).
  - Go: 2,433,208 B with encoding/json and net; hello world is 1,212,600 B. Both use `-s -w`.
  - Bun `--compile`: 109,123,760 B, the same for hello world and for the hook.
  — local measurement.
- **LOCAL-2026-11-24, peak RSS** (`wait4` ru_maxrss, child forked from a small C parent):
  - C dynamic 1.4 MB; C static 0.7 MB; Rust 2.0 MB; Go 2.9 MB.
  - Bun compile 23.3-25.3 MB.
  - Node 22: 37.3-38.0 MB.
  - CPython 3.13: 12.3-12.7 MB.

  The Python harness's RSS figures (about 14 MB) are inflated, because ru_maxrss carries the parent's footprint across `posix_spawn`. Ignore those. — local measurement.
- Deno 1.41 cut the `deno compile` hello world from 116 MB to 58 MB on Mac ARM. — [Deno 1.41 blog](https://deno.com/blog/v1.41)
- An experimental `--engine quickjs` option for `deno compile` is reported to shrink hello world from about 65 MiB to about 35.6 MiB (secondary report). — [besthub.dev](https://www.besthub.dev/articles/deno-s-big-shift-quickjs-replaces-v8-cutting-compile-size-by-almost-45-dcbacaae56b6); option listed in [Deno compile docs](https://docs.deno.com/runtime/reference/cli/compile/)
- pkg project figures: a pkg binary is 71 MB and a Bun-compiled one is 96 MB. — [yao-pkg](https://yao-pkg.github.io/pkg/guide/vs-bun-deno)

### Inferences
- A 100 MB hook per platform is a real cost for distribution: downloads, disk, and the first page-in of a cold cache. It also gives macOS's malware scan more to read on first launch (inference).
- Rust and C are smallest. Go adds about 1-2 MB of runtime.

### Gaps
- Node SEA binary size was not measured. Expect it to be roughly the size of the `node` binary (about 100 MB or more), but that is unmeasured.
- Zig binary size was not measured.
- Nuitka and PyInstaller sizes were not measured.

## 3. Daemon steady-state and tail latency (GC)

### Takeaway
For a small unix-socket request/response daemon at low concurrency, every runtime tested answered within sub-millisecond p99 locally (about 130-250 µs, with the client's connection cost included). The tail differed at p99.9: Bun was about 1.06 ms and the others 0.28-0.51 ms.

GC pauses in modern Go are typically well under 1 ms. The famous Discord spikes came from a 2019-era Go collector on a large heap. For a lock table of thousands of entries, GC is not the deciding factor. Memory footprint is: Go about 10 MB vs Node and Bun about 48-55 MB.

### Cited Findings
- **LOCAL-2026-11-24, daemon latency.** A Go client makes 50,000 sequential requests, each on a new unix connection (as a hook would). Each request sends about 140 B of JSON; the daemon parses it, does a lock-map insert and replies with JSON.

  | Daemon | p50 | p99 | p99.9 | max | RSS after |
  |---|---|---|---|---|---|
  | Go 1.24, goroutine per connection, mutex map | 100 µs | 248 µs | 462 µs | 3.3 ms | 10.1 MB |
  | Node 22, `net.createServer`, Map | 53 µs | 185 µs | 514 µs | 3.3 ms | 54.9 MB |
  | Bun 1.4.4, same JS code | 49 µs | 170 µs | 1057 µs | 3.3 ms | 48.5 MB |
  | CPython 3.13, blocking single-thread accept loop, no lock map | 43 µs | 131 µs | 276 µs | 3.5 ms | 12.2 MB |

  The max of about 3.3 ms is the same across all of them, which points to VM or scheduler noise rather than runtime behaviour. The test is sequential with no concurrency, and no Rust daemon was tested. — local measurement.
- Go GC history: in 2016 the Go team reported typical worst-case stop-the-world pauses dropping below 100 µs. — [golang-dev: Sub-millisecond GC pauses](https://groups.google.com/g/golang-dev/c/Ab1sFeoZg_8); [Twitch: Go's march to low-latency GC (2016-07-05)](https://blog.twitch.tv/en/2016/07/05/gos-march-to-low-latency-gc-a6fa96f06eb7/)
- Green Tea GC was experimental in Go 1.25 (`GOEXPERIMENT=greenteagc`). It brings about 10% less GC time for many workloads and up to 40% less for some, and was planned as the default for 1.26. It is a CPU-cost change, not a pause-time change. — [Go blog: Green Tea GC](https://go.dev/blog/greenteagc)
- GOGC and GOMEMLIMIT tuning is documented in the official guide. — [A Guide to the Go Garbage Collector](https://go.dev/doc/gc-guide)
- Discord, February 2020: the Go "Read States" service had large latency spikes "every few minutes", traced to Go's GC. Secondary sources say about every 2 minutes, caused by the forced GC on a large LRU cache. The Rust rewrite had no spikes in load tests. This is based on search snippets, since discord.com was blocked. — [Discord blog](https://discord.com/blog/why-discord-is-switching-from-go-to-rust); [@IT summary](https://atmarkit.itmedia.co.jp/ait/articles/2002/10/news038.html)

### Inferences
- With a heap of a few MB (a lock table plus an embedded DB cache), GC pauses in Go or V8 should sit in the tens to hundreds of microseconds. That fits the "sub-ms to few-ms" target. Rust or Zig removes GC jitter but would not be visibly faster at this scale (inferred from the local numbers).
- The embedded-database write (fsync) will dominate daemon latency more than the language does. This was not measured here.

### Gaps
- No published p99 numbers specific to unix-socket echo servers across Go, Rust, Node and Bun were found.
- Concurrent-load and fsync-bound measurements were not done.

## 4. Cross-compilation, static binaries and code signing

### Takeaway
- Go has the easiest cross-compile to a single static binary (`GOOS`/`GOARCH`, `CGO_ENABLED=0`). That changes if it needs a C embedded DB (SQLite via cgo): then it needs a C cross-toolchain, or a pure-Go DB.
- Rust needs target toolchains. `cargo-zigbuild` or `cross` is the usual path (inference, not sourced here).
- Zig cross-compiles C and Zig to all targets out of the box (well known, not re-sourced here).
- Bun cross-compiles via `--target` from a single host.
- Node SEA cannot use its code cache or snapshot when cross-building.
- On macOS every binary needs at least an ad-hoc signature. Distribution needs Developer ID signing plus notarization.

### Cited Findings
- **Node SEA:**
  - Stability 1.1, "Active development"; added in v19.7.0 and v18.16.0.
  - `useSnapshot` and `useCodeCache` added in v20.6.0. A built-in `--build-sea` flag arrived in v25.5.0; earlier versions inject the blob with postject.
  - The blob must come from the same Node version as the target binary.
  - Cross-platform builds must set `useCodeCache` and `useSnapshot` to false.
  - macOS needs `codesign --remove-signature` before injection and `codesign --sign -` after.
  - Tested on CI on Windows, macOS arm64 only (x64 skipped), and Linux except Alpine.

  — [Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html)
- `deno compile` embeds the program into `denort`, a stripped runtime binary, and supports cross-targets. — [Deno compile docs](https://docs.deno.com/runtime/reference/cli/compile/)
- **macOS signing:** a tool delivered through a signed installer package is checked once at install time. — [Apple Developer Forums 706379](https://developer.apple.com/forums/thread/706379); `syspolicy_check distribution` is available from macOS 14 to diagnose trusted-execution problems — [Apple Developer Forums 706442](https://developer.apple.com/forums/thread/706442)

### Inferences
- Static linking on Linux: Go with `CGO_ENABLED=0` is fully static. Rust with the musl target is fully static. The local static glibc C build worked, but glibc's static NSS has caveats.
- On Windows, a hook needs named pipes or AF_UNIX (supported since Windows 10 1803). This was not researched in depth.

### Gaps
- Bun's executables page (bun.com) was blocked, so the exact `--target` list, `--bytecode` startup gains and Bun's macOS codesign guidance were not captured. Look them up at bun.com/docs/bundler/executables.
- Windows code-signing (Authenticode, SmartScreen) costs were not researched.

## 5. Zig maturity in 2026

### Takeaway
Zig is still pre-1.0. 0.16.0 shipped in April 2026 with a breaking "I/O as an Interface" redesign, and there is no committed 1.0 date. Expect source-breaking churn at each minor release.

### Cited Findings
- Zig 0.16.0 was released in April 2026 (14 April per most sources; one post says 13 April). It came from 244 contributors and 1,183 commits over eight months; the headline is I/O as an Interface, plus async rework and incremental compilation. — [Zig 0.16.0 release notes](https://ziglang.org/download/0.16.0/release-notes.html); [LWN via linux.org](https://www.linux.org/threads/lwn-net-zig-0-16-0-released.65185/)
- No committed 1.0 timeline. Stated priorities are I/O, async, the package manager and the self-hosted backends. — [JetBrains blog: Why Zig isn't 1.0 yet (2026-06-05)](https://blog.jetbrains.com/blog/2026/06/05/why-zig-isn-t-1-0-yet/); [Ziggit: Zig Roadmap 2026](https://ziggit.dev/t/zig-roadmap-2026/10750)
- Bun is written in Zig. Anthropic announced it was acquiring Bun on 2025-12-02/03, and Claude Code "ships to millions of users as a Bun executable". — [Anthropic news](https://www.anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone); [Simon Willison, 2025-12-02](https://simonwillison.net/2025/Dec/2/anthropic-acquires-bun/)
- Zig was 64% "admired" in the Stack Overflow 2025 survey (Rust 72%). — [Stack Overflow Developer Survey 2025](https://survey.stackoverflow.co/2025/technology/)

### Inferences
- The production users of Zig are teams able to absorb toolchain churn: Bun, TigerBeetle and Ghostty. TigerBeetle and Ghostty are well-known Zig projects, but their current status was not sourced in this session. For a small team relying on AI assistants, the churn means more model hallucination of outdated std APIs (inference).

### Gaps
- TigerBeetle and Ghostty sources were not fetched; the search returned none.

## 6. Developer velocity, hiring and AI-assistant fluency

### Takeaway
Only thin sourced data. Rust is the most "admired" language (72%, SO 2025). Go and Rust usage reportedly rose. No rigorous source on AI-assistant fluency per language was found.

### Cited Findings
- Stack Overflow 2025 "admired": Rust 72%, Gleam 70%, Elixir 66%, Zig 64%. — [SO Survey 2025](https://survey.stackoverflow.co/2025/technology/)
- Go and Rust usage reportedly gained in the 2025 survey (secondary summary, unconfirmed against the official data). — [dev.to summary](https://dev.to/dev_tips/my-thoughts-on-the-2025-stack-overflow-survey-the-hype-the-reality-the-gap-26e3)
- JetBrains State of Rust 2025 exists as a source for Rust adoption. — [JetBrains blog 2026-02-11](https://blog.jetbrains.com/rust/2026/02/11/state-of-rust-2025/)

### Inferences
- A hybrid keeps velocity in one language and uses a native hook only where the startup budget forces it: a tiny native shim (C, Rust or Go, about 1 ms) plus a warm daemon in TypeScript on Bun or Node, or in Go. The local data supports this: daemon latency is similar across runtimes, while hook startup is not.
- Botbench's own CLAUDE.md requires Node 24+, one process and `node:sqlite`. A Node or TS daemon would match the existing stack. Only the hook needs to be native, or Bun if 18 ms p99 is acceptable.

### Gaps
- No measured data on LLM code-generation quality by language for systems code.

## 7. What Claude Code requires from a hook

### Takeaway
Hooks are spawned per event, either via `sh -c` (shell form, the default) or directly via exec form (`args`). They get JSON on stdin and run in parallel. The default timeout is 600 s for command hooks, so the real budget is user-perceived latency, not a hard limit.

### Cited Findings
- **How hooks are spawned:**
  - Shell form: "The `command` string is passed to a shell: `sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell when Git Bash isn't installed."
  - Exec form: when `args` is set, Claude Code "resolves `command` as an executable on `PATH` and spawns it directly ... There is no shell."
  - Hooks run in their own session without a controlling terminal.

  — [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- **Timeouts:**
  - `timeout` is in seconds. The default is 600 for `command`, `http` and `mcp_tool` hooks, lowered to 30 on UserPromptSubmit, PreModelSwitch and PostModelSwitch, and to 10 on MessageDisplay.
  - SessionEnd hooks share a 1.5 s budget, which can be raised up to 60 s.
  - On PreToolUse, a timed-out hook does not block unless `"onFailure": "block"` is set.

  — [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- **I/O semantics:**
  - Stdin carries JSON with `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id` and other fields.
  - Exit 0 with one JSON object on stdout is a structured answer. Exit 2 blocks, with stderr as the reason. Any other code is a non-blocking error.
  - Output is capped at 10,000 characters.

  — [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- **Concurrency and spawn avoidance:**
  - Matching hooks run in parallel. The `if` field skips spawning when it does not match ("avoiding the process spawn overhead").
  - `async: true` runs a hook in the background.
  - Background children that keep stdout open can delay hook completion by up to 10 s.

  — [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

### Inferences
- Use exec form so the shell does not cost about 1 ms (LOCAL: 2.06 ms vs 1.04 ms p50). Use `if` matchers so the hook is not spawned for tools the engine does not govern.
- Set `"onFailure": "block"` on PreToolUse when the engine must enforce. Otherwise a hook that crashes or times out (for example, daemon down) lets the call through. This matters for a "broker failure = deny" policy.
- The hook must never leave a child holding stdout, because of the 10 s delay.

### Gaps
- The hooks page was only partly read (the first 100k of 294k characters). Codex, Gemini CLI, Grok and Cursor hook spawn models and timeouts were not covered in this note.
