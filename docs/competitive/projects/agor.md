# Agor

| | |
|---|---|
| Repository | https://github.com/preset-io/agor |
| Commit read | b58fb20, 2026-11-19 (shallow clone); published package `agor-live` 0.29.0 (`packages/agor-live/package.json:3`) |
| Licence | Business Source License 1.1 (`LICENSE`). Licensor: Preset, Inc. Additional Use Grant: production use is allowed except for an "Agor Offering", defined as a commercial product or service offered to third parties whose primary purpose is to provide the Licensed Work's functionality to orchestrate or manage AI coding agents (hosted, managed, or bundled for customers to operate); consulting, support and integration, including running a deployment solely for one customer's internal use, are not an Agor Offering. Change Date: 2029-01-15, or the fourth anniversary of a given version's first public distribution, whichever comes first. Change Licence: Apache 2.0. This is source-available, not open source. Botbench is itself a tool that orchestrates coding agents, so code from this repo must not be copied into Botbench; only ideas can be used. A separate hosted product, Agor Cloud (open beta), is linked from `README.md:21` and its code is not in this repo. |
| Stack | TypeScript monorepo (pnpm and turborepo). Daemon: FeathersJS (REST, WebSocket, JSON-RPC `/mcp`), Drizzle ORM over LibSQL/SQLite (default, `~/.agor/agor.db`) or PostgreSQL (multi-tenant and HA). UI: React 18, Vite, Ant Design, React Flow. CLI: oclif. Agent runtime: a separate `packages/executor` process per task. Distributed via npm (`agor-live`) or Docker Compose; optional Redis for HA realtime. |
| Size and activity | About 326 MB on disk with docs media; about 4,600 files outside `node_modules`, about 2,800 `.ts` files. Very large test surface: most source files have a sibling `.test.ts`, plus `.postgres.test.ts` and HA tests. Long comments describe locking, fencing and crash recovery in detail. This reads as a mature product under heavy, recent hardening for multi-tenant and HA hosting. |
| Evidence basis | Source read only; not run |

## Promise and intended customer

The README pitch is "Multiplayer AI. Work together again." (`README.md:5`): a shared web workspace where a team and its coding agents work on one live 2D board. Each piece of work is a git branch with its own working directory, dev environment, conversations and PR. Agents are Claude Code, Codex, Gemini, OpenCode, Copilot and Cursor, driven through their SDKs, and the README says you bring your own provider and subscription (`README.md:27-31`). Agor also adds long-lived "AI teammates" with knowledge-base memory, a Slack/GitHub/Teams/Discord message gateway, a scheduler, and an MCP server that lets agents drive Agor.

The customer is one engineering team, or one company with several teams, sharing one Agor deployment: either self-hosted (one daemon, one database) or the hosted Agor Cloud. The model is a single shared server that everyone logs into. It is not a set of separately owned installations that talk to each other.

## What is actually implemented

