import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingApprovals, waitingOnApproval, type Admission, type Broker } from "../approvals/broker.ts";
import { summarize } from "../approvals/gate.ts";
import { insertPreapproved, realRepo } from "../approvals/grants.ts";
import type { Driver, DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";
import { now, transaction } from "../store/db.ts";
import type { Confinement } from "../confinement.ts";
import { commitWork, createWorktree, describeWork, removeWorktree, sharedGitDir, sourceHead, type Worktree } from "../worktrees.ts";
import { closeLeftCommands, CONTINUE_PROMPT, RESUME_PROMPT, resumeProblem, stopSurvivor } from "./recover.ts";
import { autoAccept, modeRefusals, reviewOutcome, runModeOf } from "./modes.ts";
import { reviewAssignment, runReview, storeUnfinishedReview } from "./review.ts";
import { agentName, IMPLEMENTER } from "./roles.ts";
import { commandProblem, nextRound, runCommand, type CommandRun, type EvidenceKind, type StationCommand } from "./stations.ts";

/**
 * The stations a task can be at. `building` covers making its worktree, running the repository's setup
 * commands there and its builder's turn. `verifying` is the repository's check commands running on the work Botbench
 * committed. `reviewing` is the run's reviewer reading the work, after the checks (engine/review.ts). `awaiting_decision` means nothing further happens until the owner decides; `accepted` and `rejected` are
 * the owner's decision (engine/decision.ts); `interrupted`, `failed` and `cancelled` are ends that carry a reason.
 */
export type TaskStatus = "queued" | "building" | "verifying" | "reviewing" | "awaiting_decision" | "accepted" | "rejected" | "interrupted" | "failed" | "cancelled";
/** What a task's checks found: all passed, at least one failed or ran out of time, or the repository has none. */
export type ChecksMark = "passed" | "failed" | "none";

/**
 * Where a task may go from each station. `building` to `building` records an attempt starting under the task, and a
 * move to the same station records something for its history. A stopped task goes back to work only by the owner's Resume.
 */
const MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["building", "interrupted", "failed", "cancelled"],
  building: ["building", "verifying", "reviewing", "awaiting_decision", "interrupted", "failed", "cancelled"],
  verifying: ["verifying", "reviewing", "awaiting_decision", "interrupted", "failed", "cancelled"],
  reviewing: ["awaiting_decision", "failed", "cancelled"],
  // To itself: a fully autonomous run that could not accept the task records why it waits for the owner.
  awaiting_decision: ["awaiting_decision", "accepted", "rejected"],
  accepted: [],
  rejected: [],
  interrupted: ["building", "verifying"],
  failed: [],
  cancelled: [],
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
  createdAt: string;
  updatedAt: string;
}


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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getTask(db: DatabaseSync, id: number): Task | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? toTask(row) : null;
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
    const values: (string | number)[] = [to, at];
    const details: string[] = [];
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
  if (has("'queued', 'building', 'verifying', 'reviewing'")) return null;
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
  const from = task.status === "interrupted" ? db.prepare("SELECT status FROM task_events WHERE task_id = ? AND status <> 'interrupted' ORDER BY id DESC LIMIT 1").get(task.id)?.status : task.status;
  if (from === "verifying") return task.headCommit === null ? null : "checks";
  // An agent is sent its prompt only once its task names its attempt, so a task with none has had nothing written by an agent.
  if (from === "building") return task.attemptId === null ? "setup" : "turn";
  return null;
}

/** Why a stopped task cannot be resumed, in words for the owner; null when it can. */
export function resumeBlocker(db: DatabaseSync, task: Task): string | null {
  if (stageOf(db, task) === null) return "This task has nothing to resume: it was stopped before there was work in a copy of the project.";
  if (!fs.statSync(task.worktreePath!, { throwIfNoEntry: false })?.isDirectory()) return "This task's copy of the project is no longer there, so there is nothing to resume.";
  if (plannedRunOf(db, task)?.status === "cancelled") return "Its run was cancelled, so it cannot be resumed.";
  return null;
}

