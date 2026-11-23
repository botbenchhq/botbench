# OpenAgents (OpenAgents Workspace)

| | |
|---|---|
| Repository | https://github.com/openagents-org/openagents |
| Commit read | 077789f, 2026-11-23 (shallow clone) |
| Licence | Apache 2.0 (`LICENSE`). No enterprise folder. The hosted workspace (`workspace.openagents.org`, connector default endpoint `https://workspace-endpoint.openagents.org`, `packages/agent-connector/src/workspace-client.js:6`) appears to run this same backend, but it calls closed third-party services: Firebase auth, Acenta hosted runtimes (`workspace/backend/app/routers/hosted_agents.py:1-17`), BrowserFabric cloud browser, the TokenDance model gateway (`workspace/backend/app/services/tokenpay.py:9-11`). No mobile app source in the repo, although FCM push is implemented server-side. |
| Stack | Three products in one repo. (1) `workspace/`: FastAPI + SQLAlchemy + Alembic (101 migrations) on PostgreSQL 16, optional Redis for the SSE wake stream, Next.js frontend; Docker Compose for self-host, Railway/DigitalOcean files for the hosted deployment. (2) `packages/agent-connector/`: Node.js daemon and CLI (`agn`) that runs local agent CLIs; `packages/launcher/`: Electron desktop app over it. (3) `sdk/`: the older Python "OpenAgents network" framework (mods, gRPC, A2A, agent IDs), about 89k lines, not used by the workspace backend. |
| Size and activity | About 220 MB clone; about 2,300 source files under `workspace/` and `packages/`; the largest files are 2,000 to 3,300 lines (`workspace/backend/app/routers/workspaces.py`, `packages/agent-connector/src/daemon.js`, `installer.js`). Incident reports (`workspace/backend/INCIDENT-2026-10-*.md`), dated design docs and a v1.1 migration guide point to an actively shipped product with a fast-moving permission model. Lots of compatibility shims ("legacy machine", "pre-v1.1 launchers"). |
| Evidence basis | Source read only; not run |

## Promise and intended customer

README: "One workspace where all your AI agents collaborate." A workspace is a persistent URL (Slack-like) where agents running on any machine show up, share threads, files, a shared browser and knowledge, and where teammates join. v1.1 adds "mixed human-agent teams": devices and agents are private to the person who connected them and shared on purpose, threads are private or public, approvals appear as cards, issues track work, a proactive router can pick the agent without an @mention, and work can be split into doer and reviewer.

Intended customer: individuals and small teams who already run several agent CLIs (26 are listed) and want one place to talk to them and to each other, from browser, desktop or phone, with a hosted option (free workspace creation from the README link) or self-host.

## What is actually implemented

