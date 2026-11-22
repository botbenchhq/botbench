import { randomBytes } from "node:crypto";
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
import { RESUME_PROMPT, resumeProblem, stopSurvivor } from "./recover.ts";
import { IMPLEMENTER } from "./roles.ts";
import { commandProblem, insertEvidence, runCommand, type StationCommand } from "./stations.ts";

/**
 * The stations a task can be at. `building` covers making its worktree, running the repository's setup
 * commands there and its builder's turn. `verifying` is the repository's check commands running on the work Botbench
 * committed. `awaiting_decision` means nothing further happens until the owner decides; `accepted` and `rejected` are
 * the owner's decision (engine/decision.ts); `interrupted`, `failed` and `cancelled` are ends that carry a reason.
 */
export type TaskStatus = "queued" | "building" | "verifying" | "awaiting_decision" | "accepted" | "rejected" | "interrupted" | "failed" | "cancelled";
/** What a task's checks found: all passed, at least one failed or ran out of time, or the repository has none. */
export type ChecksMark = "passed" | "failed" | "none";

/** Where a task may go from each station. `building` to `building` records an attempt starting under the task. */
const MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["building", "interrupted", "failed", "cancelled"],
  building: ["building", "verifying", "awaiting_decision", "interrupted", "failed", "cancelled"],
  verifying: ["awaiting_decision", "interrupted", "failed", "cancelled"],
  awaiting_decision: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
  interrupted: [],
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
  createdAt: string;
  updatedAt: string;
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
  if (has("'queued', 'building', 'verifying'")) return null;
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
  /** Resolves when nothing is being built or recovered. */
  idle(): Promise<void>;
  /** Interrupt the task being built, commit what it did, and leave no CLI process behind. Tasks still queued are marked interrupted. */
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
   * The builder finished: commit its work, then run the repository's check commands on it, in its worktree, each with
   * its time limit, and record each as evidence. The task goes on to wait for the owner whatever the checks found; it
   * says what that was. A check stopped by a cancel or by Botbench stopping ends the task as cancelled or interrupted.
   */
  const verify = async (task: Task, stopped?: AbortSignal): Promise<void> => {
    const headCommit = await commit(task);
    if (headCommit === null) return;
    const checks = options.repoCommands?.(task.repo).checks ?? [];
    // No checks: said so as such, never as a pass.
    if (checks.length === 0) return void move(task.id, "awaiting_decision", { headCommit, checks: "none" });
    move(task.id, "verifying", { headCommit });
    let failed = false;
    let interrupted = false;
    for (const [i, check] of checks.entries()) {
      if (stopped?.aborted || closed) {
        interrupted = true;
        break;
      }
      const result = await runCommand({ command: check.command, cwd: task.worktreePath!, limitMs: check.limitMs, confinement: confinement(task.repo), ...(stopped ? { signal: stopped } : {}) });
      insertEvidence(db, task.id, "check", i + 1, result);
      options.onTaskChange(getTask(db, task.id)!);
      if (result.outcome === "stopped") {
        interrupted = true;
        break;
      }
      if (result.outcome !== "passed") failed = true;
    }
    if (interrupted) {
      if (cancelled(task)) return void move(task.id, "cancelled", { reason: "The run was cancelled while this task's checks ran. The work is committed to its branch; the checks did not finish." });
      return void move(task.id, "interrupted", { reason: "Botbench stopped while this task's checks ran. The work is committed to its branch; the checks did not finish." });
    }
    move(task.id, "awaiting_decision", { checks: failed ? "failed" : "passed" });
  };

  /**
   * Build one queued task: its worktree (from its run's base commit, for a task of a planned run), the repository's
   * setup commands in it, then its builder's turn. A task whose run was cancelled meanwhile is left as the cancel left it.
   */
  const build = async (id: number): Promise<void> => {
    const queued = getTask(db, id);
    if (!queued || queued.status !== "queued") return;
    if (closed) return void moveFrom(id, "queued", "interrupted", { reason: "Botbench stopped before this task started." });
    const stop = new AbortController();
    active = { taskId: id, runId: queued.runId, stop };
    try {
      await prepareAndDrive(queued, stop);
    } catch (err) {
      // Whatever went wrong unforeseen, the task does not stay at a station nothing works at, holding up its run.
      report(`Building task ${id}`)(err);
      for (const from of ["queued", "building", "verifying"] as const) moveFrom(id, from, "failed", { reason: `Botbench could not go on with this task: ${words(err)}` });
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
      return void moveFrom(id, "queued", closed ? "interrupted" : "failed", { reason: `The task's copy of the project could not be created: ${words(err)}` });
    }
    const task = moveFrom(id, "queued", "building", { worktree });
    if (task === null) {
      // Cancelled while its copy was being made: the unused copy and its branch go again.
      await removeWorktree({ repo: queued.repo, path: worktree.path, deleteBranch: true }).catch(report(`Removing the unused copy of task ${id}`));
      return;
    }

    // The repository's setup commands, in order, before any agent. The first that does not pass ends the task.
    const setup = options.repoCommands?.(task.repo).setup ?? [];
    for (const [i, command] of setup.entries()) {
      if (stop.signal.aborted) break;
      const result = await runCommand({ command: command.command, cwd: worktree.path, limitMs: command.limitMs, signal: stop.signal, confinement: confinement(task.repo) });
      insertEvidence(db, id, "setup", i + 1, result);
      options.onTaskChange(getTask(db, id)!);
      if (result.outcome === "stopped") break;
      if (result.outcome !== "passed") return void move(id, "failed", { reason: commandProblem("setup", result) });
    }
    if (stop.signal.aborted) {
      if (cancelled(task)) return finish(task, "cancelled", "The run was cancelled while this task was being prepared. What setup wrote is committed to its branch.");
      return finish(task, "interrupted", "Botbench stopped while this task was being prepared.");
    }

    // The attempt's own way to the permission gate. It is released whichever way the build ends.
    const admission = broker.admit({ taskId: id, role: IMPLEMENTER, worktree: worktree.path });
    let session: DriverSession;
    try {
      if (closed) throw new Error("Botbench is stopping.");
      const gitDir = await sharedGitDir(task.repo);
      session = await driver.startAttempt({ db, cwd: worktree.path, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { ...confinement(task.repo), gitDir }, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      if (setup.length > 0) {
        // The setup commands may have written to the copy: it is kept, and what they wrote is committed.
        return finish(task, closed ? "interrupted" : cancelled(task) ? "cancelled" : "failed", words(err));
      }
      // Nothing happened in the worktree, so it and its branch go again.
      const reason = await removeWorktree({ repo: task.repo, path: worktree.path, deleteBranch: true }).then(
        () => words(err),
        (removal: unknown) => `${words(err)} The unused copy at ${worktree.path} could not be removed: ${words(removal)}`,
      );
      return void move(id, closed ? "interrupted" : cancelled(task) ? "cancelled" : "failed", { reason });
    }

    await drive(task, session, admission, task.prompt, false, stop.signal);
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
      if (db.prepare("SELECT 1 FROM tasks WHERE run_id = ? AND status IN ('building', 'verifying') LIMIT 1").get(runId)) return;
      const next = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'queued' ORDER BY id LIMIT 1").get(runId);
      if (!next) return settle(runId);
      await build(Number(next.id));
      settle(runId);
    }
  };

  /**
   * Run one turn of a task's attempt to its end and record where that leaves the task. `resumed` is true for the
   * turn that re-drives a task after a restart. If Botbench is stopped while the turn waits for the owner, the task
   * is parked: its approvals stay pending and it stays at `building` for the next start to find.
   */
  const drive = async (task: Task, session: DriverSession, admission: Admission, prompt: string, resumed: boolean, stopped?: AbortSignal): Promise<void> => {
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
          .then((answer) => (asking.has(event.id) ? session.respondToRequest(event.id, { decision: answer.decision, note: answer.note, refused: answer.refused, preapproved: answer.preapproved !== undefined, standing: answer.standing !== undefined }) : undefined))
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
    move(id, "building", { attemptId: session.attemptId, ...(resumed ? { note: `resumed after a restart, from attempt ${task.attemptId}` } : {}) });
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
    else if (end === "not sent") await finish(task, "interrupted", "Botbench stopped before the prompt was sent.");
    else if (end === "interrupted") await finish(task, "interrupted", "It was stopped before it finished. The work done up to then is committed.");
    // Nothing came of the session at all: the CLI did not take it up again.
    else if (resumed && !sessionStarted) await finish(task, "interrupted", `Claude Code could not resume the session this task was working in${detail === null ? "." : `: ${detail}`} Your answer was not applied and nothing was run. The work done up to then is committed.`);
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
      await resume(id);
    } finally {
      // However the resume went (re-driven, or given up), the tasks of its run that waited behind it go on now.
      const runId = getTask(db, id)?.runId ?? null;
      if (runId !== null && !closed) await runLine(runId);
    }
  };

  const resume = async (id: number): Promise<void> => {
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
    const admission = broker.admit({ taskId: id, role: IMPLEMENTER, worktree: task.worktreePath!, resumes: previous });
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
      await drive(task, session, admission, RESUME_PROMPT, true, stop.signal);
    } finally {
      active = null;
    }
  };

  /**
   * A Botbench that stopped leaves tasks at stations nothing is working at. One that was waiting for the owner is
   * parked: whatever is left of its CLI process is stopped, and it stays where it is until the owner answers.
   * Every other one is marked interrupted, with its work kept. Say so in each case.
   */
  const recover = async (): Promise<void> => {
    // A CLI process of the last run that is recorded on no task (Botbench stopped between starting it and writing it down) is stopped too.
    for (const row of db.prepare("SELECT id FROM attempts WHERE pgid IS NOT NULL AND created_at < ? ORDER BY id").all(began)) {
      await stopSurvivor(db, Number(row.id)).catch(report(`Stopping the process left by attempt ${row.id}`));
    }
    // The queued tasks of an approved plan are not on their way anywhere yet: they are their run's to build, and stay queued.
    // A task whose checks were running is stopped. Its work was committed before they started; nothing a check left is committed.
    for (const row of db.prepare("SELECT id FROM tasks WHERE status = 'verifying' ORDER BY id").all()) {
      move(Number(row.id), "interrupted", { reason: "Botbench stopped while this task's checks ran. The work is committed to its branch; the checks did not finish." });
    }
    const stale = db.prepare("SELECT id FROM tasks WHERE status IN ('queued', 'building') AND NOT (status = 'queued' AND EXISTS (SELECT 1 FROM runs r WHERE r.id = tasks.run_id AND r.kind = 'planned')) ORDER BY id").all();
    for (const row of stale) {
      const task = getTask(db, Number(row.id))!;
      const parked = pendingApprovals(db, task.id);
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
      const reason = "Botbench stopped while this task was on its way.";
      if (task.worktreePath === null) move(task.id, "interrupted", { reason });
      else await finish(task, "interrupted", `${reason} The work done up to then is committed.`);
    }
    // A pending approval whose task is at no station where it could be resumed has nobody to answer to.
    for (const row of db.prepare("SELECT DISTINCT a.task_id AS id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.status = 'pending' AND t.status <> 'building'").all()) {
      broker.endParked(Number(row.id), "Its task was no longer being built when Botbench started.");
    }
    // A run an older Botbench left waiting for decisions with no task ready for review has nothing left to decide.
    for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned' AND status = 'awaiting_decision' ORDER BY id").all()) settle(Number(row.id));
  };

  /** The runs that were building when the last Botbench stopped go on: their tasks not started yet are built, in plan order. */
  const resumeRuns = async (): Promise<void> => {
    for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned' AND status = 'running' ORDER BY id").all()) await runLine(Number(row.id));
  };

  // One chain: recovery first, then each task in the order it was started.
  let chain: Promise<void> = recover().catch(report("Recovering tasks")).then(resumeRuns).catch(report("Building the runs that were building"));

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
    for (const row of db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'building' ORDER BY id").all(runId)) {
      const task = getTask(db, Number(row.id))!;
      if (active?.taskId === task.id) continue;
      if (task.worktreePath === null) moveFrom(task.id, "building", "cancelled", { reason: CANCELLED });
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
    // Ends the running turn as interrupted; the build then commits and records it, or parks it. The build reports a
    // process that would not stop, and the chain is always waited for: the database closes after this.
    await current?.close().catch(() => {});
    await chain;
    await Promise.all([...stopping]);
  };

  const idle = async (): Promise<void> => {
    await Promise.all([chain, ...stopping]);
  };

  return { start, buildRun, stopRun, idle, close };
}
