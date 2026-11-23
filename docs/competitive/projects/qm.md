# QM (quartermaster)

| | |
|---|---|
| Repository | https://github.com/yc-software/qm |
| Commit read | 6f84bff, 2026-11-23 (shallow clone) |
| Licence | MIT (`LICENSE`). No enterprise folder. Hosted variants are offered by third parties (README lists DigitalOcean, E2B, Render, Superserve marketplaces and a fully hosted "Agent 37"); those are outside this repo. Model pi packages are vendored forks fetched from the repo's own GitHub releases (`package.json:77-78`). |
| Stack | TypeScript run directly on Node 24, Fastify core, Postgres (required; `pg`, `pg-boss`, pgvector-style vector store), Slack plugin on Bolt, web UI in Vite + Lit, Electron desktop client, native iOS client (Swift). Agent loop is the vendored Pi coding agent (`@earendil-works/pi-coding-agent`). Deploys as a server into the operator's own cloud: AWS, Render, Fly.io, Porter/Helm; a local Docker target exists for test drives only. Sandboxes on about ten providers (Modal, E2B, Sprites, AWS microVM, Render, Superserve, Smolmachines, Agent37, Porter, DigitalOcean Managed Agents, local Docker). |
| Size and activity | About 3,100 files. `src/` about 160k lines of TS, `test/` about 256k lines (896 test files), `plugins/` about 103k. `docs/SPEC.md` carries a long "Wall of shame" citing PRs up to qm#3440 dated 2026-11-10, so the project is large, young (PR history from 2026-08) and very active. Many migrations and "historylessness" notes show fast churn. |
| Evidence basis | Source read only; not run |

## Promise and intended customer

"A multiplayer agent harness for teams. In Slack and on the web. Run it in your own cloud, with your own models and keys" (README). The customer is one organization of authenticated internal users (SECURITY.md "Scope"), deployed by an operator into that organization's cloud account. Each person and each room (Slack channel, group DM, project) gets its own scoped memory, files, keychain view, permissions, crons, web apps and durable sandbox. Agents are always on: crons, watches, inbound webhooks and "loops" run while people are away. Swarms (pools of durable worker sessions) are a newer addition.

It is an organization server, not a personal tool. Nothing in it federates between separately operated deployments.

## What is actually implemented

| Capability (README headline first) | Evidence | Source | Note |
|---|---|---|---|
| Personal and shared scopes | Implemented | `src/types.ts:23-75`, `src/resolution/resolution-service.ts:22-30,57-108` | Scope kinds `personal, channel, team, org, group, persona`. DM maps to `personal:<actor>`; channel/group map to the room. |
| Per-scope memory | Implemented | `src/memory/policy.ts:21-30`, `src/memory/cross-scope.ts:44-81`, `src/memory/disclosure.ts:22-60` | Postgres `memory_facts` keyed by `scope_id` (`src/memory/postgres-memory-service.ts:11,21`). |
| Per-scope files and grants | Implemented | `src/acl/acl-store.ts:13-28,136+`, `src/types.ts:196-213` | Grant = owner scope, ref, grantee scope, read/write. |
| Per-person keychain with grants to a room | Implemented | `src/credentials/keychain.ts:83-155,1022-1075` | Once or standing grants, asks with 24 h TTL, owner approval. |
| Sharing posture Isolated/Open | Implemented | `src/resolution/sharing-posture.ts:10-19`, `src/resolution/sharing-access.ts:38-74` | Fail-closed composition: any Isolated wins. |
| Security posture Strict/Auto/Dangerous | Implemented | `src/security/security-posture.ts:4-35` | Auto = no tool approvals, private networks denied. Strict = approve every tool call. |
| Command policy (admin approval/deny rules) | Implemented | `src/policy/command-policy.ts:7-20,517-540` | Ships with no rules; SECURITY.md calls it bypassable. |
| Content screening for prompt injection | Partial | `src/security/security-screener.ts`, `src/security/security-posture.ts:51-157` | Model classifier; off by default; SECURITY.md lists uncovered inputs. |
| Audit log | Implemented | `src/audit/audit-log.ts:5-39`, `src/admin/postgres-audit-log.ts:24-40` | Postgres `audit_log` table, `impersonated_by` column. |
| Slack and web, same identity | Implemented | `src/slack/` (46 files), `plugins/web-ui/`, `src/identity/principal-links.ts`, `docs/principal-links.md` | Principal links fold several sign-ins to one canonical person. |
| Durable per-scope sandbox ("its own computer") | Implemented | `src/sandbox/sandbox-resources.ts:31-50`, `src/sandbox/sandbox.ts:52-73`, `docs/sandbox-preservation.md` | Provider snapshot or tar-to-S3 home recovery per backend. |
| Swarms | Implemented | `src/swarms/swarm-store.ts:80-131,201-306`, `src/swarms/swarm-service.ts:463-515,715-898` | Message-passing pools; no task board (see Coordination). |
| Persistent subagents | Implemented | `docs/persistent-subagent-sessions.md`, `src/runs/postgres-run-store.ts:154-155` (pending child returns index) | Durable child sessions, mailbox, completion wakes. |
| Goals with an independent governor | Implemented | `src/agent/goal.ts:91-104,390-394,411,451-461` | LLM governor decides continue/complete/step_back/pause. |
| Loops with ship gates and success checks | Implemented | `src/loops/ship-gate.ts:29-37`, `src/loops/success-evaluation.ts:40-66` | Command checks then LLM judge. |
| Swappable harness (Pi vs other) | Absent (removed) | `src/wiring.ts:2104-2112` migration `runtime/0002-drop-harness-choice` | Drops `approved_harness_configs` and strips `harnessId` from configs, crons and swarm templates. Only Pi remains. |
| Model breadth via Pi, gateway, BYO subscription | Implemented | `src/model/` (24 files), `src/core/individual-auth-routing.ts:22-106`, `src/model/claude-subscription.ts:1-9` | Anthropic, OpenAI, OpenRouter, custom providers, gateway discovery; per-user Claude or ChatGPT login. |
| Budgets | Implemented | `src/ratelimit/budget.ts`, `src/ratelimit/postgres-budget.ts`, `src/config.ts:591-592` | Per-person and org USD per window. |
| Published web apps | Implemented | `src/deploy/` (32 files) | Out of scope for Botbench; capability links are bearer (SECURITY.md). |
| Multi-tenant hosting | Partial | `src/tenants/`, `docs/tenant-tokens.md` | Postgres row security plus a migration toward explicit tenant tokens "in transition". |