| Capability (README headline first) | Evidence | Source | Note |
|---|---|---|---|
| Any agent in one workspace (26 CLIs) | Implemented | `packages/agent-connector/src/adapters/index.js:30-72`, one adapter per CLI under `src/adapters/` | Each adapter wraps a CLI's headless mode. README marks Cline, Aider, Goose and DeepSeek as beta or preview. |
| Persistent workspace URL | Implemented | `workspace/backend/app/routers/workspaces.py:240-300` | Slug and token generated at creation; URL carries `?token=` (`workspace-client.js:145`). |
| Shared threads with @mention routing | Implemented | `workspace/backend/app/mods/workspace_mod.py:1333-1380` | Leading or inline @mentions target agents; humans-only threads skip routing. |
| Proactive routing without @mention | Implemented | `workspace_mod.py:1469-1530` (`_route_with_llm`) | A small LLM picks the next agent(s); needs a server-side router API key, otherwise "defaulting to stop". |
| Doer and reviewer split | Implemented, behind flags | `workspace/backend/app/services/review_handoff.py:17-50`, `thread_collaboration.py:21-60` | Reviewer duty set per thread (`review_after`) or detected by regex on agent descriptions; gated by `AUTOMATIC_REVIEW_HANDOFF_ENABLED` and `THREAD_COLLABORATION_ENABLED`. |
| Private-by-default devices and agents, scoped sharing | Implemented | `workspace/backend/app/services/access_model.py:279-315, 865+`, `routers/grants.py`, `services/thread_agent_requests.py:13-45` | Owner, grants (human, agent, group), public; agents inherit owner's access. A legacy "machine" credential still gets full access (`access_model.py:870-871`). |
| Approvals as thread cards | Partial | `workspace/backend/app/services/approvals.py:203-277`, `packages/agent-connector/src/mcp-server.js:511-560` | Cooperative: the agent must call `workspace_request_approval`. The CLIs themselves run with permissions bypassed (`adapters/claude.js:571`, `codex.js:469`, `cursor.js:380`). The design doc says so (`workspace/docs/humans-agents-collab-os.md`, "Known limits"). |
| Issues with owners, participants, labels | Implemented | `workspace/backend/app/models.py:899-966`, `routers/issues.py` | "A durable team discussion; creating one never starts agent work." |
| Kanban tasks run by agents | Implemented | `models.py:968-1007`, `routers/tasks.py:597-720`, `workspace_mod.py:1838-1990` | One assignee, chosen by a person; an LLM classifier moves the card. |
| Workflow templates (multi-step, gated) | Implemented | `models.py:1009-1068`, `services/workflow.py:237-613` | Ordered steps with agent or human assignee; natural-language gates judged by an LLM. |
| Shared files, knowledge, shared browser | Implemented | `routers/files.py`, `routers/knowledge.py`, `routers/browser.py`, MCP tools `mcp-server.js:61-290, 560-590` | Files and knowledge carry owner and visibility. |
| Tunnels (expose a local port) | Implemented | `mcp-server.js:293-315` | Cloudflare tunnel spawned from the local MCP server. |
| Use from phone | Partial / Unverified | `services/push.py`, `services/fcm_client.py` | Server sends FCM push; mobile app source not in repo. The web app is the remote UI. |
| Audit log | Planned | `humans-agents-collab-os.md` Phase 3; `permission-model-v1.md` §6 | The `events` table is the de facto log. |
| Grant expiry and budget | Partial | `routers/grants.py:254-256` | `budget` is stored on grants; no code found that enforces it. |
| Structured agent-to-agent handoff | Partial | `base.js:1690-1712` (`orchestration.action === 'next'`), `workflow.py` | Exists for workflow steps; free-form threads rely on @mentions. Roadmap M6 lists the full handoff as not built. |
| Federation between separate workspaces or servers | Absent (workspace) / Planned (SDK docs) | `docs/openagents_network_model.md:17-68` | The model doc talks about federation and DIDs; the workspace backend has no federation code. |

## Architecture

```
 owner's machine A                          central workspace server (hosted or self-hosted)
 ┌────────────────────────────┐   HTTPS    ┌──────────────────────────────────────────┐
 │ agn daemon (Node)          │──poll────▶ │ FastAPI /v1/*                             │
 │  per agent: Adapter        │ ◀─SSE wake─│  event pipeline: auth → workspace_mod →   │
 │   spawns CLI per turn      │──post────▶ │  persistence (events table)               │
 │   local MCP server (tools) │            │  routers: join, events, discover, nodes,  │
 │  node heartbeat + commands │            │  tasks, issues, approvals, grants, files, │
 └────────────────────────────┘            │  browser, knowledge, workflows, routines  │
 owner's machine B (same shape) ─────────▶ │ PostgreSQL (+ Redis for the wake stream)  │
 browser / Electron / phone ─────────────▶ │ LLM router + task classifier (server key) │
                                           └──────────────────────────────────────────┘
```

- Everything goes through the central server. The connector only makes outbound HTTPS calls; there is no direct machine-to-machine path.
- The server is "event-native": `POST /v1/events` pushes into a mod pipeline (`workspace/README.md`; `app/mods/workspace_mod.py` is 2,600 lines and holds join, routing, task classification).
- Wake stream: `GET /v1/events/agent-stream` sends only "poll now" signals with no content, so access rules stay in `GET /v1/events` (`workspace-client.js:350-446`). Off unless `AGENT_STREAM_WORKSPACES` is set and Redis is present (`workspace/README.md`).
- Main tables (`workspace/backend/app/models.py`): `workspaces` (token in `password_hash`, line 108+), `workspace_members` (agents: owner_email, node_id, session_id, line 142), `channels` (threads, owner_email, visibility), `channel_members` / `channel_human_members`, `nodes` (devices, per-device token, line 490), `node_pairing_codes`, `node_commands`, `issues`, `kanban_tasks`, `workflows` / `workflow_runs`, `todos`, `approvals` / `approval_policies`, `security_groups`, `resource_grants` (line 1725), `channel_briefs`, `routines`, `timers`.

## How agents are connected and managed

Joining a workspace from your own machine (the part that matters most):

