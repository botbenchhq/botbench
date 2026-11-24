import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { createChat } from "../../src/api/chat.ts";
import { createTurns } from "../../src/api/turns.ts";
import { HOME_SHOWN } from "../../src/api/work.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { byNeed, placeChat, placeRun, placeTask, type RunFacts, type TaskFacts } from "../../src/engine/queue.ts";
import { approvePlan, cancelRun, createRun, storePlan } from "../../src/engine/run.ts";
import { CHANGED_NOTHING, createTask, getTask, moveTask, resumeNote, settleRunIn, type Task } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { openStore, transaction } from "../../src/store/db.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { storeChecks } from "../support/checks.ts";
import { chatReplayDriver } from "../support/replay-chat.ts";
import { git, initRepo, tempDir, write } from "../support/repo.ts";

// Home (the queue) and Work (the inventory) over real HTTP, against a real Botbench server, a real temporary
// repository and real SQLite. No model turn is started: each state is reached with the engine's own functions, as the
// other API tests reach it (test/api/board.test.ts), an approval is asked for through the server's own permission
// check, and the one chat is sent before the server starts to Codex replaying a session captured from its real CLI.
// A task whose work waits for another task's is told from the build line's own memory, which only a running build has:
// that one case is tested on the rule itself (the first tests here) and in test/engine/note-round.test.ts.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
type Item = Body & { kind: string; id: number; title: string; place: string; cause: string | null; since: string };
type Group = { total: number; items: Item[] };
type Home = { needsYou: Group & { messages: number }; inProgress: Group & { agents: Body[]; repos: Body[] }; waiting: Group & { causes: Body[] }; completed: Group & { lastDay: number; withoutYou: number; pullRequests: number }; ended: Record<string, number>; failed: number; total: number };
type Work = { items: Item[]; total: number; next: string | null; older: { count: number; oldest: string } | null; counts: { kind: Record<string, number>; state: Record<string, number> }; all: number; hidden: number };
const JSON_TYPE = { "content-type": "application/json" };

const task = (facts: Partial<TaskFacts>) => placeTask({ status: "building", waitingOnApproval: false, resumable: false, behindAnother: false, ...facts });
const run = (facts: Partial<RunFacts>) => placeRun({ status: "running", waitingOnApproval: false, resumable: 0, ready: 0, accepted: 0, atWork: 1, limited: 0, ...facts });

test("a task started on its own stands in one place, with why: an approval, a failure to recover, a result, a wait and its cause, or its end", () => {
  assert.deepEqual(task({ waitingOnApproval: true }), { place: "needs-you", cause: "approval" });
  assert.deepEqual(task({ status: "failed", resumable: true }), { place: "needs-you", cause: "failure" });
  assert.deepEqual(task({ status: "interrupted", resumable: true }), { place: "needs-you", cause: "failure" }, "a stopped task the owner can resume waits for them too");
  assert.deepEqual(task({ status: "awaiting_decision" }), { place: "needs-you", cause: "result" });
  assert.deepEqual(task({ status: "waiting_for_limit" }), { place: "waiting", cause: "usage-limit" });
  assert.deepEqual(task({ behindAnother: true }), { place: "waiting", cause: "dependency" });
  for (const status of ["queued", "building", "verifying", "reviewing"] as const) assert.deepEqual(task({ status }), { place: "in-progress", cause: null }, status);
  assert.deepEqual(task({ status: "accepted" }), { place: "completed", cause: null });
  assert.deepEqual(task({ status: "failed" }), { place: "failed", cause: null }, "a failure nothing can resume is an end");
  for (const status of ["rejected", "cancelled", "interrupted", "drafted"] as const) assert.deepEqual(task({ status }), { place: "ended", cause: null }, status);
  // What waits for the owner comes before what the task is otherwise doing.
  assert.deepEqual(task({ waitingOnApproval: true, behindAnother: true }), { place: "needs-you", cause: "approval" });
});

