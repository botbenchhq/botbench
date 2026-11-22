import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Broker } from "../approvals/broker.ts";
import { summarize } from "../approvals/gate.ts";
import type { Driver, DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";
import { now, transaction } from "../store/db.ts";
import { commitWork, createWorktree, describeWork, removeWorktree, sourceHead, type Worktree } from "../worktrees.ts";

/**
 * The stations a task can be at so far. `awaiting_decision` means Smelt has
 * committed the work and nothing further happens until the owner decides;
 * `interrupted` and `failed` are ends that carry a reason.
 */
export type TaskStatus = "queued" | "building" | "awaiting_decision" | "interrupted" | "failed";

/** Where a task may go from each station. `building` to `building` records an attempt starting under the task. */
const MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["building", "interrupted", "failed"],
  building: ["building", "awaiting_decision", "interrupted", "failed"],
  awaiting_decision: [],
  interrupted: [],
  failed: [],
};

export interface Task {
  id: number;
  /** The run this task belongs to. None until runs exist. */
  runId: number | null;
  repo: string;
  prompt: string;
  status: TaskStatus;
  /** Why the task was interrupted or failed, in words for the owner. */
  reason: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  /** The task branch's commit after Smelt committed the work. */
  headCommit: string | null;
  attemptId: number | null;
  /** Tasks this one waits for. Always empty for now. */
  dependsOn: string;
  createdAt: string;
  updatedAt: string;
}

/** The role a task's one attempt works in. Other roles arrive with the stations that need them. */
const IMPLEMENTER = "implementer";

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
    status: String(row.status) as TaskStatus,
    reason: text(row.reason),
    worktreePath: text(row.worktree_path),
    branch: text(row.branch),
    baseCommit: text(row.base_commit),
    headCommit: text(row.head_commit),
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

/** Store a new task as queued. The row and its first event are written together. */
export function createTask(db: DatabaseSync, o: { repo: string; prompt: string }): Task {
  return transaction(db, () => {
    const at = now();
    const id = Number(db.prepare("INSERT INTO tasks (repo_path, prompt, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)").run(o.repo, o.prompt, at, at).lastInsertRowid);
    insertEvent(db, id, at, "queued", null);
    return getTask(db, id)!;
  });
}

export interface TaskChange {
  reason?: string;
  worktree?: Worktree;
  attemptId?: number;
  headCommit?: string;
}

/**
 * Move a task to a station and record what came with the move. The new state
 * and its event are written in one transaction, so neither exists without the
 * other. A move the line does not have is refused and writes nothing.
 */
export function moveTask(db: DatabaseSync, id: number, to: TaskStatus, change: TaskChange = {}): Task {
  return transaction(db, () => {
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
    if (change.reason !== undefined) {
      sets.push("reason = ?");
      values.push(change.reason);
      details.unshift(change.reason);
    }
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    insertEvent(db, id, at, to, details.length === 0 ? null : details.join("; "));
    return getTask(db, id)!;
  });
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
  /** Check the repository, store the task as queued and return it at once. The build goes on in the background. */
  start(repo: unknown, prompt: string): Promise<Task>;
  /** Resolves when nothing is being built or recovered. */
  idle(): Promise<void>;
  /** Interrupt the task being built, commit what it did, and leave no CLI process behind. Tasks still queued are marked interrupted. */
  close(): Promise<void>;
}

export interface TasksOptions {
  db: DatabaseSync;
  /** Smelt's data directory; worktrees go under it. */
  home: string;
  driver: Driver;
  /** Where the attempt's permission requests go to wait for the owner. */
  broker: Broker;
  model?: string;
  /** Called when a transcript event was stored. */
  onEvent: () => void;
  /** Called after each state a task reaches. */
  onTaskChange: (task: Task) => void;
}

/**
 * Builds tasks, one at a time. A task is one implementer turn in its own
 * worktree: Smelt makes the worktree from the repository's current commit,
 * starts an attempt there that may edit files in it and must ask the owner,
 * through the broker, for everything else, sends the prompt, and when the turn
 * ends commits everything to the task branch itself, however the turn ended.
 */
