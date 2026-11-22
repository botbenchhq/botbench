import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingApprovals, waitingOnApproval, type Admission, type Broker } from "../approvals/broker.ts";
import { summarize } from "../approvals/gate.ts";
import { insertPreapproved, realRepo } from "../approvals/grants.ts";
import type { Driver, DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";
import { now, transaction } from "../store/db.ts";
import { commitWork, createWorktree, describeWork, removeWorktree, sourceHead, type Worktree } from "../worktrees.ts";
import { RESUME_PROMPT, resumeProblem, stopSurvivor } from "./recover.ts";

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
    requestedModel: text(row.requested_model),
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

/**
 * Store a new task as queued, as a run of its own. The row, the grants for the commands the owner pre-approved for
 * that run, and the task's first event are written together: none exists without the others.
 * Throws for a pre-approved command that cannot be a grant, and then nothing is written.
 */
export function createTask(db: DatabaseSync, o: { repo: string; prompt: string; requestedModel?: string | null; preapproved?: readonly string[] }): Task {
  return transaction(db, () => {
    const at = now();
    // Runs have no table of their own yet: a new run takes the next number after the highest in use.
    const runId = Number(db.prepare("SELECT COALESCE(MAX(run_id), 0) + 1 AS next FROM tasks").get()!.next);
    // The repository is kept by its real path as it is now. Grants and counts compare this stored path, so a link
    // that is pointed elsewhere later does not carry one repository's trust to another.
    const repo = realRepo(o.repo);
    const id = Number(db.prepare("INSERT INTO tasks (run_id, repo_path, prompt, requested_model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(runId, repo, o.prompt, o.requestedModel ?? null, at, at).lastInsertRowid);
    insertPreapproved(db, { role: IMPLEMENTER, repo, runId, taskId: id, commands: o.preapproved ?? [] });
    insertEvent(db, id, at, "queued", null);
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
    if (change.note !== undefined) details.unshift(change.note);
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
  /**
   * Check the repository, store the task as queued and return it at once. The build goes on in the background.
   * `model` is the model asked for: a name, null for the CLI's own default, or left out for the configured one.
   * `preapproved` are the commands the owner lets this task's run use without asking; each must be one plain command.
   */
  start(repo: unknown, prompt: string, model?: string | null, preapproved?: readonly string[]): Promise<Task>;
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
  /** Set while a turn runs: called when Smelt begins to stop, it decides whether that turn's task is parked. */
  let parkCurrent: (() => void) | null = null;
  /** When this engine began. What the store holds from before it is the last run's. */
  const began = now();

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
      session = await driver.startAttempt({ db, cwd: worktree.path, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      // Nothing happened in the worktree, so it and its branch go again.
      const reason = await removeWorktree({ repo: task.repo, path: worktree.path, deleteBranch: true }).then(
        () => words(err),
        (removal: unknown) => `${words(err)} The unused worktree at ${worktree.path} could not be removed: ${words(removal)}`,
      );
      return void move(id, closed ? "interrupted" : "failed", { reason });
    }

    await drive(task, session, admission, task.prompt, false);
  };

  /**
   * Run one turn of a task's attempt to its end and record where that leaves the task. `resumed` is true for the
   * turn that re-drives a task after a restart. If Smelt is stopped while the turn waits for the owner, the task
   * is parked: its approvals stay pending and it stays at `building` for the next start to find.
   */
  const drive = async (task: Task, session: DriverSession, admission: Admission, prompt: string, resumed: boolean): Promise<void> => {
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
        // Smelt itself that is stopping, the request is kept for the owner instead.
        if (event.decision === "cancelled" && !parking) admission.supersede(event.toolCallId);
      }
      options.onEvent();
    });
    move(id, "building", { attemptId: session.attemptId, ...(resumed ? { note: `resumed after a restart, from attempt ${task.attemptId}` } : {}) });
    let end: TurnEndReason | "not sent";
    try {
      // Smelt began stopping while the attempt was starting: the turn is not sent.
      end = closed ? "not sent" : await session.sendTurn(prompt);
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
    // Parked only if the owner's answer is still outstanding now: it may have come in while Smelt was stopping.
    if (parking && leftover === null && end === "interrupted" && waitingOnApproval(db, id)) {
      // Smelt is stopping while the owner's answer is outstanding. Nothing is committed and nothing ends: the next start finds it.
      admission.park();
      options.onEvent();
      return void move(id, "building", { note: "Smelt stopped while this task waited for the owner's answer; the request is kept for the next start" });
    }
    admission.release();
    options.onEvent();

    // However the turn ended, what it wrote is committed and the task says where it stands.
    if (leftover !== null) await finish(task, "failed", leftover);
    else if (end === "completed") await finish(task, "awaiting_decision");
    else if (end === "not sent") await finish(task, "interrupted", "Smelt stopped before the prompt was sent.");
    else if (end === "interrupted") await finish(task, "interrupted", "The turn was stopped before it finished. The work done up to then is committed.");
    // Nothing came of the session at all: the CLI did not take it up again.
    else if (resumed && !sessionStarted) await finish(task, "interrupted", `Claude Code could not resume the session this task was working in${detail === null ? "." : `: ${detail}`} Your answer was not applied and nothing was run. The work done up to then is committed.`);
    else await finish(task, "failed", `The turn ended with an error${detail === null ? "." : `: ${detail}`}`);
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
    const task = getTask(db, id);
    if (!task) return;
    const parked = pendingApprovals(db, id);
    if (parked.length === 0) return;
    if (task.status !== "building") return broker.endParked(id, `Its task is ${task.status}, so there is nothing to resume.`);
    // Other requests of the task still wait for the owner: it is resumed when all of them are answered.
    if (parked.some((approval) => approval.storedDecision === null)) return;
    // Smelt is stopping: the next start says what became of the answer.
    if (closed) return;
    const problem = (await stopSurvivors(task, parked)) ?? resumeProblem(db, task, parked, driver.capabilities);
    if (problem !== null) return giveUp(task, `This task waited for your answer across a restart and cannot be resumed: ${problem} Your answer was not applied and nothing was run.`);

    // The model stays the one the task was started with, whatever is configured by now.
    const previous = task.attemptId!;
    const resumeCursor = String(db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(previous)!.resume_cursor);
    const admission = broker.admit({ taskId: id, role: IMPLEMENTER, worktree: task.worktreePath!, resumes: previous });
    let session: DriverSession;
    try {
      session = await driver.startAttempt({ db, cwd: task.worktreePath!, allowEdits: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, resumeCursor, ...(task.requestedModel === null ? {} : { model: task.requestedModel }) });
    } catch (err) {
      admission.release();
      return giveUp(task, `Claude Code could not be started again to resume this task: ${words(err)} Your answer was not applied and nothing was run.`);
    }
    await drive(task, session, admission, RESUME_PROMPT, true);
  };

  /**
   * A Smelt that stopped leaves tasks at stations nothing is working at. One that was waiting for the owner is
   * parked: whatever is left of its CLI process is stopped, and it stays where it is until the owner answers.
   * Every other one is marked interrupted, with its work kept. Say so in each case.
   */
  const recover = async (): Promise<void> => {
    // A CLI process of the last run that is recorded on no task (Smelt stopped between starting it and writing it down) is stopped too.
    for (const row of db.prepare("SELECT id FROM attempts WHERE pgid IS NOT NULL AND created_at < ? ORDER BY id").all(began)) {
      await stopSurvivor(db, Number(row.id)).catch(report(`Stopping the process left by attempt ${row.id}`));
    }
    const stale = db.prepare("SELECT id FROM tasks WHERE status IN ('queued', 'building') ORDER BY id").all();
    for (const row of stale) {
      const task = getTask(db, Number(row.id))!;
      const parked = pendingApprovals(db, task.id);
      if (parked.length > 0) {
        // An answer the last run stored and did not get to apply is not carried into this one. One stored since this
        // start (the owner was quick) is not that: its task is resumed in its turn.
        const unapplied = db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'pending' AND stored_decision IS NOT NULL AND stored_at < ? LIMIT 1").get(task.id, began) !== undefined;
        const problem =
          (await stopSurvivors(task, parked)) ??
          (unapplied ? "Smelt stopped after you answered and before the answer could be given to the agent. Your answer was not applied." : resumeProblem(db, task, parked, driver.capabilities));
        if (problem === null) {
          move(task.id, "building", { note: "parked across a restart: waiting for the owner's answer to a request made before it" });
          continue;
        }
        await giveUp(task, `Smelt stopped while this task waited for your answer, and it cannot be resumed: ${problem} The request was closed and nothing was run.`);
        continue;
      }
      const reason = "Smelt stopped while this task was on its way.";
      if (task.worktreePath === null) move(task.id, "interrupted", { reason });
      else await finish(task, "interrupted", `${reason} The work done up to then is committed.`);
    }
    // A pending approval whose task is at no station where it could be resumed has nobody to answer to.
    for (const row of db.prepare("SELECT DISTINCT a.task_id AS id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.status = 'pending' AND t.status <> 'building'").all()) {
      broker.endParked(Number(row.id), "Its task was no longer being built when Smelt started.");
    }
  };

  // One chain: recovery first, then each task in the order it was started.
  let chain: Promise<void> = recover().catch(report("Recovering tasks"));

  // An answer stored for a parked approval re-drives its task, in its turn like any other work.
  broker.onStoredAnswer((approval) => {
    chain = chain.then(() => redrive(approval.taskId)).catch(report(`Resuming task ${approval.taskId}`));
  });

  const start = async (repo: unknown, prompt: string, model?: string | null, preapproved?: readonly string[]): Promise<Task> => {
    if (closed) throw new TaskError(503, "Smelt is shutting down.");
    const checked = await checkRepository(repo);
    if (closed) throw new TaskError(503, "Smelt is shutting down.");
    const task = createTask(db, { repo: checked, prompt, requestedModel: model === undefined ? (options.model ?? null) : model, ...(preapproved ? { preapproved } : {}) });
    options.onTaskChange(task);
    chain = chain.then(() => build(task.id)).catch(report(`Building task ${task.id}`));
    return task;
  };

  const close = async (): Promise<void> => {
    closed = true;
    // A task that is waiting for the owner right now is parked, not ended: its approvals stay for the next start.
    parkCurrent?.();
    // Ends the running turn as interrupted; the build then commits and records it, or parks it. The build reports a
    // process that would not stop, and the chain is always waited for: the database closes after this.
    await current?.close().catch(() => {});
    await chain;
  };

  return { start, idle: () => chain, close };
}
