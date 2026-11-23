# Experiment 2, first version: three workbenches, overlapping issues

Tracking issue: botbenchhq/botbench #169. Run on 2026-11-23 (UTC), on the owner's Mac.

## What was run

- Botbench at `origin/main` commit `0d4b131324085b32978eaedc07559b76f38d1fad`, from a temporary git worktree at `<scratch>/exp2/botbench` (now removed). Three instances from that one folder: exp-a on port 4796, exp-b on 4797, exp-c on **4799** (4798 was already held by another process I do not own, `node scripts/listener.js`; I left it alone). Each had its own `BOTBENCH_HOME` under `<scratch>/exp2/homes/`. One settings file, `<scratch>/exp2/botbench.local.json`, passed with `BOTBENCH_CONFIG`, held all three clones' settings keyed by path (confirmed in `src/config.ts`: `repositories` is keyed by full path, matched by real path). Per clone: `"checks": ["npm test"]`, `"claimIssues": true`. Also `autonomy.mode: "semi"`, `maxCheckFixRounds: 1`, Claude Code model `haiku`. The settings file's `workbench` key is global, so the names were set per instance through `PUT /api/settings`.
- Claude Code 2.1.322, model `claude-haiku-5-5` everywhere (planner and builder in arm A, the sessions in arm B). No reviewer. Node 26.13.0. Nothing ran with permissions bypassed.
- Build note: `npm run build --prefix web` fails on a fresh checkout until the root `npm ci` is also run (the web type check reads `../src` and needs `@types/node`). The README quickstart only says `npm ci --prefix web`.
- Practice repository: **botbenchhq/botbench-experiment-overlap-1602d9** (private). It is `textkit`, a zero-dependency Node library: 8 source files under `src/`, one test file `test/basic.test.js`, `npm test` = `node --test test/`. Left in place with all pull requests open. Nothing was merged.
- Arm A was driven through the HTTP API by a script per developer (`<scratch>/exp2/dev.mjs`). It acts only on what that workbench's API returns. The warning words were made by importing Botbench's own `web/src/app/peers.ts` (`issueWarnings`, `overlapLines`, `oldClaims`), the same functions the composer and the task screen call, on the same `/api/peers` view, so the words are the ones the screens show. Logs: `<scratch>/exp2/arma/*.jsonl`.
- Arm B: three `claude -p` sessions, default permission mode, `--allowedTools Read Edit Write Glob Grep "Bash(npm test)" "Bash(npm test:*)" "Bash(node --test:*)" "Bash(git:*)" "Bash(gh issue view:*)" "Bash(gh pr create:*)"`, each in its own fresh clone, each given its whole ordered list in one prompt (`<scratch>/exp2/armb/run.sh`).
- Arm B ran first (11:11 to 11:13). That way its sessions could not see Botbench's pull requests. Botbench's view of other workbenches lists only `botbench/<workbench>/…` branches, so arm B's pull requests did not show up in arm A's warnings.

## Issue design

| # | Issue | Overlap |
|---|---|---|
| 1 | slugify leaves leading, trailing and repeated hyphens | independent |
| 2 | truncate returns one character more than max | independent |
| 3 | wordCount of an empty string is 1 | independent |
| 4 | isEmail rejects plus addresses | independent |
| 5 | formatMoney puts the minus after the dollar sign | same function as 6 |
| 6 | formatMoney: support EUR and JPY | same function as 5 |
| 7 | formatDate does not zero-pad | needs a pad helper, like 8 |
| 8 | Add formatDuration HH:MM:SS | needs a pad helper, like 7 |
| 9 | parseCsv splits quoted fields with commas | same bug as 10 |
| 10 | Contacts CSV import shifts columns after the address | same bug as 9, told as a user would |

The hidden acceptance tests are in `<scratch>/exp2/hidden/` (`run.sh <dir>`). All ten fail on the seed.

Ordered lists: everybody starts with 5. Then exp-a / dev-a took 6, 1, 9; exp-b / dev-b took 7, 2, 10; exp-c / dev-c took 8, 3, 4. The starts were 20 s apart in both arms.

## Results