test("a planned run stands where the most urgent thing in it does", () => {
  assert.deepEqual(run({ waitingOnApproval: true, ready: 1 }), { place: "needs-you", cause: "approval" });
  assert.deepEqual(run({ resumable: 1, ready: 1 }), { place: "needs-you", cause: "failure" });
  assert.deepEqual(run({ status: "done", resumable: 1, accepted: 1 }), { place: "needs-you", cause: "failure" }, "a finished run with a task to resume still waits");
  assert.deepEqual(run({ status: "awaiting_plan_approval", atWork: 0 }), { place: "needs-you", cause: "plan" });
  assert.deepEqual(run({ ready: 1 }), { place: "needs-you", cause: "result" });
  assert.deepEqual(run({ status: "awaiting_decision", ready: 1, atWork: 0 }), { place: "needs-you", cause: "result" });
  assert.deepEqual(run({ status: "planning", atWork: 0 }), { place: "in-progress", cause: null });
  assert.deepEqual(run({}), { place: "in-progress", cause: null });
  assert.deepEqual(run({ atWork: 1, limited: 1 }), { place: "in-progress", cause: null }, "one task waits for its limit while another is built");
  assert.deepEqual(run({ atWork: 0, limited: 1 }), { place: "waiting", cause: "usage-limit" });
  assert.deepEqual(run({ status: "done", accepted: 1, atWork: 0 }), { place: "completed", cause: null });
  assert.deepEqual(run({ status: "done", atWork: 0 }), { place: "ended", cause: null }, "a run with nothing accepted is not completed");
  assert.deepEqual(run({ status: "cancelled", atWork: 0 }), { place: "ended", cause: null });
  assert.deepEqual(run({ status: "failed", atWork: 0 }), { place: "failed", cause: null });
});

test("a chat needs the owner only while an agent of it asks for an approval", () => {
  assert.deepEqual(placeChat({ waitingOnApproval: true }), { place: "needs-you", cause: "approval" });
  assert.deepEqual(placeChat({ waitingOnApproval: false }), { place: "chat", cause: null });
});

test("what needs the owner is ordered by the stated rule alone: approvals, failures, plans, results; the longest wait first within each", () => {
  const rows = [
    { id: 1, cause: "result", since: "2026-11-23T10:00:00.000Z" },
    { id: 2, cause: "plan", since: "2026-11-23T09:00:00.000Z" },
    { id: 3, cause: "result", since: "2026-11-23T08:00:00.000Z" },
    { id: 4, cause: "approval", since: "2026-11-23T11:00:00.000Z" },
    { id: 5, cause: "failure", since: "2026-11-23T10:30:00.000Z" },
    { id: 6, cause: "approval", since: "2026-11-23T10:45:00.000Z" },
  ] as const;
  assert.deepEqual([...rows].sort(byNeed).map((row) => row.id), [6, 4, 5, 2, 3, 1]);
});

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
  chat: number;
}

