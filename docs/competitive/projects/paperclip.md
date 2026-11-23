# Paperclip

| | |
|---|---|
| Repository | https://github.com/paperclipai/paperclip |
| Commit read | be08705f, 2026-11-22 (shallow clone) |
| Licence | MIT (`LICENSE:1-3`). The repository holds core only; a hosted "Paperclip Cloud" (waitlist in `README.md`) and a separate deployment repository own Cloud policy (`doc/DEPLOYMENT-MODES.md:6-23` describes Cloud sign-in handled outside this tree). No closed folders in the clone |
| Stack | TypeScript monorepo (pnpm, turbo). Express REST API and orchestration services (`server/`), React and Vite board UI (`ui/`), Drizzle schema on PostgreSQL, embedded or external (`packages/db/`), one package per agent adapter (`packages/adapters/*`), a native runner (`packages/paperclip-runner`), plugins, an MCP server, a CLI (`cli/`). Deploys as a local Node service (managed installer, npx, npm) or Docker; Cloud is separate |
| Size and activity | About 17,500 tracked files, 354 MB checkout. Non-test server source alone is about 757,000 lines; `server/src/services/issues.ts` is 15,040 lines and `server/src/services/heartbeat.ts` 4,872. Dense recent work (dated plan docs through 2026-11-18, adapter model audits through 2026-11-18). Mature and fast-moving, with many fixes for observed failures written into comments |
| Evidence basis | Source read only; not run |

Botbench already took ideas from Paperclip; see `docs/reviews/design-vs-paperclip.md` (claims, stale-claim takeover, human-only required review, actor on every action, two-sided interaction permissions, cross-issue cap, run presence) and `NOTICE:99-100`. This file does not repeat that review. It goes into how the mechanisms work.

## Promise and intended customer

"Open-source orchestration for teams of AI agents ... a Node.js server and React UI that orchestrates a team of AI agents to run a business" (`README.md`). The pitch is an organization: define a company goal, "hire" agents (CEO, CTO, engineers) from any provider, approve strategy, set budgets, let them run 24/7, watch from a dashboard or phone. The README names its user as someone with "20 simultaneous Claude Code terminals open" who wants autonomous organizations and cost control. The roadmap adds managers, enablers and IT/platform staff as audiences (four pillars table in `README.md`).

The model is one control plane per company: one server, one database, all agents and humans of the company inside it. Human collaboration is several board users on that one instance.

## What is actually implemented

