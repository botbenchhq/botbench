import assert from "node:assert/strict";
import test from "node:test";
import type { BoardGroup, BoardItem } from "../web/src/api/client.ts";
import { countLine, matching, workRows } from "../web/src/app/work-list.ts";

// What the column of chats and work beside a wide screen lists and says, decided without a browser, from rows shaped
// as /api/board sends them.

const task = (id: number, title: string, status: "awaiting_decision" | "building" | "failed", updatedAt: string, waitingOnApproval = false): BoardItem => ({
  kind: "task", id, repo: "/tmp/api", title, status, reason: null, checks: null, waitingOnApproval, resuming: false, discardable: false, branch: null, pullRequest: null, createdAt: updatedAt, updatedAt,
});
const run = (id: number, title: string, updatedAt: string): BoardItem => ({
  kind: "run", id, repo: "/tmp/api", title, status: "awaiting_plan_approval", reason: null, attemptId: 1, taskCount: 2, finishedCount: 0, readyCount: 0, decidedCount: 0, waitingOnApproval: false, mode: "manual", outsideText: false, cancellable: false, branch: null, pullRequest: null, createdAt: updatedAt, updatedAt,
});
const groups = (needs: BoardItem[], running: BoardItem[], finished: BoardItem[], finishedTotal = finished.length): BoardGroup[] => [
  { name: "needs-you", total: needs.length, items: needs },
  { name: "running", total: running.length, items: running },
  { name: "finished", total: finishedTotal, items: finished },
];

test("the column lists every run and task of the board's groups as one list, newest change first, each with its state in words and its own address", () => {
  const list = workRows(groups([task(3, "Fix the login timeout", "awaiting_decision", "2026-11-20T10:00:00Z"), run(2, "Plan the billing export", "2026-11-23T09:00:00Z")], [task(5, "Add rate limiting", "building", "2026-11-22T08:00:00Z")], [task(1, "Remove the old exporter", "failed", "2026-11-23T10:00:00Z")]));
  assert.deepEqual(
    list.rows.map((r) => [r.title, r.state, r.href]),
    [
      ["Remove the old exporter", "Failed", "#/tasks/1"],
      ["Plan the billing export", "Plan ready for review", "#/runs/2"],
      ["Add rate limiting", "Working", "#/tasks/5"],
      ["Fix the login timeout", "Ready for review", "#/tasks/3"],
    ],
  );
  assert.equal(list.total, 4);
  // A task waiting on an approval says so, as the board does.
  assert.equal(workRows(groups([task(7, "Ask first", "building", "2026-11-23T10:00:00Z", true)], [], [])).rows[0]!.state, "Needs input");
});

test("the search keeps the rows whose title holds the typed words in any case, and an empty or blank search keeps them all", () => {
  const { rows } = workRows(groups([task(1, "Fix the Login timeout", "awaiting_decision", "2026-11-23T10:00:00Z")], [task(2, "Add rate limiting", "building", "2026-11-22T10:00:00Z")], []));
  assert.deepEqual(matching(rows, "login").map((r) => r.id), [1]);
  assert.deepEqual(matching(rows, "  LOGIN ").map((r) => r.id), [1]);
  assert.deepEqual(matching(rows, "the login").map((r) => r.id), [1]);
  assert.deepEqual(matching(rows, "nothing like it"), []);
  assert.deepEqual(matching(rows, "").map((r) => r.id), [1, 2]);
  assert.deepEqual(matching(rows, "   ").map((r) => r.id), [1, 2]);
});

test("the count line says in words how many are shown, by kind, and of how many when a search narrows them or matches nothing", () => {
  const list = workRows(groups([run(9, "Plan the export", "2026-11-23T10:00:00Z")], [task(2, "Add rate limiting", "building", "2026-11-22T10:00:00Z"), task(3, "Fix rate math", "building", "2026-11-21T10:00:00Z")], []));
  assert.equal(countLine(list, "", 3), "1 run and 2 tasks");
  assert.equal(countLine(list, " rate ", 2), '2 of 3 match "rate"');
  assert.equal(countLine(list, "zebra", 0), 'None of 3 match "zebra"');
  assert.equal(countLine(workRows(groups([], [task(2, "Only one", "building", "2026-11-22T10:00:00Z")], [])), "", 1), "1 task");
  assert.equal(countLine(workRows(groups([run(1, "a", "2026-11-22T10:00:00Z"), run(2, "b", "2026-11-22T11:00:00Z")], [], [])), "", 2), "2 runs");
  // Finished sends only its newest: the line says how many of the oldest finished are left out, and nothing about the rest.
  const cut = workRows(groups([], [task(5, "Older work at work", "building", "2026-10-01T10:00:00Z")], [task(4, "Old work", "failed", "2026-11-01T10:00:00Z")], 120));
  assert.equal(countLine(cut, "", 2), "2 tasks. The 119 oldest finished are not listed.");
  assert.equal(countLine(workRows(groups([], [], [task(4, "Old work", "failed", "2026-11-01T10:00:00Z")], 2)), "", 1), "1 task. The 1 oldest finished one is not listed.");
});

test("chats are listed with the work, newest change first, each opening on Chat, and counted in words with the rest", () => {
  const chat = (id: number, title: string, updatedAt: string): BoardItem => ({ kind: "chat", id, title, named: false, agents: ["claude-code"], attempts: [id], createdAt: updatedAt, updatedAt });
  const list = workRows([...groups([], [task(2, "Add rate limiting", "building", "2026-11-22T10:00:00Z")], []), { name: "chats", total: 2, items: [chat(4, "Why is the login slow?", "2026-11-23T10:00:00Z"), chat(3, "Name the export", "2026-11-21T10:00:00Z")] }]);
  assert.deepEqual(list.rows.map((r) => [r.title, r.state, r.href]), [["Why is the login slow?", "Chat", "#/chats/4"], ["Add rate limiting", "Working", "#/tasks/2"], ["Name the export", "Chat", "#/chats/3"]]);
  assert.equal(countLine(list, "", 3), "2 chats and 1 task");
  assert.deepEqual(matching(list.rows, "login").map((r) => r.href), ["#/chats/4"]);
});
