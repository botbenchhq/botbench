# Agenta

| | |
|---|---|
| Repository | https://github.com/Agenta-AI/agenta |
| Commit read | b0a53f81, 2026-11-23 (shallow clone) |
| Licence | Mixed. The root `LICENSE` puts everything under MIT ("MIT Expat") except two kinds of folder. (1) Every `ee/` directory is under the Agenta Enterprise License (`ee/LICENSE`): production use needs a paid subscription, and patches belong to Agenta. These folders are `api/ee` (466 files), `web/ee` (121), `services/ee` (10), `sdks/python/ee` (6), `hosting/docker-compose/ee` (8), `hosting/kubernetes/ee` (1), and a top-level `ee/` that holds only the licence. (2) `web/website/` (493 files, the marketing site) is "All rights reserved". This audit read only the folder names under `api/ee/src/core` to judge scope: access/entitlements, organizations, subscriptions, meters, measurements, wallets, fraud, plus extensions for secrets, sessions/records and tracing. Agenta Cloud is the hosted tier. |
| Stack | Python 3 FastAPI API with Postgres (SQLAlchemy/Alembic), two Redis instances (volatile and durable), SeaweedFS (S3) for blobs, SuperTokens auth, and stream and queue workers. A TypeScript Node "runner" drives agent harnesses over ACP. The web app is Next.js/React. Deploys as Docker Compose (`hosting/docker-compose/oss/docker-compose.gh.yml`: web, api, worker-streams, worker-queues, cron, services, runner, postgres, redis x2, seaweedfs, traefik/nginx, supertokens, composio) or Kubernetes. |
| Size and activity | About 24,600 tracked files: roughly 4,600 Python and 10,500 TS/TSX. Code comments refer to design decisions by number (D3, D12, D32...), audit findings and an `openspec/` change log. This is a large, mature and fast-moving codebase with dense defensive comments. |
| Evidence basis | Source read only; not run |

## Promise and intended customer

The README calls Agenta "the open-source workspace for your agents and your team". You build "AI coworkers" by chatting, share them with your team, and talk to them in Slack, Telegram or WhatsApp. It explicitly says it is not a coding environment like Claude Code, and names its users as IT ops, GTM, HR, legal, finance and support. Its pitch: multiplayer by default, transparent versioned configuration, per-agent tool permissions with a human in the loop, a sandbox per session, model credentials the agent never sees, traced runs and costs, self-hostable, and usable by non-engineers.

The product began as an LLMOps platform for prompt management, evaluation and observability. All of that is still in the tree and in the UI: `prompts`, `playground`, `testsets`, `evaluators`, `evaluations`, `annotations` and `observability` pages under `web/oss/src/pages/w/[workspace_id]/p/[project_id]/`, and the matching `api/oss/src/core/{evaluations,evaluators,testsets,annotations,tracing}`. The agent workspace was built on top of it. Agents are stored as "workflows" with versioned revisions (`api/oss/src/core/workflows`), so they inherit the older product's versioning, tracing and evaluation.

## What is actually implemented