On the brief's lead that "more code governs access than drives the agent": by directory, access-related modules (`acl, admin, auth, credentials, identity, policy, security, resolution, tenants, directory, audit`) total about 13k lines, against about 25k for `agent, core, runs, swarms`. `src/api/` (34.7k lines) mixes both: 54 of its files return 403s. The source does not clearly back the claim. What it does show is that authorization checks are spread through nearly every module rather than kept in one policy engine.

## Architecture

```
 Slack (Bolt, in-process plugin) ─┐
 Web UI / portal / auth broker ───┼─> Core (Fastify HTTP API, src/api)
 iOS, desktop (clients of web) ───┘        │  identity -> resolution (scope, posture, grants)
                                           │  orchestrator (src/core/orchestrator*) assembles context
                                           │  runs queue (Postgres) -> workers (src/runs/worker.ts)
                                           │  agent turn = Pi session (src/agent/agent-run.ts)
                                           │  tools: execute, memory, subagents, swarm, ...
                                           ▼
             Postgres: items (transcript WAL), runs, sessions, durable maps, memory, audit
                                           │
            Per-scope sandbox via router (src/sandbox/sandbox-routing.ts) on a cloud provider
            Sandbox calls back to core with capability tokens (agent self-API, credential
            broker, git broker, egress proxy)
```

- Single composition root: `src/wiring.ts` (3,487 lines). `buildApp` at `src/wiring.ts:607` wires the notebook memory (`:866`), the memory registry and tidy wrapper (`:876-882`), every sandbox backend with its required env vars (`:981-1187`), sandbox resources (`:1231`) and the sandbox router (`:1294`), and the memory strategy (`:1885`). It also registers many migrations inline. This is the "single wiring file" the brief mentions, but it no longer swaps harnesses.
- Durable turn execution: `docs/SPEC.md:15` says a worker claims a queued run, the claim is the session's only turn lock and fences the turn's writes, and the result is committed to the `items` table.
- Run queue: `runs` table (`src/runs/postgres-run-store.ts:131-157`) with `lease_token`, `lease_expires_at`, `attempts`, `max_attempts`, `retry_after`, `claim_priority`. A partial unique index `idx_runs_one_running_per_session` (`:153`) allows at most one running run per session.
- Many subsystems store state as JSONB "durable maps" (`src/persistence/durable-map.ts`), for example the whole swarm in one row.
- Spec principles (`docs/SPEC.md:5-33`): thin harness, state in Postgres, "no sandbox is precious", grants to break scope isolation, background work carries the owner's authority.

## How agents are connected and managed

