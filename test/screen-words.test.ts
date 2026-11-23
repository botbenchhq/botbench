import assert from "node:assert/strict";
import test from "node:test";
import { trayShows } from "../web/src/components/approval-tray.ts";
import { runSentence } from "../web/src/components/run-status.ts";
import { answeredOther, notMergedLine, offersMerge, statusSentence, taskTitle } from "../web/src/components/task-status.ts";
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