| Capability (README claim) | Evidence | Source | Note |
|---|---|---|---|
| Build agents by chatting (Builder agent) | Implemented | `api/oss/src/core/workflows/builder_agent.py:26-49` | A built-in agent per project with tools to create and edit agents. `create_agent` and `edit_agent_config` are `ask`. |
| Agents on Claude Code, Codex or Pi harnesses | Implemented | `services/runner/src/harness-kind.ts:20-36`; `services/runner/README.md` | One engine drives harnesses over ACP through the `sandbox-agent` package. `@agentclientprotocol/claude-agent-acp` and `codex-acp` are dependencies (`services/runner/package.json`). |
| Each session in its own sandbox | Partial | `services/runner/src/config/runner-config.ts:20,45-49`; `services/runner/src/engines/sandbox_agent/run-plan.ts:60-67` | Real isolation only on Daytona, a hosted third party that needs an API key. The default `local` provider runs inside the runner container with no egress control, and "no backend applies a filesystem jail". |
| Model credentials never seen by the agent | Partial | `services/runner/src/engines/sandbox_agent/daytona-secrets.ts:16-40` | On Daytona the sandbox holds placeholders, and Daytona swaps in the value for listed hosts. On `local` the credentials are plain environment variables (`sandbox-credentials.ts:42-60`). |
| Use your Claude or ChatGPT subscription | Partial | `api/oss/src/core/secrets/subscription_rules.py:25-60`; `api/oss/src/core/secrets/claude_token.py:1-5`; `run-plan.ts:93-104,146-148` | ChatGPT login stored in the vault: Pi harness only. A Claude setup-token is stored and delivered as `CLAUDE_CODE_OAUTH_TOKEN`. An operator-mounted CLI login works on `local` only; Daytona refuses it. |
| Multiplayer: roles, share agents and chat sessions | Implemented | `api/oss/src/core/sharing/`, `api/oss/src/core/access/service.py:141-222` | Private or project visibility; session grants with Viewer or Participant roles; ownership transfer. In OSS, `NoRbacEntitlement` (`access/rbac.py:6-10`) gives "the short role list"; custom roles are EE. |
| Per-agent tool permissions, ask or allow or deny | Implemented | `sdks/python/agenta/sdk/agents/permission_rules.py:1-60`; `api/oss/src/core/tools/gate.py:1-10` | Rules authored per agent are rendered into Claude or Codex settings and the runner's tool seam. The server-side gate also covers session and config tools. |
| Teams of agents: call other agents, hand off work | Implemented | `api/oss/src/core/tools/session_writes.py:1-21,236-249,1268-1340`; `api/oss/src/core/sessions/child_updates/` | `start_session`, `send_session_message`, `wait_for_sessions`, `cancel_session`, with a depth limit and child updates delivered back. |
| Agents that learn (memory, own skills, own instructions) | Implemented (prompt-level) | `sdks/python/agenta/sdk/agents/platform_instructions.py:404-427` | Memory is a `## Memory` section in the agent's versioned instructions, written with `commit_revision`. There is no separate memory store. |
| MCP and Composio (1,000+ apps) | Implemented | `api/oss/src/core/gateway/providers/composio`; `services/runner/src/tools/mcp-bridge.ts` | Composio runs as its own compose service. |
| Slack, Telegram, WhatsApp, Teams, Discord | Implemented | `api/oss/src/core/channels/adapters/{slack,telegram,whatsapp,teams,discord}` | `ChannelIdentityLink` maps a channel user to an Agenta user (`channels/identity.py`). |
| Automations: schedules and event triggers | Implemented | `api/oss/src/core/triggers/`, `api/oss/src/crons/` | Not read in depth. |
| Vault for secrets | Implemented | `api/oss/src/dbs/postgres/secrets/custom_fields.py:42`; `api/oss/src/core/secrets/scopes.py` | Encrypted with Postgres `pgp_sym_encrypt`. Project and organization scopes. |
| Shared workspace files (drives) | Implemented | `api/oss/src/core/mounts/agent_drives.py:1-60`; `sharing/dtos.py:177-194` | Per-agent drive `<slug>-files`, session drive, private or shared drives, with sharing rules. |
| Every run traced, every cost tracked | Implemented (trace), Partial (cost) | `services/runner/src/tracing/otel.ts`; `services/runner/README.md` (usage with cost) | Usage and cost per run in OSS. Meters and wallets are EE (`api/ee/src/core/{meters,wallets}`). |
| Mobile | Implemented (web) | `web/mobile`, compose `web-mobile` | Not read. |

## Architecture

```
 browser / Slack / Telegram / WhatsApp
        |                      (channel adapters -> sessions)
        v
  web (Next.js) --HTTP--> api (FastAPI) ---- Postgres (workflows, sessions, turns,
                            |   |             records, secrets, sharing, memberships)
                            |   +-- Redis volatile/durable (caches, live frames, queues)
                            |   +-- workers: streams, queues; cron (triggers)
                            v
                      services (Python agent workflow service: decides config, tools,
                            |   secrets, trace for a run; services/oss/src/agent/)
                            v  POST /run  (or stdin CLI), token AGENTA_RUNNER_TOKEN
                      runner (Node, :8765)
                            |  sandbox-agent daemon, ACP
                            v
              harness: Pi | Claude Code (claude-agent-acp) | Codex (codex-acp)
              in: local (runner container) | Daytona sandbox | inprocess (Pi + Daytona cmds)
```

