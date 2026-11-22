import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { approvePlan, cancelRun, createRun, storePlan } from "../../src/engine/run.ts";
import { createTask, moveTask, settleRunIn, type Task } from "../../src/engine/task.ts";
import { transaction } from "../../src/store/db.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { git, initRepo, tempDir, write } from "../support/repo.ts";

// The runs board (unit 16) over real HTTP, against a real Botbench server, real temporary repositories and real SQLite.
// No driver is started. Each state is reached the way the other API tests reach it: runs are created and planned by the
// engine's own functions as the planner leaves them (test/api/runs.test.ts), approved plans are really built up to the
// repository's setup command (which fails, or is still running), a cancel goes through its route, and a task is put at
// Ready for review by Botbench's own worktree and commit functions (test/api/decisions.test.ts). Planner and builder
// turns, and a request for permission waiting on the board, are in e2e/board.e2e.ts with the real Claude Code.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
type Item = { kind: "run" | "task"; id: number; status: string; title: string; repo: string; readyCount?: number; waitingOnApproval: boolean };
type Group = { name: string; total: number; items: Item[] };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  /** No setup: tasks here are put at Ready for review by hand. */
  plain: string;
  /** Its setup command fails, so a task here fails before any agent could start. */
  failing: string;
  /** Its setup command runs for a minute, so a task here is still being built while the test looks. */
  slow: string;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-board-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const [plain, failing, slow] = ["plain", "failing", "slow"].map((name) => path.join(dir, name));
  for (const repo of [plain!, failing!, slow!]) initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [failing!]: { setup: ["echo preparing the copy; exit 1"] }, [slow!]: { setup: ["sleep 60"] } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, plain: plain!, failing: failing!, slow: slow!, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

const board = async (api: Api): Promise<Group[]> => {
  const res = await call(api, "GET", "/api/board");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.groups as Group[];
};
/** Each group by its name, with its items as kind and id. */
const shape = (groups: Group[]): Record<string, string[]> => Object.fromEntries(groups.map((group) => [group.name, group.items.map((item) => `${item.kind} ${item.id}`)]));

