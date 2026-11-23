import type { DatabaseSync } from "node:sqlite";
import { RunError } from "./run.ts";
import { getTask, type TaskStatus } from "./task.ts";

/*
 * "Make this a run": the owner's feedback on a finished task, or on a chat, becomes a new run. The run carries the
 * owner's own words (the note) and, for a task, only what Botbench itself recorded of it: its id and its branch's
 * name. Nothing an agent wrote is carried: no task summary, no reviewer's finding, no reply from a chat. So the run
 * reads no outside text, is not marked as such (`runs.outside_text` stays 0, engine/intake.ts), and may be run in
 * any mode. A run built on an agent's words would instead have to quote them between `outsideTextPrompt` markers and
 * be marked; no such run exists. The run records where it came from (`runs.source_task_id`, `runs.source_chat_id`),
 * set when it is stored and never changed (src/store/schema.ts).
 *
 * Adapted from Paperclip's rule that only a person's comment reopens finished work (`shouldImplicitlyMoveCommentedIssueToTodo`
 * in .reference/paperclip/server/src/routes/issues.ts): here only the owner's words make new work from finished work,
 * and only when the owner presses Send; an agent's text never does.
 */

export type RunSource = { kind: "task"; id: number } | { kind: "chat"; id: number };

/** The longest note a run made from a task or a chat may have, in characters. */
export const MAX_RUN_NOTE = 10_000;
export const NOTE_EMPTY = "The note is empty. Say in it what the run should do.";
export const noteTooLong = (length: number): string => `The note is too long: ${MAX_RUN_NOTE.toLocaleString("en-US")} characters at most, and this one has ${length.toLocaleString("en-US")}.`;

/** Why `note` cannot be the message of a run made from a task or a chat, or null when it can. */
export function noteProblem(note: unknown): string | null {
  if (typeof note !== "string" || note.trim() === "") return NOTE_EMPTY;
  if (note.length > MAX_RUN_NOTE) return noteTooLong(note.length);
  return null;
}

/** The task states a run can be made from: handed back for a decision, accepted, or rejected. */
export const SOURCE_STATUSES: readonly TaskStatus[] = ["awaiting_decision", "accepted", "rejected"];

const UNFINISHED: Partial<Record<TaskStatus, string>> = {
  queued: "is queued",
  building: "is still being built",
  verifying: "is still having its checks run",
  reviewing: "is still being reviewed",
  waiting_for_limit: "is waiting for a usage limit to reset",
};
const ENDED: Partial<Record<TaskStatus, string>> = { failed: "failed", cancelled: "was cancelled", interrupted: "was stopped" };
const FROM_WHAT = "A run is made from a task once it is ready for review, accepted or rejected.";

/** The one line saying where a run came from: "From task 12", "From a chat". */
export const sourceLabel = (source: RunSource): string => (source.kind === "task" ? `From task ${source.id}` : "From a chat");

