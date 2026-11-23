# Sandbox runtimes: E2B, Daytona, Docker Sandboxes

| | E2B | Daytona | Docker Sandboxes |
|---|---|---|---|
| Repository | github.com/e2b-dev/E2B (SDKs, CLI, API spec); runtime in github.com/e2b-dev/runtime | github.com/daytonaio/daytona (archived in place) | None public; releases and issues at github.com/docker/sbx-releases |
| Commit read | 08c4eeb, 2026-11-18 (shallow clone) | ec4c21b, 2026-06-25 (shallow clone, README only) | No source; documentation at docs.docker.com, read 2026-11-23 |
| Licence | Repository `LICENSE` is Apache-2.0; the JS SDK and CLI packages declare MIT (`packages/js-sdk/package.json:6`, `packages/cli/package.json:6`); runtime Apache-2.0 (web) | AGPL-3.0 at the last public version, v0.190.0 (web); current product closed source | Not stated in the docs read; "free to use, including for commercial and professional work" for the CLI and local compute (web) |
| Evidence basis | Source read only; not run. Web for the runtime, pricing | README plus web; no code exists in the clone | Web only |

**Daytona status, read this first.** The public repository is no longer maintained: "As of June 2026, Daytona's core development has moved to a private codebase. This repository will receive no further updates, fixes, or releases" (`README.md:2-5` in the Daytona clone). The clone holds only that README and an `assets/` folder. The rest of the README (`README.md:36`, "Our open-source platform") predates the notice and is now out of date.

## What it is and who it is for

All three run code an AI agent wrote somewhere other than the developer's own process space. They differ in where that place is.

- **E2B** is a cloud service that hands out Firecracker microVMs ("sandboxes") through a REST API, with an in-VM daemon (`envd`) for processes and files. It is for product teams that embed code execution in their own application and pay per second. Self-hosting exists through the separate runtime repository.
- **Daytona** was an open-source (AGPL) sandbox platform of the same kind. Since June 2026 it is a closed, hosted service; the public code is frozen at v0.190.0.
- **Docker Sandboxes** is Docker's tool for running a coding agent (Claude Code, among others) on a developer's own machine inside a microVM, driven by the `sbx` CLI, with an optional Docker-hosted cloud tier. It is for individual developers who want to let an agent run unattended without exposing the host. The brief names a `docker sandbox` command; the documentation read on 2026-11-23 describes only `sbx`, and this file does not confirm the older name.

## What is actually implemented

| Capability | Evidence level | Source reference | Note |
|---|---|---|---|
| E2B: create a sandbox from a template, with TTL | Implemented (API contract and SDK) | `spec/openapi.yml:1283-1295` (`NewSandbox`, `timeout` default 15 s) | The server is not in this repo; the spec and SDK are the evidence |
| E2B: set or extend TTL | Implemented (contract) | `spec/openapi.yml:5938` (`/sandboxes/{id}/timeout`), `:6005` (`/refreshes`) | Each call resets TTL from now |
| E2B: pause, resume, fork, snapshot | Implemented (contract) | `spec/openapi.yml:5677`, `:5720`, `:5771`, `:6035` | Auto-pause on timeout with or without memory, `:1303-1317`; `onTimeout` kill or pause, `:893-920` |
| E2B: egress allow and deny lists | Implemented (contract) | `spec/openapi.yml:706-731` (`allowOut`, `denyOut`, `dnsServers`); `:803` (`allow_internet_access=false` equals deny 0.0.0.0/0) | Domains allowed in `allowOut`, deny only by CIDR; editable on a running sandbox, `:5970` |
| E2B: header injection on egress (credential brokering) | Partial | `spec/openapi.yml:747-757`, `:812-822`; `packages/js-sdk/src/secret.ts:367-389` | Rules inject headers per domain; a stored secret is referenced as `${e2b.secrets.<name>}`. The spec and SDK disagree on where it resolves (see Open questions) |
| E2B: SOCKS5 egress proxy | Implemented (contract) | `spec/openapi.yml:826-850` | Applied after allow/deny filtering |
| E2B: env vars on create and per command | Implemented | `spec/openapi.yml:1333` (`envVars`); `packages/js-sdk/src/sandbox/commands/index.ts:58-72` (`cwd`, `user`, `envs`) | Plain values, visible inside the VM |
| E2B: process and file control inside the VM | Implemented (contract) | `spec/envd/process/process.proto:5-20`; `spec/envd/filesystem/filesystem.proto:7-19`; `spec/envd/envd.yaml:314` (`/files`) | Connect RPC over HTTPS, JSON encoding, `packages/js-sdk/src/sandbox/index.ts:201-205` |
| E2B: CLI exec into a sandbox | Implemented | `packages/cli/src/commands/sandbox/exec.ts:29-39` | `e2b sandbox exec <id> <cmd>` with `-c`, `-u`, `-e` |
| E2B: host folder mount | Absent | Only named volumes, `spec/openapi.yml:1059-1070` | A local worktree has to be uploaded and the result downloaded |
| E2B: self-hosting | Unverified | `README.md:104-112` points to github.com/e2b-dev/runtime | Web: Firecracker, "Linux with KVM", single-host "Embed" by `docker compose`, Terraform for AWS/GCP/Azure |
| Daytona: anything current | Unverified | `README.md:1-7` | No code in the clone; hosted service only |
| Docker Sandboxes: microVM per sandbox, own kernel and Docker engine | Unverified | docs.docker.com/ai/sandboxes/security/isolation | Web only |
| Docker Sandboxes: deny-by-default egress via host proxy, credential injection | Unverified | docs.docker.com/ai/sandboxes/security/defaults | Web only |

