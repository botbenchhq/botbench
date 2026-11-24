import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendLog } from "../approvals/broker.ts";
import { now, transaction } from "../store/db.ts";
import { isOwnBranch, lessonBranch, notOwnWords, workbenchName } from "../workbench.ts";
import { branchCheckedOutAt, branchCommit, deleteTaskBranch, forgetMissingWorktree, leftoverFiles, removeWorktree } from "../worktrees.ts";
import { evidenceState, noChecksWords, shortCommit, type EvidenceState } from "./evidence.ts";
import { recordLearning, type KeptLearning } from "./learnings.ts";
import { MAX_TITLE } from "./roles.ts";
import { listed } from "./scope.ts";
import { getTask, moveTaskIn, settleRunIn, TaskError, words, type Task, type TaskStatus } from "./task.ts";

/*
 * Decisions (unit 14). The owner closes a task that is ready for review by accepting or rejecting it, and Botbench
 * records it. Accept keeps the task's branch and removes its copy (the git worktree); Reject removes the copy and keeps
 * or deletes the branch, as the owner chose. Nothing is ever merged; an accepted task of a run that chose pull requests is
 * then pushed and opened as one (src/engine/delivery.ts), after the decision and apart from it. A decision is a row of `decisions`,
 * written once and never changed, beside an entry in the action log, and the task moves to accepted or rejected with
 * it. A planned run whose tasks are all at an end is done once none of them is left to decide.
 *
 * An accept is made only on evidence that is about the commit accepted (engine/evidence.ts): the checks ran on the
 * commit the branch holds and the task's copy holds no file that differs from it. Out-of-date checks, and a copy with a
 * changed tracked file or an untracked file git does not ignore, refuse the accept, the owner's and the mode's alike.
 * Checks that failed on that commit do not: the owner may still accept, and the decision records them as failed. Work
 * no check ran on is accepted only when the request says so ("accept without verification"), and is recorded as that.
 * What stood behind an accept is kept with it: `checks` and the commit they ran on, which is the commit accepted.
 *
 * A reject is always allowed. The checks run after Botbench committed the work, and may leave files in the copy. Those
 * are not on the branch, and removing the copy removes them, so a reject is refused while there are any, until the
 * owner confirms they may go. Files git ignores (node_modules and the like) are not counted: they are never work; an
 * accept names them in its log entry.
 *
 * A fully autonomous run accepts a task without the owner when it qualifies (engine/modes.ts): the same accept, made
 * by the mode, which the decision records as its maker with the reasons it qualified, and only on checks that passed
 * on the commit Botbench made. It is never a reject.
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
  /** The owner, or the run's mode: a fully autonomous run's accept. */
  decidedBy: "owner" | "mode";
  /** Why the mode accepted, in words for the owner; null for the owner's own decision. */
  reasons: string | null;
  /** The owner's own short note, given with the decision; null when none was, and always for the mode's accept. */
  note: string | null;
  /**
   * For an accept: what its checks had found on the commit accepted ("passed" or "failed"), or "none" for an accept
   * without verification. Null for a reject, and for a decision from before this was recorded: never read as verified.
   */
  checks: "passed" | "failed" | "none" | null;
  /** The commit those checks ran on, which is the commit accepted; null when `checks` is "none" or null. */
  checksCommit: string | null;
  decidedAt: string;
}

/** The longest note a decision carries: a short reason, read beside the decision and in Activity. */
export const MAX_DECISION_NOTE = 500;

/** The note a request gives, trimmed, or null for none. Throws a TaskError for one that is not short plain text on one line. */
export function decisionNote(given: unknown): string | null {
  if (given === undefined || given === null) return null;
  const rule = `A note is plain text on one line, at most ${MAX_DECISION_NOTE} characters.`;
  if (typeof given !== "string") throw new TaskError(400, `The note was not sent as text. ${rule}`);
  const note = given.trim();
  // What a screen would fold or hide is refused here, so the note shown is the note given.
  if (note.length > MAX_DECISION_NOTE || /[\0-\x1f\x7f\u2028\u2029]/.test(note)) throw new TaskError(400, `The note was not accepted. ${rule}`);
  return note === "" ? null : note;
}

