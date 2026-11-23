# Tutti

| | |
|---|---|
| Repository | https://github.com/tutti-os/tutti |
| Commit read | 207beee, 2026-10-08 (shallow clone, one commit visible) |
| Licence | Apache-2.0 (`LICENSE`). The multi-user product, "Tutti · VM", is closed. Internally it is called **TSH**, with a cloud backend called `tsh-server`. TSH consumes this repo's packages but its source is not here. Several runtime services are hosted by the vendor: the account and control plane at `tutti.sh`, a realtime WebSocket at `ws.tutti.sh`, and app, agent-extension and connector catalogues on CloudFront. |
| Stack | Go daemon `services/tuttid` with a SQLite store. Electron + React desktop in `apps/desktop`. A Go terminal CLI in `apps/cli`. React Native mobile app (`apps/mobile`) using gomobile bindings of a Go ICE/QUIC transport (`packages/device-link`). A Node sidecar for the Claude Agent SDK (`packages/agent/claude-sdk-sidecar`). pnpm + Go workspace monorepo. Ships as a macOS/Windows desktop installer. |
| Size and activity | About 260 MB, about 6,700 Go/TS source files. 10 ADRs and about 37 architecture docs. Many conformance, crash-recovery and replay tests. Very mature and heavily engineered. Docs record a large refactor history (session fork, goal control, turn-lifecycle authority). The shared packages are published to npm and Go modules for both Tutti and TSH. |
| Evidence basis | Source read only; not run. One attempt to read tutti.sh returned only an empty JS shell, so closed-tier facts come from the repo README and are marked Unverified. |

## Promise and intended customer

The README promises "a real-time shared workspace for your agents". Claude Code, Codex, Hermes and others share one workspace, so one agent can pick up another's conversations, files, app outputs and tasks. The user does not have to copy context between them. The customer is one person running several agent subscriptions: independent developers, designers, PMs and content creators. The product is GUI-first ("no terminal").

The README draws the open/closed line explicitly in its comparison table (`README.md`, "Two Versions of Tutti"):

- **Open source (single user):** connecting existing agents, using existing subscription credits, built-in apps, and "Big @" across *your own* agents.
- **Tutti · VM only:** group chat, working with others, working with others' agents, simultaneous editing, agent borrowing, use across devices, no-deploy sharing, and Big @ across others' agents. Creating a Room needs an invite code.

The README describes the VM tier this way (Unverified, marketing only): "Each agent runs on your own machine inside a managed local VM, while the Room shares working state in the cloud in real time."

## What is actually implemented

