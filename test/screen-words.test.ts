import assert from "node:assert/strict";
import test from "node:test";
import { trayShows } from "../web/src/components/approval-tray.ts";
import { runSentence, runTaskNote } from "../web/src/components/run-status.ts";
import { bannedIn } from "../e2e/voice.ts";
import { plannerSilenceReason, silenceReason } from "../src/engine/silence.ts";
import { answeredOther, fileMarks, fileMarksLine, notMergedLine, offersMerge, statusLook, statusSentence, statusWord, taskTitle, waitingWords } from "../web/src/components/task-status.ts";
import { LOOKS } from "../web/src/components/looks.ts";
import type { PullRequestView, RunDetail, RunTask, TaskSummary } from "../web/src/api/client.ts";

// What the task, run and approval screens say in one line, decided without a browser.

const accepted = (decidedBy: "owner" | "mode", pullRequest: Pick<PullRequestView, "state" | "number">): Parameters<typeof statusSentence>[0] => ({
  status: "accepted",
  reason: null,
  baseCommit: "a",
  headCommit: "b",
  attemptId: 1,
  waitingOnApproval: false,
  parked: false,
  resuming: false,
  ofPlan: null,
  decision: { decidedBy } as TaskSummary["decision"],
  pullRequest,
});

test("an accepted task whose pull request is open says so, by its number, in either form of Accepted", () => {
  assert.equal(statusSentence(accepted("owner", { state: "opened", number: 12 })), "Accepted. Pull request #12 opened.");
  assert.equal(statusSentence(accepted("mode", { state: "opened", number: 12 })), "Accepted without you, as its run is fully autonomous. Pull request #12 opened.");
});

test("the task's changed files are marked in words: not expected from the plan, and protected", () => {
  assert.deepEqual(fileMarks({ expected: true, protected: false }), []);
  assert.deepEqual(fileMarks({ expected: false, protected: false }), ["Not expected from the plan"]);
  assert.deepEqual(fileMarks({ expected: true, protected: true }), ["Protected"]);
  assert.deepEqual(fileMarks({ expected: false, protected: true }), ["Protected", "Not expected from the plan"]);
  assert.equal(fileMarksLine([{ expected: true, protected: false }]), null);
  // A manual task that changed a protected file says so on its status line, as a fully autonomous one says why it waits.
  const held = { ...accepted("owner", { state: "none", number: null }), status: "awaiting_decision" as const, decision: null, reason: "It needs your review: It changed 1 file under a protected path, which only you can accept: test/recordings/a.json." };
  assert.equal(statusSentence(held), "Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it. It needs your review: It changed 1 file under a protected path, which only you can accept: test/recordings/a.json.");
  assert.equal(fileMarksLine([{ expected: false, protected: false }]), "1 file was not expected from the plan: the task's words, its checks and its tests do not name it.");
  assert.equal(
    fileMarksLine([{ expected: true, protected: true }, { expected: false, protected: true }, { expected: false, protected: false }]),
    "2 files are under a protected path, which only you can accept. 2 files were not expected from the plan: the task's words, its checks and its tests do not name them.",
  );
});

test("an accepted task with no pull request open still says the branch was kept", () => {
  const kept = "Accepted. Botbench kept the branch and removed the task's copy of the project.";
  assert.equal(statusSentence(accepted("owner", { state: "none", number: null })), kept);
  // While the push is under way, or after it failed, no pull request is claimed.
  assert.equal(statusSentence(accepted("owner", { state: "sending", number: null })), kept);
  assert.equal(statusSentence(accepted("owner", { state: "failed", number: null })), kept);
  assert.equal(statusSentence(accepted("mode", { state: "none", number: null })), "Accepted without you, as its run is fully autonomous. Botbench kept the branch and removed the task's copy of the project.");
});

test("the merge command is offered for a run that keeps branches, not for one that opens pull requests", () => {
  assert.equal(offersMerge({ pullRequest: { choice: "branch" } }), true);
  assert.equal(offersMerge({ pullRequest: { choice: "pull_request" } }), false);
});

test("the task screen's line on what left the machine is true before a decision, after one, and after a push", () => {
  assert.equal(notMergedLine({ decision: null, pullRequest: { pushed: false } }), "Nothing has been merged or pushed.");
  assert.equal(notMergedLine({ decision: { decision: "reject" }, pullRequest: { pushed: false } }), "Nothing has been merged or pushed.");
  assert.equal(notMergedLine({ decision: { decision: "accept" }, pullRequest: { pushed: false } }), "Nothing has been merged or pushed.");
  // Once the branch was pushed for a pull request, the line never says nothing was pushed.
  const pushed = notMergedLine({ decision: { decision: "accept" }, pullRequest: { pushed: true } });
  assert.equal(pushed, "Nothing has been merged. The branch was pushed for its pull request.");
  assert.doesNotMatch(pushed, /or pushed/);
});