1. In the web UI, Devices, a member creates a pairing code (`XXXX-XXXX`, short-lived, single use).
2. On the machine, `agn device connect XXXX-XXXX` (or `agn join <code>` pasted into an already running agent CLI, `packages/agent-connector/src/join.js:3-15`) calls `POST /v1/nodes/redeem` with a stable `node_key` (`workspace/backend/app/routers/nodes.py:236-310`). The server checks the code creator is still a member, upserts a `Node` owned by that person, and mints a per-device token (`secrets.token_urlsafe(32)`) that is reused on re-pair. Deleting the node revokes it.
3. For each local agent the daemon calls `POST /v1/join` with the token and agent name (`routers/network.py:236-300`). The join handler binds the agent to the device and its owner, rejects joins from a different device or owner (`workspace_mod.py:141-153`), and rotates a `session_id` so a duplicate daemon gets `session_revoked` and stops (`workspace_mod.py:155-160`, `workspace-client.js:33-44`).
4. The adapter loops: heartbeat, poll `GET /v1/events` for messages targeted at it (or wait on the SSE wake), poll control events (stop, skill install), and post replies via `POST /v1/events`. Every per-agent request carries `X-Agent-Name` (`workspace-client.js:96-105`).
5. The web UI can drive the device remotely through `node_commands`: create, configure, start, stop, remove agents, run CLI logins, list directories (`nodes.py:159-165`). Only the pairing owner may enqueue commands (`nodes.py:91-109`). API keys entered in the browser are encrypted to the device's RSA public key and the server relays ciphertext only (`packages/agent-connector/src/credential-envelope.js:1-40`).

Alternative, older path: `agn connect <name> <workspace-token>` with the shared workspace token (README "Get Started").

Agent lifecycle per message (`packages/agent-connector/src/adapters/base.js:1538-1660`): one run per (agent, thread) at a time; later messages in the same thread are queued with a "message queued" status; different threads run in parallel. Before each turn the connector prepends thread history (up to 30 messages, 16,000 chars; `packages/agent-connector/README.md`), per-thread collaboration instructions, and, for a teammate's request, the owner-reviewed "shared context" (`base.js:1716-1738`). Each thread keeps its own CLI session (`claude.js:517-525`, `--resume <session>`), and a new thread can fork from a seed conversation (`claude.js:537-560`).

Adding an agent type: write an adapter class extending `BaseAdapter`, register it in `ADAPTER_MAP` (`adapters/index.js:30-60`), and add a catalog entry with install, login and launch metadata to `packages/agent-connector/registry.json`. Most adapters parse the CLI's stream-JSON output (`*-stream.js` parsers); Kiro uses the Agent Client Protocol (`acp-client.js`).

## Models, tools, subscriptions and environments

- BYO subscriptions: supported. An agent's auth mode can be `cli_login`, meaning the CLI's own sign-in is used (`packages/agent-connector/src/env.js:136-144`); the daemon can run CLI logins remotely on the web user's behalf (`login_start`/`login_input` commands, `nodes.py:159`). API keys otherwise live in plain `~/.openagents/env/<type>.env` files (`env.js:5-25`). Workspace tokens are kept in `~/.openagents/daemon.yaml` (`config.js:17, 169-188`).
- Models: whatever each CLI supports, plus a direct-LLM adapter (`adapters/llm-direct.js`) and hosted cloud agents. The server needs its own model key for the router and task classifier.
- Tools: the connector runs a per-agent MCP server exposing workspace tools: history, agents, files, publish project, image search, fetch URL, shared browser (open, click, type, screenshot), todos, timers, routines, notifications, approvals, knowledge, tunnels (`mcp-server.js:28-600`). A "skills mode" writes a `SKILL.md` with curl recipes instead (`claude.js:566-585`). Workspace skills can be installed onto agents from a registry (`skill-installer.js`, `app/skill_registry.py`).
- Isolation: none in general. Each agent runs in a configured working directory on its owner's machine with permissions bypassed: Claude `--dangerously-skip-permissions` (`claude.js:571`), Codex `--dangerously-bypass-approvals-and-sandbox` (`codex.js:469`), Cursor `--trust --force` (`cursor.js:380`). Plan mode is the only restriction offered (`claude.js:567-569`). No git worktree per task (only OpenCode's own `--dir` root is mentioned, `opencode.js:476`). NanoClaw runs each agent group in its own Docker container, but that is NanoClaw's feature, not the connector's.

## Context and memory scoping

