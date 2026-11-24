import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import { branchCommit, copyDifferences } from "../worktrees.ts";
import { taskReviews } from "./review.ts";
import { agentName } from "./roles.ts";
import type { ChecksMark, Task } from "./task.ts";

/*
 * Evidence tied to the commit under review. A check result says something about one commit: the one the task's copy
 * was at when the round of checks began. An Accept keeps the task's branch, so what it accepts is the commit that
 * branch holds when the decision is made. The two are compared here, from what is stored and from the repository as it
 * is now, and nowhere else: the owner's Accept, a fully autonomous run's accept, "Run checks again" and every screen
 * read this one answer (`evidenceState`).
 *
 * - `current`: the latest round of checks finished, began on a copy with no file differing from its commit, and that
 *   commit is the one the branch holds; and the copy holds no blocking difference now. Checks that FAILED on that
 *   commit are current too: the result is about the commit under review, it is not a pass, and the owner may still
 *   accept or reject, as before. A fully autonomous run accepts only current evidence that passed.
 * - `stale`: there are check results, and they are not about the commit the branch holds: they ran on another commit,
 *   their commit was never recorded (a result from before commits were recorded, or a round that began in a copy
 *   holding other files), or the latest round did not finish. Accept is refused; "Run checks again" is the way on.
 * - `differs`: the task's copy holds a tracked file that differs from the commit, or a file that is not tracked and
 *   that git does not ignore. Such a file could have changed what the checks found, and is not part of what Accept
 *   keeps. Accept is refused, and so is a re-run (its result would not be about the commit); the owner looks at the files.
 * - `none`: no checks ran on this version of the work (the repository has none set up). Nothing verified it; it can be
 *   accepted only as "Accept without verification", and is recorded as that.
 *
 * What git ignores in the copy (coverage output, node_modules) blocks nothing: it is listed, and goes with the copy.
 * A review by another agent is a model's opinion, not a check: the commit it read is reported apart (`review`), and an
 * out-of-date review does not by itself stop an accept.
 */

/** A file in the task's copy that keeps its evidence from being current: a tracked file that differs from the commit, or one that is neither tracked nor ignored. */
export interface CopyFile {
  path: string;
  change: "changed" | "untracked";
}

export interface EvidenceState {
  state: "current" | "stale" | "differs" | "none";
  /** What the task's checks found, as stored on it; "none" when no checks ran on this version of the work. */
  checks: ChecksMark;
  /** The commit the latest finished round of checks ran on; null when there is none or it is not known. */
  checkedCommit: string | null;
  /** The commit the task's branch holds now, which an Accept would keep; null when the branch is not there. */
  headCommit: string | null;
  /** For `differs`: the files, in git's order. Empty otherwise. */
  files: CopyFile[];
  /** What git ignores in the copy, the first `MAX_IGNORED_LISTED` entries; `ignoredMore` counts the rest. */
  ignored: string[];
  ignoredMore: number;
  /** The one sentence about `ignored`, for the owner; null when there is nothing ignored. */
  ignoredWords: string | null;
  /** What is so, and what to do, in words for the owner. */
  words: string;
  /** Whether "Run checks again" has something to run on: the evidence is stale and the task's copy is there. */
  canRunAgain: boolean;
  /** The latest review that read the work, with the commit it read and whether that is the branch's; null when there is none. */
  review: { agent: string; commit: string | null; current: boolean; words: string } | null;
}

/** How many ignored entries are listed by name; the rest are counted. */
export const MAX_IGNORED_LISTED = 20;
/** How many differing files are named in the sentence; all of them are in `files`. */
const MAX_FILES_IN_WORDS = 5;

/** A commit as the screens name it. */
export const shortCommit = (commit: string): string => commit.slice(0, 7);

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The latest round of checks begun on a task: whether it finished, and the one commit all its results name. */
export function latestChecks(db: DatabaseSync, taskId: number): { round: number; finished: boolean; commit: string | null } | null {
  const latest = db.prepare("SELECT max(round) AS n FROM (SELECT round FROM evidence WHERE task_id = ? AND kind = 'check' UNION ALL SELECT round FROM command_processes WHERE task_id = ? AND kind = 'check' UNION ALL SELECT round FROM command_lists WHERE task_id = ? AND kind = 'check')").get(taskId, taskId, taskId)?.n;
  if (typeof latest !== "number") return null;
  const rows = db.prepare("SELECT outcome, head_commit FROM evidence WHERE task_id = ? AND kind = 'check' AND round = ?").all(taskId, latest);
  const total = db.prepare("SELECT total FROM command_lists WHERE task_id = ? AND kind = 'check' AND round = ?").get(taskId, latest)?.total;
  const running = db.prepare("SELECT 1 FROM command_processes WHERE task_id = ? AND kind = 'check' AND round = ? AND ended_at IS NULL LIMIT 1").get(taskId, latest) !== undefined;
  // A round from before list sizes were recorded has no total: it is taken as finished when it has a result and none was stopped.
  const finished = rows.length > 0 && !running && (typeof total !== "number" || rows.length === total) && rows.every((row) => row.outcome !== "stopped");
  const commits = new Set(rows.map((row) => (typeof row.head_commit === "string" ? row.head_commit : null)));
  const only = commits.size === 1 ? [...commits][0]! : null;
  return { round: latest, finished, commit: only };
}

