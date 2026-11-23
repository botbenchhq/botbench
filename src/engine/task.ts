import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingApprovals, permissionResponse, waitingOnApproval, type Admission, type Broker } from "../approvals/broker.ts";
import { summarize } from "../approvals/gate.ts";
import { insertPreapproved, realRepo } from "../approvals/grants.ts";
import { chatWebAccess } from "../approvals/web-access.ts";
import { allowedHostsFor, outsideTextPrompt, runIssue, runOutside } from "./intake.ts";
import { learningsSection } from "./learnings.ts";
import { memorySection } from "./memory.ts";
import type { Driver, DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";
import { now, transaction } from "../store/db.ts";
import type { Confinement } from "../confinement.ts";
import { workbenchName } from "../workbench.ts";
import { commitWork, createWorktree, describeCommits, describeWork, removeWorktree, sharedGitDir, sourceHead, type Worktree } from "../worktrees.ts";
import { CHANGED_NOTHING_PROMPT, closeLeftCommands, CONTINUE_PROMPT, RESTART_STOPPED, RESUME_PROMPT, resumeProblem, silentPrompt, stopSurvivor } from "./recover.ts";
import { autoAccept, modeRefusals, reviewOutcome, runModeOf, unaskedQuestions } from "./modes.ts";
import { insertRefinement, loopVerdict, parseRefineReply, refineCap, refineRoundOf, taskRefinements } from "./refine.ts";
import { reviewAssignment, runReview, storeUnfinishedReview, taskReview, taskReviews } from "./review.ts";
import { agentName, IMPLEMENTER, refinePrompt } from "./roles.ts";
import { deliverNoteIn, leftBuilding, NOT_DELIVERED, NOTE_REFUSED, NOTE_TOO_LATE, noteProblem, queueNoteIn, settleWaiting, settleWaitingIn, waitingNote, type TaskNote } from "./notes.ts";
import { firstLine } from "../shorten.ts";
import { confirmGroupGone, durationWords, SILENCE_LIMIT_MS, silenceReason, stoppedForSilence, watchSilence, type SilenceWatch } from "./silence.ts";
import { protectedWords, taskScope, type FileScope } from "./scope.ts";
import { commandProblem, nextRound, runCommand, startCommandList, type CommandRun, type EvidenceKind, type StationCommand } from "./stations.ts";
import { LIMIT_CANCELLED, LIMIT_PROMPT, LIMIT_ROUND_NOTE, limitAgainReason, limitNoSessionReason, MAX_TIMER_MS, retryTime, USAGE_LIMIT_WAIT_MS } from "./usage-limit.ts";

/**
 * The stations a task can be at. `building` covers making its worktree, running the repository's setup
 * commands there and its builder's turn. `verifying` is the repository's check commands running on the work Botbench
 * committed. `reviewing` is the run's reviewer reading the work, after the checks (engine/review.ts); after a review with
 * concerns the task goes back to `building` for a round of fixes, then `verifying` and `reviewing` again (engine/refine.ts). `awaiting_decision` means nothing further happens until the owner decides; `accepted` and `rejected` are
 * the owner's decision (engine/decision.ts); `interrupted`, `failed` and `cancelled` are ends that carry a reason.
 * `waiting_for_limit` is a builder's turn that ended on its agent's usage limit: its work is committed, and at the time
 * stored with it Botbench resumes its session once and it goes back to `building` (engine/usage-limit.ts).
 */
export type TaskStatus = "queued" | "building" | "verifying" | "reviewing" | "awaiting_decision" | "accepted" | "rejected" | "interrupted" | "failed" | "cancelled" | "waiting_for_limit";
/** What a task's checks found: all passed, at least one failed or ran out of time, or the repository has none. */
export type ChecksMark = "passed" | "failed" | "none";

/**
 * Where a task may go from each station. `building` to `building` records an attempt starting under the task, and a
 * move to the same station records something for its history. A stopped task goes back to work only by the owner's Resume.
 */
const MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["building", "interrupted", "failed", "cancelled"],
  building: ["building", "verifying", "reviewing", "awaiting_decision", "interrupted", "failed", "cancelled", "waiting_for_limit"],
  verifying: ["verifying", "reviewing", "awaiting_decision", "interrupted", "failed", "cancelled"],
  reviewing: ["building", "awaiting_decision", "failed", "cancelled"],
  // To itself: a fully autonomous run that could not accept the task records why it waits for the owner.
  awaiting_decision: ["awaiting_decision", "accepted", "rejected"],
  accepted: [],
  rejected: [],
  interrupted: ["building", "verifying"],
  // Only by the owner's Resume of a task whose builder changed no file (`changedNothing`).
  failed: ["building"],
  cancelled: [],
  // Back to work at its stored time, by Botbench itself; or ended by a cancel of its run.
  waiting_for_limit: ["building", "cancelled"],
};

export interface Task {
  id: number;
  /** The run this task belongs to. A task started on its own is a run of one; null only for tasks from before runs were numbered. */
  runId: number | null;
  repo: string;
  prompt: string;
  /** The model asked for when the task was started. Null means the CLI's own default. */
  requestedModel: string | null;
  status: TaskStatus;
  /** Why the task was interrupted or failed, in words for the owner. */
  reason: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  /** The task branch's commit after Botbench committed the work. */
  headCommit: string | null;
  attemptId: number | null;
  /** What its checks found once it was built; null before that, or when it never got there. */
  checks: ChecksMark | null;
  /** Tasks this one waits for. Always empty for now. */
  dependsOn: string;
  /** How many times a restart took it up again since it was started or last resumed by the owner. */
  restarts: number;
  /** For a task waiting for a usage limit: when Botbench tries again (ISO). Null for every other task. */
  retryAt: string | null;
  createdAt: string;
  updatedAt: string;
}


/** How the builder's last turn ended, for a task the owner resumes, when the agent is told about it: no file changed, or it went silent. */
type Before = "changed nothing" | "silent" | null;

/** A reviewer the run names and this Botbench cannot start: its review fails, saying so. */
function unknownReviewer(agent: string): Driver {
  const refuse = (): never => {
    throw new Error(`Botbench cannot start ${agentName(agent)} to review.`);
  };
  return { name: agent, capabilities: { resume: false, interrupt: false, permissionRequests: false, edits: false }, probe: refuse, models: refuse, startAttempt: async () => refuse() };
}

/** A request about a task that cannot be met; `status` is the HTTP answer for it. */
export class TaskError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" ? v : null);