## Architecture and trust model

### E2B

The client talks to two HTTP surfaces:

- **Control API** at `https://api.e2b.app` (`spec/openapi.yml:6-7`). It creates, times out, pauses, resumes, forks, snapshots and kills sandboxes. It is authenticated by a team API key; the CLI reads `E2B_API_KEY` (`packages/cli/src/api.ts:29-45`).
- **envd**, inside each sandbox, on port 49983 at `49983-<sandboxId>.<domain>` (`packages/js-sdk/src/connectionConfig.ts:406`, `:599-604`). It is authenticated by a per-sandbox `X-Access-Token` (`packages/js-sdk/src/sandbox/index.ts:163-190`). It offers process start, streaming output, stdin and signals (`spec/envd/process/process.proto:5-20`) and file operations (`spec/envd/filesystem/filesystem.proto:7-19`).

Both are plain HTTPS. The SDK sets the Connect transport to JSON rather than binary (`useBinaryFormat: false`, `packages/js-sdk/src/sandbox/index.ts:201-205`), so `fetch` from Node can drive envd without the SDK. Streaming responses use Connect's envelope framing, which a caller would have to write itself. That is an estimate, not measured.

Trust model (web, github.com/e2b-dev/runtime): "One Firecracker microVM per sandbox, in its own cgroup and network namespace," with a per-sandbox nftables egress firewall. Everything in the VM, including env vars, is readable by code in the VM. The header-injection rules (`spec/openapi.yml:747-757`) are the one place a secret can be used without being placed in the VM. The spec warns that broad wildcards "may expose transformed credentials to every matching destination" (`:753-755`).