| Capability (README claim first) | Evidence | Source | Note |
|---|---|---|---|
| Bring your own agent ("if it can receive a heartbeat, it's hired") | Implemented | `packages/adapter-utils/src/types.ts:508-600`, `server/src/adapters/registry.ts`, `packages/adapters/*` | Twelve adapter packages plus `process` and `http` adapters (`server/src/adapters/http/execute.ts`) |
| Goal alignment | Implemented (data), Partial (enforcement) | `packages/db/src/schema/goals.ts`, `packages/shared/src/constants.ts:642-646` | Goal tree with levels company/team/agent/task; issues carry `goalId` (`packages/db/src/schema/issues.ts:39`). No code found that rejects work without a goal |
| Heartbeats (wake for assignments, comments, schedules) | Implemented | `packages/db/src/schema/agent_wakeup_requests.ts`, `server/src/services/heartbeat/queue.ts`, `server/src/services/heartbeat-policy.ts:14-25` | Wake requests are durable rows, coalesced, ordered by tier (see Coordination) |
| Cost control: company, agent, project budgets with hard stop | Implemented | `packages/db/src/schema/budget_policies.ts`, `server/src/services/budgets.ts:99-103,244-263`, `server/src/services/budget-reservations.ts` | Warning at 80 per cent by default, hard stop pauses the scope; unpriced usage blocks by default |
| Multi-organization | Implemented | `companyId` on every table; rule in `AGENTS.md` section 5.1 | One instance, many companies |
| Task threads, assign to agents or people | Implemented | `packages/db/src/schema/issues.ts:54-55` | `assigneeAgentId` or `assigneeUserId`, never both on a live checkout |
| Governance: approval stages, approve hires, pause, reassign, stop | Implemented | `packages/shared/src/constants.ts:864-879`, `packages/db/src/schema/approvals.ts`, `server/src/services/required-quality-review.ts:81` | Board approvals are four types; hire approval off by default (`packages/db/src/schema/companies.ts:29-31`) |
| Org chart (boss, title, job description) | Implemented | `packages/db/src/schema/agents.ts:23,37`, `server/src/services/agent-assignability.ts` | `reportsTo` chain is checked on assignment |
| Mobile ready | Partial | UI is web; `server.bind = tailnet` (`doc/DEPLOYMENT-MODES.md`), `packages/tailscale-https-broker/`, chat connectors (`server/src/services/chat-channels/`) | No native app; Desktop App is planned (`ROADMAP.md`) |
| Apps and connections, MCP gateway with Allowed / Ask first / Off | Implemented (not traced in depth) | `packages/db/src/schema/tool_access.ts`, `doc/MCP-ACCESS-GOVERNANCE.md` | |
| Shared agents, personal accounts (GitHub identity of the directing person) | Implemented (not traced in depth) | `doc/execution-github-identity.md`, `responsibleUserId` on issues, runs, costs, activity | |
| Multiple human users | Implemented | `packages/db/src/schema/company_memberships.ts`, `packages/shared/src/constants.ts:1142-1148`, `packages/db/src/schema/invites.ts`, `join_requests.ts` | Roles owner, admin, operator, viewer, member, in `authenticated` mode |
| Atomic task checkout | Implemented | `server/src/services/issues.ts:12837-13132` | Conditional UPDATE, 409 on conflict |
| Dependencies and blockers | Implemented | `packages/db/src/schema/issue_relations.ts`, `server/src/services/issues.ts:7924-7990`, `server/src/services/issue-dependency-wakeups.ts` | Only type `blocks`; cycle check; level-triggered wakes |
| Orphaned run recovery | Implemented | `server/src/services/heartbeat/recovery.ts:2534-2580,3075-3200`, `server/src/services/legacy-controller-lease.ts:17-18` | Controller lease 60 s, renewed every 10 s |
| Sandboxes (E2B, Cloudflare, Daytona, Modal, Kubernetes ...) | Unverified | `ROADMAP.md` ("Cloud / Sandbox agent support"); provider code is in plugins, not traced | Adapters do carry remote-target code (`packages/adapter-utils/src/ssh.ts` per `packages/adapters/AUTHORING.md`) |
| Memory / knowledge | Partial | `ROADMAP.md` marks it experimental; `doc/memory-landscape.md` is a survey | |
| Cases (prompt-driven multi-agent workflows with handoffs) | Partial | `server/src/services/case-handoffs.ts`, `doc/case-handoffs.md:3` ("the Cases experiment") | Behind an experiment; `server/src/services/cases-disabled.ts` exists |
| Federation between Paperclip instances | Absent | No code found for instance-to-instance messaging; "federat" appears only in AWS connector code | Companies move between instances only by export/import bundles (`ROADMAP.md`, "Cloud deployments") |
| Work queues, self-organization, organizational learning | Planned | `ROADMAP.md` (marked ⚪) | |

## Architecture

```
 board users (browser / phone / chat apps)          external agents (OpenClaw, HTTP)
            |  REST + websocket                        |  invite + join request, agent API key / JWT
            v                                          v
 +------------------------------------------------------------------+
 | server (Express)                                                 |
 |  routes/ -> services/  (issues, heartbeat, budgets, approvals,  |
 |             authorization, activity-log, recovery, workers)     |
 |  heartbeat queue -> adapter.execute(ctx) -> child CLI process   |
 |                     (claude --print stream-json, codex exec ...)|
 +------------------------------------------------------------------+
            |                                   |
     PostgreSQL (embedded or external)    execution workspaces
     all companies, agents, issues,       (project checkout, git worktree,
     runs, costs, activity                 adapter-managed or cloud sandbox)
```