- **Control plane versus runner.** The API owns all state and every decision. The runner is stateless apart from caches, and calls back to the API for tools (`/tools/call`, `services/runner/src/tools/callback.ts`), for the approval gate (`tools/gate-answer.ts`) and to persist session records (`services/runner/src/sessions/persist.ts`).
- **Sessions domain** (`api/oss/src/core/sessions/`): streams (a session), turns, executions (one run attempt in a turn), inputs (queued messages, including `child_update`), interactions (approval cards and questions), records (the event log), commands (cancel, stop) and watch.
- **Durability.** Session records are ingested with a reused record id and a retry budget. A session with lost records is marked incomplete, and a turn that would rebuild from an incomplete log is refused (`services/runner/README.md`, section "Output and ingest limits"). Each turn appends a row to `session_turns` that carries the harness session id and the sandbox id (`services/runner/src/engines/sandbox_agent/session-continuity-durable.ts:1-40`).

## How agents are connected and managed

- **One engine, several harnesses.** `services/runner/src/engines/sandbox_agent.ts` drives any harness over the Agent Client Protocol through `sandbox-agent`. `harness-kind.ts:20-36` normalises the wire spellings to `pi`, `claude`, `codex` or `unknown`, and unknown fails closed.
  - Pi (`@earendil-works/pi-coding-agent`) is the default harness and the only one that runs `inprocess`.
  - The comment in `package.json` `runtimeAgentPins` says Claude Code "is proprietary and installed at runtime by Anthropic (never pinned/baked)". Codex is pinned in the image.
- **Capability probing.** The runner reads the harness's capabilities and branches on them; for example, tools go over MCP only when the harness advertises `mcpTools` (`services/runner/README.md`, "Result").
- **Agent definition.** An agent is a workflow revision: instructions, skills, tools, connections, triggers, drives and harness settings. A change is a new revision through `commit_revision`. The Builder agent edits other agents with the person's rights (`builder_agent.py:51-60`).
- **Sandbox routing.** The provider is per-run config. `routeSandboxForHarness` (`services/runner/src/engines/sandbox_agent/sandbox-routing.ts:36-68`) sends Pi on Daytona to `inprocess` and Claude or Codex to a full Daytona sandbox.
- **Adding a provider.** Add it to `KNOWN_SANDBOX_PROVIDER_IDS` and `SANDBOX_PROVIDER_TRAITS` (`runner-config.ts:20,45-49`). Remote providers other than Daytona fail closed for non-Pi tools until tool delivery is proven (`run-plan.ts:79-85` names an in-flight E2B provider).
- **Resume.** For a session, `sandbox-reconnect.ts:1-11` reads the latest turn's stored sandbox id and restarts the parked Daytona sandbox; failing that it creates a fresh one. `daytona-heartbeat.ts` refreshes activity during long turns so Daytona's autostop does not kill them. Autostop and autodelete defaults are 15 and 30 minutes (`hosting/docker-compose/oss/env.oss.gh.example:121-122`).
- **Agent-to-agent delegation** (`session_writes.py`):
  - A calling agent starts a child session of another agent.
  - The child turn runs with the calling turn's authority and sender, with origin `calling_session`.
  - Messages between sessions are plain text only, "so no approval answer can travel with it" (`session_writes.py:18-21`).
  - The depth limit is `child_session_depth_limit` (`:236-249`).
  - Which agents a session may start comes from the agent's Subagent entries (`may_start`).
  - A private child copies the people named on its calling session (`:1323-1336`).
  - When a child turn ends, the producer writes a `child_update` input and a result file into the caller's working folder (`child_updates/service.py:1-9`).
  - Statuses: running, paused, completed, failed, cancelled, lost (`child_updates/dtos.py:8-17`).

## Models, tools, subscriptions and environments