/** For a stopped task that can be resumed: what Resume will do, in words for the owner. Null for every other task. */
export function resumeNote(db: DatabaseSync, task: Task): string | null {
  if (task.status !== "interrupted" || resumeBlocker(db, task) !== null) return null;
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
const firstLine = (s: string, max = 60): string => {
  const line = s.trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

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
  /** The agents that can review a run's tasks, by name. A run whose reviewer is not among them has its tasks' reviews fail, saying so. */
  reviewers?: Partial<Record<string, Driver>>;
  /** The time a reviewer gets; 10 minutes when left out. */
  reviewLimitMs?: number;
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
  /** What the commands of a task in `repo` are kept from (U27). */
  const confinement = (repo: string): Confinement => ({ dataDir: home, allowedHosts: options.repoHosts?.(repo) ?? [] });
  /** Whether the builder's driver runs every shell command confined: only then may a run's mode let one run without asking. */
  const confined = driver.capabilities.confinedCommands === true;
  let closed = false;
  let current: DriverSession | null = null;
  /** Set while a turn runs: called when Botbench begins to stop, it decides whether that turn's task is parked. */
  let parkCurrent: (() => void) | null = null;
  /** The task being built now, the run it belongs to, and the way to stop its setup command or turn. */
  let active: { taskId: number; runId: number | null; stop: AbortController } | null = null;
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
    const headCommit = await commit(task, reason);
    if (headCommit !== null) move(task.id, to, { headCommit, ...(reason === undefined ? {} : { reason }) });
  };
  /** Commit whatever is in the task's worktree; the commit, or null when it could not be made and the task has failed saying why. */
  const commit = async (task: Task, reason?: string): Promise<string | null> => {
    try {
      await commitWork({ path: task.worktreePath!, message: `Botbench task ${task.id}: ${firstLine(task.prompt)}` });
      return (await describeWork({ path: task.worktreePath!, baseCommit: task.baseCommit! })).headCommit;
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
    let failed: CommandRun | null = null;
    for (const [i, command] of commands.entries()) {
      if (signal?.aborted || closed) return { stopped: true, failed };
      const result = await runCommand({ command: command.command, cwd: task.worktreePath!, limitMs: command.limitMs, confinement: confinement(task.repo), track: { db, taskId: task.id, kind, round, position: i + 1 }, ...(signal ? { signal } : {}) });
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
  const verify = async (task: Task, stopped?: AbortSignal): Promise<void> => {
    const headCommit = await commit(task);
    if (headCommit === null) return;
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
  const review = async (task: Task, from: "building" | "verifying", change: TaskChange, stopped?: AbortSignal): Promise<void> => {
    const assigned = reviewAssignment(db, task.id);
    if (assigned === null) return handOver(task, from, change);
    const at = moveFrom(task.id, from, "reviewing", change);
    if (at === null) return;
    const done = await runReview({
      db, driver: options.reviewers?.[assigned.agent] ?? unknownReviewer(assigned.agent), model: assigned.model, taskId: task.id, task: assigned.task, worktree: at.worktreePath!, baseCommit: at.baseCommit!, headCommit: at.headCommit!,
      confinement: { ...confinement(task.repo), gitDir: await sharedGitDir(task.repo) }, ...(options.reviewLimitMs ? { limitMs: options.reviewLimitMs } : {}), ...(stopped ? { signal: stopped } : {}), onEvent: options.onEvent,
    });
    options.onTaskChange(getTask(db, task.id)!);
    if (done.outcome === "stopped" && cancelled(task)) return void moveFrom(task.id, "reviewing", "cancelled", { reason: "The run was cancelled while this task was being reviewed. The work is committed to its branch; the review did not finish." });
    await handOver(task, "reviewing", {});
  };

  /** Whether a task of a fully autonomous run is accepted by the mode, from what is stored of it now. */
  const qualifies = (id: number, checks: Task["checks"]): ReturnType<typeof autoAccept> => autoAccept({ checks, review: reviewOutcome(db, id), refusals: modeRefusals(db, id) });

  /**
   * The task is ready for review. In a fully autonomous run it is accepted by the mode when it qualifies, as the owner's
   * Accept would; when it does not, or the accept is refused (files the checks left, a branch that went missing), it
   * waits for the owner with a plain line saying why.
   */
  const handOver = async (task: Task, from: "building" | "verifying" | "reviewing", change: TaskChange): Promise<void> => {
    if (runModeOf(db, task.runId) !== "full") return void moveFrom(task.id, from, "awaiting_decision", change);
    const verdict = qualifies(task.id, change.checks ?? getTask(db, task.id)?.checks ?? null);
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
      worktree = await createWorktree({ repo: queued.repo, home, run: queued.runId === null ? `run-${randomBytes(4).toString("hex")}` : `run-${queued.runId}`, task: `task-${id}`, ...(plan ? { commit: plan.baseCommit } : {}) });
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
    const admission = broker.admit({ taskId: id, role: IMPLEMENTER, worktree: task.worktreePath!, confined });
    let session: DriverSession;
    try {
      if (closed) throw new Error("Botbench is stopping.");
      const gitDir = await sharedGitDir(task.repo);
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task.repo), gitDir }, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
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

    await drive(task, session, admission, task.prompt, null, stop.signal);
  };

  /**
   * Build a run's queued tasks one after another, in plan order, while the run is running. It stops at a task of the
   * run that is still building without being worked on here: one that waits for the owner's answer across a restart
   * holds up the tasks after it until it is resumed.
   */
  const runLine = async (runId: number): Promise<void> => {
    for (;;) {
      if (closed) return;
      const run = db.prepare("SELECT status FROM runs WHERE id = ? AND kind = 'planned'").get(runId);
      if (run?.status !== "running") return;
      if (db.prepare("SELECT 1 FROM tasks WHERE run_id = ? AND status IN ('building', 'verifying', 'reviewing') LIMIT 1").get(runId)) return;
      const next = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'queued' ORDER BY id LIMIT 1").get(runId);
      if (!next) return settle(runId);
      await build(Number(next.id));
      settle(runId);
    }
  };

  /**
   * Run one turn of a task's attempt to its end and record where that leaves the task. `resumed` says why a task is
   * driven again: the owner's answer to a request from before a restart, a restart, or the owner's Resume; null for
   * its first turn. `fromSession`: the attempt takes up the session of the one before. If Botbench is stopped while
   * the turn waits for the owner, the task is parked: its approvals stay pending and it stays at `building` for the
   * next start to find; stopped at any other point of the turn, it is left at `building` for the next start to take up.
   */
  const drive = async (task: Task, session: DriverSession, admission: Admission, prompt: string, resumed: "answer" | "restart" | "owner" | null, stopped?: AbortSignal, fromSession = resumed === "answer"): Promise<void> => {
    const id = task.id;
    current = session;
    admission.bind(session.attemptId);
    let detail: string | null = null;
    let sessionStarted = false;
    let parking = false;
    parkCurrent = () => void (parking = waitingOnApproval(db, id));
    /** Permission requests the CLI is still waiting on, by request id. */
    const asking = new Set<string>();
    session.onEvent((event) => {
      if (event.type === "session_started") sessionStarted = true;
      if (event.type === "turn_ended") detail = event.detail;
      if (event.type === "permission_request") {
        asking.add(event.id);
        // The broker never rejects: whatever fails on the way to the owner comes back as a decline.
        void broker
          .request({ taskId: id, attemptId: session.attemptId, role: IMPLEMENTER, tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
          // A request the CLI has stopped waiting for has no one to tell.
          .then((answer) => (asking.has(event.id) ? session.respondToRequest(event.id, { decision: answer.decision, note: answer.note, refused: answer.refused, preapproved: answer.preapproved !== undefined, standing: answer.standing !== undefined, mode: answer.byMode !== undefined }) : undefined))
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
    const why = { answer: "resumed after a restart", restart: "taken up again after a restart", owner: "resumed by the owner" } as const;
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    move(id, "building", { attemptId: session.attemptId, ...(resumed !== null ? { note: `${why[resumed]}, from attempt ${task.attemptId}${fromSession ? "" : ", in a new session"}` } : {}) });
    let end: TurnEndReason | "not sent";
    try {
      // Botbench began stopping, or the run was cancelled, while the attempt was starting: the turn is not sent.
      end = closed || stopped?.aborted === true || cancelled(task) ? "not sent" : await session.sendTurn(prompt);
    } catch (err) {
      end = "error";
      detail = words(err);
    }
    let leftover: string | null = null;
    try {
      // A task is one turn for now, so its CLI process is not kept.
      await session.close();
    } catch (err) {
      leftover = `Its Claude Code process could not be stopped: ${words(err)}`;
    }
    current = null;
    parkCurrent = null;
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
    else if (cancelled(task) && end !== "completed") await finish(task, "cancelled", CANCELLED);
    else if (end === "completed") await verify(task, stopped);
    // Botbench is stopping: the task is left as it is, uncommitted, and the next start takes it up again.
    else if (closed && (end === "not sent" || end === "interrupted")) leave(id, "building", "this task was being built");
    else if (end === "not sent") await finish(task, "interrupted", "Botbench stopped before the prompt was sent.");
    else if (end === "interrupted") await finish(task, "interrupted", "It was stopped before it finished. The work done up to then is committed.");
    // Nothing came of the session at all: the CLI did not take it up again.
    else if (resumed === "answer" && !sessionStarted) await finish(task, "interrupted", `Claude Code could not resume the session this task was working in${detail === null ? "." : `: ${detail}`} Your answer was not applied and nothing was run. The work done up to then is committed.`);
    else if (fromSession && !sessionStarted) await finish(task, "interrupted", `Claude Code could not carry on where this task stopped${detail === null ? "." : `: ${detail}`} The work done up to then is committed.`);
    else await finish(task, "failed", `Claude Code ended with an error${detail === null ? "." : `: ${detail}`}`);
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
    const admission = broker.admit({ taskId: id, role: IMPLEMENTER, worktree: task.worktreePath!, resumes: previous, confined });
    let session: DriverSession;
    try {
      const gitDir = await sharedGitDir(task.repo);
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task.repo), gitDir }, resumeCursor, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
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
   * when it had reported none.
   */
  const carryOn = async (id: number, by: "restart" | "owner"): Promise<void> => {
    const task = getTask(db, id);
    if (!task || (task.status !== "building" && task.status !== "verifying") || closed) return;
    await atWork(task, (stop) => carryOnNow(task, by, stop));
  };

  const carryOnNow = async (task: Task, by: "restart" | "owner", stop: AbortController): Promise<void> => {
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
    const admission = broker.admit({ taskId: task.id, role: IMPLEMENTER, worktree: task.worktreePath!, confined });
    let session: DriverSession;
    try {
      if (closed) throw new Error("Botbench is stopping.");
      const gitDir = await sharedGitDir(task.repo);
      // The model stays the one the task was started with, whatever is configured by now.
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task.repo), gitDir }, ...(cursor === null ? {} : { resumeCursor: cursor }), ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      if (closed) return leave(task.id, "building", "this task was being taken up again");
      return finish(task, "interrupted", `Claude Code could not be started again for this task: ${words(err)} The work done up to then is committed.`);
    }
    await drive(task, session, admission, cursor === null ? task.prompt : CONTINUE_PROMPT, by, stop.signal, cursor !== null);
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
    // A CLI process of the last run that is recorded on no task (Botbench stopped between starting it and writing it down) is stopped too.
    for (const row of db.prepare("SELECT id FROM attempts WHERE pgid IS NOT NULL AND created_at < ? ORDER BY id").all(began)) {
      await stopSurvivor(db, Number(row.id)).catch(report(`Stopping the process left by attempt ${row.id}`));
    }
    const unstoppable = await closeLeftCommands(db, began);
    // A task whose review was under way: its reviewer's process is stopped above, the review is recorded as unfinished,
    // and the task, built, committed and checked, waits for the owner.
    for (const row of db.prepare("SELECT id FROM tasks WHERE status = 'reviewing' ORDER BY id").all()) {
      const id = Number(row.id);
      const assigned = reviewAssignment(db, id);
      transaction(db, () => {
        storeUnfinishedReview(db, id, assigned?.agent ?? "unknown", assigned?.model ?? null, `Botbench stopped before ${agentName(assigned?.agent ?? "the reviewer")} finished its review.`);
        // A fully autonomous run accepts no task whose review did not finish: it says why it waits for the owner.
        const left = getTask(db, id)!;
        const verdict = runModeOf(db, left.runId) === "full" ? qualifies(id, left.checks) : null;
        moveTaskIn(db, id, "awaiting_decision", { note: "Botbench stopped during the review; the review did not finish", ...(verdict === null || verdict.accept ? {} : { reason: verdict.why }) });
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
    if (task.status !== "interrupted") throw new TaskError(409, `Only a stopped task can be resumed. This task ${STANDS[task.status]}.`);
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
      .then(() => carryOn(id, "owner"))
      .then(() => {
        const runId = getTask(db, id)?.runId ?? null;
        settle(runId);
        if (runId !== null && !closed) return runLine(runId);
      })
      .catch(report(`Resuming task ${id}`));
    return resumed;
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

  return { start, buildRun, stopRun, resume, idle, close };
}
