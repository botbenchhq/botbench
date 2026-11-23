# Design review: Botbench and Paperclip on agents and engineers working together

Date: 2026-11-22. Paperclip read from `.reference/paperclip` at commit e08705f. Paperclip paths below are relative to `.reference/paperclip/`; Botbench paths are relative to this repository. The question is Botbench's North Star: two or more engineers, each with their own Botbench and agents, delivering work together without stepping on each other (Milestone 6 in `docs/plans/2026-11-21-2234-feat-botbench-software-factory-plan.md`, and `docs/product/peers-concept.md`).

## Summary

- Stronger: each engineer keeps their own machine, agents and decisions; Paperclip puts every agent, task and approval in one shared server and database, which is a single control plane, not peers.
- Stronger: Botbench already sees other workbenches' pull requests, branches and changed files on the shared remote (P2); in the files read, Paperclip gives each issue its own worktree but has no check for two issues changing the same files.
- Weaker: Paperclip claims an issue in one step that fails with a conflict if someone else holds it, and takes over a claim whose run has ended; Botbench has no claim yet, so a running task with nothing pushed is invisible to the other workbench.
- Weaker: Paperclip records whether an agent or a person did each thing and can make a required review that only a person may remove; Botbench's action log has no "who asked" and P4's shared check has no such protection planned.
- Weaker: Paperclip limits what one agent may do to other agents' work, on both the sending and the receiving side, with a per-run cap; Botbench's P5 plans owner approval per message but no limits by kind or count.

## Side by side

| Job | Botbench | Paperclip |
|---|---|---|
| Assigning or claiming work | The owner starts a run from an issue, read-only; nothing is written to the issue: `src/engine/intake.ts` | One assignee per issue; checkout sets assignee and run in one conditional update: `server/src/services/issues.ts` |
| Avoiding duplicate work | Composer warns when another workbench has an open pull request closing the issue: `web/src/app/peers.ts` | A second checkout gets "Issue checkout conflict" (409); single assignee by design: `doc/TASKS.md` |
| Avoiding conflicting changes | Lists other workbenches' open pull requests with their files; review screen names overlapping files: `src/engine/peers.ts` | Each issue runs in its own git worktree; no overlap check found: `server/src/services/execution-workspace-policy.ts` |
| Handing a result between agents | Only inside a task: the reviewer's reply goes to the builder as data for a fix round: `src/engine/refine.ts` | Durable, idempotent "case handoffs" from one agent's task to the next: `server/src/services/case-handoffs.ts` |
| Teams and roles | Planner, builder and reviewer, one driver and model each, chosen by the owner: `src/engine/roles.ts` | Agents in an org chart (`reportsTo`), with human member roles: `packages/db/src/schema/agents.ts` |
| Goals | The run's prompt, spec file or GitHub issue: `src/engine/run.ts` | Goal tree from company to task, linked from issues and projects: `packages/db/src/schema/goals.ts` |
| Budgets and cost limits | Tokens per agent, model and run; no dollars for subscriptions, no limit: `src/usage.ts` | Budget policies per company, agent or project; warning, then hard stop and pause: `server/src/services/budgets.ts` |
| What needs a person | Never-list floor, grants, three run modes; dangerous actions always ask: `src/approvals/gate.ts` | Board approvals (hiring, strategy) plus default grants per agent: `doc/agent-permission-defaults.md` |
| Seeing what everyone does | Board of runs and tasks on this workbench, plus the P2 peers view: `web/src/screens/board.tsx` | One dashboard of all agents; live run presence per issue: `server/src/services/issue-run-presence.ts` |
| Review by another agent | A different vendor's model reviews the diff; an opinion, never a check: `src/engine/review.ts` | Review policy and an opt-in required review only a person may remove: `server/src/services/required-quality-review.ts` |
| Adding another vendor's agent | One driver per CLI behind a capability contract, live conformance tests: `src/drivers/contract.ts` | Adapter packages in a mutable registry, plus HTTP and external adapters: `server/src/adapters/registry.ts` |
| Where work and history are stored | SQLite under `~/.botbench`, append-only action log: `src/store/schema.ts` | Postgres (embedded or external) for the whole company: `packages/db/src/schema/issues.ts` |