/** One chat, sent through the chat code to Codex replaying its real CLI, before the server starts. */
async function seedChat(db: DatabaseSync, home: string): Promise<number> {
  const claude = new ClaudeCodeDriver();
  const broker = createBroker({ db, home, onChange: () => {} });
  const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
  const chat = createChat({ db, home, turns, claude, agents: { codex: chatReplayDriver("codex", "chat") }, onEvent: () => {} });
  try {
    const [first] = await chat.send({ message: "Name one primary colour", conversation: [], agents: [{ agent: "codex", model: null }] });
    for (let i = 0; i < 500 && chat.turnRunning(first!.attemptId); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!chat.turnRunning(first!.attemptId), "the chat's reply ended");
    return first!.attemptId;
  } finally {
    await chat.close();
    await turns.close();
    await broker.close();
  }
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-home-api-");
  let server: BotbenchServer | undefined;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  const home = path.join(dir, "home");
  const repo = path.join(dir, "billing-api");
  initRepo(repo);
  const db = openStore(home);
  const chat = await seedChat(db, home);
  db.close();
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  server = await startServer({ config, home, signInDelayMs: 1 });
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, repo: fs.realpathSync(repo), chat, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}
const getHome = async (api: Api): Promise<Home> => {
  const res = await call(api, "GET", "/api/home");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as unknown as Home;
};
const getWork = async (api: Api, query = ""): Promise<Work> => {
  const res = await call(api, "GET", `/api/work${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as unknown as Work;
};
const names = (items: Item[]): string[] => items.map((item) => `${item.kind} ${item.id}`);
/** Two rows are never written in the same millisecond, so "the longest wait" and "the newest change" are told apart. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

/** A stand-alone task as one being built stands: in a real copy, with the session its agent would have. */
async function building(api: Api, prompt: string): Promise<Task> {
  await tick();
  const db = api.server.db;
  const made = createTask(db, { repo: api.repo, prompt });
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${made.runId}`, task: `task-${made.id}` });
  const at = new Date().toISOString();
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', ?, ?)").run(at, at).lastInsertRowid);
  return moveTask(db, made.id, "building", { worktree, attemptId });
}

/** Put `made` at Ready for review with one committed file and its checks passed on that commit. */
async function ready(api: Api, made: Task): Promise<Task> {
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${made.runId}`, task: `task-${made.id}` });
  moveTask(api.server.db, made.id, "building", { worktree });
  write(worktree.path, `task-${made.id}.txt`, "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${made.id}` });
  assert.ok(committed.committed);
  storeChecks(api.server.db, made.id, committed.commit);
  await tick();
  return moveTask(api.server.db, made.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed" });
}
const readyTask = async (api: Api, prompt: string): Promise<Task> => ready(api, createTask(api.server.db, { repo: api.repo, prompt }));

/** A run waiting for the owner to approve its plan, stored as the engine stores one once its planner has answered. */
async function plannedRun(api: Api, titles: string[] = ["Add a greeting file"]): Promise<{ id: number; planVersion: number }> {
  await tick();
  const made = createRun(api.server.db, { repo: api.repo, prompt: "Plan the billing export", baseCommit: git(api.repo, "rev-parse", "HEAD").trim() });
  return { id: made.id, planVersion: storePlan(api.server.db, made.id, titles.map((title) => ({ title, criteria: [`${title} is done`] }))).planVersion };
}

interface Seeded {
  result: Task;
  plan: number;
  failure: Task;
  approval: Task;
  laterResult: Task;
  runResult: number;
  working: Task;
  queued: Task;
  limited: Task;
  accepted: Task;
  rejected: Task;
  cancelled: Task;
  stopped: Task;
  failed: Task;
  runCancelled: number;
}

