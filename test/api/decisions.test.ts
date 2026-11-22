import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { createTask, moveTask, type Task } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { botbenchBranches, checkoutState, initRepo, tempDir, worktreeCount, write } from "../support/repo.ts";

// The decision routes over real HTTP, against a real Botbench server, a real temporary repository and real SQLite. No
// driver is started: tasks are put at Ready for review by Botbench's own worktree and commit functions, as the task API
// tests do. A decision made through a real build is in test/engine/decision.test.ts and e2e/decision.e2e.ts.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-decisions-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

/** Put `task` at Ready for review with one committed file, in a worktree under the run named `run`. */
async function ready(api: Api, task: Task, run = `run-${task.runId}`, file = "hello.txt"): Promise<string> {
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run, task: `task-${task.id}` });
  moveTask(api.server.db, task.id, "building", { worktree });
  write(worktree.path, file, "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  moveTask(api.server.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "failed" });
  return worktree.path;
}

test("the decision routes refuse a request without a session", async (t) => {
  const api = await start(t);
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  const dir = await ready(api, task);
  for (const [route, body] of [[`/api/tasks/${task.id}/accept`, {}], [`/api/tasks/${task.id}/reject`, { branch: "discard" }]] as const) {
    const res = await fetch(`${api.base}${route}`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify(body) });
    assert.equal(res.status, 401, route);
    await res.arrayBuffer();
  }
  assert.equal(fs.existsSync(dir), true, "nothing came of the refused requests");
});

test("Accept over HTTP keeps the branch, removes the worktree, announces the task, and the task still shows its changes, read from the kept branch; a second decision is refused", async (t) => {
  const api = await start(t);
  const before = checkoutState(api.repo);
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  const dir = await ready(api, task);
  const shown = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
  assert.deepEqual([shown.status, shown.leftovers, shown.decision], ["awaiting_decision", [], null]);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${api.base}/api/stream`, { headers: api.headers, signal: abort.signal });
  const frames: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream.body!) frames.push(decoder.decode(chunk, { stream: true }));
    } catch {
      // Aborted when the test ends.
    }
  })();

  const accepted = await call(api, "POST", `/api/tasks/${task.id}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, "accepted");
  const decision = accepted.body.decision as Body;
  assert.deepEqual([decision.decision, decision.branch, decision.branchName, decision.leftovers, decision.decidedBy], ["accept", "kept", shown.branch, [], "owner"]);
  assert.equal(accepted.body.leftovers, null, "a decided task has no copy left to list");
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(botbenchBranches(api.repo), [shown.branch]);
  assert.deepEqual(checkoutState(api.repo), before);

  // What the owner now has: the branch, with its changes still readable from it.
  assert.deepEqual((accepted.body.files as Body[]).map((f) => f.path), ["hello.txt"]);
  assert.equal(accepted.body.filesProblem, null);
  const diff = await call(api, "GET", `/api/tasks/${task.id}/diff?file=hello.txt`);
  assert.equal(diff.status, 200);
  assert.match(String(diff.body.diff), /\n\+hi\n$/);

  const deadline = Date.now() + 5000;
  const announced = (): boolean => frames.join("").includes(`"taskId":${task.id},"status":"accepted"`);
  while (!announced() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(announced(), "the decision was announced on the event stream");

  const again = await call(api, "POST", `/api/tasks/${task.id}/accept`, {});
  assert.equal(again.status, 409);
  assert.match(String(again.body.error), /already accepted/i);
  const reject = await call(api, "POST", `/api/tasks/${task.id}/reject`, { branch: "discard" });
  assert.equal(reject.status, 409);
  assert.deepEqual(botbenchBranches(api.repo), [shown.branch]);
});