test("a task is titled by its own words, cut at a word boundary, and by its number until they are read", () => {
  assert.equal(taskTitle(3, "Add a line to the README saying hello\nand more"), "Add a line to the README saying hello");
  assert.equal(taskTitle(3, "Create a file named hello.txt containing hi, then run ls to show the files"), "Create a file named hello.txt containing…");
  assert.equal(taskTitle(3, null), "Task 3");
  assert.equal(taskTitle(3, "   \n  "), "Task 3");
});

test("a task's title is never cut to one word: from 40 characters on it is cut at the first word boundary at or after the 40th, and a shorter one is whole", () => {
  // A long word right after the first: cutting before the 40th character would leave one word.
  const long = "Implement src/engine/very-long-module-name/with-a-long-file.ts so that it reads the config";
  const cut = taskTitle(3, long);
  assert.equal(cut, "Implement src/engine/very-long-module-name/with-a-long-file.ts…");
  assert.ok(cut.length - 1 >= 40 && long.startsWith(cut.slice(0, -1)));
  // Under 40 characters, whole, and so is a 40-character one with nothing after it.
  assert.equal(taskTitle(3, "Fix the login page on small screens"), "Fix the login page on small screens");
  assert.equal(taskTitle(3, "x".repeat(39)), "x".repeat(39));
  assert.equal(taskTitle(3, `${"a".repeat(20)} ${"b".repeat(19)}`), `${"a".repeat(20)} ${"b".repeat(19)}`);
  // Never shorter than 40 characters once cut, whatever punctuation is at the boundary.
  for (const prompt of ["Add a line to the README saying hello there, and then commit it", "one two three four five six seven eight nine ten eleven twelve", `${"word ".repeat(30)}end`]) {
    const title = taskTitle(3, prompt);
    assert.ok(title.endsWith("…"), prompt);
    assert.ok(title.length - 1 >= 40, `${title} (${title.length - 1})`);
    assert.ok(prompt.startsWith(title.slice(0, -1)), prompt);
    assert.ok(/\s/.test(prompt[title.length - 1] ?? " "), `cut at a word boundary: ${title}`);
  }
  // A first word of 40 characters or more is never the whole title: the cut comes after the second word.
  const word = "src/engine/a-very-long-module-path/file-name.ts";
  assert.ok(word.length >= 40);
  assert.equal(taskTitle(3, `${word} must read the settings file`), `${word} must…`);
  assert.equal(taskTitle(3, `${word}   must read`), `${word}   must…`);
  assert.equal(taskTitle(3, word), word);
  assert.equal(taskTitle(3, `${word} must`), `${word} must`);
  // A first line of one word is not the title on its own when more words follow on the next lines: they are joined.
  assert.equal(taskTitle(3, "Fix\n the login page"), "Fix the login page");
  assert.equal(taskTitle(3, "Refactor:\n\nmove the session code into its own module, then test it"), "Refactor: move the session code into its…");
  assert.equal(taskTitle(3, "Fix\n"), "Fix");
  // One long line with no later word boundary is shown whole rather than cut inside a word.
  assert.equal(taskTitle(3, `Rename ${"x".repeat(60)}`), `Rename ${"x".repeat(60)}`);
});

const task = (status: RunTask["status"]): Pick<RunTask, "status"> => ({ status });
const run = (tasks: Pick<RunTask, "status">[]): Pick<RunDetail, "status" | "reason" | "waitingOnApproval" | "tasks" | "attemptId" | "mode"> => ({ status: "running", reason: null, waitingOnApproval: false, tasks: tasks as RunTask[], attemptId: 1, mode: "manual" });

test("a run whose task is in review says so, not only that it is working", () => {
  assert.match(runSentence(run([task("accepted"), task("reviewing"), task("queued")])), /^In review\. /);
  assert.match(runSentence(run([task("building"), task("queued")])), /^Working\. /);
});

test("the header's tray is not shown on the screen that already shows every approval waiting", () => {
  const a = { id: 1 };
  const b = { id: 2 };
  assert.equal(trayShows({ pending: [a], showing: [], problem: null }), "tray");
  // The task's own screen shows its card: no tray, only the one live line that says it is here.
  assert.equal(trayShows({ pending: [a], showing: [1], problem: null }), "here");
  // Another approval waits elsewhere: the tray stays.
  assert.equal(trayShows({ pending: [a, b], showing: [1], problem: null }), "tray");
  assert.equal(trayShows({ pending: [], showing: [1], problem: null }), "nothing");
  assert.equal(trayShows({ pending: null, showing: [], problem: "Approvals could not be read." }), "tray");
  assert.equal(trayShows({ pending: null, showing: [], problem: null }), "nothing");
});