/**
 * An accept refused because of the state of the task's evidence (engine/evidence.ts): out of date, a copy that differs
 * from the commit, or no checks and no word that it is accepted without verification. `evidence` is that state.
 */
export class EvidenceError extends TaskError {
  readonly evidence: EvidenceState;
  constructor(evidence: EvidenceState, message: string = evidence.words) {
    super(409, message);
    this.evidence = evidence;
  }
}

/** A decision refused because the checks left files in the task's copy that the owner has not agreed to remove. */
export class LeftoversError extends TaskError {
  readonly leftovers: string[];
  constructor(leftovers: string[], what = "These files were left by the checks and are not on the branch") {
    super(409, `${what}: ${listed(leftovers)}. They go when the task's copy is removed. Confirm that they may go, or copy them out of the task's copy first.`);
    this.leftovers = leftovers;
  }
}


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
    decidedBy: row.decided_by === "mode" ? "mode" : "owner",
    reasons: typeof row.reasons === "string" ? row.reasons : null,
    note: typeof row.note === "string" ? row.note : null,
    checks: row.checks === "passed" || row.checks === "failed" || row.checks === "none" ? row.checks : null,
    checksCommit: typeof row.checks_commit === "string" ? row.checks_commit : null,
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
  reviewing: "is still being reviewed",
  interrupted: "was stopped",
  failed: "failed",
  cancelled: "was cancelled",
  waiting_for_limit: "is waiting for a usage limit to reset",
  drafted: "changed no file and ended with a message drafted for another workbench, so there is nothing to accept or reject",
};

function ready(task: Task): void {
  if (task.status === "awaiting_decision") return;
  if (task.status === "accepted" || task.status === "rejected") throw new TaskError(409, `Task ${task.id} was already ${task.status}, and a decision is made once.`);
  throw new TaskError(409, `Task ${task.id} is not ready for review: it ${NOT_READY[task.status]}. Only a task that is ready for review can be accepted or rejected.`);
}

/**
 * Listeners told of each task just accepted, after its decision is recorded, whoever made it: delivery listens here
 * (src/engine/delivery.ts). A listener that fails never touches the decision.
 */
const acceptedListeners = new Set<(db: DatabaseSync, task: Task) => void>();
export function onTaskAccepted(listener: (db: DatabaseSync, task: Task) => void): () => void {
  acceptedListeners.add(listener);
  return () => void acceptedListeners.delete(listener);
}
function announceAccepted(db: DatabaseSync, task: Task): void {
  for (const listener of acceptedListeners) {
    try {
      listener(db, task);
    } catch (err) {
      console.error(`Telling of task ${task.id}'s acceptance failed: ${words(err)}`);
    }
  }
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
  /** The owner's optional short note on the decision. */
  note?: unknown;
  /**
   * For an accept of work no check ran on: true says the owner accepts it without verification. Such work is accepted
   * no other way, and work that has checks is never accepted with it.
   */
  withoutVerification?: unknown;
}

/**
 * Make the owner's decision on a task that is ready for review: remove its copy, delete its branch for a reject that
 * discards it, then record the decision, the task's new state, the log entry and the run's end in one write. Throws a
 * TaskError, with nothing changed, for a decision that is malformed, a task that is not ready for review, an accept its
 * evidence does not allow (an EvidenceError), and, for a reject, files the checks left that the owner has not
 * confirmed. `run` is the task's run when the decision ended it.
 */
