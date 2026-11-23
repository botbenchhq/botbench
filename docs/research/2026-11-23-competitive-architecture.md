# Competitive architecture and product research

Date: 2026-11-23. This is a research audit, so no code was changed. The 16 projects come from the owner's competitive intelligence review (November 2026). Botbench was read at `0dcc133`.

The question every section serves: **can Botbench help independently operated agent teams accomplish more together, with less human coordination, without giving up control?**

## How this was done, and what it cannot claim

- **Nothing was run.** No competitor was installed or used, so no row below is at the Run level (see `README.md` in this folder). The five experiments in section 4 are how claims reach that level.
- **Nothing was cloned.** The task's sandbox refuses `github.com` from the shell. Files were read through a web fetch of `raw.githubusercontent.com` and `github.com` at each default branch's head on 2026-11-23. That fetch passes each page through a summarising model. Quotes are close to the source but may not be verbatim, and no commit is pinned. Before any claim drives a decision, re-read the named file at a pinned commit.
- **Paperclip and OpenMausBot** were not re-read. Their rows come from this repository's earlier reviews, which read source at pinned commits (`docs/reviews/design-vs-paperclip.md`, `docs/reviews/design-vs-openmausbot.md`).
- **Name collisions.** The project names resolved as follows. OpenAgents is `openagents-org/openagents`, not the COLM 2024 research platform or `darrenhinde/OpenAgents`. Tutti is `tutti-os/tutti`, not `nutthouse/tutti` or `ventura8/Tutti`. Open Agent Bridge is `munboon/open-agent-bridge`, not the single-machine `kevinArgueta96/open-agent-bridge` family or `xx025/openab`. Agenta is `agenta-ai/agenta`. QM is `yc-software/qm`. Agensh is `microsoft/Agensh`. Agent Mesh is `google/agentmesh` (formerly `google/sam`).

## Summary

1. **Every named project exists. The combined workbench-plus-team product is already being built**, by OpenAgents, Tutti and QM in particular. Each of the following ships somewhere else, so none of them is a differentiator: multi-vendor agents, worktrees, approvals, shared threads, per-person scopes, agent-to-agent messages, signed peer identity, and durable handoffs.
2. **Every collaboration product read here runs a shared server.** That includes OpenAgents' hosted endpoint, Tutti's cloud Room, QM's team deployment, Open Agent Bridge's bridge, Agent Mesh's control plane and Paperclip's company database. Botbench's Peers design is direct and serverless (ADR 0004). That is a real difference, but it is also a cost: it has no presence, no shared board and no relay. Whether customers value it is exactly what experiment E1 tests.
3. **Unattended execution elsewhere mostly means "permissions off".** OpenAgents' Claude adapter passes `--dangerously-skip-permissions` in execute mode and has no approval relay. Open Agent Bridge's Codex kits ask for full filesystem access without prompts. Docker Sandboxes' product page says Claude runs with permission prompts skipped by default. OpenHands' default local runtime has full filesystem access. QM and Paperclip do have real approval gates. In a run, Botbench keeps its broker and safety floor while confining commands. That is defensible, but only as "safer at equal capability", and experiment E5 has to show it.
4. **No project read here runs two owners' changes together to show they fit.** Open Agent Bridge says outright that "the bridge records the recipient's evidence; it does not independently verify execution". Tutti has a read-only goal reviewer, but it gives a model's verdict on a goal inside one workspace, not a run of two owners' changes together. Botbench's P4 combined check (`src/engine/combined.ts`) is the closest thing to a moat found. That rests on "not found in what was read": it is not proof that nobody else has it.
5. **Agensh is a warning about the wrong metric.** By its README's own numbers, one agent on the newer model (56.19% on Pandoc) beat 1,024 agents on the older model (55.06%). Agent count is not the outcome. Verified, integrated delivery is.
6. **No finding requires reopening ADR 0004 (Peers P5).** Two additions are worth considering before P5 is built: handoff outcome states (Open Agent Bridge) and stricter idempotency on agent-initiated sends (QM). See section 2.

## Tier 1 studies

Each study is ordered as: promise, what was read, how agents connect, scopes and identity, coordination, verification, onboarding, and then learn / improve / avoid.

### OpenAgents (`openagents-org/openagents`). The highest-overlap direct competitor