function reviewOf(db: DatabaseSync, taskId: number, head: string | null): EvidenceState["review"] {
  const review = taskReviews(db, taskId).filter((r) => r.outcome === "reviewed").at(-1);
  if (review === undefined) return null;
  const name = agentName(review.agent);
  const opinion = "A model's opinion, not a check";
  if (review.headCommit === null) return { agent: review.agent, commit: null, current: false, words: `Botbench has no record of the commit ${name}'s review read, so it is not known to be about the commit Accept keeps. ${opinion}: it does not stop Accept.` };
  if (review.headCommit === head) return { agent: review.agent, commit: review.headCommit, current: true, words: `${name}'s review read commit ${shortCommit(review.headCommit)}, the commit Accept keeps. ${opinion}.` };
  return { agent: review.agent, commit: review.headCommit, current: false, words: `${name}'s review is out of date: it read commit ${shortCommit(review.headCommit)}, and the branch is ${head === null ? "not in the repository any more" : `now at commit ${shortCommit(head)}`}. ${opinion}: it does not stop Accept.` };
}

function ignoredWordsOf(ignored: readonly string[]): string | null {
  if (ignored.length === 0) return null;
  const listed = ignored.slice(0, MAX_IGNORED_LISTED).join(", ");
  const more = ignored.length - Math.min(ignored.length, MAX_IGNORED_LISTED);
  const one = ignored.length === 1;
  return `Git ignores ${counted(ignored.length, "entry", "entries")} in the task's copy: ${listed}${more > 0 ? ` and ${more} more` : ""}. ${one ? "It is" : "They are"} not on the branch, ${one ? "does" : "do"} not count against the evidence, and ${one ? "is" : "are"} removed with the copy.`;
}

function differsWords(files: readonly CopyFile[], commit: string): string {
  const named = files.slice(0, MAX_FILES_IN_WORDS).map((file) => `${file.path} (${file.change === "changed" ? "changed" : "not on the branch"})`).join(", ");
  const more = files.length - Math.min(files.length, MAX_FILES_IN_WORDS);
  const one = files.length === 1;
  return `The task's copy has ${counted(files.length, "file that differs", "files that differ")} from commit ${shortCommit(commit)}: ${named}${more > 0 ? ` and ${more} more` : ""}. The checks do not vouch for ${one ? "it" : "them"}, and Accept keeps only what is committed. Look at ${one ? "it" : "them"} in the task's copy: commit what should stay and run the checks again, or remove what should not, or send a note about ${one ? "it" : "them"} to the agent that built the task.`;
}

/** That nothing verified a task's work, and why: its repository had no checks set up, or (a task from before checks were recorded) none ran. */
export const noChecksWords = (task: Pick<Task, "checks">): string => `${task.checks === "none" ? "No checks are set up for this repository" : "No checks ran on this task"}, so nothing verified this work.`;

/**
 * The state of a task's evidence, for a task that is ready for review, from what is stored of it and from its copy and
 * its repository as they are now. Rejects when the copy or the branch cannot be read: an accept is then refused.
 * `checksSetUp`: whether the repository's settings list any check now; false means a re-run has nothing to run, and
 * the state says so. Left out, it is not known here, and the re-run itself refuses.
 */
