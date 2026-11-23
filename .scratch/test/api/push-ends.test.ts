import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { createRun, getRun, storePlan } from "../../src/engine/run.ts";
import { CHANGED_NOTHING, createTask, createTasks, getTask, moveTask } from "../../src/engine/task.ts";
import { createPush } from "../../src/push.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { openStore } from "../../src/store/db.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { decrypt, newDevice, startPushEndpoint, type Device, type PushEndpoint } from "../support/push-service.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// Notifications for a task that ends failed or stopped, and for a run that ends with nothing to review: a real Botbench
// server over real SQLite, a real temporary repository, and a real HTTP server as the push endpoint
// (test/support/push-service.ts), whose bodies are decrypted with each device's own key as the browser would. A run's
// tasks fail at a real setup command, so no CLI is started; the task whose builder changed no file is built with a turn
// replayed from a real Claude Code session. A restart is a new Botbench over the same data folder.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const TWO = [
  { title: "Add hello.txt", criteria: ["hello.txt says hi"] },
  { title: "Add bye.txt", criteria: ["bye.txt says bye"] },
];
/** What the failing setup command prints and the repository is called: neither may reach a notification. */
const SECRET = "secret-marker";

interface Bench {
  dir: string;
  home: string;
  repo: string;
  base: string;
  config: Config;
  endpoint: PushEndpoint;
  devices: Record<"phone" | "tablet", Device>;
}

async function bench(t: T): Promise<Bench> {
  const dir = tempDir("botbench-push-ends-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "private-repo");
  const base = initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: { setup: [`echo ${SECRET} in /Users/me/private-repo; exit 1`] } } };
  const endpoint = await startPushEndpoint();
  t.after(async () => {
    await endpoint.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, home, repo, base, config, endpoint, devices: { phone: newDevice(), tablet: newDevice() } };
}

async function boot(t: T, b: Bench): Promise<BotbenchServer> {
  const server = await startServer({ config: b.config, home: b.home, signInDelayMs: 1, allowHttpPushEndpoints: true });
  t.after(() => server.close());
  return server;
}

function subscribeAll(server: BotbenchServer, b: Bench): void {
  for (const [name, device] of Object.entries(b.devices)) server.push.subscribe(device.subscription(b.endpoint.url(name)));
}

/** Each device's decrypted messages, sorted, so the order two sends arrive in does not matter. */
function inbox(b: Bench): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, device] of Object.entries(b.devices)) {
    out[name] = b.endpoint.received.filter((r) => r.path === `/push/${name}`).map((r) => decrypt(r.body, device.privateKey, device.auth).toString("utf8")).sort();
  }
  return out;
}