- One server process holds orchestration; background work runs as in-process workers with durable deadlines (`doc/heartbeat-internals.md`, "Heartbeat Service Extractions").
- The data model is company-scoped. Central tables: `issues` (the task), `issue_relations` (blocks), `goals`, `projects`, `agents` (with `reportsTo`), `heartbeat_runs` (one row per agent invocation), `agent_wakeup_requests` (durable wake queue), `cost_events` and `finance_events`, `budget_policies` and `budget_incidents`, `approvals`, `activity_log`, `execution_workspaces`.
- Agents talk back to the server through run-scoped tools: an HS256 JWT whose claims name agent, company, run, responsible user and key scope (`server/src/agent-auth-jwt.ts`, `LocalAgentJwtClaims`), and a Paperclip skill or MCP server (`packages/mcp-server`).
- Two execution paths coexist: "legacy" adapters that spawn a CLI per heartbeat and a "native" runner with its own finalization tables (`packages/db/src/schema/native_run_finalizations.ts`, `runtimeMode` on `heartbeat_runs`). Much of the recovery code handles both.

## How agents are connected and managed

**Adapter contract.** An adapter is a `ServerAdapterModule` (`packages/adapter-utils/src/types.ts:508`): required `execute(ctx)` and `testEnvironment(ctx)`; optional session codec (resume), skills list and sync, model listing and refresh, quota windows, config schema for the UI, runtime command spec for sandboxes, login capability, hire hook. `AdapterExecutionContext` (`types.ts:237-277`) hands the adapter the run id, agent, config, task context, abort signal, remote execution target, run-scoped MCP and tool access, and callbacks `onLog`, `onEvent`, `onUsage`. A new agent type is a new package registered in `server/src/adapters/registry.ts` or loaded as a plugin (`server/src/adapters/plugin-loader.ts`, `adapter-plugin.md`).

**How each CLI is driven** (read for Claude and Codex):

- Claude Code: `claude --print --output-format stream-json --verbose`, `--resume <session>` on later heartbeats, `--model`, `--effort`, `--max-turns`, `--append-system-prompt-file` only on fresh sessions, `--mcp-config ... --strict-mcp-config` for run-scoped MCP, `--add-dir` for the prompt bundle (`packages/adapters/claude-local/src/server/execute.ts:881-909`). `dangerouslySkipPermissions` defaults to **true** (`execute.ts:449`; documented in `packages/adapters/claude-local/src/index.ts:73`), so the CLI runs with `--dangerously-skip-permissions` unless the operator turns it off (`permissions.ts:12`). An ACP path also exists (`acp.ts`).
- Codex: `codex exec --json`, `resume <id> -`, and either `-c sandbox_mode="workspace-write"` with network on, or `--dangerously-bypass-approvals-and-sandbox` when configured (`packages/adapters/codex-local/src/server/codex-args.ts:47-73`). The adapter prepares a per-agent `CODEX_HOME`, copying config and **symlinking `auth.json`** from the user's Codex home (`codex-home.ts:11-13`).
- HTTP: POST of `{agentId, runId, context, runtimeTools}` to a configured URL; success is any 2xx, so the remote agent reports back through the API on its own (`server/src/adapters/http/execute.ts`).

**Lifecycle of a run.** A wake (assignment, comment, schedule, dependency resolved, retry) is inserted into `agent_wakeup_requests` with source, reason, actor and an optional idempotency key (`packages/db/src/schema/agent_wakeup_requests.ts`; unique index for `task-retry:%` keys). When a run already executes on the same issue, the wake is stored as `deferred_issue_execution` and later comments are merged into it with `coalescedCount + 1` instead of starting a second run (`server/src/services/heartbeat/queue.ts:4691-4710`). Dispatch claims a queued run within the agent's concurrency limit (`maxConcurrentRuns`, clamped, `server/src/services/heartbeat/timer-policy.ts:26-34`), in four tiers: work a person asked for or on a person's task tree, other agent work, recovery, old recovery; every fourth start goes to the oldest run waiting over 60 minutes and every fourth to recovery (`doc/heartbeat-internals.md`, "Queued run dispatch order"; `queued-run-dispatch-order.ts`). The claim writes a controller lease into the run row in the same UPDATE: boot id, process stamp, `controllerLeaseExpiresAt = clock_timestamp() + 60 s` (`server/src/services/legacy-controller-lease.ts:38-49`), renewed every 10 s (`:17-18`). The run row records pid, process group, host hash, last output time and sequence (`packages/db/src/schema/heartbeat_runs.ts:99-117`). Terminal statuses are `succeeded`, `interrupted`, `failed`, `cancelled`, `timed_out` (`server/src/services/issues.ts:2200-2206`). Per-run timeouts are adapter config (`timeoutSec`, `graceSec`, e.g. `claude-local/src/server/acp.ts:327-328`).