test("a task waiting for a usage limit says so in plain words, naming the time it tries again, with its own label and look", () => {
  // The reader's time zone and locale are named, so the words are the same on any machine the test runs on.
  const GB = { locale: "en-GB", timeZone: "Europe/London" };
  const at = (day: number, hour: number, minute: number): Date => new Date(Date.UTC(2026, 10, day, hour, minute));
  const waiting = { status: "waiting_for_limit" as const, reason: null, baseCommit: "a", headCommit: "b", attemptId: 1, waitingOnApproval: false, parked: false, resuming: false, ofPlan: 3, decision: null, pullRequest: { state: "none" as const, number: null }, retryAt: at(22, 14, 30).toISOString() };
  assert.equal(statusSentence(waiting, at(22, 9, 5), GB), "Waiting for a usage limit to reset. It will try again at 14:30.");
  // Another day is named.
  assert.equal(statusSentence({ ...waiting, retryAt: at(24, 8, 0).toISOString() }, at(22, 9, 5), GB), "Waiting for a usage limit to reset. It will try again on Tuesday 24 November at 08:00.");
  // The clock keeps the server's form for every reader, as the server's own restart line beside it does; the time zone is the reader's, where it is already tomorrow in Tokyo.
  for (const locale of ["en-US", "de-DE", "ar-EG"]) assert.equal(statusSentence(waiting, at(22, 9, 5), { locale, timeZone: "Europe/London" }), "Waiting for a usage limit to reset. It will try again at 14:30.", locale);
  assert.equal(statusSentence({ ...waiting, retryAt: at(24, 8, 0).toISOString() }, at(22, 9, 5), { locale: "en-US", timeZone: "Europe/London" }), "Waiting for a usage limit to reset. It will try again on Tuesday 24 November at 08:00.");
  assert.equal(statusSentence({ ...waiting, retryAt: at(22, 16, 30).toISOString() }, at(22, 9, 5), { locale: "en-GB", timeZone: "Asia/Tokyo" }), "Waiting for a usage limit to reset. It will try again on Monday 23 November at 01:30.");
  // The time has come and the task is being started again.
  assert.equal(statusSentence(waiting, at(22, 14, 31), GB), "Waiting for a usage limit to reset. It is trying again now.");
  assert.equal(statusWord(waiting), "Usage limit");
  assert.deepEqual(statusLook(waiting), LOOKS.usageLimit);
  assert.notDeepEqual(LOOKS.usageLimit, LOOKS.stopped);
  assert.deepEqual(bannedIn(statusSentence(waiting, at(22, 9, 5), GB)), []);
  // The run screen's row for it, and its transcript, use the same words.
  assert.equal(waitingWords(waiting.retryAt, at(22, 9, 5), GB), "Waiting for a usage limit to reset. It will try again at 14:30.");
  assert.equal(waitingWords(null, at(22, 9, 5), GB), "Waiting for a usage limit to reset.");
});

test("a task stopped because its agent went silent says so in words on the task screen and on the run screen, naming the limit", () => {
  // The reason as the engine stores it, with the shipped limit of 600 seconds.
  const reason = silenceReason("Claude Code", 600_000);
  const stopped = { status: "interrupted" as const, reason, baseCommit: "a", headCommit: "a", attemptId: 1, waitingOnApproval: false, parked: false, resuming: false, ofPlan: 3, decision: null, pullRequest: { state: "none" as const, number: null } };
  const words =
    "Claude Code went silent: it sent nothing for 10 minutes while it was working, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started. The work done up to then is committed. Resume starts Claude Code again where it left off.";
  assert.equal(statusSentence(stopped), `Stopped. ${words}`);
  assert.equal(runTaskNote(stopped), words);
  assert.equal(silenceReason("Claude Code", 60_000).includes("for 1 minute while"), true);
  assert.equal(silenceReason("Claude Code", 90_000).includes("for 90 seconds while"), true);
  // A planner that went silent fails its run, which says so.
  const planner = plannerSilenceReason("Claude Code", 600_000);
  assert.equal(runSentence({ status: "failed", reason: planner, waitingOnApproval: false, tasks: [], attemptId: 1, mode: "manual" }), "Failed. The planner went silent: Claude Code sent nothing for 10 minutes while it was planning, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started.");
  for (const text of [statusSentence(stopped), planner]) assert.deepEqual(bannedIn(text), [], text);
});

test("a task's model is mentioned only when the model that answered is not the one asked for", () => {
  const list = { driver: "claude-code", source: "cli" as const, models: [{ id: "haiku", label: "Haiku 5.5", resolved: "claude-haiku-5-5" }, { id: "sonnet", label: "Sonnet 5", resolved: "claude-sonnet-5" }], default: null, cliDefault: null };
  assert.equal(answeredOther(list, "claude-haiku-5-5", "haiku"), false);
  assert.equal(answeredOther(list, "haiku", "haiku"), false);
  assert.equal(answeredOther(list, "claude-sonnet-5", "haiku"), true);
  // Nothing answered yet, Claude Code's own default asked for, or the names not known yet: nothing is claimed.
  assert.equal(answeredOther(list, null, "haiku"), false);
  assert.equal(answeredOther(list, "claude-sonnet-5", null), false);
  assert.equal(answeredOther(null, "claude-haiku-5-5", "haiku"), false);
});
