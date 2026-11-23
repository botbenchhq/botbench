# Reusable architectural patterns

Each pattern names the problem, who solved it, where the code is, and what it means for Botbench. Paths are inside the project's repository (local clone under `reference/` beside the Botbench checkout). Source read only; nothing was run. Adapt the approach in Botbench's own terms and credit it in the pull request. Agor is under the Business Source License: take the idea, never the code.

Nineteen references from across the library were re-opened and checked against the clones and Botbench's source after the research; all nineteen matched. The rest are as the researchers cited them.

## 1. Agent adapters

| Pattern | Source | For Botbench |
|---|---|---|
| **One protocol for many CLIs.** Tutti, OpenHands and Agenta all reach most agents through the Agent Client Protocol (ACP). Agenta and OpenHands drive Claude Code and Codex through it too; Tutti hand-writes those two. | Tutti provider registry (see [tutti.md](projects/tutti.md)); OpenHands `src/api/agent-server-adapter.ts:534-546` | The cheapest route to more agents is one ACP driver, not a driver per vendor. It must pass Botbench's own test first: can the driver route every permission request through the broker? The OpenHands repository read here shows no handling of ACP agents' permission requests (its SDK, which starts the agents, was not read), so this is unproven. |
| **Never switch a subscription to metered billing.** Delete an inherited API key before launch; load only project settings; turn off tools that outlive the turn. | OpenMausBot `server/drivers/claude.ts:114-135,1053-1062,1185` | Confirms Botbench's launch isolation. Nothing to change. |
| **A backend is a value.** Execution sits behind one API; a backend is `{host, key, kind}`, and the kind of workspace is a parameter of the start request. | OpenHands `src/api/backend-registry/types.ts:4-22`, `src/api/agent-server-adapter.ts:813-838` | The shape for #72: make "where it runs" a parameter of starting a task before adding a second place to run. |

**Do not copy:** OpenMausBot's own OAuth client for the ChatGPT plan (`server/drivers/chatgpt-plan-auth.ts:285-370`), Tutti's call to Anthropic's usage endpoint with the stored sign-in token, and Paperclip linking the user's Codex `auth.json` into its own folders (`codex-home.ts:13`). All three touch credentials Botbench never reads.

## 2. Sandbox environments

| Pattern | Source | For Botbench |
|---|---|---|
| **Credentials stay outside; a host proxy adds them.** The process inside gets a token bound to the task and an expiry; the proxy strips any credential the caller sent and sets its own for a fixed upstream. | OpenMausBot `server/bot-box/broker.ts:1-30`; Agent Mesh (`google/agentmesh`) `internal/node/egress.go:231-238`; E2B `spec/openapi.yml:747-757` | This is ADR 0002 decision 5 and #72's "no credentials mounted", solved three times the same way. |
| **Outbound rules by host that can change while it runs;** "no network" is a deny-all rule. | E2B `spec/openapi.yml:706-731,803` | Matches `allowedHosts`. Keep the same model inside a container. |
| **A lifetime with a stated end:** a timeout, a choice of stop or pause when it expires, reset on each extension. | E2B `spec/openapi.yml:893-920` | A backstop for cleaning up containers a crashed task left behind. |
| **Refuse rather than hand over a blank machine** when restoring a saved environment fails. | QM `docs/sandbox-preservation.md` | The right failure for any future saved environment. |
| **Say so when a policy cannot be enforced.** A network rule on a backend that cannot apply it is an error, not a silent pass. | Agenta `services/runner/src/engines/sandbox_agent/run-plan.ts:60-67` | Botbench's rule that isolation claims are stated exactly, as code. |

## 3. Memory scopes

