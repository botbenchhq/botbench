import type http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingApprovals, waitingOnApproval } from "../approvals/broker.ts";
import { realRepo, runGrants, showWords } from "../approvals/grants.ts";
import { repositorySettings } from "../config.ts";
import { getRun, preapprovedList, RunError } from "../engine/run.ts";
import { taskEvidence } from "../engine/stations.ts";
import { checkRepository, getTask, listTasks, TaskError, words, type Task } from "../engine/task.ts";
import { describeWork, fileDiff, type FileChange } from "../worktrees.ts";
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
 */
function summary(db: DatabaseSync, task: Task): Record<string, unknown> {
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
    createdAt, updatedAt,
  };
}

/** The files the task changed, from its base commit to the commit Smelt made. Null with the reason when they cannot be read. */
async function changedFiles(task: Task): Promise<{ files: FileChange[] | null; filesProblem: string | null }> {
  if (task.headCommit === null || task.worktreePath === null || task.baseCommit === null) return { files: null, filesProblem: null };
  try {
    return { files: (await describeWork({ path: task.worktreePath, baseCommit: task.baseCommit })).files, filesProblem: null };
  } catch (err) {
    return { files: null, filesProblem: `The task's changes cannot be read: ${words(err)}` };
  }
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

async function diff(res: http.ServerResponse, task: Task, url: URL): Promise<void> {
  const given = url.searchParams.getAll("file");
  if (given.length !== 1) throw new TaskError(400, 'Give one "file": the path of one of the task\'s changed files.');
  const { files, filesProblem } = await changedFiles(task);
  if (files === null) throw new TaskError(409, filesProblem ?? "This task has nothing committed yet.");
  // Only a name git itself listed as changed is ever handed back to git.
  const file = files.find((f) => f.path === given[0]);
  if (!file) throw new TaskError(400, "That file is not one of this task's changed files.");
  const whole = await fileDiff({ path: task.worktreePath!, baseCommit: task.baseCommit!, file: file.path });
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
  try {
    if (method === "POST" && pathname === "/api/tasks") {
      await startTask(req, res, ctx);
    } else if (method === "GET" && pathname === "/api/tasks") {
      json(res, 200, { tasks: listTasks(ctx.db).map((task) => summary(ctx.db, task)) });
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
      if (one[2]) await diff(res, task, url);
      else json(res, 200, { ...summary(ctx.db, task), ...(await changedFiles(task)), evidence: taskEvidence(ctx.db, task.id) });
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof TaskError || err instanceof RunError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
