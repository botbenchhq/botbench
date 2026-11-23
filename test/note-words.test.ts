import assert from "node:assert/strict";
import test from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import { leftBuilding, MAX_NOTE, NOT_DELIVERED, NOTE_REFUSED, NOTE_TOO_LATE, noteProblem } from "../src/engine/notes.ts";
import { NOTE_ABOUT, NOTE_HEADING, NOTE_LABEL, NOTE_NOT_DELIVERED, NOTE_REPLACED, NOTE_SEND, NOTE_SENDING, NOTE_WAITING, NOTE_WAITING_LABEL, notDeliveredLine, noteRefused } from "../web/src/components/task-note-words.ts";

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
  const screen = [NOTE_HEADING, NOTE_LABEL, NOTE_ABOUT, NOTE_SEND, NOTE_SENDING, NOTE_WAITING, NOTE_REPLACED, NOTE_NOT_DELIVERED, noteRefused(NOTE_REFUSED.failed), noteRefused(null), NOTE_WAITING_LABEL, ...Object.values(NOT_DELIVERED).map(notDeliveredLine)];
  for (const text of [...server, ...screen]) assert.deepEqual(bannedIn(text), [], text);
});

test("the box says what a send does, that a second note replaces the first until it is delivered, and a refusal says what happened, then why", () => {
  assert.match(NOTE_ABOUT, /a second note replaces the first until it is delivered\.$/);
  assert.equal(noteRefused(NOTE_REFUSED.failed), "The note was not sent. This task failed, so a note can no longer reach Claude Code.");
  assert.equal(noteRefused(null), "The note was not sent. Botbench could not be reached.");
  assert.equal(noteProblem("  ok  "), null);
  assert.equal(noteProblem("x".repeat(MAX_NOTE)), null);
});
