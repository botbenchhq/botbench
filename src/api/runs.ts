import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { waitingOnApproval } from "../approvals/broker.ts";
import { runGrants, showWords } from "../approvals/grants.ts";
import { commandLists, taskEvidence } from "../engine/stations.ts";
import { getRun, listRuns, planTasks, RunError, runTasks, runWaitingOnApproval, type Run } from "../engine/run.ts";
import { BodyError, json, modelChoice, readJsonBody, type RouteContext } from "./router.ts";
import { resumeNote } from "../engine/task.ts";
import { decisionOf, leftoversOf } from "./tasks.ts";
import { deliveryOf } from "../engine/delivery.ts";
import { runIssue } from "../engine/intake.ts";
import { issueLink } from "./issues.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What a run is called in a list: the first line of what it was given, without a markdown heading's marks; for a run from an issue with no message, the issue. */
function title(db: DatabaseSync, run: Run): string {
  const issue = run.prompt === null && run.specText === null ? runIssue(db, run.id) : null;
  const line = issue !== null ? `Issue #${issue.number}: ${issue.title}` : (run.prompt ?? run.specText ?? "").trim().split("\n")[0]!.replace(/^#+\s*/, "").trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** Whether something of the run waits for the owner's answer: its planner's request while planning, or a builder's while building. */
const waiting = (db: DatabaseSync, run: Run): boolean =>
  (run.status === "planning" && runWaitingOnApproval(db, run.id)) || (run.status === "running" && runTasks(db, run.id).some((task) => task.status === "building" && waitingOnApproval(db, task.id)));
const AT_WORK = new Set(["queued", "building", "verifying", "reviewing"]);

/** A run as a list shows it. `readyCount` and `decidedCount`: how many of its tasks are ready for review, and decided. */
export function summary(db: DatabaseSync, run: Run): Record<string, unknown> {
  const { id, repo, status, reason, attemptId, mode, createdAt, updatedAt } = run;
  const tasks = runTasks(db, id);
  const finishedCount = tasks.filter((task) => !AT_WORK.has(task.status)).length;
  const readyCount = tasks.filter((task) => task.status === "awaiting_decision").length;
  const decidedCount = tasks.filter((task) => task.status === "accepted" || task.status === "rejected").length;
  return { id, repo, title: title(db, run), status, reason, attemptId, mode, outsideText: run.outsideText, taskCount: planTasks(db, id).length, finishedCount, readyCount, decidedCount, waitingOnApproval: waiting(db, run), createdAt, updatedAt };
}

/**
 * A run as its own screen shows it: what it was given, where it stands, its plan, the tasks approved from the plan,
 * and the commands its builders may use without asking, read from the run's grants. Everything a planner wrote
 * (titles, criteria) is text, to be shown as text.
 */
async function detail(db: DatabaseSync, run: Run): Promise<Record<string, unknown>> {
  const { id, repo, prompt, specPath, specText, status, reason, requestedModel, plannerModel, buildModel, baseCommit, attemptId, planVersion, reviewer, mode, delivery, maxRefineRounds, outsideText, outsideHosts, createdAt, updatedAt } = run;
  const plan = planTasks(db, id);
  const issue = runIssue(db, id);
  const titles = new Map(plan.map((task) => [task.taskId, task.title]));
  return {
    id, repo, prompt, specPath, specText, title: title(db, run), status, reason, requestedModel, plannerModel, ...(buildModel === undefined ? {} : { buildModel }), baseCommit, attemptId, planVersion, reviewer, mode, delivery, maxRefineRounds,
    // The issue the run was started from, and whether it is marked as having read outside text (engine/intake.ts).
    issue: issue === null ? null : issueLink(issue), outsideText, outsideHosts,
    plan: plan.map((task) => ({ title: task.title, criteria: task.criteria })),
    // Each task with where it stands and the commands Botbench ran on it; its transcript and diff are on its own route.
    // A task that is ready for review lists the files its checks left in its copy, which a decision would remove.
    tasks: await Promise.all(runTasks(db, id).map(async (task) => ({
      id: task.id, status: task.status, title: titles.get(task.id) ?? task.prompt.split("\n")[0]!, reason: task.reason, attemptId: task.attemptId, branch: task.branch, checks: task.checks,
      waitingOnApproval: task.status === "building" && waitingOnApproval(db, task.id),
      evidence: taskEvidence(db, task.id), commandLists: commandLists(db, task.id),
      decision: decisionOf(db, task.id),
      pullRequest: deliveryOf(db, task),
      leftovers: await leftoversOf(task),
      resumeNote: resumeNote(db, task),
    }))),
    preapproved: runGrants(db, id).map((grant) => showWords(grant.words)),
    waitingOnApproval: waiting(db, run),
    createdAt, updatedAt,
  };
}

// voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
const EXPECTED = 'expected { "repo": "/full/path", "prompt": "..." or "specPath": "/full/path.md", "model"?: string | null, "buildModel"?: string | null, "preapproved"?: ["command", ...], "reviewer"?: null | { "agent": "codex" | "grok" | "antigravity", "model": string | null }, "mode"?: "manual" | "semi" | "full", "delivery"?: "branch" | "pull_request", "issue"?: null | { "fetchId": number, "allowHosts": boolean } }';

/**
 * The run routes: start one, list them, describe one, and the owner's decisions at the plan gate (edit, approve,
 * request changes, cancel). Returns false when the request is for none of them. Called only for requests the auth
 * gate let through, which is the only way a plan is ever approved.
 */
export async function runRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method;
  // An id is 1 to 15 digits with no leading zero, so it is always a number SQLite stores exactly.
  const one = /^\/api\/runs\/([1-9]\d{0,14})(\/plan|\/plan\/approve|\/plan\/request-changes|\/cancel)?$/.exec(pathname);
  try {
    if (method === "POST" && pathname === "/api/runs") {
      const body = await readJsonBody(req);
      if (!isObject(body) || typeof body.repo !== "string") throw new RunError(400, EXPECTED);
      // Checked before the repository or a file is looked at, and long before a run row or a worktree exists.
      const model = modelChoice(body);
      const run = await ctx.runs.start({ repo: body.repo, prompt: body.prompt, specPath: body.specPath, ...(model === undefined ? {} : { model }), ...(body.buildModel === undefined ? {} : { buildModel: body.buildModel }), preapproved: body.preapproved, reviewer: body.reviewer, ...(body.mode === undefined ? {} : { mode: body.mode }), delivery: body.delivery, issue: body.issue });
      json(res, 200, { runId: run.id });
    } else if (method === "GET" && pathname === "/api/runs") {
      json(res, 200, { runs: listRuns(ctx.db).map((run) => summary(ctx.db, run)) });
    } else if (one) {
      const id = Number(one[1]);
      const action = one[2] ?? "";
      if (method === "GET" && action === "") {
        const run = getRun(ctx.db, id);
        if (!run) throw new RunError(404, "No such run.");
        json(res, 200, await detail(ctx.db, run));
      } else if ((method === "PATCH" && action === "/plan") || (method === "POST" && action !== "" && action !== "/plan")) {
        // Every decision is a whole JSON request, and each names the plan it was made on.
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new RunError(400, "expected a JSON object");
        if (action === "/plan") ctx.runs.editPlan(id, body.tasks, body.planVersion);
        else if (action === "/plan/approve") ctx.runs.approve(id, body.planVersion);
        else if (action === "/plan/request-changes") ctx.runs.requestChanges(id, body.feedback, body.planVersion);
        else ctx.runs.cancel(id);
        json(res, 200, await detail(ctx.db, getRun(ctx.db, id)!));
      } else {
        return false;
      }
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof RunError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