**Recovery of orphaned runs.** `reapOrphanedRuns` (`server/src/services/heartbeat/recovery.ts:3075`) runs at startup and periodically (`doc/heartbeat-internals.md:37-40`). It finishes persisted native results first, then `recoverActiveExecutions` (`recovery.ts:2534`) takes every run still `running`, skips ones this process is executing or whose recorded owner process is provably alive (two servers overlap during upgrades, `recovery.ts:2568-2580`), and treats the rest as stale after 5 minutes by default (`:2538`). A wake that would coalesce into a "zombie" run (running in the database, not tracked by this process) creates a new run instead, so the dead run does not stay alive forever (`server/src/services/heartbeat.ts:726-745`). Agent status repair after a crash waits five minutes, handles at most 25 agents per pass and has statement timeouts (`doc/heartbeat-internals.md:37-55`). Restart of an interrupted turn has its own module (`server/src/services/heartbeat/restart-interrupted-turn.ts`, not read).

## Models, tools, subscriptions and environments

- **Subscriptions.** The Claude adapter classifies a run as `subscription` when no `ANTHROPIC_API_KEY` is in its environment, `api` when one is, `metered_api` for Bedrock (`claude-local/src/server/execute.ts:176-179`). Billing types include `subscription_included` and `subscription_overage` (`packages/shared/src/constants.ts:1001-1008`). So the owner's own CLI login can be used.
- **Credentials live with Paperclip too.** `ai_subscriptions`, `agent_api_keys`, `company_secrets` with providers `local_encrypted`, AWS, GCP (`constants.ts:881-884`), per-agent secret bindings, a setup-token flow for Claude (`claude-local/src/server/setup-token-runner.ts`) and Codex device login export (`codex-local/src/server/device-login-export.ts`). The server can hold and hand out provider credentials; this is a design choice Botbench rules out.
- **Tools.** Run-scoped MCP config passed to the CLI (`--strict-mcp-config`), a governed MCP gateway with per-action Allowed / Ask first / Off (`doc/MCP-ACCESS-GOVERNANCE.md`), skills synced into the CLI's skill directory (`ServerAdapterModule.syncSkills`).
- **Isolation.** Execution workspace modes `shared_workspace`, `isolated_workspace`, `operator_branch`, `adapter_default`; strategies `project_primary`, `git_worktree`, `adapter_managed`, `cloud_sandbox` (`server/src/services/execution-workspace-policy.ts:36,110-135`). The project policy's `enabled` defaults to false (`:113`), and "Mode alone never implies git_worktree" (`:83`), so a project without a policy runs agents in the shared project checkout. Remote targets copy the local workspace over ssh or into a sandbox and sync it back; adapters must never `git push` and a CI script checks that (`packages/adapters/AUTHORING.md`, `scripts/check-no-git-push.mjs`).

## Context and memory scoping

- Company is the hard boundary: every entity has `companyId`, routes must check company access (`AGENTS.md` sections 5.1 and 8). Exceptions are listed in `rules/company-scope-exceptions.mdc`.
- Inside a company, work is open by default. An issue can be `private` (`packages/db/src/schema/issues.ts:41-43,104`): readable by responsible user, creator, assignee, grantees and private-project members; privacy flows down to children and handoffs; non-members get 404 on reads, lists, search and run history; blocker edges show an identifier-only stub (`doc/ISSUE-PRIVACY.md`). Owners and admins need an audited `?breakGlass=true` read. Cycle errors name issues only by identifier for the same reason (`server/src/services/issues.ts:7975-7988`).
- Agent memory proper is experimental (connections to Mem0, Zep and others, `ROADMAP.md`). Each agent has instruction files and revisions (`agent_instruction_revisions`), and a CLI session resumed across heartbeats (`sessionCodec`; `agent_task_sessions`).
- Credentials are scoped by per-agent secret bindings and by "responsible user" identity for connections (`responsibleUserId` on issues, runs, cost events, activity).