- **Models.** Any provider key (Anthropic, OpenAI, Gemini, Mistral, MiniMax and more; `sdks/python/agenta/sdk/agents/connections/credentials.py:38-44`), plus Ollama per the README. Provider keys live in the vault at project or organization scope. An organization key is visible to a project only when the organization ids match (`api/oss/src/core/secrets/scopes.py:1-42`).
- **Subscriptions.**
  - ChatGPT logins are stored as vault rows. The runner pushes refreshed tokens back under a lineage check. The decisions accept, noop, stale, invalid, wrong_generation, other_account and older_login (`subscription_rules.py:25-60`) stop a stale or foreign login from replacing the stored one.
  - The publisher is acknowledgement-based, so a refresh token Pi rotated mid-turn is not lost (`engines/sandbox_agent/subscription-login/publisher.ts:1-15`).
  - The vault path supports ChatGPT on Pi only (`run-plan.ts:146-148`).
  - A Claude setup-token is checked against `GET /v1/models` before it is stored, because "Anthropic refuses model calls that do not come from Claude Code" (`claude_token.py:1-5`).
- **Tools.** Gateway tools (Composio connections), MCP servers, code tools and platform tools all go through `/tools/call` on the API.
  - A connection is either the agent's (`account_source: agent`) or the user's own (`account_source: "user"`, "each person who runs the agent uses their own connection", `api/oss/src/core/sharing/disclosure.py:28-59`).
- **Environment hardening.** Caller-supplied environment variables may not override runtime names such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `NODE_OPTIONS` or `LD_PRELOAD` (`services/runner/src/engines/sandbox_agent/sandbox-credentials.ts:5-35`). Declared boundaries the backend cannot enforce fail loudly rather than being silently accepted (`run-plan.ts:52-67`).
- **Harness features disabled.** The platform prompt tells agents not to use their harness's own subagents, background jobs, cron or memory (`platform_instructions.py:328-338`). Agenta replaces each of these with its own mechanism.

## Context and memory scoping

- **Memory is per agent, not per person.** "Lasting facts about this person and this job" go into the `## Memory` section of the agent's instructions. Each fact is marked confirmed or inferred, with a list of what not to store (`platform_instructions.py:404-427`).
  - Because the instructions are a shared revision, a shared agent's memory is visible to and shaped by everyone who uses it.
  - The write is a config change (`commit_revision`), and for the Builder it is gated (`edit_agent_config: ask`).
  - A file in the agent's drive (`agent-files/`) is the other memory place.
- **Drives.**
  - Each agent gets an own drive `<agent slug>-files` (`mounts/agent_drives.py:16-27`), and each session gets a session drive.
  - A private agent may have only its owner's private drive as home.
  - A shared agent cannot list another member's private drive (`DriveNotOwned`, `sharing/types.py`).
  - Sharing an agent shows a disclosure first: which connections it uses, which private drives become shared, and three fixed statements, namely that turns use run credentials, that files and tool results are shared, and that trace readers can read (`sharing/dtos.py:166-194`).
- **Sessions.** Visibility is `private` or `project`. A project-visible session makes every member a Participant: read, send, answer approvals (`sharing/service.py:1418-1424`). A private session admits only the active owner and named Participants (`:474-486`). Channel and ownerless sessions cannot be shared (`NotShareableReason`, `sharing/dtos.py:205-210`).
- **Enforcement.** Every decision goes through `AccessService._decide` (`access/service.py:141-222`) in four steps: eligibility, restrictions, role capability, then the resource policy. The comments note that "none of [the owner shortcuts] opens a private item". Sharing caches invalidate on write, with a TTL of up to 300 s as the stated worst case (`sharing/service.py:1-11`).

## Identity, permissions and autonomous execution

- **Identities.**
  - Human users authenticate with SuperTokens.
  - Principals have kinds: user, API key, and installation for channel bindings (`access/service.py:400-447`).
  - A run acts as "its human, its API key's creator, or its installation's linked user", read from the server's principal record, "never from a request or command field" (`:421-447`).
- **Roles.** Defaults are owner, admin/developer, editor, annotator and viewer, with permission lists in `access/permissions/types.py:4-37,202-319`, including `MANAGE_AGENT_OWNERSHIP`. Workspace invites exist in OSS (`api/oss/src/routers/organization_router.py:132-175`). The richer role catalog is EE.
- **Approvals.**
  - Each tool can be set to `allow`, `ask` or `deny`.
  - For session and config tools the runner asks the server (`resolve_gate`, `gate.py`), which adds facts the runner does not have: whether a person sent this turn, which agent a child session runs, the person's "always approve" choices (`approval_choices`). A fault or a 5 s timeout counts as `ask`.
  - The server also asks before a start, send or cancel in a turn no person sent (`builder_agent.py:37-39`). Automation-driven delegation therefore still surfaces a card.
