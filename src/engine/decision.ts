import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendLog } from "../approvals/broker.ts";
import { now, transaction } from "../store/db.ts";
import { branchCheckedOutAt, branchCommit, deleteTaskBranch, forgetMissingWorktree, leftoverFiles, removeWorktree } from "../worktrees.ts";
import { getTask, moveTaskIn, settleRunIn, TaskError, words, type Task, type TaskStatus } from "./task.ts";

/*
 * Decisions (unit 14). The owner closes a task that is ready for review by accepting or rejecting it, and Botbench
 * records it. Accept keeps the task's branch and removes its copy (the git worktree); Reject removes the copy and keeps
 * or deletes the branch, as the owner chose. Nothing is ever merged or pushed. A decision is a row of `decisions`,
 * written once and never changed, beside an entry in the action log, and the task moves to accepted or rejected with
 * it. A planned run whose tasks are all at an end is done once none of them is left to decide.
 *
 * The checks run after Botbench committed the work, and may leave files in the copy. Those are not on the branch, and
 * removing the copy removes them, so a decision is refused while there are any, until the owner confirms they may go.
 * Files git ignores (node_modules and the like) are not counted: they are never work.
 */

export type DecisionKind = "accept" | "reject";

/** One decision as it was recorded. */
export interface TaskDecision {
  id: number;
  taskId: number;
  decision: DecisionKind;
  /** What became of the task's branch. */
  branch: "kept" | "deleted";
  branchName: string;
  /** The commit Botbench made, which the branch held when the decision was made. */
  headCommit: string | null;
  /** The files the checks left in the copy, removed with it once the owner confirmed. */
  leftovers: string[];
  decidedBy: "owner";
  decidedAt: string;
}

/** A decision refused because the checks left files in the task's copy that the owner has not agreed to remove. */
export class LeftoversError extends TaskError {
  readonly leftovers: string[];
  constructor(leftovers: string[], what = "These files were left by the checks and are not on the branch") {
    super(409, `${what}: ${listed(leftovers)}. They go when the task's copy is removed. Confirm that they may go, or copy them out of the task's copy first.`);
    this.leftovers = leftovers;
  }
}

/** Files named in a sentence: the first 20, and how many more. The full list is in the answer and on the decision. */
const listed = (files: readonly string[]): string => (files.length <= 20 ? files.join(", ") : `${files.slice(0, 20).join(", ")} and ${files.length - 20} more`);

function toDecision(row: Record<string, unknown>): TaskDecision {
  let leftovers: unknown;
  try {
    leftovers = JSON.parse(String(row.leftovers));
  } catch {
    leftovers = [];
  }
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    decision: String(row.decision) as DecisionKind,
    branch: String(row.branch) as TaskDecision["branch"],
    branchName: String(row.branch_name),
    headCommit: typeof row.head_commit === "string" ? row.head_commit : null,
    leftovers: Array.isArray(leftovers) ? leftovers.filter((f): f is string => typeof f === "string") : [],
    decidedBy: "owner",
    decidedAt: String(row.decided_at),
  };
}

/** The decision made on a task, or null when it has none. */
export function taskDecision(db: DatabaseSync, taskId: number): TaskDecision | null {
  const row = db.prepare("SELECT * FROM decisions WHERE task_id = ?").get(taskId);
  return row ? toDecision(row) : null;
}

/** The files the checks left in a task's copy that are not on its branch, for a task that is ready for review; null for any other. */
export async function taskLeftovers(task: Task): Promise<string[] | null> {
  if (task.status !== "awaiting_decision" || task.worktreePath === null) return null;
  return leftoverFiles(task.worktreePath);
}

/** What a task that is not ready for review is, in words for the owner. */
const NOT_READY: Record<Exclude<TaskStatus, "awaiting_decision" | "accepted" | "rejected">, string> = {
  queued: "is queued",
  building: "is still being built",
  verifying: "is still being checked",
  interrupted: "was stopped",
  failed: "failed",
  cancelled: "was cancelled",
};

function ready(task: Task): void {
  if (task.status === "awaiting_decision") return;
  if (task.status === "accepted" || task.status === "rejected") throw new TaskError(409, `Task ${task.id} was already ${task.status}, and a decision is made once.`);
  throw new TaskError(409, `Task ${task.id} is not ready for review: it ${NOT_READY[task.status]}. Only a task that is ready for review can be accepted or rejected.`);
}

/** Tasks a decision is being made for now, so two at once for one task cannot both remove its copy. */
const deciding = new Set<number>();
/** Whether a decision or a discard of the task is being made now: nothing else may start on it meanwhile. */
export const beingDecided = (taskId: number): boolean => deciding.has(taskId);