## Identity, permissions and autonomous execution

- **Humans.** `local_trusted` mode has no login and is meant for a single operator on one machine; `authenticated` mode (private or public exposure) uses Better Auth sign-in (`doc/DEPLOYMENT-MODES.md`, sections 1-2). Company roles owner, admin, operator, viewer, member (`constants.ts:1142-1148`); fine-grained grants per principal and permission key (`packages/db/src/schema/principal_permission_grants.ts`).
- **Agents.** Agents are principals too (`company_memberships.principalType`). Each run gets a JWT bound to agent, company, run and responsible user (`server/src/agent-auth-jwt.ts`). Interaction rules between agents are two-sided, and only human permission managers can change them (`server/src/services/agent-interaction-permissions.ts:32`). A CEO-role agent gets extra powers, such as managing active checkouts (`server/src/services/authorization.ts:2778`) and creating OpenClaw invites (`doc/OPENCLAW_ONBOARDING.md`, step 4).
- **Approvals.** Board approvals are typed: `hire_agent`, `approve_ceo_strategy`, `budget_override_required`, `request_board_approval`, with statuses including `revision_requested` (`constants.ts:864-879`). Hire approval is off by default (`companies.ts:29-31`). Task-level review policy and opt-in required review that only a person may remove (`required-quality-review.ts:81`).
- **Unattended execution.** The default Claude adapter skips the CLI's own permission prompts (above), so "approvals" govern organizational actions (hire, strategy, budget, connection actions, review gates), not each shell command. There is no per-command permission broker in the files read.
- **Audit.** `activity_log` rows carry actor type and id, action, entity, agent, run and responsible user (`packages/db/src/schema/activity_log.ts:5-14`); mutating routes must write one (`AGENTS.md` section 8).

## Coordination of tasks and dependencies

**Checkout (claim) schema.** Four columns on `issues` (`packages/db/src/schema/issues.ts:54-59`): `assigneeAgentId` (or `assigneeUserId`), `checkoutRunId` (the run that claimed it), `executionRunId` (the run that currently executes it), `executionLockedAt`. Both run columns are foreign keys to `heartbeat_runs` with `on delete set null`. The claim belongs to a run, not just an agent.

**Checkout, step by step** (`server/src/services/issues.ts:12837-13132`):

1. Assignability check (agent not pending, not terminated, org chain healthy; `agent-assignability.ts`).
2. Refuse if an active subtree pause hold covers the issue (409, `:12867`).
3. Clear `executionRunId` and `checkoutRunId` if they point at a terminal or missing run (`clearExecutionRunIfTerminal`, `clearCheckoutRunIfTerminal`, `:8254`, `:8307`).
4. Refuse with 422 if any `blocks` relation is unresolved, listing the blockers (`:12898`).
5. In a transaction: check the agent-interaction rule with a lock, then one conditional UPDATE setting assignee, both run ids, `status = in_progress`, `startedAt`, where status is in the caller's `expectedStatuses`, the issue is unassigned or assigned to this agent with no other checkout run, and the execution lock is free or this run's (`:12922-12960`). For a `blocked` issue it can also require the caller's `lastStatusDecisionId` and `statusVersion` (optimistic concurrency).
6. If the UPDATE matched nothing, read the row and try three adoptions: same agent, `in_progress`, no checkout run (adopt unowned); same agent, other checkout run that is terminal or missing (`adoptStaleCheckoutRun`, `:8084-8200`, which locks the issue and both run rows `FOR UPDATE` and re-checks inside the transaction); or a stale `executionRunId` from a dead run (`:13046-13107`).
7. Same run asking again is not a conflict (`sameRunLock`, `:2195-2198`; `:13109`).
8. Otherwise 409 "Issue checkout conflict" with the holder's agent and run ids (`:13125`).

**Expiry.** There is no wall-clock TTL on the claim. A claim lapses only when its run reaches a terminal status or disappears; run liveness in turn comes from the 60-second controller lease and the 5-minute stale threshold of orphan recovery (above). A run held by a "manual admission" or an explicit continuation retry is never adopted (`:8136-8151`).