/** Every body as sent and as decrypted holds only a title and a path, and none of `forbidden`. */
function onlyFixedText(b: Bench, forbidden: readonly string[]): void {
  for (const [name, bodies] of Object.entries(inbox(b))) {
    for (const body of bodies) {
      const message = JSON.parse(body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(message).sort(), ["path", "title"], body);
      for (const word of forbidden) assert.ok(!body.includes(word), `${word} in ${name}'s notification ${body}`);
    }
  }
  for (const r of b.endpoint.received) for (const word of forbidden) assert.ok(!r.body.toString("latin1").includes(word), `${word} in a body as sent`);
}

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A planned run of two tasks approved through the server's own route, as the owner's tap would; each task's setup fails. */
async function runThatFails(server: BotbenchServer, b: Bench): Promise<{ runId: number; taskIds: number[] }> {
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(b.home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(signIn.status, 200);
  await signIn.arrayBuffer();
  const cookie = signIn.headers.getSetCookie()[0]!.split(";")[0]!;
  const run = createRun(server.db, { repo: b.repo, prompt: "Add two files to the private repo", baseCommit: b.base });
  const planned = storePlan(server.db, run.id, TWO);
  const res = await fetch(`${base}/api/runs/${run.id}/plan/approve`, { method: "POST", headers: { cookie, ...JSON_TYPE }, body: JSON.stringify({ planVersion: planned.planVersion }) });
  assert.equal(res.status, 200, await res.text());
  await until("the run is done", () => getRun(server.db, run.id)?.status === "done");
  const taskIds = server.db.prepare("SELECT id FROM tasks WHERE run_id = ? ORDER BY id").all(run.id).map((row) => Number(row.id));
  return { runId: run.id, taskIds };
}

const failed = (id: number) => JSON.stringify({ title: "A task failed", path: `/#/tasks/${id}` });
const stopped = (id: number) => JSON.stringify({ title: "A task stopped", path: `/#/tasks/${id}` });
const nothing = (id: number) => JSON.stringify({ title: "A run ended with nothing to review", path: `/#/runs/${id}` });

test("a run whose tasks fail sends one push per device for each failed task and one for the run, through the server's hooks, and none again for the same state or after a restart", { skip: NO_SANDBOX }, async (t) => {
  const b = await bench(t);
  const server = await boot(t, b);
  subscribeAll(server, b);
  const { runId, taskIds } = await runThatFails(server, b);
  await server.push.idle();
  assert.deepEqual(taskIds.map((id) => getTask(server.db, id)!.status), ["failed", "failed"]);
  const expected = [...taskIds.map(failed), nothing(runId)].sort();
  assert.deepEqual(inbox(b), { phone: expected, tablet: expected });
  const reasons = taskIds.map((id) => getTask(server.db, id)!.reason!);
  for (const reason of reasons) assert.match(reason, new RegExp(SECRET), "the failure's reason has the marker, so its absence below means something");
  onlyFixedText(b, [...reasons, SECRET, "private-repo", "echo", "/Users", "Add two files", "hello.txt", "setup"]);

  // The same states again, through the same hooks: nothing more is sent.
  for (const id of taskIds) server.push.taskChanged(getTask(server.db, id)!);
  server.push.runChanged(getRun(server.db, runId)!);
  await server.push.idle();
  assert.equal(b.endpoint.received.length, 6);

  // A new Botbench over the same data folder, told the same again: still only the first messages.
  await server.close();
  const again = await boot(t, b);
  for (const id of taskIds) again.push.taskChanged(getTask(again.db, id)!);
  again.push.runChanged(getRun(again.db, runId)!);
  await again.push.idle();
  assert.deepEqual(inbox(b), { phone: expected, tablet: expected });
  assert.equal(Number(again.db.prepare("SELECT count(*) AS n FROM push_sent").get()!.n), 3);
});

test("tasks a restart stops, one of them after its second restart, send one push per device each, and none again after another restart", async (t) => {
  const b = await bench(t);
  // What a Botbench that stopped left in its data folder, written with no Botbench running, so no start's recovery reads it half-written.
  const db = openStore(b.home);
  const before = createPush({ db, home: b.home, allowHttpEndpoints: true });
  for (const [name, device] of Object.entries(b.devices)) before.subscribe(device.subscription(b.endpoint.url(name)));
  // A task that was being built when Botbench stopped for the second time: its count of restarts is already 1.
  const twice = createTask(db, { repo: b.repo, prompt: "build the secret-marker feature" });
  const worktree = await createWorktree({ repo: b.repo, home: b.home, run: "run-00000001", task: `task-${twice.id}` });
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  moveTask(db, twice.id, "building", { worktree, attemptId });
  db.prepare("UPDATE tasks SET restarts = 1 WHERE id = ?").run(twice.id);
  // A task that was on its way before it had a copy of the project: a restart stops it at once.
  const early = createTask(db, { repo: b.repo, prompt: "another secret-marker task" });
  moveTask(db, early.id, "building");
  db.close();

  const second = await boot(t, b);
  await until("both tasks are stopped", () => [twice.id, early.id].every((id) => getTask(second.db, id)!.status === "interrupted"));
  await second.push.idle();
  assert.match(getTask(second.db, twice.id)!.reason!, /Botbench stopped twice/);
  const expected = [stopped(twice.id), stopped(early.id)].sort();
  assert.deepEqual(inbox(b), { phone: expected, tablet: expected });
  onlyFixedText(b, [getTask(second.db, twice.id)!.reason!, getTask(second.db, early.id)!.reason!, SECRET, "private-repo", "/Users"]);

  second.push.taskChanged(getTask(second.db, twice.id)!);
  await second.close();
  const third = await boot(t, b);
  for (const id of [twice.id, early.id]) third.push.taskChanged(getTask(third.db, id)!);
  await third.push.idle();
  assert.deepEqual(inbox(b), { phone: expected, tablet: expected });
});

test("a task whose builder changed no file fails and sends one push per device, and the same state after a restart sends none", async (t) => {
  const b = await bench(t);
  const open = async () => {
    const db = openStore(b.home);
    const broker = createBroker({ db, home: b.home, onChange: () => {} });
    await broker.listen();
    const push = createPush({ db, home: b.home, allowHttpEndpoints: true });
    // The same hook the server gives the engine (src/server.ts). No setup command: the replayed "done" turn edits nothing.
    const tasks = createTasks({ db, home: b.home, driver: buildReplayDriver(["done"]), broker, model: "haiku", repoCommands: () => ({ setup: [], checks: [] }), onEvent: () => {}, onTaskChange: push.taskChanged, onRunChange: push.runChanged });
    const close = async () => {
      await tasks.close();
      await broker.close();
      await push.idle();
      db.close();
    };
    return { db, push, tasks, close };
  };
  const one = await open();
  for (const [name, device] of Object.entries(b.devices)) one.push.subscribe(device.subscription(b.endpoint.url(name)));
  const task = await one.tasks.start(b.repo, "change the secret-marker file");
  await one.tasks.idle();
  await one.push.idle();
  const ended = getTask(one.db, task.id)!;
  assert.equal(ended.status, "failed");
  assert.ok(ended.reason!.startsWith(CHANGED_NOTHING), ended.reason!);
  assert.deepEqual(inbox(b), { phone: [failed(task.id)], tablet: [failed(task.id)] });
  onlyFixedText(b, [ended.reason!, "Claude Code", SECRET, "private-repo"]);
  one.push.taskChanged(ended);
  await one.close();

  const two = await open();
  t.after(two.close);
  two.push.taskChanged(getTask(two.db, task.id)!);
  await two.push.idle();
  assert.deepEqual(inbox(b), { phone: [failed(task.id)], tablet: [failed(task.id)] });
});

for (const trouble of ["the push service cannot be reached", "the push service answers 500", "the record of what was sent cannot be written"] as const) {
  test(`when ${trouble}, the tasks still fail and the run still ends, and the error is only logged`, { skip: NO_SANDBOX }, async (t) => {
    const b = await bench(t);
    const server = await boot(t, b);
    subscribeAll(server, b);
    if (trouble === "the push service cannot be reached") await b.endpoint.close();
    if (trouble === "the push service answers 500") for (const name of Object.keys(b.devices)) b.endpoint.answer(name, 500);
    // A real refusal by the database itself, as a full disk or a locked file would give.
    if (trouble === "the record of what was sent cannot be written") server.db.exec("CREATE TRIGGER push_sent_refused BEFORE INSERT ON push_sent BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    t.after(() => (console.error = original));
    const { runId, taskIds } = await runThatFails(server, b);
    await server.push.idle();
    console.error = original;
    assert.deepEqual(taskIds.map((id) => getTask(server.db, id)!.status), ["failed", "failed"]);
    assert.equal(getRun(server.db, runId)!.status, "done");
    if (trouble === "the record of what was sent cannot be written") {
      assert.equal(b.endpoint.received.length, 0, "nothing is sent that could not be recorded, so nothing is sent twice");
      assert.ok(logged.some((line) => /^A notification for a task could not be started: .*disk I\/O error/.test(line)), logged.join("\n"));
      assert.ok(logged.some((line) => /^A notification for a run could not be started: .*disk I\/O error/.test(line)), logged.join("\n"));
    } else {
      assert.ok(logged.filter((line) => line.startsWith("A notification to http://127.0.0.1")).length >= 6, logged.join("\n"));
      assert.equal(Number(server.db.prepare("SELECT count(*) AS n FROM push_subscriptions").get()!.n), 2, "a failure is no expiry");
    }
  });
}
