# Product review: Botbench against its North Star

Date: 2026-11-22. Reviewed at commit `08b124c` (main, after #46). Scope: the repository only; no CLI, phone or live run was used.

North Star (`docs/plans/2026-11-21-2234-feat-botbench-software-factory-plan.md:584`): "from my phone I hand Botbench a piece of work, walk away, and come back to a branch I can trust, built and reviewed by more than one vendor's agent."

Rules it is judged against: least effort to prove value (`docs/lessons.md:5`), nothing fake, clean screens, honest claims (`CLAUDE.md`, `DESIGN.md`, `docs/product/voice.md`).

## 1. Verdict in five lines

Yes, on track: every piece the North Star needs is now in the code, but it has not been proven as one journey.
A run can plan with Claude Code, build without asking in a fully autonomous mode, be reviewed by Codex, Grok or Antigravity, have the review sent back for fixes, be accepted by the mode, and open a pull request.
Not proven: no single test or recorded owner check walks that path from a phone, and install and notifications are unconfirmed on a real iPhone.
The README still says most of this is "Planned, not in this code" and that every command asks, so a reader is told the product does less, and is safer, than it is.
Next: one end-to-end North Star test and one real phone run, then fix the README, before any new feature.

## 2. What is real today

Each line names the file opened for it.

- Claude Code plans and builds, one task at a time, each in its own worktree and branch `botbench/run-<n>/task-<n>`: `src/drivers/claude-code.ts` (capabilities at line 56: resume, interrupt, permission requests, edits, confined commands), `src/engine/run.ts:438` ("builds them one at a time"), `src/worktrees.ts`.
- Claude Code's shell commands run in its macOS sandbox with `failIfUnavailable`, `autoAllowBashIfSandboxed` false and `allowUnsandboxedCommands` false: `src/drivers/claude-code.ts:55` and `:96-100`, with the per-repository rules in `src/confinement.ts`.
- Approval cards, commands allowed in advance, Always allow, and a safety floor whose commands ask the owner in manual and semi-autonomous runs and are refused in fully autonomous runs: `src/approvals/broker.ts`, `src/approvals/grants.ts`, `src/approvals/floor.ts:276`.
- Three modes per run, fixed at start: `src/engine/modes.ts:6-14`. Fully autonomous refuses to start on a repository with no checks: `src/engine/run.ts:717`. It accepts a task only when every check passed, the review is satisfied or absent, and nothing was refused: `src/engine/modes.ts:80-86`. Refusals are logged as `mode_refused`: `src/approvals/broker.ts:104`.
- Reviewers from other vendors, review-only: Codex, Grok, Antigravity, each with `permissionRequests: false, edits: false`: `src/drivers/codex.ts:46`, `src/drivers/grok.ts:44`, `src/drivers/antigravity.ts:46`. A builder role is refused to them: `src/engine/roles.ts:184`.
- The refine loop: concerns go back to the builder, checks run again, the reviewer looks again, default 2 rounds, at most 5: `src/engine/refine.ts:6-19`.
- Checks and setup commands per repository, with output kept as evidence: `src/engine/stations.ts`, `src/engine/task.ts:488-499`.
- Accept, Reject and discard, with refusals checked before anything is removed: `src/engine/decision.ts:171`, `:196` (accept by mode), `:225`.
- Pull request delivery with the owner's `git` and `gh`, never by force, a ledger against a second pull request: `src/engine/delivery.ts:14-30`, `src/github.ts`.
- Recovery after a restart: `src/engine/recover.ts` (stopping a surviving process group at line 67, resume rules at line 145).
- Connect a subscription from Settings by relaying the CLI's own sign-in, parsed from captured real output: `src/drivers/connect.ts`, `src/drivers/sign-in.ts:75` and `:86`, `test/recordings/sign-in/`.
- Web push without a dependency, payload holding one fixed sentence and the screen path, with only a task or run number in it: `src/push.ts:63` (encryption), `:85` (VAPID), `:98-101` (messages).
- Usage in tokens with no dollar amount for subscriptions: `src/usage.ts`, `web/src/screens/usage.tsx:20-24`.
- Phone-width browser tests: `e2e/playwright.config.ts:24` (390 by 844).
- Live tests drive the real CLIs, for example a real Codex review turn that must fail to write a file or read a decoy (`test/live/review.live.test.ts`); replays come from captured real sessions (`test/recordings/`), which is the owner's one approved exception.

Nothing above is claimed to have run on the owner's machine; see section 8.

## 3. Five weakest points

Ranked worst first.

1. **The North Star has no yes-or-no test.** `docs/lessons.md:7` asks for one end-to-end test per milestone. The pieces are tested apart: modes in `e2e/modes.e2e.ts:54`, the refine loop in `e2e/refine.e2e.ts:60`, delivery in `e2e/delivery.e2e.ts:58` (the pull request replayed from `test/recordings/gh-delivery.json`). Nothing runs "fully autonomous + reviewer + refine + pull request" as one run, and the phone half is unconfirmed (`README.md:49`, `README.md:147`: "This was not part of the tested quickstart."). Cost to the user: the first time the whole path runs together may be the owner's real walk-away run, and a gap between the pieces shows up as a run that waits or stops while nobody watches.
2. **The README tells a user the wrong product.** `README.md:50` lists the refine loop, the three modes, pull requests, and Grok and Gemini as "Planned, not in this code"; all but Gemini CLI are in the code, and Gemini models are reached through the Antigravity CLI as a reviewer (section 6). `README.md:3` and `:22` say every shell command waits for an answer, which semi-autonomous and fully autonomous runs do not do (`src/engine/modes.ts:9-10`). Cost: a user does not learn they can walk away, and a user who picks a mode from Settings is told by the README that commands still ask. A claim about safety that is wrong in the safe-sounding direction is the worst kind for a tool whose value is trust.
3. **The default path is not the North Star path.** The composer starts on "One task" (`README.md:96`, `web/src/screens/turn.tsx:401`). A task started on its own is always manual (`web/src/app/composer.ts:30`) and has no reviewer, because a reviewer is found only through a run's plan (`src/engine/review.ts:88`). Cost: from the phone, the obvious action gives a single-vendor branch where every command asks; the North Star needs "Plan a run", a mode and a reviewer chosen in the Add context sheet.
4. **Only one vendor can build, and two of the three reviewers read text only.** No driver but Claude Code can build (`src/engine/roles.ts:184`). Grok and Antigravity have `tools: false` (`src/drivers/grok.ts:44`, `src/drivers/antigravity.ts:46`), so they read the diff in the prompt, cut at 60,000 characters (`src/engine/roles.ts:198`). Handoff to another subscription (U21, plan line 666) is not built: there is no `src/engine/handoff.ts`. Cost: when Claude Code hits its usage limit the run stops until the owner comes back, and a large change is reviewed in part by a model that cannot open the files.
5. **The task screen buries the decision under paragraphs.** On a task waiting for the owner, `web/src/screens/task.tsx` shows `CHECKS_RISK` under the checks when checks are set up (line 259; `web/src/components/evidence.tsx:172`, about 70 words), `REVIEW_RISK` under the review when the run has a reviewer (line 267; `evidence.tsx:181`, about 60 words), then a paragraph of about 150 words with the branch (line 338), then the decision text (line 358). Cost: on a 390-pixel phone, the owner of a reviewed run with checks scrolls past about 280 words of disclaimer on every task to reach Accept. A task accepted by a fully autonomous run shows no Accept control, but the same reading stands between the owner and the result.

## 4. Effort that added no value

Value here means it moved the North Star forward or proved it. Each item was done before the North Star was proven, which `docs/lessons.md:5` already names as the mistake.

- Positioning and market work: `docs/product/positioning-concept.md` (192 lines), `docs/product/peers-concept.md`, commit `f82ed67` ("four pillars and market assessment"). A one-owner tool with no users does not need a market position yet.
- Copy research: `docs/product/ui-copy-research.md` (350 lines). The glossary in `docs/product/voice.md` is what the tests enforce; the research behind it is ten times its size.
- The rename from Smelt and the code that migrates an old install: commit `b4110e4`, and `src/store/move-home.ts` (138 lines, header at line 10) that moves `~/.smelt` for an installation only the owner ever had.
- Design-system churn: five adoptions or syncs (`ecfdf60` 0.3.0, `acdf201` 0.4.0, `be2db51` 0.7.0, `b269b20` 0.7.3, `08b124c` 0.8.1), plus seven logo SVGs in `assets/svg/` and a design page `docs/design/index.html` (259 lines). `web/design-gaps.json` is empty, so the syncs found nothing to fix in the screens.
- Voice input transcribed on the Mac: `docs/adr/0003-voice-input-on-the-mac.md`, `src/dictation/dictation.ts` (253 lines), `src/dictation/helper.swift`, needing Xcode tools and ffmpeg. It follows an owner direction (no third party), but the phone keyboard already dictates, and it does not bring "walk away" closer.
- README written, then reworked to a README standard (`cc858de`, `c409f0e`, `docs/product/readme-standard.md`), and seven features later it is behind the code (section 6). A README that has to be rewritten after each feature should be shorter.
- Tests run twice per unit, about an hour each, mostly waiting: recorded in `docs/lessons.md:12-13`. Fixed in the rules since; listed because it was the largest single cost.
- A second list of tasks: `web/src/screens/tasks.tsx` shows what the board already shows (`web/src/screens/board.tsx:138`: "A task you start on its own is here too.").

## 5. Design

One line per file under `web/src/screens/`.

- `board.tsx`: clean. Remove the header description "What needs you first, then what is running, then what has finished. A task you start on its own is here too." (line 138); the Needs you / Running / Finished selector says it. The empty state is too long: "A run makes a list of tasks from a prompt or a spec file, for you to edit and approve. Botbench then builds each task in a separate copy of the project and shows you what it did, for you to accept or reject." (line 59); one sentence and New run would do.
- `run.tsx`: not clean; too many explanations. Too long: "Request changes sends the plan as it stands here, with this feedback, back to the planner, and its new plan takes this one's place." (line 432); "You listed these when you started the run, for when its tasks are built. Planning uses none of them: every command it wants asks." (line 513); the cancel confirmation "Tasks that have finished keep their branches. The task being built is stopped, and what it did so far is committed to its branch. Tasks that have not started are not built. A cancelled run cannot be started again." (line 308). "planner" is a role word the glossary allows only where needed (`docs/product/voice.md:36`); "the plan is sent back" says it. Remove the repeated `CHECKS_RISK` paragraph from the run screen (line 493; quoted under `task.tsx`).
- `settings.tsx`: clean. Five sections, each real. "Reviews a run's tasks when you choose it for a run; it cannot plan or build here." (line 21) could be "Reviews runs."
- `sign-in.tsx`: clean. "Botbench's data directory" (line 28) is jargon; say `~/.botbench/login-token`.
- `task.tsx`: not clean; the worst screen. Remove or fold the 150-word paragraph that starts "Nothing has been merged or pushed. Claude Code may read and change files inside this task's copy of the project without asking." (line 338); it also uses "(a git worktree)", allowed only in helper text. Too long: "You listed these when you started the task. They run without asking, with further arguments too, unless Botbench's safety rules catch them (git push, sudo, deleting outside the task's copy and the like) or they are chained, piped or redirected: those still ask." (line 216). Remove "This is Claude Code's latest session on this task. Its 1 earlier session is kept in Botbench's records, not shown here." (line 233); it tells the owner about something they cannot open. Too long, under every checked task: "Checks run this repository's own commands on the agent's work, on this Mac, in a sandbox: they cannot read the sign-in, key and credential folders Botbench keeps them from or Botbench's own files, can change files only in this task's copy and a temporary folder, and reach the internet only at hosts allowed for this repository in Botbench's settings file. They can still read the rest of your home folder. The agent may have changed the code they run, so read the output, not only the result." (`CHECKS_RISK`, `web/src/components/evidence.tsx:172`, line 259). Too long, under every review: "A model's opinion of the changes, not a check. The reviewer read the diff where it could change nothing and reach no network. Botbench reads only its verdict line: with concerns, the builder is given the review to fix what it agrees with, under the same permissions as for its build, and the same reviewer looks again." (`REVIEW_RISK`, `evidence.tsx:181`, line 267); "verdict line" is jargon. Show both once, behind a disclosure, not under every result.
- `tasks.tsx`: clean, but a duplicate of the board. Remove the Tasks tab (`web/src/components/header.tsx:18`) and this screen, or the board's single tasks; five tabs on a phone is one too many.
- `trust.tsx`: mostly clean. Long: "Claude Code runs this without asking you during the Build step. The top folder of a task's copy, in this repository:" (line 134) for every row. "Refused without asking: fully autonomous" (line 28) reads as a label, not a sentence; "Refused: the run is fully autonomous" is plainer.
- `turn.tsx`: clean. The header "Claude Code 2.1.322 · signed in · subscription" (line 44) puts a version number on the chat screen; it belongs in Settings. "Claude Code works on a new branch, in a separate copy of the repository (a git worktree). Your own files and your branch are not touched." (line 454) is allowed by the glossary and is the right length.
- `usage.tsx`: clean. Remove the per-agent "cost" rows (lines 174-181), which repeat "Signed in with a subscription. It has no dollar amount, so none is shown." once per agent. In code, `"gemini-cli"` in `AGENT_NAMES` (line 17) names a driver that does not exist.

## 6. README claims the code does not fully back

- "It has Claude Code, the coding agent you already have, do the work in a separate copy of your repository, asks you before every shell command" (`README.md:3`). Gap: semi-autonomous and fully autonomous runs do not ask (`src/engine/modes.ts:9-10`, broker rule `mode_allowed` in `web/src/screens/trust.tsx:27`).
- "can have Codex review the result" (`README.md:3`) and "If you chose a reviewer, Codex then reads the change" (`README.md:23`). Gap: Grok and Antigravity review too (`src/drivers/grok.ts`, `src/drivers/antigravity.ts`, listed in `web/src/screens/settings.tsx:33-38`).
- "Nothing is merged and nothing is pushed." (`README.md:3`). Gap: a run set to "Open a pull request" pushes the task's branch (`src/engine/delivery.ts:14-19`). Nothing is merged is true.
- "You edit it or approve it. Nothing is built before you approve." (`README.md:20`). Gap: a fully autonomous run approves its own plan (`src/engine/run.ts:301`, "plan approved … by the run's mode, fully autonomous"; `web/src/screens/turn.tsx:455`, "Building starts on the plan without your approval.").
- "You read the diff, the checks and the transcript, and you Accept (the branch is kept) or Reject (you choose whether to keep the branch)." (`README.md:24`). Gap: a fully autonomous run accepts a task without the owner when its checks pass and the review is satisfied (`src/engine/modes.ts:80-86`, `src/engine/decision.ts:196`).
- "Every shell command the agent wants to run waits for your answer, unless you allowed that exact command in advance." (`README.md:22`). Gap: modes as above; Always allow also skips the card (`src/approvals/grants.ts`); and commands allowed in advance match "with further arguments too" (`web/src/screens/task.tsx:216`), not the exact command.
- "The reviewer's concerns going back to the builder; three modes per run (manual, semi-autonomous, fully autonomous; today every run is manual); opening a pull request for an accepted task; Gemini CLI and Grok" under "Planned, not in this code" (`README.md:50`). Gap: four of the five shipped: the review going back to the builder (`src/engine/refine.ts`), the three modes (`src/engine/modes.ts`), pull requests (`src/engine/delivery.ts`) and Grok (`src/drivers/grok.ts`), so "today every run is manual" is false. Gemini CLI did not ship: Gemini models are reached through the Antigravity CLI instead (`src/drivers/antigravity.ts`), and as a reviewer only.
- "Claude Code and Codex send your prompts and the code they read to their providers" (`README.md:35`). Gap: incomplete; Grok and Antigravity send the diff to theirs (`src/engine/review.ts:10-17` sends the diff to whichever reviewer is chosen).

No claim was found that describes a feature the code lacks; the gaps are claims that are out of date or narrower than the code.

## 7. Next three things to build and three to stop

Build, in order:

1. **One North Star test.** An end-to-end test at phone width: Plan a run, fully autonomous, a reviewer, Open a pull request; it passes only when the reviewer first raises concerns, the builder makes a round of fixes, the checks run again, the same reviewer looks again and is satisfied, and then the task is accepted by the mode and its pull request is recorded. A captured first review with concerns (as in `test/recordings/refine-round.json`) makes the fix round certain to happen. Live model turns for plan and build, a captured reviewer and `gh` where a live one cannot be had on demand. This is the yes-or-no that `docs/lessons.md:7` asks for, and it finds the seams between the pieces.
2. **One real walk-away run from the iPhone, recorded as the milestone's owner check.** Install, notifications, a fully autonomous run on this repository with Codex reviewing, a pull request at the end. This is the only way to prove "from my phone" and "walk away" (U23 Verification, plan line 712).
3. **Make the North Star the default from the phone.** When a repository is chosen, offer the last-used run settings (mode, reviewer, delivery) so one message starts the trusted path, instead of the manual, unreviewed "One task" (`web/src/app/composer.ts:30`). Then shorten the task screen (section 5) so the end of the journey fits on a phone.

Stop:

1. **Stop design-system syncs and copy passes until the North Star test passes.** Five syncs found no gaps (`web/design-gaps.json`); they do not change whether a branch can be trusted.
2. **Stop concept, positioning and research documents.** `docs/product/positioning-concept.md`, `peers-concept.md`, `ui-copy-research.md` serve users the product does not have yet.
3. **Stop adding paragraphs to screens to explain safety.** Each mode has its own sentence in `web/src/screens/task.tsx:338`, on top of the sandbox paragraph. The threat model (`docs/security/threat-model.md`) is where the full limits live; the screen should state what happened, not every rule that applied.

The README fix (section 6) is not on either list because it is a one-hour edit that should go with the next change, not a feature.

## 8. What could not be verified from the repository alone

- Whether `npm test`, `npm run e2e` and `npm run test:live` pass at `08b124c`; none was run for this review.
- Real vendor CLI behaviour: Claude Code's sandbox holding on the installed version, Codex's permissions profile, Grok and Antigravity output formats, and whether recordings in `test/recordings/` still match current CLI versions.
- Phone use: installing to an iPhone Home Screen, receiving push through Apple's service, answering an approval from a notification, reaching the Mac over Tailscale HTTPS.
- Live runs: whether a fully autonomous run on a real repository finishes without stopping, how often the reviewer and builder agree within two rounds, and whether the branches are good enough to trust. That is the North Star's "trust", and only real runs show it.
- A real push and pull request through the owner's `gh` (the browser test replays captured `gh` output).
- The quickstart's "About ten minutes" and the plan's 15-minute first run (U24 Verification, plan line 723).
- Usage-limit behaviour of each subscription during unattended runs, and whether each vendor's terms allow this use (`README.md:38` leaves it to the user).
- Which owner checks from the plan's Verification lines were done; the repository records no owner sign-off per milestone.