- **Promise (Docs):** "One workspace where all your AI agents collaborate. Open source." The target user runs agents on several machines or tools, often with teammates. Apache-2.0, about 4.4k stars, 4,268 commits on `develop`.
- **Connecting agents (Source):** A local Node daemon, `packages/agent-connector/`, carries one adapter per CLI, and the README lists 26 agents. Some adapters are bespoke (`src/adapters/claude.js`, `codex.js`, `gemini.js`). Others go through ACP (`src/adapters/acp-client.js`).
  - The Claude adapter spawns `claude -p … --output-format stream-json`, then keeps the process alive with `--input-format stream-json` and resumes sessions with `--resume`.
  - It disallows `CronCreate`, `CronDelete`, `CronList` and `ScheduleWakeup`, the same rule Botbench has for tools that outlive a turn.
  - Execute mode adds `--dangerously-skip-permissions`. Plan mode adds `--permission-mode plan`. The adapter has no approval relay.
  - It keeps `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_API_KEY` in the child environment, and the README tells users to run `agn env <type> --set LLM_API_KEY=…`.
  - There is no sandbox beyond permission modes, and the README says the working directory "is not a hard sandbox".
- **Transport (Source):** `src/adapters/base.js` defaults to the hosted endpoint `https://workspace-endpoint.openagents.org`.
  - It authenticates with a bearer workspace token and an `X-Agent-Name` header.
  - It polls adaptively (2 s, 5 s, up to 15 s) with a cursor saved under `~/.openagents/cursors/`. A wake-up stream only says "poll now".
  - Replies go through a durable `ResponseOutbox`, and a capped set drops duplicate messages.
  - `docs/projects/agent_workspace.md` records the transport choice: WebSocket was rejected as fragile.
- **Scopes and identity (Docs):**
  - A workspace token is the bearer secret, and "the full URL with the token grants control".
  - Roles are Creator, Master (one per workspace, coordinates) and Member.
  - The v1.1 README says devices and agents "belong to the person who connected them". Sharing is per agent and per teammate, and adding someone to a thread does not share every agent in it.
  - Anonymous workspaces are deleted after 30 days idle.
- **Coordination (Docs):** @mentions, role routing to a "doer and a reviewer", Issues with owners, and approval cards. These are described in the README, but the approval code path was not found in the adapters read.
- **Verification:** Not found. People review through approval cards and Issues.
- **Onboarding (Docs):** One install script, then `agn create`, `agn connect <name> <token>`, `agn up`. The README claims "under a minute".
- **Learn:**
  - Their ownership model (an agent belongs to whoever connected it, and is shared per teammate) is a clean answer to "who may use my agent".
  - A cursor-plus-outbox polling design survives laptops sleeping.
  - Skipping events that already happened on a fresh join avoids replaying history into an agent.
- **Improve on:** Approvals that actually stop a tool call, confinement, and a branch with evidence at the end.
- **Avoid:**
  - A hosted endpoint as the default.
  - API keys set through the product.
  - Skip-permissions as the way to run unattended.

### Tutti (`tutti-os/tutti`). The closest to the combined concept

- **Promise (Docs):** "A real-time shared workspace for your agents… not a replacement for your coding agent". It removes re-pasting context between agents. Apache-2.0, about 3.9k stars, 5,362 commits. There are two editions:
  - **Tutti (local)** is open source, and its agents and state stay local.
  - **Tutti · VM** is early access. It runs each agent "on your own machine inside a managed local VM" with working state in a cloud Room, and nothing read shows it is open source.
- **Architecture (Source):**
  - A Go daemon, `services/tuttid/`, with an SQLite store (`packages/agent/store-sqlite`) and an agent runtime controller (`packages/agent/daemon/runtime`).
  - `agent_runtime_adapter.go` passes `PermissionModeID`, `PlanMode`, MCP servers and an `Env` through to the runtime, and relays interactive requests (`SubmitInteractive`).
  - The per-CLI launch code was not read.
- **Verification (Source):** `tutti_mode_goal_review_agent_adapter.go` starts a hidden reviewer session in `"read-only"` permission mode with `StrictPermissionMode: true`.
  - Its only tool is shell, and its only write capability is `tutti-goal-review.goal-review.verdict`. The adapter refuses any launch whose capability scope is anything else.
  - Pass or fail criteria were not in the file read.
- **Replay (Source, from `CONTEXT.md`):** "Agent Session Recording" yields an immutable "Cassette" (state, stimuli, provider tape, blobs) that replays in an isolated surface. This is the same idea as Botbench's one approved exception: replaying a captured real session.
- **Collaboration (Docs):**
  - Rooms are the sharing boundary: "only what's created inside the same room is shared".
  - You can borrow a teammate's agent, and the use-case page frames that as delegation that the granter can revoke.
  - A Control Center lists every pending approval.
  - Rooms sync through a hosted cloud.