export function createTasks(options: TasksOptions): Tasks {
  const { db, home, driver, broker } = options;
  let closed = false;
  let current: DriverSession | null = null;

  const report = (what: string) => (err: unknown): void => console.error(`${what} failed: ${words(err)}`);

  const move = (id: number, to: TaskStatus, change?: TaskChange): Task => {
    const task = moveTask(db, id, to, change);
    options.onTaskChange(task);
    return task;
  };

  /** Commit whatever is in the task's worktree and move the task to where its turn left it. */
  const finish = async (task: Task, to: TaskStatus, reason?: string): Promise<void> => {
    let headCommit: string;
    try {
      await commitWork({ path: task.worktreePath!, message: `Smelt task ${task.id}: ${firstLine(task.prompt)}` });
      headCommit = (await describeWork({ path: task.worktreePath!, baseCommit: task.baseCommit! })).headCommit;
    } catch (err) {
      // The files are still in the worktree; the task says what happened to it and why they are not committed.
      move(task.id, "failed", { reason: `${reason ? `${reason} ` : ""}The work could not be committed: ${words(err)}` });
      return;
    }
    move(task.id, to, { headCommit, ...(reason === undefined ? {} : { reason }) });
  };

  const build = async (id: number): Promise<void> => {
    const queued = getTask(db, id)!;
    if (closed) return void move(id, "interrupted", { reason: "Smelt stopped before this task started." });

    let worktree: Worktree;
    try {
      // The run id stands for this task's own single-task run until runs exist.
      worktree = await createWorktree({ repo: queued.repo, home, run: `run-${randomBytes(4).toString("hex")}`, task: `task-${id}` });
    } catch (err) {
      return void move(id, "failed", { reason: `The task's worktree could not be created: ${words(err)}` });
    }
    const task = move(id, "building", { worktree });

    // The attempt's own way to the permission gate. It is released whichever way the build ends.
    const admission = broker.admit({ taskId: id, role: IMPLEMENTER, worktree: worktree.path });
    let session: DriverSession;
    try {
      if (closed) throw new Error("Smelt is stopping.");
      session = await driver.startAttempt({ db, cwd: worktree.path, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, ...(options.model ? { model: options.model } : {}) });
    } catch (err) {
      admission.release();
      // Nothing happened in the worktree, so it and its branch go again.
      const reason = await removeWorktree({ repo: task.repo, path: worktree.path, deleteBranch: true }).then(
        () => words(err),
        (removal: unknown) => `${words(err)} The unused worktree at ${worktree.path} could not be removed: ${words(removal)}`,
      );
      return void move(id, closed ? "interrupted" : "failed", { reason });
    }

    current = session;
    admission.bind(session.attemptId);
    let detail: string | null = null;
    /** Permission requests the CLI is still waiting on, by request id. */
    const asking = new Set<string>();
    session.onEvent((event) => {
      if (event.type === "turn_ended") detail = event.detail;
      if (event.type === "permission_request") {
        asking.add(event.id);
        // The broker never rejects: whatever fails on the way to the owner comes back as a decline.
        void broker
          .request({ taskId: id, attemptId: session.attemptId, role: IMPLEMENTER, tool: event.name, command: summarize(event.name, event.input), reason: event.reason, toolCallId: event.toolCallId })
          // A request the CLI has stopped waiting for has no one to tell.
          .then((answer) => (asking.has(event.id) ? session.respondToRequest(event.id, { decision: answer.decision, note: answer.note, refused: answer.refused }) : undefined))
          .catch(report(`Answering a permission request of task ${id}`));
      }
      if (event.type === "permission_resolved") {
        asking.delete(event.id);
        // The CLI gave up on the request (the turn was stopped): its card must not stay answerable.
        if (event.decision === "cancelled") admission.supersede(event.toolCallId);
      }
      options.onEvent();
    });
    move(id, "building", { attemptId: session.attemptId });
    let end: TurnEndReason | "not sent";
    try {
      // Smelt began stopping while the attempt was starting: the turn is not sent.
      end = closed ? "not sent" : await session.sendTurn(task.prompt);
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
    admission.release();
    options.onEvent();

    // However the turn ended, what it wrote is committed and the task says where it stands.
    if (leftover !== null) await finish(task, "failed", leftover);
    else if (end === "completed") await finish(task, "awaiting_decision");
    else if (end === "not sent") await finish(task, "interrupted", "Smelt stopped before the prompt was sent.");
    else if (end === "interrupted") await finish(task, "interrupted", "The turn was stopped before it finished. The work done up to then is committed.");
    else await finish(task, "failed", `The turn ended with an error${detail === null ? "." : `: ${detail}`}`);
  };

  /** A Smelt that stopped without warning leaves tasks at stations nothing is working at. Say so, and keep their work. */
  const recover = async (): Promise<void> => {
    const stale = db.prepare("SELECT id FROM tasks WHERE status IN ('queued', 'building') ORDER BY id").all();
    for (const row of stale) {
      const task = getTask(db, Number(row.id))!;
      const reason = "Smelt stopped while this task was on its way.";
      if (task.worktreePath === null) move(task.id, "interrupted", { reason });
      else await finish(task, "interrupted", `${reason} The work done up to then is committed.`);
    }
  };

  // One chain: recovery first, then each task in the order it was started.
  let chain: Promise<void> = recover().catch(report("Recovering tasks"));

  const start = async (repo: unknown, prompt: string): Promise<Task> => {
    if (closed) throw new TaskError(503, "Smelt is shutting down.");
    const checked = await checkRepository(repo);
    if (closed) throw new TaskError(503, "Smelt is shutting down.");
    const task = createTask(db, { repo: checked, prompt });
    options.onTaskChange(task);
    chain = chain.then(() => build(task.id)).catch(report(`Building task ${task.id}`));
    return task;
  };

  const close = async (): Promise<void> => {
    closed = true;
    // Ends the running turn as interrupted; the build then commits and records it. The build reports a
    // process that would not stop, and the chain is always waited for: the database closes after this.
    await current?.close().catch(() => {});
    await chain;
  };

  return { start, idle: () => chain, close };
}