/** One of everything, written oldest first in the order named here. */
async function seed(api: Api): Promise<Seeded> {
  const db = api.server.db;
  const result = await readyTask(api, "Cache the exchange rates for an hour\nand say so in the README");
  const plan = (await plannedRun(api, ["one", "two", "three", "four"])).id;
  const failure = await building(api, "Migrate the invoices table");
  await tick();
  moveTask(db, failure.id, "failed", { reason: `${CHANGED_NOTHING} Its last message is in the transcript.` });
  assert.notEqual(resumeNote(db, getTask(db, failure.id)!), null, "the task that changed no file can be resumed");
  const approval = await building(api, "Run other.sh and say what it printed");
  await tick();
  void api.server.broker.request({ taskId: approval.id, attemptId: approval.attemptId!, role: "implementer", tool: "Bash", command: "sh other.sh", cwd: ".", reason: null, toolCallId: "call-1" });
  const laterResult = await readyTask(api, "Add a function that adds two numbers");
  // A run still building, whose first task is ready for review.
  const partly = await plannedRun(api, ["first", "second"]);
  const partlyTasks = approvePlan(db, partly.id, partly.planVersion).tasks;
  await ready(api, partlyTasks[0]!);

  const working = await building(api, "Add a greeting to the README");
  await tick();
  const queued = createTask(db, { repo: api.repo, prompt: "Write tests for the CSV parser" });
  const limited = await building(api, "Tidy the changelog");
  moveTask(db, limited.id, "waiting_for_limit", { retryAt: "2026-11-24T14:30:00.000Z" });

  const accepted = await readyTask(api, "Fix the login timeout");
  assert.equal((await call(api, "POST", `/api/tasks/${accepted.id}/accept`, {})).status, 200);
  const rejected = await readyTask(api, "Rename the config loader");
  assert.equal((await call(api, "POST", `/api/tasks/${rejected.id}/reject`, { branch: "discard" })).status, 200);
  await tick();
  const cancelled = moveTask(db, createTask(db, { repo: api.repo, prompt: "Tidy module number 9" }).id, "cancelled");
  await tick();
  // Stopped before it had a copy of the project: there is nothing to resume.
  const stopped = moveTask(db, createTask(db, { repo: api.repo, prompt: "Regenerate the API client" }).id, "interrupted", { reason: "It was stopped." });
  assert.equal(resumeNote(db, stopped), null);
  await tick();
  const failed = moveTask(db, createTask(db, { repo: api.repo, prompt: "Generate the changelog from the release tags" }).id, "failed", { reason: "it broke" });
  const runCancelled = (await plannedRun(api)).id;
  cancelRun(db, runCancelled);
  return { result, plan, failure, approval, laterResult, runResult: partly.id, working, queued, limited, accepted, rejected, cancelled, stopped, failed, runCancelled };
}

test("Home and Work need a session, and take only GET", async (t) => {
  const api = await start(t);
  for (const route of ["/api/home", "/api/home/count", "/api/work"]) {
    const res = await fetch(`${api.base}${route}`);
    assert.equal(res.status, 401, route);
    await res.arrayBuffer();
  }
  assert.equal((await call(api, "POST", "/api/home", {})).status, 404);
});

test("with nothing but a chat, Home is four empty groups and Work lists the chat", async (t) => {
  const api = await start(t);
  const home = await getHome(api);
  assert.deepEqual([home.needsYou.total, home.inProgress.total, home.waiting.total, home.completed.total, home.failed, home.total], [0, 0, 0, 0, 0, 1]);
  assert.deepEqual(home.ended, { rejected: 0, cancelled: 0, stopped: 0, other: 0 });
  const work = await getWork(api);
  assert.deepEqual(names(work.items), [`chat ${api.chat}`]);
  assert.deepEqual([work.items[0]!.place, work.items[0]!.cause, work.items[0]!.agents], ["chat", null, ["codex"]]);
});