- One harness: Pi. Turns are fulfilled by `@earendil-works/pi-coding-agent` (`src/agent/agent-run.ts:31-38`, `src/agent/turn-session.ts:1`), vendored by QM with a security patch (`package.json:78`). Only the model, effort and fast mode can be chosen per turn (`src/agent/agent.ts:40-44` `RuntimeChoice`).
- The harness-choice table and `harnessId` fields were deleted (`src/wiring.ts:2104-2112`). SPEC's line that harnesses are "swappable resources" (`docs/SPEC.md:8`) is not backed by current code. The spec's "Wall of shame" records a `{ harness, model }` pair added in qm#2134. The migration shows it was later removed. No Claude Code, Codex CLI or other external agent CLI adapter exists in `src/`.
- The agent has a small fixed tool surface. `execute` runs shell commands in the scope's sandbox. Other tools cover memory, subagents, sessions, swarm and surface actions (`src/agent/agent-tools/`, `src/tools/primitives.ts`).
- Lifecycle: a durable session holds the transcript in `items`. Runs are enqueued, claimed by workers, heartbeated, and on lease expiry requeued or parked by a leader-elected reaper (`src/runs/reaper.ts:33-46`). Subagents are durable child sessions. Swarm workers are ordinary sessions owned by the swarm.
- Adding a new agent type means adding a model to the catalog or a custom provider (`src/model/custom-providers.ts`, `docs/model-gateway.md`), not a new CLI driver.

## Models, tools, subscriptions and environments

- Org model keys: Anthropic, OpenAI or OpenRouter, chosen at deploy time (`cli/templates/deployment/deployment.md` step 1). A model gateway can be discovered and routed through (`src/model/gateway-catalog.ts`).
- Per-person BYO model auth: a user can attach an Anthropic or OpenAI API key, or an OAuth login (Claude subscription or ChatGPT/Codex login). `resolveIndividualAuthRouting` picks the credential (`src/core/individual-auth-routing.ts:22-78`). `loadPersonalModelAuth` turns it into provider keys (`:80-106`). A Claude subscription token is sent with the `claude-code-20250219` and `oauth-2025-04-20` beta headers (`src/model/claude-subscription.ts:1-9`). This is subscription auth used inside QM's own Pi loop, not the user's installed CLI. Whether that use fits the providers' terms is a question for the operator. The source does not address it.
- Org-wide subscription auth: `CODEX_AUTH_CREDENTIAL` / `CLAUDE_AUTH_CREDENTIAL` point at a keychain credential that core refreshes centrally (`.env.example`).
- Credentials live encrypted in Postgres (`secretEnc`, `src/credentials/keychain.ts:83-105`), keyed by `CONNECTOR_SECRET_KEY`. Two delivery modes:
  - Materialized: env vars or files placed into the sandbox for a command (`src/credentials/credential-injection.ts`, `src/credentials/execute-files.ts`). SECURITY.md says these are plaintext while in use.
  - Brokered: the secret never enters the sandbox. The sandbox calls core's credential broker or git HTTP broker, and core adds headers for allowed hosts, methods and path prefixes (`src/api/credential-broker.ts:120-169`, `src/api/git-http-broker.ts:12-30`). Broker credentials cannot be granted for materialization (`src/credentials/keychain.ts:1044-1046`).
- Connectors: OAuth app connections, Composio, Gmail, MCP servers (`src/mcp/mcp-client.ts`, `src/mcp/mcp-server-store.ts`, `docs/mcp-connectors.md`).
- Isolation: one durable computer per scope on a cloud sandbox provider, chosen by `SANDBOX_BACKEND` (`src/wiring.ts:981-1187`). The profile declares `writablePersistence` (`snapshot_to_workspace | resident_disk | provider_managed`), `parksOnTeardown` and `egressEnforcement` (`none | ip_port | domain`) (`src/sandbox/sandbox.ts:52-73`). Egress goes through an egress proxy with provider network rules when `EGRESS_PROXY_URL` is set. Without it, Modal and Render "run fail-open" (`docs/sandbox-preservation.md`).
- Persistence per backend (`docs/sandbox-preservation.md`): Modal directory checkpoints of `/root` every 300 s, with 30-day retention and renewal for idle scopes. E2B pause plus a native snapshot at teardown. Render runtime snapshots that include processes. Sprites keep the whole disk, with copy-on-write checkpoints and an optional tar export before destroy. Smolmachines and DO Managed Agents use tar-to-S3. Hydration failure refuses to hand over a blank home. A pending marker survives core crashes.
- Load-aware but agent-decided: every command records a load sample, and the agent, not the platform, decides where to run work (`docs/SPEC.md:23`, `src/sandbox/load-probe.ts`).