- **Onboarding (Docs):** "Fully GUI-based, no terminal". Creating a Room needs an invite code.
- **Learn:**
  - Give a verdict-only reviewer exactly one write capability, enforced by the launcher. Botbench's reviewer is read-only, but it does not yet have a typed verdict channel of its own.
  - Borrowing an agent as revocable delegation, never as account sharing.
  - A single place for every approval waiting across rooms.
- **Improve on:**
  - Shared state that never leaves the owners' machines.
  - A verdict backed by checks that ran, not only by a model's reading.
- **Avoid:** A cloud Room as the only way to collaborate.

### Paperclip (`paperclipai/paperclip`). The best organisational orchestration reference

Fully covered in `docs/reviews/design-vs-paperclip.md` (Source, `e08705f`). Points relevant here:

- **Learn, already taken:**
  - Atomic issue checkout with a conflict on a second claim, which became P3 claims.
  - Durable, idempotent case handoffs, which became P5 storage in ADR 0004.
  - Send and receive interaction permissions, and a per-run cap, which became ADR 0004 items 11 and 12.
- **Learn, still open:** A required review that only a person may remove. Budget policies with a warning, then a hard stop.
- **Avoid:**
  - A mandatory company hierarchy (`reportsTo`, a goal tree from company down to task) for a developer or a team of 2 to 10.
  - One shared server for every agent and approval.

### OpenMausBot (`milind-soni/OpenMausBot`). The best personal workbench reference

Fully covered in `docs/reviews/design-vs-openmausbot.md` (Source, `3aec210`). Nothing under `enterprise/` was opened, then or now.

- **Learn, already taken:** Pairing codes, adopted in `src/api/pairing.ts`.
- **Learn, still open:**
  - Steering a running turn: a queued message is written into the turn.
  - A quiet-turn activity window.
  - Recording when a usage limit resets (see `src/engine/silence.ts` and `src/engine/usage-limit.ts` for what has landed since).
  - Any ACP agent added from config without code.
- **Avoid:**
  - Full access by default.
  - Working in the person's own folder.
  - Drifting into a general-purpose chat application.

### QM (`yc-software/qm`). The best ownership and scope reference

- **Promise (Docs):** "A multiplayer agent harness for teams. In Slack and on the web." It is self-hosted in your own cloud ("your own models and keys") on AWS, Render or Fly, with Postgres. MIT, about 15.8k stars.
  - The agent loop is built on Pi (`vendor/pi-ai`). A third-party article says QM can also run OpenCode, Codex or Claude Code, but the README only cites them as a security model. Treat that as unverified.
- **Scopes (Docs):**
  - Every person and every room has its own memory (a markdown notebook, which can be routed to external providers), files, keychain view, permissions, crons, web apps and durable sandbox.
  - Sharing defaults to Isolated. The Open setting lets a shared room read the speaker's opted-in files and memory "during a live authenticated human turn", labelled and audited.
- **Identity (Docs, `docs/principal-links.md`):**
  - One person can have several sign-ins (Slack, email, OIDC), folded to one canonical principal by `personKey` and `samePerson`.
  - Links are flat, never create admins, and never involve bots.
  - The rule: "Email similarity is not proof of identity."
- **Swarms (Docs, `docs/swarms.md`):**
  - Workers are ordinary sessions, each on its own blank computer. "No parent files are copied."
  - Spawning and sending need a `requestId`. The same payload returns the original result, and the same key with different content fails.
  - Limits default to 32 agents and depth 4, and failed reservations still count against the budget.
  - Workers "never inherit the root session's command or security-screen approval grants". Agents can control only themselves and their descendants.
  - No task-claiming mechanism is described: work arrives by spawn text, messages and goals.
- **Security posture (Docs, `SECURITY.md`):** Unusually candid. "Classifier approval is not authorization." Command policy is "a speed bump… not a sandbox boundary". Sandbox credentials are plaintext in use. Browser actions bypass some gates.
- **Learn:**
  - Writing isolation claims exactly. Botbench's rule says the same, and QM's document is a good model for `docs/security/threat-model.md`.
  - Requiring a request id on every agent-initiated send.
  - Spawned work never inheriting approvals.
  - Treating a wrong identity link as an incident, not a row to delete.
- **Improve on:**
  - Credentials never entering the agent's environment at all (ADR 0002), where QM puts them in the sandbox.
  - Personal subscriptions through the vendor's own CLI.
- **Avoid:**
  - A team cloud deployment as the entry point.
  - Operator and admin reads of personal content.

### Open Agent Bridge (`munboon/open-agent-bridge`). The closest networking reference

