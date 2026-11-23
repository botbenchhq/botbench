import { issueHostsFor, runIssue, runOutside } from "../engine/intake.ts";
import { issueLink } from "./issues.ts";
import type http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pendingApprovals, waitingOnApproval } from "../approvals/broker.ts";
import { realRepo, runGrants, showWords } from "../approvals/grants.ts";
import { repositoryClaims, repositoryHosts, repositoryProtectedPaths, repositorySettings } from "../config.ts";
import { taskScope, type FileScope } from "../engine/scope.ts";
import { getRun, preapprovedList, RunError } from "../engine/run.ts";
import { runModeOf } from "../engine/modes.ts";
import { loopRecord, NO_ACCOUNT, outcomeLine, parseChecked, parseRefineReply, refineCap, reviewOutcome, taskRefinements } from "../engine/refine.ts";
import { reviewAssignment, taskReviews } from "../engine/review.ts";
import { commandLists, taskEvidence } from "../engine/stations.ts";
import { checkRepository, getTask, listTasks, resumeNote, TaskError, words, type Task } from "../engine/task.ts";
import { beingDecided, decideTask, discardTask, LeftoversError, taskDecision, taskLeftovers, taskRemains, type TaskRemains } from "../engine/decision.ts";
import { deliveryOf } from "../engine/delivery.ts";
import { MAX_NOTE, replacedOne, undeliveredNote, waitingNote } from "../engine/notes.ts";
import { commitsFileDiff, describeCommits, describeWork, type FileChange } from "../worktrees.ts";
import { BodyError, builderOnly, json, modelChoice, readJsonBody, type RouteContext } from "./router.ts";

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
    // For a task waiting for its builder's usage limit: when Botbench tries again, as stored. Null for every other task.
    retryAt: status === "waiting_for_limit" ? task.retryAt : null,
    waitingOnApproval: waitingOnApproval(db, id),
    parked: waiting.some((approval) => approval.parkedAt !== null),
    resuming: pending.length > 0 && waiting.length === 0,
    ofPlan: task.runId !== null && getRun(db, task.runId) !== null ? task.runId : null,
    preapproved: task.runId === null ? [] : runGrants(db, task.runId).map((grant) => showWords(grant.words)),
    // Inherited from its run: it read a GitHub issue, written outside the project (engine/intake.ts).
    outsideText: runOutside(db, task.runId).text,
    issue: ((issue) => (issue === null ? null : issueLink(issue)))(runIssue(db, task.runId)),
    decision: decisionOf(db, task.id),
    pullRequest: deliveryOf(db, task),
    resumeNote: resumeNote(db, task),
    // The owner's note that waits for its builder (engine/notes.ts), with whether it replaced one that waited before it;
    // and the latest note when it was not delivered, with why. Neither is in the transcript: only a delivered note is.
    ...notesOf(db, task.id),
    // The mode of its run (manual for a task started on its own), which says who decides on it.
    mode: runModeOf(db, task.runId),
    // What the refine loop came to, for the decision point: "none", "satisfied", "unaccounted", "unresolved" or "failed", and how many
    // reviews and rounds of fixes there were. Read from the records; once the task is ready for review it is final.
    ...loopCounts(db, task.id),
    createdAt, updatedAt,
  };
}

function notesOf(db: DatabaseSync, taskId: number): { waitingNote: Record<string, unknown> | null; undeliveredNote: Record<string, unknown> | null } {
  const waiting = waitingNote(db, taskId);
  const undelivered = undeliveredNote(db, taskId);
  return {
    waitingNote: waiting === null ? null : { id: waiting.id, text: waiting.text, sentAt: waiting.sentAt, replacedOne: replacedOne(db, waiting) },
    undeliveredNote: undelivered === null ? null : { id: undelivered.id, text: undelivered.text, sentAt: undelivered.sentAt, reason: undelivered.reason },
  };
}

/** POST /api/tasks/:id/notes: the owner's note for a building task's builder, `{ "text": "..." }`. Answers with the note as stored. */
async function sendNote(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, id: number): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (!(err instanceof BodyError)) throw err;
    throw new TaskError(err.status === 413 ? 413 : 400, err.status === 413 ? `The note is too long: ${MAX_NOTE} characters at most.` : "Botbench could not read the note: it was not sent as JSON.");
  }
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  if (!isObject(body) || typeof body.text !== "string") throw new TaskError(400, 'expected { "text": "the note" }');
  json(res, 200, ctx.tasks.sendNote(id, body.text));
}

function loopCounts(db: DatabaseSync, taskId: number): { reviewOutcome: string; reviewRounds: number; refineRounds: number } {
  const assigned = reviewAssignment(db, taskId);
  if (assigned === null) return { reviewOutcome: "none", reviewRounds: 0, refineRounds: 0 };
  const record = loopRecord(db, taskId, assigned.agent);
  return { reviewOutcome: reviewOutcome(record), reviewRounds: record.reviews.length, refineRounds: record.refinements.length };
}

/**
 * Who reviews a task (its run's reviewer, or null), and its review once there is one. The review's text is the reviewer's
 * own words, a model's opinion: shown as text, never acted on.
 */