export interface DecideInput {
  taskId: number;
  /** "accept" or "reject". */
  decision: unknown;
  /** For a reject: "keep" or "discard" the branch. An accept keeps it. */
  branch?: unknown;
  /**
   * The files the checks left, exactly as the owner saw and confirmed them, which may then be removed with the copy.
   * The decision is refused when the files in the copy are not exactly these.
   */
  removeLeftovers?: unknown;
}

/**
 * Make the owner's decision on a task that is ready for review: remove its copy, delete its branch for a reject that
 * discards it, then record the decision, the task's new state, the log entry and the run's end in one write. Throws a
 * TaskError, with nothing changed, for a decision that is malformed, a task that is not ready for review, and files the
 * checks left that the owner has not confirmed. `run` is the task's run when the decision ended it.
 */
export async function decideTask(db: DatabaseSync, input: DecideInput): Promise<{ task: Task; run: { id: number; status: string } | null }> {
  const { decision, branch, removeLeftovers } = input;
  if (decision !== "accept" && decision !== "reject") throw new TaskError(400, 'Say whether to accept or reject the task: "decision" is "accept" or "reject".');
  if (decision === "reject" && branch !== "keep" && branch !== "discard") throw new TaskError(400, 'Say whether to keep or discard the task\'s branch when rejecting it: "branch" is "keep" or "discard".');
  if (decision === "accept" && branch !== undefined && branch !== "keep") throw new TaskError(400, "An accepted task keeps its branch. To delete the branch, reject the task instead.");
  if (removeLeftovers !== undefined && !(Array.isArray(removeLeftovers) && removeLeftovers.length <= 100_000 && removeLeftovers.every((f) => typeof f === "string"))) throw new TaskError(400, '"removeLeftovers" must be the list of files the owner confirmed may be removed with the task\'s copy.');
  const task = getTask(db, input.taskId);
  if (!task) throw new TaskError(404, "No such task.");
  ready(task);
  if (deciding.has(task.id)) throw new TaskError(409, `A decision on task ${task.id} is being made already.`);
  deciding.add(task.id);
  try {
    return await decide(db, task, decision, decision === "reject" && branch === "discard", (removeLeftovers as string[] | undefined) ?? []);
  } finally {
    deciding.delete(task.id);
  }
}

async function decide(db: DatabaseSync, task: Task, decision: DecisionKind, discard: boolean, confirmed: readonly string[]): Promise<{ task: Task; run: { id: number; status: string } | null }> {
  const dir = task.worktreePath!;
  const branch = task.branch!;
  // A copy that is already gone (removed by hand, or by a decision that failed after removing it) holds nothing to keep.
  const present = fs.existsSync(dir);
  let leftovers: string[];
  try {
    leftovers = present ? await leftoverFiles(dir) : [];
  } catch (err) {
    throw new TaskError(409, `The task's copy at ${dir} could not be read, so nothing was decided: ${words(err)}`);
  }
  // Removed only when they are exactly the files the owner was shown: one that appeared since is listed again first.
  const same = leftovers.length === confirmed.length && leftovers.every((file) => confirmed.includes(file));
  if (leftovers.length > 0 && !same) throw new LeftoversError(leftovers);

  // Everything that could refuse is checked before anything is removed, so a refused decision changes nothing.
  let at: string | null;
  try {
    at = await branchCommit(task.repo, branch);
  } catch (err) {
    throw new TaskError(409, `The branch ${branch} could not be read, so nothing was decided: ${words(err)}`);
  }
  if (discard) {
    // The branch is deleted only while it holds just what Botbench committed: a commit somebody else added stays.
    if (at !== null && at !== task.headCommit) throw new TaskError(409, `The branch ${branch} has commits Botbench did not make, so it was not deleted and nothing was decided. Reject the task and keep the branch, or remove those commits first.`);
    // The task's own copy, whose removal comes first, is not elsewhere, whether its folder is there or not.
    const own = new Set([dir]);
    try {
      own.add(path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir)));
    } catch {
      // Its parent folder is gone too: the stored path is the only name it has.
    }
    const elsewhere = at === null ? [] : (await branchCheckedOutAt(task.repo, branch)).filter((where) => !own.has(where));
    if (elsewhere.length > 0) throw new TaskError(409, `The branch ${branch} is checked out at ${elsewhere.join(", ")}, so it cannot be deleted and nothing was decided. Switch that folder to another branch first, or reject the task and keep the branch.`);
  } else if (at === null) {
    throw new TaskError(409, `The branch ${branch} is not in the repository any more, so there is no branch to keep and nothing was decided. Reject the task and delete the branch instead.`);
  }

  try {
    if (present) await removeWorktree({ repo: task.repo, path: dir, deleteBranch: false, removeLeftovers: leftovers.length > 0 });
    else await forgetMissingWorktree({ repo: task.repo, path: dir });
  } catch (err) {
    throw new TaskError(409, `The task's copy at ${dir} could not be removed, so nothing was decided: ${words(err)}`);
  }
  if (discard) {
    try {
      await deleteTaskBranch({ repo: task.repo, branch, commit: task.headCommit! });
    } catch (err) {
      throw new TaskError(409, `The task's copy was removed, but its branch ${branch} could not be deleted, so nothing was decided yet: ${words(err)} Reject it again to try once more.`);
    }
  }

  const kept = discard ? "deleted" : "kept";
  const copy = present ? "removed the task's copy" : "found the task's copy already gone";
  const files = leftovers.length === 0 ? "" : ` The copy held ${leftovers.length === 1 ? "1 file" : `${leftovers.length} files`} the checks left, removed with it as you confirmed: ${listed(leftovers)}.`;
  const detail = `${discard ? "Deleted" : "Kept"} the branch ${branch} and ${copy}. Nothing was merged or pushed.${files}`;
  return transaction(db, () => {
    const now_ = getTask(db, task.id)!;
    ready(now_);
    // The commit the kept branch holds now: Botbench's, or one the owner added on top of it.
    db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at) VALUES (?, 'owner', ?, ?, ?, ?, ?, ?)").run(task.id, decision, kept, branch, discard ? task.headCommit : at, JSON.stringify(leftovers), now());
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    const decided = moveTaskIn(db, task.id, decision === "accept" ? "accepted" : "rejected", { note: `${decision === "accept" ? "accepted" : "rejected"} by the owner; branch ${kept}${leftovers.length > 0 ? `; ${leftovers.length} leftover files removed with the worktree` : ""}` });
    appendLog(db, { taskId: task.id, runId: task.runId, attemptId: task.attemptId, rule: decision === "accept" ? "owner_accepted" : "owner_rejected", tool: "Branch", command: branch, cwd: task.repo, detail });
    return { task: decided, run: task.runId === null ? null : settleRunIn(db, task.runId) };
  });
}