- **Scale:** A small project, with 70 commits and 0 stars on 2026-11-23. Its design is still the closest to ADR 0004. Apache-2.0. Next.js, PostgreSQL 18, Node 24.
- **Promise (Docs):** "A self-hosted coordination service for independently running AI agents." It carries messages, tasks, context and files between agents that keep their own runtimes, models and tools.
- **Identity and pairing (Docs):**
  - Enrollment uses a single-use code and a key pair generated locally, and the private key stays on the agent's machine.
  - Requests are signed, and invalid signatures and replays are rejected.
  - Administrators enable or disable each agent-to-agent link per project.
  - "Being allowed to communicate does not grant access to a peer's tools or environment."
- **What it does not do (Docs):** It does not run models, hold provider credentials, start stopped agents, or run remote commands. "Receiving a message grants nothing extra." The operator can read ordinary messages, which are not end-to-end encrypted.
- **Handoffs (Docs, `docs/WORKFLOW.md`):**
  - The recipient reports `accepted`, `validated`, `applied`, `completed`, `blocked` or `failed`. Three of those need an integrity receipt.
  - Outcomes are append-only, at most 200 per package, and each one notifies the sender.
  - Activity reports go stale after 30 minutes, and heartbeats do not refresh them.
  - Retries reuse the saved payload and idempotency key.
- **Self-reported gaps (Docs):**
  - The signed enrollment path has integration tests but no independent pilot.
  - Revoking access does not stop a command already running.
- **Learn:**
  - A handoff outcome vocabulary that separates "received" from "applied" from "done", with receipts.
  - Staleness that heartbeats cannot hide.
  - The same "communication is not permission" rule as Botbench's.
- **Improve on:**
  - No bridge operator who can read messages.
  - Owner approval of what leaves.
  - A check that ran, instead of self-reported outcomes.
- **Avoid:** Kits that need full access without prompts.

## Tier 2 and Tier 3, briefly

All rows are at the Docs level unless they say otherwise.

| Project | What it is | Relevant to Botbench | Verdict |
|---|---|---|---|
| Microsoft Agensh (`microsoft/Agensh`, MIT, paper arXiv 2609.26781) | A research harness with no orchestrator: workers gather context, claim a sub-task, act, verify, merge. Gitea is the workspace and Mattermost the message layer. It drives Copilot, Pi, Codex or Claude Code (`--agent-harness`). | Claims written into shared context before acting, which is the same idea as P3. Its numbers say a model upgrade beat the whole fleet. | Study the claim and overlap protocol in source before P3 hardening. It is not a product to integrate. |
| Agor (`preset-io/agor`) | A multiplayer spatial board. Every piece of work is a branch with its own worktree (`~/.agor/worktrees/`). Zones fire templated prompts. Executor modes are `simple`, `sandbox` and `delegated`. Self-hosted or Agor Cloud. | The closest visual reference for coordinating engineering agents. Its worktree per branch matches Botbench. | **Business Source License 1.1, so it is not open source today.** Borrow ideas at the product level only and copy no code. |
| Agenta (`agenta-ai/agenta`, MIT) | "The open-source workspace for your agents and your team", for IT, go-to-market, HR, legal and finance work. It drives Claude Code, Pi or Codex. Sessions are sandboxed, and the technology is not named. Agents delegate to each other. "Model credentials are never seen by the agent." Connectors come through MCP and Composio. | A test of whether Botbench should move beyond code. | Defer. Botbench's wedge is software delivery (`docs/product/positioning-concept.md`). |
| Letta Code (`letta-ai/letta-code`) | Long-lived agents with memory blocks, skills, "sleeptime" learning, and context versioned in git (MemFS). Letta Cloud is the default store, and local is optional. | Memory that is versioned in git, as Botbench's learnings branch is (`src/engine/learnings.ts`). | Learn from git-versioned memory. Avoid cloud as the default memory store. |
| OpenHands (`OpenHands/OpenHands`) | An agent server with a REST API. The runtime is local (the README warns: "full access to your filesystem!"), Docker per conversation, or remote. It drives ACP agents, including Claude Code, Codex and Gemini CLI. | A reference for making the execution environment a seam (U28). | Learn the runtime seam. Avoid local full access as the default. |
| Google Agent Mesh (`google/agentmesh`, Apache-2.0, pre-1.0, "not an officially supported Google product") | Node, router and control plane. Enrollment is by OIDC or a bootstrap token, with short-lived credentials bound to the node key. "Nothing is reachable by default." Services are exposed to agents as MCP tools. | A possible transport after P5 if two owners lack a shared private network. | Defer. It adds a control plane, and ADR 0004 needs none. |
| A2A (`a2aproject/A2A`, Linux Foundation, Apache-2.0) | Agent Cards for discovery, tasks, JSON-RPC over HTTP(S) with SSE, and push notifications. It has a JS SDK (`@a2a-js/sdk`). | Interoperability beyond Botbench-to-Botbench. | Keep ADR 0004's position: a possible boundary later, not a prerequisite. |
| Daytona (`daytonaio/daytona`) | Sandboxes with snapshots, and a hosted service. **The README says the repository is no longer maintained, and development moved to a private codebase in June 2026.** | — | Avoid as a dependency. |
| E2B (`e2b-dev/E2B`) | Cloud sandboxes with an API key, or self-hosted on Linux and the major clouds through Terraform. JS and Python SDKs. | A remote execution backend. | Defer. It is not local on a Mac, and it needs a key Botbench would have to hold. |
| Docker Sandboxes (`sbx`) | One microVM per sandbox, with its own Docker daemon. The project folder is mounted read-write, or used in "clone mode". Network presets (Balanced, Locked Down) plus `sbx policy allow network <host>`. For a Claude subscription, "the session token stays on your host". | The best candidate found for U28's container kind on a Mac. | Evaluate, but first check three things: that Botbench's broker still fires inside it, the licence and pricing, and whether it can be driven without a person at the keyboard. |
| LangGraph (`langchain-ai/langgraph`, MIT) | Durable execution, checkpoints and interrupts. | Principles only. Botbench already has an append-only store and restart recovery (`src/engine/recover.ts`). | Avoid as a dependency (zero runtime dependencies). |