export function reviewOf(db: DatabaseSync, taskId: number): Record<string, unknown> {
  const assigned = reviewAssignment(db, taskId);
  // Each review and round of fixes, in order. A review's text is read only for the lines under its "Checked:" heading
  // (`checked`), and a finished review with none carries the plain note; the builder's reply only for its two headings.
  const reviews = taskReviews(db, taskId).map(({ taskId: _, ...rest }) => {
    const checked = rest.outcome === "reviewed" ? parseChecked(rest.text) : [];
    return { ...rest, checked, accountNote: rest.outcome === "reviewed" && checked.length === 0 ? `${NO_ACCOUNT}.` : null };
  });
  const review = reviews.at(-1) ?? null;
  const refinements = taskRefinements(db, taskId).map(({ taskId: _, ...rest }) => {
    const parsed = parseRefineReply(rest.reply);
    return { ...rest, addressed: parsed?.addressed ?? null, notAddressed: parsed?.notAddressed ?? null };
  });
  const line = assigned === null ? "" : outcomeLine(loopRecord(db, taskId, assigned.agent));
  return {
    reviewer: assigned === null ? null : { agent: assigned.agent, model: assigned.model },
    review, reviews, refinements,
    maxRefineRounds: assigned === null ? 0 : refineCap(db, taskId),
    reviewLine: line === "" ? null : line,
  };
}

/** A task's decision as a client sees it. */
export function decisionOf(db: DatabaseSync, taskId: number): Record<string, unknown> | null {
  const found = taskDecision(db, taskId);
  if (found === null) return null;
  const { decision, branch, branchName, leftovers, note, decidedBy, reasons, decidedAt } = found;
  return { decision, branch, branchName, leftovers, note, decidedBy, reasons, decidedAt };
}

/**
 * For a task that is ready for review: the files its checks left in its copy that are not on its branch, which a
 * decision would remove with the copy. Null for any other task, and when the copy cannot be read.
 */
export async function leftoversOf(task: Task): Promise<string[] | null> {
  return taskLeftovers(task).catch(() => null);
}

/**
 * The files the task changed, from its base commit to the commit Botbench recorded for it (`headCommit`), read from the
 * repository's own store, as the engine reads them to mark them (engine/task.ts, `changedPaths`): never from whatever
 * the copy's HEAD is now, which a builder may have moved. Null with the reason when they cannot be read, also when an
 * undecided task's copy is gone or is not one Botbench made. A task whose branch was deleted has none to show.
 */
async function changedFiles(db: DatabaseSync, task: Task, remains: TaskRemains | null): Promise<{ files: FileChange[] | null; filesProblem: string | null }> {
  if (task.headCommit === null || task.worktreePath === null || task.baseCommit === null) return { files: null, filesProblem: null };
  // The owner discarded the copy and the branch: there are no changes left to show.
  if (remains?.discardedAt != null) return { files: null, filesProblem: null };
  const decided = taskDecision(db, task.id);
  if (decided?.branch === "deleted") return { files: null, filesProblem: null };
  try {
    const recorded = { repo: task.repo, baseCommit: task.baseCommit, headCommit: task.headCommit };
    if (decided !== null) return { files: await describeCommits(recorded), filesProblem: null };
    // An undecided task's copy must still be the one Botbench made; its files are still those of the recorded commit.
    const work = await describeWork({ path: task.worktreePath, baseCommit: task.baseCommit });
    return { files: work.headCommit === task.headCommit ? work.files : await describeCommits(recorded), filesProblem: null };
  } catch (err) {
    return { files: null, filesProblem: `The task's changes cannot be read: ${words(err)}` };
  }
}

/**
 * The task's changed files, each with its marks (engine/scope.ts): `expected`, when the plan, the checks or the task's
 * tests lead one to expect it, and `protected`, when it lies under a protected path.
 */