## Context and memory scoping

This is QM's strongest area.

- Scope resolution: `conversationScope` makes a DM `personal:<actor>`, a group `group:<ref>` and a channel `channel:<ref>` (`src/resolution/resolution-service.ts:22-30`). A turn gets one `writableScopeId` and read-only `org` plus `team` scopes (`:67-69,94-96`). External (guest) turns get no read-only scopes, no org soul and no grants (`:67-92`).
- Memory recall reads `[writable, ...readOnly]` scopes by policy `off | writable | visible` (`src/memory/policy.ts:21-30`). Capture writes only to the writable scope. Each recalled fact is labelled with its source scope (`src/memory/cross-scope.ts:37-38,83-94`).
- Memory disclosure check (`src/memory/disclosure.ts:22-60`): a fact from a scope may enter a turn only if the actor and every audience member are entitled to that scope. Personal scope is entitled only to the same person (`samePerson`). Team scope needs team membership. A shared room needs a current membership check.
- Grants and the audience floor (`src/acl/acl-store.ts:24-28`): a grant is visible in a conversation only if at least one audience member is entitled to the grantee scope and every audience member is entitled to either the grantee or the owner scope. A private resource therefore does not leak into a room containing someone who could not otherwise see it.
- Entitlement function (`src/resolution/context-filter.ts:15-20`): `[org, session scope, personal:<p>, team:<t>...]`, minus scopes excluded for "own-scope bot work".
- Open sharing posture (`src/resolution/sharing-access.ts:38-74`): only on a live, authenticated, internal human turn. The speaker's personal scope becomes a source for a shared room they currently belong to. In their DM, up to 25 recent shared scopes they still belong to become sources (`MAX_OPEN_SHARED_SCOPES = 25`, `:9`). Carried files are read-only handles under `shared/open-<scope>/` (`:88-109`). Composition is fail-closed (`src/resolution/sharing-posture.ts:10-12`).
- Bot work: a Slack bot's turn is kept out of a person's projects, swarms and computers. Once a person posts in a bot-started swarm, the bot loses access (`docs/swarms.md` "Human API", `src/swarms/swarm-store.ts:44-78`, `src/core/orchestrator/` bot checks).
- Tenant boundary: Postgres row security `tenant_isolation` on `qm_bound_tenant()` (`src/tenants/migrations.ts:56-58`), moving to explicit tenant tokens (`docs/tenant-tokens.md`).
- Known gaps the project states itself (SECURITY.md): audience-floor filtering does not yet carry complete origin labels for every granted read. The ambient Slack judge path skips the full internal-only check. Open sharing relies on the model not to repeat private data in a shared reply.

## Identity, permissions and autonomous execution

- Human identity: Slack user IDs, email magic link from the built-in auth broker (`plugins/auth/`), or OIDC. Principal links fold these into one canonical person (`src/identity/principal-links.ts`, `docs/principal-links.md`). Directory sync marks bots (`is_bot`) and deactivates removed members (`src/identity/identity-service.ts:26-40`).
- Agent identity: the agent always acts as the principal resolved for the turn. There is no impersonation route in the agent self-API (SECURITY.md "Deliberately portal-only actions"). The sandbox reaches core with signed capability tokens (`src/auth/capability-token.ts:11-80`). These carry `actorId`, `scopeId`, `audienceScopeId`, destination and audience (`aud`) such as `credential-broker` or `egress-proxy`. Sandbox tokens last 48 h by default. A token says a person is at the keyboard only while its run is still running. After that it carries owner authority like a cron fire (`docs/capability-tokens.md` "Sandbox token lifetime").
- Acting as the right person in a shared conversation, from the credential catalog (`src/core/orchestrator/credential-catalog.ts:60-140`):
  - Own credentials are usable in the actor's own personal scope. In a shared room they are usable only when Open posture applies to the live speaker (`openSpeakerKeychain`, `:75-76`), or for an automation the owner opted in (`:77-89`). `ownCredentialsAllowed` (`:90-91`) combines these.
  - Each use rechecks current membership and posture, and audits `keychain.open_speaker_use` (`:104-115`).
  - In any shared scope, a credential is placed `scratchOnly` (`:136-139`). Commands that use it run on a per-turn scratch computer that is destroyed at turn end, never on the room's shared computer (`src/core/orchestrator/sandboxes.ts:30,136-143,269-286`, SECURITY.md).
  - Other people's credentials need a `KeychainAsk` that the owner approves. This creates a `KeychainGrant` bound to an `audienceScopeId`, mode `once | standing`, with expiry and revocation (`src/credentials/keychain.ts:109-155`). Use checks that the grant's audience equals the conversation, then claims a once grant atomically (`:1022-1050`).
