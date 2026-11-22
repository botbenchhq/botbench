# botbench — product and brand concept

**Working positioning, 21 November 2026**

## The idea

**Botbench is the software factory you own.** It turns coding work into a governed sequence: plan, build, check, independently review, and decide. It runs the developer's installed AI coding CLIs and stores its orchestration state, branches, transcripts, evidence, and approval records on their machine. The CLIs still communicate with their model providers.

**Hero headline:** From prompt to proof.

**Hero subhead:** Four coding agents. One production line. You decide what ships.

**Primary CTA:** Start a run.

**Supporting promise:** Give botbench a task, approve the plan, and come back to a branch, a diff, the check results, and a clear decision. No babysitting the terminal.

**Short pitch:** Botbench is an owner-controlled command center for AI coding agents. It works with the tools you already use, builds on separate Git worktrees, runs the checks you configure, asks a second model to review when enabled, and puts the evidence in front of you before you accept the result.

**One-line description (accurate for the planned first release):** A local-first software factory for turning AI coding runs into review-ready branches.

**Avoid for V1:** “verified PRs,” “autonomous releases,” “sandboxed execution,” “your code never leaves your machine,” “unlimited use of your AI subscriptions.” The current plan does not open PRs, does not provide OS-level sandbox isolation, and permits model vendor communication. Subscription entitlement and unattended-use terms must be independently checked.

## Why someone would care

Most agent tooling emphasizes **starting more agents**. The emotional pain is elsewhere: *I have more AI coding capacity than attention. I don't want four terminals, several branches, endless permission prompts, and opaque ‘done’ messages.*

The core job-to-be-done is:

> When I delegate a coding task and walk away, help me return to a result I can evaluate and safely take forward—without losing control of my local repository.

The strongest customer is a solo technical founder, power user, or very small engineering team with multiple coding-agent subscriptions and a machine they already leave on. Do not start by selling an enterprise AI SDLC replacement.

### What the customer buys

- **Less supervision.** Delegate a coherent task, then respond only where human judgment or permissions are needed.
- **A reviewable result.** A branch, diff, acceptance criteria, checks, and a separately labeled model critique rather than a success assertion.
- **Control.** Specific permissions, protected checkout, approval history, and deliberate human decisions.
- **Flexibility.** Agents as interchangeable executors where real driver capabilities and provider terms support them.
- **Ownership.** Local orchestration data, local Git branches, and self-hosting, not “all model processing is local.”

## Competitive reality

**Not defensible on their own:** multi-agent support, worktree isolation, already-paid subscriptions, a phone client, a task board, or running checks. Conductor supports multiple agents with individual worktrees and review flows; Vibe Kanban covers worktrees, progress, diffs and some approvals; OpenHands Agent Canvas is self-hostable and supports several agent backends; Claude Code supports mobile remote control. This is an active and overlapping market.

**Potential strategic wedge:** Build an exceptionally reliable *decision and evidence workflow*. Rather than a control board for agents, botbench is a control board for **engineering outcomes**.

### What could become a moat, in order

1. **The handoff format.** A uniform, inspectable evidence pack for every task: base commit, acceptance criteria, changed files, check commands and outputs, model and attempt provenance, independent review findings, outstanding risks, owner decision. Eventually portable/shareable; not a proprietary lock-in trick.
2. **Deterministic trust controls.** A robust permission broker, scoped grants, revocation, recovery after interruption, non-duplicating side effects, clear proof of what did and didn't run. The hard-to-copy advantage would be years of reliability and incident learning—not a feature checkbox.
3. **Repository-specific quality learning.** Remember which checks matter for each codebase, which work types frequently fail verification, reviewer false-positive patterns, and which evidence owners actually inspect. Suggest policies but never silently widen privileges.
4. **Empirical model routing.** Actual successful outcome rates by repo and task type, adjusted for verification failures, interventions, and time-to-accept—not merely cheapest tokens. Route between compatible permitted drivers.
5. **Habit + workflow gravity.** A morning decision inbox that becomes the place where builders start and accept AI work. Once this is habitually better than reviewing raw CLI transcripts, it can earn retention.

**Current verdict:** Botbench has an interesting wedge, not yet an established moat. The product must win on *decision quality, reliability and handoff experience* rather than claiming to be the first model-agnostic coding factory.

## Design direction

**Concept:** Industrial precision, not a cartoon forge. Obsidian/graphite foundation, molten amber for decisions and human attention, soft mint for completed checks. Monospaced labels for machine evidence; concise, legible display typography for customer outcomes.

**Visual vocabulary:** production line, stations, workpiece, evidence pack, human decision, local machine. Avoid overusing flames, sparks, anvils, or gamified agent avatars.

**Information architecture:**

- **Control room:** needs your decision / on the line / waiting on you / connected agents. Put required human action before vanity metrics.
- **Runs:** planned, building, verifying, reviewing, awaiting decision, completed. V1 runs tasks sequentially, not in parallel.
- **Approvals:** exact action, repo, worktree-relative directory, role, reason, grant scope, allow once/decline, log. Never-eligible actions always prompt.
- **Evidence:** branch, diff, check output, reviewer critique, provenance and limitations. Passing checks are not a guarantee.
- **Models:** installed CLI readiness, subscription-vs-metered-vs-unknown indication, assigned roles, supported capabilities, fallback chain.

**Primary screen hierarchy:**