export async function decideTask(db: DatabaseSync, input: DecideInput): Promise<{ task: Task; run: { id: number; status: string } | null }> {
  const { decision, branch, removeLeftovers, withoutVerification } = input;
  const note = decisionNote(input.note);
  if (decision !== "accept" && decision !== "reject") throw new TaskError(400, 'Say whether to accept or reject the task: "decision" is "accept" or "reject".');
  if (decision === "reject" && branch !== "keep" && branch !== "discard") throw new TaskError(400, 'Say whether to keep or discard the task\'s branch when rejecting it: "branch" is "keep" or "discard".');
  if (decision === "accept" && branch !== undefined && branch !== "keep") throw new TaskError(400, "An accepted task keeps its branch. To delete the branch, reject the task instead.");
  if (removeLeftovers !== undefined && !(Array.isArray(removeLeftovers) && removeLeftovers.length <= 100_000 && removeLeftovers.every((f) => typeof f === "string"))) throw new TaskError(400, '"removeLeftovers" must be the list of files the owner confirmed may be removed with the task\'s copy.');
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  if (withoutVerification !== undefined && typeof withoutVerification !== "boolean") throw new TaskError(400, '"withoutVerification" is true or false: true accepts work that no check ran on.');
  const task = getTask(db, input.taskId);
  if (!task) throw new TaskError(404, "No such task.");
  ready(task);
  if (deciding.has(task.id)) throw new TaskError(409, `A decision on task ${task.id} is being made already.`);
  deciding.add(task.id);
  try {
    return await decide(db, task, decision, decision === "reject" && branch === "discard", (removeLeftovers as string[] | undefined) ?? [], note, { unverified: withoutVerification === true });
  } finally {
    deciding.delete(task.id);
  }
}

/**
 * What a decision did beyond the branch, in the one sentence every record of it uses: nothing is ever merged, and a
 * branch is pushed only by a run that opens a pull request for an accepted task (engine/delivery.ts).
 */
export function acceptedWords(delivery: "branch" | "pull_request"): string {
  return delivery === "pull_request" ? "Nothing was merged; the run then pushes the branch and opens a pull request." : "Nothing was merged or pushed.";
}

/**
 * A fully autonomous run's accept of a task that qualified, with the reasons: the owner's Accept, made by the mode. It
 * keeps the branch and removes the copy; nothing is merged (a run that chose pull requests then delivers it). Throws a TaskError, with nothing changed, when the
 * task is not ready for review, a decision on it is under way, or its evidence is not current and passed on the
 * commit Botbench made: out-of-date checks, a copy that differs from the commit, failed checks or none.
 */
export async function acceptByMode(db: DatabaseSync, taskId: number, reasons: string): Promise<{ task: Task; run: { id: number; status: string } | null }> {
  const task = getTask(db, taskId);
  if (!task) throw new TaskError(404, "No such task.");
  ready(task);
  if (deciding.has(task.id)) throw new TaskError(409, `A decision on task ${task.id} is being made already.`);
  deciding.add(task.id);
  try {
    return await decide(db, task, "accept", false, [], null, { unverified: false, reasons });
  } finally {
    deciding.delete(task.id);
  }
}

/** What an accept's log entry and the task's history say stood behind it. */
function behindWords(task: Task, evidence: EvidenceState): string {
  const none = noChecksWords(task);
  if (evidence.state === "none") return `Accepted without verification: ${none[0]!.toLowerCase()}${none.slice(1)}`;
  const commit = shortCommit(evidence.checkedCommit!);
  return evidence.checks === "passed" ? `Its checks passed on commit ${commit}, the commit accepted.` : `Its checks failed on commit ${commit}, the commit accepted: it was accepted all the same.`;
}

/**
 * `o.reasons` is set for the mode's accept and left out for the owner's decision; only the owner's carries a `note`.
 * `o.unverified`: the owner said to accept work no check ran on.
 */