- Server side: threads, files, knowledge and browser contexts each have an owner and `private`/`public` visibility plus grants (`workspace/docs/permission-model-v1.md` §1-3, implemented in `access_model.py`). `explain()` returns a reason (owner, public, participant, grant, group, inherited_from_owner, machine, denied), exposed as `GET /v1/access/explain` (`routers/grants.py:319`). Admins get metadata only for private threads.
- Agents inherit everything their human owner can see (`access_model.py:820-824`). An agent shared with a teammate therefore sees the owner's private threads and files through its tools, unless the request-time intersection rule applies; the spec says that rule is deferred to v1.2 ("enforcing the requester-intersection rule on every read for agents (today: inheritance + grants only)", `permission-model-v1.md` §6).
- Teammate requests: the connector fetches `GET /v1/agents/{agent}/shared-context?requester_email=` and prepends the owner's `shared_instructions` and allowed knowledge (`workspace/backend/app/routers/agent_profile.py:259-320`, `base.js:1666-1738`). The boundary here is a prompt block ("existing owner restrictions still apply"), not a sandbox. The CLI process still has the owner's filesystem and credentials.
- Local memory: per-thread CLI sessions keep conversations apart (`claude.js:517-525`). Roadmap M4 says a guard against a shared request resuming from a private thread is still to be added (`humans-agents-collab-os.md`, M4).
- Machine credential: a workspace or device token without `X-Agent-Name` resolves to a "machine" principal with full access (`access_model.py:298-312, 870-871`). It is labelled legacy and due for removal in v1.2.

## Identity, permissions and autonomous execution

- Humans: Firebase or session auth (`app/firebase_auth.py`, `app/access.py`); roles owner, admin, member, viewer, guest. New workspaces set `require_login=True` (`workspaces.py:276-283`), but anonymous creation still returns a token.
- Agents: identified by `X-Agent-Name` on a machine credential. `resolve_principal` accepts any valid workspace token or any device token of that workspace together with any existing agent name and returns that agent, with that agent's owner (`access_model.py:298-311`). The device-to-agent binding is checked at join (`workspace_mod.py:150-153`) but the source does not show it checked on later requests, and session validation accepts requests that carry no session id ("legacy client, accept", `workspace_mod.py:237-260`). So a holder of one person's device token can, by the source, name another person's agent. Only running it would confirm.
- The workspace token is stored and compared in clear in a column named `password_hash` (`access_model.py:214`).
- Approvals: policy per workspace and thread with built-in defaults (deploy needs Admin, spend needs Owner, external send any member, delete blocked; `approvals.py:49-60`, `humans-agents-collab-os.md`). Resolvers are role-checked; a bare token cannot resolve on login-enforced workspaces, so agents cannot self-approve (`approvals.py:252-277`). Approval requests park the Kanban card in `need_input`. Because harnesses run with permissions bypassed, an agent that never calls the tool is not stopped.
- Unattended work: routines (cron-like) and timers fire messages into threads (`routers/routines.py`, `docs/routines.md`); overlapping routine fires are dropped (`base.js:1546-1553`).
- Audit: events are recorded; approvals record who and when; no audit UI or export.

## Coordination of tasks and dependencies

There is real but shallow coordination, all on the central server:

- `kanban_tasks` (`models.py:968-1007`): status `backlog|todo|in_progress|need_input|done`, a single `assignee`, optional `workflow_id`, hidden `task:<id>` thread. A person presses Run (`routers/tasks.py:597-720`); the server posts a kickoff message telling the agent how to phrase replies (`tasks.py:343-362`), and an LLM classifier reads each agent reply and moves the card (`workspace_mod.py:1838-1990`). No claims: agents do not pick up work; a person assigns it. No dependencies between tasks. No leases, no heartbeats tied to a task, no retry on failure beyond the human seeing `need_input`.
- `workflows` / `workflow_runs` (`models.py:1009-1068`, `services/workflow.py`): ordered steps, each assigned to an agent or a named human, with optional natural-language gate "go to step X if condition" judged by an LLM (`workflow.py:237-356`). Loop budget `max_iterations` and a hard backstop. Template snapshotted per run. This is the closest thing to a dependency chain: strictly sequential within one thread.
- `todos` (`models.py:862-882`): agent-private checklists inside a thread.
- `issues`: discussions linked to threads, files and knowledge; never start work by themselves.
- Duplicate-work avoidance: per (agent, thread) serialisation in the connector (`base.js:1545-1567`); the routing LLM picks one or a few agents; review handoff is deduplicated with a row lock (`review_handoff.py:28-29`). Nothing stops two agents in different threads from working on the same code.
- Restart recovery: the poll cursor is persisted atomically per (workspace, agent) and stale messages are skipped (`base.js:501-546`); final replies go to a disk outbox before delivery and are retried (`adapters/response-outbox.js:10-40`). A crashed in-flight turn is not resumed.
- The older Python SDK has a fuller A2A task-delegation mod with accept, reject, progress, timeout and capability matching (`sdk/src/openagents/mods/coordination/task_delegation/mod.py:295-1028`), but the workspace does not use it and its default store is in memory (`mod.py:111-114`).

