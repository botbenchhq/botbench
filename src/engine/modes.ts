import type { DatabaseSync } from "node:sqlite";
import { asRefusalKind, refusalBlocksAccept, type RefusalKind } from "../approvals/refusals.ts";
import { now } from "../store/db.ts";
import { loopRecord, NO_ACCOUNT, reviewOutcome as loopOutcome } from "./refine.ts";
import { reviewAssignment } from "./review.ts";
import { protectedWords, unexpectedWords } from "./scope.ts";

/*
 * The three modes of a run, chosen when it starts. While the run has not finished the owner may make its mode stricter
 * (fully autonomous to semi-autonomous or manual, semi-autonomous to manual), never looser; a trigger refuses any other
 * change, and each change is in the run's history as the owner's (`tightenMode` in run.ts, `modeChanges` here). Making
 * a mode stricter only takes away what the run did without the owner: the broker and the engine read the mode from the
 * store for each request and each result, so from the next one a request that ran or was refused may ask, and a result
 * the mode would have accepted waits for the owner. A request already waiting stays for the owner, a turn under way
 * finishes, and the safety floor and the rules for a run that read outside text are the same in every mode, so none
 * of them is loosened by the change. A mode is about the
 * owner's decisions, not about tools: in every mode using a tool never asks (a read, an edit inside the task's copy, a
 * confined command the safety floor does not name, the CLI's own bookkeeping, the web as the owner's setting Web
 * access allows), and an action or change that matters outside the copy asks (approvals/gate.ts).
 *   manual  the owner approves the plan and decides on each result
 *   semi    building starts without plan approval; the owner decides on each result. A run that read outside text (a
 *           GitHub issue) still waits for the owner's plan approval: a stranger's text does not start a build alone
 *   full    no plan approval; whatever would ask the owner is refused instead (the safety floor among it); a task is
 *           accepted by the mode when every check passed, the review is satisfied or there is none, nothing refused
 *           blocks it (approvals/refusals.ts; a web tool refused because Web access is Off blocks it), and every changed
 *           file is expected from the plan and none is under a protected path; handed back to the owner, saying why, when not
 * In every mode a task that changed a file under a protected path waits for the owner with a reason naming the files.
 * The owner's setting "Ask before every command" brings back a card for every command of a manual run and of a task
 * started on its own (which is always manual). A mode never loosens the safety floor, and broker failure denies in
 * every mode. Nothing is ever merged; an accepted task's branch is pushed only by a run that chose to open a pull
 * request (decision.ts, `acceptedWords`).
 */

export type RunMode = "manual" | "semi" | "full";
export const RUN_MODES: readonly RunMode[] = ["manual", "semi", "full"];
export const isRunMode = (value: unknown): value is RunMode => typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);

/** A mode in the words a sentence uses: "this run is …". */
export const MODE_WORDS: Record<RunMode, string> = { manual: "manual", semi: "semi-autonomous", full: "fully autonomous" };

/**
 * The modes a run may be made stricter to now, strictest last: none for a manual run or one that has finished. The
 * store's trigger `runs_mode_stricter_only` holds the same rule. `status` is a run's (engine/run.ts `RunStatus`).
 */
export function stricterModes(mode: RunMode, status: string): RunMode[] {
  if (status === "done" || status === "cancelled" || status === "failed") return [];
  return RUN_MODES.slice(0, RUN_MODES.indexOf(mode)).reverse();
}

/** Each change of a run's mode the owner made, oldest first, with when and what the run screen says of it. */
export function modeChanges(db: DatabaseSync, runId: number): { at: string; from: RunMode; to: RunMode; words: string }[] {
  return db
    .prepare("SELECT ts, mode_from, mode_to FROM run_events WHERE run_id = ? AND mode_to IS NOT NULL ORDER BY id")
    .all(runId)
    .flatMap((row) => (isRunMode(row.mode_from) && isRunMode(row.mode_to) ? [{ at: String(row.ts), from: row.mode_from, to: row.mode_to, words: `You changed the mode from ${MODE_WORDS[row.mode_from]} to ${MODE_WORDS[row.mode_to]}.` }] : []));
}

