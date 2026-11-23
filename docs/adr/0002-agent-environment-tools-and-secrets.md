# ADR 0002: Agent, environment and tools are separate, and secrets stay outside the environment

Date: 2026-11-22. Status: accepted (owner direction). Supersedes the plan's deferral of sandboxes.

## Decision
1. Botbench treats three things as separate: the **agent** (a vendor CLI and its model), its **execution environment** (where the commands it runs execute), and its **tools** (terminal, browser, MCP servers, connected services).
2. A secret lives outside the place the agent's commands run and is applied on the agent's behalf. This holds for the vendor sign-in and for any service token.
3. The agent CLI stays on the host under the owner's own login. Its commands are confined. Botbench does not put the whole CLI in a container.
4. Isolation arrives in two steps:
   - **Step 1, confined commands.** Each CLI's own operating-system sandbox is switched on with no network and an explicit list of unreadable places (vendor sign-in folders, the Keychain, SSH and cloud credentials). A driver whose CLI cannot do this is offered for read-only roles only.
   - **Step 2, one container per task.** Every shell command is rewritten into a container that has only the task's worktree mounted, no network, and no credentials. The container is discarded with the task.
5. A service token (for example GitHub) is held on the host by a Botbench-owned proxy. Each call goes through the permission broker and the action log. The token never enters the agent's environment. This is not built until a unit needs it.

## Why
Measured on the owner's Mac on 2026-11-22 (Claude Code 2.1.322, Codex 0.171.0, Docker through OrbStack):
- With Claude Code's sandbox on, a command could not read a file outside the working directory, `~/.ssh` or `~/.codex`, and could not reach the network. Denials came back as tool errors the driver can report.
- **Two traps.** With the sandbox on, Claude Code stops asking before Bash unless `autoAllowBashIfSandboxed` is false, which would silently remove Botbench's gate. And the sandbox does not hide the Keychain: a confined command could read the Claude Code sign-in until `~/Library/Keychains` was added to the unreadable list.
- Codex's stock sandbox modes block the network but leave `~/.codex/auth.json` readable. A custom permissions profile denies it.
- A CLI inside a container starts signed out. Signing it in there puts the sign-in file beside the commands the agent runs, so it separates nothing, and the alternatives (a long-lived token, or copying the sign-in file in) would have Botbench handle credentials, which ADR 0001 forbids.
- Rewriting each Bash call into a per-task container through the permission answer worked: the command saw the worktree, no sign-in files and no network.
- From documentation only: Grok's sandbox leaves its own sign-in readable and does not block network on macOS. Antigravity's hides some paths; whether it hides its own sign-in is unknown.

## Consequences
- Today, before step 1, a command the owner allows can read anything the owner can, including a vendor sign-in. The threat model says so.
- Step 1 depends on macOS Seatbelt, which Apple marks deprecated although every vendor CLI relies on it. Step 2 does not.
- The sandbox covers shell commands only. The CLI's own file tools, hooks and MCP servers run outside it, so reads outside the worktree are also denied by rule.
- No network by default means setup and check commands that download dependencies need an explicit, owner-set allowance per repository.
- No option stops a secret that a command prints from reaching the model provider in the transcript. Keeping secrets unreadable is the control; there is no second one.
- Steps 1 and 2 cannot both wrap the same command: the CLI's sandbox blocks the Docker socket. Step 2 replaces step 1 for shell commands where a container runtime is present.
- A Botbench-owned MCP server (for a "run" tool or a service proxy) would end the current rule that CLIs start with no MCP servers. That needs its own decision record and threat review when it is proposed.
- Grok (1.0.92) and Antigravity (1.5.14) are offered for review only, and not through their own sandboxes: their models are given no tools, the CLI works in an empty folder rather than the task's copy, and the whole CLI process runs under a `sandbox-exec` profile from Botbench that opens only the CLI's own folders (threat model, B12). Measured on 2026-11-22: Antigravity runs a repository's own hooks and MCP servers in headless mode without asking, and Grok attaches any file named with `@` in its prompt.

## Addendum, 2026-11-22: Codex and Grok get their own tools (issue #94)
- An agent that cannot ask Botbench before it acts (Codex and Grok here) may have its own tools in a chat and a review only inside a sandbox that is, by itself, the control: what it does not allow does not happen, and nothing is put to the owner. The threat model's B17 says what each gets and its limits.
- Codex keeps its own per-command sandbox with Botbench's permissions profile (step 1), not Botbench's `sandbox-exec` around the whole CLI: macOS does not nest sandboxes, so a Codex inside one would run its commands unsandboxed, and they could read its sign-in. Before each turn Codex is asked which sandbox it would use, and is not started when it reports a looser one.
- Grok runs whole under Botbench's `sandbox-exec`, its network only through a Botbench proxy to its provider. Known limit: its commands can read its own sign-in folder, as this ADR's measurements said of Grok's own sandbox.
- Antigravity keeps no tools: a private home signs it out, and a private home that keeps its sign-in could not be built or measured without reading where that sign-in lives. OpenMausBot gives it tools another way (`server/drivers/antigravity-acp.ts`): Google's ACP server with a profile of its own (`GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`), signed in once there through Antigravity's own OAuth, no MCP servers, and each `session/request_permission` put to the person. That is a second sign-in held by the CLI in Botbench's folder, and an agent that can ask; it is the way to measure next, not built here.
- Found in the review of PR #127 and changed: Grok's process gets a private temporary folder, as the shared one let its commands reach other programs' Unix sockets; each Codex and Grok tool call is written to the action log; a review in a run started from a GitHub issue gets no web search. Measured with the real CLIs and kept in `test/live/chat-tools.live.test.ts`. Codex driven by `codex exec` cannot ask and does not report a command its sandbox refused; `codex app-server` does both (threat model, B17), and is the follow-up.