| Pattern | Source | For Botbench |
|---|---|---|
| **The audience floor.** Something enters a shared conversation only if every participant could already see it. | QM `src/acl/acl-store.ts:24-28`, `src/memory/disclosure.ts:22-60` | The rule to adopt the day any Botbench memory or note can reach a peer. One function, easy to test. |
| **A personal credential used in a shared place runs on a throwaway machine** destroyed at the end of the turn. | QM `src/core/orchestrator/credential-catalog.ts:136-139` | Not needed while each developer runs on their own Mac; needed if a shared environment ever exists. |
| **One learning per commit, with its sources listed,** and "Sources: unknown" instead of an invented source. | Letta Code `src/skills/builtin/managing-shared-memory/SKILL.md:84-101` | Fits ADR 0005: a learning that cannot name where it came from is marked so. |
| **A memory writer limited by the filesystem, not by a prompt:** only its own copy is writable, on its own branch, with named end states. | Letta Code `src/agent/memory-worktree.ts:124-200,359-655` | The way to let an agent propose memory changes without trusting it. |
| **Save a fact only if it quotes the person's own words.** | OpenMausBot ("dreams", see [openmausbot.md](projects/openmausbot.md)) | Agrees with ADR 0005 and 0006. Letta Code does the opposite and learns from any transcript. |
| **Show what sharing will expose before it happens:** which connections use the agent's account, which use each person's, which private drives become shared. | Agenta `api/oss/src/core/sharing/disclosure.py:28-59` | The pairing screen for Peers should state what a peer will and will not be able to reach. |

## 4. Peer networking

