import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { taskNoteRounds } from "../src/engine/note-rounds.ts";
import { queueNoteIn, type TaskNote } from "../src/engine/notes.ts";
import { insertEvidence, taskEvidence, type CommandRun } from "../src/engine/stations.ts";
import { closeNoteRound, createTask, getTask, moveTask, moveTaskIn, type Task } from "../src/engine/task.ts";
import { now, openStore, transaction } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, tempDir, write } from "./support/repo.ts";

// The store's side of a round started by the owner's note to a task that is ready for review (issue #156), below the
// engine: real SQLite with every migration, a real temporary git repository with Botbench's own worktree and commit
// functions, and no sandbox-exec, broker or agent, so it runs everywhere `npm test` does and is never skipped. What the
// round's turn does in a real builder session, and the checks the repository's commands record, are in
// test/engine/note-round.test.ts; here each step is stored as the engine stores it (`closeNoteRound`, `insertEvidence`,
// `moveTask`), so the trigger that lets a task's checks change only for a new version of its work is what is tested.

type T = { after(fn: () => unknown): void };

interface Store {
  db: DatabaseSync;
  home: string;
  repo: string;
}

function store(t: T): Store {
  const dir = tempDir("botbench-note-round-checks-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const db = openStore(home);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo };
}

/** A check command's result as the stations store one. */
const ran = (command: string, outcome: "passed" | "failed"): CommandRun => {
  const at = now();
  return { command, outcome, exitCode: outcome === "passed" ? 0 : 1, signal: null, output: "", truncated: false, limitMs: 10_000, startedAt: at, endedAt: at, durationMs: 0 };
};

/** Commit everything in the task's copy with Botbench's own commit function; returns the new head. */
async function commit(task: Task, file: string, content: string): Promise<string> {
  write(task.worktreePath!, file, content);
  const made = await commitWork({ path: task.worktreePath!, message: `Botbench task ${task.id}` });
  assert.ok(made.committed, "something was committed");
  return made.commit;
}

/** A task ready for review whose one check failed on its committed work, as the engine leaves it. */
async function readyWithFailedCheck(s: Store): Promise<{ task: Task; head: string }> {
  const created = createTask(s.db, { repo: s.repo, prompt: "Add a greeting file" });
  const worktree = await createWorktree({ repo: s.repo, home: s.home, run: `run-${created.runId}`, task: `task-${created.id}` });
  const building = moveTask(s.db, created.id, "building", { worktree });
  const head = await commit(building, "hello.txt", "hi\n");
  moveTask(s.db, created.id, "verifying", { headCommit: head });
  insertEvidence(s.db, created.id, "check", 1, ran("grep -q hello hello.txt", "failed"), 1);
  const ready = moveTask(s.db, created.id, "awaiting_decision", { checks: "failed" });
  return { task: ready, head };
}

/** The owner's note to a task ready for review, stored and moved as the engine's `sendNote` stores and moves it. */
function noteFor(db: DatabaseSync, task: Task, text: string): TaskNote {
  return transaction(db, () => {
    const { note } = queueNoteIn(db, task.id, text, { from: task.headCommit! });
    moveTaskIn(db, task.id, "building", { note: "the owner's note starts a round" });
    return note;
  });
}

test("a note round that changes the work records new check evidence for the new version and updates the task's checks; the round is stored once, and rows are only ever added", async (t) => {
  const s = store(t);
  const { task, head } = await readyWithFailedCheck(s);
  const note = noteFor(s.db, task, "Say hello in the file, not hi.");
  assert.equal(getTask(s.db, task.id)!.status, "building");

  // The builder's turn changed the file; Botbench commits it and closes the round.
  const newHead = await commit(getTask(s.db, task.id)!, "hello.txt", "hello\n");
  assert.notEqual(newHead, head);
  const closed = closeNoteRound(s.db, { taskId: task.id, note, attemptId: null, finished: true, reply: "Changed hi to hello.", problem: null, headCommit: newHead, hasChecks: true });
  assert.equal(closed?.next, "check");
  assert.equal(closed.task.status, "verifying");
  assert.equal(closed.task.headCommit, newHead);
  const [round] = taskNoteRounds(s.db, task.id);
  assert.deepEqual([round!.noteId, round!.outcome, round!.changed, round!.fromCommit, round!.headCommit, round!.afterReviews], [note.id, "finished", true, head, newHead, 0]);

  // The checks run on the new version as a new round of evidence, and what they found replaces what they found before.
  insertEvidence(s.db, task.id, "check", 1, ran("grep -q hello hello.txt", "passed"), 2);
  const ready = moveTask(s.db, task.id, "awaiting_decision", { checks: "passed" });
  assert.equal(ready.checks, "passed");
  assert.deepEqual(taskEvidence(s.db, task.id).filter((row) => row.kind === "check").map((row) => `${row.round}:${row.outcome}`), ["1:failed", "2:passed"]);
  assert.equal(String(s.db.prepare("SELECT checks FROM tasks WHERE id = ?").get(task.id)!.checks), "passed");

  // A round is stored once per note, and never changed or removed.
  assert.throws(() => s.db.prepare("INSERT INTO note_rounds (task_id, note_id, after_reviews, outcome, changed, reply, from_commit, head_commit, started_at, ended_at) VALUES (?, ?, 0, 'finished', 0, '', ?, ?, ?, ?)").run(task.id, note.id, head, head, now(), now()), /UNIQUE/);
  assert.throws(() => s.db.prepare("UPDATE note_rounds SET changed = 0 WHERE task_id = ?").run(task.id), /note rounds are append-only/);
  assert.throws(() => s.db.prepare("INSERT OR REPLACE INTO note_rounds (id, task_id, note_id, after_reviews, outcome, changed, reply, from_commit, head_commit, started_at, ended_at) VALUES (?, ?, ?, 0, 'finished', 0, '', ?, ?, ?, ?)").run(round!.id, task.id, note.id, head, head, now(), now()), /note rounds are append-only|UNIQUE/);
  assert.throws(() => s.db.prepare("DELETE FROM note_rounds WHERE task_id = ?").run(task.id), /note rounds are append-only/);
  // Only a note the owner sent for a round, of the same task, has one.
  const other = createTask(s.db, { repo: s.repo, prompt: "Another task" });
  assert.throws(() => s.db.prepare("INSERT INTO note_rounds (task_id, note_id, after_reviews, outcome, changed, reply, from_commit, head_commit, started_at, ended_at) VALUES (?, ?, 0, 'finished', 0, '', ?, ?, ?, ?)").run(other.id, note.id, head, head, now(), now()), /a note round belongs to a note of the same task sent for a round/);
});

test("a note round that changes nothing records nothing twice: no round of check evidence, the task's checks as they were, and back to ready for review; a plain second change of the checks for the same version is still refused", async (t) => {
  const s = store(t);
  const { task, head } = await readyWithFailedCheck(s);
  const note = noteFor(s.db, task, "Is the greeting file right?");
  const evidenceBefore = taskEvidence(s.db, task.id).length;

  // The builder answered and changed no file: Botbench's commit leaves the head where it was.
  const closed = closeNoteRound(s.db, { taskId: task.id, note, attemptId: null, finished: true, reply: "It is right as it is.", problem: null, headCommit: head, hasChecks: true });
  assert.equal(closed?.next, "back");
  assert.equal(closed.task.status, "awaiting_decision");
  assert.equal(closed.task.checks, "failed", "what the checks found for this version stands");
  assert.equal(closed.task.headCommit, head);
  assert.equal(taskEvidence(s.db, task.id).length, evidenceBefore, "no check ran again");
  assert.deepEqual(taskNoteRounds(s.db, task.id).map((r) => [r.changed, r.outcome]), [[false, "finished"]]);

  // Nothing new was made, so what the checks found for this version cannot be recorded a second time.
  assert.throws(() => moveTask(s.db, task.id, "awaiting_decision", { checks: "passed" }), /what the checks found is recorded once for each version of the work/);
  assert.equal(getTask(s.db, task.id)!.checks, "failed");
});

test("a task with no note round keeps its checks once for its version, as before", async (t) => {
  const s = store(t);
  const { task } = await readyWithFailedCheck(s);
  assert.throws(() => moveTask(s.db, task.id, "awaiting_decision", { checks: "passed" }), /what the checks found is recorded once for each version of the work/);
  assert.equal(getTask(s.db, task.id)!.checks, "failed");
  // A note sent for a round names the commit it starts from; a note to a building task names none.
  assert.throws(() => s.db.prepare("INSERT INTO task_notes (task_id, text, sent_at, state, for_round) VALUES (?, 'x', ?, 'waiting', 1)").run(task.id, now()), /names the commit the round starts from/);
  assert.throws(() => s.db.prepare("INSERT INTO task_notes (task_id, text, sent_at, state, for_round, round_from) VALUES (?, 'x', ?, 'waiting', 0, 'abc')").run(task.id, now()), /names the commit the round starts from/);
});
