# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-11-25

This is the shared context file the marketing skills read first (`coreyhaines31/marketingskills`, skill `product-marketing`, which keeps it at `.agents/product-marketing.md`). It is drafted from the repository, not from interviews: every statement about the product cites code, a test or a recording, and every statement about buyers is marked as a hypothesis until someone outside the project has said it. A pointer for people reading `docs/product/` is in `docs/product/product-marketing-context.md`.

How to read the evidence labels used below:

| Label | Meaning |
|---|---|
| **Executed** | Run or rendered for this document on 2026-11-25 (an empty installation in a browser, the live website, the repository's own tests). |
| **Inspected** | The implementing code or test was read; not run for this document. |
| **Recorded** | Shown in committed media made by `e2e/media.shots.ts`: real screens and a real check, with the agents' parts replayed from recorded sessions. |
| **Hypothesis** | A belief about buyers or the market. Nobody outside the project has confirmed it. |

The source of truth for what the product does is the README's *What works today*, *Where it is going* and *Current availability*. Where this file and the README differ, the README wins and this file is wrong.

## Product Overview

**One-liner:** A local-first workbench for the coding agents you already use, with a coordination layer between developers' workbenches.

**What it does:** You hand a task, or a run of several, to Claude Code or Codex on your Mac. Each task works in its own copy of your repository (a git worktree) on its own branch; Botbench asks you only about actions that reach outside that copy, runs your repository's checks, can have another vendor's agent review the change, and leaves you a branch, a diff, the check output and the transcript to accept or reject. When a teammate runs their own Botbench on the same GitHub repository, each workbench sees the other's open pull requests and pushed branches, warns when work overlaps, can claim an issue so only one starts it, and can check two changes together before either is merged.

**Product category:** Hypothesis: people look for it as "run several coding agents in parallel", "Claude Code worktree manager", "agent orchestration for my repo", or "coding agent on my phone". The shelf it sits on is local agent orchestrators; the part that shelf does not usually carry is coordination between two developers' separate installations.

**Product type:** Open-source, self-run desktop server with a browser and phone client (Node 24, SQLite, macOS only). Built from source; no installer, no hosted service, no accounts.

**Business model:** None today. Apache 2.0. The owner's pricing hypothesis (solo free, coordination per developer per month, compute supplied by the user) is untested and is not to appear in public copy (`docs/product/positioning-concept.md`).

## Target Audience

**Target users:** Developers on a Mac who already use Claude Code (and maybe Codex) with their own subscriptions, and small teams of 2 to 5 where each person delegates to agents in one shared GitHub repository.

**Decision-makers:** The developer who installs it. For a team, each developer installs their own; nobody buys for anybody else.

**Primary use case:** Delegate a coding task, walk away, come back to a branch with evidence you can judge.

**Jobs to be done:**
- When I delegate a coding task and walk away, help me come back to a result I can judge and safely take forward, without losing control of my repository. (From `positioning-concept.md`; hypothesis until users say it.)
- When my teammate and I both hand work to agents in one repository, tell me before we collide, not when the second pull request opens.
- When an agent says it is done, show me what ran so I do not have to take its word.

**Use cases:**
- A bug fix or small feature handed to Claude Code, answered from the phone, accepted from the Mac.
- A run started from a GitHub issue, planned by Claude Code, built, checked, reviewed by Codex, opened as a pull request.
- Two developers on one repository: one sees the other's open pull request also changes `calc.py` before deciding.
- Two workbenches start on the same issue; the later run stops and says who started first.

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---|---|---|---|
| Solo builder (founder, power user) | Getting more done than they can supervise | Terminals, permission prompts, branches, and "done" that is only the agent's word | Walk away and come back to a branch with its checks, review and transcript |
| Developer on a small team | Not stepping on a teammate's work | Finds out about a duplicate issue or conflicting files when the second pull request opens | The overlap warning, issue claims and checking together, before either pull request is merged |
| Security-minded reviewer on that team (technical influencer) | What the agent could touch | Agents run with the developer's rights | Confined commands, approvals, an action log, a stated threat model, no credentials read |

## Problems & Pain Points

**Core problem:** I have more agent capacity than attention. Several agents mean several terminals, permission prompts as they come, branches to track, and an agent's word that it is done. Add a teammate with their own agents, and the two developers become the messengers between agents, and find out about collisions late.

**Why alternatives fall short:**
- A CLI in a terminal: one session per window, its prompts need you there, and "done" is its own report.
- Worktree managers and local multi-agent apps: parallel copies and diffs, but coordination stops at one person's machine (Hypothesis about the category; the projects read in `docs/competitive/` support it for those projects only).
- Hosted agent platforms and team servers: collaboration through one shared server an operator runs, and the code and runs live there.

**What it costs them:** Time watching terminals; rework when two people take the same issue or change the same files. No measured figure exists; do not quote one.

**Emotional tension:** Hypothesis: doubt about whether the agent really did what it says, and unease at leaving an agent running with your rights.

## Competitive Landscape

Every statement here comes from `docs/competitive/`, which was written from a read of each project's source at a named commit. Nothing was installed or run there. Say "not demonstrated in the projects reviewed"; never "unique", "first" or "only".

**Direct (same job, one developer):** Local workbenches and worktree managers for coding agents, such as Conductor, Vibe Kanban, OpenMausBot and Tutti's open desktop app. They start several agents in separate worktrees and show diffs. Where Botbench differs today: approvals and confined commands are on by default (the review found running with permissions bypassed is the norm in the projects read, `docs/competitive/README.md`, finding 2), and the result is gated on checks that ran rather than on the agent's statement (finding 3).

**Secondary (same job, a team):** Team servers and shared workspaces for people and agents, such as Agor, OpenAgents, Paperclip, QM. They coordinate through one server that one operator runs. Botbench keeps each developer on their own Mac and uses the shared repository as the meeting point. The review is explicit that a shared server is also why their setup is shorter, so this is a difference to prove, not an advantage to assume (finding 1).

**Indirect:** The agent CLIs used directly in a terminal (Claude Code, Codex), the vendors' own remote and cloud modes, and two people coordinating in Slack and GitHub. The CLIs are what Botbench drives; it never takes a tool away from them.

**Where Botbench is behind** (`docs/competitive/README.md`, finding 4): time from install to first result, task dependencies, number of agents supported, and platforms (macOS only).

## Differentiation

**Key differentiators (each with its evidence):**
- **Evidence instead of an agent's word.** Every task ends in a branch, its diff, the output of the repository's own checks and the transcript; another vendor's review is labelled "a model's opinion, not a check". (Inspected: `src/engine/stations.ts`, `src/engine/review.ts`; Recorded: `docs/media/botbench-demo.mp4`.)
- **Owner-controlled and local.** Your Mac, your subscriptions under the vendors' own programs, your policies: three modes, approvals, confined commands, an append-only action log. (Inspected: `src/approvals/`, `src/confinement.ts`, `src/engine/modes.ts`.)
- **Coordination between separately owned workbenches without a shared server.** Each workbench reads the other's work from the shared remote with its own `gh` and `git`; an issue claim is two branches the remote accepts only once; checking together merges two changes in a temporary copy and runs the repository's checks on the merge. Messages between paired workbenches are owner-approved both ways. Not demonstrated in the projects reviewed in `docs/competitive/`. (Inspected: `src/engine/peers.ts`, `src/engine/claims.ts`, `src/engine/combined.ts`, `src/peers/`.)

**How we do it differently:** The repository is the shared medium. Botbench adds nothing to GitHub for this except a claim, and puts nothing another workbench wrote into a prompt.

**Why that's better:** Hypothesis: each developer keeps their machine, agents and permissions, and still hears about a collision before the second pull request opens.

**Why customers choose us:** Unknown. Nobody outside the project has chosen it yet.

## Positioning and messaging hierarchy

The owner's lines are fixed; use them verbatim (`docs/product/positioning-concept.md`, Direction, 23 November 2026).

1. **Name and tagline:** Botbench. *Put your coding agents to work. Together.* (Short form: *Put your agents to work. Together.*)
2. **Descriptor:** *One workbench for your agents. One coordination layer for your team.*
3. **Proposition:** Hand work to the coding agents you already use, walk away, and come back to a branch with evidence you can judge. When a teammate's agents work the same repository, Botbench tells you before your work collides, not when the second pull request opens.
4. **Two pillars, equal weight:**
   - Solo: *Walk away. Come back to the branch.* Supported by Delegate (own copy and branch per task, three modes, approvals from the phone) and Verify (your checks, a second vendor's review as opinion, Accept or Reject).
   - Team: *Your agents. Their agents. One coordinated workflow.* Supported by the three shipped coordination moments, in the product's own words:
     - Overlap: `office-mac's open pull request #12 also changes calc.py, so the two may conflict when both are merged.` (`web/src/app/peers.ts:157`; shown on the task's Review tab under the changed files, `web/src/screens2/task/task-screen.tsx:336`)
     - Claim: `studio-mac started on issue #42 at 14:14:07 UTC on 2026-11-25, before this workbench did (14:15:02 UTC on 2026-11-25), so this run stopped: when two workbenches start on one issue, the earliest claim goes ahead.` (`src/engine/claims.ts:266,506`; the time format is `claimTimeWords`, `src/engine/claim-branch.ts:155`, so never write "2:14 PM")
     - Check together: `Check together with pull request #12`, then `Passed together:`, `Failed together:` or `Conflict:` (`web/src/components/check-together.tsx:116`)
5. **Proof:** real screens and recordings; the acceptance test `e2e/northstar.e2e.ts`; pull request #113, opened by Botbench on its own repository; the *What works today* table with a code path for every row.
6. **Boundaries, said once, where the reader decides:** macOS only, build from source, early, the subscription terms are the vendor's decision, a separate copy is not a security boundary, no hosted service, never merges.

**Value line (owner):** Less agent babysitting. Less coordination overhead. More dependable work delivered.

## Objections

| Objection | Response (truthful, with where it is said) |
|---|---|
| "Why not use Claude Code directly?" | You can, and Botbench never takes a tool away from it. It adds a separate copy and branch per task, approvals you can answer from your phone, your checks run and kept, a second vendor's review, a record of what ran, and a view of your teammates' workbenches. (README, Questions) |
| "Is it safe to let an agent run while I'm away?" | Commands are confined by the macOS sandbox, dangerous actions always ask or are refused, and a fully autonomous run accepts only under stated conditions. It is not a virtual machine or a container; point it only at repositories you trust. (README, Is it a sandbox?; `docs/security/threat-model.md`) |
| "May I use my subscription this way?" | That is the vendor's decision. Botbench runs each vendor's own unmodified program under your sign-in and never reads your credentials. Check your subscription's terms. (README) |
| "Does my code leave my Mac?" | Yes, as it does when you use the agents directly; Botbench adds nothing else unless you chose it. (README, What leaves your Mac) |
| "I'm on Linux / Windows." | Not supported: agents are started only on macOS. Say so first. |
| "Does it need a server for my team?" | No shared server and no accounts. Workbenches meet in the shared GitHub repository; pairing is direct between two listeners. |
| "Is anyone using it?" | Its author, on its own repository. Never imply more. |
| "Ten minutes to build from source is a lot." | It is the honest number; a shorter first run is planned (#174). |

**Anti-persona:** Windows or Linux users; anyone who wants a hosted service, a shared team server or an installer; anyone who needs a hard security boundary for code they do not trust; anyone who needs a stable, unchanging tool.

## Switching Dynamics

All four are hypotheses until users say them.

**Push:** watching terminals for permission prompts; not knowing what an agent ran; colliding with a teammate's agents.
**Pull:** a branch with checks and a review waiting when you return; answering from the phone; hearing about a collision first.
**Habit:** the CLI in a terminal already works; GitHub and Slack already carry team coordination.
**Anxiety:** a 10-minute build from source; macOS only; early software that changes often; whether the vendor's terms allow unattended use; running agents with your rights.

## Customer Language

No customer quotes exist yet. The phrases below are the owner's and the product's, not customers'. Replace them with verbatim user language as it arrives.

**How they describe the problem (owner's words, `README.md`):** "You find out you both took the same issue when the second pull request opens." "The two of you become the messengers."
**Words to use:** task, run, branch, separate copy, checks, review, Accept, Reject, Ready for review, Needs input, workbench, teammate, pull request, issue, claim.
**Words to avoid:** sandboxed (unqualified), verified pull requests, autonomous team, agents that talk to each other (as the value), unique, first, only, production-ready, seamless, any count of users, any speed or outcome number. On screens, also the voice glossary's banned words (`docs/product/voice.md`).

**Glossary:**

| Term | Meaning |
|---|---|
| Workbench | One Botbench installation, with a name that goes into its branches |
| Task | A prompt and a repository; built in its own copy on its own branch |
| Run | A prompt or spec that Claude Code plans into tasks |
| Separate copy | The task's git worktree; separates changes, not a security boundary |
| Check | One of the repository's own commands, run on the work |
| Review | Another vendor's agent reading the change: a model's opinion, not a check |
| Claim | Two empty branches on the remote that say a workbench started on an issue; the remote accepts only the first |
| Check together | Merging your task with another workbench's open pull request in a temporary copy and running the checks on the merge |
| Paired workbench | One other workbench this one talks to directly, questions and answers only |

## Brand Voice

Governed by `docs/product/voice.md` for the screens and by the README standard for the README. For marketing copy:

| Attribute | Means | Doesn't mean | Example line |
|---|---|---|---|
| Exact | Every claim has its condition | Hedging every sentence | "A passing check proves only what the check covers." |
| Calm | Plain declaratives, one punch per page | Hype, exclamation marks | "Walk away. Come back to the branch." |
| Evidence-first | Show the screen or name the file | Adjectives in place of proof | "Real screens and recordings. View their source." |
| Owner-centred | You decide; Botbench never merges | Agents as autonomous coworkers | "Every message between workbenches is one its owner approved." |

**Tone by context:** errors say what happened, why if known, what to do next; launches state what shipped and what did not; social copy keeps the same truth boundary as the README.
**Never use (and why):** "unique"/"first"/"only" (the competitive review cannot support it); "sandboxed" without its limits (it is not a VM); any user or outcome number (none exists); testimonials (none exist).

## Proof Points

**Metrics:** None. Do not invent any.
**Customers:** None named. "Its author, on its own repository."
**Testimonials:** None. Do not write any.

### Capability inventory

States: **Implemented and verified** (code and tests in the repository; may be demonstrated), **Early** (works in a first, limited form; must carry its caveat), **Recorded or replayed** (shown in committed media), **Planned** (never shown as working).

| Capability | Evidence | User problem | Marketing use | State |
|---|---|---|---|---|
| Tasks and runs; plan approval | `src/engine/`, `e2e/plan.e2e.ts`, `e2e/run.e2e.ts` | Agents start without a plan you agreed | "Approve the plan, then walk away" | Implemented and verified; Recorded (demo) |
| Separate copy and branch per task, `botbench/<workbench>/run-<n>/task-<n>` | `src/worktrees.ts`, `test/worktrees.test.ts`, `test/engine/workbench-branches.test.ts` | The agent edits your checkout | "Your branch is untouched" | Implemented and verified |
| Three modes | `src/engine/modes.ts`, `test/engine/modes.test.ts`, `e2e/modes.e2e.ts` | All or nothing autonomy | "Choose how much each run needs you" | Implemented and verified |
| Approvals and the safety rules; confined commands | `src/approvals/`, `src/confinement.ts`, `e2e/approval.e2e.ts`, `e2e/sandbox.e2e.ts` | Prompts in a terminal you must watch; agent runs with your rights | "Answer from your phone"; Check a command screen | Implemented and verified; Recorded (`permissions-check.png`, `first-task-phone.mp4`) |
| Repository checks | `src/engine/stations.ts`, `test/engine/verify.test.ts`, `e2e/verify.e2e.ts` | "Done" is the agent's word | "Your checks, run and kept" | Implemented and verified; Recorded (the check really ran) |
| Another vendor's review, labelled a model's opinion | `src/engine/review.ts`, `src/engine/refine.ts`, `e2e/review.e2e.ts` | One model marking its own homework | "A second opinion, labelled as one" | Implemented and verified; Recorded (Codex's review in the demo) |
| Accept / Reject; never merges | `src/engine/decision.ts`, `e2e/decision.e2e.ts` | Losing control of what ships | "You decide" | Implemented and verified |
| Pull request for an accepted task | `src/engine/delivery.ts`, `e2e/delivery.e2e.ts`; PR #113 | Hand-off to the team's normal review | "Opened as a pull request, never merged" | Implemented and verified (PR #113 is real) |
| Run from a GitHub issue, as outside text | `src/engine/intake.ts`, `e2e/intake.e2e.ts` | Copying issue text into a prompt | "Start from the issue" | Implemented and verified |
| Usage-limit wait and hand-over to another agent | `src/engine/usage-limit.ts`, `src/engine/handoff.ts`, `e2e/handoff.e2e.ts`; `docs/media/move-to-codex.gif` | Work stops at the limit while you are away | "It waits, or moves to Codex" | Implemented and verified; Recorded |
| Phone access over a private network | README, Use it from your phone; `src/api/auth.ts` | Must be at the Mac to answer | "Your phone can bring you back to it" | Implemented; not part of the tested quickstart. Home Screen app and notifications: in the code, not confirmed on a real iPhone |
| Named workbenches | `src/workbench.ts`, `e2e/peers.e2e.ts` | Two installations' branches clash | "Branches never clash" | Implemented and verified |
| Read-only view of other workbenches' open PRs and pushed branches | `src/engine/peers.ts`, `e2e/peers.e2e.ts` | You cannot see a teammate's agents' work | "See each other's work" | Implemented and verified; Early as part of coordination |
| Overlap warning (issue at start; files at review) | `web/src/app/peers.ts:157`, `web/src/screens2/task/task-screen.tsx:336`, `test/peers-words.test.ts` | Learning of a conflict when both are merged | The realization moment: "also changes calc.py" | Implemented and verified (unit and screen); no committed screenshot yet |
| Issue claims (opt-in `claimIssues`); later run stops | `src/engine/claims.ts`, `test/engine/claims.test.ts`, `e2e/northstar.e2e.ts` | Two people take the same issue | "studio-mac started first" | Implemented and verified (acceptance test, live Claude Code, replayed gh); no committed screenshot yet |
| Check together with another workbench's open PR | `src/engine/combined.ts`, `test/engine/check-together.test.ts`, `test/api/check-together.test.ts`, `web/src/components/check-together.tsx` | Two changes pass alone and fail together | "Passed together" | Implemented and verified (unit and API); no committed screenshot yet |
| Pairing one other workbench | `src/peers/`, `e2e/paired.e2e.ts`, `docs/pairing.md` | Relaying questions between two agent conversations | "Ask the other workbench" | Early: one pairing per installation; tested with two installations on one Mac, not across two Macs |
| Owner-approved questions and answers between paired workbenches | `src/peers/conversation.ts`, `e2e/paired.e2e.ts` | Same | "Every message is one its owner approved" | Early; Recorded (`paired-question.mp4`, `paired-question.png`) |
| Commands in one Docker container per task (opt-in) | `src/execution.ts`, `docs/adr/0009-container-execution.md` | Wanting more separation for commands | Mention only in configuration | Implemented, off by default; not a default isolation claim |
| Six more peer message kinds, autonomous cross-owner coordination, dependencies (#172), cross-Mac pairing, shorter first run (#174) | README, Where it is going; #154, #172, #174 | | Roadmap only, never animated or shown as working | Planned |

### Claim → evidence table

Every meaningful claim the README and the website make. Status: **Supported** (evidence matches), **Supported with condition** (true only with the stated condition nearby), **Fix** (wrong or misleading as written), **Remove** (cannot be supported).

| # | Claim (where) | Evidence | Kind | Status |
|---|---|---|---|---|
| 1 | Each task works in its own copy on its own branch; Botbench does not touch your files or your branch (README, site Workbench) | `src/worktrees.ts`, `test/worktrees.test.ts`; quickstart step 8 | Inspected | Supported |
| 2 | Hand a task to Claude Code or Codex (README, site home) | `src/drivers/claude-code.ts`, `src/drivers/codex.ts` | Inspected | Supported with condition: Claude Code is required (it plans); Codex can build once Botbench's check finds that it can |
| 3 | "macOS · Node 24+ · Claude Code or Codex" (site closing band on all 8 pages) | Quickstart prerequisites | Executed (rendered) | **Fix**: Claude Code is required; Codex is optional |
| 4 | Your repository's checks run and their output is kept (README, site Evidence) | `src/engine/stations.ts`; demo check really ran | Inspected, Recorded | Supported |
| 5 | Another vendor's review is "a model's opinion, not a check" (README, site) | `src/engine/review.ts`; voice glossary | Inspected | Supported |
| 6 | It never merges a pull request (README, site) | `src/engine/delivery.ts`; CLAUDE.md hard rule | Inspected | Supported |
| 7 | An action that reaches outside the copy waits for your answer; dangerous ones always ask or are refused (README) | `src/approvals/gate.ts`, `e2e/approval.e2e.ts`, `e2e/refused.e2e.ts` | Inspected | Supported |
| 8 | Commands are confined by the macOS sandbox, which is not a VM or container (README, site) | `src/confinement.ts`, threat model | Inspected | Supported with condition (stated) |
| 9 | Answer approvals from your phone (README, site) | Private-network setup, README | Inspected | Supported with condition: needs a private network with HTTPS names; not part of the tested quickstart |
| 10 | Pick it up on your Mac or phone (site hero) | Same | Inspected | Supported with condition (as 9) |
| 11 | You see the other workbenches' open pull requests and pushed branches (README, site Coordination) | `src/engine/peers.ts`, `e2e/peers.e2e.ts` | Inspected | Supported with condition: both push to one remote, `gh` signed in on each Mac |
| 12 | Warned "under Your decision" when another workbench's PR changes the same files (README, Your team's coordination) | `web/src/screens2/task/task-screen.tsx:336`: shown on the Review tab under the changed files | Inspected | **Fix**: name the right place |
| 13 | Only one of you takes an issue; the later run stops and says who started first (README, site) | `src/engine/claims.ts:266,506`, `e2e/northstar.e2e.ts` | Inspected | Supported with condition: `claimIssues` on in each settings file, run from an issue that opens pull requests |
| 14 | Check two changes together before either is merged (README, site) | `src/engine/combined.ts`, `test/engine/check-together.test.ts` | Inspected | Supported with condition: proves only what the checks cover; counts while both heads are unchanged |
| 15 | Every message between workbenches is one its owner approved (README, site) | `src/peers/conversation.ts`, `src/peers/drafts.ts`, `e2e/paired.e2e.ts` | Inspected, Recorded | Supported (Early) |
| 16 | Pairing tested with two installations on one Mac, not across two Macs (README, site) | `docs/pairing.md`, `e2e/paired.e2e.ts` | Inspected | Supported (the caveat is the claim) |
| 17 | No accounts or shared server (README, site) | No account code; peers listeners talk directly, `src/peers/` | Inspected | Supported |
| 18 | About ten minutes to a first branch; one short Claude Code turn on your subscription (README, site Get started) | Quickstart; steps 1 to 5 labels checked in a browser on an empty installation | Executed in part (build, start, sign-in, Chat and Add context labels); not timed, no model turn started | Supported with condition: the time is the owner's, not measured here |
| 19 | The demo is 25 seconds, recorded at 1440×900 at its real speed; agents replayed (README, site) | `e2e/media.shots.ts:236`, `docs/media/botbench-demo.mp4` | Inspected | Supported |
| 20 | Real screens; nothing on them was edited (README, site) | `e2e/media.shots.ts:186`; site `PROVENANCE.md` | Inspected | Supported |
| 21 | Botbench is built with Botbench where it can be; PR #113 is one it opened (README, site Evidence) | https://github.com/botbenchhq/botbench/pull/113 | Inspected | Supported |
| 22 | The acceptance test runs the whole story (site Evidence heading) | `e2e/northstar.e2e.ts` covers one autonomous run to a pull request and the second workbench's claim withdrawal; it does not cover the overlap warning or checking together | Inspected | **Fix** the heading's scope: "runs one issue from start to pull request, and the second workbench's withdrawal" |
| 23 | Codex, Grok or Antigravity review (README, site) | `src/drivers/`, `src/engine/review.ts` | Inspected | Supported |
| 24 | Nothing else leaves your Mac from Botbench itself (README) | README list; `src/update.ts` (release check) | Inspected | Supported (the list is the claim) |
| 25 | "Proof, not promises" (README heading, site Evidence h1) | Items 4, 5, 21 | | Supported as a heading; it is a contrast formula, keep it to one place |
| 26 | "Shared GitHub visibility shows the other workbenches' open pull requests" (site home) | Item 11 | | Supported; wording is jargon (see the surface audit) |
| 27 | Home Screen app and notifications (README, site Explore) | `src/push.ts` | Inspected | Supported with condition: not confirmed on a real iPhone |

## Goals

**Business goal:** Prove that two developers' workbenches collaborate better than their normal process (the North Star, `docs/product/positioning-concept.md`).
**Conversion action, by surface:**

| Surface | Primary action | Secondary |
|---|---|---|
| README | Follow the Quickstart to a first branch | Star or watch; read *What works today* |
| Site home | Build from source (to Get started) | Watch the demo; open the repository |
| Site Workbench, Coordination, Evidence | Build from source | The README section each page summarises |
| Site Get started | Run the steps; then the README Quickstart for detail | Set up checks for a repository |
| Site Explore, Docs | Find the code or document behind a claim | Build from source |
| Org profile | Open the botbench repository | The website |

**Current metrics:** None collected. The site has no analytics, by rule.

## Learnings

*Decisions and tested lessons. Newest first.*

| Date | Learning | Evidence | Applies to | Status |
|---|---|---|---|---|
| 2026-11-25 | Write claim times as the product does, "14:14:07 UTC on 2026-11-25", never "2:14 PM" | `claimTimeWords`, `src/engine/claim-branch.ts:155` | Scenes, cards, site, README | active |
| 2026-11-25 | The overlap line sits on the Review tab under the changed files, not in Your decision | `web/src/screens2/task/task-screen.tsx:336` | README, scenes | active |
| 2026-11-23 | Lead with the owner's two-capabilities framing; workbench and coordination are equals | `docs/product/positioning-concept.md`, Direction | All copy | active |

## Changelog
*Newest first.*
- v1 (2026-11-25) — Initial context, drafted from the repository, the live site and an empty installation; owner lines kept verbatim; claim → evidence table and capability inventory added.