async function decide(db: DatabaseSync, task: Task, decision: DecisionKind, discard: boolean, confirmed: readonly string[], note: string | null, o: { unverified: boolean; reasons?: string }): Promise<{ task: Task; run: { id: number; status: string } | null }> {
  const { reasons } = o;
  const dir = task.worktreePath!;
  const branch = task.branch!;
  // Another workbench's branch is never decided on here: not kept, not deleted, not delivered.
  if (!isOwnBranch(db, branch)) throw new TaskError(409, `${notOwnWords(branch)} Nothing was decided.`);
  // A copy that is already gone (removed by hand, or by a decision that failed after removing it) holds nothing to keep.
  const present = fs.existsSync(dir);
  let leftovers: string[];
  try {
    leftovers = present ? await leftoverFiles(dir) : [];
  } catch (err) {
    throw new TaskError(409, `The task's copy at ${dir} could not be read, so nothing was decided: ${words(err)}`);
  }
  // For a reject: removed only when they are exactly the files the owner was shown: one that appeared since is listed
  // again first. An accept is refused over any such file further down, whatever was confirmed.
  const same = leftovers.length === confirmed.length && leftovers.every((file) => confirmed.includes(file));
  if (decision === "reject" && leftovers.length > 0 && !same) throw new LeftoversError(leftovers);

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
  } else if (reasons !== undefined && at !== task.headCommit) {
    // The mode qualified the task, its changed files among it, at Botbench's own commit: a branch moved since is the owner's to judge.
    throw new TaskError(409, `The branch ${branch} has moved past the commit Botbench made and checked, so only you can accept it.`);
  }
  // An accept stands on evidence about the commit it keeps (engine/evidence.ts): one rule, for the owner and the mode.
  let evidence: EvidenceState | null = null;
  if (decision === "accept") {
    try {
      evidence = await evidenceState(db, task);
    } catch (err) {
      throw new TaskError(409, `The task's evidence could not be read, so nothing was decided: ${words(err)}`);
    }
    // The commit compared is the one this decision keeps and records.
    if (evidence.headCommit !== at) throw new TaskError(409, `The branch ${branch} moved while Botbench was deciding, so nothing was decided. Look at the task again.`);
    if (evidence.state === "stale" || evidence.state === "differs") throw new EvidenceError(evidence);
    if (evidence.state === "none") {
      if (reasons !== undefined) throw new EvidenceError(evidence, "No checks ran on it, so only you can accept it, without verification.");
      if (!o.unverified) throw new EvidenceError(evidence, `${noChecksWords(task)} To accept it all the same, choose Accept without verification.`);
    } else {
      if (o.unverified) throw new EvidenceError(evidence, `Task ${task.id} has checks, so it is not accepted without verification. ${evidence.words}`);
      if (reasons !== undefined && evidence.checks !== "passed") throw new EvidenceError(evidence);
    }
    // Read again just before the copy goes: a commit added to the branch since the evidence was read is not accepted unseen.
    let still: string | null;
    try {
      still = await branchCommit(task.repo, branch);
    } catch (err) {
      throw new TaskError(409, `The branch ${branch} could not be read, so nothing was decided: ${words(err)}`);
    }
    if (still !== at) throw new TaskError(409, `The branch ${branch} moved while Botbench was deciding, so nothing was decided. Look at the task again.`);
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

  // The owner's reason for a reject, committed on a lesson branch for later runs to learn from (engine/learnings.ts).
  const learned = decision === "reject" && note !== null ? await keepLearning(db, task, note) : null;
  const kept = discard ? "deleted" : "kept";
  const copy = present ? "removed the task's copy" : "found the task's copy already gone";
  const files = leftovers.length === 0 ? "" : ` The copy held ${leftovers.length === 1 ? "1 file" : `${leftovers.length} files`} the checks left, removed with it as you confirmed: ${listed(leftovers)}.`;
  // What git ignored in the copy went with it, unasked as before, and is named here.
  const ignoredCount = evidence === null ? 0 : evidence.ignored.length + evidence.ignoredMore;
  const ignored = evidence === null || ignoredCount === 0 || !present ? "" : ` The copy held ${ignoredCount === 1 ? "1 entry" : `${ignoredCount} entries`} git ignores, removed with it: ${evidence.ignored.join(", ")}${evidence.ignoredMore > 0 ? ` and ${evidence.ignoredMore} more` : ""}.`;
  const behind = evidence === null ? "" : ` ${behindWords(task, evidence)}`;
  const checked = evidence === null ? null : evidence.state === "none" ? "none" : evidence.checks;
  // A run that chose pull requests pushes an accepted task's branch next (engine/delivery.ts): the entry says so.
  const delivers = decision === "accept" && task.runId !== null && db.prepare("SELECT delivery FROM runs WHERE id = ?").get(task.runId)?.delivery === "pull_request";
  const detail = `${discard ? "Deleted" : "Kept"} the branch ${branch} and ${copy}. ${acceptedWords(delivers ? "pull_request" : "branch")}${behind}${files}${ignored}${learned === null ? "" : ` The note below is kept for later runs in ${learned.file} on the branch ${learned.branch}. Nothing was pushed or merged, and your own files and branch are as they were: review that branch and merge it like any change, and later runs here learn from the note.`}${note === null ? "" : ` Your note: ${note}`}`;
  const made = transaction(db, () => {
    const now_ = getTask(db, task.id)!;
    ready(now_);
    // The commit the kept branch holds now: Botbench's, or one the owner added on top of it.
    const by = reasons === undefined ? "owner" : "mode";
    db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, reasons, note, checks, checks_commit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      task.id, by, decision, kept, branch, discard ? task.headCommit : at, JSON.stringify(leftovers), now(), reasons ?? null, by === "owner" ? note : null, checked, checked === "passed" || checked === "failed" ? evidence!.checkedCommit : null,
    );
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    const decided = moveTaskIn(db, task.id, decision === "accept" ? "accepted" : "rejected", { note: `${decision === "accept" ? "accepted" : "rejected"} by ${by === "owner" ? "the owner" : "the run's mode, fully autonomous"}${checked === null ? "" : checked === "none" ? " without verification" : `; checks ${checked} on commit ${evidence!.checkedCommit}`}; branch ${kept}${leftovers.length > 0 ? `; ${leftovers.length} leftover files removed with the worktree` : ""}` });
    const rule = by === "mode" ? "mode_accepted" : decision === "accept" ? "owner_accepted" : "owner_rejected";
    appendLog(db, { taskId: task.id, runId: task.runId, attemptId: task.attemptId, rule, tool: "Branch", command: branch, cwd: task.repo, detail: reasons === undefined ? detail : `${reasons} ${detail}` });
    return { task: decided, run: task.runId === null ? null : settleRunIn(db, task.runId) };
  });
  if (decision === "accept") announceAccepted(db, made.task);
  return made;
}