test("Home: everything that needs the owner, whole, in the stated order and with why; then what is in progress, what waits and for what, and what was accepted; the rest only counted", async (t) => {
  const api = await start(t);
  const s = await seed(api);
  const home = await getHome(api);

  // An approval holding an agent, a failure to recover, the plan, then the results, the longest wait first.
  assert.deepEqual(names(home.needsYou.items), [`task ${s.approval.id}`, `task ${s.failure.id}`, `run ${s.plan}`, `task ${s.result.id}`, `task ${s.laterResult.id}`, `run ${s.runResult}`]);
  assert.deepEqual(home.needsYou.items.map((item) => item.cause), ["approval", "failure", "plan", "result", "result", "result"]);
  assert.deepEqual([home.needsYou.total, home.needsYou.messages], [6, 0]);
  assert.deepEqual((await call(api, "GET", "/api/home/count")).body, { needsYou: 6 });
  const [approval, failure, plan, result, , runResult] = home.needsYou.items as [Item, Item, Item, Item, Item, Item];
  assert.deepEqual(approval.approval, { tool: "Bash", command: "sh other.sh" });
  assert.deepEqual([approval.title, approval.repo, approval.agents, approval.mode], ["Run other.sh and say what it printed", api.repo, ["claude-code"], "manual"]);
  assert.ok(approval.since > s.approval.updatedAt, "an approval has waited since it was asked for, not since its task started");
  assert.match(String(failure.reason), /^Claude Code finished without changing any file\./);
  assert.equal(failure.failure, "failed");
  assert.equal(plan.taskCount, 4);
  assert.equal(result.title, "Cache the exchange rates for an hour", "a task is named by the first line of what it was given");
  assert.equal(result.checks, "passed");
  const evidence = result.evidence as { state: string; words: string };
  assert.equal(evidence.state, "current");
  assert.equal(typeof evidence.words, "string");
  assert.deepEqual([runResult.readyCount, runResult.taskCount], [1, 2]);

  assert.deepEqual(names(home.inProgress.items), [`task ${s.working.id}`, `task ${s.queued.id}`], "the longest at work first");
  assert.equal(home.inProgress.total, 2);
  assert.deepEqual(home.inProgress.agents, [{ name: "claude-code", count: 2 }]);
  assert.deepEqual(home.inProgress.repos, [{ name: api.repo, count: 2 }]);

  // A wait for a usage limit is under Waiting, with its cause and the time it is tried again: it is not in progress.
  assert.deepEqual(names(home.waiting.items), [`task ${s.limited.id}`]);
  assert.deepEqual([home.waiting.items[0]!.cause, home.waiting.items[0]!.retryAt], ["usage-limit", "2026-11-24T14:30:00.000Z"]);
  assert.deepEqual(home.waiting.causes, [{ cause: "usage-limit", count: 1, retryAt: "2026-11-24T14:30:00.000Z" }]);

  // Completed is accepted work only. What ended any other way is counted, and is in Work.
  assert.deepEqual(names(home.completed.items), [`task ${s.accepted.id}`]);
  assert.deepEqual(home.completed.items[0]!.accepted, { by: "owner", pullRequests: [] });
  assert.deepEqual([home.completed.total, home.completed.lastDay, home.completed.withoutYou, home.completed.pullRequests], [1, 1, 0, 0]);
  assert.deepEqual(home.ended, { rejected: 1, cancelled: 2, stopped: 1, other: 0 });
  assert.equal(home.failed, 1);
  assert.equal(home.total, 16, "every listed run, task and chat");
  const onHome = [...home.needsYou.items, ...home.inProgress.items, ...home.waiting.items, ...home.completed.items];
  for (const gone of [s.rejected, s.cancelled, s.stopped, s.failed]) assert.ok(!onHome.some((item) => item.kind === "task" && item.id === gone.id), `task ${gone.id} is not on Home`);
});

test("Home stays whole where it must and short where it can: every item that needs the owner is sent, the lower groups send a few rows and count them all", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  for (let i = 0; i < 12; i++) await plannedRun(api);
  for (let i = 0; i < HOME_SHOWN + 5; i++) createTask(db, { repo: api.repo, prompt: `queued ${i}` });
  const home = await getHome(api);
  assert.deepEqual([home.needsYou.items.length, home.needsYou.total], [12, 12]);
  assert.deepEqual([home.inProgress.items.length, home.inProgress.total], [HOME_SHOWN, HOME_SHOWN + 5]);
  assert.deepEqual(home.inProgress.agents, [{ name: "claude-code", count: HOME_SHOWN + 5 }], "the summary is of the whole group, not of the rows sent");
});

test("a row hidden from the list is left out of Home's lower groups and of Work, but never out of Needs you", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  const waits = await readyTask(api, "Waits for a decision");
  const queued = createTask(db, { repo: api.repo, prompt: "Queued" });
  for (const id of [waits.id, queued.id]) assert.equal((await call(api, "POST", "/api/board/hide", { kind: "task", id })).status, 200);
  const home = await getHome(api);
  assert.deepEqual(names(home.needsYou.items), [`task ${waits.id}`]);
  assert.equal(home.inProgress.total, 0);
  assert.equal(home.total, 1, "the chat");
  const work = await getWork(api);
  assert.deepEqual([names(work.items), work.hidden, work.all], [[`chat ${api.chat}`], 2, 1]);
  assert.deepEqual(names((await getWork(api, "?hidden=1")).items).sort(), [`task ${waits.id}`, `task ${queued.id}`].sort());
});