/** The source a request names: null for none, else `{ "task": id }` or `{ "chat": id }`. Anything else is refused before anything is looked at. */
export function sourceGiven(given: unknown): RunSource | null {
  if (given === undefined || given === null) return null;
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  const shape = '"source" must be null, { "task": <task id> } or { "chat": <chat id> }.';
  if (typeof given !== "object" || Array.isArray(given)) throw new RunError(400, shape);
  const entries = Object.entries(given as Record<string, unknown>);
  if (entries.length !== 1) throw new RunError(400, shape);
  const [kind, id] = entries[0]!;
  if ((kind !== "task" && kind !== "chat") || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new RunError(400, shape);
  return { kind, id };
}

/** The chat an attempt belongs to, by the chat's id; null when the attempt is in no recorded chat. */
const chatOf = (db: DatabaseSync, attemptId: number): number | null => {
  const row = db.prepare("SELECT chat_id FROM chat_members WHERE attempt_id = ?").get(attemptId);
  return row === undefined ? null : Number(row.chat_id);
};

export interface CheckedSource {
  kind: "task" | "chat";
  /** The task's id, or the chat's own id (its first attempt). */
  id: number;
  /** The task's repository, by its real path; null for a chat, which has none of its own. */
  repo: string | null;
  /** The task's branch as Botbench named it; null for a chat. */
  branch: string | null;
  /** One plain line saying where the run came from. */
  label: string;
}

/**
 * Check a source as Botbench has it: a task that exists and is finished (ready for review, accepted or rejected), in
 * the repository `repo` when one is given; or a chat Botbench recorded, by any of its attempts. Throws a RunError with
 * a plain reason otherwise. Reads only; nothing is written.
 */
export function checkSource(db: DatabaseSync, source: RunSource, repo: string | null): CheckedSource {
  if (source.kind === "chat") {
    const chat = chatOf(db, source.id);
    if (chat === null) throw new RunError(404, "That chat is not in Botbench's records, so no run can be made from it.");
    return { kind: "chat", id: chat, repo: null, branch: null, label: sourceLabel({ kind: "chat", id: chat }) };
  }
  const task = getTask(db, source.id);
  if (task === null) throw new RunError(404, `There is no task ${source.id}, so no run can be made from it.`);
  if (!SOURCE_STATUSES.includes(task.status)) {
    const unfinished = UNFINISHED[task.status];
    if (unfinished !== undefined) throw new RunError(409, `Task ${task.id} ${unfinished}, so no run can be made from it yet. ${FROM_WHAT}`);
    throw new RunError(409, `Task ${task.id} ${ENDED[task.status] ?? "is not finished"}, so no run can be made from it. ${FROM_WHAT}`);
  }
  if (repo !== null && repo !== task.repo) throw new RunError(400, `Task ${task.id} was built in ${task.repo}, not ${repo}. A run made from it works in the same repository.`);
  return { kind: "task", id: task.id, repo: task.repo, branch: task.branch, label: sourceLabel({ kind: "task", id: task.id }) };
}

/** Where a run came from, as stored; null for a run started any other way. */
export function sourceOf(db: DatabaseSync, runId: number): RunSource | null {
  const row = db.prepare("SELECT source_task_id, source_chat_id FROM runs WHERE id = ?").get(runId);
  if (row === undefined) return null;
  if (row.source_task_id !== null) return { kind: "task", id: Number(row.source_task_id) };
  if (row.source_chat_id !== null) return { kind: "chat", id: Number(row.source_chat_id) };
  return null;
}

/** The runs made from a task, oldest first. */
export const runsMadeFrom = (db: DatabaseSync, taskId: number): number[] => db.prepare("SELECT id FROM runs WHERE source_task_id = ? ORDER BY id").all(taskId).map((row) => Number(row.id));

/**
 * What the planner of a run made from a source is told of it, from Botbench's own records only: for a task, its id and
 * its branch's name and nothing else (not its status or the owner's decision); for a chat, only that it was one.
 */
export function sourcePrompt(db: DatabaseSync, source: RunSource): string {
  const note = "The work above is the owner's own note; nothing an agent wrote is included.";
  if (source.kind === "chat") return `Botbench's record: the owner made this run from a chat in Botbench. ${note}`;
  const branch = getTask(db, source.id)?.branch ?? null;
  const where = branch === null ? "which has no branch" : `whose work is on the branch \`${branch}\``;
  return `Botbench's record: the owner made this run from task ${source.id} in this repository, ${where}. ${note}`;
}

/** One message the owner wrote in a chat. */
export interface OwnerMessage {
  text: string;
  at: string;
}

/**
 * The messages the owner wrote in a chat, oldest first, as the chat shows them: each round's message once, and each
 * message the owner sent an agent that keeps its own conversation (Claude Code). Never an agent's reply, a request to
 * compare answers (Botbench's, not the owner's), or the prompt Botbench framed for an agent from the conversation so
 * far, which holds agents' replies: an attempt of a round was sent that framing as its first prompt.
 */
export function ownerMessages(db: DatabaseSync, chatId: number): OwnerMessage[] {
  const found: OwnerMessage[] = [];
  const rounds = new Set<number>();
  const attempts = db.prepare("SELECT m.attempt_id, c.round_id FROM chat_members m JOIN chat_attempts c ON c.attempt_id = m.attempt_id WHERE m.chat_id = ? ORDER BY m.attempt_id").all(chatId);
  for (const attempt of attempts) {
    const roundId = attempt.round_id === null ? null : Number(attempt.round_id);
    if (roundId !== null && !rounds.has(roundId)) {
      rounds.add(roundId);
      const round = db.prepare("SELECT kind, message, created_at FROM chat_rounds WHERE id = ?").get(roundId);
      if (round !== undefined && round.kind === "ask") found.push({ text: String(round.message), at: String(round.created_at) });
    }
    const attemptId = Number(attempt.attempt_id);
    const first = Number(db.prepare("SELECT min(turn) AS turn FROM events WHERE attempt_id = ?").get(attemptId)?.turn ?? 0);
    for (const row of db.prepare("SELECT turn, ts, payload FROM events WHERE attempt_id = ? AND type = 'user_prompt' ORDER BY id").all(attemptId)) {
      if (roundId !== null && Number(row.turn) === first) continue;
      let text: unknown;
      try {
        text = (JSON.parse(String(row.payload)) as { text?: unknown }).text;
      } catch {
        continue;
      }
      if (typeof text === "string") found.push({ text, at: String(row.ts) });
    }
  }
  return found.filter((m) => m.text.trim() !== "").sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