- Approvals: posture decides whether every tool call needs approval (`src/security/security-posture.ts:18-22`). Command policy adds admin rules for approval or denial (`src/policy/command-policy.ts`). Only the human who asked can approve. Bot-originated requests are refused rather than asked (`src/core/approval-requester.ts:7-26`). Approval grant modes are `once | session | always` (`src/types.ts:489-499`). Pending approvals expire (`src/core/approval-requester.ts:83`).
- Unattended work: crons, loops and webhooks run with the owner's authority, minus person-only steps such as approval prompts, registering webhooks and admin changes. A task text written by an automated turn runs without the owner's authority until the owner rewrites it (`docs/SPEC.md:29`, `src/cron/authority.ts`, `src/loops/authority.ts`).
- Audit: `AuditEvent{at, principalId, action, resource, scopeLabel, status, detail, impersonatedBy}` in Postgres (`src/audit/audit-log.ts:5-14`). Egress audit and credential-usage sinks are separate (`src/admin/postgres-egress-audit-sink.ts`, `src/admin/postgres-credential-usage-sink.ts`). Exact model requests are captured by default (SECURITY.md).
- Admin powers: org admins can read transcripts, memory, keychain metadata and more. Reads are audited but need no consent (SECURITY.md "Known limitations").

## Coordination of tasks and dependencies

There is no task board, claim table or dependency graph between agents. Coordination works at three layers.

1. Run queue (one turn per session, crash-safe):
   - Claim: `claim_runs` picks `pending` runs with no running or earlier pending sibling in the same session, using `FOR UPDATE SKIP LOCKED`. It sets `status='running'`, a fresh `lease_token`, `lease_expires_at`, `worker_id` and `attempts+1` (`src/runs/postgres-run-store.ts:37-60`).
   - Uniqueness: a partial unique index allows one running run per session (`:153`). Idempotent enqueue uses a unique `idempotency_key` (`:131`).
   - Heartbeat: the worker extends the lease every ttl/3 (`src/runs/worker.ts:86,107`, store `:328-331`). If the heartbeat fails, the worker stops (`src/runs/worker.ts:213`).
   - Recovery: a reaper under a leader lease `runs:reaper` requeues or parks expired runs (`src/runs/reaper.ts:8,33-46`). Hand-back and preemption counters exist (`postgres-run-store.ts:338`). Every write that ends a run is conditional on `lease_token`, which fences stale workers.
2. Swarm (pool of agents):
   - Data structure: one JSONB `Swarm` row with `members[]` (`state: reserved|ready|failed`, `control: paused|stopped`, `parentId`, `depth`, `sandboxId`, `forumSandboxId`, `attempts`), `messages[]` (per-swarm monotonic `seq`, `audience`, `replyTo`, optional `goal`, and per-recipient `notifications` state `pending|mailbox|queued|handed|failed` with `runId`), `spawnRequests` and `messageRequests` keyed by request signature (`src/swarms/swarm-store.ts:80-131`).
   - Fencing: every agent write runs in one transaction. It locks the caller's `runs` row `FOR UPDATE`, checks status `running`, the same attempt, the same lease token, an unexpired lease and the same actor, locks the session `FOR SHARE`, then locks and rewrites the swarm row (`src/swarms/swarm-store.ts:205-242`, `src/swarms/swarm-fence.ts:13-29`). A replaced attempt cannot act.
   - Duplicate-work avoidance covers requests, not tasks. `requestId` plus a content signature returns the original reservation or message, and reusing a key with different content fails (`src/swarms/swarm-service.ts:715-719,838-842`). Notification enqueue uses `dedupKey: swarm:<messageId>:<recipientId>` (`:489-496`). Nothing stops two workers doing the same piece of work. The docs say workers sharing the board computer "must coordinate concurrent writes themselves" (`docs/swarms.md`).
   - Shared workspace: a "board" computer per swarm. Each worker gets a blank private computer in the parent's scope. No files are copied.
   - Failure recovery: a durable outbox reconciles in two phases, resources then delivery, in batches of 16 with 4 concurrent, a 30 s phase deadline and a 10 s provision deadline (`src/swarms/swarm-store.ts:16-22`, `src/swarms/swarm-service.ts:515-678`). Provisioning gets 3 attempts (`:609`). Cleanup of failed workers stays pending and is retried. Failed reservations still consume the agent budget.
   - Controls: pause, resume and stop cascade down the member tree (`controlState`, `src/swarms/swarm-store.ts:146-157`).
   - Budgets: `agents` 32, `depth` 4, optional `messages`, `notifications`, `lifetimeMs`, `turnMs` (`docs/swarms.md` Defaults).