test("Reject over HTTP: discard deletes the branch and the task says its changes are gone with it; keep leaves the branch; a bad request is refused in words", async (t) => {
  const api = await start(t);
  const one = createTask(api.server.db, { repo: api.repo, prompt: "one" });
  const two = createTask(api.server.db, { repo: api.repo, prompt: "two" });
  await ready(api, one);
  await ready(api, two);
  const branchOf = async (task: Task): Promise<string> => String((await call(api, "GET", `/api/tasks/${task.id}`)).body.branch);
  const keptBranch = await branchOf(two);

  for (const body of [{}, { branch: "later" }, "not json"]) {
    const res = await call(api, "POST", `/api/tasks/${one.id}/reject`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof res.body.error, "string");
  }

  const discarded = await call(api, "POST", `/api/tasks/${one.id}/reject`, { branch: "discard" });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.deepEqual([discarded.body.status, (discarded.body.decision as Body).branch], ["rejected", "deleted"]);
  assert.deepEqual([discarded.body.files, discarded.body.filesProblem], [null, null]);
  const diff = await call(api, "GET", `/api/tasks/${one.id}/diff?file=hello.txt`);
  assert.equal(diff.status, 409);
  assert.match(String(diff.body.error), /branch was deleted/i);

  const kept = await call(api, "POST", `/api/tasks/${two.id}/reject`, { branch: "keep" });
  assert.equal(kept.status, 200);
  assert.equal((kept.body.decision as Body).branch, "kept");
  assert.deepEqual(botbenchBranches(api.repo), [keptBranch]);
  assert.equal(worktreeCount(api.repo), 1);
});

test("deciding a task that is not ready for review is refused with 409 and a plain reason", async (t) => {
  const api = await start(t);
  const queued = createTask(api.server.db, { repo: api.repo, prompt: "queued" });
  // Stored as queued by the engine itself, so no build line takes it up: it stays queued.
  const res = await call(api, "POST", `/api/tasks/${queued.id}/accept`, {});
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /not ready for review/i);
  assert.equal((await call(api, "POST", "/api/tasks/999/accept", {})).status, 404);
});

test("files the checks left are listed on the task, and Accept is refused without the owner's confirmation of them and made with it", async (t) => {
  const api = await start(t);
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  const dir = await ready(api, task);
  write(dir, "coverage/report.txt", "left by a check\n");
  assert.deepEqual((await call(api, "GET", `/api/tasks/${task.id}`)).body.leftovers, ["coverage/report.txt"]);

  const refused = await call(api, "POST", `/api/tasks/${task.id}/accept`, {});
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /left by the checks/);
  assert.deepEqual(refused.body.leftovers, ["coverage/report.txt"]);
  assert.equal(fs.existsSync(path.join(dir, "coverage/report.txt")), true);

  const accepted = await call(api, "POST", `/api/tasks/${task.id}/accept`, { removeLeftovers: ["coverage/report.txt"] });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual((accepted.body.decision as Body).leftovers, ["coverage/report.txt"]);
  assert.equal(fs.existsSync(dir), false);
});

test("a run's screen lists each task's decision, and the run is done once the last task is decided", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  const planned = storePlan(db, createRun(db, { repo: api.repo, prompt: "two files", baseCommit: checkoutState(api.repo).head }).id, [
    { title: "one", criteria: ["one.txt exists"] },
    { title: "two", criteria: ["two.txt exists"] },
  ]);
  const { tasks } = approvePlan(db, planned.id, planned.planVersion);
  for (const task of tasks) await ready(api, task, `run-${planned.id}`, `${task.id}.txt`);
  // Both built: the run waits for the owner, as the build line leaves it. Written here directly, a shortcut: the build
  // line reaching this state is tested in test/engine/build.test.ts and test/engine/decision.test.ts.
  db.prepare("UPDATE runs SET status = 'awaiting_decision' WHERE id = ?").run(planned.id);

  const read = async (): Promise<Body> => (await call(api, "GET", `/api/runs/${planned.id}`)).body;
  assert.deepEqual(((await read()).tasks as Body[]).map((task) => [task.status, task.decision, task.leftovers]), [["awaiting_decision", null, []], ["awaiting_decision", null, []]]);

  assert.equal((await call(api, "POST", `/api/tasks/${tasks[0]!.id}/accept`, {})).status, 200);
  let run = await read();
  assert.equal(run.status, "awaiting_decision");
  assert.deepEqual((run.tasks as Body[]).map((task) => task.status), ["accepted", "awaiting_decision"]);
  assert.equal(((run.tasks as Body[])[0]!.decision as Body).branch, "kept");

  assert.equal((await call(api, "POST", `/api/tasks/${tasks[1]!.id}/reject`, { branch: "discard" })).status, 200);
  run = await read();
  assert.equal(run.status, "done");
  assert.deepEqual((run.tasks as Body[]).map((task) => [task.status, (task.decision as Body).branch]), [["accepted", "kept"], ["rejected", "deleted"]]);
});