- **Unattended runs.** Triggers run agents on a schedule or an event. `ask` tools in such runs produce interaction cards that a member answers later. Not read in depth.
- **Audit.** Sharing changes publish events (`sharing/audit.py`). Runs are OTel-traced. Session records are the persisted event log.

## Coordination of tasks and dependencies

- **Within one project, between agents: delegation only.**
  - A parent starts or messages child sessions and waits with `wait_for_sessions`.
  - A child that ends unexpectedly is reported as `lost`. Cold replay marks tool calls without results as having unknown outcomes and "must not tell the model to repeat those calls" (`services/runner/README.md`).
  - Send keys combine the calling session, execution and tool call id (`session_writes.py:1260-1266`), which deduplicates a retried send.
- **Not present.** No claim, lock or dependency graph between peer agents, and no shared task board. Two people starting two agents on the same work are not detected.

## Collaboration between different human owners

This works only inside one Agenta deployment, between members of one organization and project. Separately owned agents of different people work together through the agent sharing and session sharing described above. Owners can transfer an agent, or take one over once the owner has left (`OwnerStillActive`, `InvalidTransferTarget` in `sharing/types.py`). There is no transport between two Agenta installations and no federation. The trust model is a central server and its RBAC.

## Verification and acceptance of outcomes

- **Evaluation stack from the LLMOps product.** Testsets, evaluators, evaluation runs, annotation queues (`api/oss/src/core/evaluations`, `.../annotations`) and human annotation. Agents are workflows, so in principle the same evaluation applies; this audit did not trace an agent run through an evaluation.
- **Per-run acceptance.** None beyond approval cards and the person reading the result. For code work, the platform prompt asks the agent to check `git status`, the diff and the log before `gh pr create`, and never to "invent a PR URL or a commit hash" (`platform_instructions.py:300-326`). This is prompt-level only.

## Install to first useful result

As documented: self-host with Docker Compose (`hosting/docker-compose/oss/`, env example `env.oss.gh.example`), which brings up about 15 containers including Postgres, two Redis, SeaweedFS, SuperTokens and Composio.

- The README's self-host path is to install an Agenta skill into your own coding agent and let it walk you through setup.
- You then need a model key or subscription connection, and for real session isolation a Daytona account and key.
- Agenta Cloud is the low-effort path.

## For Botbench

### Learn

- A cross-functional agent workspace ends up with the same primitives as a coding workbench:
  - sessions with a durable event log
  - approval cards
  - delegation with depth limits
  - per-tool permissions
  - credentials kept out of the agent's reach
  - sandbox resume

  What it adds is a central sharing model: visibility, grants, roles and a disclosure before sharing.
- Agenta drives Claude Code and Codex through ACP adapters rather than their raw CLIs. It still has to fight each harness's built-in subagents, memory and cron by telling the model not to use them (`platform_instructions.py:328-338`).
- The subscription story is fragile for Claude (a setup-token, or a mounted login on local only), and Agenta only offers a refreshed-login vault for ChatGPT on Pi. Botbench's model of driving the owner's own CLI on the owner's machine avoids this whole class of problem.
- "One sandbox per session" holds only on a hosted provider. The local mode states plainly that it enforces neither network nor filesystem boundaries.

### Reuse conceptually (with source references)

All references are in MIT-licensed folders. Patterns can be adapted with attribution, and no `ee/` code was used.