| Pattern | Source | For Botbench |
|---|---|---|
| **A pairing code becomes a per-device token;** re-pairing reuses it; deleting the device revokes it. | OpenAgents `workspace/backend/app/routers/nodes.py:236-310` | Botbench already pairs devices with a one-time code (#138). The same shape extends to pairing a workbench. |
| **A key per installation, signed requests, a nonce table and a 60-second window** against replay. Built on `node:crypto` only. | Open Agent Bridge (see [open-agent-bridge.md](projects/open-agent-bridge.md)) | Confirms ADR 0004's Ed25519 choice needs no dependency. ADR 0004 does not yet cover a replayed acknowledgement or refusal; this does. |
| **Safe retries.** A key per sender and operation plus a digest of the payload: the same payload returns the stored answer, a different one is a conflict, a retired key says gone. | Open Agent Bridge `src/lib/messaging.ts:7-30`, `db/001-bridge.sql:62-65`; QM `src/swarms/swarm-service.ts:715-719` | The concrete form of ADR 0004's "same id and same bytes" rule. |
| **A wake-up that carries nothing.** The signal says only "something is waiting"; the content is fetched on the normal path where every access check already runs. | OpenAgents `packages/agent-connector/src/workspace-client.js:350-446`; Open Agent Bridge `scripts/bridge-client.mjs:127-131` | Same principle as Botbench's push notices. Apply it to peer messages. |
| **A note on every line an agent reads, written only by the system:** who it is from, what it is, and one of three authorities (own request, on their behalf, information only). Imitations in the text are escaped. | OpenMausBot `server/provenance-label.ts:1-19,29-37`, `server/peer-provenance.ts:170` | The best single pattern for Peers. A message from another workbench is always "information only". |
| **Message and task shapes from A2A:** creator-set message id, context id, parts, nine task states; a finished task never restarts. | A2A `specification/a2a.proto:187-208,260-277` | Use these field names in ADR 0004's messages so another vendor's agent could interoperate later. Botbench's extra fields go under one extension. |
| **"A request for authorization is never itself a grant."** | A2A `docs/specification.md:1945` | ADR 0004 decision 8, stated by the standard. |

**The counter-example to keep in mind:** in Open Agent Bridge a peer's message becomes an unattended Codex turn with full access (`src/lib/agent-kit.ts:32`, `scripts/quiet-session.mjs:49`). That is the outcome ADR 0004's "an incoming message is only a card for the owner" exists to prevent.

## 5. Shared work graphs

| Pattern | Source | For Botbench |
|---|---|---|
| **A dependency is satisfied only when the earlier task is completed and accepted by the user.** | Tutti `packages/workspace/issues/normalize.go:207-225` | The rule for Botbench's deferred task dependencies: a later task builds on accepted work, not on finished work. Across workbenches, "accepted" becomes "merged". |
| **One relation, `blocks`, with cycles refused** by an error that names the existing chain. | Paperclip (see [paperclip.md](projects/paperclip.md)) | Enough of a graph. Do not model more. |
| **Wake once per ready state.** The wake key is a hash of the blockers and when the issue became blocked, so a cleared blocker wakes the waiting work exactly once. | Paperclip `server/src/services/issue-dependency-wakeups.ts:56-120` | Applies to "your teammate's pull request merged, your waiting task can start". |
| **Hand-off record:** purpose, revision, next action, acceptance checks; outcomes appended only by the receiver. | Open Agent Bridge `src/lib/workflow-reports.ts:6-17` | A template for a hand-off between workbenches that stays checkable. |
| **Who asked is kept apart from whose agent ran it.** | Tutti `packages/agent/activity-replication/types.go:166-200` (a contract in the open code; the implementation is closed); Agor `apps/agor-daemon/src/utils/branch-authorization.ts:316-340` | The "second kind of principal" that `peers-concept.md` says Botbench needs in its log and approvals. |

## 6. Durable tasks

| Pattern | Source | For Botbench |
|---|---|---|
| **A claim belongs to a run, not to an agent,** and is taken in one conditional update. Takeover order: free, then the same run, then a holder whose run is dead. | Paperclip `packages/db/src/schema/issues.ts:54-59`, `server/src/services/issues.ts:12837-13132` | Botbench's claim is a branch the remote refuses twice, which is stronger across machines. Botbench already lets an owner take over an old claim after a confirm (`src/engine/claims.ts`, credited to Paperclip). What it lacks is a claim that lapses by itself. |
| **A lease with a token and a heartbeat;** every write checks the lease is still held; a reaper returns expired work. | QM `src/runs/postgres-run-store.ts:37-60,153,328`; Open Agent Bridge `src/lib/tasks.ts:43-133` | The mechanism for a claim that renews while its run is alive and lapses when it is not. |
| **"Needs reconciliation":** work whose holder vanished cannot be re-taken until someone confirms the local operation stopped. | Open Agent Bridge `src/lib/tasks.ts:43-133` | The honest state for a claim whose workbench went silent. |
| **Record each finished step and, after a restart, run only the unfinished ones.** | LangGraph `pregel/_runner.py:613-623`, `pregel/_loop.py:853-866` | Botbench re-runs every setup and check command after a restart (`src/engine/task.ts:1305-1307`) although each already has its own row. |
| **A stable id for every point that waits on a person,** and an invalid answer is never consumed. | LangGraph `types.py:1011-1012,1046-1056` | Botbench matches approvals by request fields (`src/approvals/broker.ts:69-75`). A stable id matters once an answer can concern another workbench. |
| **Merge new messages into one deferred wake** while a run is active, instead of starting a second run. | Paperclip `server/src/services/heartbeat/queue.ts:4691-4710` | For peer messages that arrive mid-task. |

## 7. Authorization

| Pattern | Source | For Botbench |
|---|---|---|
| **A remembered grant includes a hash of the tool's configuration,** so changing the tool voids it; outbound and device-control tools are never remembered. | OpenMausBot `server/provider-tool-allow.ts:33-43` | A tightening for "Always allow". |
| **The server sets who approved,** and binds each decision to its session, task and request. | Agor `apps/agor-daemon/src/permissions/deliver-permission-decision.ts:25-106` (idea only) | Needed when more than one person can answer. |
| **Narrowing by intersection.** A task token can only reduce what its holder may do; the earliest expiry wins; an empty rule denies everything. | Agent Mesh `api/tar.go:491`, `internal/identity/authorize.go:94` | The principle for any future "do this one thing on my behalf". Not the library. |
| **A gate that treats every fault as "ask"** and adds a fact the runner lacks: did a person send this turn? | Agenta `api/oss/src/core/tools/gate.py:1-10` | Agrees with "broker failure = deny". The "did a person send this" fact is the taint rule Peers requires. |

## 8. Keeping the main branch whole

| Pattern | Source | For Botbench |
|---|---|---|
| **A broken-main gate as a pure state machine:** the person whose merge broke it is told first, the team after 15 minutes, and it lifts after 60. | Agensh `agensh/quality.py:18-26,116-162` | When several workbenches open pull requests against one repository, a broken default branch should hold fully autonomous acceptance on all of them. |
| **Claim-to-assignee sync that never removes an assignee a person set.** | Agensh `agensh/backlog.py:26-47` | A way to make a claim visible in GitHub's own screens. It is a new write to GitHub, so it is the owner's decision. |

**Not transferable from Agensh:** its claims are free text, never exclusive, and no code detects two claims on the same work (`board-service/shared_lessons.py:333-341`). That works inside one operator's swarm with a CI gate behind it. It would not work between developers.