/*
 * Discards (unit 16). A task that failed, was stopped or was cancelled was never ready for review, so nothing about it is
 * decided; but its copy of the project and Botbench's branch for it may still be there. Discard removes both, under the
 * same safety rules as a Reject that deletes the branch: the branch goes only while it holds just what Botbench put on
 * it, never while it is checked out anywhere else, and files in the copy that are not on the branch go only once the
 * owner has seen and confirmed exactly those. The task keeps its state and its reason; the discard is an entry in the
 * action log, which also says it happened.
 */

/** The states a task ends in without ever being ready for review. */
const ENDED_UNREVIEWED: ReadonlySet<TaskStatus> = new Set(["failed", "interrupted", "cancelled"]);

/** The rule a discard is logged under. */
const DISCARDED = "owner_discarded" as const;

/** When the owner discarded what the task left, from the action log; null when they have not. */
function discardedAt(db: DatabaseSync, taskId: number): string | null {
  const row = db.prepare("SELECT ts FROM action_log WHERE task_id = ? AND rule = ? ORDER BY id LIMIT 1").get(taskId, DISCARDED);
  return row ? String(row.ts) : null;
}

/** What a task that ended without being ready for review still has: its copy, Botbench's branch, and the files in the copy not on the branch. */
export interface TaskRemains {
  copy: boolean;
  branch: boolean;
  files: string[];
  /** When the owner discarded them; null when they have not. */
  discardedAt: string | null;
}

/**
 * What a task that failed, was stopped or was cancelled left behind, read from the disk and the repository as they are
 * now; null for a task in any other state. Rejects when the copy or the branch cannot be read.
 */
export async function taskRemains(db: DatabaseSync, task: Task): Promise<TaskRemains | null> {
  if (!ENDED_UNREVIEWED.has(task.status)) return null;
  const copy = task.worktreePath !== null && fs.existsSync(task.worktreePath);
  const branch = task.branch !== null && (await branchCommit(task.repo, task.branch)) !== null;
  return { copy, branch, files: copy ? await leftoverFiles(task.worktreePath!) : [], discardedAt: discardedAt(db, task.id) };
}

export interface DiscardInput {
  taskId: number;
  /** The files in the copy that are not on the branch, exactly as the owner saw and confirmed them. */
  removeFiles?: unknown;
}

/**
 * Remove the copy and Botbench's branch of a task that failed, was stopped or was cancelled, and log it. Throws a
 * TaskError, with nothing changed, for a task in another state, one with nothing left, a branch with commits Botbench
 * did not make or checked out elsewhere, and files in the copy the owner has not confirmed.
 */
