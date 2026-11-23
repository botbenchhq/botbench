import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import { taskReviews } from "./review.ts";
import { agentName } from "./roles.ts";

/*
 * The refine loop's rules, as pure functions (the loop itself runs in engine/task.ts). After a review whose verdict is
 * concerns, the builder is given the review and asked to fix what it agrees with and say why for the rest; its work is
 * committed and checked again and the reviewer looks again, with the builder's reasons. The loop ends when the reviewer
 * says it looks right, the run's cap on rounds of fixes is reached, the builder changed nothing in a round, or a review
 * or a round of fixes did not finish; the task is then Ready for review. What either model wrote is data: it is passed
 * to the other model between marked lines and shown to the owner as text. Botbench reads only the verdict line, to
 * decide whether to ask for fixes, the review's "Checked:" lines, without which a looks-right verdict is not satisfied,
 * and the reply's headings, to count; none can make Botbench do anything else.
 */

/** The rounds of fixes a run allows when the settings name none. */
export const DEFAULT_MAX_REFINE_ROUNDS = 2;
/** The most rounds of fixes the settings may allow: each round is one builder turn and one review more. */
export const MAX_REFINE_ROUNDS = 5;

/**
 * What the loop did with a task's reviews, for the decision point: nothing reviewed, the reviewer satisfied, the reviewer
 * saying it looks right without saying what it checked, the models still disagreeing, or a review or round of fixes that
 * did not finish.
 */
export type ReviewOutcome = "none" | "satisfied" | "unaccounted" | "unresolved" | "failed";

/** A review as the loop reads it. */
export interface LoopReview {
  outcome: "reviewed" | "failed" | "timed_out" | "stopped";
  verdict: "looks_right" | "concerns" | null;
  text: string;
}
/** A round of fixes as the loop reads it: `finished` (its turn completed), `failed` or `stopped`; whether it changed the work; the builder's reply. */
export interface LoopRefinement {
  outcome: "finished" | "failed" | "stopped";
  changed: boolean;
  reply: string;
}

/** The verdict the loop goes by: a review in the asked form says it; any other finished review counts as concerns; a review that did not finish has none. */
export function loopVerdict(review: Pick<LoopReview, "outcome" | "verdict">): "looks_right" | "concerns" | null {
  if (review.outcome !== "reviewed") return null;
  return review.verdict === "looks_right" ? "looks_right" : "concerns";
}