| Capability (README headline first) | Evidence level | Source reference | Note |
|---|---|---|---|
| Connect existing agents (Claude Code, Codex, Hermes; OpenClaw in development) | Implemented | `packages/agent/daemon/providerregistry/claude_code.go:10`, `codex.go:12`, `providers.go:23` (Cursor), `providers.go:151` (OpenClaw, disabled) | Declarative provider descriptors. Three runtime families: Claude Agent SDK sidecar, Codex `app-server` JSON-RPC, and standard ACP. |
| Reuse existing subscriptions, no API keys | Implemented | `claude_code.go:24` (`NativeSubscription: true`), `claude_code.go:36` (OAuth usage probe), `packages/agent/runtimeprep/mutagen_auth.go` | Uses the CLI's own login files (`~/.claude/.credentials.json`, `~/.codex/auth.json`), projected into a per-session provider home. |
| Big @: reference another agent's conversations, files, app outputs, tasks | Implemented (own workspace) | `packages/agent/daemon/runtime/tutti_mention_routing.go:30`; `docs/architecture/agent-reference-mention-resolution.md` | `mention://` URIs routed to injected skills, which call the `tutti` CLI. The CLI reads the daemon's canonical store. |
| @ an agent to do work (handoff) | Implemented | `packages/agent/runtimeprep/skill_templates/tutti-handoff.md`; `services/tuttid/service/cli/providers/agentcontext/session_commands.go` | Prompt-level contract plus `tutti agent start/send/wait/get`. |
| Task orchestration; agents avoid conflicts | Partial | `services/tuttid/service/workspace/issue_sequential_dispatch.go:28`; `services/tuttid/service/agent/active_peers.go:19` | Issue/Task/Run dispatcher with dependencies and worktrees is real. Conflict avoidance between ad-hoc agents is only an advisory `agent active-peers` list, which cannot identify the caller ("SELF_IDENTITY_UNAVAILABLE"). |
| Goals to tasks | Implemented | `services/tuttid/service/cli/providers/tuttimodeplan/commands.go:84` (`plan propose`), `services/tuttid/service/tuttimodeplan/issue_materializer.go` | An agent proposes a plan, the user reviews it, and it becomes an Issue with Tasks. |
| Control Center (approvals, running work in one view) | Implemented (renderer, not deeply read) | `packages/agent/daemon/runtime/codex_appserver_approval_resolver.go`; `docs/adr/0006-step6-approval-resolver-durable-projection.md` | Provider approvals are surfaced as durable pending items. |
| App centre (design, PPT, canvas apps) usable by agents | Partial | `services/tuttid/builtin-apps/catalog.go:53` | Only an onboarding app ships in the repo. Other apps come from a remote CloudFront catalogue, so their code is not in this repo. Agents drive apps through CLI commands exposed per app (`skill_templates/workspace-app.md`). |
| Connectors / MCP market | Implemented | `docs/architecture/connector.md`; `packages/connector/*`; `packages/agent/daemon/runtime/codex_appserver_mcp.go` | Remote market catalogue; local install and authorization owned by the daemon. |
| Mobile remote control of your desktop | Implemented (needs vendor cloud) | `services/tuttid/service/mobileremote/control_plane.go:22`; `packages/device-link/README.md` | ICE/QUIC P2P with relay fallback. Pairing and rendezvous go through `tutti.sh`. |
| Group chat, working with others, others' agents, agent borrowing | Unverified (closed TSH) | Contract only: `packages/agent/activity-replication/types.go:166-182` | The open repo defines the wire contract for uploading activity to a cloud projection. It has no uploader and no sink. |
| Across devices / Rooms / presence | Partial | `services/tuttid/service/userpresence/service.go`; `services/tuttid/api/daemon_user_presence.go` | Daemon API for room presence exists. The open desktop renderer does not call it; only the generated TS client references it. |
| VM-backed agent execution | Unverified (closed TSH) | Mentions only: `docs/architecture/workspace-terminal.md:12,32`; `docs/architecture/agent-runtime-preparation.md`; `providers.go` OpenClaw "runtime VM" message | No VM, guest-agent or hypervisor code in this repo. |
| Simultaneous editing | Absent in repo | none found | No CRDT/OT code. |

## Architecture

```
Electron desktop (apps/desktop) ── HTTP+bearer ──> tuttid (services/tuttid, Go)
       │                                             │  SQLite: workspaces, issues, tasks, runs,
       │                                             │  agent canonical store (packages/agent/store-sqlite),
       │                                             │  tutti-mode executions, wakes, model plans, connectors
       │                                             ├─ agent daemon kit (packages/agent/daemon)
       │                                             │    ├─ Claude: node claude-sdk-sidecar (NDJSON v10) -> claude executable
       │                                             │    ├─ Codex/Tutti Agent: `codex app-server` JSON-RPC
       │                                             │    └─ ACP: cursor-agent acp, opencode, hermes, kimi, grok (extensions)
       │                                             ├─ runtimeprep: per-session skills, policy prompt, provider home, env
       │                                             ├─ CLI capability registry (service/cli) <── `tutti` CLI used by agents
       │                                             └─ mobileremote / userpresence / accountrealtime ──> tutti.sh, ws.tutti.sh
apps/mobile (React Native) ── device-link ICE/QUIC (+relay) ──> tuttid
```

