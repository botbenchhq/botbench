import assert from "node:assert/strict";
import test from "node:test";
import * as server from "../src/engine/run-source.ts";
import { blocked, rowsFor, sendFor, type Facts } from "../web/src/app/composer.ts";
import { composerAddress, MAX_RUN_NOTE, messagePreview, NOTE_EMPTY, noteProblem, noteTooLong, offersRun, readHandOff, sourceInAddress, sourceRepoProblem, type ComposerSource } from "../web/src/app/run-source.ts";

// "Make this a run" as the screens decide it, without a browser: which tasks offer it, what the composer sends, and why
// Send waits. The composer shows the same reasons the server gives, word for word.

const REPO = "/Users/owner/code/api";
const FROM_TASK: ComposerSource = { ref: { kind: "task", id: 12 }, label: "From task 12", repo: REPO };
const FROM_CHAT: ComposerSource = { ref: { kind: "chat", id: 5 }, label: "From a chat", repo: null };
const run = (over: Partial<Facts> = {}): Facts => ({
  text: "Now add a farewell file too.",
  repo: { kind: "known", path: REPO },
  repoStatus: { state: "usable" },
  kind: "run",
  specPath: "",
  mode: "manual",
  builder: { state: "ready" },
  model: { ok: true, model: "haiku" },
  buildModel: null,
  commandTyped: false,
  hasChecks: true,
  source: FROM_TASK,
  ...over,
});
const extras = { preapproved: [], reviewer: null, delivery: "branch" as const, oneTask: true };

test("the composer refuses a note with the server's own words and limit", () => {
  assert.equal(MAX_RUN_NOTE, server.MAX_RUN_NOTE);
  assert.equal(NOTE_EMPTY, server.NOTE_EMPTY);
  for (const note of ["", "   \n", "ok", "x".repeat(MAX_RUN_NOTE), "x".repeat(MAX_RUN_NOTE + 1)]) assert.equal(noteProblem(note), server.noteProblem(note), JSON.stringify(note.slice(0, 10)));
  assert.equal(noteTooLong(12_345), server.noteTooLong(12_345));
  assert.equal(blocked(run({ text: "  " }))!.reason, NOTE_EMPTY);
  assert.equal(blocked(run({ text: "x".repeat(MAX_RUN_NOTE + 1) }))!.reason, noteTooLong(MAX_RUN_NOTE + 1));
  assert.equal(sendFor(run({ text: "" }), extras).do, "blocked");
});

test("a run from a task stays in the task's repository, with the server's reason when another is chosen", () => {
  const other = "/Users/owner/code/web";
  const why = sourceRepoProblem(FROM_TASK, other);
  assert.equal(why, `Task 12 was built in ${REPO}, not ${other}. A run made from it works in the same repository.`);
  assert.deepEqual(blocked(run({ repo: { kind: "known", path: other } })), { reason: why, required: "repository" });
  // A chat has no repository of its own: any may be chosen.
  assert.equal(sourceRepoProblem(FROM_CHAT, other), null);
  assert.equal(blocked(run({ repo: { kind: "known", path: other }, source: FROM_CHAT })), null);
});

test("Send makes the run from the note and names its source; the owner may choose any mode, Fully autonomous too", () => {
  for (const mode of ["manual", "semi", "full"] as const) {
    const sent = sendFor(run({ mode }), extras);
    assert.equal(sent.do, "run");
    assert.deepEqual(sent, { do: "run", repo: REPO, prompt: "Now add a farewell file too.", model: "haiku", preapproved: [], reviewer: null, mode, delivery: "branch", oneTask: true, onLimit: "wait", source: { kind: "task", id: 12 } });
  }
  assert.deepEqual((sendFor(run({ source: FROM_CHAT }), extras) as { source?: unknown }).source, { kind: "chat", id: 5 });
  // An approval time limit chosen for it is sent with it, as for any run; Off sends none.
  assert.equal((sendFor(run({}), { ...extras, approvalLimitMinutes: 60 }) as { approvalLimitMinutes?: number }).approvalLimitMinutes, 60);
  assert.equal("approvalLimitMinutes" in sendFor(run({}), { ...extras, approvalLimitMinutes: null }), false);
  // A spec file or an issue is never sent with it.
  const sent = sendFor(run({ specPath: "/tmp/spec.md", issue: { fetchId: 3, allowHosts: false, number: 9, title: "Bug" } }), extras) as Record<string, unknown>;
  assert.equal(sent.specPath, undefined);
  assert.equal(sent.issue, undefined);
  // Not a run in a repository any more: the source no longer applies.
  assert.equal((sendFor(run({ kind: "task" }), extras) as { source?: unknown }).source, undefined);
  assert.equal(sendFor(run({ repo: { kind: "none" } }), extras).do, "chat");
});

test("the Add context sheet of a run made from a source offers no issue and no spec file, and keeps every other setting", () => {
  const rows = rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", reviewOffered: true, commandsKnown: true, issueOffered: true, builderOffered: true, sourced: true });
  assert.deepEqual(rows, ["repository", "kind", "builder", "mode", "tasks", "review", "delivery", "limit", "approvalLimit", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", reviewOffered: true, commandsKnown: true, issueOffered: true, sourced: false }), ["repository", "kind", "issue", "spec", "mode", "tasks", "review", "delivery", "limit", "approvalLimit", "commands", "models"]);
});

test("a task offers Make this a run once it is ready for review, accepted or rejected, and never while it is being built or reviewed", () => {
  assert.deepEqual(["awaiting_decision", "accepted", "rejected"].map((s) => offersRun(s as never)), [true, true, true]);
  for (const status of ["queued", "building", "verifying", "reviewing", "waiting_for_limit", "failed", "cancelled", "interrupted"] as const) assert.equal(offersRun(status), false, status);
  assert.deepEqual(server.SOURCE_STATUSES, ["awaiting_decision", "accepted", "rejected"]);
});

test("the composer's address names the source, and only a well-formed one is read; a hand-off is read part by part", () => {
  assert.equal(composerAddress({ kind: "task", id: 12 }), "#/turn?start=run&from=task-12");
  assert.deepEqual(sourceInAddress("/turn?start=run&from=task-12"), { kind: "task", id: 12 });
  assert.deepEqual(sourceInAddress("/turn?start=run&from=chat-5"), { kind: "chat", id: 5 });
  for (const at of ["/turn?start=run&from=task-0", "/turn?start=task&from=task-1", "/turn?start=run&from=run-3", "/turn?start=run&from=task-1x"]) assert.equal(sourceInAddress(at), null, at);
  const task = { kind: "task", id: 12 };
  assert.deepEqual(readHandOff(JSON.stringify({ source: task, note: "Go on", repo: REPO })), { source: task, note: "Go on", repo: REPO });
  assert.deepEqual(readHandOff(JSON.stringify({ source: task, note: "Go on", repo: 3 })), { source: task, note: "Go on", repo: null });
  assert.equal(readHandOff(JSON.stringify({ source: task, note: 7 })), null);
  assert.equal(readHandOff(JSON.stringify({ note: "Go on" })), null);
  assert.equal(readHandOff(JSON.stringify({ source: { kind: "run", id: 1 }, note: "Go on" })), null);
  assert.equal(readHandOff(JSON.stringify({ source: { kind: "task", id: 0 }, note: "Go on" })), null);
  assert.equal(readHandOff("not json"), null);
  assert.equal(messagePreview(`one\n two   three ${"x".repeat(200)}`).length, 141);
});