3. Goals, and deciding to ask for help:
   - A goal keeps a worker running until a periodic LLM "governor" returns `complete`, or until `token_cap` is spent (`src/agent/goal.ts:91-104`).
   - The governor can return `step_back` when the agent loops or claims to be blocked. It returns `pause` only after a previous `step_back` and only when the blocker needs something only the user can give, phrased as the question for the user. A `pause` without a previous `step_back` is downgraded (`src/agent/goal.ts:390-394,451-461`).
   - The agent cannot pause or abandon its own goal (`:308`). A worker treats the goal sender as its user and messages it for decisions. It can call goal `wait`, which stops the clock until a message arrives or 30 minutes pass (`GOAL_WAIT_MAX_MS`, `:106`).
   - Mid-turn messages are polled every 5 s at tool boundaries (`GOAL_INBOX_POLL_MS`, `:107`; `src/swarms/swarm-goal-inbox.ts`).

Subagents and peer sessions (`docs/persistent-subagent-sessions.md`): durable child sessions with a `session_mailbox`. Completion produces a deduplicated parent wake. Peer wakes between top-level conversations stop after eight in a row. Stable call IDs deduplicate retries.

## Collaboration between different human owners

Inside one deployment, yes, and this is the product's core. Several people share Slack channels, group DMs and projects. Each person's memory, keychain and files stay in their personal scope. Grants and Open posture are the only ways across, and the audience floor stops a resource from appearing in a room where anyone present lacks entitlement. In a shared room, the agent uses the live speaker's identity and credentials, on a scratch computer. People can also act inside the same swarm: humans in the swarm scope may pause or stop any worker, and agents may control only themselves and their descendants (`docs/swarms.md` Worker controls).

Across deployments, no. QM assumes a single organization (SECURITY.md Scope). External Slack workspaces (Slack Connect) are supported only as restricted audiences: a fresh namespace, no personal or org memory, and no keychain (`docs/external-slack.md`). Multi-tenant hosting (`src/tenants/`) separates organizations; it does not connect them. There is no transport, protocol or trust model for two separately owned QM installations to exchange tasks or messages. All collaboration is mediated by one shared server and one operator, who must be trusted by everyone (SECURITY.md: QM does not protect against a malicious operator; admins can read content).

## Verification and acceptance of outcomes

- Goals: an LLM governor judges completion from a work digest (`src/agent/goal.ts:411-461`). The agent cannot declare its own goal finished without that review.
- Loops: `evaluateSuccess` runs declared check commands first (any failure means continue, or park at the attempt cap), then asks an LLM judge (`src/loops/success-evaluation.ts:40-66`). Ship gates per declared ship action are `auto`, or `hold` until a human-created `ShipGrant` covers that action and policy version, and they "graduate" to standing grants (`src/loops/ship-gate.ts:18-41`). Loops have a governor that can quarantine, throttle or ping (`src/loops/governor.ts:16-30`).
- Swarms: no acceptance step. Results are messages and transcripts. The docs say live provider and model acceptance is "a separate deployment check" and "the agent-board UI is intentionally deferred" (`docs/swarms.md` Verification).
- No built-in concept of a verified branch or evidence bundle for coding work. The coding use case ("open PRs, monitor CI") relies on the agent using git and `gh` in its sandbox through the git broker.
- Deployment verification: `qm check --live` with a private live session canary is the release gate (`cli/templates/deployment/deployment.md`).

## Install to first useful result

As documented (not run):

1. Create an organization-owned private deployment repo and run `npm exec --package=@yc-software/qm@latest -- qm init . --org <slug> --target <aws|render|fly>` (Render also needs `--repo`/`--branch`), then `npm install` (`docs/getting-started.md`).
2. Hand the generated `.codex/skills/deploy-qm/` skill to a coding agent. It walks through the steps in `cli/templates/deployment/deployment.md` (277 lines): confirm the cloud account and billing; choose sign-in (built-in email broker needs a verified sender plus a Resend or SMTP key, or Slack, or OIDC); choose a model provider key; choose a sandbox provider and its account and keys; optionally connectors and a Slack app (bot and app tokens, generated manifest); then `qm check`, `qm plan`, `qm up`, `qm check --live`.
3. Prerequisites: a cloud account (AWS, Render, Fly or Porter/Kubernetes), managed Postgres, a sandbox provider account (Modal, E2B, etc.) with an image or template build, object storage for snapshots on some backends, five signing and encryption secrets (`CORE_SIGNING_SECRET`, `CAPABILITY_SECRET`, `PORTAL_IDENTITY_SECRET`, `CONNECTOR_SECRET_KEY`, `SKILL_SIGNING_SECRET` in `.env.example`), an email sender or Slack, and a model key. `src/config.ts` alone reads at least 121 distinct env var names.
4. Alternatives: third-party one-click marketplaces (README), or the Docker target for a local test drive ("never present it as the recommended path", deployment.md).

