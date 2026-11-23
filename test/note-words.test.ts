import assert from "node:assert/strict";
import test from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import { leftBuilding, MAX_NOTE, NOT_DELIVERED, NOTE_REFUSED, NOTE_TOO_LATE, noteProblem } from "../src/engine/notes.ts";
import { NOTE_ABOUT, NOTE_ABOUT_READY, NOTE_HEADING, NOTE_LABEL, NOTE_NOT_DELIVERED, NOTE_REPLACED, NOTE_SEND, NOTE_SENDING, NOTE_WAITING, NOTE_WAITING_LABEL, NOTE_WAITING_ROUND, notDeliveredLine, noteRefused } from "../web/src/components/task-note-words.ts";
import { noteRoundLine } from "../src/engine/note-rounds.ts";
import { clockWords } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { waitingForWords } from "../web/src/components/task-status.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every sentence about an owner's note that a person sees, from the task screen and from the server, against the
// glossary of docs/product/voice.md, which the screen-words tests enforce: none holds a word Botbench never shows
// (turn, attempt, CLI and the rest), whatever the state of the task.

test("the note box's words and the server's reasons hold no word the glossary bans", () => {
  const server = [
    ...Object.values(NOTE_REFUSED),
    NOTE_TOO_LATE,
    ...Object.values(NOT_DELIVERED),
    ...(["failed", "interrupted", "cancelled", "verifying", "awaiting_decision"] as const).map(leftBuilding),
    noteProblem("")!,
    noteProblem("x".repeat(MAX_NOTE + 1))!,
    "Botbench could not read the note: it was not sent as JSON.",
  ];
  const screen = [NOTE_HEADING, NOTE_LABEL, NOTE_ABOUT, NOTE_ABOUT_READY, NOTE_SEND, NOTE_SENDING, NOTE_WAITING, NOTE_WAITING_ROUND, NOTE_REPLACED, NOTE_NOT_DELIVERED, noteRefused(NOTE_REFUSED.failed), noteRefused(null), NOTE_WAITING_LABEL, ...Object.values(NOT_DELIVERED).map(notDeliveredLine), waitingForWords({ waitingFor: { taskId: 12, title: "x" } })!];
  for (const text of [...server, ...screen]) assert.deepEqual(bannedIn(text), [], text);
});

test("a note to a task that is ready for review is refused at no station that is ready for review, and its round's line and the restart line hold no banned word", () => {
  assert.equal(Object.hasOwn(NOTE_REFUSED, "awaiting_decision"), false, "a task that is ready for review takes a note");
  assert.equal(Object.hasOwn(NOTE_REFUSED, "building"), false);
  assert.match(NOTE_ABOUT_READY, /checks and reviews the work again/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-note-words-"));
  const db = openStore(path.join(dir, "home"));
  try {
    // The round's line as the engine builds it, for a round whose builder never took the note and changed nothing.
    const at = "2026-11-23T10:00:00.000Z";
    db.prepare("INSERT INTO runs (kind, repo_path, prompt, created_at, updated_at) VALUES ('single', '/r', 'p', ?, ?)").run(at, at);
    db.prepare("INSERT INTO tasks (id, run_id, repo_path, prompt, status, created_at, updated_at) VALUES (1, 1, '/r', 'p', 'awaiting_decision', ?, ?)").run(at, at);
    db.prepare("INSERT INTO task_notes (task_id, text, sent_at, state, for_round, round_from) VALUES (1, 'n', ?, 'waiting', 1, 'abc')").run(at);
    db.prepare("INSERT INTO note_rounds (task_id, note_id, after_reviews, outcome, changed, reply, problem, from_commit, head_commit, started_at, ended_at) VALUES (1, 1, 0, 'failed', 0, '', 'x', 'abc', 'abc', ?, ?)").run(at, at);
    db.prepare("INSERT INTO task_events (task_id, ts, status, detail) VALUES (1, ?, 'awaiting_decision', NULL)").run("2026-11-23T10:00:01.000Z");
    const line = noteRoundLine(db, { id: 1, status: "awaiting_decision", builderAgent: null })!;
    assert.equal(line, "Your note did not reach Claude Code, so nothing changed and the checks and the review were not run again.");
    for (const text of [line, `Botbench restarted ${clockWords(new Date(at))} and took this task up again by itself.`]) assert.deepEqual(bannedIn(text), [], text);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the box says what a send does, that a second note replaces the first until it is delivered, and a refusal says what happened, then why", () => {
  assert.match(NOTE_ABOUT, /a second note replaces the first until it is delivered\.$/);
  assert.equal(noteRefused(NOTE_REFUSED.failed), "The note was not sent. This task failed, so a note can no longer reach Claude Code.");
  assert.equal(noteRefused(null), "The note was not sent. Botbench could not be reached.");
  assert.equal(noteProblem("  ok  "), null);
  assert.equal(noteProblem("x".repeat(MAX_NOTE)), null);
});