**Release** (`:13287-13362`): under `SELECT ... FOR UPDATE`, only the assignee may release ("Only assignee can release issue"), and only the checkout run unless that run is dead ("Only checkout run can release issue"). `in_progress` goes back to `todo`; assignee is cleared unless the issue is done or cancelled, so finished work keeps its owner. `adminForceRelease` (`:13364`) clears the locks and optionally the assignee. Agents normally check out automatically when woken for an issue assigned to them and dependency-ready (`shouldAutoCheckoutIssueForWake`, `server/src/services/heartbeat.ts:746`).

**Work graph.** Goals (company > team > agent > task) form a tree (`goals.parentId`, `goals.ownerAgentId`). Issues have `parentId` (sub-issues), `goalId`, `projectId`, plus `originIssueId` for audit-only provenance that "is never read for hierarchy or authorization" (`issues.ts:68-70`). `requestDepth` counts delegation depth (`:74`). Dependencies are one relation type, `blocks`, unique per edge (`packages/db/src/schema/issue_relations.ts`). Adding a blocker runs a breadth-first search over all company `blocks` edges and refuses a cycle with a 422 that names the existing chain and tells the agent not to reverse it, because agents were seen swapping dependencies on a bare "cycle" error (`issues.ts:7924-7988`).

**Dependency wakes.** When blockers resolve or all children complete, the dependent's assignee is woken with reason `issue_blockers_resolved` or `issue_children_completed` (`server/src/services/issue-dependency-wakeups.ts:7-10`). Wakes are level-triggered: the idempotency key is a hash of the sorted blocker ids plus the time the issue last entered `blocked`, so one wake per ready state, and a completed earlier wake does not suppress a wake for a new ready state (`:56-120`). An agent that blocks its own issue is not woken straight back, which had caused "five wakes in four minutes" (`:24-53`).

**Delegation and handoffs.** The normal path is an agent creating sub-issues (`parentId`) assigned to agents below it, then being woken by `issue_children_completed`. Assignment checks the assignee's whole `reportsTo` chain (terminated, missing, cycle or too deep refuses, `agent-assignability.ts`). Agent-to-agent actions are bounded by interaction permissions and the per-run cross-issue cap of 20 (`server/src/services/cross-issue-influence-limit.ts:8`). The experimental Cases feature adds durable handoffs: an advisory lock on `(company, actor, idempotency key)`, an input fingerprint, and states `awaiting_release` / `pending_dispatch` / `awaiting_completion`, so a handoff is delivered only after the source run has provably stopped (`server/src/services/case-handoffs.ts:357-380,554`; `doc/case-handoffs.md`).

**Duplicate-work avoidance** rests on single assignee, the checkout lock, the wake coalescing above, and partial unique indexes that allow only one open recovery or watchdog issue per origin (`issues.ts:160-216`). No check for two issues editing the same files was found.

## Collaboration between different human owners

- **Several people, one instance: yes.** In `authenticated` mode several humans sign in to the same company with roles (`company_memberships`, invites, join requests). Work queued for a person's task tree is dispatched before agent-originated work (`doc/heartbeat-internals.md`), and "responsible user" follows delegation so shared agents act with the directing person's GitHub identity (`doc/execution-github-identity.md`).
- **Agents on other machines: yes, as members of the one instance.** An external agent joins through an invite and a join request carrying agent name, adapter type, capabilities and a hashed one-time claim secret (`packages/db/src/schema/join_requests.ts:5-23`), which a board user approves (`doc/OPENCLAW_ONBOARDING.md`, steps 4-5). It then receives work through a gateway or HTTP adapter and calls the Paperclip API with its key. Remote execution targets (ssh, sandboxes) also let one instance run agents elsewhere.
- **Separately owned installations: no.** No code was found for two Paperclip instances to exchange tasks, claims or messages. Moving a company between instances is export and import of a bundle (`ROADMAP.md`). Trust is the instance's: whoever runs the server and database holds every company's tasks, run logs and (optionally) credentials. A second owner's agents can only take part by joining the first owner's instance.

## Verification and acceptance of outcomes