| | Arm A: Botbench, claims on | Arm B: 3 plain `claude -p` |
|---|---|---|
| Pull requests opened | 11 (#22 to #32) | 11 (#11 to #21) |
| Issues with more than one PR (9+10 counted as one piece of work) | **2**: issue 4 (#31, #32, from the stale-claim takeover, see below) and 9/10 (#30, #29) | **2**: issue 5 (#11, #16) and 9/10 (#15, #20) |
| Pairs that conflict when merged two at a time onto main | 6: two in source files (5×6 in `src/money.js`, 9×10 in `src/csv.js`) and four in `test/basic.test.js` only (2×3, 7×8, 8×9, 8×10) | 6: five in source files (5×5′, 5×6 twice, 7×8 in `src/dates.js`, 9×10) and one in the test file only (2×3) |
| Merging in issue order onto main, skipping a branch that conflicts | 4 failed to merge (3, 6, 8, 10). The two issue-4 PRs have identical content and merged together cleanly | 5 failed to merge (3, the second 5, 6, 8, 10) |
| Merged results that fail the repository's tests | 0 | 0 |
| Issues nobody finished | 0 | 0 |
| Hidden tests, each PR's branch on its own | 11 of 11 PRs pass their issue's test | 11 of 11 |
| Hidden tests on the merged result | 7 of 10 (3, 6, 8 fail: their branches did not merge) | 7 of 10 (3, 6, 8 fail, same reason) |
| Human interventions, tool asked me | 23: exp-a 8, exp-b 9, exp-c 6. That is 11 plan approvals (a run from an issue always asks), 11 accepts, and 1 approval card (exp-b, issue 10, a `cat > src/csv.js <<'EOF'` heredoc) | 0. Headless runs cannot ask: 10 commands were denied (compound `find`/`for` commands, a heredoc, one `gh pr create` with `$(printf …)`), and the agents worked around each one |
| Human interventions, I had to untangle | 2: exp-b confirmed taking over exp-c's claim; exp-c's Botbench had to be restarted | 0 |
| Runs that needed a restart or manual repair | 1 (exp-c's issue 4 run, killed on purpose) | 0 |
| Agent runs | 12 Botbench runs = 23 Claude Code turns (exp-a 8, exp-b 9, exp-c 6). Two of those runs (1 turn) were my probes for the stale claim; one probe was stopped by the claim before it used any tokens | 3 sessions (30, 34 and 40 turns inside them) |
| Wall time | 11:14:10 to 11:16:35 for all work but issue 4, then issue 4 at 12:17:39 (held by the stale claim) | 11:11:18 to 11:13:12 |

Neither arm meets the pass line in `experiments.md`. Arm A had a duplicate PR for one issue, and the same number of conflicting pairs as arm B (6 and 6). Arm A had fewer conflicts in source files (2 against 5). Most of that difference comes from issue 5 being done once instead of twice, and from where the agents happened to place the code for 7 and 8. Botbench did not cause the second part. The repository has a single test file, so every conflict outside the source files is an artefact of how small it is.

### What Botbench warned, and whether it came in time

Before Send (composer), on the attached issue:
- exp-b, issue 5, 11:14:29: "exp-a started on this issue less than a minute ago." exp-b skipped to 7. This came in time: no work was wasted.
- exp-c, issue 5, 11:14:55: "exp-a already has pull request #22 open for this issue." and "exp-a started on this issue less than a minute ago." exp-c skipped to 8. In time.
- Every other start showed no warning, as expected: issues 9 and 10 have different numbers, so there was nothing to warn about.
- Because of these warnings, the remote's claim race (two workbenches pushing a claim at once) never happened on the normal path. It was only exercised by the stale-claim probe below. In arm B, dev-b noticed by itself that the branch `fix/5-formatmoney-negative-sign` already existed and did not open a second PR. dev-c chose a different branch name and opened #16.

At review (Your decision), 17 overlap lines in the main pass. **Only one named a source file**: exp-a, issue 9, 11:16:27: "exp-b's open pull request #29 also changes src/csv.js and test/basic.test.js, so the two may conflict when both are merged." That was the 9/10 duplicate. The line came after exp-a's agent had already done the work. My driver accepted it, and so opened the duplicate PR. A careful developer reading that line could have rejected the task and opened no second PR, but the wasted work could no longer be avoided. The other 16 lines named only `test/basic.test.js`, so they were noise for deciding anything.

### What Botbench did not catch

- **9 and 10**, as expected: claims are by issue number, and both were done (#30, #29).
- **7 and 8**, as expected: each added its own zero-padding (`padStart` inline in #23, a local `pad` in #25). Arm B did the same.
- **5 and 6 by the same workbench**: exp-a built both from main, one after the other, and they conflict in `src/money.js`. There is no warning about your own open pull requests, and each run starts from main, not from the previous run's branch.
- **A missed overlap from the 60-second cache**: exp-c's review of issue 8 at 11:15:20 listed only #22, though exp-b's #23 (`src/dates.js`) had opened at 11:14:59. The view of other workbenches is kept for 60 s (`PEERS_FRESH_MS`).
- **Claim branches stay after a PR**: both claim branches of every issue that got a PR stay on the remote, so the Work screen keeps saying "Started on issue #N" next to the PR.

## Stale claim timeline (issue 4, exp-c)

| Time (UTC) | What happened |
|---|---|
| 11:16:03 | exp-c starts issue 4 and pushes its claim (`botbench/claims/issue-4`, `botbench/exp-c/run-3/issue-4-at-20261123T111603365Z`) |
| 11:16:19 | Task ready; accepted; `kill -9` on exp-c's server right then, before the push and PR |
| 11:16:47 | exp-b's composer: "exp-c started on this issue less than a minute ago." Nothing says exp-c is stopped. No takeover offered |
| ~11:16:50 | Takeover asked through the API anyway: refused, "exp-c started on issue #4 less than an hour ago. Only a claim at least an hour old can be taken over." |
| 11:16:56 | Plain start ignoring the warning: within 3 s the run stopped. "exp-c started on issue #4 at 11:16:03 UTC on 2026-11-23, before this workbench did (11:16:56 UTC on 2026-11-23), so this run stopped: when two workbenches start on one issue, the earliest claim goes ahead. The remote refused this workbench's claim, so nothing of this run was pushed." |
| 12:16:37 | exp-b's composer: "exp-c started on this issue 60 minutes ago." Takeover now offered |
| 12:16:54 | exp-b takes it over (one confirm). "You took over exp-c's claim from 11:16:03 UTC on 2026-11-23; its branches stay on the remote as they are." |
| 12:17:22 | exp-b opens PR #31 for issue 4 |
| 12:17:28 | exp-c restarted |
| 12:17:36 | exp-c, with nobody acting, finishes delivering its accepted task and opens PR #32 for issue 4. It gives no warning: its own lock is still there, so the check before sending lets it go |

For another workbench, the issue was blocked for 60 min 18 s, from the kill to the moment a takeover was offered. The one-hour minimum counts from the claim time, so it cannot be shorter. Restarting the stopped workbench unblocks it in seconds. **Doing both produces a duplicate PR**: after a takeover, nothing stops the original holder from delivering when it comes back. Here the two PRs happen to be identical.

## What could not be tested, and why

- A true simultaneous claim race on the normal path: the composer warning stopped every second start first. The remote's refusal was only seen in the probe.
- A workbench killed while its builder was mid-turn: the haiku builds took 4 to 15 s, and the kill landed between accept and delivery. Resuming a mid-turn builder after a restart was not observed.
- Paperclip and OpenAgents arms: not run.
- The web UI: not used. The API and the screens' own warning functions were used instead, so layout and visibility on screen were not checked.

## Limits of this first version

One person (me) acted as three developers, through a script with fixed rules: skip on a composer warning, approve every plan, accept every ready task. It did not act on review-time warnings, as a person might have. The practice repository was built for this test, has a single test file and very small issues: every build took seconds, so the timing overlaps are much shorter than real work would make them. There was one run per arm, so there is no variance. Arm B's sessions were each given their whole list at once, while Botbench needs one run per issue. The model was Haiku throughout.