1. **A decision-ready task:** one sentence summary; clear verification state; prominent *Inspect evidence*; deliberate *Accept branch* (not *Merge* or *Publish*).
2. **A running task:** current station and latest meaningful event; open full transcript on demand.
3. **A permission:** exact command and scope with *Allow once* / *Decline*; no generic “Allow all.”
4. **A production summary:** completed checks, ready branches, pending decisions. Subscription usage belongs below delivery outcomes.

**Mobile experience:** A pocket-sized decision desk, not a shrunken IDE. Prioritize approvals and evidence summary; expose detailed diffs/transcripts as secondary drill-downs. The planned installable PWA can notify owners of pending approval and decision events but should not include code or command text in push payloads.

## Golden path and sample UX copy

**Create:** "What should botbench build?" — choose an existing local repo and give a task or markdown spec.

**Plan:** "Review the plan before the line starts." — edit or remove planner-generated independent tasks and set specific allowed commands.

**Run:** "It's on the line." — implementation is isolated in its own Git worktree; updates are visible and can survive process restarts with defined recovery behavior.

**Verify:** "Here is what passed. Here is what didn't." — exact commands, output, exit codes, timeouts. The reviewer uses a different model when enabled.

**Decide:** "The work is ready. The decision is yours." — accept or reject the branch. Accept does not push, merge, or open a PR in V1.

## Product release boundaries

**Release 1, as specified in the attached plan:** local Node/SQLite single process; CLI adapters; owner sign-in; worktree per task; editable approval-gated plan; permission broker and ledger; configured checks; optional different-model read-only reviewer; owner accept/reject branch; phone-accessible PWA and push; sequential task execution; no automatic PRs/pushes.

**Release 2, proposed:** idempotent GitHub PR publication and branch lifecycle; optionally downloadable evidence report; more robust sandbox options. Do not market these as shipping until implemented.

**Release 3, proposed:** repo-specific outcome analytics, reviewer calibrations, empirical route optimization, configurable policy packs, outcome metrics.

## Critical risks to resolve before promoting the proposition

1. **Subscription eligibility and provider rules.** Anthropic's current Claude Code legal docs state that developers building products that interact with Claude capabilities should use API-key authentication through Claude Console or supported providers, and prohibit third parties routing users' subscription credentials on their behalf. The docs also distinguish user sign-in to an unmodified Claude Code binary. A product that spawns the official CLI under an owner's login may be covered differently from a service that intermediates OAuth, but this must be confirmed for each actual integration and use case. No stored credentials is good security hygiene, not automatic policy clearance. The headline “use the subscriptions you already pay for” requires provider-by-provider proof or a permitted alternative.
2. **Worktree ≠ sandbox.** Git worktrees isolate branch state, not OS access. Running agent-generated tests and setup commands on the host carries risk; permit controls reduce but do not eliminate it.
3. **'Verification' semantics.** Do not infer correctness from green tests. Show which checks ran, what they covered, the independent review if configured, and any unresolved findings.
4. **PR promise mismatch.** The plan expressly defers push and PR creation. Product copy, docs, and UI must say *review-ready branch* until the PR workflow ships.
5. **Test feasibility.** Different CLI protocols, permission interception, rate limit conditions, and account/login probes may be inconsistent. Probe and disclose limits rather than claiming parity.
6. **Trade-name diligence.** Do a real trademark, repository name and domain search before public launch; this draft does not clear the name.

## Validation to prove customers care

Recruit 10–15 multi-subscription technical builders who have actual repositories and repeatable backlog items. Require a first real end-to-end branch from a phone, then watch repeated usage for two weeks. Count:

- **Core adoption:** fraction of users who run a second real task within seven days.
- **Unattended value:** share of runs that reach *awaiting decision* without unplanned intervention; report user-approved commands separately.
- **Trust:** percent of results whose evidence pack is opened before acceptance; percent of attempted dangerous actions blocked.
- **Delivery quality:** fraction of tasks passing user-configured checks; percent accepted vs rejected; time from result-ready to human decision.
- **Model advantage:** cross-model review findings that the implementer actually fixes, versus superficial comments.
- **Ease:** median time from fresh install to first real branch and from a morning notification to an accept/reject decision.

**The make-or-break question:** After two weeks, do users deliberately return to Botbench as the default place to delegate code, or do they go back to Claude/Codex/Conductor? If they don't return, more integrations will not rescue the positioning.

## Naming and messaging

**Name:** `botbench` (this draft was written for the earlier name, Smelt, which the owner replaced with Botbench on 2026-11-22). Use it as a noun. A clean visual identity, domain diligence and a consistent lowercase wordmark matter.

**Recommended pair:**

> botbench.
>
> **From prompt to proof.**
>
> Your coding agents, one production line. Plan, build, check, review, decide—on your machine, under your control.

**Alternative punchline:** *The AI code is theirs to write. The decision is yours to make.*

---

### Sources reviewed

- User's uploaded *Forge Software Factory - Plan*, dated Nov 21, 2026 (renamed Botbench here).
- Conductor — https://www.conductor.build/docs/concepts/parallel-agents
- OpenHands — https://github.com/OpenHands/OpenHands
- Vibe Kanban — https://github.com/BloopAI/vibe-kanban/blob/main/docs/core-features/monitoring-task-execution.mdx
- Claude Code Remote Control — https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- Claude Code legal and compliance — https://code.claude.com/docs/en/legal-and-compliance