- Statuses include `in_review` (`constants.ts:198-206`). Review policy per issue (`issues.reviewPolicy`), required quality review with "stale" detection when the reviewed target changed (`required-quality-review.ts:78-107`).
- Completion contracts are stored with risk, `completionAuthority`, incomplete-criteria policy and a canonical SHA-256 (`packages/db/src/schema/completion_contracts.ts:19-27`); runs record `completionContractSha256` (`heartbeat_runs.ts:77`). How strictly they gate "done" was not traced.
- Task watchdogs: an opt-in agent woken when a whole issue subtree has come to rest, to check whether stopping was legitimate (`doc/TASK-WATCHDOG.md:21-33`).
- Work products and artifacts are recorded (`issue_work_products`). The final acceptor is a board user, or an agent where review policy allows.

## Install to first useful result

As documented (`doc/INSTALLING.md`): download `install.sh` and its checksum from paperclip.ing, run it; it ensures Node.js 24.11+, runs `paperclipai install` and interactive onboarding. Alternatives: `npx`, global npm, source checkout with `pnpm dev`. PostgreSQL is embedded unless `DATABASE_URL` is set (`AGENTS.md` section 4). Onboarding creates a company, turns the mission text into a goal and seeds a CEO agent on `claude_local` with the core Paperclip skills (`server/src/services/onboarding-seed.ts:20,26-60`). So the first result needs a signed-in Claude Code (or another adapter), and then a goal, the CEO and usually more "hires" before code gets written. No Docker or cloud account is required for local use.

## For Botbench

### Learn

- The claim belongs to a run, not a person or agent, and "expiry" is the death of that run, judged by a renewed lease. This avoids picking a TTL and avoids stealing from a slow but live run.
- Nearly every subtle rule in the code cites an observed failure (wake loops, swapped dependencies, zombie runs refreshing themselves). Botbench's Peers layer will meet the same failures between workbenches.
- An organization-first model costs a solo developer: one must accept a company, a goal, a CEO agent with a `reportsTo` chain whose health gates assignment, roles with special powers (CEO manages checkouts), and board approvals. For two engineers on one repository, most of this is ceremony; the useful core is issue, single assignee, run-owned checkout, blocks edges and wakes.

### Reuse conceptually (with source references)

MIT licence: ideas and even code may be adapted with the copyright notice kept; list any copied file in `NOTICE`.

1. **Checkout by run with conditional update and adoption ladder** (`server/src/services/issues.ts:12904-13132`, `:8084-8200`). For Botbench's local SQLite this maps directly: `UPDATE ... WHERE claim_run IS NULL OR claim_run = ?` and adopt only when the holder run is terminal. For Peers over GitHub there is no conditional write, but the same rule ("a claim names its run; a dead run's claim can be taken; the same run asking again is no conflict") applies to what is written on the issue.
2. **Level-triggered dependency wakes with a state key** (`server/src/services/issue-dependency-wakeups.ts:56-120`). Key = hash(sorted blocker ids + time entered blocked). Useful when Botbench starts a dependent task after a peer's blocking issue closes: one start per ready state, no repeats on re-reads.
3. **Wake coalescing into the running turn** (`server/src/services/heartbeat/queue.ts:4691-4710`). A new comment on an issue whose run is active becomes a deferred wake with the comment ids merged, not a second run. Botbench could do the same for peer messages that arrive while a task runs.
4. **Cycle refusal that names the chain and says what not to do** (`server/src/services/issues.ts:7924-7988`). Error text written for an agent reader.
5. **Controller lease in the same UPDATE as the claim, renewed on a timer** (`server/src/services/legacy-controller-lease.ts:17-18,38-49`), plus "zombie" detection (`server/src/services/heartbeat.ts:726-745`). Botbench is one process, so its version is simpler: a process boot id on each running task, so restart recovery can tell its own live tasks from leftovers.
6. **Dispatch tiers that put human-requested work first, with fairness shares** (`doc/heartbeat-internals.md`, "Queued run dispatch order"). Relevant once Botbench queues work from peers alongside the owner's own.

### Improve on

