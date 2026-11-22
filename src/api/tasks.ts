import type http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingApprovals, waitingOnApproval } from "../approvals/broker.ts";
import { realRepo, runGrants, showWords } from "../approvals/grants.ts";
import { repositorySettings } from "../config.ts";
import { getRun, preapprovedList, RunError } from "../engine/run.ts";
import { taskEvidence } from "../engine/stations.ts";
import { checkRepository, getTask, listTasks, resumeNote, TaskError, words, type Task } from "../engine/task.ts";
import { beingDecided, decideTask, discardTask, LeftoversError, taskDecision, taskLeftovers, taskRemains, type TaskRemains } from "../engine/decision.ts";
import { commitsFileDiff, describeCommits, describeWork, fileDiff, type FileChange } from "../worktrees.ts";
import { BodyError, json, modelChoice, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const MAX_PROMPT = 20_000;
/** A diff longer than this is cut, and the answer says so: a phone is not sent megabytes for one file. */
export const MAX_DIFF = 400_000;

/**
 * A task as a client sees it: what it was given, where it stands, and the branch and commits its work is on.
 * What it says about approvals is read from the pending approvals, not stored: a task that waits for the owner is still building.
 * `waitingOnApproval`: a request of its agent waits for the owner's answer. `parked`: such a request was asked before a
 * restart, so the agent is stopped and the answer will resume the task. `resuming`: the owner's answer to such a request
 * is stored and the task is being started again to receive it.
 * `ofPlan`: the run it belongs to when it was queued by approving that run's plan, else null.
 * `preapproved`: the commands its run may use without asking, as the owner sent them when starting it, read from the run's grants.
 * `decision`: the owner's decision, once there is one.
 * `resumeNote`: for a stopped task the owner can resume, what Resume will do, in words; null for any other task.
 */
export function summary(db: DatabaseSync, task: Task): Record<string, unknown> {
  const { id, repo, prompt, requestedModel, status, reason, branch, baseCommit, headCommit, attemptId, checks, createdAt, updatedAt } = task;
  const pending = status === "building" ? pendingApprovals(db, id) : [];
  const waiting = pending.filter((approval) => approval.storedDecision === null);
  return {
    id, repo, prompt, requestedModel, status, reason, branch, baseCommit, headCommit, attemptId,
    // What the checks found: "passed", "failed" (one failed or ran out of time), "none" (no checks are set up), or null before.
    checks,
    waitingOnApproval: waitingOnApproval(db, id),
    parked: waiting.some((approval) => approval.parkedAt !== null),
    resuming: pending.length > 0 && waiting.length === 0,
    ofPlan: task.runId !== null && getRun(db, task.runId) !== null ? task.runId : null,
    preapproved: task.runId === null ? [] : runGrants(db, task.runId).map((grant) => showWords(grant.words)),
    decision: decisionOf(db, task.id),
    resumeNote: resumeNote(db, task),
    createdAt, updatedAt,
  };
}

/** A task's decision as a client sees it. */
export function decisionOf(db: DatabaseSync, taskId: number): Record<string, unknown> | null {
  const found = taskDecision(db, taskId);
  if (found === null) return null;
  const { decision, branch, branchName, leftovers, decidedBy, decidedAt } = found;
  return { decision, branch, branchName, leftovers, decidedBy, decidedAt };
}

/**
 * For a task that is ready for review: the files its checks left in its copy that are not on its branch, which a
 * decision would remove with the copy. Null for any other task, and when the copy cannot be read.
 */
export async function leftoversOf(task: Task): Promise<string[] | null> {
  return taskLeftovers(task).catch(() => null);
}

/**
 * The files the task changed, from its base commit to the commit Botbench made. Null with the reason when they cannot
 * be read. A decided task has no copy left: its changes are read from the branch it kept, and a task whose branch was
 * deleted has none to show.
 */
async function changedFiles(db: DatabaseSync, task: Task, remains: TaskRemains | null): Promise<{ files: FileChange[] | null; filesProblem: string | null }> {
  if (task.headCommit === null || task.worktreePath === null || task.baseCommit === null) return { files: null, filesProblem: null };
  // The owner discarded the copy and the branch: there are no changes left to show.
  if (remains?.discardedAt != null) return { files: null, filesProblem: null };
  const decided = taskDecision(db, task.id);
  if (decided?.branch === "deleted") return { files: null, filesProblem: null };
  try {
    if (decided !== null) return { files: await describeCommits({ repo: task.repo, baseCommit: task.baseCommit, headCommit: task.headCommit }), filesProblem: null };
    return { files: (await describeWork({ path: task.worktreePath, baseCommit: task.baseCommit })).files, filesProblem: null };
  } catch (err) {
    return { files: null, filesProblem: `The task's changes cannot be read: ${words(err)}` };
  }
}


/**
 * What a task that failed, was stopped or was cancelled left behind (its copy, its branch, the files in the copy not on
 * the branch) and whether the owner discarded them; null for any other task. Null too when they cannot be read, and
 * then the reason is in `remainsProblem`.
 */
async function remainsOf(db: DatabaseSync, task: Task): Promise<{ remains: TaskRemains | null; remainsProblem: string | null }> {
  try {
    return { remains: await taskRemains(db, task), remainsProblem: null };
  } catch (err) {
    return { remains: null, remainsProblem: `What the task left cannot be read: ${words(err)}` };
  }
}

/** A task as its own screen shows it: the summary, its changed files, its evidence, what a decision would remove, and what a discard would. */
async function detail(db: DatabaseSync, task: Task): Promise<Record<string, unknown>> {
  const left = await remainsOf(db, task);
  return { ...summary(db, task), ...(await changedFiles(db, task, left.remains)), evidence: taskEvidence(db, task.id), leftovers: await leftoversOf(task), ...left };
}

async function startTask(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(req);
  // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
  if (!isObject(body) || typeof body.repo !== "string" || typeof body.prompt !== "string" || body.prompt.trim() === "") throw new TaskError(400, 'expected { "repo": "/full/path", "prompt": "...", "model"?: string | null, "preapproved"?: ["command", ...] }');
  // Checked before the repository is looked at, and long before a task row or a worktree exists.
  const model = modelChoice(body);
  if (body.prompt.length > MAX_PROMPT) throw new TaskError(400, `The prompt is too long: ${MAX_PROMPT} characters at most.`);
  const task = await ctx.tasks.start(body.repo, body.prompt, model, preapprovedList(body.preapproved));
  json(res, 200, { taskId: task.id });
}

/** How many repositories used before the list offers. */
const RECENT_REPOS = 10;

/**
 * The repositories New task and New run offer: the ones used before (a task or a run started in them), the most
 * recently used first and at most ten, then the ones the settings file names that are not already listed.
 */
function knownRepositories(ctx: RouteContext): { name: string; path: string }[] {
  const used = ctx.db.prepare("SELECT repo_path FROM runs GROUP BY repo_path ORDER BY MAX(id) DESC LIMIT ?").all(RECENT_REPOS).map((row) => String(row.repo_path));
  const configured = Object.keys(ctx.config.repositories ?? {}).map(realRepo);
  return [...new Set([...used, ...configured])].map((repo) => ({ name: path.basename(repo), path: repo }));
}

async function diff(db: DatabaseSync, res: http.ServerResponse, task: Task, url: URL): Promise<void> {
  const given = url.searchParams.getAll("file");
  if (given.length !== 1) throw new TaskError(400, 'Give one "file": the path of one of the task\'s changed files.');
  const decided = taskDecision(db, task.id);
  if (decided?.branch === "deleted") throw new TaskError(409, "This task was rejected and its branch was deleted, so its changes are gone.");
  const { files, filesProblem } = await changedFiles(db, task, (await remainsOf(db, task)).remains);
  if (files === null) throw new TaskError(409, filesProblem ?? "This task has nothing committed yet.");
  // Only a name git itself listed as changed is ever handed back to git.
  const file = files.find((f) => f.path === given[0]);
  if (!file) throw new TaskError(400, "That file is not one of this task's changed files.");
  const whole = decided !== null
    ? await commitsFileDiff({ repo: task.repo, baseCommit: task.baseCommit!, headCommit: task.headCommit!, file: file.path })
    : await fileDiff({ path: task.worktreePath!, baseCommit: task.baseCommit!, file: file.path });
  json(res, 200, { file: file.path, diff: whole.slice(0, MAX_DIFF), truncated: whole.length > MAX_DIFF });
}

/**
 * The task routes: start one, list them, describe one, one changed file's diff,
 * and the check of a repository path. Returns false when the request is for
 * none of them. Called only for requests the auth gate let through.
 */
export async function taskRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method;
  // An id is 1 to 15 digits with no leading zero, so it is always a number SQLite stores exactly.
  const one = /^\/api\/tasks\/([1-9]\d{0,14})(\/diff)?$/.exec(pathname);
  const decision = /^\/api\/tasks\/([1-9]\d{0,14})\/(accept|reject)$/.exec(pathname);
  const discard = /^\/api\/tasks\/([1-9]\d{0,14})\/discard$/.exec(pathname);
  const resume = /^\/api\/tasks\/([1-9]\d{0,14})\/resume$/.exec(pathname);
  try {
    if (method === "POST" && pathname === "/api/tasks") {
      await startTask(req, res, ctx);
    } else if (method === "GET" && pathname === "/api/tasks") {
      json(res, 200, { tasks: listTasks(ctx.db).map((task) => summary(ctx.db, task)) });
    } else if (method === "GET" && pathname === "/api/repos") {
      json(res, 200, { repositories: knownRepositories(ctx) });
    } else if (method === "GET" && pathname === "/api/repos/check") {
      const given = url.searchParams.getAll("path");
      if (given.length !== 1) throw new TaskError(400, 'Give one "path".');
      // Answers about the one path given, in words; it lists nothing.
      const answer = await checkRepository(given[0]).then(
        (repo) => ({ usable: true, path: repo, reason: null }),
        (err: unknown) => {
          if (!(err instanceof TaskError)) throw err;
          return { usable: false, path: given[0], reason: err.message };
        },
      );
      json(res, 200, answer);
    } else if (method === "GET" && pathname === "/api/repos/settings") {
      const given = url.searchParams.getAll("path");
      if (given.length !== 1 || given[0]!.includes("\0") || !path.isAbsolute(given[0]!)) throw new TaskError(400, 'Give one "path": the full path of a repository, starting with /.');
      // What the owner's config offers for this repository. It grants nothing: a task gets only what its own start request lists.
      json(res, 200, { path: realRepo(given[0]!), preapproved: repositorySettings(ctx.config, given[0]!).preapproved ?? [] });
    } else if (method === "GET" && one) {
      const task = getTask(ctx.db, Number(one[1]));
      if (!task) throw new TaskError(404, "No such task.");
      if (one[2]) await diff(ctx.db, res, task, url);
      else json(res, 200, await detail(ctx.db, task));
    } else if (method === "POST" && decision) {
      const body = await readJsonBody(req);
      if (!isObject(body)) throw new TaskError(400, "expected a JSON object");
      const decided = await decideTask(ctx.db, { taskId: Number(decision[1]), decision: decision[2], branch: body.branch, removeLeftovers: body.removeLeftovers });
      ctx.stream.announceTask(decided.task);
      if (decided.run !== null) ctx.stream.announceRun(decided.run);
      json(res, 200, await detail(ctx.db, decided.task));
    } else if (method === "POST" && discard) {
      const body = await readJsonBody(req);
      if (!isObject(body)) throw new TaskError(400, "expected a JSON object");
      const discarded = await discardTask(ctx.db, { taskId: Number(discard[1]), removeFiles: body.removeFiles });
      // Its state is the same; the screens that show it read it again.
      ctx.stream.announceTask(discarded);
      json(res, 200, await detail(ctx.db, discarded));
    } else if (method === "POST" && resume) {
      const id = Number(resume[1]);
      // A discard at work on the task may be removing its copy: nothing is started in it meanwhile.
      if (beingDecided(id)) throw new TaskError(409, "This task is being discarded, so it cannot be resumed.");
      json(res, 200, await detail(ctx.db, ctx.tasks.resume(id)));
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof LeftoversError) json(res, err.status, { error: err.message, leftovers: err.leftovers });
    else if (err instanceof BodyError || err instanceof TaskError || err instanceof RunError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
