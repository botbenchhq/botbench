import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { realRepo } from "../approvals/grants.ts";
import { MAX_ISSUE_NUMBER, PR_LIST_LIMIT, redact } from "../github.ts";
import { now, transaction } from "../store/db.ts";
import { isOwnBranch } from "../workbench.ts";
import { branchCommit, combinedRoot, describeCommits, peerChangedFiles, prepareCombinedCopy, remoteAddress, removeCombinedCopy } from "../worktrees.ts";
import { allowedHostsFor } from "./intake.ts";
import type { PeerPullRequest, Peers, PeersView } from "./peers.ts";
import { runCommand, type CommandOutcome, type CommandRun, type StationCommand } from "./stations.ts";
import { getTask, TaskError, words, type Task } from "./task.ts";
import type { Execution } from "../execution.ts";

/*
 * Checking a task together with another workbench's open pull request (Peers, step P4). Two changes that each pass
 * their own checks can still fail to fit together; "they fit" is something that ran, not something two agents said.
 *
 * The owner asks for it on a task that is ready for review. Botbench reads the other pull request from the view of the
 * shared remote (engine/peers.ts), fetches its head read only into a temporary copy of the repository under the data
 * folder, merges it with the task's commit on a scratch branch there (src/worktrees.ts), and runs the repository's own
 * setup and check commands on the merge, confined exactly as a task's checks are (engine/stations.ts): the copy and a
 * temporary folder are all they may write, and they reach no network unless the repository allows hosts. Nothing is
 * pushed; the copy, and the scratch branch in it, are removed afterwards, whatever happened.
 *
 * The other pull request's code is somebody else's, so the check runs code nobody here wrote or read: the result is
 * labelled as including another workbench's code. Its title, branch and files are outside text, shown as plain text,
 * and none of it reaches a prompt. The branch name is passed to git only after it matched the task branch pattern.
 *
 * The result is stored as task evidence with the two head commits it ran on. It counts only while both are still the
 * heads: once the view of the remote shows another head for the pull request, or the task's branch has moved, it is
 * stale, and the check is offered again (approach from Paperclip server/src/services/required-quality-review.ts, whose
 * required review reports a slot as stale once its evidence no longer matches).
 *
 * "Require checking together" is a per-repository setting only the owner sets and removes, through the API
 * (src/api/check-together.ts); nothing an agent writes, no transcript and no peer's text is read for it. With it on, a
 * fully autonomous run does not accept a task by itself while an open pull request from another workbench that changes
 * one of its files has no passing, current check together; each such pull request is a blocker, and once the last is
 * cleared the run's mode looks at the task again (approach from Paperclip
 * server/src/services/issue-dependency-wakeups.ts, which wakes a blocked issue when its blockers resolve).
 */

export type CombinedOutcome = "passed" | "failed" | "conflict" | "not_run";

/** One setup or check command run on the merge, as stored. */
export interface CombinedCommand extends Omit<CommandRun, "command"> {
  id: number;
  kind: "setup" | "check";
  position: number;
  command: string;
}

/** One check together, as stored: on which two commits it ran and what it found. */
export interface CombinedCheck {
  id: number;
  taskId: number;
  pullRequest: number;
  workbench: string;
  peerBranch: string;
  /** The head of the other pull request that was fetched and merged; null when it could not be fetched. */
  peerCommit: string | null;
  /** The task's commit it was merged with. */
  taskCommit: string;
  /** passed: merged cleanly and every command passed; failed: merged, and a command did not pass; conflict: did not merge; not_run: could not be made. */
  outcome: CombinedOutcome;
  conflicts: string[];
  /** Why it could not be made (not_run), in words for the owner. */
  problem: string | null;
  startedAt: string;
  endedAt: string;
  commands: CombinedCommand[];
}