- **Agent Host.** `packages/agent/host` is the reusable lifecycle authority for Session, Turn, Goal, fork, edit-retry and recovery. Both tuttid and TSH's `cmd/desktopd` are adapters over it (`AGENTS.md:63-85`).
- **Canonical activity store.** `packages/agent/store-sqlite` normalizes every provider's events into one schema: sessions, turns, interactions, messages, runtime operations. This shared store is how Codex can read what Claude did.
- **Workspace Issue domain.** `packages/workspace/issues/model.go` defines Topic, Issue, Task, Run, RunOutput, ContextRef and Budget. Persistence is in `services/tuttid/data/workspace/migrations_issue_topics.go:65-250`.
- **Tutti Mode execution.** A durable orchestration aggregate with checkpoints, main-conversation "wakes", goal reviews, launch intents and cancel compensations (`services/tuttid/data/workspace/migrations_tutti_mode_execution.go:21-379`).
- **Event stream.** A business event stream to the renderer (`services/tuttid/service/eventstream`, `docs/architecture/business-event-stream.md`).

## How agents are connected and managed

- **Provider registry.** `providerregistry.ProviderDescriptor` declares, per provider:
  - identity
  - runtime kind and command
  - auth status and login commands
  - auth-file watch paths
  - installer and updater (official script, managed npm)
  - composer profile: models, reasoning effort, permission modes, slash-command effects
  - skill kind
  - event aliases
  - desktop ordering

  Examples: `claude_code.go:10-173`, `providers.go:23-82`.
- **Adding a provider.**
  - New ACP providers are "a thin declarative config on top of the shared engine" (`packages/agent/daemon/runtime/acp_providers.go`).
  - Third-party ACP agents can also arrive as signed, data-only **Agent Extensions**, pinned by exact version and Ed25519 key in `config/tutti.defaults.json`. Pinned sources: gemini, codebuddy, copilot, kilo, qwen, hermes, kimi-code, grok; only hermes and kimi-code are enabled.
  - Release ZIPs that contain executables are rejected (`docs/architecture/agent-extensions.md`).
- **Claude Code.**
  - Driven through `@anthropic-ai/claude-agent-sdk` in a Node sidecar speaking versioned NDJSON (`packages/agent/claude-sdk-sidecar/README.md`).
  - The sidecar passes `pathToClaudeCodeExecutable` and a `canUseTool` callback that routes permission prompts to Tutti (`src/sessionRuntime.ts:1039-1049`).
  - Existing `~/.claude/projects` JSONL histories can be imported (`claude_code.go:163`).
- **Codex.**
  - Driven through `codex app-server` JSON-RPC (`codex.go:18`), with codegen pinned to the Codex protocol (ADR 0001/0002).
  - Covers approvals, MCP, goals, review, fork and image generation (`runtime/codex_appserver_*.go`).
- **Lifecycle.**
  - Controller start/resume/cancel is scoped per session.
  - Live sessions are released when idle.
  - `SubscribeWhenAvailable` lets observers reattach after a daemon restart (`packages/agent/daemon/README.md`).
- **Process cassettes.** A record/replay transport for provider stdio is used for deterministic regression tests (`runtime/process_transport_recording.go`, `process_transport_replay.go`; ADR 0010).

## Models, tools, subscriptions and environments

- **Subscriptions.**
  - Claude: the SDK is pointed at the user's logged-in `claude`. Auth is probed against `https://api.anthropic.com/api/oauth/usage` with the stored OAuth token (`claude_code.go:36-47`).
  - Codex: account status is read through app-server.
  - Login files are projected into a session-private provider home by symlink, falling back to Mutagen two-way sync on Windows (`runtimeprep/mutagen_auth.go:44`, `codex_provider_state_home.go`).
  - API keys remain optional (`CredentialEnvVars`, `claude_code.go`).
- **Model access plans.** Optional per-workspace endpoint plus encrypted credential. Codex receives a loopback Responses-to-Chat gateway (`services/tuttid/service/modelgateway`; `docs/architecture/model-access-plans.md`).
- **Tutti Agent.** The vendor's own Codex-derived CLI (`tutti-agent app-server`, `providers.go:84`). It needs a Tutti sign-in and is billed by credits (`docs/architecture/agent-account-and-commerce.md`).
- **Tools.**
  - The main tool channel is the `tutti` CLI capability registry, documented to each agent by injected skills: `tutti-cli`, `tutti-handoff`, `issue-manager`, `reference`, `workspace-app`, `browser-use`, `computer-use` (`packages/agent/runtimeprep/skill_templates/`).
  - Connectors install MCP servers or CLI shims, available to every agent (`docs/architecture/connector.md:310-322`).
  - There are also a browser node and a computer-use capability.