export async function discardTask(db: DatabaseSync, input: DiscardInput): Promise<Task> {
  const { removeFiles } = input;
  if (removeFiles !== undefined && !(Array.isArray(removeFiles) && removeFiles.length <= 100_000 && removeFiles.every((f) => typeof f === "string"))) throw new TaskError(400, '"removeFiles" must be the list of files the owner confirmed may be removed with the task\'s copy.');
  const task = getTask(db, input.taskId);
  if (!task) throw new TaskError(404, "No such task.");
  if (task.status === "awaiting_decision") throw new TaskError(409, `Task ${task.id} is ready for review: accept or reject it instead.`);
  if (task.status === "accepted" || task.status === "rejected") throw new TaskError(409, `Task ${task.id} was already ${task.status}, and its copy was removed then.`);
  if (!ENDED_UNREVIEWED.has(task.status)) throw new TaskError(409, `Task ${task.id} ${NOT_READY[task.status as keyof typeof NOT_READY]}. Only a task that failed, was stopped or was cancelled can be discarded.`);
  if (deciding.has(task.id)) throw new TaskError(409, `Task ${task.id} is being discarded already.`);
  deciding.add(task.id);
  try {
    return await discard(db, task, (removeFiles as string[] | undefined) ?? []);
  } finally {
    deciding.delete(task.id);
  }
}

async function discard(db: DatabaseSync, task: Task, confirmed: readonly string[]): Promise<Task> {
  const dir = task.worktreePath;
  const branch = task.branch;
  const present = dir !== null && fs.existsSync(dir);
  let at: string | null;
  let files: string[];
  try {
    at = branch === null ? null : await branchCommit(task.repo, branch);
    files = present ? await leftoverFiles(dir) : [];
  } catch (err) {
    throw new TaskError(409, `The task's copy or its branch could not be read, so nothing was discarded: ${words(err)}`);
  }
  if (!present && at === null) throw new TaskError(409, `Task ${task.id} has nothing left to discard: its copy of the project and its branch are not there.`);
  const same = files.length === confirmed.length && files.every((file) => confirmed.includes(file));
  if (files.length > 0 && !same) throw new LeftoversError(files, "These files are in the task's copy and are not on the branch");

  // Everything that could refuse is checked before anything is removed, so a refused discard changes nothing.
  if (at !== null) {
    // What Botbench put on the branch: its own commit, or, before it committed anything, the commit the branch started from.
    const ours = task.headCommit ?? task.baseCommit;
    if (at !== ours) throw new TaskError(409, `The branch ${branch} has commits Botbench did not make, so nothing was discarded. Remove those commits first, or keep the branch.`);
    const own = new Set(dir === null ? [] : [dir]);
    if (dir !== null) {
      try {
        own.add(path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir)));
      } catch {
        // Its parent folder is gone too: the stored path is the only name it has.
      }
    }
    const elsewhere = (await branchCheckedOutAt(task.repo, branch!)).filter((where) => !own.has(where));
    if (elsewhere.length > 0) throw new TaskError(409, `The branch ${branch} is checked out at ${elsewhere.join(", ")}, so nothing was discarded. Switch that folder to another branch first.`);
  }

  if (dir !== null) {
    try {
      if (present) await removeWorktree({ repo: task.repo, path: dir, deleteBranch: false, removeLeftovers: files.length > 0 });
      else await forgetMissingWorktree({ repo: task.repo, path: dir });
    } catch (err) {
      throw new TaskError(409, `The task's copy at ${dir} could not be removed, so nothing was discarded: ${words(err)}`);
    }
  }
  const copy = dir === null ? "" : present ? "removed the task's copy" : "found the task's copy already gone";
  const kept = files.length === 0 ? "" : ` The copy held ${files.length === 1 ? "1 file" : `${files.length} files`} not on the branch, removed with it as you confirmed: ${listed(files)}.`;
  const log = (detail: string): void => appendLog(db, { taskId: task.id, runId: task.runId, attemptId: task.attemptId, rule: DISCARDED, tool: "Branch", command: branch ?? "", cwd: task.repo, detail });
  if (at !== null) {
    try {
      await deleteTaskBranch({ repo: task.repo, branch: branch!, commit: at });
    } catch (err) {
      // The copy, and the files the owner confirmed, are gone already: that is logged before the refusal says the rest.
      if (copy !== "") log(`${copy[0]!.toUpperCase()}${copy.slice(1)}, but the branch ${branch} could not be deleted: ${words(err)}${kept}`);
      throw new TaskError(409, `The task's copy was removed, but its branch ${branch} could not be deleted: ${words(err)} Discard it again to try once more.`);
    }
  }
  log(`${at === null ? "Found the branch already gone" : `Deleted the branch ${branch}`}${copy === "" ? "" : ` and ${copy}`}. Nothing was merged or pushed.${kept}`);
  return getTask(db, task.id)!;
}