## Collaboration between different human owners

Yes, within one workspace on one server. Two people each pair their own machine (separate `Node` rows owned by each, `nodes.py:274-283`); their agents join the same workspace; both people are workspace members (or guests). Trust model: the central server is the authority for everything; machines trust it fully, and it trusts device tokens plus self-declared agent names. Cross-owner controls:

- An agent is used by others only through grants (to a person, an agent, or a security group; `resource_grants`), or per-thread sharing set by the agent's owner with modes `no|yes|approval` (`thread_agent_requests.py:7-45`, `ChannelAgentSharing`). Adding someone to a thread does not give them the agents in it; a blocked request posts "Ask {owner} to enable sharing" (`thread_agent_requests.py:48-56`).
- Issues have the same per-owner sharing modes (`IssueAgentSharing`, `models.py:933-937`).
- "Whose credits/runtime" labels and owner-reviewed shared instructions exist (`agent_profile.py:223-251`).
- No federation: two separately run workspace servers cannot connect. Collaboration requires both people to use the same hosted or self-hosted server.

## Verification and acceptance of outcomes

Thin. "Done" is an LLM classifier reading the agent's own message (`workspace_mod.py:1838-1910`). Workflow gates are LLM judgements (`workflow.py:342-356`). The reviewer agent posts findings in the thread (`thread_collaboration.py:35-40`). Approvals gate actions, not results. No tests are run, no diff or branch is produced, no evidence bundle, no human acceptance step other than reading the thread. Results are files or browser artifacts attached to the thread.

## Install to first useful result

As documented (README "Get Started"):

1. `curl -fsSL https://openagents.org/install.sh | bash` (or the desktop app).
2. Open a hosted workspace (README link creates one) or self-host with Docker Compose (Postgres, backend, frontend; `workspace/docker-compose.yml`).
3. `agn create <name> --type claude --install`, sign the CLI in or `agn env <type> --set LLM_API_KEY=...`.
4. Pair the device with a code from the web UI, or `agn connect <name> <workspace-token>`; `agn up` starts the daemon.
5. Message the agent in the browser.

Hosted path needs no Docker and no account to start (anonymous creation still works), so first chat with a local agent is minutes, by the docs. Proactive routing and the task classifier on a self-hosted server need a server-side model key.

## For Botbench

### Learn

- The market framing is "Slack for agents": a central hub where everyone's agents appear, with sharing by grant. It wins on breadth (26 CLIs) and on time to first chat. It does not deliver verified code changes, isolation or real task coordination.
- Their own roadmap shows the hard parts are exactly Botbench's: enforced approvals (they are cooperative), audit, per-request scoping of a shared agent (deferred intersection rule), and structured handoff.
- Device pairing plus owner-only remote control is a good onboarding shape for "my agents on my machine join our shared space".

### Reuse conceptually (with source references)

All Apache 2.0: patterns and code can be adapted with attribution and the licence notice.

1. Pairing code to per-device token: short single-use code created by a signed-in member, redeemed with a stable device key, token reused on re-pair, delete the device row to revoke (`workspace/backend/app/routers/nodes.py:236-310`, `91-109`). Fits a Botbench peer pairing flow.
2. Credential envelope: browser encrypts secrets to the device's public key and the hub relays ciphertext bound to (node, action, args) context (`packages/agent-connector/src/credential-envelope.js:1-40`). Useful if a peer or phone ever sends credentials to a workbench through a relay.
3. Content-free wake stream: SSE carries only "poll now"; all access checks stay on the normal read path (`packages/agent-connector/src/workspace-client.js:350-446`). Good model for workbench-to-workbench notification without duplicating authorisation.
4. Session rotation on join: each join mints a session id, older clients get `session_revoked` and stop (`workspace_mod.py:155-176`, `workspace-client.js:33-44`). Prevents ghost daemons acting as the same agent.
5. Access explanation: `explain()` returns why a principal may see a resource, shown in the UI (`access_model.py:865+`, `routers/grants.py:319`). Botbench could show "why can this peer see this task".
6. Per-thread sharing modes `no|yes|approval` decided by the agent's owner, independent of thread membership (`services/thread_agent_requests.py:7-45`).
7. Durable local edges: atomic persisted poll cursor (`adapters/base.js:501-546`) and a reply outbox on disk (`adapters/response-outbox.js:10-40`).
8. Workflow run snapshot so template edits never disturb runs in flight, with an iteration budget (`models.py:1009-1068`).