- **Isolation.**
  - Issue Tasks that run in parallel on a shared git checkout get a per-run git worktree under `<state>/task-worktrees`. A shared non-git directory degrades to exclusive dispatch (`services/tuttid/service/workspace/issue_task_worktree.go:28,58`).
  - Ad-hoc agent sessions run in the user's cwd.
  - Sandboxing is the provider's own: Codex sandbox policy, Claude permission modes. `CommandNetworkAccessPolicy` only toggles Codex `networkAccess` (`packages/agent/daemon/README.md`).
  - No container or VM in the open repo.

## Context and memory scoping

- **Workspace is the boundary.** Every agent in a local workspace can read every other session's canonical activity, Issue outputs and app artifacts through the CLI. No per-agent private scope was found.
- **Mentions resolve live.** A `workspace-reference` mention is a handle, not an expanded file list. The agent resolves it at use time with `tutti reference list`, and workspace scope must match the invocation context (`docs/architecture/agent-reference-mention-resolution.md`).
- **CLI context is self-asserted by the caller.**
  - The `tutti` CLI builds its context from environment variables: `TUTTI_WORKSPACE_ID`, `TUTTI_AGENT_SESSION_ID`, `TUTTI_AGENT_CWD`, `TUTTI_AGENT_RAIL_PLACEMENT` (`apps/cli/internal/app/run.go:242-254`).
  - It authenticates with the single daemon bearer token read from the listener endpoint file (`apps/cli/internal/daemon/endpoint.go:56-62`).
  - Docs call this "trusted Agent Session context". The source shows it is trusted only in the sense that the daemon injected those variables. A process with shell access could set other values. The handoff skill relies on the instruction "Never set `TUTTI_AGENT_CWD` ... manually" (`tutti-handoff.md`).
- **Host routes.** Daemon-internal routes freeze context and forbid filter bypass (`services/tuttid/service/cli/host_route.go:31`). Reviewer agents get an allow-list of capabilities (`services/tuttid/tutti_mode_goal_review_agent_adapter.go:20-27`).
- **Closed tier (contract only).** `SessionScope { InitiatorUserID, ExecutorOwnerUserID, SourceDeviceID, SharedAgentBindingID, LaunchKind, Visibility(members|public) }` and `TargetScope { OwnerUserID, OwnerDeviceID }` (`packages/agent/activity-replication/types.go:166-182`, `validation.go:15-16`). This is the data model for "agent borrowing": one person's session runs on another owner's agent. Enforcement lives in `tsh-server`, which is not present.

## Identity, permissions and autonomous execution

- **Humans.**
  - The local daemon actor is the constant `"local"` (`services/tuttid/service/workspace/issues.go:17`).
  - Issue rows carry `creator_user_id` and Run rows `requester_user_id` / `agent_user_id`, which suggests a multi-user schema shared with TSH.
  - The Tutti account (cookie authorizer, `services/tuttid/service/account`) gates Tutti Agent, credits, connectors and mobile pairing.
- **Daemon authn.** One `TUTTID_ACCESS_TOKEN` bearer for all clients, including agents via the CLI (`services/tuttid/server/server.go:112`). Workspace apps get derived per-app tokens (`server.go:43-63`).
- **Approvals.**
  - Approvals are delegated to each provider's permission protocol and shown as durable pending items. A reconnect marks them interrupted instead of silently rejecting (ADR 0006).
  - Claude session-only grants are kept in memory and never widened (`claude-sdk-sidecar/src/sessionPermissionLedger.ts:12`).
  - Permission modes per provider range from ask-before-write to full-access (`claude_code.go` composer profile).
  - There is no Tutti-owned policy floor beyond the provider modes.