test("Work: every run, task and chat, newest change first, each with its state and its menu; search by title, filters by kind and by state, each counted", async (t) => {
  const api = await start(t);
  const s = await seed(api);
  const all = await getWork(api);
  assert.equal(all.total, 16);
  assert.equal(all.all, 16);
  assert.deepEqual([all.next, all.older], [null, null]);
  assert.equal(all.items[0]!.id, s.runCancelled, "newest change first");
  assert.deepEqual(all.items.map((item) => item.updatedAt), all.items.map((item) => item.updatedAt as string).sort().reverse());
  assert.deepEqual(all.counts.kind, { all: 16, run: 3, task: 12, chat: 1 });
  assert.deepEqual(all.counts.state, { any: 16, "needs-you": 6, "in-progress": 2, waiting: 1, completed: 1, failed: 1, ended: 4 });
  const find = (work: Work, kind: string, id: number): Item => work.items.find((item) => item.kind === kind && item.id === id)!;
  // The row is the board's, so its state words and its More menu are built from the same facts as before.
  assert.deepEqual([find(all, "task", s.failed.id).status, find(all, "task", s.failed.id).place, find(all, "task", s.failed.id).discardable], ["failed", "failed", false]);
  assert.deepEqual([find(all, "task", s.failure.id).status, find(all, "task", s.failure.id).place, find(all, "task", s.failure.id).cause, find(all, "task", s.failure.id).discardable], ["failed", "needs-you", "failure", true]);
  assert.deepEqual([find(all, "run", s.plan).cancellable, find(all, "run", s.plan).taskCount], [true, 4]);
  assert.equal(typeof find(all, "task", s.result.id).branch, "string");

  // A filter by state. Failed is the failure nothing can resume; the one that can be is under Needs you.
  assert.deepEqual(names((await getWork(api, "?state=failed")).items), [`task ${s.failed.id}`]);
  assert.deepEqual(names((await getWork(api, "?state=waiting")).items), [`task ${s.limited.id}`]);
  assert.deepEqual(names((await getWork(api, "?state=completed")).items), [`task ${s.accepted.id}`]);
  assert.deepEqual(names((await getWork(api, "?state=ended")).items), [`run ${s.runCancelled}`, `task ${s.stopped.id}`, `task ${s.cancelled.id}`, `task ${s.rejected.id}`]);
  // A filter by kind, and both together; each filter's counts say what choosing it would show.
  const runs = await getWork(api, "?kind=run");
  assert.deepEqual(names(runs.items).sort(), [`run ${s.plan}`, `run ${s.runResult}`, `run ${s.runCancelled}`].sort());
  assert.deepEqual(runs.counts.state, { any: 3, "needs-you": 2, "in-progress": 0, waiting: 0, completed: 0, failed: 0, ended: 1 });
  assert.deepEqual(runs.counts.kind, { all: 16, run: 3, task: 12, chat: 1 });
  const needs = await getWork(api, "?kind=task&state=needs-you");
  assert.equal(needs.total, 4);
  assert.deepEqual(needs.counts.kind, { all: 6, run: 2, task: 4, chat: 0 });
  assert.deepEqual(names((await getWork(api, "?kind=chat")).items), [`chat ${api.chat}`]);

  // Search: the typed words anywhere in the title, in any case, trimmed.
  const found = await getWork(api, `?q=${encodeURIComponent("  THE CHANGELOG ")}`);
  assert.deepEqual(names(found.items), [`task ${s.failed.id}`, `task ${s.limited.id}`]);
  assert.deepEqual([found.total, found.all, found.counts.state.failed, found.counts.state.waiting], [2, 16, 1, 1]);
  assert.deepEqual((await getWork(api, "?q=nothing+has+these+words")).items, []);
  // Only the title is searched: the second line of what a task was given is not.
  assert.equal((await getWork(api, "?q=README")).total, 1);
});