## Findings

Ranked by value to an engineer whose Botbench works on the same repository as a teammate's.

### 1. Claim an issue in one step, and let the later claim lose

- Paperclip: checkout writes the assignee and the run only if nobody else holds the issue; otherwise it answers 409 with who holds it. A repeat by the same run is not a conflict.
- Paperclip file: `server/src/services/issues.ts` (the "Issue checkout conflict" path).
- Botbench today: P2 warns only when another workbench already has an open pull request for the issue (`web/src/app/peers.ts`); two workbenches that start the same issue minutes apart both go ahead, and `src/github.ts` writes nothing to an issue.
- Change: P3's claim is written just before the run starts (the owner's choice), then the issue is read again. GitHub has no compare-and-set, so the rule is: the earliest claim from a workbench wins, and a workbench that finds an earlier claim from another workbench withdraws its own and does not start without the owner confirming.
- Size: medium.
- Acceptance: two installations claim the same issue within one second; exactly one run starts, and the other shows the winning workbench's name and claim time with its own claim gone from the issue.
- Peers step: P3.

### 2. A claim names its run and is released when the run is gone

- Paperclip: when the run holding an issue has ended or is missing, the next checkout takes the claim over instead of failing (`adoptStaleCheckoutRun`).
- Paperclip file: `server/src/services/issues.ts`.
- Botbench today: P3 plans to release a claim when a run ends without a pull request, but a run that ends while Botbench is down is only found at restart (`src/engine/recover.ts`), and nothing says what the other workbench does with an old claim.
- Change: the claim carries workbench, run and time. Startup recovery releases claims of runs it marks interrupted or that were discarded; the other workbench shows a claim's age, and its owner may take it over after a confirm that names the holder.
- Size: small.
- Acceptance: a run is discarded while its workbench is stopped; after restart, the issue carries no claim from that workbench and the action log has one row recording the release.
- Peers step: P3.

### 3. A shared check that only an owner can remove, and that counts only when it ran

- Paperclip: an agent may add a required review to a task, but only an authenticated person may change or remove it; "no model claims, labels, plans or file presence count as approval".
- Paperclip file: `server/src/services/required-quality-review.ts`.
- Botbench today: the reviewer is an opinion, never a check (`src/engine/review.ts`), and P4's linked check is planned but not built; nothing stops agent output or a later peer message from asking to drop it.
- Change: in P4, the link between two issues and its check command are set and removed only by an owner action through the API; a task in the link cannot be accepted as "fits" until that check ran on the merged scratch branch and passed.
- Size: medium.
- Acceptance: with a link in place, a task whose transcript asks to skip the shared check still shows the check as required, and accepting it in a fully autonomous run waits for the owner until the check has run and passed.
- Peers step: P4.

### 4. Mark a shared check result stale when either branch moves

- Paperclip: a required review reports a slot as "stale" when its evidence no longer matches, and dependent issues wake only when their blockers resolve (`issue_relations` type `blocks`).
- Paperclip file: `server/src/services/issue-dependency-wakeups.ts`.
- Botbench today: P2 reads the other workbench's pushed branches with `git ls-remote` (`src/engine/peers.ts`) but nothing ties a check result to the commits it ran on.
- Change: a P4 shared check stores the two head commits it ran on; when the peers view shows a different head for either branch, the result is shown as stale and the check is offered again.
- Size: small.
- Acceptance: after the other workbench pushes a new commit to its linked branch, this workbench shows the earlier "passed" as stale, naming the commit it ran on and the new one.
- Peers step: P4.

### 5. Record who asked, on every action and approval

- Paperclip: every activity row has an actor type (agent or user) and id, and review verdicts are matched to who requested them.
- Paperclip file: `server/src/services/issue-review-policy.ts` (reads `activity_log` actor type and id).
- Botbench today: `action_log` has rules, tool, command and folder but no principal (`src/store/schema.ts`); every decision is assumed to be the owner's, which `docs/product/peers-concept.md` lists as a prerequisite to fix.
- Change: approvals and action-log rows gain who asked: the owner, this workbench's agent, or a named peer workbench; the approval card shows it.
- Size: medium.
- Acceptance: an approval raised while acting on a peer's message stores the peer workbench's name, the card shows it, and the action-log row for the answer carries the same name.
- Peers step: P5 (needed before any peer message can lead to an action).