Ongoing administration for a small team: first admin grant; choose security posture (Auto default), sharing posture (Isolated default) and screening mode; optional command-policy rules (none ship); model allowlist and budgets (`BUDGET_USD_PER_WINDOW=25`, `ORG_BUDGET_USD_PER_WINDOW=100` defaults); directory sync and principal-link fixes for people with several sign-ins; connector OAuth apps; egress proxy so sandboxes are not fail-open; snapshot buckets and retention; staged rollouts for some protocol switches (`docs/capability-tokens.md`); upgrading by bumping the pinned package. The defaults are reasonable. The operator, though, is still running a distributed system with Postgres, workers, a sandbox fleet and secrets.

## For Botbench

### Learn

- A scope model that follows the conversation (DM = personal, room = shared) plus explicit grants is easy to explain to users, and it maps cleanly onto Botbench Peers (my workbench = personal, a shared issue or room = shared).
- The audience floor is the decisive rule for multi-party contexts: a resource enters a conversation only if every participant could see it anyway. This is stronger than "the requester can see it".
- "The agent acts as the person whose turn it is", plus "decisions that authorize future agent behaviour must come from outside the agent" (admin grants, impersonation, approvals; SECURITY.md). That principle fits Botbench's permission broker directly.
- Credentials named in a shared context run on a throwaway scratch computer, never the shared workspace. This is a concrete answer to "my token must not linger where your agent can read it".
- Leases fenced into every state write (run lease token checked inside the same transaction as the swarm write) are what make crash recovery safe.
- QM dropped harness pluralism to stay thin. Botbench's whole premise is pluralism over CLIs the owner already has. QM's experience suggests keeping the adapter contract narrow.

### Reuse conceptually (with source references)

All MIT. Reuse with attribution if code is copied; concepts are free to adapt.

1. Audience-floor grant filter: `src/acl/acl-store.ts:24-28` (`audienceReaches`), with entitlement at `src/resolution/context-filter.ts:15-20`. Botbench can use it when a peer's issue or room has several owners: show a shared artifact only if every participant's workbench is entitled.
2. Fail-closed posture composition: `src/resolution/sharing-posture.ts:10-19` and the posture ranks at `src/security/security-posture.ts:31-35`. Narrower scopes can only tighten. A peer-level policy should compose the same way with each owner's local floor.
3. Scoped credential grants with once/standing mode, owner approval via asks, and an atomic once-claim bound to the audience: `src/credentials/keychain.ts:109-155,1022-1050`. This suits "lend my credential to this one cross-peer task".
4. Brokered credentials that never enter the sandbox: `src/api/credential-broker.ts:120-169`, `src/api/git-http-broker.ts`. Botbench could broker GitHub pushes for worktree agents the same way.
5. Scratch-only placement of credentials in shared contexts: `src/core/orchestrator/credential-catalog.ts:136-139`, `src/core/orchestrator/sandboxes.ts:269-286`.
6. Lease-fenced queue claims: `src/runs/postgres-run-store.ts:37-60,153,328-347` and `src/swarms/swarm-store.ts:205-242`. SQLite can express the same lease-token-conditional updates for Botbench task claims.
7. Idempotent requests with a content signature (same key and payload returns the original, same key with different payload fails): `src/swarms/swarm-service.ts:715-719`. Botbench needs this for retried peer messages.
8. Governor with `step_back` before `pause`, and the agent cannot pause itself: `src/agent/goal.ts:390-394,451-461`. A disciplined rule for when an agent may interrupt a human.
9. Notification states `pending | mailbox | queued | handed | failed`, with `wake:false` mailbox delivery: `src/swarms/swarm-store.ts:110`, `docs/swarms.md`. A good vocabulary for ADR 0004's workbench-to-workbench messages.
10. Ship gates that graduate from hold to standing grant per action and policy version: `src/loops/ship-gate.ts:18-41`.

### Improve on

