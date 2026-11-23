import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import { loopRecord, reviewOutcome as loopOutcome } from "./refine.ts";
import { reviewAssignment } from "./review.ts";

/*
 * The three modes of a run, chosen when it starts and never changed after (a trigger refuses it).
 *   manual  the owner approves the plan, every command that is not allowed in advance asks, the owner decides
 *   semi    the owner approves the plan and decides; a command that runs inside the confinement runs without asking
 *   full    the plan is approved by the mode; confined commands run without asking; whatever would ask the owner is
 *           refused instead (the safety floor among it); a task is accepted by the mode when every check passed and
 *           the review is satisfied or there is none, and handed back to the owner, saying why, when not
 * A mode never loosens the safety floor, and broker failure denies in every mode. Nothing is ever merged; an accepted
 * task's branch is pushed only by a run that chose to open a pull request (decision.ts, `acceptedWords`).
 */

export type RunMode = "manual" | "semi" | "full";
export const RUN_MODES: readonly RunMode[] = ["manual", "semi", "full"];
export const isRunMode = (value: unknown): value is RunMode => typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);

/** A mode in the words a sentence uses: "this run is …". */
export const MODE_WORDS: Record<RunMode, string> = { manual: "manual", semi: "semi-autonomous", full: "fully autonomous" };

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

/**
 * Where a task's review stands: "none" (its run has no reviewer), "satisfied", "unresolved" (concerns, or no verdict in
 * the asked form, after the last round of fixes) or "failed" (a review or a round of fixes did not finish, or there is no
 * review yet). Read from the refine loop's records (engine/refine.ts).
 */
export type ReviewOutcome = "none" | "satisfied" | "unresolved" | "failed";
export function reviewOutcome(db: DatabaseSync, taskId: number): ReviewOutcome {
  const assigned = reviewAssignment(db, taskId);
  if (assigned === null) return "none";
  // The refine loop's outcome: "satisfied" only when the loop ended with the reviewer saying it looks right. A review
  // that has not happened yet is not a satisfied one.
  const record = loopRecord(db, taskId, assigned.agent);
  return record.reviews.length === 0 ? "failed" : loopOutcome(record);
}

/** What a fully autonomous run refused during a task: each refused request's command, oldest first. */
export function modeRefusals(db: DatabaseSync, taskId: number): string[] {
  return db.prepare("SELECT tool, command FROM action_log WHERE task_id = ? AND rule = 'mode_refused' ORDER BY id").all(taskId).map((row) => (row.tool === "Bash" ? String(row.command) : `${String(row.tool)} ${String(row.command)}`.trim()));
}

export interface AcceptFacts {
  /** What the checks found: "passed" only when at least one ran and every one passed. */
  checks: "passed" | "failed" | "none" | null;
  review: ReviewOutcome;
  /** The requests the mode refused during the task. */
  refusals: readonly string[];
}

const shorten = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * Whether a fully autonomous run accepts a task without the owner, from what is known of it: every check passed (so at
 * least one is set up), the review is satisfied or the run has none, and nothing was refused during the task. Answers
 * the reasons it qualified, for the record, or the plain reasons it needs the owner. Whether the builder touched files
 * the plan did not expect is not known to Botbench and is not judged here.
 */
export function autoAccept(facts: AcceptFacts): { accept: true; reasons: string } | { accept: false; why: string } {
  const why: string[] = [];
  if (facts.checks === "failed") why.push("A check failed.");
  else if (facts.checks !== "passed") why.push("No checks ran on it.");
  if (facts.review === "unresolved") why.push("The reviewer raised concerns.");
  else if (facts.review === "failed") why.push("The review did not finish.");
  if (facts.refusals.length > 0) why.push(`Botbench refused ${facts.refusals.length === 1 ? "something" : `${facts.refusals.length} things`} an agent asked to do during this task (${shorten(facts.refusals.join("; "))}).`);
  if (why.length > 0) return { accept: false, why: `It needs your review: ${why.join(" ")}` };
  const review = facts.review === "satisfied" ? "the reviewer said it looks right" : "this run has no reviewer";
  return { accept: true, reasons: `Accepted without you, as this run is fully autonomous: every check passed, ${review}, and nothing an agent asked for was refused.` };
}