### 6. Let each side turn off kinds of peer requests, checked on both ends

- Paperclip: interactions between agents (assign, mention, comment, edit, configure) have an outgoing and an incoming setting; both must allow, and an explicit "no" is not overridden by any role.
- Paperclip file: `server/src/services/agent-interaction-permissions.ts`.
- Botbench today: P5 plans typed messages with each owner approving what leaves and what is acted on; no per-kind setting is planned.
- Change: per peer, the owner sets which message kinds (question, interface proposal, review request, handoff) may be sent and received; a kind turned off on the receiving side is refused before it becomes a card, and the refusal is logged.
- Size: small.
- Acceptance: with review requests turned off for peer A, a review request from A is answered with a refusal, creates no pending approval, and adds one action-log row naming A.
- Peers step: P5.

### 7. Cap how much one run can send to a peer

- Paperclip: one run may influence at most 20 other issues (comments, updates, resolutions); every attempt is logged first, then refused over the cap.
- Paperclip file: `server/src/services/cross-issue-influence-limit.ts`.
- Botbench today: nothing in P5's plan limits volume; two agents asking each other questions could fill both owners' screens with cards.
- Change: a per-run limit, small by default, on messages an agent may send to peers; over it, the request is refused without a card and the agent is told why in plain words.
- Size: small.
- Acceptance: in a run with a limit of 3, the fourth outgoing peer message creates no card, is not sent, and leaves one action-log row with a rule distinct from `owner_declined`.
- Peers step: P5.

### 8. Show running work on an issue before anything is pushed

- Paperclip: each issue shows its queued and running runs from one shared read, so nobody waits for output to know it is taken.
- Paperclip file: `server/src/services/issue-run-presence.ts`.
- Botbench today: the peers view lists only open pull requests and pushed branches (`src/engine/peers.ts`); a task in progress on another workbench appears nowhere until it pushes.
- Change: the peers view reads P3 claims along with pull requests and branches, and the composer and task screen name the workbench and claim time for an issue in progress.
- Size: small.
- Acceptance: while workbench A builds from issue N with nothing pushed, workbench B's composer, with issue N attached, shows "A took this issue" with the time.
- Peers step: P3.

## Not worth taking

- Dollar budgets with a hard stop per agent (`server/src/services/budgets.ts`): subscription turns carry no dollar amount and Botbench never moves a session to metered billing.
- An org chart where agents manage and assign to other agents (`packages/db/src/schema/agents.ts`): in Botbench the engineers coordinate; agents delegating to agents takes decisions away from the owner.
- One shared server and database for everyone's agents (`packages/db/src/schema/issues.ts`): it is a central control plane, against local by default and one workbench per engineer.
- Agents holding their own API credentials (`server/src/services/agent-credentials.ts`): Botbench never stores or forwards provider credentials.
- A goal tree from company down to task (`packages/db/src/schema/goals.ts`): for two engineers on one repository, the issue already is the goal; another layer adds weight for no user.

## Could not verify

- The clone is at commit e08705f with about 17,500 tracked files; whether it matches the upstream repository was not checked. Every file opened could be read; only a subset was read: the files cited here, `README.md`, `doc/GOAL.md`, `doc/TASKS.md`, `doc/case-handoffs.md`, `doc/agent-interaction-permissions.md`, `doc/agent-permission-defaults.md` and `packages/adapters/AUTHORING.md`.
- No Paperclip code was found that detects two issues changing the same files; a search of `server/src`, `doc` and `docs` found none, but the codebase is too large to rule it out.
- `doc/TASKS.md` calls itself partly aspirational; which of its rules are enforced beyond checkout and single assignee was not traced.
- The cross-issue cap in finding 7 only logs before a date set in its code (2026-08-11) and refuses after it; whether any setting turns it off in a given installation was not traced.
- Whether GitHub lets two workbenches' claim writes and reads land in a stable order, which finding 1 relies on, needs a live test with two installations and real `gh`.
- Neither project was run; the P3 to P5 steps are not built, so the Botbench side of findings 1 to 8 is the plan, not behaviour.