- **Unattended work.**
  - Tutti Mode can run a full plan: a watchdog wakes the source agent every 5 minutes of inactivity (`docs/architecture/issue-execution.md`, `watchdogDueAt`).
  - Tasks with `AutoAccept` skip the human gate (`model.go:170`).
  - `dispatchPaused` is the stop switch.
- **Audit.** Goal-review audit table, execution mutations history and session audit projection (`migrations_tutti_mode_execution.go:365`; `runtime/session_audit_projection.go`).

## Coordination of tasks and dependencies

This is the strongest area.

- **Data structures.**
  - Issue fields: `SequentialExecution`, `ParallelExecution`, `DispatchPaused`, `Budget`.
  - Task fields: `DependencyTaskIDs`, `Parallelizable`, `AutoAccept`, `AcceptanceState`, `SupersededByTaskID`, `AgentTargetID`, `ExecutionDirectory`.
  - Run fields: `AgentSessionID`, `Usage`, `OutputDir`.
  - Sources: `packages/workspace/issues/model.go:106-211`.
- **Claim.**
  1. Under a per-Issue in-process mutex (`issue_mutation_locks.go`, explicitly "not a durable transaction boundary"), the dispatcher rechecks pause, budget and dependencies, then creates a durable `running` Run. That Run "is the claim that prevents duplicate dispatch" (`issue-execution.md`).
  2. Launch (worktree plus agent session) happens after the lock is released (`issues.go:379-397`).
- **Dependencies.** A task is eligible only if every dependency is `completed` **and** `user_accepted` and not superseded (`packages/workspace/issues/normalize.go:207-225`).
- **Idempotent delivery.**
  - Deterministic `clientSubmitID = "issue-run:<runID>"` (`normalize.go`, `IssueRunClientSubmitID`).
  - `workspace_issue_run_launch_intents` with owner/lease and a strict current-owner CAS on `MarkDispatched`.
  - `workspace_issue_run_cancel_compensations` for exact-turn cancellation after races (`migrations_tutti_mode_execution.go:201,251`).
- **Recovery.** Startup repair and `RecoverEligibleIssueDispatches` (`issue_dispatch_recovery.go:14`). Launch failures settle the claimed Run idempotently.
- **Orchestrator loop (Tutti Mode).**
  - Finishing a task never dispatches the next one mechanically.
  - A durable "wake" asks the source agent to issue a fenced `schedule/mutate/acknowledge/complete/stop` command carrying an expected graph revision (`issue-execution.md`; CLI paths at `tuttimodeplan/commands.go:132-196`).
- **Ad-hoc agents (outside Issues).**
  - Handoff via `tutti agent start/send/wait` with a "one session receives follow-ups" rule.
  - Duplicate check is advisory: `agent sessions` / `agent active-peers` (`tutti-handoff.md`).
- **Collaboration runs.** Consult, fork, delegate and handoff are recorded with trigger source (user/agent/policy), context scope, tokens and adoption (`services/tuttid/biz/collabrun/model.go:22`).

## Collaboration between different human owners

- **Open repo:** not possible. Everything is one local daemon and one SQLite file per user. No transport carries another person's tasks or sessions.
- **Closed TSH, as visible from shared code:**
  - an activity-replication upload contract with idempotent mutation IDs, stale-snapshot no-ops and projection epochs, sunk into `tsh-server` MySQL (`packages/agent/activity-replication/README.md`);
  - room presence APIs (`userpresence`);
  - a room-scoped CLI mode in skill templates (`HostFacts.WorkspaceScope "room"`, `tutti-handoff.md`);
  - workbench host sessions that prevent "one user's cached snapshot from leaking into another user's room session" (ADR 0009).
- **Trust model (inferred):** central and vendor-hosted. The Room lives in the vendor cloud and membership is server-authoritative. Unverified, because the server is closed.
- **Device link.** `packages/device-link` was upstreamed from TSH. It is pinned-certificate QUIC with ICE and relay. In the open repo it is used only for a user's own phone-to-desktop link.

## Verification and acceptance of outcomes