/** Read the board until `done` says so. */
async function until(api: Api, done: (groups: Group[]) => boolean): Promise<Group[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const groups = await board(api);
    if (done(groups)) return groups;
    assert.ok(Date.now() < deadline, `the board never got there: ${JSON.stringify(shape(groups))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A run waiting for the owner to approve its plan, stored as the engine stores one once its planner has answered. */
function plannedRun(api: Api, repo: string, titles: string[] = ["Add a greeting file"]): { id: number; planVersion: number } {
  const run = createRun(api.server.db, { repo, prompt: `Work in ${path.basename(repo)}`, baseCommit: initHead(repo) });
  const waiting = storePlan(api.server.db, run.id, titles.map((title) => ({ title, criteria: [`${title} is done`] })));
  return { id: run.id, planVersion: waiting.planVersion };
}
const initHead = (repo: string): string => git(repo, "rev-parse", "HEAD").trim();

/** Put `task` at Ready for review with one committed file, in a worktree under its run. */
async function ready(api: Api, task: Task, repo: string): Promise<void> {
  const worktree = await createWorktree({ repo, home: api.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(api.server.db, task.id, "building", { worktree });
  write(worktree.path, `task-${task.id}.txt`, "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  moveTask(api.server.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed" });
}

test("the board needs a session", async (t) => {
  const api = await start(t);
  const res = await fetch(`${api.base}/api/board`);
  assert.equal(res.status, 401);
  await res.arrayBuffer();
});

test("with no runs and no tasks the board is three empty groups in order: Needs you, Running, Finished", async (t) => {
  const api = await start(t);
  assert.deepEqual(await board(api), [
    { name: "needs-you", total: 0, items: [] },
    { name: "running", total: 0, items: [] },
    { name: "finished", total: 0, items: [] },
  ]);
});

test("runs and stand-alone tasks in each state appear in the right group, the ones that need the owner first, each group counted by its items", async (t) => {
  const api = await start(t);
  const db = api.server.db;

  // Needs you: a plan ready for review.
  const planReady = plannedRun(api, api.plain);
  // Needs you: every task built and one ready for review, the run waiting for decisions, as the build line leaves it.
  const toDecide = plannedRun(api, api.plain, ["one", "two"]);
  const decideTasks = approvePlan(db, toDecide.id, toDecide.planVersion).tasks;
  await ready(api, decideTasks[0]!, api.plain);
  moveTask(db, decideTasks[1]!.id, "failed", { reason: "it broke" });
  transaction(db, () => settleRunIn(db, toDecide.id));
  // Needs you: a run still building whose first task is ready for review.
  const partly = plannedRun(api, api.plain, ["first", "second"]);
  const partlyTasks = approvePlan(db, partly.id, partly.planVersion).tasks;
  await ready(api, partlyTasks[0]!, api.plain);
  // Needs you: a stand-alone task ready for review.
  const lone = createTask(db, { repo: api.plain, prompt: "create lone.txt\nwith more lines" });
  await ready(api, lone, api.plain);

  // Finished: a run cancelled at its plan, a run whose every task failed, a decided run, and a stand-alone task that failed.
  const cancelled = plannedRun(api, api.plain);
  assert.equal((await call(api, "POST", `/api/runs/${cancelled.id}/cancel`, {})).status, 200);
  const allFailed = plannedRun(api, api.failing, ["one", "two"]);
  assert.equal((await call(api, "POST", `/api/runs/${allFailed.id}/plan/approve`, { planVersion: allFailed.planVersion })).status, 200);
  const decided = plannedRun(api, api.plain);
  const decidedTask = approvePlan(db, decided.id, decided.planVersion).tasks[0]!;
  await ready(api, decidedTask, api.plain);
  transaction(db, () => settleRunIn(db, decided.id));
  assert.equal((await call(api, "POST", `/api/tasks/${decidedTask.id}/accept`, {})).status, 200);
  const loneFailed = (await call(api, "POST", "/api/tasks", { repo: api.failing, prompt: "create failed.txt" })).body.taskId as number;

  // The build line builds one task at a time: the failing ones end first, then the slow one starts its setup.
  await until(api, (g) => g[2]!.items.some((item) => item.kind === "run" && item.id === allFailed.id) && g[2]!.items.some((item) => item.kind === "task" && item.id === loneFailed));

  // Running: a run waiting for the planner (none has been started for it here), and an approved run whose task is in its setup.
  const queued = createRun(db, { repo: api.plain, prompt: "Plan this later", baseCommit: initHead(api.plain) });
  const building = plannedRun(api, api.slow);
  assert.equal((await call(api, "POST", `/api/runs/${building.id}/plan/approve`, { planVersion: building.planVersion })).status, 200);
  const groups = await until(api, (g) => g[1]!.items.some((item) => item.kind === "run" && item.id === building.id && item.status === "running") && db.prepare("SELECT 1 FROM tasks WHERE run_id = ? AND status = 'building'").get(building.id) !== undefined);
  assert.deepEqual(groups.map((group) => group.name), ["needs-you", "running", "finished"], "the groups are in order, the one that needs the owner first");
  const sorted = Object.fromEntries(Object.entries(shape(groups)).map(([name, items]) => [name, [...items].sort()]));
  assert.deepEqual(sorted, {
    "needs-you": [`run ${planReady.id}`, `run ${toDecide.id}`, `run ${partly.id}`, `task ${lone.id}`].sort(),
    running: [`run ${queued.id}`, `run ${building.id}`].sort(),
    finished: [`run ${cancelled.id}`, `run ${allFailed.id}`, `run ${decided.id}`, `task ${loneFailed}`].sort(),
  });
  // A task of a planned run is on the board as part of its run, never on its own.
  for (const task of [...decideTasks, ...partlyTasks, decidedTask]) assert.ok(!groups.some((group) => group.items.some((item) => item.kind === "task" && item.id === task.id)), `task ${task.id} is only in its run`);

  const find = (kind: string, id: number): Item => groups.flatMap((group) => group.items).find((item) => item.kind === kind && item.id === id)!;
  assert.deepEqual([find("run", planReady.id).status, find("run", toDecide.id).status, find("run", partly.id).status], ["awaiting_plan_approval", "awaiting_decision", "running"]);
  assert.deepEqual([find("run", toDecide.id).readyCount, find("run", partly.id).readyCount, find("run", planReady.id).readyCount], [1, 1, 0], "how many tasks are ready for review, from the tasks themselves");
  assert.deepEqual([find("run", allFailed.id).status, find("run", cancelled.id).status, find("run", decided.id).status], ["done", "cancelled", "done"]);
  assert.deepEqual({ ...find("task", lone.id), updatedAt: "" }, { ...find("task", lone.id), kind: "task", id: lone.id, title: "create lone.txt", repo: api.plain, status: "awaiting_decision", waitingOnApproval: false, updatedAt: "" });
  assert.equal(find("task", loneFailed).status, "failed");
});

test("however many runs and tasks there are, every one that needs the owner is on the board; Finished sends its newest hundred and counts them all", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  // An old stand-alone task waiting for review, and an old plan waiting for approval, then many newer finished runs and planned tasks.
  const old = createTask(db, { repo: api.plain, prompt: "an old task" });
  await ready(api, old, api.plain);
  const oldPlan = plannedRun(api, api.plain);
  for (let i = 0; i < 260; i++) cancelRun(db, plannedRun(api, api.plain, ["one", "two"]).id);
  // More than two hundred tasks of planned runs, which an older stand-alone task must not be crowded out by.
  let many = { id: 0, planVersion: 0 };
  for (let i = 0; i < 12; i++) {
    many = plannedRun(api, api.plain, Array.from({ length: 20 }, (_, n) => `task ${n}`));
    approvePlan(db, many.id, many.planVersion);
    cancelRun(db, many.id);
  }
  const groups = await board(api);
  assert.deepEqual(shape(groups)["needs-you"]!.sort(), [`run ${oldPlan.id}`, `task ${old.id}`].sort());
  assert.equal(groups[0]!.total, 2);
  assert.equal(groups[2]!.total, 272, "the count is the real one");
  assert.equal(groups[2]!.items.length, 100, "the newest hundred are sent");
  assert.equal(groups[2]!.items[0]!.id, many.id, "newest first");
});