## 1. Capability matrix

Key:

- ✓ means implemented and seen in source.
- ◐ means partial.
- D means documented only, not seen in source.
- P means planned.
- – means not found in what was read. That is not proof it is absent.

For Botbench, "today" means seen in source at `0dcc133`.

| Capability | Botbench today | Botbench direction | OpenAgents | Tutti | Paperclip | OpenMausBot | QM | Open Agent Bridge |
|---|---|---|---|---|---|---|---|---|
| Drive several vendors' CLIs | ✓ Claude Code and Codex build. Grok and Antigravity review or chat (`src/drivers/`) | P all as builders, once confinement holds | ✓ 26 listed (`adapters/`) | D Claude Code, Codex, Hermes | ✓ adapter registry | ✓ stream-json, JSON-RPC, ACP | D Pi. Others unverified | D Codex. Claude Code "confirmed" |
| Use the owner's subscription, never store keys | ✓ (hard rule, `src/drivers/launch.ts`) | — | ◐ keeps the OAuth token. Keys set through `agn env` | D "subscriptions you already have" | — | D | – own keys | D holds no provider credentials |
| Isolated copy per task | ✓ git worktree | P container (U28) | – | D VM edition | ✓ worktree per issue | – shadow checkpoints | D sandbox per scope | – |
| Commands confined (files, network) | ✓ macOS sandbox (`src/confinement.ts`) | P container | – | ? `CommandNetworkAccess` flag, enforcement not seen | – | – | D egress proxy, conditional | – |
| Approval stops a tool call | ✓ broker, floor, modes (`src/approvals/`) | — | – skip-permissions in execute | D Control Center | ✓ | ✓ permission proxy | D Strict and Auto | – |
| Plan → build → check → review → decide | ✓ (`src/engine/run.ts`, `stations.ts`, `review.ts`, `decision.ts`) | — | ◐ doer and reviewer routing (D) | ◐ goal reviewer (✓) | ◐ review policy | – | – | – |
| Reviewer from another vendor | ✓ | — | ◐ role routing can name another agent as reviewer (D) | – | ◐ any agent can be a reviewer | – | – | – |
| Result as a branch or pull request with evidence | ✓ (`src/engine/delivery.ts`) | — | – | – | ◐ worktree | – prompt only | – | – |
| Phone access | ✓ pairing code and push | — | D push notifications | D mobile remote | – | ✓ relay and app | D an `ios/` folder exists | – |
| Owner-scoped memory | ◐ owner-only store (`src/engine/memory.ts`) and a learnings branch | P shared learnings (ADR 0005) | D folder knowledge | – | – | – | D per person and per room | – |
| Workbenches see each other's work | ✓ P2 through `gh` (`src/engine/peers.ts`) | — | ✓ shared workspace | D Room | ✓ one server | – | D one server | D board |
| Claim work, avoid duplicates | ◐ P3 claim by early push. Reads, no atomic write (`src/engine/claims.ts`) | — | – | – | ✓ atomic checkout | – | – (swarms use idempotent spawn instead) | D task claims |
| Check that two owners' changes fit, by running them | ✓ P4 (`src/engine/combined.ts`) | — | – | – | – | – | – | – ("does not independently verify") |
| Agent-to-agent messages across owners | – | P P5, ADR 0004 accepted | ✓ through a hosted server | D through a cloud Room | ✓ one server | – | D one server | D through a bridge |
| Signed peer identity | – | P Ed25519 (ADR 0004) | – bearer token | ? | – | – | D signed ingress and capability tokens | D signed requests |
| Collaborate with no shared server | – | P direct (ADR 0004) | – | – | – | n/a | – | – |
| Owner approves every outgoing message | – | P (ADR 0004 item 9) | – | – | – | n/a | – | – |
| Install to first useful result | ◐ install docs, no single installer | P (U24) | D one script, "under a minute" | D GUI, no terminal | D | D | D cloud deploy | D Postgres and an admin |

