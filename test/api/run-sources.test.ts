import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createRun } from "../../src/engine/run.ts";
import { MAX_RUN_NOTE, NOTE_EMPTY, noteTooLong } from "../../src/engine/run-source.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { finishedTask, recordedChat } from "../support/run-source.ts";

// "Make this a run" over real HTTP, against a real server and its real SQLite store. No test here starts a CLI: a run
// that is refused never reaches its planner, and the runs whose links are read are stored as the engine stores them.
// A run made from a source and planned is in test/engine/run-source.test.ts, its planner replayed.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  repo: string;
  other: string;
  base: string;
  url: string;
  headers: Record<string, string>;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-run-sources-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const other = path.join(dir, "other");
  initRepo(other);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${url}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { server, repo: fs.realpathSync(repo), other: fs.realpathSync(other), base, url, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

type Body = Record<string, unknown>;
async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.url}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}
/** Every table "Make this a run" could change: the runs and what a run brings with it, the tasks and the chats. */
const TABLES = ["runs", "run_events", "plan_tasks", "tasks", "task_events", "attempts", "events", "approvals", "chat_rounds", "chat_attempts", "chat_members", "chat_titles"];
/** Each of those tables, every row and column, so a change to a row is seen as well as a row added. */
const contents = (api: Api): Record<string, unknown[]> => Object.fromEntries(TABLES.map((table) => [table, api.server.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const store = (api: Api) => ({ db: api.server.db, repo: api.repo, base: api.base });

test("opening the composer on a finished task or a chat only reads: the source as Botbench has it, and no row is added anywhere", async (t) => {
  const api = await start(t);
  const task = finishedTask(store(api));
  const chat = recordedChat(api.server.db);
  const before = contents(api);

  const opened = await call(api, "GET", `/api/run-sources/task/${task.id}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body, { kind: "task", id: task.id, repo: api.repo, branch: task.branch, label: `From task ${task.id}` });

  // Opened from any of the chat's attempts: the chat, and only the owner's own messages to pick as the note.
  const fromChat = await call(api, "GET", `/api/run-sources/chat/${chat.attempts.at(-1)}`);
  assert.equal(fromChat.status, 200);
  assert.equal(fromChat.body.id, chat.id);
  assert.equal(fromChat.body.label, "From a chat");
  assert.equal(fromChat.body.repo, null);
  assert.deepEqual((fromChat.body.messages as Body[]).map((m) => m.text), chat.owner);
  for (const said of chat.agents) assert.ok(!JSON.stringify(fromChat.body).includes(said), said);

  assert.deepEqual(contents(api), before, "opening the composer created nothing");
});

test("a source that is not finished or not there cannot be opened, with a plain reason", async (t) => {
  const api = await start(t);
  const building = finishedTask(store(api), "building");
  const reviewing = finishedTask(store(api), "reviewing");
  assert.deepEqual(await call(api, "GET", `/api/run-sources/task/${building.id}`), { status: 409, body: { error: `Task ${building.id} is still being built, so no run can be made from it yet. A run is made from a task once it is ready for review, accepted or rejected.` } });
  assert.equal((await call(api, "GET", `/api/run-sources/task/${reviewing.id}`)).status, 409);
  assert.deepEqual(await call(api, "GET", "/api/run-sources/task/99999"), { status: 404, body: { error: "There is no task 99999, so no run can be made from it." } });
  assert.deepEqual(await call(api, "GET", "/api/run-sources/chat/99999"), { status: 404, body: { error: "That chat is not in Botbench's records, so no run can be made from it." } });
});

test("Send is refused with a plain reason, and no run is stored, for an empty or too long note, a missing or unfinished source, or another repository", async (t) => {
  const api = await start(t);
  const ready = finishedTask(store(api));
  const building = finishedTask(store(api), "building");
  const before = contents(api);
  const send = (body: Body) => call(api, "POST", "/api/runs", { repo: api.repo, mode: "manual", ...body });

  assert.deepEqual(await send({ prompt: "", source: { task: ready.id } }), { status: 400, body: { error: NOTE_EMPTY } });
  assert.deepEqual(await send({ prompt: "  \n\t ", source: { task: ready.id } }), { status: 400, body: { error: NOTE_EMPTY } });
  assert.deepEqual(await send({ source: { task: ready.id } }), { status: 400, body: { error: NOTE_EMPTY } });
  assert.deepEqual(await send({ prompt: "x".repeat(MAX_RUN_NOTE + 1), source: { task: ready.id } }), { status: 400, body: { error: noteTooLong(MAX_RUN_NOTE + 1) } });
  assert.match(noteTooLong(MAX_RUN_NOTE + 1), /^The note is too long: 10,000 characters at most/);
  assert.deepEqual(await send({ prompt: "Go on", source: { task: 99999 } }), { status: 404, body: { error: "There is no task 99999, so no run can be made from it." } });
  assert.equal((await send({ prompt: "Go on", source: { task: building.id } })).status, 409);
  assert.deepEqual(await send({ prompt: "Go on", source: { chat: 99999 } }), { status: 404, body: { error: "That chat is not in Botbench's records, so no run can be made from it." } });
  // A task of this repository cannot be paired with another repository's path.
  assert.deepEqual(await call(api, "POST", "/api/runs", { repo: api.other, mode: "manual", prompt: "Go on", source: { task: ready.id } }), { status: 400, body: { error: `Task ${ready.id} was built in ${api.repo}, not ${api.other}. A run made from it works in the same repository.` } });
  assert.equal((await send({ prompt: "Go on", source: { task: "1" } })).status, 400);

  assert.deepEqual(contents(api), before, "nothing was stored");
});

test("the run screen links to the task or chat a run was made from, and the task screen to the runs made from it; no other run or task has either", async (t) => {
  const api = await start(t);
  const task = finishedTask(store(api));
  const other = finishedTask(store(api));
  const chat = recordedChat(api.server.db);
  const fromTask = createRun(api.server.db, { repo: api.repo, prompt: "Now a farewell", baseCommit: api.base, source: { kind: "task", id: task.id } });
  const fromChat = createRun(api.server.db, { repo: api.repo, prompt: "The header", baseCommit: api.base, source: { kind: "chat", id: chat.id } });
  const plain = createRun(api.server.db, { repo: api.repo, prompt: "Something else", baseCommit: api.base });

  assert.deepEqual((await call(api, "GET", `/api/runs/${fromTask.id}`)).body.source, { kind: "task", id: task.id, label: `From task ${task.id}` });
  assert.deepEqual((await call(api, "GET", `/api/runs/${fromChat.id}`)).body.source, { kind: "chat", id: chat.id, label: "From a chat" });
  assert.equal((await call(api, "GET", `/api/runs/${plain.id}`)).body.source, null);
  assert.equal((await call(api, "GET", `/api/runs/${task.runId}`)).body.source, null);
  // Where the links go is there to read: the task, and the chat by the id its own route takes.
  assert.equal((await call(api, "GET", `/api/tasks/${task.id}`)).status, 200);
  assert.equal((await call(api, "GET", `/api/chats/${chat.id}`)).status, 200);

  assert.deepEqual((await call(api, "GET", `/api/tasks/${task.id}`)).body.runsMade, [fromTask.id]);
  assert.deepEqual((await call(api, "GET", `/api/tasks/${other.id}`)).body.runsMade, []);
  // A run stays where it came from: its run row's source never moves.
  assert.throws(() => api.server.db.prepare("UPDATE runs SET source_task_id = ? WHERE id = ?").run(other.id, fromTask.id), /never changed/);
});
