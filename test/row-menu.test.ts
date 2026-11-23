import assert from "node:assert/strict";
import test from "node:test";
import type { BoardItem } from "../web/src/api/client.ts";
import { cancelStatement, moreName, rowMenu } from "../web/src/app/row-menu.ts";
import { bannedIn } from "../e2e/voice.ts";

// What each row's More menu on Work offers, decided without a browser: only what is real for the row's state. The
// approach is from OpenMausBot's src/components/ChatMoreMenu.test.ts (a menu's items checked by their keys, one state
// at a time), written again for Botbench's rows. The rows are as the board's API sends them (test/api/rows.test.ts).

const at = "2026-11-23T10:00:00.000Z";
const run = (o: Partial<Extract<BoardItem, { kind: "run" }>> = {}): BoardItem => ({
  kind: "run", id: 4, repo: "/r/api", title: "Add a greeting", status: "running", reason: null, attemptId: 1, taskCount: 2, finishedCount: 0, readyCount: 0, decidedCount: 0,
  waitingOnApproval: false, mode: "manual", outsideText: false, createdAt: at, updatedAt: at, branch: null, pullRequest: null, cancellable: true, ...o,
} as BoardItem);
const task = (o: Partial<Extract<BoardItem, { kind: "task" }>> = {}): BoardItem => ({
  kind: "task", id: 12, repo: "/r/api", title: "create hello.txt", status: "failed", reason: "it broke", checks: null, waitingOnApproval: false, resuming: false,
  createdAt: at, updatedAt: at, branch: "botbench/mac/run-3/task-12", pullRequest: null, discardable: true, ...o,
});
const chat = (o: Partial<Extract<BoardItem, { kind: "chat" }>> = {}): BoardItem => ({ kind: "chat", id: 7, title: "Colours for the logo", named: true, agents: ["codex"], attempts: [7, 9], createdAt: at, updatedAt: at, ...o });
const actions = (item: BoardItem, hidden = false): string[] => rowMenu(item, hidden).map((entry) => entry.action);

test("a running run offers Open, Hide and, last as the item that takes something away, Cancel", () => {
  assert.deepEqual(actions(run()), ["open", "hide", "cancel"]);
  const items = rowMenu(run(), false);
  assert.deepEqual(items.map((entry) => entry.label), ["Open run 4", "Hide from the list", "Cancel run 4"]);
  assert.deepEqual(items.map((entry) => entry.danger), [false, false, true]);
});

test("a finished run offers no Cancel; its branch and its pull request only when it has exactly one, as the board sends them", () => {
  assert.deepEqual(actions(run({ status: "done", cancellable: false })), ["open", "hide"]);
  assert.deepEqual(actions(run({ status: "done", cancellable: false, branch: "botbench/mac/run-4/task-1", pullRequest: { number: 12, url: "https://github.com/o/r/pull/12" } })), ["open", "copy-branch", "open-pull-request", "hide"]);
  assert.equal(rowMenu(run({ cancellable: false, pullRequest: { number: 12, url: "https://github.com/o/r/pull/12" } }), false)[1]!.label, "Open pull request #12");
});

test("a failed task with its branch and an open pull request offers all four, and Discard last; one with nothing left offers no Discard and no branch", () => {
  assert.deepEqual(actions(task({ pullRequest: { number: 5, url: "https://github.com/o/r/pull/5" } })), ["open", "copy-branch", "open-pull-request", "hide", "discard"]);
  assert.equal(rowMenu(task(), false).at(-1)!.label, "Discard task 12");
  assert.deepEqual(actions(task({ branch: null, discardable: false })), ["open", "hide"]);
  // A task is never cancelled from here: Cancel is for a run.
  assert.ok(!actions(task({ status: "building", discardable: false })).includes("cancel"));
});

test("a chat offers Rename and Hide only: no Open pull request, Copy branch, Cancel, Discard or a new chat from it", () => {
  assert.deepEqual(actions(chat()), ["rename", "hide"]);
  assert.deepEqual(actions(chat(), true), ["rename", "show"]);
  assert.deepEqual(rowMenu(chat(), false).map((entry) => entry.label), ["Rename chat", "Hide from the list"]);
});

test("among the hidden rows each row offers Show in the list in place of Hide", () => {
  for (const item of [run(), task(), chat()]) {
    const items = rowMenu(item, true);
    assert.ok(items.some((entry) => entry.action === "show" && entry.label === "Show in the list"));
    assert.ok(!items.some((entry) => entry.action === "hide"));
  }
});

test("each More button is named for its row, and every label and statement is in the voice's words", () => {
  assert.equal(moreName(run()), "More actions for run 4");
  assert.equal(moreName(task()), "More actions for task 12");
  assert.equal(moreName(chat()), "More actions for chat Colours for the logo");
  const words = [run(), task({ pullRequest: { number: 5, url: "u" } }), chat()].flatMap((item) => [...rowMenu(item, false), ...rowMenu(item, true)].map((entry) => entry.label));
  for (const status of ["planning", "awaiting_plan_approval", "running"] as const) words.push(cancelStatement(status, 1));
  for (const text of words) assert.deepEqual(bannedIn(text), [], text);
  assert.equal(cancelStatement("awaiting_plan_approval", 1), "The plan of 1 task is dropped and nothing is built. A cancelled run cannot be started again; start a new one instead.");
});