Columns for Tier 2 and Tier 3 are left out on purpose. Their docs alone do not support row-by-row marks.

## 2. Reusable architectural patterns

These are concepts, not code. Each names where it was seen and where it would land in Botbench.

| Pattern | Seen in | Botbench landing point |
|---|---|---|
| A verdict-only reviewer: read-only mode, one write capability, enforced at launch | Tutti `services/tuttid/tutti_mode_goal_review_agent_adapter.go` | `src/engine/review.ts`: a typed verdict the reviewer cannot exceed. Today the verdict is parsed from text. |
| Recorded sessions replayed in an isolated surface | Tutti `CONTEXT.md` (Cassette) | Already the approved exception in CLAUDE.md. Tutti's split between a mutable recording and an immutable cassette is worth copying in concept. |
| A cursor per consumer plus a durable outbox, polling as the source of truth, and a stream only as a wake-up signal | OpenAgents `packages/agent-connector/src/adapters/base.js` | P5 delivery (ADR 0004 item 7) already retries from the store. A "poll now" wake-up is a later option. |
| An agent belongs to whoever connected it, shared per teammate, and joining a thread shares nothing | OpenAgents README v1.1 | Already matches P5 scope (ADR 0004 item 5). Use it as wording for Settings. |
| A `requestId` on every agent-initiated send: the same payload returns the first result, and the same key with other content fails | QM `docs/swarms.md` | ADR 0004 item 7 has this for messages. Extend it to agent drafts (item 9), so a re-driven turn cannot draft twice. |
| Spawned or delegated work never inherits approval grants | QM `docs/swarms.md` | Already implied by grants per task. State it as a rule when a task can start a task. |
| Handoff outcomes: accepted, validated, applied, completed, blocked, failed, with receipts, append-only | Open Agent Bridge `docs/WORKFLOW.md` | P5 review request and verdict kinds. Let a verdict say "applied and checks passed" only with a P4 run id as the receipt. |
| Activity goes stale on a clock that heartbeats cannot refresh | Open Agent Bridge `docs/WORKFLOW.md` | P3 claims: a claim with no new commit for N hours shows as stale to the other workbench. |
| An atomic claim that conflicts on a second taker | Paperclip `server/src/services/issues.ts` | P3 has a known gap (`design-vs-paperclip.md`, finding 1). It still needs an owner decision on a shared ref. |
| A claim written into shared context before acting, then overlaps settled by messages | Agensh README | P3 plus P5: a claim could name the files it expects to touch, so P2's overlap warning fires before any push. |
| One canonical principal per person, flat links, never bots | QM `docs/principal-links.md` | `asked_by` in ADR 0004 item 10. If a peer has two Macs later, link them under one person this way. |
| An execution environment seam: local, container per task, remote | OpenHands README, Agor `packages/executor` | U28. The seam is planned already. Docker Sandboxes is the candidate runtime. |
| Tools that outlive a turn switched off at launch | OpenAgents `claude.js` (`--disallowedTools … CronCreate … ScheduleWakeup`) | Already a Botbench hard rule. This is independent confirmation that the vendor tool names are right. |

## 3. Competitive gaps

### Where Botbench can be shown to be better

Each of these needs its experiment before it is claimed in public.