Lifecycle: default TTL 15 seconds unless the caller sets one (`spec/openapi.yml:1290-1295`); at timeout, kill or pause (`:893-920`); paused sandboxes keep memory and disk and can be resumed, forked or snapshotted. Session length is capped by plan: 1 hour on Hobby, 24 hours on Pro (web, https://e2b.dev/pricing).

### Daytona

Nothing to read. Web facts: the June 11, 2026 announcement gives security as the reason ("AI tools can now find exploitable flaws in open source code at a speed and scale no human team can match") and says the old repository "remains available as is" (https://daytona.io/dotfiles/updates/daytona-is-going-closed-source). The v0.190.0 `LICENSE` is the GNU AGPL v3 with no added terms (https://github.com/daytonaio/daytona/blob/v0.190.0/LICENSE). The announcement does not mention self-hosting. A community fork, Nightona, says it continues from v0.190.0 under AGPL-3.0 (https://cdn.jsdelivr.net/gh/nightona-co/nightona@main/README.md); its activity was not checked.

### Docker Sandboxes

All web, from docs.docker.com/ai/sandboxes/ and its architecture, security, defaults, isolation, install, FAQ and Claude Code pages, read 2026-11-23.

- **Isolation.** Each sandbox is a "lightweight microVM with its own Linux kernel", with its own Docker engine and no path to the host's Docker daemon (/ai/sandboxes/security/isolation). The docs do not name the hypervisor on macOS.
- **Workspace.** In direct mode, a host folder is mounted read-write at the same absolute path, so "changes in either direction are instant." Clone mode mounts the repository read-only and the agent works on a private clone. A sandbox can also have no mount at all (/ai/sandboxes/architecture/).
- **Network.** "All outbound TCP traffic, including HTTP, HTTPS, and SSH, is blocked unless an explicit rule allows the destination." UDP and ICMP are blocked, and DNS goes through a policy-enforcing resolver. Rules are set with `sbx policy allow` and listed with `sbx policy ls` (/ai/sandboxes/security/defaults). The security page also warns that "the default allowed domains include broad wildcards" (/ai/sandboxes/security). The two pages read differently, and running `sbx policy ls` would settle it.
- **Credentials.** "No credentials are available to the sandbox unless you provide them using `sbx secret` or environment variables". The host proxy puts them into outbound headers, and "the raw credential values never enter the VM" (/ai/sandboxes/security). A Claude subscription sign-in stays on the host, and the sandbox does not read `~/.claude` (/ai/sandboxes/agents/claude-code/).
- **Agent mode.** `sbx run claude <dir>` runs the whole Claude Code CLI inside the VM with `--dangerously-skip-permissions` by default (/ai/sandboxes/agents/claude-code/). The user inside is non-root with sudo (/ai/sandboxes/security/defaults).
- **Not protected, by Docker's own account.** Workspace files that run later (Git hooks, CI config, `package.json` scripts), shared read-write skills, and local stdio MCP servers, which run on the host (/ai/sandboxes/security).
- **Persistence.** A sandbox persists across agent stops until `sbx rm` (/ai/sandboxes/architecture/).
- **Platform.** macOS 14 or later on Apple silicon, Windows 11 with Hypervisor Platform, Ubuntu 24.04 or later with KVM. "You don't need Docker Desktop or Docker Engine to use `sbx`." A Docker account sign-in (`sbx login`) is required. Usage telemetry is on by default and can be switched off (/ai/sandboxes/install/, /ai/sandboxes/faq/).
- **API.** The REST API and TypeScript SDK cover cloud sandboxes only (/ai/sandboxes-api/). Local sandboxes are driven by the CLI. An `sbx exec` reference page exists, but its content did not load, so its flags are unverified.

### Comparison

| | E2B | Daytona | Docker Sandboxes |
|---|---|---|---|
| Isolation technology | Firecracker microVM (web) | Unverified (closed) | microVM, own kernel (web) |
| Lifecycle and persistence | TTL per sandbox, kill or pause at timeout; plan caps 1 h or 24 h | Unverified | Persists until `sbx rm`; stop keeps the VM |
| Snapshot and resume | Pause, resume, fork, snapshot in the API | Claimed in README `:40` | Not documented beyond persistence |
| Networking and egress | `allowOut` domains or CIDR, `denyOut` CIDR, editable live, SOCKS5 upstream | Unverified | Deny-by-default host proxy, `sbx policy allow` |
| Secrets handling | Env vars visible in the VM; egress header rules with secret placeholders | Unverified | Host proxy injects; raw values never in the VM (web) |
| Local versus cloud | Cloud; self-host needs Linux with KVM | Cloud | Local on the Mac; cloud tier optional |
| Host folder mount | None (upload and download) | Unverified | Direct read-write mount at the same path, or clone mode |
| Licence | Apache-2.0 runtime, MIT SDK and CLI | Old code AGPL-3.0, product closed | Not stated; free for local use |
| Cost model | Per second: $0.000014 per vCPU-s, $0.0000045 per GiB-s; Pro $150 a month (web, e2b.dev/pricing) | Hosted, metered (not checked) | Local free; cloud pay as you go |
| SDK surface | REST plus envd Connect RPC, JS and Python SDKs, CLI | SDKs in five languages, now at github.com/daytona | `sbx` CLI locally; REST and TS SDK for cloud only |
| Fit as optional Botbench backend | Possible third "cloud sandbox" kind over plain HTTP, but needs worktree upload and an account | None | Candidate microVM variant of the "container" kind through the CLI |

## What Botbench would use it for

Issue #72 defines one seam with two kinds: "confined on the host" (macOS Seatbelt, which Apple marks deprecated, ADR 0002 Consequences) and "container". Both keep the agent CLI on the host (ADR 0002 decision 3) and rewrite each approved shell command to run in the environment. Judged against that seam:

- **Docker Sandboxes as a "container" backend.** It covers most of what #72 asks for. The task copy is mounted read-write at the same path, so command paths need no translation. No credentials are passed in and egress is denied by default, with a per-host allow command. The user is non-root. It needs neither Docker Desktop nor Docker Engine, which removes the Docker dependency but not the "runtime absent" case. Botbench would call `sbx create` with the worktree before the build, rewrite each approved command to `sbx exec`, and call `sbx rm` when the task is decided, discarded or cancelled. Unknowns: whether `sbx exec` runs a non-interactive command and returns its exit status; whether network policy is per sandbox or global; and whether an owner-named OCI image can be the template. Botbench would not use `sbx run claude`. That puts the CLI in the VM with permissions bypassed, which removes Botbench's gate and breaks ADR 0002 decision 3.
- **E2B as a "cloud sandbox" kind.** It could serve a phone-started task when the Mac is busy, or a check suite too heavy for the laptop. All of it is reachable through `fetch` against the REST API and envd, so it needs no SDK. The cost is that the worktree has to travel: upload it through `/files` (`spec/envd/envd.yaml:314`) before the build and bring the diff back after. The source of truth then lives in two places.
- **Daytona.** Nothing to use. Its frozen AGPL code is not a base to build on.

Each requirement of #72 against the two usable backends. "Docs" means the claim comes from Docker's web documentation only. Plain `docker run`, the approach ADR 0002 measured, is the baseline.

| #72 requirement | Docker Sandboxes (`sbx`) | E2B (plain HTTP) |
|---|---|---|
| One environment per task, started before the build | `sbx create` with a workspace path (docs) | `POST /sandboxes` (`spec/openapi.yml:1283`) |
| Task copy mounted read-write | Direct mode, same absolute path (docs) | No mount; upload through envd `/files`, download the diff |
| No network unless the repository allows hosts | Deny by default, `sbx policy allow` (docs); whether it is per sandbox is unknown | `allowOut` per sandbox, CIDR deny for the rest (`:706-731`) |
| No credentials or home folder | None by default; `~/.claude` not read (docs) | Nothing from the Mac unless Botbench sends it |
| Non-root | Non-root with sudo inside the VM (docs) | `user` per command (`commands/index.ts:62-64`) |
| Each approved command rewritten to run inside | `sbx exec` page exists; flags unverified | `Process.Start` over Connect (`process.proto:9`) |
| Setup and check commands in the same environment | Possible, since the sandbox persists across commands (docs) | Possible within TTL |
| Removed on decide, discard, cancel; leftovers removed at start | `sbx rm`; listing leftovers needs `sbx ls` (not checked) | `DELETE /sandboxes/{id}` (`:5536`); list at `:5095`; TTL as a backstop |
| Runtime absent: refused with a reason, no fallback | Botbench checks for `sbx` on PATH | Botbench checks for a configured endpoint |
| Image per repository, nothing pulled unless named | Templates and kits; owner-named OCI image unverified | Templates built from a Dockerfile (`/v3/templates`, `:6183`) |
| Zero new runtime dependencies | Holds (external CLI) | Holds with `fetch`; Connect stream framing is hand-written |

## Cost of adopting it

| | E2B | Daytona | Docker Sandboxes |
|---|---|---|---|
| Runtime dependencies | None if driven by `fetch`; the SDK would add `@connectrpc/connect-web` and others (`packages/js-sdk/src/sandbox/index.ts:1`) | n/a | None in Botbench; the owner installs `sbx` (Homebrew) |
| Services to run | E2B cloud, or a self-hosted Linux/KVM host, never the Mac | n/a | `sbx` daemon on the Mac |
| Accounts | E2B team API key | Daytona account | Docker account, `sbx login` required |
| Licence | Apache-2.0 and MIT, no copyleft | AGPL-3.0 for old code | Not stated; terms of Docker's service |
| Lock-in | E2B template format and API; moderate | High (closed) | `sbx` CLI shape; low if behind the seam |
| Zero runtime dependencies | Holds with `fetch`; envd streaming framing must be hand-written | n/a | Holds; Botbench shells out to a CLI the owner chose |
| One local Node process | Holds; the sandbox is remote | n/a | Holds; `sbx` is the owner's tool, like Docker for #72 |
| No Docker for first run | Holds (not needed at all) | n/a | Holds only as an optional kind; first run stays on host confinement |
| Local by default | Breaks; code and checks leave the Mac | Breaks | Holds |
| Credentials never read by Botbench | Breaks unless Botbench shells out to the `e2b` CLI under its own login; calling the API directly means Botbench holds the API key | n/a | Holds: `sbx login` and `sbx secret` stay with `sbx` |

## Recommendation

- **E2B: follow the standard's shapes without the dependency.** Its contract is the clearest public statement of what an agent sandbox needs: an egress list of allowed domains and denied CIDRs, editable while running (`spec/openapi.yml:706-731`, `:5970`); a lifecycle of TTL plus kill-or-pause at timeout (`:893-920`); and secrets that are named, never read back, and injected at egress (`packages/js-sdk/src/secret.ts:26`, `:367-389`). Botbench's per-repository environment settings should use the same shapes, so that a cloud kind maps onto them later. A cloud kind now would break local-by-default and make Botbench hold an API key.
- **Daytona: ignore.** The public code is frozen and unmaintained (`README.md:2-5`), it is AGPL, and the live product is closed and hosted only. Nothing in it beats E2B's public contract.
- **Docker Sandboxes: watch.** Its design matches ADR 0002 closely: a microVM, a host-side proxy that injects credentials so they never enter the VM, egress denied by default, and no Docker Desktop. It is the most likely second backend behind #72's "container" kind on a Mac without Docker. Do not adopt it yet. The licence is unstated, it requires a Docker account sign-in, telemetry is on by default, and whether `sbx exec` and per-sandbox policy fit command rewriting can only be settled by running it. Build #72 on plain `docker run` (as measured in ADR 0002), keep the seam narrow enough that `sbx` can slot in, and revisit once `sbx exec` is documented.

## Open questions

- E2B: where is `${e2b.secrets.<name>}` resolved? `spec/openapi.yml:822` says "secret resolution happens client-side before sending to the API"; `packages/js-sdk/src/secret.ts:367-373` says "the runtime resolves" it and an unknown name "fails server-side". The answer decides whether the secret ever reaches the VM host's configuration in clear text.
- E2B: does a sandbox with `allow_internet_access=false` still reach envd (yes, by design?) and the header-injection proxy? Only a run shows the actual egress path.
- E2B: is the single-host "Embed" self-host practical on a Linux box an owner already has, and how much maintenance does it need (web claim only)?
- Docker Sandboxes: does `sbx exec` run a non-interactive command with exit status and separate stdout and stderr, as #72's rewrite needs?
- Docker Sandboxes: is network policy per sandbox, so one repository's allowed hosts stay with that task, or is it global to the `sbx` daemon?
- Docker Sandboxes: what is the default allow list, given that one page says all TCP is blocked and another says defaults include broad wildcards?
- Docker Sandboxes: can a template be an owner-named OCI image, pulled only when named, and what is the start time per task?
- Docker Sandboxes: under what licence and terms does `sbx` ship, and does it work with sign-in but no network after first start?
- Daytona: is the Nightona fork maintained enough to matter? Nothing here depends on it.