export async function evidenceState(db: DatabaseSync, task: Task, o: { checksSetUp?: boolean } = {}): Promise<EvidenceState> {
  const head = task.branch === null ? null : await branchCommit(task.repo, task.branch);
  const present = task.worktreePath !== null && fs.existsSync(task.worktreePath);
  const copy = present ? await copyDifferences(task.worktreePath!) : null;
  // A copy on its task branch is at the branch's commit; one that is not was moved while this was read.
  if (copy !== null && head !== null && copy.commit !== head) throw new Error(`The task's copy is at commit ${shortCommit(copy.commit)} and its branch ${task.branch} is at ${shortCommit(head)}. Either the branch moved while Botbench was reading it (try again), or the copy was switched to another branch: switch it back with git switch ${task.branch}, run in the copy.`);
  const files: CopyFile[] = copy === null ? [] : [...copy.changed.map((path) => ({ path, change: "changed" as const })), ...copy.untracked.map((path) => ({ path, change: "untracked" as const }))];
  const allIgnored = copy?.ignored ?? [];
  const latest = latestChecks(db, task.id);
  const checks: ChecksMark = task.checks ?? "none";
  const checkedCommit = checks !== "none" && latest !== null && latest.finished ? latest.commit : null;
  const base = {
    checks, checkedCommit, headCommit: head, files: [] as CopyFile[],
    ignored: allIgnored.slice(0, MAX_IGNORED_LISTED), ignoredMore: allIgnored.length - Math.min(allIgnored.length, MAX_IGNORED_LISTED), ignoredWords: ignoredWordsOf(allIgnored),
    canRunAgain: false, review: reviewOf(db, task.id, head),
  };
  if (files.length > 0) return { ...base, state: "differs", files, words: differsWords(files, copy!.commit) };
  if (checks === "none") return { ...base, state: "none", words: `${noChecksWords(task)} You can accept it without verification.` };
  if (head !== null && checkedCommit === head) {
    return {
      ...base, state: "current",
      words: checks === "passed"
        ? `Evidence is current: the checks passed on commit ${shortCommit(head)}, the commit Accept keeps.`
        : `The checks failed on commit ${shortCommit(head)}, the commit Accept keeps. The result is current, and it is not a pass: you can still accept or reject it.`,
    };
  }
  const about = head === null ? "the branch, which is not in the repository any more" : `commit ${shortCommit(head)}, which Accept would keep`;
  const why =
    latest === null || !latest.finished ? `The latest checks did not finish, so nothing is verified for ${about}.`
    : checkedCommit === null ? `Botbench has no record of the commit these checks ran on, so they do not count for ${about}.`
    : `The checks are out of date: they ran on commit ${shortCommit(checkedCommit)}, and the branch is ${head === null ? "not in the repository any more" : `now at commit ${shortCommit(head)}`}.`;
  const canRunAgain = present && head !== null && o.checksSetUp !== false;
  const next = canRunAgain ? "Run checks again to check the commit you would accept."
    : head === null ? "There is no commit to check: reject the task instead."
    : !present ? "The task's copy of the project is no longer there, so Botbench cannot run them again: reject the task and keep its branch instead."
    : "This repository has no checks set up now, so they cannot be run again: add its checks to Botbench's settings file again, or reject the task.";
  return { ...base, state: "stale", canRunAgain, words: `${why} ${next}` };
}

/** One time the owner had a task's checks run again while it was ready for review. */
export interface CheckRerun {
  id: number;
  taskId: number;
  requestedBy: "owner";
  /** The commit the results before it were for; null when that was not known. */
  fromCommit: string | null;
  /** The commit the branch held when it was asked. */
  headCommit: string;
  /** How it ended: what the checks found, or stopped before they finished; null while it is under way. */
  outcome: "passed" | "failed" | "stopped" | null;
  startedAt: string;
  endedAt: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const toRerun = (row: Record<string, unknown>): CheckRerun => ({ id: Number(row.id), taskId: Number(row.task_id), requestedBy: "owner", fromCommit: text(row.from_commit), headCommit: String(row.head_commit), outcome: text(row.outcome) as CheckRerun["outcome"], startedAt: String(row.started_at), endedAt: text(row.ended_at) });

/** A task's re-runs of its checks, oldest first. */
export const taskCheckReruns = (db: DatabaseSync, taskId: number): CheckRerun[] => db.prepare("SELECT * FROM check_reruns WHERE task_id = ? ORDER BY id").all(taskId).map(toRerun);

/** The task's re-run of its checks that is under way, or null. */
export function openCheckRerun(db: DatabaseSync, taskId: number): CheckRerun | null {
  const row = db.prepare("SELECT * FROM check_reruns WHERE task_id = ? AND ended_at IS NULL").get(taskId);
  return row ? toRerun(row) : null;
}

/**
 * The rounds of a task's checks that the owner's re-runs ran: each round begun while a re-run was open (more than one
 * when Botbench restarted during it). For naming an earlier round as what it was.
 */
export function rerunRounds(db: DatabaseSync, taskId: number): number[] {
  return db.prepare("SELECT DISTINCT l.round AS round FROM command_lists l JOIN check_reruns r ON r.task_id = l.task_id AND l.started_at >= r.started_at AND (r.ended_at IS NULL OR l.started_at <= r.ended_at) WHERE l.task_id = ? AND l.kind = 'check' ORDER BY l.round").all(taskId).map((row) => Number(row.round));
}

/** Store the start of a re-run, inside the caller's transaction, while the task is still ready for review. */
export function startCheckRerunIn(db: DatabaseSync, o: { taskId: number; fromCommit: string | null; headCommit: string }): number {
  return Number(db.prepare("INSERT INTO check_reruns (task_id, requested_by, from_commit, head_commit, started_at) VALUES (?, 'owner', ?, ?, ?)").run(o.taskId, o.fromCommit, o.headCommit, now()).lastInsertRowid);
}

/** End a re-run, once. */
export function endCheckRerunIn(db: DatabaseSync, id: number, outcome: "passed" | "failed" | "stopped"): void {
  db.prepare("UPDATE check_reruns SET outcome = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL").run(outcome, now(), id);
}