function toTask(row: Record<string, unknown>): Task {
  return {
    id: Number(row.id),
    runId: int(row.run_id),
    repo: String(row.repo_path),
    prompt: String(row.prompt),
    requestedModel: text(row.requested_model),
    status: String(row.status) as TaskStatus,
    reason: text(row.reason),
    worktreePath: text(row.worktree_path),
    branch: text(row.branch),
    baseCommit: text(row.base_commit),
    headCommit: text(row.head_commit),
    checks: text(row.checks) as ChecksMark | null,
    attemptId: int(row.attempt_id),
    dependsOn: String(row.depends_on),
    restarts: Number(row.restarts ?? 0),
    retryAt: text(row.retry_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getTask(db: DatabaseSync, id: number): Task | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? toTask(row) : null;
}

/**
 * The files a task's work changed, from its start commit to the commit Botbench recorded as its head, read from the
 * repository: what its changed files are marked from (engine/scope.ts). None when either commit is missing or cannot be read.
 */
async function changedPaths(task: Pick<Task, "repo" | "baseCommit">, headCommit: string | null): Promise<string[]> {
  if (task.baseCommit === null || headCommit === null) return [];
  return describeCommits({ repo: task.repo, baseCommit: task.baseCommit, headCommit }).then((files) => files.map((file) => file.path), () => []);
}

/** The newest tasks, newest first. */
export function listTasks(db: DatabaseSync, limit = 200): Task[] {
  return db.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT ?").all(limit).map(toTask);
}

const insertEvent = (db: DatabaseSync, id: number, at: string, status: TaskStatus, detail: string | null): void => {
  db.prepare("INSERT INTO task_events (task_id, ts, status, detail) VALUES (?, ?, ?, ?)").run(id, at, status, detail);
};

/**
 * Write one queued task of a run, with its first event, and return its id. Call it inside the transaction that
 * creates the run or approves its plan, so the task exists only together with what it belongs to.
 */
export function insertQueuedTask(db: DatabaseSync, o: { runId: number; repo: string; prompt: string; requestedModel: string | null }): number {
  const at = now();
  const id = Number(db.prepare("INSERT INTO tasks (run_id, repo_path, prompt, requested_model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(o.runId, o.repo, o.prompt, o.requestedModel, at, at).lastInsertRowid);
  insertEvent(db, id, at, "queued", null);
  return id;
}

/**
 * Store a new task as queued, as a run of its own. The row, the grants for the commands the owner pre-approved for
 * that run, and the task's first event are written together: none exists without the others.
 * Throws for a pre-approved command that cannot be a grant, and then nothing is written.
 */
export function createTask(db: DatabaseSync, o: { repo: string; prompt: string; requestedModel?: string | null; preapproved?: readonly string[] }): Task {
  return transaction(db, () => {
    const at = now();
    // The repository is kept by its real path as it is now. Grants and counts compare this stored path, so a link
    // that is pointed elsewhere later does not carry one repository's trust to another.
    const repo = realRepo(o.repo);
    // A task started on its own is a run of one: it takes the next run id, which no other run or task ever gets.
    const runId = Number(db.prepare("INSERT INTO runs (kind, repo_path, prompt, created_at, updated_at) VALUES ('single', ?, ?, ?, ?)").run(repo, o.prompt, at, at).lastInsertRowid);
    const id = insertQueuedTask(db, { runId, repo, prompt: o.prompt, requestedModel: o.requestedModel ?? null });
    insertPreapproved(db, { role: IMPLEMENTER, repo, runId, taskId: id, commands: o.preapproved ?? [] });
    return getTask(db, id)!;
  });
}

export interface TaskChange {
  reason?: string;
  /** Something for the task's history only, when the task stays at its station. */
  note?: string;
  worktree?: Worktree;
  attemptId?: number;
  headCommit?: string;
  checks?: ChecksMark;
  /** For a move to `waiting_for_limit`: when to try again (ISO). Cleared by any move away from that wait. */
  retryAt?: string;
}

/**
 * Move a task to a station and record what came with the move. The new state
 * and its event are written in one transaction, so neither exists without the
 * other. A move the line does not have is refused and writes nothing.
 */
export function moveTask(db: DatabaseSync, id: number, to: TaskStatus, change: TaskChange = {}): Task {
  return transaction(db, () => moveTaskIn(db, id, to, change));
}

/** `moveTask` inside the caller's transaction, for a move written together with something else. */
export function moveTaskIn(db: DatabaseSync, id: number, to: TaskStatus, change: TaskChange = {}): Task {
  {
    const task = getTask(db, id);
    if (!task) throw new Error(`No task ${id}.`);
    if (!MOVES[task.status]?.includes(to)) throw new Error(`Task ${id} is ${task.status} and cannot move to ${to}.`);
    const at = now();
    const sets = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, at];
    const details: string[] = [];
    if (to === "waiting_for_limit") {
      if (change.retryAt === undefined) throw new Error(`Task ${id} cannot wait for a usage limit without a time to try again.`);
      sets.push("retry_at = ?");
      values.push(change.retryAt);
      // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
      details.push(`tries again at ${change.retryAt}`);
    } else if (task.status === "waiting_for_limit") {
      sets.push("retry_at = ?");
      values.push(null);
    }
    if (change.worktree) {
      sets.push("worktree_path = ?", "branch = ?", "base_commit = ?");
      values.push(change.worktree.path, change.worktree.branch, change.worktree.baseCommit);
      // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
      details.push(`worktree on branch ${change.worktree.branch}`);
    }
    if (change.attemptId !== undefined) {
      sets.push("attempt_id = ?");
      values.push(change.attemptId);
      details.push(`attempt ${change.attemptId}`);
    }
    if (change.headCommit !== undefined) {
      sets.push("head_commit = ?");
      values.push(change.headCommit);
      details.push(`head commit ${change.headCommit}`);
    }
    if (change.checks !== undefined) {
      sets.push("checks = ?");
      values.push(change.checks);
      details.push(`checks ${change.checks}`);
    }
    if (change.reason !== undefined) {
      sets.push("reason = ?");
      values.push(change.reason);
      details.unshift(change.reason);
    }
    if (change.note !== undefined) details.unshift(change.note);
    // A note waits only for a building task's builder: a task that leaves building with one still waiting, by any way
    // the builder's turn did not settle it (engine/notes.ts), has it marked not delivered with the move.
    if (task.status === "building" && to !== "building") settleWaitingIn(db, id, leftBuilding(to));
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    insertEvent(db, id, at, to, details.length === 0 ? null : details.join("; "));
    return getTask(db, id)!;
  }
}

/**
 * A running run whose tasks have all reached an end (built, failed, stopped or cancelled) waits for the owner's
 * decisions while a task is ready for review, and is done once none is: each decided, failed, stopped or cancelled. Written with its event, and
 * only from `running` or `awaiting_decision`: a run cancelled meanwhile stays so. Returns the run's new state, or null
 * when it did not change.
 */
function settleRun(db: DatabaseSync, runId: number): { id: number; status: string } | null {
  return transaction(db, () => settleRunIn(db, runId));
}

/** `settleRun` inside the caller's transaction, for the end a decision brings about. */
export function settleRunIn(db: DatabaseSync, runId: number): { id: number; status: string } | null {
  const run = db.prepare("SELECT status FROM runs WHERE id = ? AND kind = 'planned'").get(runId);
  if (run?.status !== "running" && run?.status !== "awaiting_decision") return null;
  const has = (statuses: string): boolean => db.prepare(`SELECT 1 FROM tasks WHERE run_id = ? AND status IN (${statuses}) LIMIT 1`).get(runId) !== undefined;
  // A task waiting for a usage limit is still on its way: its run is neither done nor waiting on decisions.
  if (has("'queued', 'building', 'verifying', 'reviewing', 'waiting_for_limit'")) return null;
  // A task that is ready for review keeps the run waiting. With none, nothing is left to decide and the run is done,
  // also when no task was ever ready for review because each failed or was stopped.
  const to = has("'awaiting_decision'") ? "awaiting_decision" : "done";
  if (to === run.status) return null;
  const at = now();
  db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(to, at, runId);
  const detail = to === "awaiting_decision" ? "every task has reached an end" : has("'accepted', 'rejected'") ? "every task is decided or ended" : "every task ended and none was ready for review";
  // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
  db.prepare("INSERT INTO run_events (run_id, ts, status, detail) VALUES (?, ?, ?, ?)").run(runId, at, to, detail);
  return { id: runId, status: to };
}

/** The run a task was queued by when its plan was approved, with the commit that plan was made from; null for a task started on its own. */
function plannedRunOf(db: DatabaseSync, task: Task): { id: number; status: string; baseCommit: string } | null {
  if (task.runId === null) return null;
  const row = db.prepare("SELECT id, status, base_commit FROM runs WHERE id = ? AND kind = 'planned'").get(task.runId);
  return row ? { id: Number(row.id), status: String(row.status), baseCommit: String(row.base_commit) } : null;
}

/**
 * Where a task's work was when it stopped, for taking it up again: its setup commands (no agent had started in its
 * copy), its agent's turn, or its checks (its work was committed). Read from where it stands, or, for a stopped task,
 * from the station it was at before it stopped. Null when there is nothing to take up: no copy, or no committed work to check.
 */
export function stageOf(db: DatabaseSync, task: Task): "setup" | "turn" | "checks" | null {
  if (task.worktreePath === null) return null;
  const stopped = task.status === "interrupted" || changedNothing(task);
  const from = stopped ? db.prepare("SELECT status FROM task_events WHERE task_id = ? AND status NOT IN ('interrupted', 'failed') ORDER BY id DESC LIMIT 1").get(task.id)?.status : task.status;
  if (from === "verifying") return task.headCommit === null ? null : "checks";
  // An agent is sent its prompt only once its task names its attempt, so a task with none has had nothing written by an agent.
  // A wait for a usage limit is only ever entered from a builder's turn.
  if (from === "building" || from === "waiting_for_limit") return task.attemptId === null ? "setup" : "turn";
  return null;
}

/** The reason a task fails with when its builder's turn ended and its branch holds no change from its base. */
export const CHANGED_NOTHING = "Claude Code finished without changing any file.";

/** Whether a task failed because its builder changed no file: the one failed task the owner can resume. */
export const changedNothing = (task: Pick<Task, "status" | "reason">): boolean => task.status === "failed" && task.reason !== null && task.reason.startsWith(CHANGED_NOTHING);

/** Why a stopped task cannot be resumed, in words for the owner; null when it can. */
export function resumeBlocker(db: DatabaseSync, task: Task): string | null {
  if (stageOf(db, task) === null) return "This task has nothing to resume: it was stopped before there was work in a copy of the project.";
  if (!fs.statSync(task.worktreePath!, { throwIfNoEntry: false })?.isDirectory()) return "This task's copy of the project is no longer there, so there is nothing to resume.";
  if (plannedRunOf(db, task)?.status === "cancelled") return "Its run was cancelled, so it cannot be resumed.";
  return null;
}

/** For a stopped task that can be resumed: what Resume will do, in words for the owner. Null for every other task. */
export function resumeNote(db: DatabaseSync, task: Task): string | null {
  if ((task.status !== "interrupted" && !changedNothing(task)) || resumeBlocker(db, task) !== null) return null;
  if (changedNothing(task)) return "Resume starts Claude Code again in the same session, in the task's copy of the project, tells it that it changed no file, and asks it to do the task now.";
  const stage = stageOf(db, task);
  if (stage === "checks") return "Resume runs this repository's checks again from the start, on the work committed to the task's branch.";
  if (stage === "setup") return "Resume runs this repository's setup commands again from the start in the task's copy of the project, then starts Claude Code on the task.";
  return "Resume starts Claude Code again in the task's copy of the project, with the files as they were left, and asks it to carry on where it stopped.";
}

/** A task's state as the rest of a sentence that starts "This task", for a refusal. */
const STANDS: Record<TaskStatus, string> = {
  queued: "is queued",
  building: "is already working",
  verifying: "is already working: its checks are running",
  reviewing: "is already working: it is being reviewed",
  awaiting_decision: "is ready for review",
  accepted: "was accepted",
  rejected: "was rejected",
  interrupted: "is stopped",
  failed: "failed",
  cancelled: "was cancelled",
  waiting_for_limit: "is waiting for a usage limit to reset, and Botbench tries again by itself at the time it shows",
};

const MAX_PATH = 4096;

/**
 * Check what a client gave as a repository: a full path to the top level of a
 * git repository that has a commit. Returns the path without detours. Nothing
 * a client sends reaches git or the filesystem before this has passed.
 */
export async function checkRepository(input: unknown): Promise<string> {
  if (typeof input !== "string" || input.includes("\0") || !path.isAbsolute(input)) throw new TaskError(400, "Give the full path, starting with /.");
  if (input.length > MAX_PATH) throw new TaskError(400, "The repository path is too long.");
  const repo = path.resolve(input);
  try {
    await sourceHead(repo);
  } catch (err) {
    throw new TaskError(400, err instanceof Error ? err.message : String(err));
  }
  return repo;
}

/** An error as the sentence it carries. */
export const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface Tasks {
  /**
   * Check the repository, store the task as queued and return it at once. The build goes on in the background.
   * `model` is the model asked for: a name, null for the CLI's own default, or left out for the configured one.
   * `preapproved` are the commands the owner lets this task's run use without asking; each must be one plain command.
   */
  start(repo: unknown, prompt: string, model?: string | null, preapproved?: readonly string[]): Promise<Task>;
  /** Build a running run's queued tasks, one at a time, in plan order, after whatever is being built now. */
  buildRun(runId: number): void;
  /** The run was cancelled: stop what is being done for it now (a setup command or a turn). Resolves once it has stopped. */
  stopRun(runId: number): Promise<void>;
  /**
   * The owner's Resume of a stopped task: it goes back to the station it stopped at at once, and is taken up again in
   * its turn, from where it was. Throws a TaskError (404, 409) for a task that does not exist or cannot be resumed.
   */
  resume(id: number): Task;
  /**
   * The owner's note to a task that is building (engine/notes.ts): stored as the one waiting for its builder, replacing
   * one that waits already, and sent as the builder's next message once its current turn ends normally. Throws a
   * TaskError for a task that does not exist (404), one that is not building or whose builder has just finished (409),
   * and a note that is empty or too long (400); nothing is stored then.
   */
  sendNote(id: number, text: string): { note: TaskNote; replaced: TaskNote | null };
  /** A blocker of a fully autonomous run's task was cleared: its mode looks at it again. Resolves once it has. */
  reconsider(taskId: number): Promise<void>;
  /** Resolves when nothing is being built or recovered. */
  idle(): Promise<void>;
  /**
   * Stop what is at work and leave no CLI process or command behind. A task at work is left at its station, its files
   * as they are, for the next start to take up again; one that waits for the owner's answer is parked.
   */
  close(): Promise<void>;
}

export interface TasksOptions {
  db: DatabaseSync;
  /** Botbench's data directory; worktrees go under it. */
  home: string;
  driver: Driver;
  /** Where the attempt's permission requests go to wait for the owner. */
  broker: Broker;
  model?: string;
  /** The commands Botbench runs itself in a repository's new worktrees. None when left out. */
  repoCommands?: (repo: string) => { setup: readonly StationCommand[]; checks: readonly StationCommand[] };
  /** The hosts a repository's commands may reach, the agent's and Botbench's own. None, and no network, when left out. */
  repoHosts?: (repo: string) => readonly string[];
  /** The paths of a repository that only the owner may accept a change to (engine/scope.ts). None when left out. */
  protectedPaths?: (repo: string) => readonly string[];
  /** The agents that can review a run's tasks, by name. A run whose reviewer is not among them has its tasks' reviews fail, saying so. */
  reviewers?: Partial<Record<string, Driver>>;
  /** The time a reviewer gets; 10 minutes when left out. */
  reviewLimitMs?: number;
  /** How long a builder may send nothing before it is stopped (engine/silence.ts); 10 minutes when left out, and 0 for no limit. */
  silenceLimitMs?: number;
  /** How long a task waits after its builder's usage limit when the agent gives no reset time (engine/usage-limit.ts); 30 minutes when left out. */
  usageLimitWaitMs?: number;
  /**
   * The check-together gate a fully autonomous run's accept passes through (engine/combined.ts): with the owner's
   * "require checking together" on, it waits while an overlapping open pull request of another workbench has no
   * passing, current check together. None when left out.
   */
  checkTogether?: { gate(task: Task, files: readonly string[], head: string | null): Promise<{ ok: true } | { ok: false; why: string }> };
  /** Called when a transcript event was stored. */
  onEvent: () => void;
  /** Called after each state a task reaches, and after evidence is added to it. */
  onTaskChange: (task: Task) => void;
  /** Called when a run's build reaches its end. */
  onRunChange?: (run: { id: number; status: string }) => void;
}

/**
 * Builds tasks, one at a time. A task is one implementer turn in its own
 * worktree: Botbench makes the worktree from the repository's current commit,
 * starts an attempt there that may edit files in it and must ask the owner,
 * through the broker, for everything else, sends the prompt, and when the turn
 * ends commits everything to the task branch itself, however the turn ended.
 */
export function createTasks(options: TasksOptions): Tasks {
  const { db, home, driver, broker } = options;
  const silenceLimit = options.silenceLimitMs ?? SILENCE_LIMIT_MS;
  const usageLimitWait = options.usageLimitWaitMs ?? USAGE_LIMIT_WAIT_MS;
  /** What the commands of a task are kept from (U27). A run that read outside text reaches no host unless its owner allowed them (engine/intake.ts). */
  const confinement = (task: Pick<Task, "repo" | "runId">): Confinement => ({ dataDir: home, allowedHosts: allowedHostsFor(db, task.runId, options.repoHosts?.(task.repo) ?? []) });
  /**
   * A builder's first prompt: the task's own, then the notes in docs/solutions/ of the task's copy when it has any
   * (engine/learnings.ts), then the owner's notes on this workbench when there are any (engine/memory.ts), then, for a
   * run started from an issue, the issue as outside text.
   */
  const builderPrompt = (task: Task): string => {
    const issue = runIssue(db, task.runId);
    const learnings = learningsSection(task.worktreePath ?? task.repo);
    const memory = memorySection(home);
    return `${task.prompt}${learnings === undefined ? "" : `\n\n${learnings}`}${memory === undefined ? "" : `\n\n${memory}`}${issue === null ? "" : `\n\n${outsideTextPrompt(issue)}`}`;
  };
  /** Whether the builder's driver runs every shell command confined: only then may a command run without asking. */
  const confined = driver.capabilities.confinedCommands === true;
  /**
   * The builder's way to the permission gate, the same for its build, a round of fixes, a resume and an answer after a
   * restart: one place, so no kind of builder attempt is admitted as less confined than it is (run 3 of the self-review:
   * a round of fixes was, and asked the owner about every command).
   */
  const admitBuilder = (task: Task, resumes?: number): Admission => broker.admit({ taskId: task.id, role: IMPLEMENTER, worktree: task.worktreePath!, confined, ...(resumes === undefined ? {} : { resumes }) });
  let closed = false;
  let current: DriverSession | null = null;
  /** Set while a turn runs: called when Botbench begins to stop, it decides whether that turn's task is parked. */
  let parkCurrent: (() => void) | null = null;
  /** The task being built now, the run it belongs to, and the way to stop its setup command or turn. */
  let active: { taskId: number; runId: number | null; stop: AbortController } | null = null;
  /**
   * The tasks whose builder's turn is over and whose work is on its way to being committed and checked: still building,
   * but a note can no longer reach their builder, so one is refused (`sendNote`) rather than left to wait for nothing.
   */
  const finishing = new Set<number>();
  /** When this engine began. What the store holds from before it is the last run's. */
  const began = now();

  const report = (what: string) => (err: unknown): void => console.error(`${what} failed: ${words(err)}`);

  const move = (id: number, to: TaskStatus, change?: TaskChange): Task => {
    const task = moveTask(db, id, to, change);
    options.onTaskChange(task);
    return task;
  };
  /** Move a task that is still at `from`, and only then; null when it has moved on meanwhile (its run was cancelled). */
  const moveFrom = (id: number, from: TaskStatus, to: TaskStatus, change?: TaskChange): Task | null => {
    const moved = transaction(db, () => (getTask(db, id)?.status === from ? moveTaskIn(db, id, to, change) : null));
    if (moved) options.onTaskChange(moved);
    return moved;
  };
  /** Whether the run a task belongs to was cancelled. */
  const cancelled = (task: Task): boolean => plannedRunOf(db, task)?.status === "cancelled";
  const CANCELLED = "The run was cancelled while this task was being built. The work done up to then is committed to its branch.";
  const settle = (runId: number | null): void => {
    if (runId === null) return;
    const settled = settleRun(db, runId);
    if (settled) options.onRunChange?.(settled);
  };

  /** Commit whatever is in the task's worktree and move the task to where its turn left it. */
  const finish = async (task: Task, to: TaskStatus, reason?: string): Promise<void> => {
    const headCommit = (await commit(task, reason))?.headCommit;
    if (headCommit !== undefined) move(task.id, to, { headCommit, ...(reason === undefined ? {} : { reason }) });
  };
  /**
   * Commit whatever is in the task's worktree. The commit, and whether the branch then holds any change from its base;
   * null when it could not be made and the task has failed saying why.
   */
  const commit = async (task: Task, reason?: string): Promise<{ headCommit: string; changed: boolean } | null> => {
    try {
      await commitWork({ path: task.worktreePath!, message: `Botbench task ${task.id}: ${firstLine(task.prompt)}` });
      const work = await describeWork({ path: task.worktreePath!, baseCommit: task.baseCommit! });
      return { headCommit: work.headCommit, changed: work.files.length > 0 };
    } catch (err) {
      // The files are still in the worktree; the task says what happened to it and why they are not committed.
      move(task.id, "failed", { reason: `${reason ? `${reason} ` : ""}The work could not be committed: ${words(err)}` });
      return null;
    }
  };

  /**
   * Botbench is stopping while this task is at work: it is left at its station, its files as they are and nothing
   * committed, for the next start to take up again (once; see `recover`).
   */
  const leave = (id: number, station: "building" | "verifying", what: string): void => {
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    moveFrom(id, station, station, { note: `Botbench stopped while ${what}; left for the next start to take up again` });
  };

  /**
   * Run a list of the repository's commands of one kind on a task, in order, in its worktree, each with its time
   * limit, as the next round of that list: each is recorded as it starts and stored as evidence as it ends. Setup
   * stops at the first that does not pass; checks all run. `stopped`: a command was stopped (a cancel, or Botbench
   * stopping) and the rest were not run.
   */
  const runList = async (task: Task, kind: EvidenceKind, commands: readonly StationCommand[], signal?: AbortSignal): Promise<{ stopped: boolean; failed: CommandRun | null }> => {
    const round = nextRound(db, task.id, kind);
    // The whole list is known before its first command runs, so a count shown meanwhile is out of all of it.
    if (commands.length > 0) startCommandList(db, task.id, kind, round, commands.length);
    let failed: CommandRun | null = null;
    for (const [i, command] of commands.entries()) {
      if (signal?.aborted || closed) return { stopped: true, failed };
      const result = await runCommand({ command: command.command, cwd: task.worktreePath!, limitMs: command.limitMs, confinement: confinement(task), track: { db, taskId: task.id, kind, round, position: i + 1 }, ...(signal ? { signal } : {}) });
      options.onTaskChange(getTask(db, task.id)!);
      if (result.outcome === "stopped") return { stopped: true, failed };
      if (result.outcome !== "passed") {
        failed ??= result;
        if (kind === "setup") break;
      }
    }
    return { stopped: false, failed };
  };

  /**
   * The builder finished: commit its work, then run the repository's check commands on it. The task goes on to wait
   * for the owner whatever the checks found; it says what that was.
   */
  const verify = async (task: Task, reply: string, stopped?: AbortSignal): Promise<void> => {
    const made = await commit(task);
    if (made === null) return;
    // Nothing to check or review: the task fails, saying so, and the owner can resume it or discard it. A round of fixes
    // that changes nothing is another matter (`refined`): the build before it did change the work.
    if (!made.changed) {
      const last = reply.trim() === "" ? "It wrote no message." : `Its last message: ${reply.trim().length > 600 ? `${reply.trim().slice(0, 600)}…` : reply.trim()}`;
      return void move(task.id, "failed", { headCommit: made.headCommit, reason: `${CHANGED_NOTHING} ${last}` });
    }
    await checkCommitted(task, made.headCommit, stopped);
  };

  /** Run the repository's checks on the work committed at `headCommit`, then go on to the review. */
  const checkCommitted = async (task: Task, headCommit: string, stopped?: AbortSignal): Promise<void> => {
    const checks = options.repoCommands?.(task.repo).checks ?? [];
    // No checks: said so as such, never as a pass.
    if (checks.length === 0) return review(task, "building", { headCommit, checks: "none" }, stopped);
    move(task.id, "verifying", { headCommit });
    await check(task, checks, stopped);
  };

  /**
   * Run the repository's checks on a task at `verifying`, whose work is committed, and record what they found. What a
   * check leaves in the copy is never committed. Checks stopped by a cancel end the task as cancelled; stopped by
   * Botbench stopping, the task is left for the next start, which runs them again from the start.
   */
  const check = async (task: Task, checks: readonly StationCommand[], stopped?: AbortSignal): Promise<void> => {
    if (checks.length === 0) return review(task, "verifying", { checks: "none" }, stopped);
    const ran = await runList(task, "check", checks, stopped);
    if (ran.stopped) {
      if (cancelled(task)) return void moveFrom(task.id, "verifying", "cancelled", { reason: "The run was cancelled while this task's checks ran. The work is committed to its branch; the checks did not finish." });
      if (closed) return leave(task.id, "verifying", "the checks of this task ran");
      return void moveFrom(task.id, "verifying", "interrupted", { reason: "This task's checks were stopped before they finished. The work is committed to its branch." });
    }
    await review(task, "verifying", { checks: ran.failed === null ? "passed" : "failed" }, stopped);
  };

  /**
   * The task's work is committed and checked. When its run names a reviewer, the reviewer reads it first and its review
   * is stored on the task; however the review went, the task then waits for the owner, as a review is an opinion and
   * not a check. Only a cancel of the run ends it otherwise.
   */
  /**
   * Whether a reviewer, which cannot ask, may use its own web search: only on Web access Allow, and never in a run that
   * read outside text (a GitHub issue), whose web tools always ask: for an agent that cannot ask, that is Off.
   */
  const reviewerWebSearch = (task: Task): boolean => chatWebAccess(db) === "allow" && !runOutside(db, task.runId).text;

  const review = async (task: Task, from: "building" | "verifying", change: TaskChange, stopped?: AbortSignal): Promise<void> => {
    const assigned = reviewAssignment(db, task.id);
    if (assigned === null) return handOver(task, from, change);
    const reviews = taskReviews(db, task.id);
    const fixes = taskRefinements(db, task.id);
    const lastFix = fixes.at(-1);
    // The loop ends at a round of fixes that did not finish or changed nothing: there is nothing new to review.
    if (lastFix !== undefined && lastFix.round === reviews.length && (lastFix.outcome !== "finished" || !lastFix.changed)) return handOver(task, from, change);
    const at = moveFrom(task.id, from, "reviewing", change);
    if (at === null) return;
    const round = reviews.length + 1;
    const before = reviews.at(-1);
    const done = await runReview({
      db, driver: options.reviewers?.[assigned.agent] ?? unknownReviewer(assigned.agent), model: assigned.model, taskId: task.id, round, task: assigned.task, worktree: at.worktreePath!, baseCommit: at.baseCommit!, headCommit: at.headCommit!,
      ...(before === undefined ? {} : { previous: { round, review: before.text, reasons: parseRefineReply(lastFix?.reply ?? "")?.notAddressed ?? null } }),
      confinement: { ...confinement(task), gitDir: await sharedGitDir(task.repo) }, webSearch: reviewerWebSearch(task), ...(options.reviewLimitMs ? { limitMs: options.reviewLimitMs } : {}), ...(stopped ? { signal: stopped } : {}), onEvent: options.onEvent,
    });
    options.onTaskChange(getTask(db, task.id)!);
    if (done.outcome === "stopped" && cancelled(task)) return void moveFrom(task.id, "reviewing", "cancelled", { reason: "The run was cancelled while this task was being reviewed. The work is committed to its branch; the review did not finish." });
    // Concerns, and rounds of fixes left: the builder is asked for fixes. Only the verdict line is read for this.
    if (loopVerdict(done) === "concerns" && fixes.length < refineCap(db, task.id) && !closed && stopped?.aborted !== true) return refine(at, assigned.agent, stopped);
    await handOver(task, "reviewing", {});
  };

  /** Whether a task of a fully autonomous run is accepted by the mode, from what is stored of it now and the marks of its changed files. */
  const qualifies = (id: number, checks: Task["checks"], scope: readonly FileScope[]): ReturnType<typeof autoAccept> =>
    autoAccept({ checks, review: reviewOutcome(db, id), refusals: modeRefusals(db, id), questions: unaskedQuestions(db, id), protectedFiles: scope.filter((f) => f.protected).map((f) => f.path), unexpectedFiles: scope.filter((f) => !f.expected && !f.protected).map((f) => f.path) });

  /**
   * The task is ready for review. First the files it changed, from its start commit to its head commit, are read and
   * marked (engine/scope.ts). In any mode, one under a protected path makes it wait for the owner with a reason naming
   * those files. In a fully autonomous run it is otherwise accepted by the mode when it qualifies, as the owner's Accept
   * would; when it does not, or the accept is refused (files the checks left, a branch that went missing), it waits for
   * the owner with a plain line saying why.
   */
  const handOver = async (task: Task, from: "building" | "verifying" | "reviewing" | "awaiting_decision", change: TaskChange): Promise<void> => {
    // A build that changed nothing never gets here (`verify`); rounds of fixes that undid every change of the build would.
    // Changes that cannot be read are taken as none, which a fully autonomous run never accepts.
    // Read at the commit Botbench recorded, the one the mode's accept requires the branch to hold, never the copy's HEAD.
    const head = change.headCommit ?? getTask(db, task.id)?.headCommit ?? null;
    const files = await changedPaths(task, head);
    const scope = taskScope(db, task, files, options.protectedPaths?.(task.repo) ?? []);
    if (runModeOf(db, task.runId) !== "full") {
      const guarded = scope.filter((f) => f.protected).map((f) => f.path);
      return void moveFrom(task.id, from, "awaiting_decision", guarded.length === 0 ? change : { ...change, reason: `It needs your review: ${protectedWords(guarded)}` });
    }
    let verdict = files.length === 0 ? ({ accept: false, why: "It needs your review: its branch holds no change." } as const) : qualifies(task.id, change.checks ?? getTask(db, task.id)?.checks ?? null, scope);
    // On a repository whose owner requires checking together, every open pull request of another workbench that
    // changes one of these files must have a passing check together at both current heads (engine/combined.ts).
    if (verdict.accept && options.checkTogether !== undefined) {
      const together = await options.checkTogether.gate(getTask(db, task.id) ?? task, files, head);
      if (!together.ok) verdict = { accept: false, why: `It needs your review: ${together.why}` };
    }
    const ready = moveFrom(task.id, from, "awaiting_decision", verdict.accept ? change : { ...change, reason: verdict.why });
    if (ready === null || !verdict.accept) return;
    try {
      // Loaded here: decision.ts builds on this module, which must not need it before both are loaded.
      const { acceptByMode } = await import("./decision.ts");
      const decided = await acceptByMode(db, task.id, verdict.reasons);
      options.onTaskChange(decided.task);
      if (decided.run) options.onRunChange?.(decided.run);
    } catch (err) {
      moveFrom(task.id, "awaiting_decision", "awaiting_decision", { reason: `It needs your review: Botbench could not accept it without you. ${words(err)}` });
    }
  };

  /**
   * What the builder is sent for a round of fixes: the latest review as another model's opinion. A builder that takes
   * up its earlier session already has the task; one started without it is also given the task and the files its work
   * changed. `again`: the builder was stopped while on this round (by Botbench stopping, or by its usage limit), and it
   * is taken up again; the words say which.
   */
  const refinePromptFor = async (task: Task, reviewer: string, fresh: boolean, again: "restart" | "limit" | null = null): Promise<string> => {
    const latest = taskReview(db, task.id)!;
    let files: string[] = [];
    if (fresh) files = (await describeWork({ path: task.worktreePath!, baseCommit: task.baseCommit! }).catch(() => ({ files: [] as { path: string }[] }))).files.map((file) => file.path);
    const issue = fresh ? runIssue(db, task.runId) : null;
    // A new session has not seen the issue a run was started from: it is given again, as the first build's prompt gives it.
    const prompt = `${refinePrompt({ reviewer, review: latest.text, task: fresh ? { prompt: task.prompt, files } : null })}${issue === null ? "" : `\n\n${outsideTextPrompt(issue)}`}`;
    // voice: not on screen. Botbench's words to the agent; the transcript shows the prompt as it was sent.
    const note = again === "limit" ? LIMIT_ROUND_NOTE : "Botbench stopped before you finished this round of fixes; the files in this folder are as you left them, and anything you were running then was stopped. Do the round again from where it stands now.";
    // voice: not on screen. Botbench's words to the agent; the transcript shows the prompt as it was sent.
    return again !== null ? prompt.replace("[From Botbench, not from the owner] ", `[From Botbench, not from the owner] ${note}\n\n`) : prompt;
  };

  /**
   * A round of fixes: the builder is started again in the task's copy, under the same permission check and
   * confinement as for its build, taking up its earlier session when it reported one, and sent the review. Its turn
   * is driven as a build's is; how it ended is recorded when it ends (`refined`).
   */
  const refine = async (task: Task, reviewer: string, stopped?: AbortSignal): Promise<void> => {
    const at = moveFrom(task.id, "reviewing", "building", { note: `round ${refineRoundOf(db, task.id)} of fixes` });
    if (at === null) return;
    await startRound(at, reviewer, false, stopped);
  };

  /**
   * Start the builder on the round of fixes of a task at `building`: in its earlier session when it has one, unless
   * `fresh`. `note`, for the task's history, is stored with the new attempt once it has started.
   */
  const startRound = async (at: Task, reviewer: string, fresh: boolean, stopped?: AbortSignal, note?: string): Promise<void> => {
    const attempt = fresh || at.attemptId === null ? undefined : db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(at.attemptId);
    const cursor = driver.capabilities.resume && typeof attempt?.resume_cursor === "string" && attempt.resume_cursor !== "" ? attempt.resume_cursor : null;
    const admission = admitBuilder(at);
    let session: DriverSession;
    try {
      if (closed) throw new Error("Botbench is stopping.");
      const gitDir = await sharedGitDir(at.repo);
      session = await driver.startAttempt({ db, cwd: at.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(at), gitDir }, ...(cursor === null ? {} : { resumeCursor: cursor }), ...(at.requestedModel === null ? {} : { model: at.requestedModel }) });
    } catch (err) {
      admission.release();
      if (closed) return leave(at.id, "building", "this task's round of fixes was being started");
      return refined(at, refineRoundOf(db, at.id)!, null, "error", "", `${agentName(driver.name)} could not be started for the round of fixes: ${words(err)}`, stopped);
    }
    await drive(at, session, admission, await refinePromptFor(at, reviewer, cursor === null), null, stopped, cursor !== null, note);
  };

  /**
   * A round of fixes ended, completed or failed: what the builder wrote is committed, the round is recorded, and the
   * loop goes on. Work that changed is checked again and reviewed again; a round that failed or changed nothing ends
   * the loop, and the task is Ready for review. A round that took up the builder's earlier session (`resumed`) and
   * completed with no reply and no change is not taken as an answer: Botbench notes it on the task and runs the round
   * once more in a new session, with the whole task (detect, log and retry fresh, as issue #111 cites paperclip's claude-local adapter doing).
   * That new session's round is recorded however it ends; one with no reply and no change is a round with no answer.
   * The empty rounds of #111 had one cause, which the driver now handles (the CLI's own result for a background command
   * left from the earlier session, `parseClaudeLine`); the retry stays for an empty resumed round of any other cause.
   */
  /** How the note on a round's one retry in a new session ends; the round's retry is found by it. */
  const FRESH_RETRY = "the round runs once more in a new session";
  const refined = async (task: Task, round: number, attemptId: number | null, end: "completed" | "error", reply: string, detail: string | null, stopped?: AbortSignal, resumed = false): Promise<void> => {
    const from = taskReviews(db, task.id).at(-1)?.headCommit ?? task.headCommit!;
    const startedAt = db.prepare("SELECT ts FROM task_events WHERE task_id = ? AND status = 'building' ORDER BY id DESC LIMIT 1").get(task.id)?.ts;
    const headCommit = (await commit(task))?.headCommit ?? null;
    const reviewer = reviewAssignment(db, task.id)?.agent ?? null;
    // Once per round, read from the task's history: a retry that a restart takes up again in its own session is still the
    // retry. Its note is stored with the new session's attempt, in one write (`drive`), so a restart before that session
    // started finds no note and the round still gets its retry.
    const retried = db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND detail LIKE ? LIMIT 1").get(task.id, `round ${round} of fixes: %${FRESH_RETRY}%`) !== undefined;
    if (resumed && !retried && end === "completed" && reply.trim() === "" && headCommit === from && reviewer !== null && !closed && stopped?.aborted !== true && !cancelled(task)) {
      const at = getTask(db, task.id);
      // voice: not on screen. A note in the stored history of the task, in the plan's own terms; no screen reads it.
      const note = `round ${round} of fixes: ${agentName(driver.name)} took up its earlier session (attempt ${attemptId}) and ended its turn with no reply and no change; ${FRESH_RETRY}`;
      if (at?.status === "building") return startRound(at, reviewer, true, stopped, note);
    }
    const problem = end === "completed" ? null : `${agentName(driver.name)}'s round of fixes ended with an error${detail === null ? "." : `: ${detail}`}`;
    insertRefinement(db, { taskId: task.id, round, attemptId, outcome: end === "completed" ? "finished" : "failed", changed: headCommit !== null && headCommit !== from, reply, problem, fromCommit: from, headCommit, startedAt: typeof startedAt === "string" ? startedAt : now() });
    options.onTaskChange(getTask(db, task.id)!);
    if (headCommit === null) return;
    if (headCommit === from) return review(task, "building", {}, stopped);
    await checkCommitted(task, headCommit, stopped);
  };

  /**
   * Build one queued task: its worktree (from its run's base commit, for a task of a planned run), the repository's
   * setup commands in it, then its builder's turn. A task whose run was cancelled meanwhile is left as the cancel left it.
   */
  const build = async (id: number): Promise<void> => {
    const queued = getTask(db, id);
    if (!queued || queued.status !== "queued") return;
    if (closed) return;
    await atWork(queued, (stop) => prepareAndDrive(queued, stop));
  };

  /** Do the work of a task as the task at work, which a cancel or Botbench stopping can stop. */
  const atWork = async (task: Task, work: (stop: AbortController) => Promise<void>): Promise<void> => {
    const stop = new AbortController();
    active = { taskId: task.id, runId: task.runId, stop };
    try {
      await work(stop);
    } catch (err) {
      // Whatever went wrong unforeseen, the task does not stay at a station nothing works at, holding up its run.
      report(`Building task ${task.id}`)(err);
      for (const from of ["queued", "building", "verifying", "reviewing"] as const) moveFrom(task.id, from, "failed", { reason: `Botbench could not go on with this task: ${words(err)}` });
    } finally {
      active = null;
    }
  };

  const prepareAndDrive = async (queued: Task, stop: AbortController): Promise<void> => {
    const id = queued.id;
    const plan = plannedRunOf(db, queued);
    let worktree: Worktree;
    try {
      // Under the task's own run: a run's tasks sit side by side, and a task started on its own is a run of one.
      worktree = await createWorktree({ repo: queued.repo, home, run: queued.runId === null ? `run-${randomBytes(4).toString("hex")}` : `run-${queued.runId}`, task: `task-${id}`, workbench: workbenchName(db), ...(plan ? { commit: plan.baseCommit } : {}) });
    } catch (err) {
      // Stopping meanwhile: the task is still queued, and the next start builds it.
      if (closed) return;
      return void moveFrom(id, "queued", "failed", { reason: `The task's copy of the project could not be created: ${words(err)}` });
    }
    const task = moveFrom(id, "queued", "building", { worktree });
    if (task === null) {
      // Cancelled while its copy was being made: the unused copy and its branch go again.
      await removeWorktree({ repo: queued.repo, path: worktree.path, deleteBranch: true }).catch(report(`Removing the unused copy of task ${id}`));
      return;
    }
    await setUpAndDrive(task, stop);
  };

  /**
   * The repository's setup commands in a task's copy, in order, then its builder's turn with the task's own prompt.
   * Only ever run on a copy no agent has worked in: a new one, or one whose setup was stopped before any agent started.
   */
  const setUpAndDrive = async (task: Task, stop: AbortController): Promise<void> => {
    const id = task.id;
    const setup = options.repoCommands?.(task.repo).setup ?? [];
    const ran = await runList(task, "setup", setup, stop.signal);
    if (ran.failed !== null) return void moveFrom(id, "building", "failed", { reason: commandProblem("setup", ran.failed) });
    if (ran.stopped || stop.signal.aborted) {
      if (cancelled(task)) return finish(task, "cancelled", "The run was cancelled while this task was being prepared. What setup wrote is committed to its branch.");
      return leave(id, "building", "this task was being prepared");
    }

    // The attempt's own way to the permission gate. It is released whichever way the build ends.
    const admission = admitBuilder(task);
    let session: DriverSession;
    try {
      if (closed) throw new Error("Botbench is stopping.");
      const gitDir = await sharedGitDir(task.repo);
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task), gitDir }, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      // No agent started: the next start takes the task up from its setup.
      if (closed) return leave(id, "building", "this task was being prepared");
      if (setup.length > 0) {
        // The setup commands may have written to the copy: it is kept, and what they wrote is committed.
        return finish(task, cancelled(task) ? "cancelled" : "failed", words(err));
      }
      // Nothing happened in the worktree, so it and its branch go again.
      const reason = await removeWorktree({ repo: task.repo, path: task.worktreePath!, deleteBranch: true }).then(
        () => words(err),
        (removal: unknown) => `${words(err)} The unused copy at ${task.worktreePath} could not be removed: ${words(removal)}`,
      );
      return void move(id, cancelled(task) ? "cancelled" : "failed", { reason });
    }

    await drive(task, session, admission, builderPrompt(task), null, stop.signal);
  };

  /**
   * Build a run's queued tasks one after another, in plan order, while the run is running. It stops at a task of the
   * run that is still building without being worked on here: one that waits for the owner's answer across a restart
   * holds up the tasks after it until it is resumed, and so does one waiting for a usage limit until it has resumed
   * and reached an end.
   */
  const runLine = async (runId: number): Promise<void> => {
    for (;;) {
      if (closed) return;
      const run = db.prepare("SELECT status FROM runs WHERE id = ? AND kind = 'planned'").get(runId);
      if (run?.status !== "running") return;
      if (db.prepare("SELECT 1 FROM tasks WHERE run_id = ? AND status IN ('building', 'verifying', 'reviewing', 'waiting_for_limit') LIMIT 1").get(runId)) return;
      const next = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'queued' ORDER BY id LIMIT 1").get(runId);
      if (!next) return settle(runId);
      await build(Number(next.id));
      settle(runId);
    }
  };

  /**
   * Run one turn of a task's attempt to its end, and then the owner's note, when one waits, as the next turn of the same
   * session (`driveTurns`), and record where that leaves the task. `resumed` says why a task is
   * driven again: the owner's answer to a request from before a restart, a restart, the owner's Resume, or the end of a
   * wait for a usage limit; null for its first turn. A turn that ends on the usage limit makes the task wait for it, once:
   * the turn that resumed it after that wait stops it for the owner instead. `fromSession`: the attempt takes up the session of the one before. If Botbench is stopped while
   * the turn waits for the owner, the task is parked: its approvals stay pending and it stays at `building` for the
   * next start to find; stopped at any other point of the turn, it is left at `building` for the next start to take up.
   */
  const drive = async (task: Task, session: DriverSession, admission: Admission, prompt: string, resumed: "answer" | "restart" | "owner" | "limit" | null, stopped?: AbortSignal, fromSession = resumed === "answer", note?: string): Promise<void> => {
    // A turn starts: a note may reach this builder again, as after its build's checks and review, on a round of fixes.
    finishing.delete(task.id);
    try {
      await driveTurns(task, session, admission, prompt, resumed, stopped, fromSession, note);
    } finally {
      finishing.delete(task.id);
    }
  };

  /**
   * `drive`'s work. The prompt is sent, and then, while each turn ends normally and the owner's note waits
   * (engine/notes.ts), the note is sent as the next message of the same session, and marked delivered with the session's
   * record of it (`sendNote`): the same attempt, its
   * admission, confinement and permission check, so it adds no permission beyond the build's. Only once no note waits
   * does the task go on to be committed and checked. A turn that ends any other way leaves a waiting note unsent, marked
   * not delivered with the reason.
   */
  const driveTurns = async (task: Task, session: DriverSession, admission: Admission, prompt: string, resumed: "answer" | "restart" | "owner" | "limit" | null, stopped?: AbortSignal, fromSession = resumed === "answer", note?: string): Promise<void> => {
    const id = task.id;
    current = session;
    admission.bind(session.attemptId);
    let detail: string | null = null;
    /** Set when the turn ended on the agent's usage limit (`limitedEnd`): the reset time it gave, or null. */
    let usageLimit = null as { resetsAt: string | null } | null;
    let reply = "";
    // A task with a review whose round has no fixes yet is on a round of fixes (engine/refine.ts).
    const refineRound = refineRoundOf(db, id);
    let sessionStarted = false;
    let parking = false;
    parkCurrent = () => void (parking = waitingOnApproval(db, id));
    /** Permission requests the CLI is still waiting on, by request id. */
    const asking = new Set<string>();
    session.onEvent((event) => {
      if (event.type === "session_started") sessionStarted = true;
      if (event.type === "text") reply = event.text;
      if (event.type === "turn_ended") {
        detail = event.detail;
        usageLimit = event.usageLimit ?? null;
      }
      if (event.type === "permission_request") {
        asking.add(event.id);
        // The broker never rejects: whatever fails on the way to the owner comes back as a decline.
        void broker
          .request({ taskId: id, attemptId: session.attemptId, role: IMPLEMENTER, tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
          // A request the CLI has stopped waiting for has no one to tell.
          .then((answer) => (asking.has(event.id) ? session.respondToRequest(event.id, permissionResponse(answer)) : undefined))
          .catch(report(`Answering a permission request of task ${id}`));
      }
      if (event.type === "permission_resolved") {
        asking.delete(event.id);
        // The CLI gave up on the request (the turn was stopped): its card must not stay answerable. When it is
        // Botbench itself that is stopping, the request is kept for the owner instead.
        if (event.decision === "cancelled" && !parking) admission.supersede(event.toolCallId);
      }
      options.onEvent();
    });
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    const why = { answer: "resumed after a restart", restart: "taken up again after a restart", owner: "resumed by the owner", limit: "resumed after waiting for a usage limit to reset" } as const;
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    // `note`: the caller's own, stored in the same write as the attempt (a round's retry in a new session, `refined`).
    move(id, "building", { attemptId: session.attemptId, ...(note !== undefined ? { note } : resumed !== null ? { note: `${why[resumed]}, from attempt ${task.attemptId}${fromSession ? "" : ", in a new session"}` } : {}) });
    let end: TurnEndReason | "not sent";
    /** The silence watch of each turn sent, the last one's turn the one that ended last. */
    const watches: SilenceWatch[] = [];
    /** Send one message, with the silence limit watching its turn; resolves with how the turn ended. */
    const startTurn = (message: string): Promise<TurnEndReason> => {
      // Registered after the listener above, so it reads the requests the CLI waits on as they stand after each event.
      const silence = watchSilence(session, silenceLimit, () => asking.size > 0);
      watches.push(silence);
      return session.sendTurn(message).finally(() => silence.clear());
    };
    /**
     * Send the waiting note as the next message, and mark it delivered in the same transaction as the session's record of
     * it: a driver records the message it takes before it hands it on, in the same step as `sendTurn`, and records
     * nothing for one it refuses. So the note is marked delivered only once the session took it, and the record and the
     * mark are stored together or not at all. One the session refused stays waiting, and is settled when the turn ends.
     */
    const sendNote = (note: TaskNote): Promise<TurnEndReason> =>
      transaction(db, () => {
        const before = Number(db.prepare("SELECT coalesce(max(id), 0) AS id FROM events WHERE attempt_id = ?").get(session.attemptId)!.id);
        const turn = startTurn(note.text);
        const took = db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND id > ? AND type = 'user_prompt' LIMIT 1").get(session.attemptId, before) !== undefined;
        if (took) deliverNoteIn(db, note.id, session.attemptId);
        return turn;
      });
    /** Whether the task goes on after a turn that ended normally: Botbench is not stopping and its run was not cancelled. */
    const goesOn = (): boolean => !closed && stopped?.aborted !== true && !cancelled(task);
    /** The builder's reply to this drive's own prompt: a round of fixes is recorded from it, not from its answer to a note. */
    let ownReply: string | null = null;
    try {
      // Botbench began stopping, or the run was cancelled, while the attempt was starting: the turn is not sent.
      if (!goesOn()) end = "not sent";
      else {
        let last = await startTurn(prompt);
        ownReply = reply;
        // The owner's note, as the next message of this session (`sendNote`); one sent meanwhile waits for this turn.
        while (last === "completed" && goesOn()) {
          const next = waitingNote(db, id);
          if (next === null) break;
          const turn = sendNote(next);
          options.onTaskChange(getTask(db, id)!);
          last = await turn;
          // The session did not take it (the note still waits): it is not sent again; the end below settles it.
          if (waitingNote(db, id)?.id === next.id) {
            if (last === "completed") last = "error";
            break;
          }
        }
        end = last;
      }
    } catch (err) {
      end = "error";
      detail = words(err);
    }
    // In the same step as the last look for a note: from here no note reaches this builder, and one sent is refused.
    finishing.add(id);
    // Stopped for silence, unless the turn finished meanwhile: its end is the silence, whatever the CLI said as it was stopped.
    const silent = watches.at(-1)?.fired() === true && end !== "completed";
    let leftover: string | null = null;
    try {
      // A task is one turn for now, so its CLI process is not kept.
      await session.close();
      // Nothing of a silent agent may be left running: its whole process group is confirmed gone before the stop is recorded.
      if (silent) await confirmGroupGone(db, session.attemptId);
    } catch (err) {
      leftover = silent
        ? `${agentName(driver.name)} went silent for ${durationWords(silenceLimit)}, the silence limit in Botbench's settings, and Botbench could not stop its process: ${words(err)}`
        : `Its ${agentName(driver.name)} process could not be stopped: ${words(err)}`;
    }
    current = null;
    parkCurrent = null;
    // A note still waiting now is not sent: the turn did not end normally, or the task does not go on to its next message.
    const notSent = leftover !== null ? NOT_DELIVERED.leftover : closed ? NOT_DELIVERED.stopping : !goesOn() ? NOT_DELIVERED.cancelled : silent ? NOT_DELIVERED.silent : end === "interrupted" ? NOT_DELIVERED.interrupted : end === "completed" ? null : NOT_DELIVERED.error;
    if (notSent !== null && settleWaiting(db, id, notSent) !== null) options.onTaskChange(getTask(db, id)!);
    // Parked only if the owner's answer is still outstanding now: it may have come in while Botbench was stopping.
    if (parking && leftover === null && end === "interrupted" && waitingOnApproval(db, id)) {
      // Botbench is stopping while the owner's answer is outstanding. Nothing is committed and nothing ends: the next start finds it.
      admission.park();
      options.onEvent();
      return void move(id, "building", { note: "Botbench stopped while this task waited for the owner's answer; the request is kept for the next start" });
    }
    admission.release();
    options.onEvent();

    // However the turn ended, what it wrote is committed and the task says where it stands.
    if (leftover !== null) await finish(task, "failed", leftover);
    // A turn that finished before the cancel reached it is a finished task like any other.
    else if (cancelled(task) && end !== "completed") {
      if (refineRound !== null) {
        const from = taskReviews(db, id).at(-1)?.headCommit ?? task.headCommit!;
        insertRefinement(db, { taskId: id, round: refineRound, attemptId: session.attemptId, outcome: "stopped", changed: false, reply, problem: "The run was cancelled during this round of fixes.", fromCommit: from, headCommit: null, startedAt: now() });
      }
      await finish(task, "cancelled", CANCELLED);
    }
    // Gone silent: Stopped for the owner, who can resume it, in any mode. A fully autonomous run never accepts it.
    else if (silent) await finish(task, "interrupted", silenceReason(agentName(driver.name), silenceLimit));
    // The usage limit, in any kind of builder turn: the task waits for it and is resumed once. Reached again after that
    // wait (by the resumed turn, or any later turn, also across a restart) it stops the task for the owner; only the
    // owner's Resume allows another wait. Botbench stopping ends a turn as interrupted, never as a limit; a limit reached
    // just as Botbench stops is still stored, and the next start arms its time.
    else if (end === "error" && usageLimit !== null) {
      if (resumed === "limit" || waitedForLimit(id)) await finish(task, "interrupted", limitAgainReason(agentName(driver.name)));
      else await waitForLimit(task, usageLimit.resetsAt);
    }
    // A round of fixes that completed or failed goes on through the loop; one stopped by a restart is taken up again like a build.
    else if (refineRound !== null && (end === "completed" || (end === "error" && resumed !== "answer"))) await refined(task, refineRound, session.attemptId, end, ownReply ?? reply, detail, stopped, fromSession);
    else if (end === "completed") await verify(task, reply, stopped);
    // Botbench is stopping: the task is left as it is, uncommitted, and the next start takes it up again.
    else if (closed && (end === "not sent" || end === "interrupted")) leave(id, "building", "this task was being built");
    else if (end === "not sent") await finish(task, "interrupted", "Botbench stopped before the prompt was sent.");
    else if (end === "interrupted") await finish(task, "interrupted", "It was stopped before it finished. The work done up to then is committed.");
    // Nothing came of the session at all: the CLI did not take it up again.
    else if (resumed === "answer" && !sessionStarted) await finish(task, "interrupted", `Claude Code could not resume the session this task was working in${detail === null ? "." : `: ${detail}`} Your answer was not applied and nothing was run. The work done up to then is committed.`);
    else if (fromSession && !sessionStarted) await finish(task, "interrupted", `Claude Code could not carry on where this task stopped${detail === null ? "." : `: ${detail}`} The work done up to then is committed.`);
    else await finish(task, "failed", `Claude Code ended with an error${detail === null ? "." : `: ${detail}`}`);
  };

  /** Whether a task already waited for a usage limit since it was started or the owner last resumed it, read from its history. */
  const waitedForLimit = (id: number): boolean =>
    db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND status = 'waiting_for_limit' AND id > (SELECT COALESCE(MAX(id), 0) FROM task_events WHERE task_id = ? AND detail LIKE 'resumed by the owner%') LIMIT 1").get(id, id) !== undefined;

  /** The timer that wakes each task waiting for a usage limit, by task id. Armed from the stored time; the store is what counts. */
  const timers = new Map<number, NodeJS.Timeout>();

  /** Set the timer that wakes a waiting task at its stored time (at once when that has passed). */
  const arm = (task: Pick<Task, "id" | "retryAt">): void => {
    clearTimeout(timers.get(task.id));
    // Stopping: the next start arms it from the store.
    if (closed) return;
    const delay = Math.min(Math.max(0, Date.parse(task.retryAt ?? "") - Date.now()) || 0, MAX_TIMER_MS);
    timers.set(
      task.id,
      setTimeout(() => {
        timers.delete(task.id);
        chain = chain.then(() => wake(task.id)).catch(report(`Resuming task ${task.id} after its usage limit`));
      }, delay),
    );
  };

  /**
   * The builder's turn ended on its usage limit: what it wrote is committed, as for any stop, and the task waits until
   * the time stored with it. Read again in the write: a cancel of its run meanwhile ends it as cancelled instead.
   */
  const waitForLimit = async (task: Task, resetsAt: string | null): Promise<void> => {
    const made = await commit(task);
    if (made === null) return;
    const retryAt = retryTime(resetsAt, Date.now(), usageLimitWait);
    const moved = transaction(db, () => {
      if (getTask(db, task.id)?.status !== "building") return null;
      if (cancelled(task)) return moveTaskIn(db, task.id, "cancelled", { headCommit: made.headCommit, reason: CANCELLED });
      return moveTaskIn(db, task.id, "waiting_for_limit", { headCommit: made.headCommit, retryAt });
    });
    if (moved === null) return;
    options.onTaskChange(moved);
    if (moved.status === "waiting_for_limit") arm(moved);
  };

  /**
   * A waiting task's time has come: it goes back to building and its builder is started again, by Botbench itself, in
   * the same session with the task's own model (`carryOn`), once. Nothing happens for a task that no longer waits (its
   * run was cancelled), and a task whose run was cancelled without its wait being ended is ended now. A timer that fired
   * early (a due time beyond the longest timer) is set again. Then the tasks of its run behind it go on.
   */
  const wake = async (id: number): Promise<void> => {
    if (closed) return;
    const task = getTask(db, id);
    if (task?.status !== "waiting_for_limit") return;
    if (Date.parse(task.retryAt ?? "") > Date.now()) return arm(task);
    const moved = transaction(db, () => {
      const now_ = getTask(db, id);
      if (now_?.status !== "waiting_for_limit") return null;
      if (cancelled(now_)) return moveTaskIn(db, id, "cancelled", { reason: LIMIT_CANCELLED });
      // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
      return moveTaskIn(db, id, "building", { note: "the wait for the usage limit is over; the builder's session is resumed once" });
    });
    if (moved === null) return;
    options.onTaskChange(moved);
    if (moved.status === "building") await carryOn(id, "limit");
    settle(moved.runId);
    if (moved.runId !== null && !closed) await runLine(moved.runId);
  };

  /** End a task that waited on the owner across a restart and cannot go on: its approvals are closed, never allowed, and it says why. */
  const giveUp = async (task: Task, reason: string): Promise<void> => {
    broker.endParked(task.id, reason);
    if (task.worktreePath === null) move(task.id, "interrupted", { reason });
    else await finish(task, "interrupted", `${reason} The work done up to then is committed.`);
  };

  /** Stop what is left of the CLI processes of a task's attempts from before this start. Returns why, when one could not be stopped. */
  const stopSurvivors = async (task: Task, parked: readonly { attemptId: number }[]): Promise<string | null> => {
    const attempts = new Set([...(task.attemptId === null ? [] : [task.attemptId]), ...parked.map((approval) => approval.attemptId)]);
    for (const attemptId of attempts) {
      try {
        await stopSurvivor(db, attemptId);
      } catch (err) {
        return `Its Claude Code process from before the restart could not be stopped: ${words(err)}`;
      }
    }
    return null;
  };

  /**
   * The owner answered an approval that was asked before a restart. Once every such approval of the task has its
   * answer, the task is re-driven: a new attempt resumes the session in the same worktree, and the broker gives
   * the stored answers to that attempt's matching requests. A task that cannot be resumed ends interrupted, and
   * its stored answers are discarded.
   */
  const redrive = async (id: number): Promise<void> => {
    try {
      await resumeParked(id);
    } finally {
      // However the resume went (re-driven, or given up), the tasks of its run that waited behind it go on now.
      const runId = getTask(db, id)?.runId ?? null;
      if (runId !== null && !closed) await runLine(runId);
    }
  };

  const resumeParked = async (id: number): Promise<void> => {
    const task = getTask(db, id);
    if (!task) return;
    const parked = pendingApprovals(db, id);
    if (parked.length === 0) return;
    if (task.status !== "building") return broker.endParked(id, `Its task is ${task.status}, so there is nothing to resume.`);
    // Other requests of the task still wait for the owner: it is resumed when all of them are answered.
    if (parked.some((approval) => approval.storedDecision === null)) return;
    // Botbench is stopping: the next start says what became of the answer.
    if (closed) return;
    const problem = (await stopSurvivors(task, parked)) ?? resumeProblem(db, task, parked, driver.capabilities);
    if (problem !== null) return giveUp(task, `This task waited for your answer across a restart and cannot be resumed: ${problem} Your answer was not applied and nothing was run.`);

    // The model stays the one the task was started with, whatever is configured by now.
    const previous = task.attemptId!;
    const resumeCursor = String(db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(previous)!.resume_cursor);
    const admission = admitBuilder(task, previous);
    let session: DriverSession;
    try {
      const gitDir = await sharedGitDir(task.repo);
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task), gitDir }, resumeCursor, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      return giveUp(task, `Claude Code could not be started again to resume this task: ${words(err)} Your answer was not applied and nothing was run.`);
    }
    const stop = new AbortController();
    active = { taskId: id, runId: task.runId, stop };
    try {
      await drive(task, session, admission, RESUME_PROMPT, "answer", stop.signal);
    } finally {
      active = null;
    }
  };

  /**
   * Take up again a task left at `building` or `verifying` by a restart or by the owner's Resume, from where its work
   * was: its checks run again from the start on the committed work; its setup runs again from the start in a copy no
   * agent has worked in; or its agent is started again in its copy, once whatever is left of the agent before it is
   * known to be stopped, taking up the session it had reported (told what happened), or with the task's own prompt
   * when it had reported none. `limit`: the task waited for its builder's usage limit, and this is the one resume after it.
   */
  const carryOn = async (id: number, by: "restart" | "owner" | "limit", before: Before = null): Promise<void> => {
    const task = getTask(db, id);
    if (!task || (task.status !== "building" && task.status !== "verifying") || closed) return;
    await atWork(task, (stop) => carryOnNow(task, by, stop, before));
  };

  /** `before`: the owner resumed a task whose builder's turn had ended without changing a file, or had gone silent, and it is told so. */
  const carryOnNow = async (task: Task, by: "restart" | "owner" | "limit", stop: AbortController, before: Before = null): Promise<void> => {
    const stage = stageOf(db, task);
    const commands = options.repoCommands?.(task.repo) ?? { setup: [], checks: [] };
    if (stage === null || !fs.statSync(task.worktreePath!, { throwIfNoEntry: false })?.isDirectory()) {
      for (const from of ["building", "verifying"] as const) moveFrom(task.id, from, "interrupted", { reason: "This task's copy of the project is no longer there, so it could not be taken up again." });
      return;
    }
    if (stage === "checks") return check(task, commands.checks, stop.signal);
    if (stage === "setup") return setUpAndDrive(task, stop);

    // Never a second agent beside the first in one copy: what is left of the one before is stopped first, or nothing starts.
    const problem = await stopSurvivors(task, []);
    if (problem !== null) return void moveFrom(task.id, "building", "interrupted", { reason: `${problem} Nothing more was run in its copy of the project.` });
    const attempt = db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(task.attemptId!);
    const cursor = driver.capabilities.resume && typeof attempt?.resume_cursor === "string" && attempt.resume_cursor !== "" ? attempt.resume_cursor : null;
    // Botbench starts a builder by itself only to take up the same session: with none to take up, the owner decides.
    if (by === "limit" && cursor === null) return finish(task, "interrupted", limitNoSessionReason(agentName(driver.name)));
    const admission = admitBuilder(task);
    let session: DriverSession;
    try {
      if (closed) throw new Error("Botbench is stopping.");
      const gitDir = await sharedGitDir(task.repo);
      // The model stays the one the task was started with, whatever is configured by now.
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task), gitDir }, ...(cursor === null ? {} : { resumeCursor: cursor }), ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      if (closed) return leave(task.id, "building", "this task was being taken up again");
      return finish(task, "interrupted", `Claude Code could not be started again for this task: ${words(err)} The work done up to then is committed.`);
    }
    // A round of fixes is sent the review again, with word that it was stopped; the first build is told to carry on.
    const reviewer = refineRoundOf(db, task.id) === null ? null : reviewAssignment(db, task.id)?.agent ?? null;
    const prompt =
      reviewer !== null ? await refinePromptFor(task, reviewer, cursor === null, by === "limit" ? "limit" : "restart")
      : cursor === null ? builderPrompt(task)
      : by === "limit" ? LIMIT_PROMPT
      : before === "changed nothing" ? CHANGED_NOTHING_PROMPT
      : before === "silent" ? silentPrompt(durationWords(silenceLimit))
      : CONTINUE_PROMPT;
    await drive(task, session, admission, prompt, by, stop.signal, cursor !== null);
  };

  /** A task a restart left at work for the second time is stopped for the owner, who can resume it. */
  const stopForOwner = async (task: Task, stage: "setup" | "turn" | "checks"): Promise<void> => {
    if (stage === "checks") return void moveFrom(task.id, "verifying", "interrupted", { reason: "Botbench stopped twice while this task's checks ran, so they were not run a third time. The work is committed to its branch; nothing the checks left was committed. Resume runs the checks again." });
    if (stage === "setup") return void moveFrom(task.id, "building", "interrupted", { reason: "Botbench stopped twice while this task was being set up, so it was not set up a third time and Claude Code was not started. Resume runs the setup commands again." });
    await finish(task, "interrupted", "Botbench stopped twice while this task was being built, so it was not started a third time. The work done up to then is committed to its branch. Resume lets Claude Code carry on.");
  };

  /**
   * A Botbench that stopped leaves tasks at stations nothing is working at. First, whatever is left running of its
   * CLIs and of the commands it ran is stopped, each only once it is known to be Botbench's own. A task that was
   * waiting for the owner is parked, and stays where it is until the owner answers. A task that was at work is taken
   * up again once, from where its work was; stopped by a restart a second time, it is stopped for the owner. The count
   * is in the store. Returns the tasks to take up, in the order they were started.
   */
  const recover = async (): Promise<number[]> => {
    // A CLI process of the last run that is recorded on no task (Botbench stopped between starting it and writing it down,
    // or a chat or review turn) is stopped too, and every turn of the last run still running is recorded as stopped:
    // one whose process number was not written yet, or was cleared before its end was, has nothing left to stop.
    for (const row of db.prepare("SELECT id FROM attempts WHERE (pgid IS NOT NULL OR status = 'running') AND created_at < ? ORDER BY id").all(began)) {
      await stopSurvivor(db, Number(row.id)).catch(report(`Stopping the process left by attempt ${row.id}`));
    }
    const unstoppable = await closeLeftCommands(db, began);
    // A task whose review was under way: its reviewer's process is stopped above, the review is recorded as unfinished,
    // and the task, built, committed and checked, waits for the owner.
    for (const row of db.prepare("SELECT id FROM tasks WHERE status = 'reviewing' ORDER BY id").all()) {
      const id = Number(row.id);
      const assigned = reviewAssignment(db, id);
      const at = getTask(db, id)!;
      // Its changed files are marked as `handOver` marks them, so a protected file is named here too.
      const files = await changedPaths(at, at.headCommit);
      const scope = taskScope(db, at, files, options.protectedPaths?.(at.repo) ?? []);
      const guarded = scope.filter((f) => f.protected).map((f) => f.path);
      transaction(db, () => {
        storeUnfinishedReview(db, id, assigned?.agent ?? "unknown", assigned?.model ?? null, `${RESTART_STOPPED}. ${agentName(assigned?.agent ?? "The reviewer")} did not finish its review.`);
        // A fully autonomous run accepts no task whose review did not finish: it says why it waits for the owner.
        const left = getTask(db, id)!;
        const verdict = runModeOf(db, left.runId) === "full" ? qualifies(id, left.checks, scope) : null;
        const reason = verdict !== null ? (verdict.accept ? null : verdict.why) : guarded.length > 0 ? `It needs your review: ${protectedWords(guarded)}` : null;
        moveTaskIn(db, id, "awaiting_decision", { note: "Botbench stopped during the review; the review did not finish", ...(reason === null ? {} : { reason }) });
      });
      options.onTaskChange(getTask(db, id)!);
    }
    const work: number[] = [];
    // The queued tasks of an approved plan are not on their way anywhere yet: they are their run's to build, and stay queued.
    const stale = db.prepare("SELECT id FROM tasks WHERE status IN ('queued', 'building', 'verifying') AND NOT (status = 'queued' AND EXISTS (SELECT 1 FROM runs r WHERE r.id = tasks.run_id AND r.kind = 'planned')) ORDER BY id").all();
    for (const row of stale) {
      const task = getTask(db, Number(row.id))!;
      // One task that cannot be recovered does not hold up the others.
      try {
        const parked = task.status === "building" ? pendingApprovals(db, task.id) : [];
        if (parked.length > 0) {
          // An answer the last run stored and did not get to apply is not carried into this one. One stored since this
          // start (the owner was quick) is not that: its task is resumed in its turn.
          const unapplied = db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'pending' AND stored_decision IS NOT NULL AND stored_at < ? LIMIT 1").get(task.id, began) !== undefined;
          const problem =
            (await stopSurvivors(task, parked)) ??
            (unapplied ? "Botbench stopped after you answered and before the answer could be given to the agent. Your answer was not applied." : resumeProblem(db, task, parked, driver.capabilities));
          if (problem === null) {
            // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
            move(task.id, "building", { note: "parked across a restart: waiting for the owner's answer to a request made before it" });
            continue;
          }
          await giveUp(task, `Botbench stopped while this task waited for your answer, and it cannot be resumed: ${problem} The request was closed and nothing was run.`);
          continue;
        }
        // A task started on its own that had not started: built in its turn.
        if (task.status === "queued") {
          work.push(task.id);
          continue;
        }
        // Something of the last run may still be at work in its copy: nothing more is done there, and nothing is committed.
        const problem = unstoppable.get(task.id) ?? (await stopSurvivors(task, []));
        // The run may have been cancelled while that was being done: the cancel stands.
        if (getTask(db, task.id)?.status !== task.status) continue;
        if (problem !== null) {
          moveFrom(task.id, task.status, "interrupted", { reason: `${problem} Nothing more was run in its copy of the project, and nothing was committed.` });
          continue;
        }
        const stage = stageOf(db, task);
        if (stage === null || !fs.statSync(task.worktreePath!, { throwIfNoEntry: false })?.isDirectory()) {
          moveFrom(task.id, task.status, "interrupted", { reason: "Botbench stopped while this task was on its way, and its copy of the project is not there." });
          continue;
        }
        if (task.restarts >= 1) {
          await stopForOwner(task, stage);
          continue;
        }
        const taken = transaction(db, () => {
          if (getTask(db, task.id)?.status !== task.status) return null;
          db.prepare("UPDATE tasks SET restarts = restarts + 1 WHERE id = ?").run(task.id);
          // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
          return moveTaskIn(db, task.id, task.status, { note: `Botbench restarted while this task was at work (${stage}); it is taken up again once` });
        });
        if (taken === null) continue;
        options.onTaskChange(taken);
        work.push(task.id);
      } catch (err) {
        report(`Recovering task ${task.id}`)(err);
      }
    }
    // A pending approval whose task is at no station where it could be resumed has nobody to answer to.
    for (const row of db.prepare("SELECT DISTINCT a.task_id AS id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.status = 'pending' AND t.status <> 'building'").all()) {
      broker.endParked(Number(row.id), "Its task was no longer being built when Botbench started.");
    }
    // A run an older Botbench left waiting for decisions with no task ready for review has nothing left to decide.
    for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned' AND status IN ('running', 'awaiting_decision') ORDER BY id").all()) settle(Number(row.id));
    return work;
  };

  /** Take up, one at a time, the tasks recovery found at work, then build what the runs that were building have not started. */
  const takeUp = async (work: readonly number[]): Promise<void> => {
    for (const id of work) {
      if (closed) return;
      if (getTask(db, id)?.status === "queued") await build(id);
      else await carryOn(id, "restart");
      settle(getTask(db, id)?.runId ?? null);
    }
  };

  /** The runs that were building when the last Botbench stopped go on: their tasks not started yet are built, in plan order. */
  const resumeRuns = async (): Promise<void> => {
    for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned' AND status = 'running' ORDER BY id").all()) await runLine(Number(row.id));
  };

  // One chain: recovery first, then each task in the order it was started.
  let chain: Promise<void> = recover()
    .then(takeUp)
    .catch(report("Recovering tasks"))
    .then(resumeRuns)
    .catch(report("Building the runs that were building"));

  // A task left waiting for a usage limit by the last Botbench keeps its stored time: it is woken then, or at once when
  // that has passed, in its turn after the recovery above.
  // Each is announced again: a Botbench that stopped between storing the wait and announcing it sent no notification,
  // and the push service records what it sent, so one already sent is not sent twice.
  for (const row of db.prepare("SELECT id FROM tasks WHERE status = 'waiting_for_limit' ORDER BY id").all()) {
    const waiting = getTask(db, Number(row.id))!;
    options.onTaskChange(waiting);
    arm(waiting);
  }

  // An answer stored for a parked approval re-drives its task, in its turn like any other work.
  broker.onStoredAnswer((approval) => {
    // A planner's request belongs to no task; a run that was planning when Botbench stopped is ended by the runs engine.
    const taskId = approval.taskId;
    if (taskId === null) return;
    chain = chain.then(() => redrive(taskId)).catch(report(`Resuming task ${taskId}`));
  });

  const start = async (repo: unknown, prompt: string, model?: string | null, preapproved?: readonly string[]): Promise<Task> => {
    if (closed) throw new TaskError(503, "Botbench is shutting down.");
    const checked = await checkRepository(repo);
    if (closed) throw new TaskError(503, "Botbench is shutting down.");
    const task = createTask(db, { repo: checked, prompt, requestedModel: model === undefined ? (options.model ?? null) : model, ...(preapproved ? { preapproved } : {}) });
    options.onTaskChange(task);
    chain = chain.then(() => build(task.id)).catch(report(`Building task ${task.id}`));
    return task;
  };

  const resume = (id: number): Task => {
    if (closed) throw new TaskError(503, "Botbench is shutting down.");
    const task = getTask(db, id);
    if (!task) throw new TaskError(404, "No such task.");
    const again = changedNothing(task);
    // Read before the reason is cleared: the agent is told why it was stopped.
    const before: Before = again ? "changed nothing" : stoppedForSilence(task) ? "silent" : null;
    if (task.status !== "interrupted" && !again) throw new TaskError(409, `Only a stopped task, or one whose builder changed no file, can be resumed. This task ${STANDS[task.status]}.`);
    const blocker = resumeBlocker(db, task);
    if (blocker !== null) throw new TaskError(409, blocker);
    const to = stageOf(db, task) === "checks" ? "verifying" : "building";
    const { resumed, run } = transaction(db, () => {
      // Resumed by the owner, it is taken up again once more after a restart, as a task they had just started.
      db.prepare("UPDATE tasks SET restarts = 0, reason = NULL WHERE id = ?").run(id);
      // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
      const moved = moveTaskIn(db, id, to, { note: "resumed by the owner" });
      const of = plannedRunOf(db, moved);
      // Its run is at work again until the task reaches an end.
      if (of === null || (of.status !== "done" && of.status !== "awaiting_decision")) return { resumed: moved, run: null };
      const at = now();
      db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(at, of.id);
      // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
      db.prepare("INSERT INTO run_events (run_id, ts, status, detail) VALUES (?, ?, 'running', ?)").run(of.id, at, `task ${id} resumed by the owner`);
      return { resumed: moved, run: { id: of.id, status: "running" } };
    });
    options.onTaskChange(resumed);
    if (run !== null) options.onRunChange?.(run);
    chain = chain
      .then(() => carryOn(id, "owner", before))
      .then(() => {
        const runId = getTask(db, id)?.runId ?? null;
        settle(runId);
        if (runId !== null && !closed) return runLine(runId);
      })
      .catch(report(`Resuming task ${id}`));
    return resumed;
  };

  const sendNote = (id: number, text: string): { note: TaskNote; replaced: TaskNote | null } => {
    if (closed) throw new TaskError(503, "Botbench is shutting down.");
    const queued = transaction(db, () => {
      // Read and written in one transaction, so a note is stored only for a task that is building at that moment.
      const task = getTask(db, id);
      if (!task) throw new TaskError(404, "No such task.");
      if (task.status !== "building") throw new TaskError(409, NOTE_REFUSED[task.status]);
      if (finishing.has(id)) throw new TaskError(409, NOTE_TOO_LATE);
      const problem = noteProblem(text);
      if (problem !== null) throw new TaskError(400, problem);
      return queueNoteIn(db, id, text);
    });
    options.onTaskChange(getTask(db, id)!);
    return queued;
  };

  const buildRun = (runId: number): void => {
    if (closed) return;
    chain = chain.then(() => runLine(runId)).catch(report(`Building run ${runId}`));
  };

  /** Cancels at work outside the chain: waited for by `idle` and `close`. */
  const stopping = new Set<Promise<void>>();
  const stopRun = (runId: number): Promise<void> => {
    const done = stopRunNow(runId).finally(() => stopping.delete(done));
    stopping.add(done);
    return done;
  };
  const stopRunNow = async (runId: number): Promise<void> => {
    // A task of the run that waits, parked, for an answer from before a restart has nothing at work: it is ended here,
    // its work committed. Its requests were closed with the cancel.
    // So is one the owner resumed that waits for its turn. What its checks left is not committed.
    // A task waiting for a usage limit was ended by the cancel's own write (`cancelRun`); its timer has nothing left to wake.
    for (const row of db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'cancelled'").all(runId)) {
      clearTimeout(timers.get(Number(row.id)));
      timers.delete(Number(row.id));
    }
    for (const row of db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status IN ('building', 'verifying') ORDER BY id").all(runId)) {
      const task = getTask(db, Number(row.id))!;
      if (active?.taskId === task.id) continue;
      if (task.status === "verifying") moveFrom(task.id, "verifying", "cancelled", { reason: "The run was cancelled before this task's checks ran again. The work is committed to its branch." });
      else if (task.worktreePath === null) moveFrom(task.id, "building", "cancelled", { reason: CANCELLED });
      else await finish(task, "cancelled", CANCELLED);
    }
    if (active === null || active.runId !== runId) return;
    active.stop.abort();
    // Ends the running turn as interrupted; the build then commits what it did and records the task as cancelled.
    await current?.close().catch(report(`Stopping the turn of run ${runId}`));
  };

  const close = async (): Promise<void> => {
    closed = true;
    // A task waiting for a usage limit keeps its stored time for the next start; only this start's timers go.
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    // A task that is waiting for the owner right now is parked, not ended: its approvals stay for the next start.
    parkCurrent?.();
    // A setup command at work is stopped with its process group.
    active?.stop.abort();
    // Ends the running turn as interrupted; the build then leaves the task for the next start, or parks it. The build
    // reports a process that would not stop, and the chain is always waited for: the database closes after this.
    await current?.close().catch(() => {});
    await chain;
    await Promise.all([...stopping]);
  };

  const idle = async (): Promise<void> => {
    await Promise.all([chain, ...stopping]);
  };

  /**
   * A blocker of a task was cleared (a check together passed, engine/combined.ts): a task of a fully autonomous run that
   * is still ready for review is looked at again by its mode, exactly as when it first got there, and accepted when it
   * now qualifies. Any other task is left as it is. Waited for by `idle` and `close`.
   */
  const reconsider = (taskId: number): Promise<void> => {
    const task = getTask(db, taskId);
    if (closed || task === null || task.status !== "awaiting_decision" || runModeOf(db, task.runId) !== "full") return Promise.resolve();
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    const done: Promise<void> = handOver(task, "awaiting_decision", { note: "a check together passed; the run's mode looked at the task again" })
      .catch(report(`Looking again at task ${taskId}`))
      .finally(() => stopping.delete(done));
    stopping.add(done);
    return done;
  };

  return { start, buildRun, stopRun, resume, sendNote, reconsider, idle, close };
}
