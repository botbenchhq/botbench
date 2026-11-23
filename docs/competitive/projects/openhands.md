# OpenHands (Agent Canvas)

| | |
|---|---|
| Repository | https://github.com/All-Hands-AI/OpenHands (now redirects to github.com/OpenHands/OpenHands) |
| Commit read | c5e47c4, 2026-11-22 (shallow clone) |
| Licence | MIT for the whole checkout (`LICENSE`, `package.json` `"license": "MIT"`). This checkout has **no `enterprise/` folder**: `git ls-files` returns no path containing "enterprise". Earlier versions of this repository carried an `enterprise/` folder under a separate, non-MIT licence; it is not present here, so nothing was read or excluded on that basis. Non-open parts that remain: OpenHands Cloud and "OpenHands Enterprise" are hosted, closed services that Canvas talks to over HTTP (`src/api/cloud/`). The Python SDK and Agent Server live in a separate repository, OpenHands/software-agent-sdk, which is MIT (web: https://github.com/OpenHands/software-agent-sdk). |
| Stack | TypeScript, React 19, React Router 8, Vite, Zustand, TanStack Query, `@openhands/typescript-client` (the Agent Server client); Node launcher scripts (`bin/`, `scripts/`); Electron desktop build (`electron/`); Docker image (`docker/`); Helm chart (`helm/`). The Python Agent Server and Automation Server are pulled at run time via `uvx` from PyPI or a git ref (`scripts/dev-with-automation.mjs:346-421`). State in `~/.openhands` files; frontend state in browser `localStorage`. |
| Size and activity | About 51 MB, 2,954 tracked files, package version 1.43.0, release-please, heavy unit/Playwright test suites. The repository has been rewritten: it is no longer the Python OpenHands agent and runtime but "Agent Canvas", a frontend and local-stack launcher. The agent loop, runtimes, event store and security analyzers are in software-agent-sdk, which was **not cloned for this audit**. |
| Evidence basis | Source read only; not run. Claims about the Agent Server are inferred from the request payloads and types this repo sends and receives; those are marked Partial or Unverified accordingly. |

## Promise and intended customer

README headline: "The self-hosted developer control center for coding agents and automations. Run OpenHands, Claude Code, Codex, Gemini, Pi, OpenCode, or any ACP-compatible agent across local, remote, and cloud backends." The customer is an individual developer or small team that wants an always-on engineering agent, on a laptop, a Mac Mini, a VM, Docker, a DigitalOcean microVM, or OpenHands Cloud, plus scheduled or webhook-triggered automations (Slack reports, GitHub issue decomposition). The commercial upsell is OpenHands Cloud (organizations, hosted sandboxes, shared conversations).

This is now the closest public product to Botbench's first half: drive the owner's existing coding CLIs on their subscriptions, one git worktree per conversation, from a browser. The difference is that OpenHands puts a remote-capable HTTP server (the Agent Server) between the UI and the agent, and treats "where it runs" as a swappable backend.

## What is actually implemented

| Capability | Evidence level | Source reference | Note |
|---|---|---|---|
| Drive Claude Code, Codex, Gemini CLI, Pi, OpenCode via ACP | Partial | `docs/ACP_AGENTS.md:1-60`, `src/constants/acp-providers.ts:72-175`, `src/types/settings.ts:97-109` | Canvas stores `agent_kind: "acp"` plus `acp_command`; the Agent Server (SDK repo) spawns the ACP subprocess. The spawn code is not in this repo. |
| Reuse the CLI's subscription login | Partial | `docs/ACP_AGENTS.md:62-120` | Documented per provider (Keychain, `~/.codex/auth.json`, etc.). Works only when the Agent Server runs on the machine holding the login; containers need the auth blob pasted as a secret (`docs/ACP_AGENTS.md:128-145`). |
| Multiple switchable backends | Implemented | `src/api/backend-registry/types.ts:1-32`, `src/api/backend-registry/storage.ts:13-14,98-118` | A backend is `{id, name, host, apiKey, kind: "local"|"cloud"}` kept in browser `localStorage`. |
| Local / Docker per-conversation execution | Partial | `src/api/agent-server-adapter.ts:534-546,995-1004`, `scripts/dev-safe.mjs:1011-1028` | Canvas sends `workspace.kind = LocalWorkspace` or `DockerExecutionWorkspace`; `OH_CONVERSATION_RUNTIME=docker` and container limits are passed through to the Agent Server, which owns container creation. |
| Git worktree per conversation | Partial | `src/api/agent-server-adapter.ts:813-838,1250-1254` | `worktree: true` by default for local runs, with `worktree_options {base, ref, branch_prefix}` (default prefix `openhands/`). Worktree creation is server-side. |
| DigitalOcean managed microVM backend (MARS) | Implemented (client side) | `src/api/mars/AGENTS.md`, `scripts/mars-tunnel-bridge.mjs`, `scripts/tunnel-client.mjs`, `scripts/mars-api.mjs` | Port-forward tunnel to an agent-server in a microVM, registered as an ordinary `local` backend. |
| Child conversations (agent-to-agent delegation) | Implemented (client tool) | `src/api/launch-child-conversation-client-tool.ts:14-118`, `src/services/child-conversation-launch.ts:117-554` | Agent can launch a child locally (worktree or shared dir) or on Cloud; fire-and-forget. |
| Confirmation mode and security analyzer | Partial | `src/api/agent-server-adapter.ts:785-810,1240,1275-1279`, `src/components/shared/buttons/conversation-confirmation-buttons.tsx:16-150` | Canvas maps settings to `NeverConfirm` / `AlwaysConfirm` / `ConfirmRisky(HIGH)` and `LLM` / `Pattern` / `PolicyRail` analyzers; enforcement is in the SDK. |
| Event stream with resumable cursor | Implemented (client side) | `src/contexts/conversation-websocket-context.tsx:1299-1315,1355-1369` | WebSocket subscribe with `after_seq`; REST history preload; auto reconnect. |
| Automations (cron, GitHub/webhook events) | Partial | `src/types/automation.ts:1-30`, `src/api/automation-service/automation-service.api.ts:70-176,364-372` | UI and client only; scheduler and dispatcher are in OpenHands/automation (separate repo). |
| GitHub/GitLab/Bitbucket/Forgejo listing and PR links | Partial | `src/api/git-provider-items-service.ts:17-40` | Reads a `GITHUB_TOKEN`-style secret from the local secrets store; issue-to-PR flow itself is an automation preset not in this repo. |
| Slack integration | Unverified | README only | No Slack client code in this repo; presumably an automation plugin or MCP. |
| Multi-user, organizations, sharing | Partial (cloud only) | `src/api/cloud/organization-service.api.ts:46-156`, `src/api/cloud/shared-conversation-service.api.ts:21-58` | Organizations, members, service accounts, shared conversations exist only as calls to the closed Cloud API. |
| Single API key auth on self-host | Implemented | `scripts/dev-with-automation.mjs:500-545`, `docs/SELF_HOSTING.md:48-60` | One `LOCAL_BACKEND_API_KEY` per stack, header `X-Session-API-Key`. No per-user identity. |

## Architecture

```
Browser / Electron (Agent Canvas, this repo)
  |  REST + WebSocket, X-Session-API-Key, per backend {host, apiKey}
  v
ingress.mjs :8000 (path router) ---- automation backend :18001 (uvx, OpenHands/automation)
  |
  v
Agent Server :18000 (uvx, software-agent-sdk)  -- conversations, events, secrets, settings
  |-- LocalWorkspace: runs tools on host, optional git worktree per conversation
  |-- DockerExecutionWorkspace: one container per conversation, own agent-server inside
  |-- ACP agent: spawns `npx @agentclientprotocol/claude-agent-acp` etc. over stdio JSON-RPC
  `-- OpenHands agent: LLM loop with tools, MCP, condenser
Alternative backends: OpenHands Cloud (kind "cloud"), DigitalOcean microVM via tunnel (kind "local")
```

- `bin/agent-canvas.mjs` and `scripts/dev-with-automation.mjs` start the stack: they resolve ports, generate or read a session key and an `OH_SECRET_KEY`, run the Agent Server and Automation Server with `uvx --from <pypi or git ref>` (`scripts/dev-with-automation.mjs:346-421`), and front everything with `scripts/ingress.mjs`.
- `scripts/dev-safe.mjs:1009-1075` builds the Agent Server's environment: persistence dir, conversations path (`~/.openhands/agent-canvas/dev_conversations`, `scripts/dev-safe.mjs:741`), bash events dir, session key, and the `OH_CONVERSATION_*` container settings.
- `src/api/agent-server-adapter.ts` (1,721 lines) is the translation layer from UI settings to `StartConversationRequest` payloads; a test (`src/api/no-direct-agent-server-calls.test.ts`) enforces that UI code goes through service adapters.
- `src/api/runtime-service/agent-server-runtime-service.ts:13-90` uses the SDK's `RemoteWorkspace` client for command execution and file download against the per-conversation runtime URL, identically for local and cloud.
- Runtime services info: the launcher publishes ports and URLs on `/server_info.runtime_services`, and the frontend appends them to the agent's system prompt so it does not guess ports (`docs/architecture.md`, `scripts/dev-with-automation.mjs:1517-1549`).
- Docker image entrypoint kills the container when `/alive` fails for about 30 s so a restart policy can recover it (`docker/entrypoint.sh:120-160`, README).

## How agents are connected and managed

Two agent kinds (`src/types/settings.ts:97-109`):

- `openhands`: the built-in SDK agent; LLM, condenser, MCP and tool settings apply; Canvas also registers "client tools" that the browser executes: Canvas UI control, `launch_child_conversation`, `request_secret`, automation form (`src/api/agent-server-adapter.ts:1222-1238`).
- `acp`: an external CLI spawned by the Agent Server as an ACP subprocess. LLM settings are inert; `mcp_config`, `acp_command`, `acp_args`, `acp_model`, `acp_server` apply. Client tools are not offered to ACP agents (`src/api/agent-server-adapter.ts:1225` sends `[]` unless kind is `openhands`).

The provider registry is upstream: `openhands.sdk.settings.acp_providers`, mirrored into the TypeScript client, then enriched with icons and copy in `src/constants/acp-providers.ts:121-175`. Adding a new CLI means adding it in the SDK; any ACP-speaking CLI can also be configured as a custom command. Default launch commands are `npx -y @agentclientprotocol/claude-agent-acp`, `npx -y @agentclientprotocol/codex-acp`, `npx -y @google/gemini-cli --acp`, and so on (`docs/ACP_AGENTS.md:40-48`); they are downloaded on first use, not preinstalled.

Agent profiles (`src/api/agent-profiles-service/`, `src/constants/profile-scope.ts:1-30`) bundle agent kind, LLM profile, skills, and an allow-list of MCP servers and secrets per profile (tri-state: null = all, array = only these). Lifecycle per conversation: start request, `max_iterations`, `stuck_detection: true` (`src/api/agent-server-adapter.ts:1038-1039`), pause/resume, confirmation responses.

## Models, tools, subscriptions and environments

- **Subscriptions**: ACP agents use the CLI's own login when the Agent Server runs on the same machine; the login takes priority over any API key (`docs/ACP_AGENTS.md:62-110`). For Docker or cloud backends the user pastes `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON` (contents of `~/.codex/auth.json`), etc. into secrets (`docs/ACP_AGENTS.md:128-145`). Cloud runs only Claude Code, Codex and Gemini.
- **API keys** for the OpenHands agent: LLM profiles and "provider connections", a shared `api_key` plus base URL per provider (`src/api/provider-connections-service/provider-connections-service.api.ts:1-30`), any LiteLLM-style model.
- **Credentials location**: the Agent Server's secrets store, encrypted with `OH_SECRET_KEY` persisted under `~/.openhands` (`scripts/dev-safe.mjs:94-96,745`). Secrets are passed per conversation as `LookupSecret` references (`src/api/agent-server-adapter.ts:1024-1030`) and appear as environment variables. Browser `localStorage` holds every backend's session key; `docs/SELF_HOSTING.md` flags that any script on the Canvas origin (including the bundled VS Code) can read them (issue #16492).
- **Tools**: MCP servers, skills, plugins, hooks (`hook_config`, `src/api/agent-server-adapter.ts:1284-1288`), a browser tool, terminal, file editor, OpenVSCode under `/vscode`.
- **Isolation**: (a) none: host filesystem access (README warns); (b) whole stack in one Docker container with `/projects` mounted; (c) one container per conversation (`OH_CONVERSATION_RUNTIME=docker`) with memory, CPU and pids limits (`scripts/dev-safe.mjs:1013-1020`); (d) microVM per DigitalOcean session; (e) Cloud sandbox. Local conversations default to a git worktree, Docker ones do not (`src/api/agent-server-adapter.ts:1250-1254`). README notes that conversations sharing a host workspace share files.

## Context and memory scoping

- Conversation history and state belong to the Agent Server that ran it; a conversation is not portable between backends. Canvas keeps only local metadata (`src/api/conversation-metadata-store.ts`).
- Agent profiles scope MCP servers and secrets per profile (`src/constants/profile-scope.ts:1-30`), the one explicit context boundary in the open code.
- Child conversations get no parent history; the brief must be self-contained (`src/api/launch-child-conversation-client-tool.ts:14-20`).
- No per-person scoping on self-host: everyone holding the backend key sees all conversations, secrets and settings. Per-user and per-org scoping exists only through Cloud (`src/api/cloud/organization-service.api.ts`).

## Identity, permissions and autonomous execution

- **Human identity (self-host)**: a single shared bearer key per stack; loopback mode injects it into the HTML, public or LAN mode makes the user paste it (`scripts/dev-with-automation.mjs:500-545`, README). No accounts, roles or audit by user.
- **Agent identity**: conversations are tagged with `clientsource=canvas` and `acpserver=<provider>` (`src/api/agent-server-adapter.ts:1257-1264`), for telemetry only.
- **Approvals**: confirmation mode maps to the SDK's confirmation policies: off = `NeverConfirm`; on = `AlwaysConfirm`; on with LLM analyzer = `ConfirmRisky` with threshold HIGH and `confirm_unknown: true` (`src/api/agent-server-adapter.ts:785-796`). Analyzers: `LLMSecurityAnalyzer` (the model labels each action's `security_risk`, `src/types/agent-server/core/events/action-event.ts:46-61`), `PatternSecurityAnalyzer`, `PolicyRailSecurityAnalyzer` (`src/api/agent-server-adapter.ts:798-809`). The agent state `waiting_for_confirmation` (`src/types/agent-server/core/base/common.ts:71`) shows Approve/Reject buttons with the risk level (`src/components/shared/buttons/conversation-confirmation-buttons.tsx:103-150`). Whether this applies to ACP agents (whose own permission prompts ACP carries as `session/request_permission`) is not visible here: no code in this repo handles ACP permission requests.
- Child launches carry tool annotations (`readOnlyHint: false`, `openWorldHint: true`) so the analyzer predicts their risk (`src/api/launch-child-conversation-client-tool.ts:108-117`). The local planner child runs with `NeverConfirm` (`src/api/agent-server-adapter.ts:1409`).
- **Unattended**: automations run on schedules or webhooks with whatever policy their profile has; there is no separate floor for automation runs in this repo.
- External guardrail integration is documentation only (`docs/DefenseClaw.md`: LLM proxy, skill and MCP scanning, no code changes).

## Coordination of tasks and dependencies

- No task queue, claims or locks. The unit is a conversation. Delegation is `launch_child_conversation`: the server records `parent_conversation_id` and derives `sub_conversation_ids` (`src/api/agent-server-adapter.ts:1410-1420`, agent-server >= 1.37.1).
- Duplicate-work avoidance is prompt-level only: "One call per delegated task. Do NOT call this tool twice" and "keep each child's scope independent" (`src/api/launch-child-conversation-client-tool.ts:30-35`).
- Isolation is the conflict mechanism: `isolation="worktree"` cuts a fresh worktree from the default branch; when the parent workspace cannot host one (no commits) or creation fails, it falls back to the shared directory and tells the agent why (`src/services/child-conversation-launch.ts:228-316`).
- Results are not joined: the child "does not block you, you do not see its output"; only an acknowledgement with id, URL and status comes back (`src/api/launch-child-conversation-client-tool.ts:16-20,48-55`).
- Automation triggers can either start a new run or `continue_conversation` the one an earlier event started (`src/types/automation.ts:22-26`), a light form of event-to-conversation affinity.
- Recovery: per-conversation containers mount workspace and persisted state so history survives container replacement (README Option 3); the WebSocket resumes from `after_seq` (`src/contexts/conversation-websocket-context.tsx:1299-1315`); Docker entrypoint fails fast on a hung server.

## Collaboration between different human owners

- Self-host: a team can share one Agent Server by sharing its key and URL; README suggests "share an Agent Server with your team for agents doing code review and dependency updates, then have your personal agents running on your laptop". That is shared access to one installation, not collaboration between separately owned installations; there is no identity to tell members apart.
- One browser can connect to many backends (personal laptop, team VM, Cloud) and switch, but backends do not talk to each other; a child conversation can cross from local to Cloud only through the Cloud API with the same user's credentials (`src/services/child-conversation-launch.ts:393-454`).
- Cloud: organizations, members, service accounts and shared read-only conversations (`src/api/cloud/shared-conversation-service.api.ts:21-58`). Closed service.
- No workbench-to-workbench transport, no trust model between owners.

## Verification and acceptance of outcomes

- No acceptance gate on agent output in this repo. Outcomes are conversations, PR links (`constructPullRequestUrl`, `src/api/git-provider-items-service.ts:6`) and automation run history.
- Iteration cap and stuck detection are always on (`src/api/agent-server-adapter.ts:1238-1239`).
- The repo's own development uses `test-evidence/` and `docs/verification/` for PR screenshots, which is a process, not a product feature.

## Install to first useful result

As documented (README): Node 24 and `uv`, then `npm install -g @openhands/agent-canvas && agent-canvas`, which downloads Python and `openhands-agent-server` via `uvx` on first launch, opens `http://localhost:8000`, then a four-step onboarding: choose agent (OpenHands or an ACP CLI), check backend, credentials (optional locally if the CLI is logged in), say hello (`docs/ACP_AGENTS.md:120-150`). Docker alternative: one `docker run` with a state volume and a projects mount. Per-conversation containers: `OH_CONVERSATION_RUNTIME=docker agent-canvas`. Self-hosting on a VM: firewall, systemd, nginx and Let's Encrypt (`docs/SELF_HOSTING.md`). No account needed unless using Cloud or DigitalOcean.

## For Botbench

### Learn

- OpenHands reached the same conclusion as Botbench, drive the owner's coding CLIs on their subscriptions in a worktree, and implemented it through ACP rather than per-CLI adapters. Their CLI list (Claude Code, Codex, Gemini, Pi, OpenCode) overlaps Botbench's almost exactly.
- Their portability boundary is the Agent Server HTTP+WebSocket API, not the UI and not the CLI. Everything Canvas does goes through it, so "where it runs" reduces to a `{host, apiKey}` record (`src/api/backend-registry/types.ts:4-22`). The microVM backend proves the point: a tunnel to an agent-server registers as an ordinary local backend and "conversations, files, and the terminal work unmodified" (`src/api/mars/AGENTS.md`).
- Subscription logins do not travel: on a container or cloud backend the user must paste OAuth tokens or auth files as secrets. Execution portability costs credential portability, and that is a security cost.

### Reuse conceptually (with source references)

All MIT; patterns may be adapted with attribution, code may be copied with the licence notice. The SDK (MIT) was not read.

1. **Backend as a value, execution behind one API.** `Backend {host, apiKey, kind}` plus a `RemoteWorkspace` client used identically for local and cloud (`src/api/backend-registry/types.ts:4-22`, `src/api/runtime-service/agent-server-runtime-service.ts:13-60`). For Botbench: define a small "execution host" protocol (start task, stream events with a cursor, run command, read file, respond to approval) that today's in-process Mac runner implements, so a Linux VM or container runner can implement it later without touching the broker or UI.
2. **Workspace kind in the start request.** `workspace: {kind: "LocalWorkspace"|"DockerExecutionWorkspace", working_dir}` plus `worktree` and `worktree_options {base, ref, branch_prefix}` plus `container {memory, cpus}` (`src/api/agent-server-adapter.ts:534-546,813-838`). A clean way to make isolation a per-task parameter rather than a global mode.
3. **Delegation tool with explicit isolation and honest fallback.** `launch_child_conversation(target, task, isolation)` with server-side validation that returns corrective guidance, worktree by default, and a stated fallback when a worktree cannot be cut (`src/api/launch-child-conversation-client-tool.ts:14-118`, `src/services/child-conversation-launch.ts:117-316`).
4. **Cursor-based event resume.** Subscribe with `after_seq` from the last REST page, replacing timestamp comparisons (`src/contexts/conversation-websocket-context.tsx:1299-1315`). Botbench's phone view and any remote runner need the same.
5. **Risk-tiered confirmation policy as data.** `NeverConfirm` / `AlwaysConfirm` / `ConfirmRisky{threshold, confirm_unknown}` with a pluggable analyzer (`src/api/agent-server-adapter.ts:785-809`), and tool annotations feeding the risk guess (`src/api/launch-child-conversation-client-tool.ts:108-117`). Comparable to Botbench's broker; the `confirm_unknown` flag is a good default.
6. **Secrets requested in-flow, never in chat.** `request_secret(name, reason)` stores the value and exposes it as `$NAME` (`src/api/request-secret-client-tool.ts:1-50`).
7. **Runtime services in the system prompt.** Launcher publishes real URLs and ports via `/server_info.runtime_services` so agents do not guess (`scripts/dev-with-automation.mjs:1517-1549`).

### Improve on

- **Identity**: self-host has one shared key and no per-user identity, roles or audit (`scripts/dev-with-automation.mjs:500-545`); per-user features are Cloud-only. Botbench Peers can offer per-owner identity across installations without a vendor cloud.
- **Key handling in the browser**: every backend's session key sits in `localStorage`, readable by any script on the origin including the bundled editor (`docs/SELF_HOSTING.md`, issue #16492). Botbench can keep tokens server-side and scope them per device.
- **Approval coverage for vendor CLIs**: confirmation and analyzers are configured for the OpenHands agent; this repo shows no handling of ACP permission requests, and client tools are withheld from ACP agents (`src/api/agent-server-adapter.ts:1225`). Botbench's permission broker over vendor CLIs is a real differentiator if it covers all of them.
- **Delegation without join or verification**: children are fire-and-forget, deduplication is a prompt instruction, and results are not returned or checked (`src/api/launch-child-conversation-client-tool.ts:16-35`). Botbench's claims and verified-branch evidence go further.
- **No cross-owner collaboration**: backends never talk to each other. That is the Peers gap Botbench is aiming at.

### Deliberately avoid

- Running the agent with full host filesystem access as the default quickstart (README Option 1, Option 4).
- Copying subscription OAuth tokens and auth files into remote containers as the price of portability; prefer running the vendor CLI where its login already lives, or a provider-sanctioned token, and say so in the UI.
- Splitting the product across four repositories with runtime `uvx` downloads of pinned servers; it makes the security surface and version skew hard to reason about (`src/api/agent-server-compatibility.ts`, `scripts/check-sdk-version-sync.mjs`).

### What it would take to make Botbench execution portable

From OpenHands' design, the minimum is: (1) a runner process that owns the CLI subprocess, worktree and event log, separate from the UI and broker, reachable over HTTP+WebSocket with a bearer key; (2) a start request that names workspace kind, worktree options and resource limits; (3) an event stream with a monotonic sequence cursor; (4) ACP or per-CLI adapters inside the runner, not the UI; (5) a credential story per host type (local login reuse versus injected token); (6) a backend registry in the UI. Botbench's broker would have to sit in or in front of the runner so approvals still hold when the runner is remote.

## Capability ratings

1. byo-agent-clis: Partial; ACP subprocesses with subscription login reuse are configured here, spawning is in the SDK repo.
2. model-providers: Implemented; any LLM via provider connections for the built-in agent, five ACP CLIs plus custom.
3. tools-connectors: Partial; MCP, skills, plugins, hooks configured here; Slack and Linear integrations not found in this repo.
4. isolation: Partial; worktree, per-conversation Docker, microVM, Cloud sandbox are requested here and executed by the Agent Server.
5. approvals: Partial; confirmation policies and three analyzers are wired from the UI; no visible handling for ACP agents.
6. memory-scoping: Partial; per-profile MCP and secret allow-lists; no per-person scoping on self-host.
7. identity-authz: Partial; one shared bearer key on self-host; organizations and members only via closed Cloud.
8. task-coordination: Partial; parent/child conversations with worktree isolation; no claims, locks or joins.
9. cross-owner: Absent; shared server access only, no collaboration between separately owned installations.
10. peer-transport: Absent; UI connects to many backends, backends never talk to each other (tunnel is UI-to-VM only).
11. verification: Absent; iteration cap and stuck detection, no acceptance gate or evidence.
12. durability: Partial; server-persisted conversations, container state survives replacement, cursor resume; recovery logic is server-side.
13. budgets-usage: Partial; `max_budget_per_task` setting and accumulated cost in conversation state (`src/types/settings.ts:161`, `src/utils/conversation-metrics.ts`); enforcement in SDK.
14. audit-observability: Partial; full event stream per conversation and telemetry tags; no per-user audit.
15. remote-mobile: Partial; browser UI reachable remotely via SSH tunnel or nginx with key entry; no mobile-specific client found.
16. time-to-first-result: Low effort; one npm install and an onboarding modal, reusing an existing CLI login locally.

## Open questions

- How the Agent Server spawns ACP agents, and whether ACP `session/request_permission` is routed into confirmation mode and the security analyzers (needs the software-agent-sdk source or a run).
- Whether a Docker per-conversation sandbox can be resumed after an Agent Server restart with its process state, or only its files and event history.
- Whether `max_budget_per_task` is enforced for ACP agents, whose LLM calls the server does not see.
- How the issue-to-PR and Slack automations are built (OpenHands/automation and `@openhands/extensions`, not read).
- How a Claude Code subscription OAuth token behaves inside a remote container over time (refresh, terms of use).
