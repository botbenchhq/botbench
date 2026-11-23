import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { createChat } from "../../src/api/chat.ts";
import { createTurns } from "../../src/api/turns.ts";
import type { Config } from "../../src/config.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { createRun } from "../../src/engine/run.ts";
import { createTask } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { chatReplayDriver } from "../support/replay-chat.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// The first-run state of an installation (GET /api/first-run), over real HTTP on a real store. It is true on an empty
// data folder and false for good once one chat, task or run has been stored: after a restart, and after that chat,
// task or run is gone. The chat is stored by the chat itself, Codex replaying a session captured from its real CLI
// (test/support/replay-chat.ts); the task and the run are stored as the engine stores them. No model turn is started.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  home: string;
  repo: string;
  commit: string;
  firstRun(): Promise<unknown>;
  restart(): Promise<Api>;
}

async function start(t: T, dir: string, home: string, repo: string, commit: string): Promise<Api> {
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) (closed = true), await server.close();
  };
  t.after(close);
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await signIn.arrayBuffer();
  const cookie = signIn.headers.getSetCookie()[0]!.split(";")[0]!;
  // Like every route but sign-in, it needs the owner's session.
  const refused = await fetch(`${base}/api/first-run`);
  await refused.arrayBuffer();
  assert.equal(refused.status, 401);
  return {
    server,
    home,
    repo,
    commit,
    firstRun: async () => {
      const res = await fetch(`${base}/api/first-run`, { headers: { cookie } });
      assert.equal(res.status, 200);
      return ((await res.json()) as { firstRun: unknown }).firstRun;
    },
    restart: async () => (await close(), start(t, dir, home, repo, commit)),
  };
}

async function fresh(t: T): Promise<Api> {
  const dir = tempDir("botbench-first-run-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const commit = initRepo(repo);
  return start(t, dir, path.join(dir, "home"), repo, commit);
}

test("an empty data folder is a first run, and asking does not end it", async (t) => {
  const api = await fresh(t);
  assert.equal(await api.firstRun(), true);
  assert.equal(await api.firstRun(), true);
  const again = await api.restart();
  assert.equal(await again.firstRun(), true);
});

test("the first run ends once a chat is stored, and stays ended after a restart", async (t) => {
  const api = await fresh(t);
  const { db } = api.server;
  const claude = new ClaudeCodeDriver();
  const turns = createTurns({ db, home: api.home, driver: claude, onEvent: () => {} });
  const chat = createChat({ db, home: api.home, turns, claude, agents: { codex: chatReplayDriver("codex") }, onEvent: () => {} });
  const [reply] = await chat.send({ message: "Name one primary colour.", conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }] });
  for (let i = 0; i < 500 && chat.turnRunning(reply!.attemptId); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await chat.close();
  await turns.close();
  assert.equal(await api.firstRun(), false);
  const again = await api.restart();
  assert.equal(await again.firstRun(), false);
});

test("the first run ends once a task is stored", async (t) => {
  const api = await fresh(t);
  createTask(api.server.db, { repo: api.repo, prompt: "Add a file" });
  assert.equal(await api.firstRun(), false);
});

test("the first run stays ended after what ended it is gone, and after a restart", async (t) => {
  const api = await fresh(t);
  const { db } = api.server;
  // Botbench removes no chat, task or run today, and their events are append-only. A chat's attempt, inserted exactly
  // as the drivers insert one and before any event is stored, is the one row that can be taken out again, so the rule is
  // seen not to hang on anything still stored.
  const at = new Date().toISOString();
  const { lastInsertRowid } = db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'running', NULL, ?, ?)").run("codex", null, at, at);
  assert.equal(await api.firstRun(), false);
  db.prepare("DELETE FROM attempts WHERE id = ?").run(lastInsertRowid);
  const stored = (table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  assert.deepEqual([stored("attempts"), stored("tasks"), stored("runs")], [0, 0, 0]);
  assert.equal(await api.firstRun(), false);
  const again = await api.restart();
  assert.equal(await again.firstRun(), false);
});

test("the first run ends once a run is stored", async (t) => {
  const api = await fresh(t);
  createRun(api.server.db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit });
  assert.equal(await api.firstRun(), false);
});

test("the first-run mark cannot be taken back: it is neither changed nor deleted", async (t) => {
  const api = await fresh(t);
  const { db } = api.server;
  createRun(db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit });
  assert.throws(() => db.prepare("DELETE FROM first_use").run(), /first use is kept/);
  assert.throws(() => db.prepare("UPDATE first_use SET at = 'x'").run(), /first use is kept/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO first_use (id, at) VALUES (1, 'x')").run(), /first use is kept/);
  assert.equal(await api.firstRun(), false);
});