/** Each check together of a task, newest first. */
export function combinedChecks(db: DatabaseSync, taskId: number): CombinedCheck[] {
  const commands = (id: number): CombinedCommand[] =>
    db.prepare("SELECT * FROM combined_check_commands WHERE combined_check_id = ? ORDER BY id").all(id).map((row) => ({
      id: Number(row.id),
      kind: String(row.kind) as "setup" | "check",
      position: Number(row.position),
      command: String(row.command),
      outcome: String(row.outcome) as CommandOutcome,
      exitCode: typeof row.exit_code === "number" ? row.exit_code : null,
      signal: typeof row.signal === "string" ? row.signal : null,
      output: String(row.output),
      truncated: row.output_truncated === 1,
      limitMs: Number(row.limit_ms),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      durationMs: Number(row.duration_ms),
    }));
  return db.prepare("SELECT * FROM combined_checks WHERE task_id = ? ORDER BY id DESC").all(taskId).map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    pullRequest: Number(row.pull_request),
    workbench: String(row.workbench),
    peerBranch: String(row.peer_branch),
    peerCommit: typeof row.peer_commit === "string" ? row.peer_commit : null,
    taskCommit: String(row.task_commit),
    outcome: String(row.outcome) as CombinedOutcome,
    conflicts: JSON.parse(String(row.conflicts)) as string[],
    problem: typeof row.problem === "string" ? row.problem : null,
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    commands: commands(Number(row.id)),
  }));
}

type Stored = Omit<CombinedCheck, "id" | "commands"> & { commands: (CommandRun & { kind: "setup" | "check"; position: number })[] };