1. **Changes from two owners that are checked to fit.** P4 runs both branches together in confinement and stores the evidence. In what was read, the nearest things are Tutti's single-owner goal reviewer and Open Agent Bridge's self-reported outcomes. Experiment: E4.
2. **Collaboration without anyone's server.** Every Tier 1 collaboration product needs a shared server, whether hosted, team-deployed or bridge. Botbench's is direct between two Macs, and nothing leaves except what each owner approved. This only matters if pairing is easier than "both join a workspace URL". Experiment: E1.
3. **Unattended without permissions off.** Botbench confines commands and keeps the broker, the floor and three modes, while several competitors run with prompts skipped. Experiment: E5.
4. **The end state is a branch you can review.** Branch, checks, a reviewer from another vendor, an owner decision, and an optional pull request that is never merged. Most competitors end at a message or a file.

### Where Botbench is behind

Do not claim these, and decide which are worth closing.

- **Agent breadth:** OpenAgents lists 26 agents. Botbench builds with two. ACP adapters (OpenAgents, OpenMausBot, OpenHands) are how the others got breadth cheaply.
- **First run:** One script or a GUI elsewhere. Botbench has no installer yet (U24).
- **Seeing each other live:** Presence, shared threads and shared boards (OpenAgents, Tutti, Agor). Botbench's P2 view comes from GitHub, so a running task with nothing pushed is invisible until P3's early push.
- **Steering a running task:** OpenMausBot queues a message into a running turn. Botbench's only way in is a refusal note on an approval card.
- **Scoped memory across people:** QM's person and room scopes are far ahead. Botbench has owner-only memory and a learnings branch.
- **Beyond code:** Agenta and QM serve non-engineers. Botbench deliberately does not, for now.

## 4. Five product experiments

Every experiment uses real repositories, real CLIs and real people (hard rule: nothing fake). Install competitors in a separate macOS user account or a VM, never in the owner's main account. Their daemons can reach the network and the files under that account. Record results at the Run level in this folder.

The measures are the same across all five:

- Setup time: from download to first useful result.
- Active coordination time per person: time spent reading, relaying or deciding.
- Human interventions per accepted change.
- Successful outcomes: merged without rework within 48 hours.
- Reliability: runs that ended without a manual rescue.
- Repeat use: used again unprompted within 14 days.

| # | Experiment | Compared with | Pass bar (proposed) |
|---|---|---|---|
| E1 | **Two developers, one change across a boundary.** For example, one person builds an API and the other its client in the same repository. Each pair does one change with Botbench (P1–P4, and P5 when built), and one with their normal process. | GitHub plus Slack, and OpenAgents with a shared workspace | ≥20% less active coordination time, with no more integration failures. 8 of 10 pairs set it up without help. This is the owner's go or no-go bar (`positioning-concept.md`). |
| E2 | **First useful result.** A new user goes from nothing to a reviewed branch on their own repository. | OpenAgents, Agor, OpenHands | Botbench's median time is no worse than the fastest competitor's, and the first result is a branch with passing checks. |
| E3 | **No duplicate work.** Two workbenches pull from one backlog of 10 labelled issues for a day (watch issues, `src/engine/watch.ts`). | Botbench P3, Paperclip's atomic checkout, and no coordination | Zero duplicate pull requests. Duplicate starts counted and explained. |
| E4 | **False confidence.** Ten pairs of tasks, five seeded with a real interface mismatch that each side's own tests miss. | P4 combined check, a reviewer alone, agents messaging alone (OpenAgents or Open Agent Bridge), and a person alone | P4 catches every seeded mismatch, with no more than one false alarm in the five clean pairs. |
| E5 | **Unattended and safe at the same time.** Real tasks run fully autonomous, with decoy secrets outside the copy and network destinations that were not allowed. | Botbench fully autonomous, OpenAgents execute mode, Docker Sandboxes with Claude | Botbench completes as many tasks with zero decoy reads, zero disallowed egress and zero unattended prompts. Count every refused action that blocked a legitimate step. |

## 5. Strategic recommendations

Ranks run H, M, L. A "fit" of H means it serves the North Star directly.

