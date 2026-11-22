import assert from "node:assert/strict";
import test from "node:test";
import { stations } from "../web/src/components/run-status.ts";
import type { RunTask, TaskStatus } from "../web/src/api/client.ts";

// A run's three stations, from the run's state and its tasks' and nothing else (the design system's run timeline).

const task = (status: TaskStatus): RunTask => ({ id: 1, status, title: "t", reason: null, attemptId: null, branch: null, checks: null, waitingOnApproval: false, evidence: [], commandLists: [], decision: null, leftovers: null, resumeNote: null });
const run = (status: Parameters<typeof stations>[0]["status"], tasks: RunTask[] = [], more: { attemptId?: number | null; waitingOnApproval?: boolean } = {}) =>
  stations({ status, tasks, attemptId: more.attemptId === undefined ? 1 : more.attemptId, waitingOnApproval: more.waitingOnApproval ?? false });
const flat = (shown: ReturnType<typeof stations>) => shown && { at: shown.current, stations: shown.stations.map((s) => `${s.name}: ${s.state}: ${s.words}`) };

test("planning: queued with no planner yet, then working or needing input at Plan, with nothing built", () => {
  assert.deepEqual(flat(run("planning", [], { attemptId: null })), { at: null, stations: ["Plan: not-started: Queued", "Build: not-started: Not started", "Decide: not-started: Not started"] });
  assert.deepEqual(flat(run("planning")), { at: 0, stations: ["Plan: running: Working", "Build: not-started: Not started", "Decide: not-started: Not started"] });
  assert.deepEqual(flat(run("planning", [], { waitingOnApproval: true }))?.stations[0], "Plan: waiting: Needs input");
  assert.deepEqual(flat(run("awaiting_plan_approval"))?.stations[0], "Plan: waiting: Waiting for your approval");
  // A run fails only while it plans.
  assert.deepEqual(flat(run("failed")), { at: 0, stations: ["Plan: failed: Failed", "Build: not-started: Not started", "Decide: not-started: Not started"] });
});

test("building: Build counts the tasks that finished, and Decide waits once a task is ready for review", () => {
  assert.deepEqual(flat(run("running", [task("awaiting_decision"), task("building"), task("queued")])), {
    at: 1,
    stations: ["Plan: done: Done", "Build: running: Working · 1 of 3 tasks finished", "Decide: waiting: 1 task ready for review"],
  });
  assert.deepEqual(flat(run("running", [task("building")], { waitingOnApproval: true }))?.stations.slice(1), ["Build: waiting: Needs input · 0 of 1 task finished", "Decide: not-started: Not started"]);
});

test("every task ended: Decide waits for the tasks ready for review, and a run with none built says Build failed, never Done", () => {
  assert.deepEqual(flat(run("awaiting_decision", [task("awaiting_decision"), task("failed")])), {
    at: 2,
    stations: ["Plan: done: Done", "Build: done: Done · 1 of 2 tasks built", "Decide: waiting: 1 task ready for review"],
  });
  assert.deepEqual(flat(run("awaiting_decision", [task("failed"), task("interrupted")])), {
    at: 1,
    stations: ["Plan: done: Done", "Build: failed: No task was built", "Decide: not-started: Not started"],
  });
  assert.deepEqual(flat(run("done", [task("accepted"), task("rejected"), task("failed")]))?.stations[2], "Decide: done: Done · 2 of 3 tasks decided");
  // Unit 16: a run whose every task failed, was stopped or was cancelled is done with nothing to review, and says so.
  assert.deepEqual(flat(run("done", [task("failed"), task("interrupted")])), {
    at: null,
    stations: ["Plan: done: Done", "Build: failed: No task was ready for review", "Decide: not-started: Not started"],
  });
});

test("a cancelled run has no timeline: it has no state for a cancelled station", () => {
  assert.equal(run("cancelled", [task("cancelled")]), null);
});
