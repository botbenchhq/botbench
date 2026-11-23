import assert from "node:assert/strict";
import test from "node:test";
import { trayShows } from "../web/src/components/approval-tray.ts";
import { runSentence } from "../web/src/components/run-status.ts";
import { answeredOther, notMergedLine, taskTitle } from "../web/src/components/task-status.ts";
import type { RunDetail, RunTask } from "../web/src/api/client.ts";

// What the task, run and approval screens say in one line, decided without a browser.

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