const plain = (line: string): string => line.replace(/[*_`#]/g, "").trim();
const bullet = /^\s*[-*]\s+(.*\S)\s*$/;
const isNone = (item: string): boolean => /^none\.?$/i.test(plain(item));

/** The bullet lines after the line `at`, up to the first line that is neither a bullet nor blank. */
function bulletsAfter(lines: readonly string[], at: number, stop: (line: string) => boolean = () => false): string[] {
  const found: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (stop(line)) break;
    if (line.trim() === "") continue;
    const match = bullet.exec(line);
    if (!match) break;
    if (!isNone(match[1]!)) found.push(match[1]!.trim());
  }
  return found;
}

/** A review's findings: its bullet lines under "Findings:", without "- none". None when there is no such heading. */
export function parseFindings(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^findings\s*:$/i.test(plain(line)));
  return at === -1 ? [] : bulletsAfter(lines, at);
}

/**
 * What a review says it examined: the lines under its first "Checked:" heading (and any words on that line), without
 * "- none". Empty when the review gives no such account; such a review cannot satisfy the loop.
 */
export function parseChecked(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^checked\s*:/i.test(plain(line)));
  if (at === -1) return [];
  const inline = plain(lines[at]!).replace(/^checked\s*:/i, "").trim();
  return [...(inline === "" || isNone(inline) ? [] : [inline]), ...bulletsAfter(lines, at)];
}

const ADDRESSED = /^addressed\s*:$/i;
const NOT_ADDRESSED = /^not addressed,? and why\s*:$/i;

/** The builder's reply read for its closing form: what it addressed and what it did not, with why. Null when the reply does not end in that form. */
export function parseRefineReply(text: string): { addressed: string[]; notAddressed: string[] } | null {
  const lines = text.split("\n");
  const last = (re: RegExp): number => lines.map((line) => re.test(plain(line))).lastIndexOf(true);
  const a = last(ADDRESSED);
  const n = last(NOT_ADDRESSED);
  if (a === -1 || n === -1) return null;
  const heading = (line: string): boolean => ADDRESSED.test(plain(line)) || NOT_ADDRESSED.test(plain(line));
  return { addressed: bulletsAfter(lines, a, heading), notAddressed: bulletsAfter(lines, n, heading) };
}

export interface LoopRecord {
  /** The reviewer and the builder, by agent name. */
  agent: string;
  builder: string;
  reviews: readonly LoopReview[];
  refinements: readonly LoopRefinement[];
  /** The run's cap on rounds of fixes. */
  cap: number;
}

/** A round of fixes that came after the last review: the loop's latest step. */
const fixAfterLastReview = (r: LoopRecord): LoopRefinement | null => (r.refinements.length >= r.reviews.length && r.refinements.length > 0 ? r.refinements.at(-1)! : null);

/** The outcome so far, read from the records alone. Once the task is Ready for review it is the loop's outcome. */
export function reviewOutcome(r: LoopRecord): ReviewOutcome {
  const last = r.reviews.at(-1);
  if (last === undefined) return "none";
  if (last.outcome !== "reviewed") return "failed";
  const fix = fixAfterLastReview(r);
  if (fix !== null && fix.outcome !== "finished") return "failed";
  if (loopVerdict(last) !== "looks_right" || fix !== null) return "unresolved";
  // A verdict alone is not enough: the review must say what it examined.
  return parseChecked(last.text).length > 0 ? "satisfied" : "unaccounted";
}

/** The plain note on a review that does not say what it examined. */
export const NO_ACCOUNT = "The reviewer gave no account of what it checked";

/** "1 round", "2 rounds". */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The plain line about the loop on the task: what the reviewer raised, what the builder did, and how it stands. Empty with no review. */
export function outcomeLine(r: LoopRecord): string {
  const outcome = reviewOutcome(r);
  if (outcome === "none") return "";
  const reviewer = agentName(r.agent);
  const builder = agentName(r.builder);
  const first = r.reviews[0]!;
  if (first.outcome !== "reviewed") return `${reviewer}'s review did not finish: needs your judgment.`;
  if (outcome === "satisfied" && r.refinements.length === 0) return `${reviewer} found nothing to fix.`;
  const unaccounted = `${reviewer} said it looks right but gave no account of what it checked: needs your judgment.`;
  if (outcome === "unaccounted" && r.refinements.length === 0) return unaccounted;
  const parts: string[] = [];
  // What each review with concerns raised, in order: the builder's count below is of every round, so this is too.
  const raised = r.reviews.filter((review) => loopVerdict(review) === "concerns").map((review) => parseFindings(review.text).length);
  const [firstCount, ...later] = raised;
  const opening = firstCount === undefined || firstCount === 0 ? `${reviewer} raised concerns` : `${reviewer} raised ${count(firstCount, "concern", "concerns")}`;
  parts.push(`${opening}${later.map((n) => (n === 0 ? ", then concerns again" : `, then ${n}`)).join("")}.`);
  const finished = r.refinements.filter((fix) => fix.outcome === "finished");
  if (finished.length > 0) {
    const replies = finished.map((fix) => parseRefineReply(fix.reply));
    if (replies.some((reply) => reply === null)) parts.push(`${builder} replied to them.`);
    else {
      const addressed = replies.reduce((n, reply) => n + reply!.addressed.length, 0);
      const explained = replies.reduce((n, reply) => n + reply!.notAddressed.length, 0);
      if (!finished.some((fix) => fix.changed)) parts.push(`${builder} changed nothing and explained ${explained}.`);
      else parts.push(`${builder} addressed ${addressed}${explained > 0 ? ` and explained ${explained}` : ""}.`);
    }
  }
  const last = r.reviews.at(-1)!;
  const fix = fixAfterLastReview(r);
  if (outcome === "failed") parts.push(last.outcome !== "reviewed" ? `${reviewer}'s next review did not finish: needs your judgment.` : `${builder}'s fixes did not finish: needs your judgment.`);
  else if (outcome === "satisfied") parts.push(`${reviewer} is satisfied.`);
  else if (outcome === "unaccounted") parts.push(unaccounted);
  else if (r.cap > 0 && r.refinements.length >= r.cap && fix === null) parts.push(`Still disagree after ${count(r.refinements.length, "round", "rounds")}: needs your judgment.`);
  else parts.push("Needs your judgment.");
  return parts.join(" ");
}

/** One round of fixes, as stored: it follows the review of the same round. */
export interface Refinement extends LoopRefinement {
  id: number;
  taskId: number;
  round: number;
  /** The builder's session for this round, whose events are its transcript; null when it never started. */
  attemptId: number | null;
  /** Why the round did not finish, in words for the owner; null when it finished. */
  problem: string | null;
  /** The commit the round started from, and the one Botbench made after it (null when none could be made). */
  fromCommit: string;
  headCommit: string | null;
  startedAt: string;
  endedAt: string;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A task's rounds of fixes, in order. */
export function taskRefinements(db: DatabaseSync, taskId: number): Refinement[] {
  return db.prepare("SELECT * FROM refinements WHERE task_id = ? ORDER BY round").all(taskId).map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    round: Number(row.round),
    attemptId: typeof row.attempt_id === "number" ? row.attempt_id : null,
    outcome: String(row.outcome) as Refinement["outcome"],
    changed: row.changed === 1,
    reply: String(row.reply),
    problem: text(row.problem),
    fromCommit: String(row.from_commit),
    headCommit: text(row.head_commit),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
  }));
}

/** Store a round of fixes that ended. */
export function insertRefinement(db: DatabaseSync, r: Omit<Refinement, "id" | "endedAt">): void {
  db.prepare("INSERT INTO refinements (task_id, round, attempt_id, outcome, changed, reply, problem, from_commit, head_commit, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    r.taskId, r.round, r.attemptId, r.outcome, r.changed ? 1 : 0, r.reply, r.problem, r.fromCommit, r.headCommit, r.startedAt, now(),
  );
}

/** The cap on rounds of fixes of the run a task belongs to; 0 for a task of no planned run. */
export function refineCap(db: DatabaseSync, taskId: number): number {
  const row = db.prepare("SELECT r.max_refine_rounds AS n FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?").get(taskId);
  return typeof row?.n === "number" ? row.n : 0;
}

/**
 * The round of fixes a task's builder is on, read from the store: the round of its latest review when that review has
 * no round of fixes after it. Null when the task has no review: its builder is on the task's first build.
 */
export function refineRoundOf(db: DatabaseSync, taskId: number): number | null {
  const reviews = taskReviews(db, taskId);
  if (reviews.length === 0) return null;
  const round = reviews.at(-1)!.round;
  return db.prepare("SELECT 1 FROM refinements WHERE task_id = ? AND round = ?").get(taskId, round) ? null : round;
}

/** A task's reviews and rounds of fixes as the loop's outcome is read from them. */
export function loopRecord(db: DatabaseSync, taskId: number, agent: string): LoopRecord {
  return { agent, builder: "claude-code", reviews: taskReviews(db, taskId), refinements: taskRefinements(db, taskId), cap: refineCap(db, taskId) };
}