test("Work is paged by a cursor: each page starts exactly after the last, whatever changed meanwhile, and says how much is older", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  const made: number[] = [];
  for (let i = 0; i < 7; i++) {
    await tick();
    made.push(moveTask(db, createTask(db, { repo: api.repo, prompt: `cancelled ${i}` }).id, "cancelled").id);
  }
  const newest = [...made].reverse().map((id) => `task ${id}`);
  const first = await getWork(api, "?kind=task&limit=3");
  assert.deepEqual(names(first.items), newest.slice(0, 3));
  assert.equal(first.total, 7);
  assert.equal(first.older!.count, 4);
  assert.equal(first.older!.oldest, getTask(db, made[0]!)!.updatedAt, "back to the oldest match");
  assert.equal(typeof first.next, "string");
  // A row made after the first page was read is newer than the cursor, so the next page neither repeats nor skips a row.
  await tick();
  createTask(db, { repo: api.repo, prompt: "made meanwhile" });
  const second = await getWork(api, `?kind=task&limit=3&cursor=${first.next}`);
  assert.deepEqual(names(second.items), newest.slice(3, 6));
  assert.equal(second.older!.count, 1);
  const third = await getWork(api, `?kind=task&limit=3&cursor=${second.next}`);
  assert.deepEqual(names(third.items), newest.slice(6));
  assert.deepEqual([third.next, third.older], [null, null]);
  assert.equal(third.total, 8, "the count is of every match, on every page");
});

test("Work refuses a value it does not take, saying what it takes; nothing is guessed at", async (t) => {
  const api = await start(t);
  const cursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const refused: [string, RegExp][] = [
    ["?kind=tasks", /^kind: expected one of all, run, task, chat$/],
    ["?state=finished", /^state: expected one of any, needs-you, in-progress, waiting, completed, failed, ended$/],
    ["?state=any&state=failed", /^state: given more than once$/],
    ["?hidden=yes", /^hidden: expected 1 or 0$/],
    ["?limit=0", /^limit: expected a whole number from 1 to 200$/],
    ["?limit=201", /^limit:/],
    ["?limit=5.5", /^limit:/],
    ["?limit=-1", /^limit:/],
    ["?limit=abc", /^limit:/],
    [`?q=${"a".repeat(201)}`, /^q: at most 200 characters$/],
    ["?cursor=", /^cursor:/],
    ["?cursor=not%20base64", /^cursor:/],
    [`?cursor=${Buffer.from("not json").toString("base64url")}`, /^cursor:/],
    [`?cursor=${cursor({ updatedAt: "x" })}`, /^cursor:/],
    [`?cursor=${cursor(["2026-11-23T10:00:00.000Z", "task"])}`, /^cursor:/],
    [`?cursor=${cursor(["2026-11-23T10:00:00.000Z", "plan", 1])}`, /^cursor:/],
    [`?cursor=${cursor(["2026-11-23T10:00:00.000Z", "task", 1.5])}`, /^cursor:/],
    [`?cursor=${cursor(["2026-11-23T10:00:00.000Z", "task", "1; DROP TABLE tasks"])}`, /^cursor:/],
    [`?cursor=${cursor([1, "task", 1])}`, /^cursor:/],
    [`?cursor=${"A".repeat(300)}`, /^cursor:/],
  ];
  for (const [query, error] of refused) {
    const res = await call(api, "GET", `/api/work${query}`);
    assert.equal(res.status, 400, query);
    assert.match(String(res.body.error), error, query);
  }
  // A search is words, never a pattern or a query: these find nothing and break nothing.
  for (const q of ["%", "_", "' OR 1=1 --", "\\", "*"]) assert.deepEqual((await getWork(api, `?q=${encodeURIComponent(q)}`)).items, [], q);
  assert.equal((await getWork(api, "?limit=200&hidden=0&kind=all&state=any&q=")).total, 1);
});