1. **Share disclosure before sharing.** List the connections an agent uses, mark which belong to the owner and which to each person (`account_source: "user"`), list the private storage that would become shared, and state fixed truths ("files and tool results are shared"). See `api/oss/src/core/sharing/disclosure.py:28-59` and `sharing/dtos.py:166-194`. This fits Botbench Peers when a workbench offers an agent or a task to another owner.
2. **Delegation where messages between sessions are plain text only,** so no approval can be forwarded through an agent, with a depth limit, idempotent send keys and terminal statuses including `lost`. See `api/oss/src/core/tools/session_writes.py:1-21,236-249,1260-1266` and `sessions/child_updates/dtos.py:8-17`.
3. **A server-side gate that answers `allow`, `deny` or `ask` with facts the runner lacks,** above all "did a person send this turn". Every fault reads as `ask`. See `api/oss/src/core/tools/gate.py:1-10` and `builder_agent.py:37-39`. Botbench's permission broker could ask the same question for turns started by a peer or an automation.
4. **Fail loudly on boundaries a backend cannot enforce.** See `services/runner/src/engines/sandbox_agent/run-plan.ts:52-67,79-85`.
5. **Lineage checks on refreshed credentials** so a stale or foreign login never overwrites the stored one: `api/oss/src/core/secrets/subscription_rules.py:25-60`, with acknowledgement-based publishing in `subscription-login/publisher.ts:1-15`.
6. **Acting identity taken from the server's record, never from a request field.** See `api/oss/src/core/access/service.py:421-447`.

### Improve on

- **Memory.** A shared agent's `## Memory` is one text blob in the instructions, shared by every user and with no per-person scope (`platform_instructions.py:404-427`). Botbench's ADR 0005 and 0006 provenance and scoping can do better.
- **Coordination.** Peer agents cannot claim work and duplicates are not detected. Only parent-child delegation exists.
- **Collaboration across installations.** None. Everything assumes one central deployment. Botbench Peers targets exactly what Agenta lacks.
- **Local isolation.** The default local provider has no network or filesystem confinement (`run-plan.ts:60-67`). A worktree plus a safety floor on the owner's machine is a stronger default for code.

### Deliberately avoid

- Bringing in a full central service stack (Postgres, two Redis, S3, an auth server, workers) to get sharing. Botbench's single-process local design is its edge.
- Depending on a hosted sandbox vendor for the isolation promise.
- Mixing open and enterprise code in the same repository layout. This makes the open part harder to reuse safely.

## Capability ratings

1. byo-agent-clis: Partial. Claude Code and Codex through ACP adapters. Subscriptions are limited: a Claude setup-token or a mounted login on local only; the ChatGPT vault works on Pi only.
2. model-providers: Implemented. Many provider keys, Ollama, and organization or project keys.
3. tools-connectors: Implemented. MCP, Composio gateway, and channels (Slack, Telegram, WhatsApp, Teams, Discord).
4. isolation: Partial. Per-session Daytona sandbox when configured; the local default has no network or filesystem jail.
5. approvals: Implemented. allow, ask or deny per tool; server gate; "always approve" choices; cards in sessions.
6. memory-scoping: Partial. Memory per agent in versioned instructions; drive and session sharing rules, but no per-person memory.
7. identity-authz: Implemented. Users, API keys, installations; roles and per-resource policy in OSS; a fuller catalog in EE.
8. task-coordination: Partial. Parent-child delegation with depth limit and status; no claims or dependencies between peers.
9. cross-owner: Partial. Several people share agents and sessions in one deployment; no cross-installation path.
10. peer-transport: Absent. One central server.
11. verification: Partial. LLMOps evaluation stack exists; no per-run acceptance gate for agent work.
12. durability: Implemented. Durable session records with retry, turn ledger, sandbox reconnect, cold replay with unknown outcomes.
13. budgets-usage: Partial. Usage and cost per run in OSS; meters and wallets in EE.
14. audit-observability: Implemented. OTel traces per run, persisted session records, sharing audit events.
15. remote-mobile: Implemented. Web and mobile web, plus chat channels.
16. time-to-first-result: High effort to self-host (about 15 containers, model keys, Daytona for isolation); Low on Agenta Cloud.

## Open questions

- Whether Claude Code with a setup-token runs in a Daytona sandbox in practice, or whether it only runs on local.
- How the local provider separates two concurrent sessions in the same runner container: separate working directories only, or more.
- Whether evaluations can score agent sessions end to end, or only prompt and workflow outputs.
- How much of multi-user operation in production needs EE (plan entitlements, role catalog, organization features) beyond the OSS short role list.
- How quickly the 300 s sharing-cache worst case shows up when someone's access is revoked.