### Improve on

- Enforced permissions: OpenAgents runs every CLI with permissions bypassed and relies on the agent calling an approval tool (`claude.js:571`, `codex.js:469`, `humans-agents-collab-os.md` Known limits). Botbench's broker and safety floor are a real difference; say so.
- Isolation: no worktree or sandbox per task; agents edit the owner's working directory. Botbench's worktree-per-task beats this for parallel work.
- Shared-agent scoping: a teammate's request to your agent runs with your filesystem, credentials and inherited workspace access, bounded only by a prompt block (`base.js:1716-1738`; intersection rule deferred, `permission-model-v1.md` §6).
- Agent identity: per-request identity is a self-declared header on a workspace-wide or device token, with no visible per-request check of which device the agent lives on (`access_model.py:298-311`). Botbench peers should bind agent identity to the installation's key.
- Task coordination: no claims, leases, dependencies or duplicate-work checks; a person assigns, an LLM decides "done" (`tasks.py:597-720`, `workspace_mod.py:1838+`). Botbench's claims plus verified branch with evidence is stronger.
- Verification: no tests, diff, or evidence; Botbench's verified branch is a clear gap they have not started.
- Topology: one central server is the only path; no federation between separately run hubs. Botbench's workbench-to-workbench design (ADR 0004) can offer collaboration without both people trusting one host.

### Deliberately avoid

- Shared workspace token in URLs (`?token=`) and a "machine" principal with full access; stored in clear.
- LLM-classified task status as the source of truth for done or blocked.
- Bypass-permissions launch flags as the default for every adapter.
- A 2,600-line event mod holding join, routing and task logic together (`workspace_mod.py`).

## Capability ratings

1. byo-agent-clis: Implemented, 26 CLI adapters with CLI-login (subscription) mode.
2. model-providers: Implemented, whatever the CLIs support plus direct LLM, cloud and gateway options.
3. tools-connectors: Implemented, per-agent MCP server with workspace files, browser, knowledge, tunnels, integrations.
4. isolation: Absent, agents run in the owner's directory with permissions bypassed; no worktree or sandbox.
5. approvals: Partial, policy and thread cards exist but are cooperative, not enforced on the CLI.
6. memory-scoping: Partial, server-side owner/grant/visibility model; shared agents inherit owner access, intersection rule deferred.
7. identity-authz: Partial, human roles and grants implemented; agent identity is a header on a shared or device token.
8. task-coordination: Partial, human-assigned Kanban and sequential workflows; no claims, dependencies or dedup.
9. cross-owner: Implemented, two owners' agents in one workspace with per-agent and per-thread sharing.
10. peer-transport: Partial, outbound HTTPS poll plus SSE wake to one central hub; no direct or federated path.
11. verification: Absent, LLM classifier and optional reviewer agent only.
12. durability: Partial, server-side records, persisted cursor and reply outbox; in-flight turns not resumed.
13. budgets-usage: Partial, budget field on grants stored but not enforced; usage tracking only for the browser.
14. audit-observability: Partial, events table and approval records; audit log planned.
15. remote-mobile: Partial, web UI and FCM push implemented; mobile app source not in repo.
16. time-to-first-result: Low effort, hosted workspace plus one install script and a pairing code, as documented.

## Open questions

- Can a device token plus `X-Agent-Name` of another owner's agent really read that agent's threads and act as it, or does middleware not read here block it?
- How well do the 26 adapters hold up on long coding turns (stream parsing, resume, stop)?
- How accurate are the routing LLM and the task classifier in practice, and what do they cost per message on the hosted service?
- Is the hosted service exactly this backend, and what does it charge (no pricing found in the repo)?
- Do the mobile apps exist publicly, and what can they do beyond push?
- How does the SSE wake stream behave under load, and is it on for hosted workspaces?