| Action | Item | Customer value | Differentiation | Effort | Validation risk | Why |
|---|---|---|---|---|---|---|
| **Build** | Run E1 and E4 on P1–P4 now, before P5 | H | H | L | M | P4 is the claimed moat, and it is already built. Prove it before adding messaging, which everyone has. |
| **Build** | P5 first slice as ADR 0004 says, plus Open Agent Bridge's handoff outcome states for review requests and verdicts, with a P4 run id as the receipt | H | M | M | M | It joins messaging to the one thing nobody else verifies. Change the ADR before code, not after. |
| **Build** | `requestId` idempotency on agent drafts (QM pattern), and staleness for P3 claims (Open Agent Bridge pattern) | M | L | L | L | Small, and they close known re-drive and silent-claim gaps. |
| **Build** | A typed reviewer verdict that the reviewer cannot exceed (Tutti pattern) | M | L | L | L | It hardens the review station without a new trust boundary. |
| **Build** | First-run path (U24), timed against E2 | H | L | M | L | The current gap most likely to lose a user before any differentiator is seen. |
| **Integrate** | Docker Sandboxes as U28's container kind, after the three checks in Tier 3 | M | L | M | M | Integrate a runtime, don't build one (positioning concept). It is the only candidate found that is local, on a Mac and subscription-safe. |
| **Integrate** | ACP as a second driver path for agents with no structured protocol of their own, through the same broker | M | L | M | M | It is how three competitors got breadth. It still fits "structured headless protocol, one adapter". Needs an ADR. |
| **Defer** | A2A, Agent Mesh, any relay or hosted service | L now | L | H | H | No first-slice need, and each adds a boundary (ADR 0004). Revisit if E1 shows pairing is the blocker. |
| **Defer** | Swarms beyond two workbenches, task dependencies, parallel tasks | M | L | H | H | Already deferred in CLAUDE.md. Agensh's numbers say a model upgrade often beats agent count. |
| **Defer** | Person and room memory scopes (QM model), cross-functional agents (Agenta) | M | L | H | M | Real, but off the wedge until two-developer delivery is proven. |
| **Avoid** | A central server or accounts as the entry point (Paperclip, QM, OpenAgents' hosted default) | — | — | — | — | It breaks "local by default". Everyone else already does it. |
| **Avoid** | Permissions off as the way to be autonomous | — | — | — | — | It breaks the safety floor. The opposite is Botbench's claim. |
| **Avoid** | Cloud memory by default (Letta), keys held by the product (OpenAgents, E2B) | — | — | — | — | Hard rules. |
| **Avoid** | Daytona as a dependency, LangGraph or any framework dependency, and copying code from Agor (BSL) or OpenMausBot `enterprise/` | — | — | — | — | An unmaintained public repository, the zero-dependency rule, and licences. |
| **Avoid** | Measuring success by providers, agents or connectors | — | — | — | — | Measure E1's coordination time and E4's caught mismatches instead. |

## Open questions for the owner

1. **The P3 atomic claim.** Should Botbench be allowed one shared ref per issue on GitHub, which today's rule "pushes only a task's own branch" forbids? This is still open from `design-vs-paperclip.md`.
2. **Running competitors.** May the experiments install competitor software in a separate macOS account on the owner's machine? It needs the owner's own sign-ins for those products.
3. **ADR 0004.** Should it be amended for handoff outcome states before P5 code starts?

## Sources

Each was read on 2026-11-23 through a web fetch, at the default branch head.

- OpenAgents: `README.md`, `packages/agent-connector/src/adapters/claude.js`, `packages/agent-connector/src/adapters/base.js`, `docs/projects/agent_workspace.md`, the repository tree. https://github.com/openagents-org/openagents
- Tutti: `README.md`, `CONTEXT.md`, `services/tuttid/` listing, `agent_runtime_adapter.go`, `agent_command_network_policy.go`, `tutti_mode_goal_review_agent_adapter.go`. https://github.com/tutti-os/tutti
- QM: `README.md`, `SECURITY.md`, `docs/swarms.md`, `docs/principal-links.md`. https://github.com/yc-software/qm
- Open Agent Bridge: `README.md`, `docs/WORKFLOW.md`. https://github.com/munboon/open-agent-bridge
- Agensh: `README.md`. https://github.com/microsoft/Agensh. Paper: https://arxiv.org/abs/2609.26781
- Agor: `README.md`. https://github.com/preset-io/agor
- Agenta: `README.md`. https://github.com/agenta-ai/agenta
- Letta Code: `README.md`. https://github.com/letta-ai/letta-code
- OpenHands: `README.md`. https://github.com/OpenHands/OpenHands
- Agent Mesh: `README.md`. https://github.com/google/agentmesh
- A2A: `README.md`. https://github.com/a2aproject/A2A
- Daytona: `README.md`. https://github.com/daytonaio/daytona
- E2B: `README.md`. https://github.com/e2b-dev/E2B
- Docker Sandboxes: https://docs.docker.com/ai/sandboxes/get-started/ and https://www.docker.com/products/docker-sandboxes/
- LangGraph: `README.md`. https://github.com/langchain-ai/langgraph
- Paperclip and OpenMausBot: this repository's `docs/reviews/design-vs-paperclip.md` and `docs/reviews/design-vs-openmausbot.md`.