/** The mode of a run by its id; manual for a task of no run, as every task was before modes. */
export function runModeOf(db: DatabaseSync, runId: number | null): RunMode {
  if (runId === null) return "manual";
  const mode = db.prepare("SELECT mode FROM runs WHERE id = ?").get(runId)?.mode;
  return isRunMode(mode) ? mode : "manual";
}

/** The mode a new run gets when the owner names none: the one chosen in Settings, else the settings file's, else manual. */
export function defaultMode(db: DatabaseSync, configured: RunMode | undefined): RunMode {
  const stored = db.prepare("SELECT value FROM owner_settings WHERE name = 'default_mode'").get()?.value;
  return isRunMode(stored) ? stored : (configured ?? "manual");
}

export function setDefaultMode(db: DatabaseSync, mode: RunMode): void {
  db.prepare("INSERT INTO owner_settings (name, value, updated_at) VALUES ('default_mode', ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(mode, now());
}

/** Whether the owner chose "Ask before every command" in Settings; off when never chosen. Read from the store for each request. */
export function askEveryCommand(db: DatabaseSync): boolean {
  return db.prepare("SELECT value FROM owner_settings WHERE name = 'ask_every_command'").get()?.value === "on";
}

export function setAskEveryCommand(db: DatabaseSync, on: boolean): void {
  db.prepare("INSERT INTO owner_settings (name, value, updated_at) VALUES ('ask_every_command', ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(on ? "on" : "off", now());
}

/** Whether a run's plan is approved without the owner as soon as it is stored: fully autonomous, and semi-autonomous unless the run read outside text. */
export const planApprovedByMode = (run: { mode: RunMode; outsideText: boolean }): boolean => run.mode === "full" || (run.mode === "semi" && !run.outsideText);

/**
 * Where a task's review stands: "none" (its run has no reviewer), "satisfied", "unaccounted" (it looks right, but the
 * review does not say what it checked), "unresolved" (concerns, or no verdict in
 * the asked form, after the last round of fixes) or "failed" (a review or a round of fixes did not finish, or there is no
 * review yet). Read from the refine loop's records (engine/refine.ts).
 */
export type ReviewOutcome = "none" | "satisfied" | "unaccounted" | "unresolved" | "failed";
export function reviewOutcome(db: DatabaseSync, taskId: number): ReviewOutcome {
  const assigned = reviewAssignment(db, taskId);
  if (assigned === null) return "none";
  // The refine loop's outcome: "satisfied" only when the loop ended with the reviewer saying it looks right and what it
  // checked. A review
  // that has not happened yet is not a satisfied one.
  const record = loopRecord(db, taskId, assigned.agent);
  return record.reviews.length === 0 ? "failed" : loopOutcome(record);
}

/**
 * One request a fully autonomous run refused: its command as a line, its kind (null for one recorded before kinds were),
 * and the tool that asked (Bash for a shell command; left out, a shell command).
 */
export interface ModeRefusal {
  command: string;
  kind: RefusalKind | null;
  tool?: string;
}

/** "1 command", "6 commands", or "requests" when not every one is a shell command: how many were refused, in words. */
export function refusedCount(refusals: readonly ModeRefusal[]): string {
  const commands = refusals.every((refusal) => (refusal.tool ?? "Bash") === "Bash");
  const noun = commands ? (refusals.length === 1 ? "command" : "commands") : refusals.length === 1 ? "request" : "requests";
  return `${refusals.length} ${noun}`;
}

/** Where the task screen lists every refused request in full, which the one-line reasons point to. */
const LISTED = "Each is listed under Refused without asking.";

/** What was refused without asking during a task, oldest first: by a fully autonomous run, or because Web access is Off (a refusal of the network). */
export function modeRefusals(db: DatabaseSync, taskId: number): ModeRefusal[] {
  return db
    .prepare("SELECT rule, tool, command, refusal FROM action_log WHERE task_id = ? AND rule IN ('mode_refused', 'web_refused') ORDER BY id")
    .all(taskId)
    .map((row) => ({
      command: row.tool === "Bash" ? String(row.command) : `${String(row.tool)} ${String(row.command)}`.trim(),
      kind: row.rule === "web_refused" ? "network" : asRefusalKind(row.refusal),
      tool: String(row.tool),
    }));
}

/**
 * The questions the task's agent asked during a fully autonomous run, which nobody was asked (approvals/question.ts), oldest
 * first: the agent decided each itself. Read from the log entry that recorded each with what the agent was told.
 */
export function unaskedQuestions(db: DatabaseSync, taskId: number): string[] {
  return db.prepare("SELECT command FROM action_log WHERE task_id = ? AND rule = 'question_unasked' ORDER BY id").all(taskId).map((row) => String(row.command));
}

export interface AcceptFacts {
  /** What the checks found: "passed" only when at least one ran and every one passed. */
  checks: "passed" | "failed" | "none" | null;
  review: ReviewOutcome;
  /** The requests the mode refused during the task. */
  refusals: readonly ModeRefusal[];
  /** The questions the agent asked that nobody was asked (`unaskedQuestions`). None when left out. */
  questions?: readonly string[];
  /** Changed files under a protected path, and changed files the plan did not lead one to expect (engine/scope.ts). None when left out. */
  protectedFiles?: readonly string[];
  unexpectedFiles?: readonly string[];
}

/**
 * Whether a fully autonomous run accepts a task without the owner, from what is known of it: every check passed (so at
 * least one is set up), the review is satisfied or the run has none, nothing refused during the task blocks the
 * accept (`refusalBlocksAccept`: the safety rules, or a request that would have left the confinement), no changed file
 * is under a protected path, and every changed file is one the plan led one to expect (engine/scope.ts). Answers the
 * reasons it qualified, for the record, naming any refusal that did not block, or the plain reasons it needs the owner.
 * Refused commands are counted, not quoted: these reasons are the task's one-line status, and a command can be thousands
 * of characters (a here-document). The task screen lists every one in full under Refused without asking.
 */
export function autoAccept(facts: AcceptFacts): { accept: true; reasons: string } | { accept: false; why: string } {
  const why: string[] = [];
  if (facts.checks === "failed") why.push("A check failed.");
  else if (facts.checks !== "passed") why.push("No checks ran on it.");
  if (facts.review === "unresolved") why.push("The reviewer raised concerns.");
  else if (facts.review === "unaccounted") why.push(`${NO_ACCOUNT}.`);
  else if (facts.review === "failed") why.push("The review did not finish.");
  const blocking = facts.refusals.filter((refusal) => refusalBlocksAccept(refusal.kind));
  if (blocking.length > 0) why.push(`${refusedCount(blocking)} refused during this task.`);
  // A question is the agent saying it needed the owner's choice: it chose for itself, and the owner sees what it chose.
  const questions = facts.questions ?? [];
  if (questions.length > 0) why.push(`Claude Code had ${questions.length === 1 ? "a question" : `${questions.length} questions`} for you and chose the answer itself, as a fully autonomous run puts no questions to you (${questions.map((q) => `"${q}"`).join("; ")}).`);
  if ((facts.protectedFiles?.length ?? 0) > 0) why.push(protectedWords(facts.protectedFiles!));
  if ((facts.unexpectedFiles?.length ?? 0) > 0) why.push(unexpectedWords(facts.unexpectedFiles!));
  // The rest of what was refused is counted too, apart, as it did not keep the task from being accepted.
  const harmless = facts.refusals.filter((refusal) => !refusalBlocksAccept(refusal.kind));
  if (why.length > 0 && harmless.length > 0) why.push(`${blocking.length > 0 ? "Also " : ""}${refusedCount(harmless)} refused that would not have kept it from being accepted.`);
  if (why.length > 0 && facts.refusals.length > 0) why.push(LISTED);
  if (why.length > 0) return { accept: false, why: `It needs your review: ${why.join(" ")}` };
  const review = facts.review === "satisfied" ? "the reviewer said it looks right and what it checked" : "this run has no reviewer";
  if (facts.refusals.length === 0) return { accept: true, reasons: `Accepted without you, as this run is fully autonomous: every check passed, ${review}, and nothing an agent asked for was refused.` };
  return { accept: true, reasons: `Accepted without you, as this run is fully autonomous: every check passed, ${review}, and the ${refusedCount(harmless)} Botbench refused ${harmless.length === 1 ? "was" : "were"} not on the always-ask list and would not have reached outside the task's copy. ${LISTED}` };
}
