import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "../store/db.ts";
import type { TaskStatus } from "./task.ts";

/*
 * An owner's note to a task that is building (issue #78): words the owner types while the builder works, sent to the
 * builder as its next message in the same session once its current turn ends normally, before Botbench commits and
 * checks the work (engine/task.ts, `drive`). One note waits at a time: a second one sent before delivery replaces the
 * first, which is kept, marked replaced. A note waits off the transcript, as OpenMausBot's steer queue keeps a message
 * sent mid-turn off it until it runs, and it is claimed (marked delivered) in the one write that takes it out of waiting,
 * just before it is sent, so no two ends of a turn and no restart can send it twice. A turn that ends any other way marks
 * a waiting note not delivered, with the reason, and it is never sent.
 *
 * The note is the owner's own words: it is sent as it was typed, trusted, and never marked as outside text. It grants
 * nothing: the turn it starts runs in the same attempt, under the same admission, confinement and permission check as
 * the build (docs/security/threat-model.md, "Owner notes").
 */

/** The longest note, in characters. The store refuses a longer one too. */
export const MAX_NOTE = 4000;

export type NoteState = "waiting" | "delivered" | "replaced" | "not_delivered";

export interface TaskNote {
  id: number;
  taskId: number;
  /** The owner's words, without the blank space around them. */
  text: string;
  sentAt: string;
  state: NoteState;
  /** The attempt whose session it was sent to, once delivered. */
  attemptId: number | null;
  /** Why it was not delivered, in words for the owner. */
  reason: string | null;
  /** When it left waiting; null while it waits. */
  settledAt: string | null;
}

const toNote = (row: Record<string, unknown>): TaskNote => ({
  id: Number(row.id),
  taskId: Number(row.task_id),
  text: String(row.text),
  sentAt: String(row.sent_at),
  state: String(row.state) as NoteState,
  attemptId: typeof row.attempt_id === "number" ? row.attempt_id : null,
  reason: typeof row.reason === "string" ? row.reason : null,
  settledAt: typeof row.settled_at === "string" ? row.settled_at : null,
});

/** Every note sent to a task, oldest first. */
export function taskNotes(db: DatabaseSync, taskId: number): TaskNote[] {
  return db.prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY id").all(taskId).map(toNote);
}

/** The note that waits for the task's builder, or null. */
export function waitingNote(db: DatabaseSync, taskId: number): TaskNote | null {
  const row = db.prepare("SELECT * FROM task_notes WHERE task_id = ? AND state = 'waiting'").get(taskId);
  return row ? toNote(row) : null;
}

const noteById = (db: DatabaseSync, id: number): TaskNote => toNote(db.prepare("SELECT * FROM task_notes WHERE id = ?").get(id)!);

/** Why `text` cannot be a note, in words for the owner; null when it can. Only a string reaches this. */
export function noteProblem(text: string): string | null {
  if (text.trim() === "") return "Write a note first: it is empty.";
  if (text.trim().length > MAX_NOTE) return `The note is too long: ${MAX_NOTE} characters at most.`;
  return null;
}

/**
 * Store a note as the one waiting for its task, inside the caller's transaction (which has checked that the task is
 * building). One already waiting is marked replaced in the same write, at the same moment. Returns both.
 */
export function queueNoteIn(db: DatabaseSync, taskId: number, text: string): { note: TaskNote; replaced: TaskNote | null } {
  const at = now();
  const before = waitingNote(db, taskId);
  if (before !== null) db.prepare("UPDATE task_notes SET state = 'replaced', settled_at = ? WHERE id = ?").run(at, before.id);
  const id = Number(db.prepare("INSERT INTO task_notes (task_id, text, sent_at, state) VALUES (?, ?, ?, 'waiting')").run(taskId, text.trim(), at).lastInsertRowid);
  return { note: noteById(db, id), replaced: before === null ? null : noteById(db, before.id) };
}

/**
 * Take the waiting note out of waiting as delivered to `attemptId`, in one write, just before it is sent: it is then
 * never sent again, by a later end of the same turn or by a restart. Null when no note waits.
 */