/**
 * Commit the owner's reason for rejecting `task` to docs/solutions/ on its lesson branch (src/workbench.ts), based on
 * the commit the task started from, from the task's plan title (or its number, for a task started on its own) and the
 * note, and nothing else: never its prompt or any outside text. Returns the branch and file, or null when it could not
 * be committed: the rejection goes on all the same.
 */
async function keepLearning(db: DatabaseSync, task: Task, note: string): Promise<KeptLearning | null> {
  const row = db.prepare("SELECT title FROM plan_tasks WHERE task_id = ?").get(task.id);
  const title = typeof row?.title === "string" ? row.title.slice(0, MAX_TITLE) : `Task ${task.id}`;
  try {
    if (task.baseCommit === null) throw new Error("the task has no commit it started from to base the lesson branch on.");
    const at = { branch: lessonBranch(workbenchName(db), task.id), base: task.baseCommit };
    return await recordLearning(task.repo, at, { title, note, taskId: task.id, date: now().slice(0, 10) });
  } catch (err) {
    console.error(`Keeping the note on task ${task.id} in ${task.repo} failed, and the task is rejected all the same: ${words(err)}`);
    return null;
  }
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
export const ENDED_UNREVIEWED: ReadonlySet<TaskStatus> = new Set(["failed", "interrupted", "cancelled", "drafted"]);

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
  if (!ENDED_UNREVIEWED.has(task.status)) throw new TaskError(409, `Task ${task.id} ${NOT_READY[task.status as keyof typeof NOT_READY]}. Only a task that failed, was stopped, was cancelled or drafted a message can be discarded.`);
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
  if (branch !== null && !isOwnBranch(db, branch)) throw new TaskError(409, `${notOwnWords(branch)} Nothing was discarded.`);
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