async function markedFiles(ctx: RouteContext, task: Task, remains: TaskRemains | null): Promise<{ files: (FileChange & Omit<FileScope, "path">)[] | null; filesProblem: string | null }> {
  const { files, filesProblem } = await changedFiles(ctx.db, task, remains);
  if (files === null) return { files, filesProblem };
  const scope = taskScope(ctx.db, task, files.map((file) => file.path), repositoryProtectedPaths(ctx.config, task.repo));
  return { files: files.map((file, i) => ({ ...file, expected: scope[i]!.expected, protected: scope[i]!.protected })), filesProblem };
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

/**
 * Where an accepted task whose branch was kept would be pushed, for the owner to confirm before "Open a pull request":
 * the remote, its address with any credentials taken out, the GitHub repository and the base branch the settings name.
 * Null for any other task, one whose pull request is open or being opened, and a repository with no such remote.
 */
async function pullRequestTarget(ctx: RouteContext, task: Task): Promise<Record<string, unknown> | null> {
  if (task.status !== "accepted" || taskDecision(ctx.db, task.id)?.branch !== "kept" || ctx.deliveries.busy(task.id)) return null;
  // A delivery that reads as under way while none is (in this process) is offered again, as Try again.
  if (deliveryOf(ctx.db, task).state === "opened") return null;
  return ctx.deliveries.target(task).catch(() => null) as Promise<Record<string, unknown> | null>;
}

/** A task as its own screen shows it: the summary, its changed files, its evidence, what a decision would remove, and what a discard would. */
/**
 * How many of the task's builder sessions came before the one it names now (a build before its rounds of fixes, a
 * session before a restart). Read from the task's own history, where each session it worked in is recorded by number.
 */
function earlierAttempts(db: DatabaseSync, task: Task): number {
  const ids = new Set<number>();
  for (const row of db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND detail LIKE '%attempt %'").all(task.id)) {
    for (const match of String(row.detail).matchAll(/\battempt (\d+)\b/g)) ids.add(Number(match[1]));
  }
  if (task.attemptId !== null) ids.delete(task.attemptId);
  return ids.size;
}

async function detail(ctx: RouteContext, task: Task): Promise<Record<string, unknown>> {
  const { db } = ctx;
  const left = await remainsOf(db, task);
  // `issueHosts`: for a task of a marked run whose owner allowed them, the network hosts its commands may reach.
  return { ...summary(db, task), issueHosts: issueHostsFor(db, task.runId, repositoryHosts(ctx.config, task.repo)), earlierAttempts: earlierAttempts(db, task), ...(await markedFiles(ctx, task, left.remains)), evidence: taskEvidence(db, task.id), commandLists: commandLists(db, task.id), ...reviewOf(db, task.id), leftovers: await leftoversOf(task), ...left, pullRequestTarget: await pullRequestTarget(ctx, task) };
}

async function startTask(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(req);
  // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
  if (!isObject(body) || typeof body.repo !== "string" || typeof body.prompt !== "string" || body.prompt.trim() === "") throw new TaskError(400, 'expected { "repo": "/full/path", "prompt": "...", "model"?: string | null, "preapproved"?: ["command", ...] }');
  // Checked before the repository is looked at, and long before a task row or a worktree exists.
  builderOnly(body);
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
  // The same two commits as the list of files above.
  const whole = await commitsFileDiff({ repo: task.repo, baseCommit: task.baseCommit!, headCommit: task.headCommit!, file: file.path });
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
  const pullRequest = /^\/api\/tasks\/([1-9]\d{0,14})\/pull-request$/.exec(pathname);
  const note = /^\/api\/tasks\/([1-9]\d{0,14})\/notes$/.exec(pathname);
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
      json(res, 200, { path: realRepo(given[0]!), preapproved: repositorySettings(ctx.config, given[0]!).preapproved ?? [], hasChecks: (repositorySettings(ctx.config, given[0]!).checks ?? []).length > 0, claimIssues: repositoryClaims(ctx.config, given[0]!) });
    } else if (method === "GET" && one) {
      const task = getTask(ctx.db, Number(one[1]));
      if (!task) throw new TaskError(404, "No such task.");
      if (one[2]) await diff(ctx.db, res, task, url);
      else json(res, 200, await detail(ctx, task));
    } else if (method === "POST" && decision) {
      const body = await readJsonBody(req);
      if (!isObject(body)) throw new TaskError(400, "expected a JSON object");
      const decided = await decideTask(ctx.db, { taskId: Number(decision[1]), decision: decision[2], branch: body.branch, removeLeftovers: body.removeLeftovers, note: body.note });
      ctx.stream.announceTask(decided.task);
      if (decided.run !== null) {
        ctx.stream.announceRun(decided.run);
        // A run the decision ended may release its issue claim (engine/claims.ts).
        ctx.claims.runChanged(decided.run);
      }
      json(res, 200, await detail(ctx, decided.task));
    } else if (method === "POST" && discard) {
      const body = await readJsonBody(req);
      if (!isObject(body)) throw new TaskError(400, "expected a JSON object");
      const discarded = await discardTask(ctx.db, { taskId: Number(discard[1]), removeFiles: body.removeFiles });
      // Its state is the same; the screens that show it read it again.
      ctx.stream.announceTask(discarded);
      json(res, 200, await detail(ctx, discarded));
    } else if (method === "POST" && resume) {
      const id = Number(resume[1]);
      // A discard at work on the task may be removing its copy: nothing is started in it meanwhile.
      if (beingDecided(id)) throw new TaskError(409, "This task is being discarded, so it cannot be resumed.");
      json(res, 200, await detail(ctx, ctx.tasks.resume(id)));
    } else if (method === "POST" && pullRequest) {
      // The owner's own "Open a pull request" (or "Try again"), naming the remote and branch the confirmation showed.
      const body = await readJsonBody(req);
      if (!isObject(body)) throw new TaskError(400, "expected a JSON object");
      const id = Number(pullRequest[1]);
      ctx.deliveries.deliver(id, { by: "owner", expect: { remote: body.remote, branch: body.branch, address: body.address } });
      json(res, 200, await detail(ctx, getTask(ctx.db, id)!));
    } else if (method === "POST" && note) {
      await sendNote(req, res, ctx, Number(note[1]));
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