- **Permission control per command.** Claude runs with `--dangerously-skip-permissions` by default (`claude-local/src/server/execute.ts:449`) and Codex can bypass its sandbox (`codex-args.ts:61`); governance sits at the organization level. Botbench's broker and safety floor give per-action control that Paperclip does not have in the files read.
- **Credentials.** Paperclip stores subscriptions, API keys and secrets and symlinks Codex `auth.json` into managed homes (`codex-home.ts:13`). Botbench keeps credentials with the CLIs.
- **Isolation by default.** Paperclip's worktree isolation is opt-in per project (`execution-workspace-policy.ts:113`); Botbench always uses one worktree per task.
- **Separately owned peers.** Paperclip has no path for two owners' installations to coordinate; everyone must join one server. That is exactly Botbench's Peers gap to fill.
- **Overlap of changes.** No check for two issues touching the same files was found; Botbench's peers view already names overlapping files.
- **Size.** Recovery alone spans dozens of modules and option flags (`recovery.ts:3075` takes 22 skip flags). Botbench can keep the same guarantees far smaller by staying one process and one owner.

### Deliberately avoid

- The mandatory company, CEO agent and org chart for a developer who wants tasks done on a repository (`onboarding-seed.ts:20`; `authorization.ts:2778`).
- Agents hiring agents and agents delegating down a `reportsTo` chain without the owner in the loop.
- Dollar budgets with hard-stop pauses for subscription use; Botbench records tokens and never moves a session to metered billing.
- One shared database holding every participant's tasks, logs and credentials.
- Skip-permissions as the default for CLI runs.

## Capability ratings

1. byo-agent-clis: Implemented; twelve CLI adapters driven headless with session resume, owner's subscription login usable.
2. model-providers: Implemented; Claude, Codex, Cursor, Gemini, OpenCode, Pi, Hermes, Grok, Kimi, OpenClaw, plus HTTP and process adapters.
3. tools-connectors: Implemented; run-scoped MCP, governed MCP gateway with Allowed / Ask first / Off, skills sync, connected apps (gateway not traced in depth).
4. isolation: Partial; git worktree and sandboxes available but opt-in per project, shared checkout by default.
5. approvals: Partial; typed board approvals and human-only required review, but CLIs run with permission prompts skipped by default and no per-command broker.
6. memory-scoping: Implemented; company boundary everywhere, private issues with inherited access and audited break-glass; agent memory itself experimental.
7. identity-authz: Implemented; human roles and grants, agents as principals with run-scoped JWTs, two-sided agent interaction rules.
8. task-coordination: Implemented; run-owned atomic checkout with stale adoption, blocks edges with cycle refusal, level-triggered wakes, coalescing.
9. cross-owner: Partial; several humans and remote agents can join one instance, but no collaboration between separately owned instances.
10. peer-transport: Absent; no instance-to-instance protocol, only export/import bundles.
11. verification: Implemented; review policy, stale-aware required review, completion contracts, task watchdogs (gating depth not fully traced).
12. durability: Implemented; Postgres-backed runs and wakes, 60 s controller lease, startup and periodic orphan recovery, bounded retries.
13. budgets-usage: Implemented; cost events with billing type, budget policies per company/agent/project, warning and hard-stop pause, reservations before dispatch.
14. audit-observability: Implemented; activity log with actor, run and responsible user on every mutation, run logs and excerpts, optional tracing.
15. remote-mobile: Partial; responsive web UI over LAN or tailnet, chat connectors; no native app.
16. time-to-first-result: Medium effort; one installer with embedded Postgres, but a company, goal and CEO agent come before a coding result, and a signed-in CLI is required.

## Open questions

- How long a checkout stays held in practice when a CLI hangs without output: does the active-run watchdog (`server/src/modules/active-run-watchdog/`, not read) end it before the 5-minute orphan threshold?
- Whether `--dangerously-skip-permissions` default holds in the shipped onboarding, or the installer prompts for it.
- How completion contracts and required reviews interact when an agent marks an issue `done` in fully autonomous operation.
- Whether two humans on one instance, each with personal AI accounts, see each other's private tasks' costs in company totals in a way that leaks work (docs say totals include private work).
- How the remote (ssh, sandbox) workspace sync-back behaves on conflicts with local changes made in the meantime.
- Real time from install to a merged change, and how many board approvals onboarding asks for.