/** Store one check together and its commands in one write. Answers its id. */
function storeCombined(db: DatabaseSync, c: Stored): number {
  return transaction(db, () => {
    const id = Number(
      db.prepare("INSERT INTO combined_checks (task_id, pull_request, workbench, peer_branch, peer_commit, task_commit, outcome, conflicts, problem, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.taskId, c.pullRequest, c.workbench, c.peerBranch, c.peerCommit, c.taskCommit, c.outcome, JSON.stringify(c.conflicts), c.problem, c.startedAt, c.endedAt).lastInsertRowid,
    );
    for (const run of c.commands) {
      db.prepare("INSERT INTO combined_check_commands (combined_check_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, run.kind, run.position, run.command, run.outcome, run.exitCode, run.signal, run.output, run.truncated ? 1 : 0, run.limitMs, run.startedAt, run.endedAt, run.durationMs,
      );
    }
    return id;
  });
}

/*
 * The owner's setting. Every row is an owner action through the API; the latest for a repository is in force.
 */

/** Whether the owner requires checking together on `repo`. */
export function checkTogetherRequired(db: DatabaseSync, repo: string): boolean {
  return db.prepare("SELECT required FROM combined_requirements WHERE repo_path = ? ORDER BY id DESC LIMIT 1").get(realRepo(repo))?.required === 1;
}

/** The owner's change to the setting for `repo`. Called only by the owner's route (src/api/check-together.ts). */
export function setCheckTogetherRequired(db: DatabaseSync, repo: string, required: boolean): void {
  db.prepare("INSERT INTO combined_requirements (repo_path, required, set_by, set_at) VALUES (?, ?, 'owner', ?)").run(realRepo(repo), required ? 1 : 0, now());
}

/*
 * Whether a result still stands on the heads it ran on.
 */

/**
 * Whether a check together still stands on the commits it ran on: `current`; `stale`, naming which head moved and to
 * what; `closed`, when the view no longer lists the pull request as another workbench's open one; or `unknown`, when the
 * view of the remote could not be read. Only `current` counts.
 */
export type Freshness =
  | { state: "current" }
  | { state: "stale"; taskMoved: boolean; pullRequestMoved: boolean; taskNow: string | null; pullRequestNow: string | null }
  | { state: "closed" }
  | { state: "unknown"; problem: string };

/** `taskHead`: the commit the task's branch points at now (null when it is gone). `view`: the view of the shared remote. */
export function freshness(check: Pick<CombinedCheck, "pullRequest" | "peerCommit" | "taskCommit">, o: { taskHead: string | null; view: PeersView }): Freshness {
  if (o.view.state !== "ready") return { state: "unknown", problem: o.view.problem };
  const pr = o.view.pullRequests.find((p) => p.number === check.pullRequest);
  if (pr === undefined) return { state: "closed" };
  const taskMoved = o.taskHead !== check.taskCommit;
  const pullRequestMoved = pr.head !== check.peerCommit;
  if (!taskMoved && !pullRequestMoved) return { state: "current" };
  return { state: "stale", taskMoved, pullRequestMoved, taskNow: o.taskHead, pullRequestNow: pr.head };
}

/**
 * The files each open pull request of another workbench changes, by its number, as git read them from its fetched head
 * (`peerFiles` of CheckTogether); null for one whose files could not be read.
 */
export type PeerFiles = ReadonlyMap<number, readonly string[] | null>;

/**
 * The open pull requests of other workbenches in `view` that change one of `files`, with the files both change. Which
 * files a pull request changes is what git read from its commits (`peerFiles`), not GitHub's list of them; one whose
 * files could not be read, or that is not in `peerFiles`, may change any of them and counts as overlapping.
 */
export function overlapping(view: PeersView, files: readonly string[], peerFiles: PeerFiles): { pr: PeerPullRequest; files: string[] }[] {
  if (view.state !== "ready" || files.length === 0) return [];
  const ours = new Set(files);
  return view.pullRequests.flatMap((pr) => {
    const theirs = peerFiles.get(pr.number);
    if (theirs === undefined || theirs === null) return [{ pr, files: [] }];
    const both = theirs.filter((file) => ours.has(file));
    return both.length === 0 ? [] : [{ pr, files: both }];
  });
}

const prWords = (pr: Pick<PeerPullRequest, "workbench" | "number">): string => `${pr.workbench}'s pull request #${pr.number}`;
const listWords = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * Whether a fully autonomous run may accept the task as far as checking together goes. With the setting off, yes.
 * With it on: only when the view of the remote could be read, and every open pull request of another workbench that
 * changes one of the task's `files` has a check together that passed and is current. A conflict, a failed or unmade
 * check, and a stale one do not count. `why` is the plain reason, to follow "It needs your review:".
 */
export function checkTogetherGate(o: { required: boolean; files: readonly string[]; view: PeersView; peerFiles: PeerFiles; checks: readonly CombinedCheck[]; taskHead: string | null }): { ok: true } | { ok: false; why: string; waitingOn: number[] } {
  if (!o.required) return { ok: true };
  if (o.view.state !== "ready") return { ok: false, why: `This repository requires checking together with other workbenches' pull requests, and Botbench could not read them: ${o.view.problem}`, waitingOn: [] };
  if (o.view.mayBeMore === true) return { ok: false, why: `This repository requires checking together, and it has at least ${PR_LIST_LIMIT} open pull requests, more than Botbench reads at once, so it cannot tell which of them change the same files.`, waitingOn: [] };
  const blockers = overlapping(o.view, o.files, o.peerFiles).filter(({ pr }) => !o.checks.some((c) => c.pullRequest === pr.number && c.outcome === "passed" && freshness(c, { taskHead: o.taskHead, view: o.view }).state === "current"));
  if (blockers.length === 0) return { ok: true };
  const named = listWords(blockers.map(({ pr }) => prWords(pr)));
  return { ok: false, why: `This repository requires checking together, and there is no passing check together with ${named} at the commits both are at now.`, waitingOn: blockers.map(({ pr }) => pr.number) };
}

/*
 * Running a check together.
 */

export interface CheckTogether {
  /**
   * The owner's "Check together with pull request #N" on a task that is ready for review. Checks what it can at once and
   * throws a TaskError (400, 404, 409) saying why it cannot run; otherwise starts it and answers with its end to come.
   */
  start(taskId: number, pullRequest: unknown): Promise<{ finished: Promise<CombinedCheck> }>;
  /** The pull request a check together of the task is running with now, or null. */
  running(taskId: number): number | null;
  /**
   * The files each open pull request of another workbench in `view` changes, read by git from its head on the remote
   * (src/worktrees.ts peerChangedFiles), from `baseCommit`. Kept per head, so a head is fetched once. Never rejects.
   */
  peerFiles(task: Task, view: PeersView): Promise<PeerFiles>;
  /** The gate a fully autonomous run's accept passes through (engine/task.ts). Never rejects: a doubt is a wait. */
  gate(task: Task, files: readonly string[], head: string | null): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Stop what is running and wait until each has stored its end and removed its copy. */
  close(): Promise<void>;
}

export interface CheckTogetherOptions {
  db: DatabaseSync;
  /** Botbench's data folder: the temporary copies go under it. */
  home: string;
  peers: Peers;
  repoCommands: (repo: string) => { setup: readonly StationCommand[]; checks: readonly StationCommand[] };
  repoHosts: (repo: string) => readonly string[];
  /** Where a repository's commands run (src/execution.ts): on this Mac when left out. A container repository's are not run here. */
  execution?: (repo: string) => Execution;
  /** The remote of the repository that holds the other workbenches' branches (its delivery remote). */
  remote: (repo: string) => string;
  /** Called when a check together of the task has ended and is stored. */
  onTaskChange: (task: Task) => void;
  /** Called when one passed: its blocker may be cleared, so a fully autonomous run looks at the task again. */
  onPassed?: (taskId: number) => void;
}

/** Why a check together was not run for a repository whose commands run in a container, in words for the owner. */
export const CONTAINER_NOT_TOGETHER = "This repository's commands run in a container, and Botbench does not check together in one yet. Nothing ran on this Mac instead.";
class ContainerRepository extends Error {}

export function createCheckTogether(o: CheckTogetherOptions): CheckTogether {
  const { db, home } = o;
  const busy = new Map<number, { pullRequest: number; finished: Promise<CombinedCheck> }>();
  // The files a peer's head changes from a base, by "<head> <base>": a commit's files never change.
  const filesOf = new Map<string, Promise<string[] | null>>();
  const stop = new AbortController();

  const run = async (task: Task, taskCommit: string, pr: PeerPullRequest, fetchUrl: string, commands: { setup: readonly StationCommand[]; checks: readonly StationCommand[] }): Promise<CombinedCheck> => {
    const startedAt = now();
    const dir = path.join(combinedRoot(home), `task-${task.id}-${randomBytes(6).toString("hex")}`);
    const base = { taskId: task.id, pullRequest: pr.number, workbench: pr.workbench, peerBranch: pr.branch, taskCommit, startedAt };
    let stored: Stored;
    try {
      // A repository whose commands run in a container never runs them on this Mac, and the merge has no container of its own.
      if (o.execution?.(task.repo).kind === "container") throw new ContainerRepository();
      const merge = await prepareCombinedCopy({ repo: task.repo, home, dir, fetchUrl, peerBranch: pr.branch, taskCommit });
      if (!merge.merged) {
        stored = { ...base, peerCommit: merge.peerCommit, outcome: "conflict", conflicts: merge.conflicts, problem: null, endedAt: now(), commands: [] };
      } else {
        const confinement = { dataDir: home, allowedHosts: allowedHostsFor(db, task.runId, o.repoHosts(task.repo)) };
        const ran: Stored["commands"] = [];
        let passed = true;
        let stopped = false;
        // Setup first, as in a task's own copy, stopping at the first that does not pass; then every check.
        for (const [kind, list] of [["setup", commands.setup], ["check", commands.checks]] as const) {
          if (!passed && kind === "check") break;
          for (const [i, command] of list.entries()) {
            if (stop.signal.aborted) {
              stopped = true;
              break;
            }
            const result = await runCommand({ command: command.command, cwd: dir, limitMs: command.limitMs, confinement, signal: stop.signal });
            ran.push({ ...result, kind, position: i + 1 });
            if (result.outcome === "stopped") stopped = true;
            if (result.outcome !== "passed") {
              passed = false;
              if (kind === "setup") break;
            }
          }
          if (stopped) break;
        }
        stored = stopped
          ? { ...base, peerCommit: merge.peerCommit, outcome: "not_run", conflicts: [], problem: "Botbench stopped before the check together finished.", endedAt: now(), commands: ran }
          : { ...base, peerCommit: merge.peerCommit, outcome: passed ? "passed" : "failed", conflicts: [], problem: null, endedAt: now(), commands: ran };
      }
    } catch (err) {
      if (err instanceof ContainerRepository) stored = { ...base, peerCommit: null, outcome: "not_run", conflicts: [], problem: CONTAINER_NOT_TOGETHER, endedAt: now(), commands: [] };
      else stored = { ...base, peerCommit: null, outcome: "not_run", conflicts: [], problem: `Botbench could not merge pull request #${pr.number} with this task's work: ${redact(words(err)).slice(0, 2000)}`, endedAt: now(), commands: [] };
    } finally {
      try {
        removeCombinedCopy(home, dir);
      } catch (err) {
        console.error(`Removing the copy for checking task ${task.id} together failed: ${words(err)}`);
      }
    }
    const id = storeCombined(db, stored);
    const check = combinedChecks(db, task.id).find((c) => c.id === id)!;
    const now_ = getTask(db, task.id);
    if (now_ !== null) o.onTaskChange(now_);
    if (check.outcome === "passed") o.onPassed?.(task.id);
    return check;
  };

  const peerFiles = async (task: Task, view: PeersView): Promise<PeerFiles> => {
    const found = new Map<number, string[] | null>();
    if (view.state !== "ready" || view.pullRequests.length === 0) return found;
    const base = task.baseCommit;
    const address = await remoteAddress(task.repo, o.remote(task.repo)).catch(() => null);
    for (const pr of view.pullRequests) {
      if (base === null || address === null || pr.head === null) {
        found.set(pr.number, null);
        continue;
      }
      const key = `${pr.head} ${base}`;
      let read = filesOf.get(key);
      if (read === undefined) {
        const dir = path.join(combinedRoot(home), `files-${task.id}-${randomBytes(6).toString("hex")}`);
        read = peerChangedFiles({ repo: task.repo, home, dir, fetchUrl: address.fetch, peerBranch: pr.branch, baseCommit: base })
          // A head that moved between the view and the fetch is not the one the view names: its files are not known.
          .then((r) => (r.peerCommit === pr.head ? r.files : null), () => null)
          .finally(() => {
            try {
              removeCombinedCopy(home, dir);
            } catch (err) {
              console.error(`Removing the copy for reading pull request #${pr.number}'s files failed: ${words(err)}`);
            }
          });
        filesOf.set(key, read);
        // An answer that could not be read is asked again next time.
        void read.then((files) => {
          if (files === null) filesOf.delete(key);
        });
      }
      found.set(pr.number, await read);
    }
    return found;
  };

  return {
    peerFiles,
    async start(taskId, given) {
      if (typeof given !== "number" || !Number.isSafeInteger(given) || given < 1 || given > MAX_ISSUE_NUMBER) throw new TaskError(400, "Give the number of another workbench's open pull request.");
      const task = getTask(db, taskId);
      if (task === null) throw new TaskError(404, "No such task.");
      if (task.status !== "awaiting_decision" || task.headCommit === null || task.branch === null) throw new TaskError(409, "Only a task that is ready for review can be checked together with another pull request.");
      if (!isOwnBranch(db, task.branch)) throw new TaskError(409, `The branch ${task.branch} is not this workbench's, so Botbench does not check it together with anything.`);
      if (busy.has(task.id)) throw new TaskError(409, `This task is already being checked together with pull request #${busy.get(task.id)!.pullRequest}. Wait for it to finish.`);
      const commands = o.repoCommands(task.repo);
      if (commands.checks.length === 0) throw new TaskError(409, "No checks are set up for this repository, so there is nothing to run together.");
      const view = await o.peers.view(task.repo, { fresh: true });
      if (view.state !== "ready") throw new TaskError(409, `Botbench could not read the other workbenches' pull requests: ${view.problem}`);
      const pr = view.pullRequests.find((p) => p.number === given);
      if (pr === undefined) throw new TaskError(404, `Pull request #${given} is not an open pull request from another workbench on this repository.`);
      const remote = o.remote(task.repo);
      const address = await remoteAddress(task.repo, remote).catch(() => null);
      if (address === null) throw new TaskError(409, `This repository has no remote named ${remote}, so the pull request cannot be fetched.`);
      // The commit the task's branch is at now, which is what staleness compares with: a branch moved since Botbench's
      // commit is checked as it is now, not as it was.
      const taskCommit = await branchCommit(task.repo, task.branch).catch(() => null);
      if (taskCommit === null) throw new TaskError(409, `The branch ${task.branch} is not in the repository any more, so there is nothing to check together.`);
      // Checked again now, after the reads: a second start meanwhile is refused, never run twice at once.
      if (busy.has(task.id)) throw new TaskError(409, `This task is already being checked together with pull request #${busy.get(task.id)!.pullRequest}. Wait for it to finish.`);
      const finished = run(task, taskCommit, pr, address.fetch, commands).finally(() => busy.delete(task.id));
      busy.set(task.id, { pullRequest: pr.number, finished });
      return { finished };
    },
    running: (taskId) => busy.get(taskId)?.pullRequest ?? null,
    async gate(task, files, head) {
      const required = checkTogetherRequired(db, task.repo);
      if (!required) return { ok: true };
      try {
        const view = await o.peers.view(task.repo, { fresh: true });
        const taskHead = task.branch === null ? null : await branchCommit(task.repo, task.branch).catch(() => null);
        // The branch must still be at the commit the mode qualified; a branch at another commit is the owner's.
        const verdict = checkTogetherGate({ required, files, view, peerFiles: await peerFiles(task, view), checks: combinedChecks(db, task.id), taskHead: taskHead === head ? taskHead : null });
        return verdict.ok ? { ok: true } : { ok: false, why: verdict.why };
      } catch (err) {
        return { ok: false, why: `This repository requires checking together, and Botbench could not tell whether it was done: ${words(err)}` };
      }
    },
    async close() {
      stop.abort();
      await Promise.allSettled([...busy.values()].map((b) => b.finished));
    },
  };
}

/** The view of checking together a task's screen shows: the setting, what is running, each result with whether it still stands, and what can be checked. */
export async function checkTogetherView(o: { db: DatabaseSync; peers: Peers; checkTogether: CheckTogether; task: Task }): Promise<Record<string, unknown>> {
  const { db, task } = o;
  const stored = combinedChecks(db, task.id);
  const required = checkTogetherRequired(db, task.repo);
  // A task that is not ready for review and was never checked together has nothing to show: GitHub is not asked.
  if (task.status !== "awaiting_decision" && stored.length === 0) return { required, running: o.checkTogether.running(task.id), checks: [], offers: [], waitingOn: [], undetermined: null, viewProblem: null };
  const view = await o.peers.view(task.repo);
  const taskHead = task.branch === null ? null : await branchCommit(task.repo, task.branch).catch(() => null);
  const checks = stored.map((check) => ({ ...check, freshness: freshness(check, { taskHead, view }) }));
  const files = await changedFiles(task);
  // Read only for a task that can still be checked together: each peer head is fetched once, then kept.
  const peerFiles = task.status === "awaiting_decision" ? await o.checkTogether.peerFiles(task, view) : new Map<number, string[] | null>();
  const overlaps = new Map(overlapping(view, files, peerFiles).map(({ pr, files: both }) => [pr.number, both]));
  const offers = task.status === "awaiting_decision" && view.state === "ready" ? view.pullRequests.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, workbench: pr.workbench, head: pr.head, overlaps: overlaps.get(pr.number) ?? [] })) : [];
  const gate = task.status === "awaiting_decision" ? checkTogetherGate({ required, files, view, peerFiles, checks, taskHead }) : null;
  return {
    required,
    running: o.checkTogether.running(task.id),
    checks,
    offers,
    // Whether the requirement is met now, for a task that is ready for review: which open pull requests still need a passing, current check.
    waitingOn: gate === null || gate.ok ? [] : gate.waitingOn,
    // Blocked without a pull request to name: the list could not be read, or may be cut. The reason, in words.
    undetermined: gate === null || gate.ok || gate.waitingOn.length > 0 ? null : gate.why,
    viewProblem: view.state === "ready" ? null : view.problem,
  };
}

/** The files a task's committed work changed, as the engine reads them; none when they cannot be read. */
async function changedFiles(task: Task): Promise<string[]> {
  if (task.baseCommit === null || task.headCommit === null) return [];
  return describeCommits({ repo: task.repo, baseCommit: task.baseCommit, headCommit: task.headCommit }).then((files) => files.map((f) => f.path), () => []);
}
