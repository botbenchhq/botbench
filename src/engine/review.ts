import type { DatabaseSync } from "node:sqlite";
import { askThroughBroker, logSandboxedCalls, type Broker } from "../approvals/broker.ts";
import type { Confinement } from "../confinement.ts";
import { DriverUnavailableError, type Driver, type DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";
import { now } from "../store/db.ts";
import { commitsDiff, describeCommits } from "../worktrees.ts";
import { agentName, parseVerdict, REVIEWER, reviewDiff, reviewerPrompt, sentOfDiff, type PlanTask, type PreviousReview, type ReviewedFile } from "./roles.ts";

/*
 * The review station (U20, in part). Once a task of a run that names a reviewer is built, committed and checked, the
 * reviewer is sent the task's title, its acceptance criteria, the full list of the files it changed with the lines each
 * added and removed (with the request to flag any that does not belong to the task), then its whole diff, from the
 * commit it started from to the commit Botbench made, in numbered parts (engine/roles.ts, `reviewerPrompt`); only a diff
 * longer than MAX_REVIEW_PARTS parts is cut, and only then is the review stored with diffCut. It works read-only in the task's copy (the driver decides how; for
 * Codex see src/drivers/codex.ts), with no network, no way to ask the owner anything and a time limit. Its reply is
 * stored on the task as one review of its round, append-only, and is a model's opinion, not a check. A reviewer that
 * cannot start, fails, runs out of time or is stopped leaves a review that says so in plain words. The reply is data: it
 * is never run. Only its verdict line is read by Botbench, to decide whether the builder is asked for fixes, and the lines
 * under its "Checked:" heading, without which it cannot be satisfied (engine/refine.ts, `reviewOutcome`); the builder
 * is then given the reply as another model's opinion, set apart as data (engine/refine.ts).
 */

/** The time a reviewer gets: 10 minutes. */
export const REVIEW_LIMIT_MS = 600_000;

export type ReviewOutcome = "reviewed" | "failed" | "timed_out" | "stopped";

/** One task's review, as stored. */
export interface Review {
  id: number;
  taskId: number;
  /** Which review of the task this is, from 1: the loop asks again after each round of fixes. */
  round: number;
  agent: string;
  /** The model asked for; null is the agent's own default. */
  model: string | null;
  /** The reviewer's session, whose events are its transcript; null when it never started. */
  attemptId: number | null;
  outcome: ReviewOutcome;
  /** Read from the reply's first line, when it is in the asked form. */
  verdict: "looks_right" | "concerns" | null;
  /** The reviewer's reply, as it wrote it; empty when there is none. */
  text: string;
  /** Why there is no review, in words for the owner; null when there is one. */
  problem: string | null;
  /** How long the task's diff was, and whether the reviewer was sent only its start (a diff longer than MAX_REVIEW_PARTS parts). */
  diffChars: number;
  diffCut: boolean;
  /**
   * How many parts of the diff the reviewer was sent and how many characters they held, read from the prompt its session
   * was given; null when none was (it never started, the diff was empty) or the review is from before diffs were sent in parts.
   */
  diffSent: { parts: number; chars: number } | null;
  /** The commit reviewed; null for a review from before rounds were kept, or one that never read the work. */
  headCommit: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A task's latest review, or null when it has none. */
export function taskReview(db: DatabaseSync, taskId: number): Review | null {
  return taskReviews(db, taskId).at(-1) ?? null;
}

/** A task's reviews, one per round, in order. */
export function taskReviews(db: DatabaseSync, taskId: number): Review[] {
  // Only the end of the reviewer's prompt is read: the sentence after its last part says what it was sent (`sentOfDiff`).
  return db
    .prepare("SELECT r.*, (SELECT substr(json_extract(e.payload, '$.text'), -?) FROM events e WHERE e.attempt_id = r.attempt_id AND e.type = 'user_prompt' ORDER BY e.id LIMIT 1) AS prompt_end FROM reviews r WHERE r.task_id = ? ORDER BY r.round")
    .all(PROMPT_END_CHARS, taskId)
    .map(toReview);
}

/** Enough of the end of a reviewer's prompt to hold its last `</diff>` and the sentence after it. */
const PROMPT_END_CHARS = 2_000;

function toReview(row: Record<string, unknown>): Review {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    round: Number(row.round),
    agent: String(row.agent),
    model: text(row.model),
    attemptId: typeof row.attempt_id === "number" ? row.attempt_id : null,
    outcome: String(row.outcome) as ReviewOutcome,
    verdict: text(row.verdict) as Review["verdict"],
    text: String(row.text),
    problem: text(row.problem),
    diffChars: Number(row.diff_chars),
    diffCut: row.diff_cut === 1,
    diffSent: typeof row.prompt_end === "string" ? sentOfDiff(row.prompt_end) : null,
    headCommit: text(row.head_commit),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    durationMs: Number(row.duration_ms),
  };
}

/** Who reviews a task, and what it was asked to build: its run's reviewer and its plan task. Null when its run names no reviewer, or it is no task of a plan. */
export function reviewAssignment(db: DatabaseSync, taskId: number): { agent: string; model: string | null; task: PlanTask } | null {
  const row = db.prepare("SELECT r.reviewer_agent AS agent, r.reviewer_model AS model, p.title, p.criteria FROM plan_tasks p JOIN runs r ON r.id = p.run_id WHERE p.task_id = ? AND r.reviewer_agent IS NOT NULL").get(taskId);
  if (!row) return null;
  let criteria: unknown;
  try {
    criteria = JSON.parse(String(row.criteria));
  } catch {
    criteria = [];
  }
  return { agent: String(row.agent), model: text(row.model), task: { title: String(row.title), criteria: Array.isArray(criteria) ? criteria.filter((c): c is string => typeof c === "string") : [] } };
}

const seconds = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 100) / 10} seconds` : `${Math.round(ms / 60_000)} minutes`);
const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ReviewOptions {
  db: DatabaseSync;
  driver: Driver;
  /** The run's choice of model for its reviewer; null is the agent's own default. */
  model: string | null;
  taskId: number;
  /** Which review of the task this is, from 1. */
  round?: number;
  /** For a review after a round of fixes: the reviewer's last review and the builder's reasons. */
  previous?: PreviousReview;
  task: PlanTask;
  worktree: string;
  baseCommit: string;
  headCommit: string;
  /** What the reviewer's commands are kept from; it reaches no host whatever the repository allows. */
  confinement: Confinement;
  /**
   * The reviewer's own web search, which its provider runs on its own servers (Codex, Grok): on when the owner's "Web
   * access in chat" is Allow, since a reviewer cannot ask. Its commands reach no network either way.
   */
  webSearch?: boolean;
  limitMs?: number;
  /**
   * Where the requests of a reviewer that asks before it acts (Antigravity) go, as the task's review step's: read-only,
   * so only reads and confined commands can be allowed. Without it, everything such a reviewer would ask is refused.
   */
  broker?: Pick<Broker, "admit" | "request">;
  /** Aborted when the run is cancelled or Botbench stops: the review is stopped. */
  signal?: AbortSignal;
  /** Called when one of the reviewer's events was stored. */
  onEvent?: () => void;
}

/** Run one review and store it on the task, which must be at the review station. Never rejects for the reviewer's sake: what went wrong is the review. */
export async function runReview(o: ReviewOptions): Promise<Review> {
  const startedAt = now();
  const began = Date.now();
  const name = agentName(o.driver.name);
  const limitMs = o.limitMs ?? REVIEW_LIMIT_MS;
  let attemptId: number | null = null;
  let reply = "";
  let diffChars = 0;
  let diffCut = false;
  let outcome: ReviewOutcome = "failed";
  let problem: string | null = null;

  const store = (): Review => {
    o.db.prepare("INSERT INTO reviews (task_id, round, agent, model, attempt_id, outcome, verdict, text, problem, head_commit, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      o.taskId, o.round ?? 1, o.driver.name, o.model, attemptId, outcome, outcome === "reviewed" ? parseVerdict(reply) : null, reply, problem, o.headCommit, diffChars, diffCut ? 1 : 0, startedAt, now(), Date.now() - began,
    );
    return taskReview(o.db, o.taskId)!;
  };

  let diff: string;
  let files: ReviewedFile[];
  try {
    diff = await commitsDiff({ path: o.worktree, baseCommit: o.baseCommit, headCommit: o.headCommit });
    files = await describeCommits({ repo: o.worktree, baseCommit: o.baseCommit, headCommit: o.headCommit });
  } catch (err) {
    problem = `${name} was not started: Botbench could not read the task's changes (${words(err)}).`;
    return store();
  }
  diffChars = diff.length;
  diffCut = reviewDiff(diff).cut;
  const tools = o.driver.capabilities.tools !== false;
  const webSearch = tools && o.webSearch === true;
  const prompt = reviewerPrompt({ task: o.task, files, diff, tools,...(tools ? { copy: o.worktree, webSearch } : {}), ...(o.previous ? { previous: o.previous } : {}) });

  if (o.signal?.aborted) {
    outcome = "stopped";
    problem = `${name} was not started: the review was stopped first.`;
    return store();
  }
  let session: DriverSession;
  // A reviewer that asks (Antigravity) is admitted as the task's review step: read-only, its commands confined. Codex asks
  // only when it builds, to leave its sandbox (`escalationsOnly`); its review is kept by its sandbox alone and has no gate.
  const asks = tools && o.driver.capabilities.permissionRequests && o.driver.capabilities.chatTools === true && o.driver.capabilities.escalationsOnly !== true;
  const admission = asks && o.broker !== undefined ? o.broker.admit({ taskId: o.taskId, role: REVIEWER, worktree: o.worktree, readOnly: true, confined: o.driver.capabilities.confinedCommands === true }) : null;
  try {
    session = await o.driver.startAttempt({ db: o.db, cwd: o.worktree, readOnly: true, ...(admission === null ? {} : { gate: { socketPath: admission.socketPath, secret: admission.secret } }), confinement: { ...o.confinement, allowedHosts: [] }, ...(webSearch ? { webSearch } : {}), ...(o.model === null ? {} : { model: o.model }) });
  } catch (err) {
    admission?.release();
    problem = `${name} could not review this task: ${err instanceof DriverUnavailableError ? err.probe.problem ?? err.message : words(err)}`;
    return store();
  }
  attemptId = session.attemptId;
  admission?.bind(session.attemptId);
  // A reviewer that cannot ask (Codex, Grok) runs its tools without the broker: each call is logged under the task.
  if (session.capabilities.permissionRequests === false && tools) logSandboxedCalls(o.db, session, { agent: name, taskId: o.taskId, cwd: o.worktree, where: "the task's copy, read-only" });
  else if (asks) askThroughBroker(o.db, o.broker ?? { request: async () => ({ decision: "decline", note: null, approvalId: null, refused: "Botbench's permission check is not set up for this review." }) }, session, { who: { taskId: o.taskId }, role: REVIEWER, agent: name, cwd: o.worktree, where: "the task's copy, read-only" });
  let failure: string | null = null;
  session.onEvent((event) => {
    if (event.type === "text") reply = event.text;
    if (event.type === "turn_ended" && event.reason === "error") failure = event.detail;
    o.onEvent?.();
  });
  let why: "limit" | "stopped" | null = null;
  const stop = (reason: "limit" | "stopped"): void => {
    if (why !== null) return;
    why = reason;
    void session.interruptTurn().catch(() => {});
  };
  const timer = setTimeout(() => stop("limit"), limitMs);
  const onAbort = (): void => stop("stopped");
  o.signal?.addEventListener("abort", onAbort);
  if (o.signal?.aborted) stop("stopped");
  let end: TurnEndReason;
  try {
    end = await session.sendTurn(prompt);
  } catch (err) {
    end = "error";
    failure = words(err);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
  await session.close().catch(() => {});
  admission?.release();

  if (why === "limit") {
    outcome = "timed_out";
    problem = `${name} did not finish within ${seconds(limitMs)} and was stopped.`;
  } else if (why === "stopped") {
    outcome = "stopped";
    problem = `${name} was stopped before it finished.`;
  } else if (end === "completed" && reply.trim() !== "") {
    outcome = "reviewed";
  } else if (end === "completed") {
    problem = `${name} finished without writing a review.`;
  } else {
    problem = `${name} could not review this task: ${failure ?? "it ended without saying why."}`;
  }
  // Only a finished review is kept as one; what a reviewer wrote before it was cut short is in its transcript.
  if (outcome !== "reviewed") reply = "";
  return store();
}

/** Record that a task's review did not finish, for a task left at the review station by a Botbench that stopped. */
export function storeUnfinishedReview(db: DatabaseSync, taskId: number, agent: string, model: string | null, problem: string): void {
  const at = now();
  const round = taskReviews(db, taskId).length + 1;
  db.prepare("INSERT INTO reviews (task_id, round, agent, model, attempt_id, outcome, verdict, text, problem, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, NULL, 'stopped', NULL, '', ?, 0, 0, ?, ?, 0)").run(taskId, round, agent, model, problem, at, at);
}