- **Acceptance gate.** Each Task passes through `pending_acceptance` → `user_accepted`. States are `agent_claimed`, `auto_checked`, `user_accepted` (`model.go:44-50`). Successors only unblock on `user_accepted` (`normalize.go:221`).
- **Goal review.**
  - A separate read-only reviewer agent session is limited to issue-read commands plus `tutti goal-review verdict`. Verdicts are `goal_satisfied | more_work_required | inconclusive` and are fenced by checkpoint and graph revision (`services/tuttid/service/tuttimodeexecution/reviews.go:146`, `prompts.go:168`).
  - If the reviewer fails, the result "fails closed"; switching to self-review needs an audited user action (`prompts.go:144-148`).
- **Not found:** Tutti running tests, CI, diffs-as-evidence or a branch hand-off itself. Run outputs are files in `output_dir`.

## Install to first useful result

As documented:

1. Download the macOS DMG or Windows EXE from tutti.sh (`README.md`, Quick Start).
2. Install or sign in to Claude Code / Codex. Tutti can install them through the official scripts or npm (installer descriptors in `providerregistry`).
3. Open a workspace and start an agent.

No Docker or cloud account is needed for Claude or Codex. A Tutti account is needed for Tutti Agent, connectors and mobile pairing.

Developer build: Node 24, pnpm 10.11, Go 1.24, `pnpm install`, `make dev-gui` (`CONTRIBUTING.md:21-60`). Tutti · VM needs an invite code to create a Room (README).

## For Botbench

### Learn

- Tutti, like Botbench, drives the official CLIs on the user's own subscription. It is the strongest public reference for doing that across Claude Agent SDK, Codex app-server and ACP behind one descriptor registry.
- Its answer to "agents share context" is not a shared memory model. It is one normalized activity store, plus a CLI the agents call, plus skills that teach them when to call it. That is cheap and works across providers.
- Multi-user is split cleanly: the open repo is single-user. The multi-user layer is a closed cloud projection fed by a versioned replication contract whose session scope separates initiator from executor owner. That is the shape of "use someone else's agent", and Botbench Peers needs the same distinction.

### Reuse conceptually (with source references)

Apache-2.0: patterns and code may be adapted with attribution and NOTICE retention.

- **Declarative provider descriptors.** One struct carries command, auth probe, login, auth-file watch, installer, permission-mode mapping and slash-command effects (`packages/agent/daemon/providerregistry/claude_code.go:10-173`, `types.go`). Botbench's adapter layer could converge on this.
- **Durable run-as-claim with deterministic submit ID.** Plus a launch-intent lease, current-owner CAS and cancel-compensation rows (`packages/workspace/issues/normalize.go` `IssueRunClientSubmitID`; `migrations_tutti_mode_execution.go:201-300`; `docs/architecture/issue-execution.md`). Directly applicable to Botbench claims surviving restarts.
- **Dependency readiness requires human acceptance.** `normalize.go:207-225`, with `AutoAccept` as an explicit per-task opt-out (`model.go:170`).
- **Mention URIs routed to skills plus a scoped CLI.** Resolution is lazy and live (`runtime/tutti_mention_routing.go:30`; `docs/architecture/agent-reference-mention-resolution.md`). A good template for referencing a peer's task or evidence without pasting it.
- **Independent read-only reviewer with a capability allow-list and a fenced verdict.** Fails closed (`tutti_mode_goal_review_agent_adapter.go:20-27`; `tuttimodeexecution/prompts.go:144-188`).
- **Replication contract fields.** `SessionScope.InitiatorUserID / ExecutorOwnerUserID / SharedAgentBindingID / Visibility` and idempotent mutation semantics (`packages/agent/activity-replication/types.go:166-200`, README). A reference for ADR 0004 workbench-to-workbench message shapes.
- **Per-run worktree only when concurrency needs it; otherwise degrade to exclusive.** `issue_task_worktree.go:58`.
- **Auth-file projection into session-private provider homes.** `runtimeprep/mutagen_auth.go`, `codex_provider_state_home.go`.

### Improve on