| Capability (README headline) | Evidence | Source reference | Note |
|---|---|---|---|
| Drives the agent CLIs/SDKs you already use | Implemented | `packages/agentic-tools/src/index.ts:41-120`, `packages/executor/src/handlers/sdk/tool-registry.ts` | Six integrations. Claude through `@anthropic-ai/claude-agent-sdk` (`packages/agor-claude/src/index.ts:3`); Codex through `@openai/codex-sdk` plus a `codex app-server` JSONL sidecar used only for thread fork (`packages/executor/src/sdk-handlers/codex/app-server-client.ts:26-30`). |
| BYO subscription | Implemented, with conditions | `packages/core/src/config/key-resolver.ts:20-50` (`useNativeAuth`), `packages/core/src/config/claude-subscription-oauth.ts:25-58` | Keys resolve from user, then tenant, else "native auth" (the CLI's own login). Managed Claude subscription OAuth is available only with contained credential storage or delegated mode. |
| Branches as isolated working directories | Implemented | `packages/core/src/db/schema.sqlite.ts:729-800`, `apps/agor-daemon/src/services/repos.ts:943-975` | Git worktrees under `~/.agor/worktrees/<repo>/<name>`; the executor creates them; `filesystem_status` goes from `creating` to `ready`. |
| Per-branch dev environment, ports assigned automatically | Implemented (deterministic offset, no probing) | `packages/core/src/environment/variable-resolver.ts:25-35`, `apps/agor-daemon/src/services/branches.ts:419-470,2789-2894` | Each branch gets the lowest unused integer `branch_unique_id`; templates compute ports such as `{{add 10000 branch.unique_id}}`. I found no check that a port is free. |
| Live spatial board, zones fire templated prompts | Implemented | `packages/core/src/types/board.ts:79-135`, `apps/agor-daemon/src/services/zone-trigger.ts:65-126` | `always_new` creates a session and sends the rendered Handlebars prompt; `show_picker` lets the user pick an existing session. |
| Session trees: fork and spawn | Implemented | `apps/agor-daemon/src/services/sessions.ts:1126-1215` (fork), `:1221-` (spawn); schema `schema.sqlite.ts:102-104,156-162` | Fork resumes the parent SDK session with `forkSession: true` (`packages/executor/src/sdk-handlers/claude/query-builder.ts:352-365`). |
| Child-completion callbacks | Implemented | `packages/core/src/callbacks/child-completion-template.ts:1-40`, `schema.sqlite.ts:261-297` | The parent gets a templated message when a child finishes; cross-branch links are stored in `session_relationships`. |
| Live cursors, facepile, comments | Implemented | `packages/core/src/types/presence.ts:11-26`, `apps/agor-daemon/src/realtime/routing.ts:177`, `apps/agor-daemon/src/services/board-comments.ts`, `schema.sqlite.ts:2219-2260` | Comments attach to a board, branch or session and have a `resolved` flag. |
| Shared multiplayer terminal ("see each other's keystrokes", `apps/agor-docs/content/guide/multiplayer-social.mdx:99-101`) | Partial; the claim is not backed | `apps/agor-daemon/src/services/terminals.ts:119-128` | The docs say tmux. The code uses Zellij, and the session name is a hash of tenant, **user** and branch, so each user gets a separate terminal. The realtime channel is per user (`realtime/routing.ts:147`). |
| Branch-scoped RBAC | Implemented | `schema.sqlite.ts:1285-1493`, `apps/agor-daemon/src/utils/branch-authorization.ts:316-340` | Viewer, Collaborator and Manager roles, plus a separate `none/read/write` filesystem dimension; user and group principals. |
| Per-user credentials and env vars | Implemented | `apps/agor-daemon/src/services/sessions.ts:1186-1200`, `context/concepts/session-sharing.md` | Env var *names* are copied on fork and resolved against the child owner's own values. |
| Execution modes simple / sandbox / delegated | Implemented; sandbox is Linux only | `apps/agor-daemon/src/utils/sandbox-wrap.ts:117,130-265`, `packages/core/src/unix/bwrap.ts`, `apps/agor-daemon/src/utils/spawn-executor.ts:14-20,90-97` | The default is `simple` (`packages/core/src/config/config-manager.ts:2394`): agents run as the daemon user with no filesystem boundary. |
| Agor MCP server (agents drive Agor) | Implemented | `apps/agor-daemon/src/mcp/server.ts:932`, `apps/agor-daemon/src/mcp/tools/*.ts` (about 156 `agor_*` names), `apps/agor-daemon/src/mcp/tokens.ts:1-28` | Search/describe/execute facade (`register-tool-proxy.ts:25`). |
| Per-prompt token and dollar accounting | Implemented | `schema.sqlite.ts:364-372`, `apps/agor-daemon/src/services/leaderboard.ts:303` | Raw and normalized SDK responses are stored per task; the leaderboard sums `costUsd`. |
| Budgets or spend caps | Absent | none found | No spend-limit field or check found. The many "budget" hits are time budgets. |
| Scheduler | Implemented | `apps/agor-daemon/src/services/scheduler.ts:536`, `schema.sqlite.ts:239-245` | The unique index on `(schedule_id, scheduled_run_at)` prevents a duplicate run. |
| Message gateway (Slack, GitHub, Teams, Discord, others) | Implemented | `packages/core/src/gateway/connectors/github.ts:1-20,151-160`, `schema.sqlite.ts:2345-2370` | The GitHub connector **polls** for @mentions in PR and issue comments. |
| Teammates with memory | Implemented | `packages/core/src/types/branch.ts:902-990`, `schema.sqlite.ts:2800-2880` | A teammate is a branch with `custom_context.teammate`, and its memory lives in KB namespaces. |
| Post-task reports | Partial | `packages/core/src/types/report.ts:1-40` | The type describes auto-generated reports. I found no generator in the executor or daemon. |
| Mobile UI | Implemented (shell) | `apps/agor-ui/src/App.tsx:142,222-224` | A separate lazy-loaded `MobileApp`. |

## Architecture

```
agor-cli (oclif) ─┐
agor-ui (React) ──┼─ Feathers client (REST + WS) ──► agor-daemon (FeathersJS)
external SDK ─────┘                                  ├─ services/*  (hooks: auth, RBAC, short-id)
                                                    ├─ POST /mcp  (stateless, JWT per session/task)
                                                    ├─ scheduler, gateway listeners, health monitor,
                                                    │  task-runtime reconciler
                                                    ├─ Drizzle ─► LibSQL ~/.agor/agor.db | PostgreSQL (+RLS)
                                                    └─ spawn-executor ─► executor process (per task / command)
                                                                         ├─ local: daemon user (simple)
                                                                         ├─ local + bwrap mounts (sandbox, Linux)
                                                                         └─ executor_command_template (delegated: k8s/docker/remote)
                                                                         executor ──WS (Feathers client)──► daemon
```

- Data model (`packages/core/src/db/schema.sqlite.ts`): `repos` → `branches` (worktree path, `branch_unique_id`, env commands, `primary_owner_user_id`, `permission_binding`) → `sessions` (required `branch_id`, `parent_session_id`, `forked_from_session_id`, `sdk_home_scope`, status) → `tasks` (one prompt; `queued…completed`, `queue_position`, heartbeat and termination columns) → `messages`. There are also `boards`, `board_objects` (zones, notes), `board_comments`, `schedules`, `gateway_channels`, `kb_*`, `mcp_servers`, `users`, `groups`, and capability-policy tables.
- The daemon owns the database. The executor never touches it directly: it connects back as a Feathers WebSocket client with a scoped token (`packages/executor/src/sdk-handlers/base/tool.interface.ts:66-97`: "MUST call messagesService.create()"). Payloads reach the executor on stdin, and in delegated mode the launcher environment is stripped of daemon secrets (`apps/agor-daemon/src/utils/spawn-executor.ts:90-97`).
- Task queueing is durable and lives in the `tasks` table, with no separate queue table. Admission takes Branch and then Session row locks and allows one non-terminal task per session. Later prompts are inserted as `queued` with `max(queue_position)+1` (`context/concepts/task-queueing.md`, implementation referenced at `apps/agor-daemon/src/utils/prompt-admission-transaction.ts`).
- Supervision: the executor heartbeat defaults to 10 s, with a stale threshold of max(3 intervals, 30 s) (`packages/core/src/config/executor-heartbeat.ts:4-40`). `task-runtime-reconciler.ts:25-31` classifies tasks as `dispatch_timeout`, `heartbeat_stale` or `termination_stranded` and fails them with "Executor heartbeat lost".

## How agents are connected and managed

- **Two registries.** `packages/agentic-tools/src/index.ts:27-120` defines each integration: name, `authentication: 'api-key' | 'runtime-managed'`, `apiKeyName`, and `configHomeOverride`, the env vars that relocate the tool's config home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, the `XDG_*` set for OpenCode, `COPILOT_HOME`). The comment at `packages/agentic-tools/src/types.ts:27-30` says the relocation recipe is "recorded here (Phase 2) but not yet applied at runtime". Separately, `packages/executor/src/handlers/sdk/tool-registry.ts` maps each `Tool` to a `ToolRunner`, and `handlers/sdk/{claude,codex,gemini,copilot,opencode,cursor}.ts` build each one through `createTool(repos, apiKey, useNativeAuth)` (`base-executor.ts:562-632`).
- **Contract.** `ITool` (`packages/executor/src/sdk-handlers/base/tool.interface.ts`) has capability-gated optional methods: `createSession`, `executeTask` with streaming callbacks, `getSessionMessages`, and others. A normalizer per tool converts SDK output into Agor messages (`sdk-handlers/normalizer-factory.ts`).
- **Adding a tool.** Add a new `defineIntegration` entry, a `handlers/sdk/<tool>.ts` runner, an `sdk-handlers/<tool>/` normalizer and tool, and extend the `agentic_tool` enum in both schemas (`schema.sqlite.ts:91-95`). This is a code change and a migration, not a plugin.
- **Lifecycle.** Prompt, then durable task admission, then executor spawn after commit, then the executor claims `dispatching → running`, then heartbeats and SDK "pulses" (`packages/executor/src/sdk-watchdog.ts`), then the task ends. Conversation continuity comes from the stored `sdk_session_id` (`schema.sqlite.ts:150`). Stop goes through a termination coordinator with a claim token and expiry (`schema.sqlite.ts:315-320`).
- **Approvals.** Claude's `canUseTool` and PreToolUse hooks (`sdk-handlers/claude/query-builder.ts:647-661`, `sdk-handlers/base/permission-hooks.ts:216-356`) set the task and session to `awaiting_permission` and wait for a WebSocket decision. Scopes `once` and remember-scoped map to SDK permission destinations. Codex uses its own `sandboxMode` and `approvalPolicy` (`schema.sqlite.ts:171-177`).

## Models, tools, subscriptions and environments

- **Credentials.** `resolveApiKey` (`packages/core/src/config/key-resolver.ts:33-50`) checks a user connection, then a tenant connection, then falls back to `useNativeAuth`, meaning the CLI's own login on the host. Keys are encrypted at rest (`packages/core/src/db/encryption.ts`). Claude subscription OAuth and Codex device auth have durable attempt tables (`schema.sqlite.ts:2101-2218`). In `simple` mode, any native login on the host belongs to the daemon account and is shared by every user's sessions. That is my inference from the default execution mode and the fallback, not a statement in the code.
- **Models.** Per-session `model_config` (`model`, `mode`, `effort`, `provider`) and tool presets (`agentic_tool_presets`, `schema.sqlite.ts:1551`). Breadth comes from the six SDKs. OpenCode brings many providers.
- **MCP and tools.** A user/tenant MCP server registry with OAuth tokens per user (`schema.sqlite.ts:1608,1950-2066`), attached per session (`session_mcp_servers`). There is an MCP egress gateway (`apps/agor-daemon/src/mcp-egress/`, `context/concepts/mcp-egress-gateway.md`) and per-tool allow/deny (`executor/src/sdk-handlers/base/mcp-tool-permissions.ts`).
- **Isolation.**
  - `simple` (default): the executor runs as the daemon user with no filesystem boundary. The user docs warn that a member's terminal can read the config, the DB and the JWT secret (`apps/agor-docs/content/guide/multiplayer-social.mdx:125`).
  - `sandbox`: bubblewrap with mounts derived from RBAC (writable, read-only or absent branch). It masks daemon state and fails closed. It is Linux only (`apps/agor-daemon/src/utils/sandbox-wrap.ts:117,171-172`), so it is not available on macOS.
  - `delegated`: `executor_command_template` hands launch to an external substrate that receives `{tenant_id}`, `{user_id}`, `{branch_fs_access}` and `{branch_sdk_home}` (`context/guides/rbac-and-unix-isolation.md`). Earlier `strict`/`insulated` modes that created Unix users and used sudo were removed in 0.25.
- **Environments.** A repo's `.agor.yml` defines named variants with `start`, `stop`, `nuke`, `logs`, `health` and `app` templates (`apps/agor-docs/content/guide/environment-configuration.mdx:55-80`). These render into branch columns (`schema.sqlite.ts:751-760`). Start, stop and restart run through the executor with an issued command token and time budgets (`apps/agor-daemon/src/services/branches.ts:419-470`). A health monitor probes `health_check_url` with public-URL restrictions in multi-tenant mode (`branches.ts:3027-3055`). HA uses claim/expiry columns on the branch row (`schema.sqlite.ts:763-772`). Port isolation is arithmetic only: the docs say "Choose a free port range on your host".

## Context and memory scoping

- **Session SDK state.** `sdk_home_scope` is immutable, either `execution_home` (the creator's private home) or `branch` (shared, branch-owned) (`schema.sqlite.ts:63-76`). Only `branch` sessions can ever be prompted by another person.
- **Knowledge base.** Namespaces have `kind` system, global, user, repo, branch or team; `visibility_default` public or private; `others_can` none, read or write; plus a user/group ACL with read, write or own (`schema.sqlite.ts:2800-2880`). A teammate has a primary namespace. Its daily memory (`memory/{{YYYY-MM-DD}}.md`) is private to the owner by default. Its per-namespace grants are a ceiling intersected with the calling user's own permission (`packages/core/src/types/branch.ts:933-970`).
- **Credentials and env vars.** These belong to the actual caller, never to the session owner. A fork copies only env var names (`apps/agor-daemon/src/services/sessions.ts:1186-1200`). A foreign prompt uses the caller's execution home, credentials and MCP visibility (`context/concepts/session-sharing.md`, enforced through `resolveSessionPromptAccess` at `apps/agor-daemon/src/utils/branch-authorization.ts:316-340`).
- **Tenant boundary.** PostgreSQL RLS plus a trusted tenant context on every call (`packages/core/src/db/tenant-scope.ts`, `tenant-write-gate.ts`), and CI scripts `check:multitenancy-boundaries` and `check:daemon-filesystem-boundaries` (`package.json` scripts).
- **The branch filesystem is shared.** Every session on a branch, whoever owns it, works in the same worktree (`context/concepts/branches.md`). In `simple` mode, files on the host are not private.

## Identity, permissions and autonomous execution

- **People.** The `users` table holds email, bcrypt password and role `superadmin | admin | member | viewer` (`schema.sqlite.ts:1039-1062`). There are groups, API keys (`user_api_keys`, `apps/agor-daemon/src/auth/api-key-strategy.ts`), refresh tokens, and one-time launch auth. I saw no SSO login strategy in `apps/agor-daemon/src/auth/`; `user_external_identities` (`schema.sqlite.ts:1212`) appears to map gateway identities.
- **Resources.** Boards carry `board_access` and a `branch_template`. Branches either inherit the template or override it. Roles are Viewer, Collaborator (create sessions and prompt your own) and Manager (lifecycle, environment, policy). A primary owner is transferable only through explicit ownership commands (`context/guides/rbac-and-unix-isolation.md`).
- **Agents.** An agent acts as the user who created its task. MCP tokens are JWTs with `sub`=session, `uid`, `tid`, `tsk`=task and a 24 h expiry. They are rejected once the session is deleted or the task's executor no longer owns a live task, and branch access is re-checked on every request (`apps/agor-daemon/src/mcp/tokens.ts:1-28`). Each heartbeat re-checks filesystem access and terminates the executor if access dropped (`rbac-and-unix-isolation.md`, "Task launch and heartbeat").
- **Approvals.** The server ignores any client-supplied `decidedBy` and records the authenticated user. The decider needs the same authority as someone allowed to prompt the session (`apps/agor-daemon/src/permissions/deliver-permission-decision.ts:25-106`). Decisions can time out (`packages/executor/src/permissions/permission-service.ts:39-50`).
- **Unattended work.** Schedules and zone triggers start agents with no human prompt. Creating a schedule needs branch Manager, and the creator's membership and Manager role are re-checked at every fire. Permission mode per session can be `bypassPermissions` (`query-builder.ts:652`).
- **Audit.** Task `created_by`, prompt provenance (`db/prompt-provenance-persistence.*`), stored messages and tool calls, permission messages that record the approver, OpenTelemetry-style tracing (`apps/agor-daemon/src/tracing/`) and analytics. I found no separate append-only audit log table.

## Coordination of tasks and dependencies

There is no work-claiming protocol between agents. Coordination comes from structure:

- **Unit of isolation.** Each piece of work is a branch, a worktree that is usually one PR. Two pieces of work avoid file collisions by living on different branches. The repository fences overlapping workspace paths under a lock when a branch is created (`apps/agor-daemon/src/services/repos.ts:960-962`).
- **Per-session single flight.** Admission allows only one non-terminal task per session. Later prompts queue in order and can be reordered or cancelled through MCP (`agor_tasks_reorder_queued`, `agor_tasks_cancel_queued`; described at `apps/agor-daemon/src/mcp/tools/sessions.ts:736`). I found no rule stopping two sessions on the same branch from running at once in the same worktree.
- **Delegation and handoff.** Spawn (fresh context child) or fork (copied context sibling), then a completion callback into the parent (`packages/core/src/callbacks/child-completion-template.ts`). Callbacks can be one-shot or persistent, which enables multi-hop chains: C reports to B, then B reports to A (`context/concepts/mcp-session-tools.md`). A database uniqueness constraint coalesces equal callback events. The docs say delivery is best-effort if the daemon dies between the source task ending and the callback task being created.
- **Duplicate avoidance.** Only for schedules: the partial unique index `(schedule_id, scheduled_run_at)` (`schema.sqlite.ts:239-245`). There is no deduplication of human or agent work items. Board zones work as a visual Kanban stage, not as a lock.
- **Failure recovery.** Durable tasks; a heartbeat-stale reconciler (`apps/agor-daemon/src/services/task-runtime-reconciler.ts`); termination claims with token, expiry, instance and boot id (`schema.sqlite.ts:315-320`); branch deletion fenced by process identity (PID, boot id, PID namespace) with an administrator release path (`context/concepts/branches.md`). Recovery means marking work failed and fencing it safely. Resuming means a person or agent prompting the session again, which reuses `sdk_session_id`.
- **Daemon-level coordination** (`packages/core/src/coordination/index.ts:1-60`) provides only diagnostic instance and boot identity, plus backoff and jitter helpers for HA workers. It does not coordinate agents.

## Collaboration between different human owners

- **Within one deployment: strong.** Several people log into the same daemon and share boards, cursors, comments, branches and sessions. A Collaborator can prompt someone else's branch-home session only when three switches agree: the tenant `session_sharing_enabled` (default off), the branch's `allow_shared_session_prompts`, and the caller's `sessions.prompt_own`. The task then runs with the caller's credentials and is attributed to the caller (`context/concepts/session-sharing.md`). This is the clearest example I have seen of who-pays and who-is-accountable rules for prompting a shared conversation.
- **Across separately owned installations: absent.** I found no peer-to-peer protocol, federation, or daemon-to-daemon transport. The trust model is one operator, one database, one tenant boundary. The external channels are the message gateway (Slack, GitHub @mention polling, Teams, Discord, Shortcut, WhatsApp, Telegram, per `schema.sqlite.ts:2358-2360`), which routes outside messages *into* one deployment's branch. Tenant export and import (`packages/core/src/db/tenant-export.ts`, `tenant-import.ts`) moves data between deployments; it is not live collaboration.
- **What this means for Botbench Peers.** Agor answers "a team sharing one server", not "independently operated workbenches coordinating". Its sharing rules are still the right reference for the in-session part.

## Verification and acceptance of outcomes

- Agor itself runs no tests, gates or verification on agent output. Any verification is whatever the agent does in the branch, or what the per-branch dev environment lets a person inspect: one-click start, health probe, `app_url` for the team to open.
- Results are recorded as messages and tool blocks with diff enrichment (`packages/executor/src/sdk-handlers/base/diff-enrichment.ts`), task status, token and cost data, and child-completion reports. The `Report` type (`packages/core/src/types/report.ts`) describes auto-generated learnings and decisions reports, but I found no generator.
- PRs: the branch stores `pull_request_url` and `issue_url` (`apps/agor-daemon/src/mcp/tools/branches.ts:366,1051`). I found no code that opens PRs; the agent is expected to use git or gh itself.
- Acceptance is human: comments with `resolved`, zones as stages, and the `needs_attention` and `ready_for_prompt` flags (`schema.sqlite.ts:137,782`).

## Install to first useful result

As documented (`README.md:95-120`):

1. Node.js 22.12 or later and Git on `PATH`; SSH keys or a CA trust store for remotes.
2. `npm install -g agor-live`, then `agor init` to create the config and DB and install the selected agent tools, then `agor daemon start`, then `agor open`.
3. The onboarding wizard creates a board and "your first AI teammate". Log in to at least one agent (API key or the tool's native login).
4. To get per-branch dev environments, add a `.agor.yml` with start/stop/health templates and pick a free port range.
5. Teams: PostgreSQL, `sandbox` mode on Linux with bubblewrap, or `delegated` mode with your own launcher. HA needs Postgres and Redis (`docker-compose.ha.yml`). Docker Compose is an alternative install path. Hosted Agor Cloud is the managed option.

Solo time to a first agent session appears short on paper: three commands plus an agent login. Team-grade isolation on a Mac is not available, because sandbox mode needs Linux.

## For Botbench

### Learn

- A "branch = worktree = environment = PR" card as the unit of work is a strong, legible model for people watching agents. It matches Botbench's one-worktree-per-task.
- The hard problems Agor spent its effort on are attribution and authority when people share one conversation: whose credentials run, who approved, who may continue someone else's session. They are not the UI.
- Agor's isolation story depends on Linux: sandbox needs bubblewrap, and the default `simple` mode has no boundary. A Mac-first tool has to solve this differently.
- Agent self-access over MCP, with a tool-search facade instead of listing about 150 tools, keeps agent context small (`apps/agor-daemon/src/mcp/server.ts:9,175-177`).

### Reuse conceptually (with source references)

BSL 1.1: ideas only. Do not copy code or text. Botbench is a coding-agent orchestrator, so incorporated code could fall inside the "Agor Offering" restriction, and BSL terms would attach to derivative works.

1. **The caller pays and is accountable on a shared session.** A continued conversation runs with the actual prompter's credentials, execution home and MCP visibility, is attributed to them, and needs three independent switches (`context/concepts/session-sharing.md`; `apps/agor-daemon/src/utils/branch-authorization.ts:316-340`). Botbench Peers can adopt this when one developer's agent acts on another's issue or PR: the actor's own subscription and broker apply, never the requester's.
2. **Immutable SDK-home scope stamped at session creation** (`packages/core/src/db/schema.sqlite.ts:63-76`). It decides once whether a conversation's native CLI state is private or shareable, so the mount identity never changes under a resumable session. Botbench could mark a task as private or handoff-able when it is created.
3. **Server-side approver identity** (`apps/agor-daemon/src/permissions/deliver-permission-decision.ts:25-106`). Ignore the client-supplied approver, record the authenticated one, bind the request to session, task and request id, and require prompt authority to approve. This directly supports Botbench's permission broker audit.
4. **Deterministic per-worktree port offset** (`packages/core/src/environment/variable-resolver.ts:25-35`, templates in `apps/agor-docs/content/guide/environment-configuration.mdx:55-80`). Botbench should add a free-port probe on top.
5. **Completion callbacks into the parent session, with persistent versus once modes and multi-hop chains** (`packages/core/src/callbacks/child-completion-template.ts`, `context/concepts/mcp-session-tools.md`). For Peers, the same shape could post "child finished" back into the requesting issue or workbench.
6. **Zones as stage plus prompt template** (`apps/agor-daemon/src/services/zone-trigger.ts:65-126`). Moving work to a stage fires a templated prompt. The equivalent for Botbench is a GitHub label or project column that triggers a templated task.
7. **Heartbeat re-check of authority** (`context/guides/rbac-and-unix-isolation.md`, "Task launch and heartbeat"). Revoked access terminates a live executor and never widens it. This is useful if Peers can revoke a collaborator mid-task.
8. **Scheduled-run deduplication with a partial unique index** (`schema.sqlite.ts:239-245`). It is a cheap idempotency key for recurring or triggered runs.

### Improve on

- **Cross-installation collaboration.** Agor has none: one server, one DB, one operator. Botbench's North Star (separately owned workbenches) is space Agor does not address.
- **Verification.** Agor runs no tests or gates and attaches no evidence to an outcome. Botbench's "verified branch with evidence" is a clear difference.
- **Isolation on a Mac.** Agor's default `simple` mode has no filesystem boundary, and its sandbox is Linux only (`apps/agor-daemon/src/utils/sandbox-wrap.ts:171-172`). Botbench's broker plus safety floor can be strong on macOS where Agor's is not.
- **Concurrency within one branch.** Several sessions share one worktree, and I found no branch-level lock. Botbench's one-worktree-per-task avoids two agents editing the same tree.
- **Port allocation.** Agor computes ports without probing. Botbench can probe and record them.
- **Spend control.** Agor tracks cost and has no caps. Botbench can enforce budgets.
- **Docs drift.** The shared-terminal docs say tmux with shared keystrokes, while the code uses per-user Zellij sessions (`apps/agor-daemon/src/services/terminals.ts:119-128`). The relocation recipe for tool config homes is "not yet applied at runtime" (`packages/agentic-tools/src/types.ts:27-30`).

### Deliberately avoid

- A central shared server as the collaboration model. It conflicts with "each developer owns their installation and subscriptions".
- A trusted mode with no boundary as the default.
- The complexity burden. Multi-tenant RLS, HA fencing, and over 150 MCP tools are large infrastructure for a local one-process tool. Take the authority rules, not the machinery.
- Using an agent's SDK native login on a shared host. In `simple` mode it effectively pools one person's subscription across users.

## Capability ratings

1. byo-agent-clis: Implemented — six SDK-driven agents with native-auth fallback; managed subscription OAuth only in contained modes.
2. model-providers: Implemented — six harnesses, per-session model and effort config, OpenCode for wide provider reach.
3. tools-connectors: Implemented — MCP registry with per-user OAuth, egress gateway, Agor's own MCP server, and a Slack/GitHub/Teams/Discord gateway.
4. isolation: Partial — a worktree per branch; real filesystem isolation only in Linux bwrap sandbox or delegated mode; the default has none.
5. approvals: Implemented — PreToolUse/canUseTool waits for a decision bound to the server-side approver, with scopes and timeouts.
6. memory-scoping: Implemented — KB namespaces with ACLs, private teammate memory, immutable SDK-home scope, per-caller credentials.
7. identity-authz: Implemented — users, groups and tenant roles; branch and board capability policies; scoped MCP JWTs; no SSO found.
8. task-coordination: Partial — durable per-session queue, spawn/fork with callbacks, schedule dedup; no claiming or duplicate-work prevention between agents.
9. cross-owner: Partial — rich sharing among users of one deployment; nothing between separately owned installations.
10. peer-transport: Absent — no daemon-to-daemon protocol; only inbound chat and GitHub gateways and offline tenant export/import.
11. verification: Absent — no tests, gates or evidence; acceptance is human inspection of messages, diffs and dev environments.
12. durability: Implemented — durable task states, heartbeats, reconciler, fenced termination and deletion; recovery fails work safely and does not auto-resume.
13. budgets-usage: Partial — per-task tokens and USD, plus a leaderboard; no spend caps.
14. audit-observability: Implemented — task and approver attribution, prompt provenance, tracing, analytics; no dedicated append-only audit log.
15. remote-mobile: Implemented — web UI with a mobile shell, Slack/GitHub gateways, hosted Cloud option.
16. time-to-first-result: Low effort solo (npm plus three commands plus an agent login, as documented); High effort for an isolated team setup (Linux bwrap or a custom delegated launcher, Postgres).

## Open questions

- Does the shared terminal actually let two users see one PTY in any configuration, or is it always per user, as `buildZellijSessionName` suggests?
- What happens when two sessions on the same branch edit files at once: any warning, lock, or UI signal?
- With `simple` mode and native CLI login, whose subscription do other users' sessions consume, and does the UI say so?
- How reliable are callbacks across daemon restarts in practice, given the documented best-effort gap?
- How does the board perform with hundreds of branches, and how usable is the mobile shell for approvals?
- Does Agor Cloud add capabilities absent from this repo, such as cross-org collaboration or verification?
