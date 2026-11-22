import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";
import { checkoutState, initRepo, smeltBranches, tempDir, worktreeCount } from "../support/repo.ts";

// No test in this file starts a driver: turns and tasks that reach Claude Code with a chosen model are in
// test/live/models.live.test.ts, and so is the list the real CLI reports.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const BARE: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };

async function start(t: T, config: Config = BARE, dir = tempDir("smelt-models-api-")): Promise<{ server: SmeltServer; dir: string; home: string; base: string; headers: Record<string, string> }> {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { server, dir, home, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function get(base: string, headers: Record<string, string>, route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function post(base: string, headers: Record<string, string>, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * For the rest of the test, this process is a machine on which Claude Code is not installed: every PATH folder
 * that holds a `claude` is left out, so Smelt's attempt to start the CLI really fails and nothing of it runs.
 */
function withoutClaudeOnPath(t: T): void {
  const saved = process.env.PATH;
  t.after(() => (process.env.PATH = saved));
  process.env.PATH = (saved ?? "")
    .split(path.delimiter)
    .filter((dir) => dir !== "" && !fs.existsSync(path.join(dir, "claude")))
    .join(path.delimiter);
}

test("GET /api/models needs a session; where Claude Code reports no list, it returns the configured list, says it is from configuration, and gives the default", async (t) => {
  withoutClaudeOnPath(t);
  const models = ["sonnet", "claude-haiku-4-5-20251001"];
  const listed = models.map((id) => ({ id }));

  // The role's model comes before the driver's own.
  const both = await start(t, { ...BARE, drivers: { "claude-code": { model: "sonnet", models } }, roles: { implementer: { driver: "claude-code", model: "claude-haiku-4-5-20251001" } } });
  const refused = await fetch(`${both.base}/api/models`);
  assert.equal(refused.status, 401, "without a session");
  assert.doesNotMatch(await refused.text(), /sonnet|haiku/);
  assert.deepEqual(await get(both.base, both.headers, "/api/models"), {
    status: 200,
    body: { driver: "claude-code", source: "config", models: listed, default: "claude-haiku-4-5-20251001", cliDefault: null },
  });

  const driverOnly = await start(t, { ...BARE, drivers: { "claude-code": { model: "sonnet", models } }, roles: { implementer: { driver: "claude-code" } } });
  assert.equal((await get(driverOnly.base, driverOnly.headers, "/api/models")).body.default, "sonnet");

  // Nothing configured: no list to offer and no default but the CLI's own.
  const bare = await start(t);
  assert.deepEqual((await get(bare.base, bare.headers, "/api/models")).body, { driver: "claude-code", source: "config", models: [], default: null, cliDefault: null });
  for (const { server } of [both, driverOnly, bare]) assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no attempt was started");
});

/** Values that are not a plain model name. Each would otherwise become an argument of the CLI. */
const NOT_A_MODEL_NAME: unknown[] = [
  "-p",
  "--dangerously-skip-permissions",
  "--model=opus",
  "-",
  " haiku",
  "haiku ",
  "hai ku",
  "haiku\n",
  "haiku\t--verbose",
  "hai\u0000ku",
  "hai\u001bku",
  "—model",
  "haiku;rm",
  "$(id)",
  "ha'iku",
  'ha"iku',
  "",
  "x".repeat(101),
  7,
  true,
  ["haiku"],
  { id: "haiku" },
];

test("a model that is not a plain model name is refused with 400 before any attempt, task row or worktree exists", async (t) => {
  const { server, base, headers, dir, home } = await start(t);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const before = checkoutState(repo);
  const scratchBefore = fs.readdirSync(path.join(home, "scratch"));

  for (const model of NOT_A_MODEL_NAME) {
    const shown = JSON.stringify(model).slice(0, 60);
    const turn = await post(base, headers, "/api/turns", { prompt: "hi", model });
    assert.equal(turn.status, 400, `turn with model ${shown}`);
    assert.match(String(turn.body.error), /model/i);
    assert.equal(turn.body.attemptId, undefined);
    const task = await post(base, headers, "/api/tasks", { repo, prompt: "create hello.txt", model });
    assert.equal(task.status, 400, `task with model ${shown}`);
    assert.match(String(task.body.error), /model/i);
    assert.equal(task.body.taskId, undefined);
  }
  // The refusal says what a model name may be, and never repeats control characters back.
  const words = String((await post(base, headers, "/api/turns", { prompt: "hi", model: "--dangerously-skip-permissions" })).body.error);
  assert.match(words, /letter or a digit/);

  for (const table of ["attempts", "events", "tasks", "task_events"]) assert.equal(server.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, `no row in ${table}`);
  assert.equal(fs.existsSync(path.join(home, "worktrees")), false, "no worktree folder");
  assert.deepEqual(fs.readdirSync(path.join(home, "scratch")), scratchBefore);
  assert.equal(worktreeCount(repo), 1);
  assert.deepEqual(smeltBranches(repo), []);
  assert.deepEqual(checkoutState(repo), before);

  // A plain name passes the check; here the attempt it names does not exist, so still nothing starts.
  for (const model of ["haiku", "claude-haiku-4-5-20251001", "claude-opus-4-8[1m]", "us.anthropic.claude-haiku-4-5-20251001-v1:0", null]) {
    assert.equal((await post(base, headers, "/api/turns", { prompt: "hi", attemptId: 4242, model })).status, 404, JSON.stringify(model));
  }
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0);
});

test("POST /api/tasks records the model asked for: the one named, the CLI's own default for null, the configured one when none is given", async (t) => {
  // Smelt's home inside the repository: each task is real and fails at its first step, before any driver could start.
  const repo = tempDir("smelt-models-api-");
  initRepo(repo);
  const { server, base, headers } = await start(t, { ...BARE, drivers: { "claude-code": { model: "sonnet" } }, roles: { implementer: { driver: "claude-code" } } }, repo);

  const asked: [Record<string, unknown>, string | null][] = [
    [{ model: "claude-haiku-4-5-20251001" }, "claude-haiku-4-5-20251001"],
    [{ model: null }, null],
    [{}, "sonnet"],
  ];
  for (const [extra, expected] of asked) {
    const started = await post(base, headers, "/api/tasks", { repo, prompt: "create hello.txt", ...extra });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const id = Number(started.body.taskId);
    assert.equal(server.db.prepare("SELECT requested_model FROM tasks WHERE id = ?").get(id)!.requested_model, expected);
    assert.equal((await get(base, headers, `/api/tasks/${id}`)).body.requestedModel, expected);
  }
  const listed = (await get(base, headers, "/api/tasks")).body.tasks as { requestedModel: string | null }[];
  assert.deepEqual(listed.map((task) => task.requestedModel), ["sonnet", null, "claude-haiku-4-5-20251001"]);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no driver was started");
});
