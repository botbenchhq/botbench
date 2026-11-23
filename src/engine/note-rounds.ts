import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import type { TaskNote } from "./notes.ts";
import { agentName } from "./roles.ts";

/*
 * A round started by the owner's note to a task that is ready for review (issue #156; the round itself runs in
 * engine/task.ts). The note is stored as the owner's words (engine/notes.ts, marked `forRound`), the task goes back to
 * building on the owner's word, and the builder's session is taken up again in the same copy with the note as its next
 * prompt, under the same admission, confinement and permission check as the build: it grants nothing. When the turn
 * ends, Botbench commits; work that changed is checked and reviewed again, as after a reviewer's round of fixes, and the
 * task goes back to the owner or is accepted by its run's mode. A round that changed nothing records no checks for the
 * same version again: the task goes back to the owner with a plain line saying so.
 *
 * Approach, from three references. Paperclip's issue route (server/src/routes/issues.ts, the implicit reopen) lets only a
 * person's comment reopen finished work and wake its assignee with it, never an agent's; here only the owner's note,
 * through the signed-in route, takes a task that is ready for review back to work, and nothing a model writes becomes a
 * note. OpenMausBot's steer queue (server/steer-queue.ts) keeps a message sent to a busy agent off the transcript until
 * it runs; the note waits the same way, in `task_notes`, until its round's session takes it. Rakazo's stuck work
 * (packages/core/src/runs/stuck-work.ts) keeps queued work a state of its own, in words, and marks each waiting episode
 * once; a round or Resume queued behind another task reports Waiting, naming that task (engine/task.ts, `waitingBehind`),
 * and a restart's pick-up is one line until the owner acts or the task ends. Its reminders and expiry did not fit: a
 * queued round here waits only for the task ahead of it, which ends by itself.
 */

/** One round started by the owner's note, as stored once it ended. */
export interface NoteRound {
  id: number;
  taskId: number;
  noteId: number;
  /** How many reviews the task had when the round began: a review after that is the round's. */
  afterReviews: number;
  attemptId: number | null;
  outcome: "finished" | "failed" | "stopped";
  changed: boolean;
  reply: string;
  /** Why it did not finish, in words for the owner; null when it finished. */
  problem: string | null;
  fromCommit: string;
  headCommit: string | null;
  startedAt: string;
  endedAt: string;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A task's note rounds that ended, in order. */
export function taskNoteRounds(db: DatabaseSync, taskId: number): NoteRound[] {
  return db.prepare("SELECT * FROM note_rounds WHERE task_id = ? ORDER BY id").all(taskId).map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    noteId: Number(row.note_id),
    afterReviews: Number(row.after_reviews),
    attemptId: typeof row.attempt_id === "number" ? row.attempt_id : null,
    outcome: String(row.outcome) as NoteRound["outcome"],
    changed: row.changed === 1,
    reply: String(row.reply),
    problem: text(row.problem),
    fromCommit: String(row.from_commit),
    headCommit: text(row.head_commit),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
  }));
}

/** Store a note round that ended. */
export function insertNoteRound(db: DatabaseSync, r: Omit<NoteRound, "id" | "endedAt">): void {
  db.prepare("INSERT INTO note_rounds (task_id, note_id, after_reviews, attempt_id, outcome, changed, reply, problem, from_commit, head_commit, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    r.taskId, r.noteId, r.afterReviews, r.attemptId, r.outcome, r.changed ? 1 : 0, r.reply, r.problem, r.fromCommit, r.headCommit, r.startedAt, now(),
  );
}

const toNote = (row: Record<string, unknown>): TaskNote => ({
  id: Number(row.id),
  taskId: Number(row.task_id),
  text: String(row.text),
  sentAt: String(row.sent_at),
  state: String(row.state) as TaskNote["state"],
  attemptId: typeof row.attempt_id === "number" ? row.attempt_id : null,
  reason: text(row.reason),
  settledAt: text(row.settled_at),
  forRound: true,
  roundFrom: text(row.round_from),
});

/**
 * The note of the round a task is on, read from the store: its latest note sent for a round that waits or was
 * delivered, when no round has ended for it. Null when the task is on no note round.
 */
export function openNoteRound(db: DatabaseSync, taskId: number): TaskNote | null {
  const row = db.prepare("SELECT n.* FROM task_notes n WHERE n.task_id = ? AND n.for_round = 1 AND n.state IN ('waiting', 'delivered') AND NOT EXISTS (SELECT 1 FROM note_rounds r WHERE r.note_id = n.id) ORDER BY n.id DESC LIMIT 1").get(taskId);
  return row ? toNote(row) : null;
}

/**
 * Whether a note round began after the task's latest review, or one is under way: a round of fixes for that review is
 * then not what the builder is on (engine/refine.ts, `refineRoundOf`). `reviews` is how many reviews the task has.
 */
export function noteRoundSinceReview(db: DatabaseSync, taskId: number, reviews: number): boolean {
  if (openNoteRound(db, taskId) !== null) return true;
  return db.prepare("SELECT 1 FROM note_rounds WHERE task_id = ? AND after_reviews >= ? LIMIT 1").get(taskId, reviews) !== undefined;
}

/** How many note rounds of a task changed the work: each is a version of the work of its own (engine/check-fix.ts, `workVersion`). */
export const changedNoteRounds = (db: DatabaseSync, taskId: number): number => Number(db.prepare("SELECT count(*) AS n FROM note_rounds WHERE task_id = ? AND changed = 1").get(taskId)!.n);

/**
 * The plain line about the task's latest note round, for a task that is ready for review again after it and had
 * nothing new to check: its builder changed nothing, or its turn did not finish. Null for any other task.
 */
export function noteRoundLine(db: DatabaseSync, task: { id: number; status: string; builderAgent: string | null }): string | null {
  if (task.status !== "awaiting_decision") return null;
  const last = taskNoteRounds(db, task.id).at(-1);
  if (last === undefined || last.changed) return null;
  // A later review or decision point came from something else: the line is only about the round that brought it back.
  const back = db.prepare("SELECT ts FROM task_events WHERE task_id = ? AND status = 'awaiting_decision' ORDER BY id DESC LIMIT 1").get(task.id)?.ts;
  if (typeof back !== "string" || back < last.endedAt) return null;
  const builder = agentName(task.builderAgent ?? "claude-code");
  const reached = db.prepare("SELECT 1 FROM task_notes WHERE id = ? AND state = 'delivered'").get(last.noteId) !== undefined;
  if (!reached) return `Your note did not reach ${builder}, so nothing changed and the checks and the review were not run again.`;
  if (last.outcome !== "finished") return `${builder} did not finish working on your note and changed nothing, so the checks and the review were not run again.`;
  return `${builder} changed nothing for your note, so the checks and the review were not run again.`;
}