export function claimNote(db: DatabaseSync, taskId: number, attemptId: number): TaskNote | null {
  return transaction(db, () => {
    const note = waitingNote(db, taskId);
    if (note === null) return null;
    db.prepare("UPDATE task_notes SET state = 'delivered', attempt_id = ?, settled_at = ? WHERE id = ?").run(attemptId, now(), note.id);
    return noteById(db, note.id);
  });
}

/** Mark the task's waiting note, if any, not delivered with `reason`, inside the caller's transaction. Returns it, or null. */
export function settleWaitingIn(db: DatabaseSync, taskId: number, reason: string): TaskNote | null {
  const note = waitingNote(db, taskId);
  if (note === null) return null;
  db.prepare("UPDATE task_notes SET state = 'not_delivered', reason = ?, settled_at = ? WHERE id = ?").run(reason, now(), note.id);
  return noteById(db, note.id);
}

/** `settleWaitingIn` in its own transaction. */
export function settleWaiting(db: DatabaseSync, taskId: number, reason: string): TaskNote | null {
  return transaction(db, () => settleWaitingIn(db, taskId, reason));
}

/**
 * The note a task's screen shows as not delivered: the latest note, when it was not delivered. Null when there is
 * none, or the latest was delivered, replaced or still waits.
 */
export function undeliveredNote(db: DatabaseSync, taskId: number): TaskNote | null {
  const row = db.prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId);
  const note = row ? toNote(row) : null;
  return note?.state === "not_delivered" ? note : null;
}

/** Whether the waiting note replaced one that waited before it: that one was marked replaced at the moment this was sent. */
export function replacedOne(db: DatabaseSync, note: TaskNote): boolean {
  return db.prepare("SELECT 1 FROM task_notes WHERE task_id = ? AND id < ? AND state = 'replaced' AND settled_at = ? LIMIT 1").get(note.taskId, note.id, note.sentAt) !== undefined;
}

/** Why a note to a task at `status` is refused, in words for the owner: every status but `building`. */
export const NOTE_REFUSED: Record<Exclude<TaskStatus, "building">, string> = {
  queued: "This task has not started yet, so there is nothing for a note to follow. You can send one once Claude Code is working on it.",
  verifying: "Claude Code has finished this task and its checks are running, so a note can no longer reach it.",
  reviewing: "Claude Code has finished this task and it is being reviewed, so a note can no longer reach it.",
  awaiting_decision: "Claude Code has finished this task and it is ready for review, so a note can no longer reach it.",
  failed: "This task failed, so a note can no longer reach Claude Code.",
  interrupted: "This task is stopped, so a note cannot reach Claude Code. Resume it first, if it offers Resume.",
  cancelled: "This task was cancelled, so a note can no longer reach Claude Code.",
  accepted: "This task was accepted, so a note can no longer reach Claude Code.",
  rejected: "This task was rejected, so a note can no longer reach Claude Code.",
};

/** Why a note is refused in the moment between the end of the builder's last turn and the task's move on from building. */
export const NOTE_TOO_LATE = "Claude Code has just finished, and Botbench is committing the work, so a note can no longer reach it.";

/** Why a waiting note was not delivered, by how the builder's turn ended (engine/task.ts, `drive`). */
export const NOT_DELIVERED = {
  cancelled: "The run was cancelled before Claude Code finished, so your note was not sent.",
  silent: "Claude Code went silent and was stopped before it finished, so your note was not sent.",
  error: "Claude Code ended with an error before it finished, so your note was not sent.",
  interrupted: "Claude Code was stopped before it finished, so your note was not sent.",
  stopping: "Botbench stopped before Claude Code finished, so your note was not sent. You can send it again once the task is working.",
  leftover: "Claude Code's process could not be stopped, so your note was not sent.",
} as const;

/**
 * Why a waiting note was not delivered when its task left building some other way (its setup failed, a restart stopped
 * it, it was cancelled with no turn running), by where the task went. Written with the move (engine/task.ts, `moveTaskIn`).
 */
export function leftBuilding(to: TaskStatus): string {
  if (to === "failed") return "The task failed before your note could be sent.";
  if (to === "interrupted") return "The task was stopped before your note could be sent.";
  if (to === "cancelled") return "The run was cancelled before your note could be sent.";
  return "Claude Code had finished before your note could be sent.";
}