- No cross-installation collaboration. Every collaborator must sit in one operator's server and trust that operator and its admins with content (SECURITY.md). Botbench's peer-to-peer model between separately owned workbenches addresses exactly the case QM excludes.
- No task-level duplicate-work avoidance in swarms. Idempotency covers requests and notifications only, and workers "coordinate concurrent writes themselves" on the board (`docs/swarms.md`). Botbench's explicit claims on issues are a real advantage. A claim with a lease, a heartbeat and a dependency field would beat QM here.
- No outcome evidence for coding work. Completion is an LLM governor or judge. Botbench's verified branch with evidence is stronger and more checkable.
- No external CLI adapters and no use of a person's installed Claude Code or Codex. QM calls models with subscription tokens inside its own Pi loop (`src/model/claude-subscription.ts:1`), which differs from driving the CLI the owner already runs.
- Heavy operations: Postgres, a sandbox provider, five secrets, 121 or more env vars, about ten sandbox backends with documented drift (`docs/SPEC.md:117-122`). A local one-process tool can win on time to first result.
- The swarm is a single JSONB row holding every message (`src/swarms/swarm-store.ts:113-131`), rewritten under a row lock on each write. That will contend under the "millions of agents" ambition in SPEC. Botbench should store messages as rows.
- Self-acknowledged weak spots (SECURITY.md): command policy is bypassable; credentials are plaintext in the sandbox; admins read content without consent; capability links and the spend token are bearer.

### Deliberately avoid

- Making sandbox computers durable homes across about ten providers. The project's own "Provider drift" and "Config-matrix expansion" lists (`docs/SPEC.md:102-122`) show the cost. Botbench's git worktree is the durable unit.
- Model-discretion disclosure in Open posture. QM admits server checks cannot stop the model repeating private data into a shared reply (SECURITY.md). Cross-peer sharing in Botbench should move artifacts deliberately, not load private memory into shared prompts.
- Org-admin content-read powers as a default. They do not fit a peer model where no one is above the owners.
- Removing harness choice. That suits QM's thin-harness goal but would contradict Botbench's premise.

## Capability ratings

1. byo-agent-clis: Absent; Pi is the only harness, the harness-choice table was dropped, and BYO covers model subscriptions, not CLIs.
2. model-providers: Implemented; Anthropic, OpenAI, OpenRouter, custom providers and gateway discovery via Pi, plus per-user API key or subscription login.
3. tools-connectors: Implemented; MCP client, OAuth connectors, Composio, Gmail, credential and git brokers.
4. isolation: Implemented; durable per-scope cloud sandboxes on about ten providers, scratch computers per turn, egress proxy (fail-open when unset).
5. approvals: Implemented; posture-driven tool approvals, admin command rules, requester-only human approval, bot requests refused.
6. memory-scoping: Implemented; per-scope memory with an audience-entitlement disclosure check and a fail-closed Open/Isolated posture.
7. identity-authz: Implemented; principals with linked sign-ins, scoped grants, audience-bound capability tokens, tenant row security (tenant-token migration Partial).
8. task-coordination: Partial; lease-fenced run queue and idempotent swarm requests, but no task claiming or dependency graph between agents.
9. cross-owner: Partial; strong for many people inside one deployment, absent between separately owned installations.
10. peer-transport: Absent; no protocol between QM deployments; Slack Connect gives only a restricted guest audience.
11. verification: Partial; LLM governor and judge plus command checks for loops, ship gates; no evidence bundle for code work.
12. durability: Implemented; Postgres item log, leased runs with reaper, durable outboxes, sandbox snapshot recovery.
13. budgets-usage: Implemented; per-person and org USD windows, spend views, swarm budgets.
14. audit-observability: Implemented; Postgres audit log, egress and credential-usage sinks, error log, model request capture.
15. remote-mobile: Implemented; Slack, web, Electron desktop and a native iOS client against the hosted server.
16. time-to-first-result: High effort; needs a cloud account, Postgres, a sandbox provider, model keys, secrets and an email sender or Slack app, though an agent-guided `qm init` skill and a local Docker test target soften it.

## Open questions

- How often does the Open posture actually leak private memory into shared replies in practice, and does the audit trail make that detectable?
- How the single-row swarm (all messages in one JSONB document) behaves at the default 32 agents with chatty workers: lock waits, row size, transaction timeouts (`lock_timeout 10s`, `statement_timeout 15s`).
- Whether swarm workers duplicate work in practice without a claim mechanism, and how well the governor's `step_back`/`pause` discipline holds up.
- Real cold-start and restore times per sandbox backend, and how often hydration refuses and needs an operator restart.
- Whether per-user Claude subscription tokens used through Pi stay usable under provider policy over time.
- The real administrative load for a 5 to 10 person team after the first deploy: upgrades, connector re-consent, principal-link fixes.
