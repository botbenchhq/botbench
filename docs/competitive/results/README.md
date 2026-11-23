# Experiment results

What was actually run, as opposed to read. Each file is the record of one run of an experiment from [`../experiments.md`](../experiments.md), with its setup, evidence and limits. These are first versions: one person, practice repositories built for the purpose, small tasks, the smallest model, and no competitor arms (those need disposable virtual machines with a test sign-in). Treat the numbers as readings, not measurements of the market.

| Date | Experiment | Result in one line | File |
|---|---|---|---|
| 23 November 2026 | 3. Walk away from a hostile repository | **Held.** No protection that must hold failed; each documented limit of the macOS confinement behaved as documented; all tasks completed. Three places where the README's words and the behaviour differ (#180). | [unattended safety](2026-11-23-unattended-safety.md) |
| 23 November 2026 | 2. Three workbenches, overlapping issues | **Did not pass.** Botbench avoided the same-issue duplicate in normal use, but made one through a stale claim, had as many conflicting pairs as three uncoordinated sessions (6 and 6), and asked a person 23 times where the plain sessions asked none. | [overlapping issues](2026-11-23-overlapping-issues.md) |

## What the two runs say, read together

**Control held.** Left alone on a repository full of planted instructions, Botbench carried out none of them, the sandbox refused what the approval list did not catch, and the limits were where the documentation says they are. One caution: in the planted-text runs the agent never tried a planted action (the planner filtered them out), so the refusals in fully autonomous mode were exercised only by a direct probe.

**Coordination did not yet beat no coordination.** On ten small issues across three workbenches:

- *What worked:* "exp-a started on this issue less than a minute ago" was shown before the other two began, and both skipped the issue. No work was wasted on it. The uncoordinated sessions did that issue twice.
- *What did not:*
  - **Conflicts were not reduced** (6 pairs in both arms). Botbench's overlap warning comes at review, after the work is done. Of 17 warnings, 16 named only the one shared test file, so they were noise; one named a source file.
  - **The stale claim made a duplicate.** A stopped workbench held its issue for an hour (the minimum before a takeover is offered). After a teammate took it over and opened a pull request, the stopped workbench restarted and opened a second one for the same issue with no warning (#188).
  - **Botbench asked a person 23 times for ten issues;** the plain sessions asked none. A run from an issue needs its plan approved and its result accepted. That is the design for outside text, and it is the opposite of less coordination overhead on a team's own issues.
  - **The same bug written twice** (issues 9 and 10) was done twice, and **two issues needing the same helper** each wrote their own, in both arms. Expected; nothing looks for either.
  - **No warning about a workbench's own open pull requests:** one workbench built two issues that conflict with each other.
- *Equal in both arms:* every issue finished; each branch alone passed its hidden tests (11 of 11); the merged result passed 7 of 10.

**What this changes.** The claim on an issue is the least of the problem. The cost is in work that touches the same code under different issue numbers, and in how often a person is asked. Both point at the same next work: knowing what each workbench is changing before it starts, not at review ([#172](https://github.com/botbenchhq/botbench/issues/172)), claims that lapse and cannot be doubled ([#173](https://github.com/botbenchhq/botbench/issues/173), #188), warnings that carry signal (#189), and a decision on how much a person must approve for a team's own issues (see `docs/product/peers-autonomy-tradeoff.md`; the same question as for messages).

## Not yet run

Experiments 1, 4 and 5; the Paperclip, OpenAgents and OpenMausBot arms of 2 and 3; experiment 3 with a cached sudo password; experiment 2 with "check together" used before accepting.