- **Agent identity on the CLI is environment-asserted under one shared daemon token** (`apps/cli/internal/app/run.go:242-254`, `endpoint.go:56-62`). Botbench's permission broker can issue per-session credentials, so one agent cannot act as another session.
- **No Tutti-owned safety floor.** Permissions are whatever the provider mode allows, up to `bypassPermissions` / full-access. Botbench's broker and floor are a real differentiator.
- **Conflict avoidance between ad-hoc agents is advisory and self-blind.** `active_peers.go:19-39` returns `SELF_IDENTITY_UNAVAILABLE`, and there is no file or path claim.
- **No verification evidence.** Acceptance is a human click or an LLM verdict. Tests run, diffs and branches are not captured. Botbench delivers a verified branch with evidence.
- **Cross-owner collaboration is closed, vendor-hosted and invite-gated.** Botbench Peers can do it open and self-hosted, over GitHub or direct links between workbenches.
- **The Issue mutation lock is in-process only, by its own comment** (`issue_mutation_locks.go:5-10`). Fine locally, but not a multi-installation coordination primitive.

### Deliberately avoid

- The size of the engineering surface: ADRs on turn-lifecycle authority, generation fences and saga replay. Botbench's "least effort to prove value" rule argues against copying this depth before a Peers milestone exists.
- A product split where collaboration needs the vendor's cloud and account (control plane `tutti.sh`, `ws.tutti.sh`).
- Using the Claude Agent SDK against a consumer OAuth subscription without checking provider terms. Tutti does this (`claude_code.go:24,36`). Botbench drives the CLI itself; keep that boundary deliberate.
- Prompt-only guards ("never set TUTTI_AGENT_CWD manually") standing in for enforced boundaries.

## Capability ratings

1. byo-agent-clis: Implemented. Claude (Agent SDK on the local `claude`), Codex app-server, Cursor/OpenCode/Hermes/Kimi via ACP, all on existing logins.
2. model-providers: Implemented. Eight canonical providers, pinned extension sources (Gemini, Copilot, Qwen, Grok, and others, mostly disabled), plus custom endpoint model plans.
3. tools-connectors: Implemented. CLI capability registry, MCP/CLI connector market, browser and computer use, app commands. Most apps are remote downloads.
4. isolation: Partial. Per-run git worktrees for parallel Issue tasks only. Provider sandboxes otherwise. VM isolation is closed and Unverified.
5. approvals: Implemented. Provider approval prompts as durable pending items. No Tutti-owned policy floor.
6. memory-scoping: Partial. The workspace is the only boundary and there is no per-agent private scope. Room scoping exists only as a contract.
7. identity-authz: Partial. Single daemon bearer. Agent session identity is asserted by environment variables. Account login is vendor-hosted.
8. task-coordination: Implemented. Durable Run claims, dependencies gated on acceptance, leases, CAS, compensation, recovery.
9. cross-owner: Unverified. Closed Tutti · VM. Only the replication contract and presence API are open.
10. peer-transport: Partial. ICE/QUIC device link with relay, used for own phone to own desktop through the vendor control plane.
11. verification: Partial. Human acceptance gate plus an independent LLM goal reviewer. No test or diff evidence.
12. durability: Implemented. SQLite, startup repair, watchdog wakes, idempotent submit IDs, cassette replay.
13. budgets-usage: Implemented. Per-Issue token budgets with soft limit, run usage, provider rate-limit and usage probes, credits.
14. audit-observability: Implemented. Execution mutation history, goal-review audit, session audit projection, diagnostics logs.
15. remote-mobile: Implemented. React Native app over device link. Needs a tutti.sh account and pairing.
16. time-to-first-result: Low effort. Desktop installer plus existing Claude/Codex login. No Docker or keys.

## Open questions

- Does TSH's "managed local VM" actually isolate agent execution and file access, and what crosses into the cloud Room (full transcripts, files, or only projections)?
- How does agent borrowing authorize one person's prompt to run on another owner's subscription and machine? Who approves tool calls, and whose account pays?
- Can the source agent run a Tutti Mode plan to completion unattended with `AutoAccept` and full-access mode, and how often does the watchdog loop drift in practice?
- How reliable is skill-routed mention resolution across providers, given that it depends on each agent choosing to call the right skill?
- Does the Claude Agent SDK path keep working on consumer subscriptions over time, and does the vendor gate it?
