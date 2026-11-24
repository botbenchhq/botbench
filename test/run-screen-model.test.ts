import assert from "node:assert/strict";
import test from "node:test";
import type { RunTask, TaskStatus } from "../web/src/api/client.ts";
import { LOOKS } from "../web/src/components/looks.ts";
import { decidedCount, pullRequests, rowState, runControls, stateTone, taskFacts } from "../web/src/screens2/run/run-model.ts";

// What the rebuilt run screen works out for itself (web/src/screens2/run/run-model.ts).

const NO_PR: RunTask["pullRequest"] = { choice: "branch", state: "none", number: null, url: null, adopted: false, prState: null, pushed: false, repository: null, base: null, remote: null, branch: null, problem: null, at: null };
const task = (status: TaskStatus, more: Partial<RunTask> = {}): RunTask => ({ id: 1, status, title: "t", reason: null, attemptId: null, branch: null, checks: null, retryAt: null, waitingOnApproval: false, evidence: [], commandLists: [], decision: null, pullRequest: NO_PR, leftovers: null, evidenceState: null, evidenceProblem: null, checkingAgain: false, rerunRounds: [], resumeNote: null, restartLine: null, waitingFor: null, ...more });

test("a task's row says what it is doing in words, and names its branch once it has ended", () => {
  assert.equal(taskFacts(task("queued")), "Starts when the tasks before it have finished");
  assert.equal(taskFacts(task("building")), "Preparing a separate copy of the project");
  assert.equal(taskFacts(task("building", { attemptId: 4 })), "Claude Code is working; open it to watch");
  assert.equal(taskFacts(task("building", { attemptId: 4, waitingOnApproval: true })), "Claude Code is waiting for your answer");
  assert.equal(taskFacts(task("verifying")), "Botbench is running this repository's checks");
  assert.equal(taskFacts(task("reviewing")), "The reviewer is reading the changes");
  assert.equal(taskFacts(task("awaiting_decision", { branch: "botbench/run-1/task-1" })), "botbench/run-1/task-1");
  assert.equal(taskFacts(task("cancelled")), "No branch");
});

test("amber is only for what waits on the owner; work under way, success and failure each have their tone, and the rest is neutral", () => {
  assert.equal(stateTone(LOOKS.needsInput), "waits");
  assert.equal(stateTone(LOOKS.readyForReview), "waits");
  assert.equal(stateTone(LOOKS.working), "working");
  assert.equal(stateTone(LOOKS.checking), "working");
  assert.equal(stateTone(LOOKS.accepted), "success");
  assert.equal(stateTone(LOOKS.done), "success");
  assert.equal(stateTone(LOOKS.failed), "failed");
  // A usage limit is not the owner's to answer: it is not amber.
  for (const look of [LOOKS.queued, LOOKS.stopped, LOOKS.cancelled, LOOKS.rejected, LOOKS.acceptedUnverified, LOOKS.usageLimit, LOOKS.nothingToReview]) assert.equal(stateTone(look), "neutral");
});

test("the run's menu offers a stricter mode only where the server offers one, and Cancel only while the run can be cancelled", () => {
  assert.deepEqual(runControls({ status: "running", modeChoices: ["semi", "manual"] }), { stricter: true, cancel: true });
  assert.deepEqual(runControls({ status: "awaiting_plan_approval", modeChoices: [] }), { stricter: false, cancel: true });
  assert.deepEqual(runControls({ status: "planning", modeChoices: [] }), { stricter: false, cancel: true });
  for (const status of ["awaiting_decision", "done", "cancelled", "failed"] as const) assert.deepEqual(runControls({ status, modeChoices: [] }), { stricter: false, cancel: false });
  // A run whose tasks are all built can still be made stricter while the server says so, and can no longer be cancelled.
  assert.deepEqual(runControls({ status: "awaiting_decision", modeChoices: ["manual"] }), { stricter: true, cancel: false });
});

test("pull requests are listed only for a run that chose them, and only those that have a number and an address", () => {
  const opened = task("accepted", { id: 7, title: "Write the exporter", pullRequest: { ...NO_PR, choice: "pull_request", state: "opened", number: 12, url: "https://github.com/o/r/pull/12" } });
  const sending = task("accepted", { id: 8, pullRequest: { ...NO_PR, choice: "pull_request", state: "sending" } });
  assert.deepEqual(pullRequests({ delivery: "pull_request", tasks: [opened, sending] }).map((row) => [row.taskId, row.title, row.view.number, row.view.url]), [[7, "Write the exporter", 12, "https://github.com/o/r/pull/12"]]);
  assert.deepEqual(pullRequests({ delivery: "branch", tasks: [opened] }), []);
});

test("decided tasks are the accepted and the rejected", () => {
  assert.equal(decidedCount({ tasks: [task("accepted"), task("rejected"), task("failed"), task("awaiting_decision")] }), 2);
});

test("a row says a task's state in the product's word; an accept with no checks is said as that and is not a success", () => {
  const decision = (checks: "passed" | "none") => ({ decision: "accept", checks }) as unknown as NonNullable<RunTask["decision"]>;
  assert.deepEqual(rowState(task("building")), { word: "Working", look: LOOKS.working });
  assert.deepEqual(rowState(task("building", { waitingOnApproval: true })), { word: "Needs input", look: LOOKS.needsInput });
  assert.deepEqual(rowState(task("awaiting_decision")), { word: "Ready for review", look: LOOKS.readyForReview });
  assert.deepEqual(rowState(task("accepted", { decision: decision("passed") })), { word: "Accepted", look: LOOKS.accepted });
  assert.deepEqual(rowState(task("accepted", { decision: decision("none") })), { word: "Accepted without verification", look: LOOKS.acceptedUnverified });
  assert.equal(stateTone(rowState(task("accepted", { decision: decision("none") })).look), "neutral");
});
