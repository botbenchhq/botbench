import { DEFAULT_MAX_REFINE_ROUNDS } from "./refine.ts";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { permissionResponse, type Admission, type Broker } from "../approvals/broker.ts";
import { summarize } from "../approvals/gate.ts";
import { entryProblem, insertPreapproved, MAX_ENTRIES, realRepo } from "../approvals/grants.ts";
import type { Driver, DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";
import { now, transaction } from "../store/db.ts";
import { createPlanningWorktree, removePlanningWorktree, sharedGitDir, sourceHead } from "../worktrees.ts";
import { stopSurvivor } from "./recover.ts";
import { confirmGroupGone, durationWords, plannerSilenceReason, SILENCE_LIMIT_MS, watchSilence, type StoppedDuring } from "./silence.ts";
import { agentName, correctionPrompt, IMPLEMENTER, mergePlan, oneTaskPrompt, parsePlan, PLANNER, plannerPrompt, REVIEWER, roleProblem, sameModelProblem, taskPrompt, validatePlan, type PlanTask, type RoleChoice } from "./roles.ts";
import { DRIVER_NAMES } from "../config.ts";
import { confinementProblem } from "../confinement.ts";
import { isRunMode, MODE_WORDS, planApprovedByMode, stricterModes, type RunMode } from "./modes.ts";
import type { StationCommand } from "./stations.ts";
import { modelNameProblem } from "../drivers/contract.ts";
import { checkRepository, getTask, insertQueuedTask, moveTaskIn, TaskError, words, type Task, type Tasks } from "./task.ts";
import { issueFetch, outsideTextPrompt, runIssue } from "./intake.ts";
import { LIMIT_CANCELLED } from "./usage-limit.ts";
import { isOnLimit, type OnLimit } from "./handoff.ts";
import { learningsSection } from "./learnings.ts";
import { memorySection } from "./memory.ts";
import { messageIssue, takeOverGiven, type ClaimName } from "./claim-branch.ts";
import { ownWorkbenches } from "../workbench.ts";
import { checkSource, noteProblem, sourceGiven, sourcePrompt, type RunSource } from "./run-source.ts";

/*
 * Runs and the plan gate. A run is a piece of work the owner gave as a prompt or a spec file, against one repository.
 * A planner turns it into tasks, the owner edits and approves them, and only then do task rows exist.
 *
 *   planning ──▶ awaiting_plan_approval ──▶ running ──▶ awaiting_decision ──▶ done   (done once every built task is decided)
 *      │   ◀── request changes ──┘   │           │
 *      ▼                             ▼           ▼
 *   failed, cancelled             cancelled   cancelled                      (the task at work is stopped; the rest are not built)
 *
 * The planner is read-only. It works in a detached worktree of the run's base commit under the Botbench home, never in
 * the owner's checkout; the driver starts it without any tool that writes; every shell command it wants goes to the
 * owner through the gate under the planner role, where no grant applies, unless it is a confined one the floor does not
 * name, which runs (approvals/gate.ts). A fully autonomous run's plan is approved by the mode as soon as it is stored,
 * and so is a semi-autonomous run's, unless it read outside text (engine/modes.ts, `planApprovedByMode`). The worktree is removed when planning ends,
 * however it ends. What the planner replies is data: it is validated and stored as text.
 */

export type RunStatus = "planning" | "awaiting_plan_approval" | "running" | "awaiting_decision" | "done" | "cancelled" | "failed";

export interface Run {
  id: number;
  /** The repository's real path, as it was when the run was started. */
  repo: string;
  /** What the owner asked for, when it was given as a prompt. */
  prompt: string | null;
  /** The spec file the run was started from, by its real path, and its text as it was read then. */
  specPath: string | null;
  specText: string | null;
  status: RunStatus;
  /** Why the run failed, or why its plan is as it was after the planner was asked to change it. */
  reason: string | null;
  /** The model asked for the planner. Null means the CLI's own default. */
  requestedModel: string | null;
  /** The model that answered as the planner, from its session. */
  plannerModel: string | null;
  /**
   * The model the run's tasks are built on, chosen when it starts: a name, or null for the agent's own default.
   * Undefined for a run started before a run recorded one, whose tasks took the configured model.
   */
  buildModel?: string | null;
  /** The agent the run's tasks are built by, chosen when it starts: "codex", or null for the main agent. */
  buildAgent: string | null;
  /** The commit the plan was made from. */
  baseCommit: string;
  /** The newest planner attempt: its events are the planner's transcript. */
  attemptId: number | null;
  /** The agent and model that review each built task, chosen when the run was started; null when nobody reviews. */
  reviewer: RoleChoice | null;
  /** How much the run does without the owner, chosen when it was started and never changed (engine/modes.ts). */
  mode: RunMode;
  /** What becomes of each task it accepts, chosen when the run was started: its branch is kept, or pushed and opened as a pull request. */
  delivery: Delivery;
  /** How many rounds of fixes the builder may be asked for after a review with concerns, set when the run started (engine/refine.ts). */
  maxRefineRounds: number;
  /** Counts the plan's changes. An edit or an approval names the version it saw and is refused when the plan has moved on. */
  planVersion: number;
  /** The GitHub issue the run was started from, by the id of the fetch the owner was shown (engine/intake.ts); null for none. */
  issueFetchId: number | null;
  /** The run read text from outside the project, so no grant applies to its commands and it is never fully autonomous. */
  outsideText: boolean;
  /** The owner let the commands of this marked run reach the repository's allowed network hosts all the same. */
  outsideHosts: boolean;
  /**
   * The run is kept to one task, chosen when it started and never changed: its planner is asked for one; a plan of
   * several is sent back once, and one that still holds several is merged by Botbench (`mergePlan`).
   */
  oneTask: boolean;
  /**
   * How many minutes an approval of the run waits for the owner before Botbench denies it (approvals/broker.ts), chosen
   * when it started and never changed; null for no limit, as for every run started before there was one.
   */
  approvalLimitMinutes: number | null;
  /** What a builder's usage limit does in this run, chosen when it started and never changed: wait for the reset, or switch to the next agent (engine/handoff.ts). */
  onLimit: OnLimit;
  /** The finished task or the chat the owner made this run from ("Make this a run", engine/run-source.ts); null for a run started any other way. Never changed. */
  source: RunSource | null;
  createdAt: string;
  updatedAt: string;
}

/** One task of a run's plan as stored. `taskId` is the task made from it once the plan is approved. */
export type Delivery = "branch" | "pull_request";

/** The delivery a request names: "branch" when it names none. Anything else is refused with the reason, before anything exists. */
export function deliveryChoice(given: unknown): Delivery {
  if (given === undefined || given === null || given === "branch") return "branch";
  if (given === "pull_request") return "pull_request";
  // voice: not on screen. It names the API's own field and values for a caller whose request was malformed; the client never sends one.
  throw new RunError(400, '"delivery" must be "branch" (keep the branch) or "pull_request" (open a pull request).');
}

export interface StoredPlanTask extends PlanTask {
  position: number;
  taskId: number | null;
}

/** A request about a run that cannot be met; `status` is the HTTP answer for it. */
export class RunError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" ? v : null);

function toRun(row: Record<string, unknown>): Run {
  return {
    id: Number(row.id),
    repo: String(row.repo_path),
    // A run started from an issue with no message of the owner's own stores an empty prompt (the table's own check asks for one).
    prompt: row.prompt === "" ? null : text(row.prompt),
    specPath: text(row.spec_path),
    specText: text(row.spec_text),
    status: String(row.status) as RunStatus,
    reason: text(row.reason),
    requestedModel: text(row.requested_model),
    plannerModel: text(row.planner_model),
    ...(row.build_model_set === 1 ? { buildModel: text(row.build_model) } : {}),
    buildAgent: text(row.build_agent),
    baseCommit: String(row.base_commit),
    attemptId: int(row.attempt_id),
    planVersion: Number(row.plan_version),
    reviewer: typeof row.reviewer_agent === "string" ? { agent: row.reviewer_agent, model: text(row.reviewer_model) } : null,
    mode: isRunMode(row.mode) ? row.mode : "manual",
    delivery: row.delivery === "pull_request" ? "pull_request" : "branch",
    maxRefineRounds: Number(row.max_refine_rounds ?? 0),
    issueFetchId: int(row.issue_fetch_id),
    outsideText: row.outside_text === 1,
    outsideHosts: row.outside_hosts === 1,
    oneTask: row.one_task === 1,
    approvalLimitMinutes: int(row.approval_limit_minutes),
    onLimit: isOnLimit(row.on_limit) ? row.on_limit : "wait",
    source: row.source_task_id != null ? { kind: "task", id: Number(row.source_task_id) } : row.source_chat_id != null ? { kind: "chat", id: Number(row.source_chat_id) } : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** A planned run by its id. The run of one that a task started on its own is has no state and is not one of these. */
export function getRun(db: DatabaseSync, id: number): Run | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ? AND kind = 'planned'").get(id);
  return row ? toRun(row) : null;
}

/** The newest planned runs, newest first. */
export function listRuns(db: DatabaseSync, limit = 200): Run[] {
  return db.prepare("SELECT * FROM runs WHERE kind = 'planned' ORDER BY id DESC LIMIT ?").all(limit).map(toRun);
}

/** A run's plan, in order. Criteria that do not read as a list of text are no criteria. */
export function planTasks(db: DatabaseSync, runId: number): StoredPlanTask[] {
  return db.prepare("SELECT * FROM plan_tasks WHERE run_id = ? ORDER BY position").all(runId).map((row) => {
    let criteria: unknown;
    try {
      criteria = JSON.parse(String(row.criteria));
    } catch {
      criteria = [];
    }
    return { position: Number(row.position), title: String(row.title), criteria: Array.isArray(criteria) ? criteria.filter((c): c is string => typeof c === "string") : [], taskId: int(row.task_id) };
  });
}

/** The tasks made from a run's plan, in plan order. */
export function runTasks(db: DatabaseSync, runId: number): Task[] {
  return db.prepare("SELECT id FROM tasks WHERE run_id = ? ORDER BY id").all(runId).map((row) => getTask(db, Number(row.id))!);
}

/** Whether a request of the run's planner waits for the owner's answer. */
export function runWaitingOnApproval(db: DatabaseSync, runId: number): boolean {
  return db.prepare("SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending' AND stored_decision IS NULL LIMIT 1").get(runId) !== undefined;
}

const insertEvent = (db: DatabaseSync, id: number, at: string, status: RunStatus, detail: string | null): void => {
  db.prepare("INSERT INTO run_events (run_id, ts, status, detail) VALUES (?, ?, ?, ?)").run(id, at, status, detail);
};

/**
 * Store a new run as planning. The row, the grants for the commands the owner pre-approved for the run's builders,
 * and the run's first event are written together: none exists without the others. The grants are the implementer's:
 * the planner has none. Throws for a pre-approved command that cannot be a grant, and then nothing is written.
 */
export function createRun(db: DatabaseSync, o: { repo: string; builder?: string | null; prompt?: string; spec?: { path: string; text: string }; issue?: { fetchId: number; allowHosts: boolean }; requestedModel?: string | null; buildModel?: string | null; baseCommit: string; preapproved?: readonly string[]; reviewer?: RoleChoice | null; mode?: RunMode; delivery?: Delivery; maxRefineRounds?: number; oneTask?: boolean; onLimit?: OnLimit; takeOver?: readonly ClaimName[]; source?: RunSource; approvalLimitMinutes?: number | null }): Run {
  // From a prompt or a spec file, one of the two; or from an issue, with or without a prompt of the owner's own.
  if (o.issue !== undefined ? o.spec !== undefined : (o.prompt === undefined) === (o.spec === undefined)) throw new Error("A run is started from a prompt or from a spec file, one of the two, or from an issue with or without a prompt.");
  return transaction(db, () => {
    const at = now();
    // Kept by its real path as it is now: grants compare this stored path, so a link pointed elsewhere later carries no trust along.
    const repo = realRepo(o.repo);
    const id = Number(
      db
        .prepare("INSERT INTO runs (kind, repo_path, prompt, spec_path, spec_text, status, requested_model, build_model, build_model_set, build_agent, base_commit, reviewer_agent, reviewer_model, mode, delivery, max_refine_rounds, issue_fetch_id, outside_text, outside_hosts, one_task, on_limit, source_task_id, source_chat_id, approval_limit_minutes, created_at, updated_at) VALUES ('planned', ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(repo, o.prompt ?? (o.issue !== undefined && o.spec === undefined ? "" : null), o.spec?.path ?? null, o.spec?.text ?? null, o.requestedModel ?? null, o.buildModel ?? null, o.buildModel === undefined ? 0 : 1, o.builder ?? null, o.baseCommit, o.reviewer?.agent ?? null, o.reviewer?.model ?? null, o.mode ?? "manual", o.delivery ?? "branch", o.maxRefineRounds ?? DEFAULT_MAX_REFINE_ROUNDS, o.issue?.fetchId ?? null, o.issue === undefined ? 0 : 1, o.issue?.allowHosts === true ? 1 : 0, o.oneTask === true ? 1 : 0, o.onLimit ?? "wait", o.source?.kind === "task" ? o.source.id : null, o.source?.kind === "chat" ? o.source.id : null, o.approvalLimitMinutes ?? null, at, at).lastInsertRowid,
    );
    insertPreapproved(db, { role: IMPLEMENTER, repo, runId: id, taskId: null, commands: o.preapproved ?? [] });
    // Stored with the run, so its claim (engine/claims.ts), which starts once the run is announced, already sees them.
    for (const c of o.takeOver ?? []) db.prepare("INSERT INTO claim_takeovers (run_id, branch, holder, issue, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, c.branch, c.workbench, c.issue, c.startedAt, at);
    insertEvent(db, id, at, "planning", null);
    return getRun(db, id)!;
  });
}

function known(db: DatabaseSync, id: number): Run {
  const run = getRun(db, id);
  if (!run) throw new RunError(404, "No such run.");
  return run;
}

/** Why a run that is not waiting for the owner's approval cannot have `what` done to its plan. */
function notWaiting(run: Run, what: string): RunError {
  if (run.status === "planning") return new RunError(409, `Run ${run.id} is still being planned, so there is no plan to ${what} yet.`);
  if (run.status === "cancelled") return new RunError(409, `Run ${run.id} was cancelled, so its plan cannot be ${what === "approve" ? "approved" : "changed"}.`);
  if (run.status === "failed") return new RunError(409, `Run ${run.id} failed before it had a plan.`);
  return new RunError(409, `Run ${run.id}'s plan is already approved, so it cannot be ${what === "approve" ? "approved again" : "changed"}.`);
}

/** The plan version a request names must be the plan's own: a window that shows an older plan changes and approves nothing. */
function sameVersion(run: Run, given: unknown): void {
  if (given !== run.planVersion) throw new RunError(409, "The plan changed since this window read it. Read the run again, then decide.");
}
function versionGiven(given: unknown): void {
  if (typeof given !== "number" || !Number.isSafeInteger(given) || given < 0) throw new RunError(400, '"planVersion" must be the plan\'s version number, as the run gave it when it was read.');
}

interface RunChange {
  detail?: string | null;
  /** Sets the reason; null clears it. */
  reason?: string | null;
  plannerModel?: string | null;
  attemptId?: number;
  /** The plan itself changed: the version moves on. */
  planChanged?: boolean;
}

/** Write a run's state with what came with it, and its event, inside the caller's transaction. */
function writeRun(db: DatabaseSync, id: number, to: RunStatus, change: RunChange = {}): void {
  const at = now();
  const sets = ["status = ?", "updated_at = ?"];
  const values: (string | number | null)[] = [to, at];
  if (change.reason !== undefined) (sets.push("reason = ?"), values.push(change.reason));
  if (change.plannerModel !== undefined && change.plannerModel !== null) (sets.push("planner_model = ?"), values.push(change.plannerModel));
  if (change.attemptId !== undefined) (sets.push("attempt_id = ?"), values.push(change.attemptId));
  if (change.planChanged) sets.push("plan_version = plan_version + 1");
  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  insertEvent(db, id, at, to, change.detail ?? (typeof change.reason === "string" ? change.reason : null));
}

function replacePlan(db: DatabaseSync, runId: number, tasks: readonly PlanTask[]): void {
  db.prepare("DELETE FROM plan_tasks WHERE run_id = ?").run(runId);
  const insert = db.prepare("INSERT INTO plan_tasks (run_id, position, title, criteria) VALUES (?, ?, ?, ?)");
  for (const [i, task] of tasks.entries()) insert.run(runId, i + 1, task.title, JSON.stringify(task.criteria));
}

const tasksWord = (n: number): string => `${n} ${n === 1 ? "task" : "tasks"}`;
/** Why a plan of a run kept to one task cannot hold `n` tasks. */
const ONE_TASK_ONLY = (n: number): string => `This run is kept to one task, so its plan holds exactly 1 task; this one holds ${tasksWord(n)}. Put the work in one task.`;

/**
 * The planner's plan arrived: store it and wait for the owner. Only a run that is being planned takes a plan; a
 * plan that arrives for a run cancelled in the meantime is refused and nothing is stored.
 */
export function storePlan(db: DatabaseSync, runId: number, tasks: readonly PlanTask[], o: { plannerModel?: string | null; note?: string | null } = {}): Run {
  return transaction(db, () => {
    const run = known(db, runId);
    if (run.status !== "planning") throw notWaiting(run, "store");
    const checked = validatePlan({ tasks }, { oneTask: run.oneTask });
    if (!checked.ok) throw new Error(`The plan cannot be stored: ${checked.errors.join(" ")}`);
    if (run.oneTask && checked.tasks.length !== 1) throw new Error(`The plan cannot be stored: ${ONE_TASK_ONLY(checked.tasks.length)}`);
    replacePlan(db, runId, checked.tasks);
    writeRun(db, runId, "awaiting_plan_approval", { reason: o.note ?? null, plannerModel: o.plannerModel ?? null, planChanged: true, detail: `plan of ${tasksWord(checked.tasks.length)}${o.note ? `; ${o.note}` : ""}` });
    return getRun(db, runId)!;
  });
}

/**
 * The owner's edit of a plan that waits for approval: the whole list as it should be, which is how a title or a
 * criterion is changed, a task added and a task deleted. Validated like a planner's plan; refused once the plan is approved.
 */
export function editPlan(db: DatabaseSync, runId: number, tasks: unknown, planVersion: unknown): Run {
  return transaction(db, () => {
    const run = known(db, runId);
    versionGiven(planVersion);
    if (run.status !== "awaiting_plan_approval") throw notWaiting(run, "edit");
    sameVersion(run, planVersion);
    const checked = validatePlan({ tasks }, { oneTask: run.oneTask });
    if (!checked.ok) throw new RunError(400, checked.errors.join(" "));
    if (run.oneTask && checked.tasks.length !== 1) throw new RunError(400, ONE_TASK_ONLY(checked.tasks.length));
    replacePlan(db, runId, checked.tasks);
    writeRun(db, runId, "awaiting_plan_approval", { planChanged: true, detail: `plan edited by the owner: ${tasksWord(checked.tasks.length)}` });
    return getRun(db, runId)!;
  });
}

/**
 * The owner approves the plan as it stands: one queued task row per plan task, each naming the run, and the run is
 * running. All in one write. The tasks are queued on the run's build model; a run that recorded none takes
 * `implementerModel`, the configured one. No worktree is made here: building a task is the build station's. `by` "mode"
 * is a fully autonomous run, or a semi-autonomous one that read no outside text, approving its own plan as the planner
 * gave it; only such a run's plan is approved that way.
 */
export function approvePlan(db: DatabaseSync, runId: number, planVersion: unknown, implementerModel: string | null = null, by: "owner" | "mode" = "owner"): { run: Run; tasks: Task[] } {
  return transaction(db, () => {
    const run = known(db, runId);
    versionGiven(planVersion);
    if (run.status !== "awaiting_plan_approval") throw notWaiting(run, "approve");
    sameVersion(run, planVersion);
    if (by === "mode" && !planApprovedByMode(run)) throw new RunError(409, `Run ${run.id} is ${MODE_WORDS[run.mode]}${run.outsideText ? " and was started from a GitHub issue" : ""}, so its plan waits for your approval.`);
    const plan = planTasks(db, runId);
    // What is approved is checked once more as it is stored: nothing reaches a builder that a plan may not hold.
    const checked = validatePlan({ tasks: plan.map(({ title, criteria }) => ({ title, criteria })) }, { oneTask: run.oneTask });
    if (!checked.ok) throw new RunError(409, `The plan cannot be approved as it is: ${checked.errors.join(" ")}`);
    if (run.oneTask && checked.tasks.length !== 1) throw new RunError(409, `The plan cannot be approved as it is: ${ONE_TASK_ONLY(checked.tasks.length)}`);
    const link = db.prepare("UPDATE plan_tasks SET task_id = ? WHERE run_id = ? AND position = ?");
    const tasks = plan.map((task) => {
      const made = insertQueuedTask(db, { runId, repo: run.repo, prompt: taskPrompt(task), requestedModel: run.buildModel === undefined ? implementerModel : run.buildModel, builderAgent: run.buildAgent });
      link.run(made, runId, task.position);
      return made;
    });
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    writeRun(db, runId, "running", { reason: null, planChanged: true, detail: `plan approved ${by === "owner" ? "by the owner" : `by the run's mode, ${MODE_WORDS[run.mode]}`}: ${tasksWord(tasks.length)} queued` });
    return { run: getRun(db, runId)!, tasks: tasks.map((id) => getTask(db, id)!) };
  });
}

/**
 * The owner cancels a run that is being planned, waits for approval, or is building. The run and its tasks that have
 * not started are cancelled in one write; the task being built, if any, is stopped by the build line, which then
 * records it. Tasks that have finished are left as they are, with their branches.
 */
export function cancelRun(db: DatabaseSync, runId: number, by = "cancelled by the owner"): Run {
  return transaction(db, () => {
    const run = known(db, runId);
    if (run.status === "cancelled") throw new RunError(409, `Run ${run.id} was already cancelled.`);
    if (run.status === "failed") throw new RunError(409, `Run ${run.id} failed, so there is nothing to cancel.`);
    if (run.status === "awaiting_decision" || run.status === "done") throw new RunError(409, `Run ${run.id}'s tasks have all been built, so there is nothing left to cancel.`);
    writeRun(db, runId, "cancelled", { detail: by });
    for (const row of db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'queued' ORDER BY id").all(runId)) {
      moveTaskIn(db, Number(row.id), "cancelled", { reason: "The run was cancelled before this task started." });
    }
    // A task waiting for a usage limit has nothing at work and its work is committed: it ends here, in the same write,
    // so no restart can find it waiting under a cancelled run, and it is never resumed.
    for (const row of db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'waiting_for_limit' ORDER BY id").all(runId)) {
      moveTaskIn(db, Number(row.id), "cancelled", { reason: LIMIT_CANCELLED });
    }
    return getRun(db, runId)!;
  });
}

/**
 * The owner makes a run's mode stricter while it has not finished: fully autonomous to semi-autonomous or manual,
 * semi-autonomous to manual. The mode and the history's record of the owner's change, naming both modes, are written
 * together. Nothing else is touched: a request waiting for the owner stays, a turn under way finishes, and from the
 * next request and the next result on, the broker and the engine read the new mode from the store (engine/modes.ts).
 * Throws for a mode that is none of the three (400), a run that does not exist (404), one that has finished, and the
 * same or a looser mode (409); then nothing is written.
 */
export function tightenMode(db: DatabaseSync, runId: number, given: unknown): Run {
  const mode = modeChoice(given);
  return transaction(db, () => {
    const run = known(db, runId);
    if (run.status === "done" || run.status === "cancelled" || run.status === "failed") throw new RunError(409, `Run ${run.id} has finished, so its mode can no longer be changed.`);
    if (mode === run.mode) throw new RunError(409, `Run ${run.id} is already ${MODE_WORDS[mode]}.`);
    if (!stricterModes(run.mode, run.status).includes(mode)) throw new RunError(409, `Run ${run.id} is ${MODE_WORDS[run.mode]}. A run's mode can be made stricter while it works, never looser, so it cannot become ${MODE_WORDS[mode]}.`);
    const at = now();
    db.prepare("UPDATE runs SET mode = ?, updated_at = ? WHERE id = ?").run(mode, at, runId);
    // voice: not on screen. A note in the stored history of the run; the run screen says it from `modeChanges`.
    db.prepare("INSERT INTO run_events (run_id, ts, status, detail, actor, mode_from, mode_to) VALUES (?, ?, ?, ?, 'owner', ?, ?)").run(runId, at, run.status, `mode changed by the owner from ${MODE_WORDS[run.mode]} to ${MODE_WORDS[mode]}`, run.mode, mode);
    return getRun(db, runId)!;
  });
}

const MAX_PATH = 4096;
export const MAX_PROMPT = 20_000;
export const MAX_FEEDBACK = 5000;
/** The largest spec file read. A spec is a page or a few of prose, and all of it goes to the planner. */
export const MAX_SPEC_BYTES = 200_000;
const SPEC_EXTENSIONS = [".md", ".markdown", ".txt"];
/** How long the file system gets to hand a spec file over. A folder macOS will not let a service read can stall for good. */
const SPEC_LIMIT_MS = 2000;

const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);

/**
 * Read the spec file a client named. A client that holds the owner's session can make Botbench read a file with this,
 * so only this is read: a full path to a regular file named .md, .markdown or .txt, outside Botbench's own data folder,
 * of at most `MAX_SPEC_BYTES` bytes, that is valid UTF-8 text with no NUL in it. A pipe or a device is never read
 * from, and the whole read has a time limit. Returns the file's real path and its text; nothing of a refused file.
 */
export async function readSpec(input: unknown, o: { home: string }): Promise<{ path: string; text: string }> {
  if (typeof input !== "string" || input.includes("\0") || !path.isAbsolute(input)) throw new RunError(400, "Give the spec file's full path, starting with /.");
  if (input.length > MAX_PATH) throw new RunError(400, "The spec file's path is too long.");
  const given = path.resolve(input);
  const allowed = (file: string): boolean => SPEC_EXTENSIONS.includes(path.extname(file).toLowerCase());
  if (!allowed(given)) throw new RunError(400, `The spec file ${given} is not a .md, .markdown or .txt file. Botbench reads a spec only from a text file with one of those endings.`);

  const read = async (): Promise<{ path: string; text: string }> => {
    let real: string;
    try {
      real = await fs.promises.realpath(given);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new RunError(400, `The spec file ${given} does not exist.`);
      throw new RunError(400, `The spec file ${given} could not be read (${code ?? "unknown error"}).`);
    }
    // Where the path really leads decides, not how it was written.
    if (!allowed(real)) throw new RunError(400, `The spec file ${given} leads to ${real}, which is not a .md, .markdown or .txt file.`);
    let home = path.resolve(o.home);
    try {
      home = await fs.promises.realpath(home);
    } catch {
      // A home that is not there yet holds nothing to guard.
    }
    if (isInside(real, home)) throw new RunError(400, `The spec file ${given} is inside Botbench's own data folder, which is never read as a spec.`);
    let handle: fs.promises.FileHandle;
    try {
      // Never waits on a pipe nobody writes to, and follows no link that appeared since the path was resolved.
      handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new RunError(400, `The spec file ${given} does not exist.`);
      throw new RunError(400, `The spec file ${given} could not be read (${code ?? "unknown error"}).`);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RunError(400, `The spec file ${given} is not a regular file.`);
      // A second name for a file says nothing of where the file belongs: it could be one inside Botbench's own folder.
      if (stat.nlink > 1) throw new RunError(400, `The spec file ${given} has more than one name (it is a hard link), so Botbench cannot tell where it belongs. Copy it to a file of its own.`);
      if (stat.size > MAX_SPEC_BYTES) throw new RunError(400, `The spec file ${given} is too large: ${stat.size} bytes, and Botbench reads at most ${MAX_SPEC_BYTES}.`);
      // One byte more than the limit is asked for, so a file that grew since it was measured is still refused.
      const buffer = Buffer.alloc(MAX_SPEC_BYTES + 1);
      let filled = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
        if (filled === buffer.length) throw new RunError(400, `The spec file ${given} is too large: Botbench reads at most ${MAX_SPEC_BYTES} bytes.`);
      }
      if (filled === 0) throw new RunError(400, `The spec file ${given} is empty.`);
      const bytes = buffer.subarray(0, filled);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new RunError(400, `The spec file ${given} is not text: it is not valid UTF-8.`);
      }
      if (content.includes("\0")) throw new RunError(400, `The spec file ${given} is not text: it holds NUL bytes.`);
      return { path: real, text: content };
    } catch (err) {
      if (err instanceof RunError) throw err;
      throw new RunError(400, `The spec file ${given} could not be read (${(err as NodeJS.ErrnoException).code ?? words(err)}).`);
    } finally {
      await handle.close().catch(() => {});
    }
  };

  return new Promise((resolve, reject) => {
    // A read that outlives its limit ends on its own later and closes its file; nobody waits for it.
    const timer = setTimeout(() => reject(new RunError(400, `The spec file ${given} could not be read within ${SPEC_LIMIT_MS / 1000} seconds. If it is on an external drive or in a protected folder, Botbench may not be allowed to read it there.`)), SPEC_LIMIT_MS);
    read().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export interface StartRun {
  repo: unknown;
  prompt?: unknown;
  specPath?: unknown;
  /** The planner's model: a name, null for the CLI's own default, or left out for the configured one. */
  model?: string | null;
  /** The model the tasks are built on: a name, null for the CLI's own default, or left out for the planner's choice when one was given, else the configured one. */
  buildModel?: unknown;
  /** The agent that builds the tasks: "codex", or left out or null for the main agent, which also plans. */
  builder?: string | null;
  /** The commands the run's builders may use without asking; each must be one plain command. */
  preapproved?: unknown;
  /** Who reviews each built task: null or left out for nobody, else `{ agent, model }` (a model name, or null for the agent's own default). */
  reviewer?: unknown;
  /** "manual", "semi" or "full"; left out, the default mode (Settings). */
  mode?: unknown;
  /** What becomes of each task the run accepts: "branch" (the default) or "pull_request". */
  delivery?: unknown;
  /** The GitHub issue the owner was shown, `{ fetchId, allowHosts }` (engine/intake.ts); left out or null for none. */
  issue?: unknown;
  /** Keep the run to one task: true or false; left out, on in a fully autonomous run and off in any other. */
  oneTask?: unknown;
  /** What a builder's usage limit does: "wait" (the default) for it to reset, or "switch" to the next agent on the fallback list in Settings. */
  onLimit?: unknown;
  /** Other workbenches' old claims on the run's issue the owner chose to take over, by branch (engine/claim-branch.ts); left out for none. */
  takeOver?: unknown;
  /** The finished task or the chat the run is made from, `{ task }` or `{ chat }` by id (engine/run-source.ts); left out or null for none. The prompt is then the owner's note. */
  source?: unknown;
  /** How many minutes an approval waits for the owner before Botbench denies it: a whole number from 1 to 1440, or left out or null for no limit. */
  approvalLimitMinutes?: unknown;
}

export interface Runs {
  /** Check everything the run was given, store it as planning and return it at once. The planner works in the background. */
  start(input: StartRun): Promise<Run>;
  editPlan(id: number, tasks: unknown, planVersion: unknown): Run;
  /** Approve the plan: the run is running, its tasks are queued, and the build line builds them one at a time. */
  approve(id: number, planVersion: unknown): { run: Run; tasks: Task[] };
  /** Send the plan as it stands back to the planner with the owner's feedback. The run is planning until the planner answers. */
  requestChanges(id: number, feedback: unknown, planVersion: unknown): Run;
  /** Cancel a run that is planning, waits for approval or is building. A planner or a builder at work is stopped. */
  cancel(id: number, by?: string): Run;
  /** Make the run's mode stricter, on the owner's request (`tightenMode`). Nothing at work is stopped and no request waiting is answered. */
  tightenMode(id: number, mode: unknown): Run;
  /** Resolves when no planner is at work and nothing is being recovered. */
  idle(): Promise<void>;
  /** Stop the planner at work and leave no CLI process and no planning worktree behind. */
  close(): Promise<void>;
}

export interface RunsOptions {
  db: DatabaseSync;
  /** Botbench's data directory; planning worktrees go under it. */
  home: string;
  driver: Driver;
  /** Where the planner's permission requests go to wait for the owner. */
  broker: Broker;
  /** The planner role's configured model. */
  model?: string;
  /** The implementer role's configured model, which the tasks of an approved plan are queued with. */
  implementerModel?: string;
  /** The agents that can review, by name; a run may name one of them as its reviewer. */
  reviewers?: Partial<Record<string, Driver>>;
  /** The cap on rounds of fixes a run started now is given; 2 when left out. */
  maxRefineRounds?: number;
  /** Called when a transcript event was stored. */
  onEvent: () => void;
  /** Called after each state a run reaches and each change of its plan. */
  onRunChange: (run: Run) => void;
  /** Called for each task an approval queued or a cancel ended. */
  onTaskChange: (task: Task) => void;
  /** The build line: it builds an approved run's tasks and stops what it does for a cancelled run. */
  line: Pick<Tasks, "buildRun" | "stopRun"> & Partial<Pick<Tasks, "builderProblem">>;
  /** Agents other than `driver` that can build a run's tasks (Codex), by name, for what a fully autonomous run asks of them. None when left out. */
  builders?: Partial<Record<string, Driver>>;
  /** The check commands of a repository. A run with none cannot be fully autonomous. None when left out. */
  repoCommands?: (repo: string) => { checks: readonly StationCommand[] };
  /** The mode a run is given when the request names none; manual when left out. */
  defaultMode?: () => RunMode;
  /** How long a planner may send nothing before it is stopped (engine/silence.ts); 10 minutes when left out, and 0 for no limit. */
  silenceLimitMs?: number;
}

/** How one go of the planner ended. `note` says what Botbench did to the plan, when it merged it. */
type Outcome = { tasks: PlanTask[]; model: string | null; note?: string } | { problem: string } | { cancelled: true };

const STOPPED = "Botbench stopped before this run's plan was made.";
/** The work of a run started from an issue with no message of the owner's own. Botbench's words, in the work's place. */
const NO_MESSAGE = "(No message of the owner's own: the work is the problem the GitHub issue below describes.)";

/** Why a run that read outside text cannot be fully autonomous. */
export const OUTSIDE_NOT_FULL = "A run started from a GitHub issue cannot be fully autonomous: people outside this project wrote the issue, and a stranger's text must not lead to an accepted change and a pull request with nobody looking. Choose manual or semi-autonomous.";

/**
 * Plans runs, one planner at a time, and takes the owner's decisions at the plan gate.
 */
export function createRuns(options: RunsOptions): Runs {
  const { db, home, driver, broker } = options;
  const silenceLimit = options.silenceLimitMs ?? SILENCE_LIMIT_MS;
  let closed = false;
  let current: { runId: number; session: DriverSession } | null = null;

  const report = (what: string) => (err: unknown): void => console.error(`${what} failed: ${words(err)}`);
  const announce = (run: Run): Run => {
    try {
      options.onRunChange(run);
    } catch (err) {
      // A listener that fails must not undo or hide a state already written.
      report(`Announcing run ${run.id}`)(err);
    }
    return run;
  };
  /** Move a run that is still being planned, and only then: one the owner cancelled in the meantime stays as the owner left it. */
  const move = (id: number, to: RunStatus, change: RunChange): Run | null => {
    const moved = transaction(db, () => {
      if (getRun(db, id)?.status !== "planning") return null;
      writeRun(db, id, to, change);
      return getRun(db, id)!;
    });
    return moved === null ? null : announce(moved);
  };

  /** One go of the planner in `dir`: a turn, and one more when its plan is not accepted. */
  const ask = async (run: Run, dir: string, change?: { current: PlanTask[]; feedback: string }): Promise<Outcome> => {
    const gone = (): boolean => getRun(db, run.id)?.status !== "planning";
    if (closed) return { problem: STOPPED };
    const admission: Admission = broker.admit({ runId: run.id, role: PLANNER, worktree: dir, readOnly: true, confined: driver.capabilities.confinedCommands === true });
    let session: DriverSession;
    try {
      // The planner only reads: its commands reach no network, whatever hosts the repository allows its builder.
      const gitDir = await sharedGitDir(run.repo);
      session = await driver.startAttempt({ db, cwd: dir, readOnly: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { dataDir: home, allowedHosts: [], gitDir }, ...(run.requestedModel === null ? {} : { model: run.requestedModel }) });
    } catch (err) {
      admission.release();
      return { problem: `The planner could not be started: ${words(err)}` };
    }
    admission.bind(session.attemptId);
    current = { runId: run.id, session };
    let reply: string[] = [];
    let model: string | null = null;
    let detail: string | null = null;
    /** Permission requests the CLI is still waiting on, by request id. */
    const asking = new Set<string>();
    session.onEvent((event) => {
      if (event.type === "text") reply.push(event.text);
      if (event.type === "session_started") model = event.model;
      if (event.type === "turn_ended") detail = event.detail;
      if (event.type === "permission_request") {
        asking.add(event.id);
        // The broker never rejects: whatever fails on the way to the owner comes back as a decline.
        void broker
          .request({ taskId: null, runId: run.id, attemptId: session.attemptId, role: PLANNER, tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
          .then((answer) => (asking.has(event.id) ? session.respondToRequest(event.id, permissionResponse(answer)) : undefined))
          .catch(report(`Answering a permission request of run ${run.id}'s planner`));
      }
      if (event.type === "permission_resolved") {
        asking.delete(event.id);
        // The CLI gave up on the request: its card must not stay answerable.
        if (event.decision === "cancelled") admission.supersede(event.toolCallId);
      }
      options.onEvent();
    });

    /** Whether a turn of this planner was stopped because it went silent (engine/silence.ts). */
    let silent = false;
    /** The command a silent planner was stopped during, when one was running. */
    let silentDuring: StoppedDuring | null = null;
    const turn = async (prompt: string): Promise<{ end: TurnEndReason; text: string }> => {
      reply = [];
      detail = null;
      let end: TurnEndReason;
      // Registered after the listener above, so it reads the requests the CLI waits on as they stand after each event.
      const silence = watchSilence(session, silenceLimit, () => asking.size > 0);
      try {
        end = await session.sendTurn(prompt);
      } catch (err) {
        end = "error";
        detail = words(err);
      } finally {
        silence.clear();
      }
      if (silence.fired() && end !== "completed") {
        silent = true;
        silentDuring = silence.stoppedDuring();
      }
      return { end, text: reply.join("\n") };
    };
    const problemOf = (end: TurnEndReason): string =>
      silent ? plannerSilenceReason(agentName(driver.name), silenceLimit, silentDuring) : closed ? STOPPED : end === "interrupted" ? "The planner was stopped before it finished." : `The planner ended with an error${detail === null ? "." : `: ${detail}`}`;

    let outcome: Outcome;
    try {
      // The run names its planner's attempt before the first event, so a screen can follow the transcript from the start.
      // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
      if (!gone()) move(run.id, "planning", { attemptId: session.attemptId, detail: `planner attempt ${session.attemptId}` });
      const issue = runIssue(db, run.id);
      const work = run.prompt ?? run.specText ?? (issue === null ? "" : NO_MESSAGE);
      const oneTask = { oneTask: run.oneTask };
      // A run made from a task or a chat: what Botbench itself recorded of where it came from, after the owner's note.
      const follows = run.source === null ? {} : { follows: sourcePrompt(db, run.source) };
      // `close` stops only a session it can see: one still being started when Botbench began stopping is sent no turn.
      const first = gone() || closed ? null : await turn(plannerPrompt({ work, ...oneTask, ...follows, ...(change ? { current: change.current, feedback: change.feedback } : {}), learnings: learningsSection(run.repo), memory: memorySection(home), ...(issue === null ? {} : { outside: outsideTextPrompt(issue) }) }));
      if (first === null && !gone()) outcome = { problem: STOPPED };
      else if (first === null || gone()) outcome = { cancelled: true };
      else if (first.end !== "completed") outcome = { problem: problemOf(first.end) };
      else {
        let plan = parsePlan(first.text, oneTask);
        if (!plan.ok) {
          // Sent back once, with what was wrong. A second plan that is not accepted ends the planning.
          const second = await turn(correctionPrompt(plan.errors));
          if (gone()) outcome = { cancelled: true };
          else if (second.end !== "completed") outcome = { problem: problemOf(second.end) };
          else {
            plan = parsePlan(second.text, oneTask);
            outcome = plan.ok ? { tasks: plan.tasks, model } : { problem: `The planner returned a plan Botbench could not accept, twice. What was wrong with the second: ${plan.errors.join(" ")}` };
          }
        } else outcome = { tasks: plan.tasks, model };
      }
      // A run kept to one task: a plan of several is sent back once. One that still holds several, or a reply that is
      // no plan, is merged by Botbench from the latest plan of several, and the run's record says so.
      if (run.oneTask && "tasks" in outcome && outcome.tasks.length > 1) {
        const several = outcome.tasks;
        const again = await turn(oneTaskPrompt(several.length));
        if (gone()) outcome = { cancelled: true };
        else if (again.end !== "completed" && closed) outcome = { problem: problemOf(again.end) };
        else {
          const replied = again.end === "completed" ? parsePlan(again.text, oneTask) : null;
          const latest = replied !== null && replied.ok ? replied.tasks : several;
          outcome =
            latest.length === 1
              ? { tasks: latest, model }
              : { tasks: [mergePlan(latest)], model, note: `This run is kept to one task. ${agentName(driver.name)} planned ${latest.length} tasks even when asked again for one, so Botbench joined them into one task: their titles in order, and all of their criteria.` };
        }
      }
    } catch (err) {
      outcome = { problem: words(err) };
    }
    try {
      await session.close();
      // Nothing of a silent planner may be left running: its whole process group is confirmed gone before the run records it.
      if (silent) await confirmGroupGone(db, session.attemptId);
    } catch (err) {
      if (!("cancelled" in outcome)) {
        outcome = { problem: silent ? `The planner went silent for ${durationWords(silenceLimit)}, the silence limit in Botbench's settings, and Botbench could not stop its ${agentName(driver.name)} process: ${words(err)}` : `The planner's ${agentName(driver.name)} process could not be stopped: ${words(err)}` };
      }
      report(`Stopping run ${run.id}'s planner`)(err);
    }
    current = null;
    admission.release();
    options.onEvent();
    return outcome;
  };

  /** Plan a run that is `planning`: worktree, planner, plan, and the worktree gone again whatever came of it. */
  const plan = async (id: number, change?: { current: PlanTask[]; feedback: string }): Promise<void> => {
    const run = getRun(db, id);
    if (!run || run.status !== "planning") return;
    const name = `run-${id}`;
    let outcome: Outcome;
    try {
      const dir = closed ? null : await createPlanningWorktree({ repo: run.repo, home, run: name, commit: run.baseCommit });
      outcome = dir === null ? { problem: STOPPED } : await ask(run, dir, change);
    } catch (err) {
      outcome = { problem: `The planner's copy of the project could not be made: ${words(err)}` };
    }
    let leftover: string | null = null;
    try {
      await removePlanningWorktree({ repo: run.repo, home, run: name });
    } catch (err) {
      leftover = `The planner's copy of the project under ${path.join(home, "worktrees", name)} could not be removed: ${words(err)}`;
      report(`Removing run ${id}'s planning worktree`)(err);
    }
    const now_ = getRun(db, id);
    // Cancelled while the planner worked: the run already says so, and a plan that arrived late is not stored.
    if (!now_ || now_.status !== "planning" || "cancelled" in outcome) return;
    if ("tasks" in outcome) {
      const note = [outcome.note, leftover].filter((part): part is string => typeof part === "string").join(" ");
      const stored = announce(storePlan(db, id, outcome.tasks, { plannerModel: outcome.model, note: note === "" ? null : note }));
      // A fully autonomous run, and a semi-autonomous one that read no outside text, do not wait at the plan gate:
      // building starts on the plan as the planner gave it.
      if (planApprovedByMode(stored)) approveNow(id, stored.planVersion, "mode");
      return;
    }
    // Botbench is stopping: the run is left planning, and the next start plans it again (see `recover`).
    // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
    if (closed) return void move(id, "planning", { detail: "Botbench stopped while this run was being planned; left for the next start to plan again" });
    const problem = leftover === null ? outcome.problem : `${outcome.problem} ${leftover}`;
    // A planner asked to change a plan and unable to leaves the owner's plan as it was.
    if (change) move(id, "awaiting_plan_approval", { reason: `The planner did not produce a changed plan, so the plan is as it was. ${problem}` });
    else move(id, "failed", { reason: problem.startsWith(STOPPED) ? `${problem} Start the run again.` : problem });
  };

  /**
   * A Botbench that stopped while planning leaves a run at `planning` with nobody planning it. Nothing of that planning
   * is left behind, and the run is planned again once, from the start, in a fresh copy; stopped while planning a
   * second time (the count is in the store), it fails and says so. A change the owner asked for is not asked again:
   * the plan stays as it was. The runs are read before this engine takes its first request, so every one found is the
   * last run's. Returns the runs to plan again.
   */
  const recover = async (): Promise<number[]> => {
    const again: number[] = [];
    for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned' AND status = 'planning' ORDER BY id").all()) {
      const run = getRun(db, Number(row.id))!;
      let stuck: string | null = null;
      if (run.attemptId !== null) {
        await stopSurvivor(db, run.attemptId).catch((err: unknown) => {
          stuck = `Its planner from before the restart could not be stopped: ${words(err)}`;
        });
      }
      broker.endRunApprovals(run.id, "Botbench stopped while the planner waited for this answer.");
      await removePlanningWorktree({ repo: run.repo, home, run: `run-${run.id}` }).catch(report(`Removing the planning worktree left by run ${run.id}`));
      if (planTasks(db, run.id).length > 0) move(run.id, "awaiting_plan_approval", { reason: `${STOPPED} The planner had been asked to change the plan; the plan is as it was.` });
      else if (stuck !== null) move(run.id, "failed", { reason: `${STOPPED} ${stuck} Start the run again.` });
      else if (Number(db.prepare("SELECT restarts FROM runs WHERE id = ?").get(run.id)!.restarts) >= 1) move(run.id, "failed", { reason: "Botbench stopped twice while this run was being planned, so it was not planned a third time. Start the run again." });
      else {
        // Read again in the write: a cancel while the old planner was being stopped stands.
        const taken = transaction(db, () => {
          if (getRun(db, run.id)?.status !== "planning") return false;
          db.prepare("UPDATE runs SET restarts = restarts + 1 WHERE id = ?").run(run.id);
          // voice: not on screen. A note in the stored history of the task or run, in the plan's own terms; no screen reads it.
          writeRun(db, run.id, "planning", { detail: "Botbench restarted while this run was being planned; it is planned again once, from the start" });
          return true;
        });
        if (taken) again.push(run.id);
      }
    }
    // No planner is at work yet, so every planning worktree still under the home is a leftover, whatever its run says
    // now: one cancelled just before Botbench was killed, or one whose removal failed.
    const root = path.join(home, "worktrees");
    for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const id = /^run-([1-9]\d{0,14})$/.exec(name);
      if (!id || !fs.existsSync(path.join(root, name, "planner"))) continue;
      const row = db.prepare("SELECT repo_path FROM runs WHERE id = ?").get(Number(id[1]));
      if (row) await removePlanningWorktree({ repo: String(row.repo_path), home, run: name }).catch(report(`Removing the planning worktree left under ${name}`));
    }
    return again;
  };

  // One chain: recovery first, then each planning in the order it was asked for.
  let chain: Promise<void> = recover()
    .then(async (again) => {
      for (const id of again) await plan(id);
    })
    .catch(report("Recovering runs"));
  const enqueue = (id: number, change?: { current: PlanTask[]; feedback: string }): void => {
    chain = chain.then(() => plan(id, change)).catch(report(`Planning run ${id}`));
  };

  /**
   * A reviewer must not be the builder's own agent and model (R5), must be an agent that can review, and must be usable
   * now, as its own probe says: a run is not started with a reviewer that could only fail.
   */
  const reviewerUsable = async (reviewer: RoleChoice, buildModel: string | null, builder: string): Promise<void> => {
    const same = sameModelProblem({ agent: builder, model: buildModel }, reviewer);
    if (same !== null) throw new RunError(400, same);
    const found = options.reviewers?.[reviewer.agent];
    if (found === undefined) throw new RunError(400, `${agentName(reviewer.agent)} cannot review a run. Choose ${Object.keys(options.reviewers ?? {}).map(agentName).join(", ")}, or no review.`);
    const cannot = roleProblem(REVIEWER, reviewer.agent, found.capabilities);
    if (cannot !== null) throw new RunError(400, cannot);
    const probe = await found.probe();
    if (probe.problem !== null) throw new RunError(400, `${agentName(reviewer.agent)} cannot review this run: ${probe.problem}`);
  };

  /**
   * A fully autonomous run accepts work when its checks pass, so a repository with none cannot have one; and its
   * commands run without the owner only confined, so neither can an agent whose commands cannot be confined here.
   */
  const fullyAutonomousUsable = (repo: string, builder: Driver): void => {
    if ((options.repoCommands?.(repo).checks.length ?? 0) === 0) {
      throw new RunError(400, 'This repository has no checks set up, so a run on it cannot be fully autonomous: without checks, "fully autonomous" would mean agents agreeing with each other. Add check commands for it to Botbench\'s settings file, or choose semi-autonomous.');
    }
    // The planner is the main agent and the tasks are built by `builder`. A builder that asks only to leave its own
    // sandbox (Codex) keeps every command inside it there: what it asks to run outside, the run refuses.
    const keeps = (d: Driver): boolean => d.capabilities.confinedCommands === true || d.capabilities.escalationsOnly === true;
    const loose = [driver, builder].find((d) => !keeps(d));
    const unconfined = loose === undefined ? confinementProblem() : `${agentName(loose.name)} does not run every command it is given inside Botbench's protection.`;
    if (unconfined !== null) throw new RunError(400, `A run cannot be fully autonomous here: the commands its agents run cannot be kept away from your sign-ins and the network. ${unconfined}`);
  };

  const start = async (input: StartRun): Promise<Run> => {
    const stopping = (): void => {
      if (closed) throw new RunError(503, "Botbench is shutting down.");
    };
    stopping();
    const hasPrompt = input.prompt !== undefined && input.prompt !== null;
    const hasSpec = input.specPath !== undefined && input.specPath !== null;
    const issueChoice = issueGiven(input.issue);
    const sourceChoice = sourceGiven(input.source);
    if (sourceChoice !== null) {
      // The owner's note is the whole message: nothing else, and nothing anyone outside the project wrote, comes with it.
      if (hasSpec || issueChoice !== null) throw new RunError(400, "A run made from a task or a chat takes your note as its message, not a spec file or an issue.");
      const problem = noteProblem(input.prompt);
      if (problem !== null) throw new RunError(400, problem);
    }
    if (hasPrompt && hasSpec) throw new RunError(400, "Give a prompt or a spec file, not both.");
    if (issueChoice !== null && hasSpec) throw new RunError(400, "Give a message or nothing with an issue, not a spec file.");
    if (!hasPrompt && !hasSpec && issueChoice === null) throw new RunError(400, "Give one of a prompt and a spec file path.");
    if (hasPrompt && (typeof input.prompt !== "string" || input.prompt.trim() === "")) throw new RunError(400, "The prompt must be text that says what to build.");
    if (hasPrompt && (input.prompt as string).length > MAX_PROMPT) throw new RunError(400, `The prompt is too long: ${MAX_PROMPT} characters at most.`);
    const preapproved = preapprovedList(input.preapproved);
    const reviewer = reviewerChoice(input.reviewer);
    const mode = input.mode === undefined ? (options.defaultMode?.() ?? "manual") : modeChoice(input.mode);
    if (input.buildModel !== undefined && input.buildModel !== null && modelNameProblem(input.buildModel) !== null) throw new RunError(400, `The build model is not a model name. ${modelNameProblem(input.buildModel)}`);
    // The builder: the main agent, or one the owner chose (Codex), which must be able to build now.
    const builderName = input.builder ?? null;
    // A line that can say why a builder cannot build decides; one that cannot accepts only the main agent.
    const cannot = options.line.builderProblem !== undefined ? options.line.builderProblem(builderName, mode) : builderName === null ? null : `${agentName(builderName)} cannot build a run's tasks in Botbench.`;
    if (cannot !== null) throw new RunError(400, cannot);
    const builder = builderName === null ? driver : options.builders?.[builderName];
    if (builder === undefined) throw new RunError(400, `${agentName(builderName!)} cannot build a run's tasks in Botbench.`);
    // Left out: the same choice as planning when one was made, as the New run screen offers it; else the configured one.
    // Another agent than the planner's builds on its own default, unless a build model was chosen for it.
    const buildModel = input.buildModel !== undefined ? (input.buildModel as string | null) : builderName !== null ? null : input.model !== undefined ? input.model : (options.implementerModel ?? null);
    const delivery = deliveryChoice(input.delivery);
    const oneTask = oneTaskChoice(input.oneTask, mode);
    const approvalLimitMinutes = approvalLimitChoice(input.approvalLimitMinutes);
    const onLimit = onLimitChoice(input.onLimit);
    // Everything a client names is checked before anything is stored: the repository, then the spec file.
    let repo: string;
    try {
      repo = await checkRepository(input.repo);
    } catch (err) {
      throw err instanceof TaskError ? new RunError(err.status, err.message) : err;
    }
    const spec = hasSpec ? await readSpec(input.specPath, { home }) : undefined;
    let baseCommit: string;
    try {
      baseCommit = await sourceHead(repo);
    } catch (err) {
      throw new RunError(400, words(err));
    }
    // The issue must be one read for this repository, as the owner was shown it.
    const issue = issueChoice === null ? null : issueFetch(db, issueChoice.fetchId);
    if (issueChoice !== null && issue === null) throw new RunError(400, "There is no issue read with that number. Look the issue up again.");
    if (issue !== null && issue.repoPath !== realRepo(repo)) throw new RunError(400, `That issue was read for another repository (${issue.repoPath}), not ${repo}. Look it up again for this one.`);
    if (issue !== null && mode === "full") throw new RunError(400, OUTSIDE_NOT_FULL);
    // A task made into a run is one that is finished, in this same repository; a chat is one Botbench recorded.
    const source = sourceChoice === null ? undefined : checkSource(db, sourceChoice, realRepo(repo));
    // A claim taken over is another workbench's, on this run's issue, and old enough by its name (engine/claims.ts).
    let takeOver: ClaimName[];
    try {
      takeOver = takeOverGiven(input.takeOver, { issue: issue?.number ?? messageIssue(hasPrompt ? (input.prompt as string) : null), own: ownWorkbenches(db), now: Date.now() });
    } catch (err) {
      throw new RunError(400, words(err));
    }
    if (mode === "full") fullyAutonomousUsable(repo, builder);
    if (reviewer !== null) await reviewerUsable(reviewer, buildModel, builder.name);
    stopping();
    const run = createRun(db, { repo, builder: builderName, ...(spec ? { spec } : hasPrompt ? { prompt: input.prompt as string } : {}), ...(issueChoice === null ? {} : { issue: issueChoice }), requestedModel: input.model === undefined ? (options.model ?? null) : input.model, buildModel, baseCommit, preapproved, reviewer, mode, delivery, oneTask, onLimit, takeOver, approvalLimitMinutes, ...(source === undefined ? {} : { source: { kind: source.kind, id: source.id } }), ...(options.maxRefineRounds === undefined ? {} : { maxRefineRounds: options.maxRefineRounds }) });
    announce(run);
    enqueue(run.id);
    return run;
  };

  const announceTask = (task: Task): void => {
    try {
      options.onTaskChange(task);
    } catch (err) {
      report(`Announcing task ${task.id}`)(err);
    }
  };

  const approveNow = (id: number, planVersion: unknown, by: "owner" | "mode"): { run: Run; tasks: Task[] } => {
    if (closed) throw new RunError(503, "Botbench is shutting down.");
    const approved = approvePlan(db, id, planVersion, options.implementerModel ?? null, by);
    announce(approved.run);
    for (const task of approved.tasks) announceTask(task);
    options.line.buildRun(id);
    return approved;
  };
  const approve = (id: number, planVersion: unknown): { run: Run; tasks: Task[] } => approveNow(id, planVersion, "owner");

  const requestChanges = (id: number, feedback: unknown, planVersion: unknown): Run => {
    const { run, plan: sent, words: said } = transaction(db, () => {
      const waiting = known(db, id);
      if (typeof feedback !== "string" || feedback.trim() === "") throw new RunError(400, 'Say what to change: "feedback" must be text for the planner.');
      if (feedback.length > MAX_FEEDBACK) throw new RunError(400, `The feedback is too long: ${MAX_FEEDBACK} characters at most.`);
      versionGiven(planVersion);
      if (waiting.status !== "awaiting_plan_approval") throw notWaiting(waiting, "change");
      sameVersion(waiting, planVersion);
      if (closed) throw new RunError(503, "Botbench is shutting down.");
      const stands = planTasks(db, id).map(({ title, criteria }) => ({ title, criteria }));
      writeRun(db, id, "planning", { reason: null, detail: `changes requested by the owner: ${feedback.trim().slice(0, 500)}` });
      return { run: getRun(db, id)!, plan: stands, words: feedback.trim() };
    });
    announce(run);
    enqueue(id, { current: sent, feedback: said });
    return run;
  };

  const cancel = (id: number, by?: string): Run => {
    const run = cancelRun(db, id, by);
    // Stops the builder at work, or its setup command; the build line then commits what it did and records it cancelled.
    void options.line.stopRun(id).catch(report(`Stopping the build of run ${id}`));
    // A request of its planner or of its builders that waits for the owner has nobody to answer to any more.
    broker.endRunApprovals(id, "The run was cancelled.");
    for (const task of runTasks(db, id)) broker.endParked(task.id, "The run was cancelled.");
    announce(run);
    for (const task of runTasks(db, id)) if (task.status === "cancelled") announceTask(task);
    // Stops the planner at work; the planning then sees the run cancelled, stores nothing and removes its worktree.
    if (current?.runId === id) void current.session.close().catch(report(`Stopping run ${id}'s planner`));
    return run;
  };

  const close = async (): Promise<void> => {
    closed = true;
    // Ends the running turn as interrupted; the planning then records why and removes its worktree. The chain is
    // always waited for: the database closes after this.
    await current?.session.close().catch(report("Stopping the planner"));
    await chain;
  };

  return { start, editPlan: (id, tasks, planVersion) => announce(editPlan(db, id, tasks, planVersion)), approve, requestChanges, cancel, tightenMode: (id, mode) => announce(tightenMode(db, id, mode)), idle: () => chain, close };
}

/**
 * The commands a request pre-approves: only what the request itself lists, each one plain command.
 * Anything else is refused with the reason, before anything exists.
 */
export function preapprovedList(given: unknown): string[] {
  if (given === undefined) return [];
  if (!Array.isArray(given)) throw new RunError(400, '"preapproved" must be a list of commands.');
  if (given.length > MAX_ENTRIES) throw new RunError(400, `"preapproved" may hold ${MAX_ENTRIES} commands at most.`);
  const problem = given.map(entryProblem).find((p) => p !== null);
  if (problem) throw new RunError(400, problem);
  return given as string[];
}

/** The issue a request names: null for none, else the fetch the owner was shown and whether its network hosts are allowed. */
export function issueGiven(given: unknown): { fetchId: number; allowHosts: boolean } | null {
  if (given === undefined || given === null) return null;
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  const shape = '"issue" must be null, or { "fetchId": <the id the issue was looked up with>, "allowHosts": true or false }.';
  if (typeof given !== "object" || Array.isArray(given)) throw new RunError(400, shape);
  const { fetchId, allowHosts, ...rest } = given as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof fetchId !== "number" || !Number.isSafeInteger(fetchId) || fetchId < 1 || typeof allowHosts !== "boolean") throw new RunError(400, shape);
  return { fetchId, allowHosts };
}

/** The longest approval time limit a run may have, in minutes: a day. */
export const MAX_APPROVAL_LIMIT_MINUTES = 1440;

/** The approval time limit a request names, in minutes; null when it names none, which is the default. Anything else is refused with the reason, before anything exists. */
export function approvalLimitChoice(given: unknown): number | null {
  if (given === undefined || given === null) return null;
  if (typeof given === "number" && Number.isSafeInteger(given) && given >= 1 && given <= MAX_APPROVAL_LIMIT_MINUTES) return given;
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  throw new RunError(400, `"approvalLimitMinutes" must be a whole number of minutes from 1 to ${MAX_APPROVAL_LIMIT_MINUTES}, or null for no limit.`);
}

/** Whether a request keeps its run to one task: as it says, or, left out, on only in a fully autonomous run. Anything else is refused with the reason, before anything exists. */
export function oneTaskChoice(given: unknown, mode: RunMode): boolean {
  if (given === undefined || given === null) return mode === "full";
  if (typeof given === "boolean") return given;
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  throw new RunError(400, '"oneTask" must be true (keep the run to one task) or false.');
}

/** What a request says a builder's usage limit does: "wait" when it says nothing. Anything else is refused with the reason, before anything exists. */
export function onLimitChoice(given: unknown): OnLimit {
  if (given === undefined || given === null) return "wait";
  if (isOnLimit(given)) return given;
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  throw new RunError(400, '"onLimit" must be "wait" (wait for the usage limit to reset) or "switch" (switch to the next agent).');
}

/** The mode a request names. Anything else is refused with the reason, before anything exists. */
export function modeChoice(given: unknown): RunMode {
  if (isRunMode(given)) return given;
  throw new RunError(400, '"mode" must be "manual", "semi" or "full".');
}

/** The reviewer a request names: null for none, else a known agent and a model name or null. Anything else is refused with the reason, before anything exists. */
export function reviewerChoice(given: unknown): RoleChoice | null {
  if (given === undefined || given === null) return null;
  const shape = '"reviewer" must be null, or { "agent": "codex", "grok" or "antigravity", "model": "<model name>" or null }.';
  if (typeof given !== "object" || Array.isArray(given)) throw new RunError(400, shape);
  const { agent, model, ...rest } = given as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof agent !== "string") throw new RunError(400, shape);
  if (!(DRIVER_NAMES as readonly string[]).includes(agent)) throw new RunError(400, `"reviewer" names an agent Botbench does not know. ${shape}`);
  if (model !== undefined && model !== null && modelNameProblem(model) !== null) throw new RunError(400, `The reviewer's model is not a model name. ${modelNameProblem(model)}`);
  return { agent, model: typeof model === "string" ? model : null };
}