test("a planned run that is done is completed only when something of it was accepted", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  const kept = await plannedRun(api);
  const keptTask = approvePlan(db, kept.id, kept.planVersion).tasks[0]!;
  await ready(api, keptTask);
  transaction(db, () => settleRunIn(db, kept.id));
  assert.equal((await call(api, "POST", `/api/tasks/${keptTask.id}/accept`, {})).status, 200);
  const dropped = await plannedRun(api);
  const droppedTask = approvePlan(db, dropped.id, dropped.planVersion).tasks[0]!;
  await ready(api, droppedTask);
  transaction(db, () => settleRunIn(db, dropped.id));
  assert.equal((await call(api, "POST", `/api/tasks/${droppedTask.id}/reject`, { branch: "discard" })).status, 200);
  const home = await getHome(api);
  assert.deepEqual(names(home.completed.items), [`run ${kept.id}`]);
  assert.deepEqual(home.completed.items[0]!.accepted, { by: "owner", pullRequests: [] });
  assert.deepEqual(home.ended, { rejected: 1, cancelled: 0, stopped: 0, other: 0 });
  assert.deepEqual(names((await getWork(api, "?state=ended")).items), [`run ${dropped.id}`]);
});

test("a planned run says what is most urgent in it from its own tasks: a stopped task to resume with its reason and since when, and a wait on a usage limit since the task began to wait", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  const attempt = (): number => Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('codex', 'ended', ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  // A run whose first task went silent and was stopped with its copy left, so the owner can resume it.
  const stoppedRun = await plannedRun(api, ["first", "second"]);
  const [first] = approvePlan(db, stoppedRun.id, stoppedRun.planVersion).tasks;
  const copy = await createWorktree({ repo: api.repo, home: api.home, run: `run-${first!.runId}`, task: `task-${first!.id}` });
  moveTask(db, first!.id, "building", { worktree: copy, attemptId: attempt() });
  await tick();
  const stopped = moveTask(db, first!.id, "interrupted", { reason: "Codex went silent." });
  assert.notEqual(resumeNote(db, stopped), null);
  // A run whose only task waits for its builder's usage limit, long after the run started.
  const limitedRun = await plannedRun(api, ["only"]);
  const [only] = approvePlan(db, limitedRun.id, limitedRun.planVersion).tasks;
  const other = await createWorktree({ repo: api.repo, home: api.home, run: `run-${only!.runId}`, task: `task-${only!.id}` });
  moveTask(db, only!.id, "building", { worktree: other, attemptId: attempt() });
  await tick();
  const limited = moveTask(db, only!.id, "waiting_for_limit", { retryAt: "2026-11-24T09:00:00.000Z" });

  const home = await getHome(api);
  assert.deepEqual(names(home.needsYou.items), [`run ${stoppedRun.id}`]);
  const [needs] = home.needsYou.items as [Item];
  assert.deepEqual([needs.cause, needs.failure, needs.reason, needs.since], ["failure", "stopped", "Codex went silent.", stopped.updatedAt]);
  assert.deepEqual(names(home.waiting.items), [`run ${limitedRun.id}`]);
  const [waits] = home.waiting.items as [Item];
  assert.deepEqual([waits.cause, waits.retryAt, waits.since], ["usage-limit", "2026-11-24T09:00:00.000Z", limited.updatedAt]);
  assert.ok(waits.since > (waits.updatedAt as string), "the wait is counted from the task's move, not from the run's last change");
  assert.equal(home.inProgress.total, 0, "a run that only waits is not in progress");
  const work = await getWork(api, "?kind=run");
  assert.deepEqual(work.items.map((item) => [item.id, item.place, item.cause, item.failure]), [[limitedRun.id, "waiting", "usage-limit", null], [stoppedRun.id, "needs-you", "failure", "stopped"]]);
});
