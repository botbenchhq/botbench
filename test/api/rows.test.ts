import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { createChat, type Chat } from "../../src/api/chat.ts";
import { createTurns } from "../../src/api/turns.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { decideTask } from "../../src/engine/decision.ts";
import { createDeliveries } from "../../src/engine/delivery.ts";
import { approvePlan, cancelRun, createRun, storePlan } from "../../src/engine/run.ts";
import { createTask, moveTask } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { openStore } from "../../src/store/db.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { chatReplayDriver } from "../support/replay-chat.ts";
import { replayGitHub } from "../support/replay-github.ts";
import { botbenchBranches, git, initRepo, tempDir, worktreeCount, write } from "../support/repo.ts";

// The Work list's own state over real HTTP, against a real Botbench server and real SQLite: hiding and showing a run,
// a task or a chat, renaming a chat, and what each row's More menu is built from. Nothing here starts a model turn.
// Chats are sent before the server starts, through the chat code itself, to Codex replaying a session captured from its
// real CLI (test/support/replay-chat.ts); tasks and runs are put in their states by the engine's own functions, and a
// pull request is opened by the delivery step replaying output captured from the real gh (test/support/replay-github.ts).

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
type Item = Body & { kind: string; id: number };
type Group = { name: string; total: number; items: Item[] };
const JSON_TYPE = { "content-type": "application/json" };
const ADDRESS = "https://github.com/botbenchhq/botbench-delivery-fixture.git";

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  repo: string;
  seeded: Seeded;
}

interface Seeded {
  /** A chat of two messages, its attempts oldest first. */
  chat: number[];
  /** A second chat of one message. */
  other: number;
  /** A run at its plan. */
  run: number;
  /** A task of a planned run, which is listed only with its run. Its plan was approved and the run cancelled before the server started, so nothing builds it. */
  ofRun: number;
  /** A stand-alone task that failed with its copy and branch left. */
  failed: { id: number; branch: string };
  /** A stand-alone task accepted and delivered: its pull request is open. */
  delivered: { id: number; branch: string; url: string; number: number };
}

async function settled(chat: Chat, ids: readonly number[]): Promise<void> {
  for (let i = 0; i < 500 && ids.some((id) => chat.turnRunning(id)); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ids.every((id) => !chat.turnRunning(id)), "every chat turn ended");
}

/** Two chats, sent through the chat code to Codex replaying its real CLI. */
async function seedChats(db: DatabaseSync, home: string): Promise<{ chat: number[]; other: number }> {
  const claude = new ClaudeCodeDriver();
  const broker = createBroker({ db, home, onChange: () => {} });
  const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
  const chat = createChat({ db, home, turns, claude, agents: { codex: chatReplayDriver("codex", "chat") }, onEvent: () => {} });
  try {
    const [first] = await chat.send({ message: "  # Name one primary colour.\nIn one word, please.", conversation: [], agents: [{ agent: "codex", model: null }] });
    await settled(chat, [first!.attemptId]);
    const [second] = await chat.send({ message: "And another one?", conversation: [first!.attemptId], agents: [{ agent: "codex", model: null }] });
    await settled(chat, [second!.attemptId]);
    const [other] = await chat.send({ message: "A chat of its own", conversation: [], agents: [{ agent: "codex", model: null }] });
    await settled(chat, [other!.attemptId]);
    return { chat: [first!.attemptId, second!.attemptId], other: other!.attemptId };
  } finally {
    await chat.close();
    await turns.close();
    await broker.close();
  }
}

/** Put a stand-alone task in its own copy with one committed file, as a builder leaves it. */
async function built(db: DatabaseSync, home: string, repo: string, prompt: string) {
  const task = createTask(db, { repo, prompt });
  const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(db, task.id, "building", { worktree });
  write(worktree.path, `task-${task.id}.txt`, "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  return { task, commit: committed.commit, branch: worktree.branch };
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-rows-api-");
  // One hook, so the order is fixed: the server, with its engine and broker, is closed before the folder it writes to
  // is removed, and a removal that fails can never leave the server open (a later hook is skipped once one throws).
  let server: BotbenchServer | undefined;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", bare);
  git(repo, "config", `url.${bare}.insteadOf`, ADDRESS);
  git(repo, "remote", "add", "origin", ADDRESS);

  const db = openStore(home);
  const chats = await seedChats(db, home);
  const run = createRun(db, { repo, prompt: "Plan a greeting", baseCommit: git(repo, "rev-parse", "HEAD").trim() });
  storePlan(db, run.id, [{ title: "Add a greeting file", criteria: ["It exists"] }]);
  // Approved and cancelled here, not over HTTP: approving through the server would start a real build of its task.
  const ofRunRun = createRun(db, { repo, prompt: "Plan a farewell", baseCommit: git(repo, "rev-parse", "HEAD").trim() });
  const ofRunPlan = storePlan(db, ofRunRun.id, [{ title: "Add a farewell file", criteria: ["It exists"] }]);
  const [ofRun] = approvePlan(db, ofRunRun.id, ofRunPlan.planVersion).tasks;
  cancelRun(db, ofRunRun.id);
  const failed = await built(db, home, repo, "create failed.txt");
  moveTask(db, failed.task.id, "failed", { reason: "it broke", headCommit: failed.commit });
  const delivered = await built(db, home, repo, "create hello.txt");
  moveTask(db, delivered.task.id, "awaiting_decision", { headCommit: delivered.commit, checks: "none" });
  await decideTask(db, { taskId: delivered.task.id, decision: "accept" });
  const deliveries = createDeliveries({ db, config: { repositories: {} } as unknown as Config, github: replayGitHub().github, onTaskChange: () => {} });
  deliveries.deliver(delivered.task.id, { by: "owner" });
  await deliveries.close();
  const pr = db.prepare("SELECT url, number FROM deliveries WHERE task_id = ? AND step = 'opened'").get(delivered.task.id)!;
  db.close();

  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} };
  server = await startServer({ config, home, signInDelayMs: 1 });
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return {
    server, base, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! },
    seeded: { ...chats, run: run.id, ofRun: ofRun!.id, failed: { id: failed.task.id, branch: failed.branch }, delivered: { id: delivered.task.id, branch: delivered.branch, url: String(pr.url), number: Number(pr.number) } },
  };
}

async function call(api: Api, method: string, route: string, body?: unknown, raw?: string): Promise<{ status: number; body: Body }> {
  const sends = raw !== undefined || body !== undefined;
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(sends ? JSON_TYPE : {}) }, ...(sends ? { body: raw ?? JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Body };
}

async function list(api: Api, hidden = false): Promise<{ groups: Group[]; hidden: number }> {
  const res = await call(api, "GET", hidden ? "/api/board?hidden=1" : "/api/board");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as unknown as { groups: Group[]; hidden: number };
}
const rows = (groups: Group[]): string[] => groups.flatMap((group) => group.items.map((item) => `${item.kind} ${item.id}`)).sort();
const find = (groups: Group[], kind: string, id: number): Item | undefined => groups.flatMap((group) => group.items).find((item) => item.kind === kind && item.id === id);

/** What hiding must never change: every run, task and chat stored, and each branch and copy on disk. */
function kept(api: Api): unknown {
  const db = api.server.db;
  const count = (table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return { runs: count("runs"), tasks: count("tasks"), attempts: count("attempts"), events: count("events"), chatRounds: count("chat_rounds"), chatAttempts: count("chat_attempts"), branches: botbenchBranches(api.repo), copies: worktreeCount(api.repo) };
}

test("the Work list's routes need a session", async (t) => {
  const api = await start(t);
  for (const [method, route] of [["POST", "/api/board/hide"], ["POST", "/api/board/show"], ["GET", `/api/chats/${api.seeded.chat[0]}`], ["POST", `/api/chats/${api.seeded.chat[0]}/rename`]] as const) {
    const res = await fetch(`${api.base}${route}`, { method, headers: JSON_TYPE, ...(method === "POST" ? { body: JSON.stringify({ kind: "run", id: api.seeded.run, title: "x" }) } : {}) });
    assert.equal(res.status, 401, `${method} ${route}`);
    await res.arrayBuffer();
  }
});

test("each chat is a row of the Chats group, named by its first attempt and titled by the first line of its first message, with its attempts in order", async (t) => {
  const api = await start(t);
  const { groups } = await list(api);
  const chats = groups.find((group) => group.name === "chats")!;
  assert.equal(chats.total, 2);
  assert.deepEqual(chats.items.map((item) => item.id), [api.seeded.other, api.seeded.chat[0]], "newest first");
  const chat = find(groups, "chat", api.seeded.chat[0]!)!;
  assert.equal(chat.title, "Name one primary colour.", "the first line, without its heading marks");
  assert.equal(chat.named, false);
  assert.deepEqual(chat.attempts, api.seeded.chat);
  assert.deepEqual(chat.agents, ["codex"]);
  // The second attempt is part of the first chat, not a chat of its own.
  assert.equal(find(groups, "chat", api.seeded.chat[1]!), undefined);
  const opened = await call(api, "GET", `/api/chats/${api.seeded.chat[0]}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.attempts, api.seeded.chat);
  assert.equal((await call(api, "GET", `/api/chats/${api.seeded.chat[1]}`)).status, 404);
});

test("hiding and showing a run, a task and a chat: idempotent, the hidden row is left out of the list and counted, listed under hidden, and nothing is deleted", async (t) => {
  const api = await start(t);
  const before = kept(api);
  const all = rows((await list(api)).groups);
  const targets = [["run", api.seeded.run], ["task", api.seeded.failed.id], ["chat", api.seeded.chat[0]!]] as const;
  for (const [kind, id] of targets) {
    for (let twice = 0; twice < 2; twice++) {
      const res = await call(api, "POST", "/api/board/hide", { kind, id });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { kind, id, hidden: true });
    }
  }
  const hiddenRows = targets.map(([kind, id]) => `${kind} ${id}`).sort();
  const shown = await list(api);
  assert.deepEqual(rows(shown.groups), all.filter((row) => !hiddenRows.includes(row)));
  assert.equal(shown.hidden, 3, "each hidden row is counted once, however often it was hidden");
  const hidden = await list(api, true);
  assert.deepEqual(rows(hidden.groups), hiddenRows);
  assert.equal(hidden.hidden, 3);
  assert.equal(hidden.groups.find((group) => group.name === "chats")!.total, 1, "a hidden chat is still in its own group");
  assert.deepEqual(kept(api), before, "hiding deleted and changed nothing");

  for (const [kind, id] of targets) {
    for (let twice = 0; twice < 2; twice++) {
      const res = await call(api, "POST", "/api/board/show", { kind, id });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { kind, id, hidden: false });
    }
  }
  const back = await list(api);
  assert.deepEqual(rows(back.groups), all);
  assert.equal(back.hidden, 0);
  assert.deepEqual(rows((await list(api, true)).groups), []);
  assert.deepEqual(kept(api), before, "showing deleted and changed nothing");
});

test("hiding or showing an unknown or non-listed row is 404, and a malformed body is 400; neither changes anything", async (t) => {
  const api = await start(t);
  const ofRun = api.seeded.ofRun;
  const single = Number(api.server.db.prepare("SELECT run_id FROM tasks WHERE id = ?").get(api.seeded.failed.id)!.run_id);
  for (const path of ["/api/board/hide", "/api/board/show"]) {
    for (const [kind, id] of [["run", 999_999], ["task", 999_999], ["chat", 999_999], ["task", ofRun], ["run", single], ["chat", api.seeded.chat[1]!]] as const) {
      const res = await call(api, "POST", path, { kind, id });
      assert.equal(res.status, 404, `${path} ${kind} ${id}: ${JSON.stringify(res.body)}`);
      assert.equal(typeof res.body.error, "string");
    }
    for (const body of [{}, [], { kind: "run" }, { id: api.seeded.run }, { kind: "branch", id: 1 }, { kind: "run", id: "1" }, { kind: "run", id: 0 }, { kind: "run", id: 1.5 }, { kind: "run", id: -3 }]) {
      const res = await call(api, "POST", path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
    }
    assert.equal((await call(api, "POST", path, undefined, "{not json")).status, 400);
  }
  assert.equal(Number(api.server.db.prepare("SELECT count(*) AS n FROM hidden_rows").get()!.n), 0);
});

test("renaming a chat sets the owner's title, trimmed to one line and length-limited, shown in the list; an empty title goes back to the first message; the chat itself is untouched", async (t) => {
  const api = await start(t);
  const db = api.server.db;
  const id = api.seeded.chat[0]!;
  const chatRecord = (): unknown => ({ rounds: db.prepare("SELECT * FROM chat_rounds ORDER BY id").all(), attempts: db.prepare("SELECT * FROM chat_attempts ORDER BY attempt_id").all(), events: db.prepare("SELECT count(*) AS n FROM events").get() });
  const before = chatRecord();

  const named = await call(api, "POST", `/api/chats/${id}/rename`, { title: "  Colours\n  for   the logo  " });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.title, "Colours for the logo");
  assert.equal(named.body.named, true);
  assert.deepEqual(named.body.attempts, api.seeded.chat);
  let item = find((await list(api)).groups, "chat", id)!;
  assert.deepEqual([item.title, item.named], ["Colours for the logo", true]);

  const long = "x".repeat(81);
  const refused = await call(api, "POST", `/api/chats/${id}/rename`, { title: long });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /at most 80 characters/);
  assert.equal(find((await list(api)).groups, "chat", id)!.title, "Colours for the logo", "a refused name changes nothing");
  assert.equal((await call(api, "POST", `/api/chats/${id}/rename`, { title: "y".repeat(80) })).body.title, "y".repeat(80), "80 characters is the limit, not over it");

  const cleared = await call(api, "POST", `/api/chats/${id}/rename`, { title: "   " });
  assert.equal(cleared.status, 200);
  assert.deepEqual([cleared.body.title, cleared.body.named], ["Name one primary colour.", false]);
  item = find((await list(api)).groups, "chat", id)!;
  assert.deepEqual([item.title, item.named], ["Name one primary colour.", false]);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM chat_titles").get()!.n), 0);

  assert.equal((await call(api, "POST", `/api/chats/999999/rename`, { title: "x" })).status, 404);
  assert.equal((await call(api, "POST", `/api/chats/${api.seeded.chat[1]}/rename`, { title: "x" })).status, 404, "an attempt that is not a chat's first names no chat");
  for (const body of [{}, { title: 3 }, { title: null }, ["x"]]) assert.equal((await call(api, "POST", `/api/chats/${id}/rename`, body)).status, 400, JSON.stringify(body));
  assert.equal((await call(api, "POST", `/api/chats/${id}/rename`, undefined, "nope")).status, 400);

  // A renamed chat can be hidden and shown again, and keeps its name.
  await call(api, "POST", `/api/chats/${id}/rename`, { title: "Logo" });
  assert.equal((await call(api, "POST", "/api/board/hide", { kind: "chat", id })).status, 200);
  assert.equal(find((await list(api, true)).groups, "chat", id)!.title, "Logo");
  assert.equal((await call(api, "POST", "/api/board/show", { kind: "chat", id })).status, 200);
  assert.equal(find((await list(api)).groups, "chat", id)!.title, "Logo");
  assert.deepEqual(chatRecord(), before, "the chat's messages and attempts are as they were");
});

test("each row carries what its More menu offers: the branch while git has it, the pull request while it is open, Cancel for a run still going, Discard for a failed task with something left", async (t) => {
  const api = await start(t);
  const { groups } = await list(api);
  const run = find(groups, "run", api.seeded.run)!;
  assert.deepEqual({ branch: run.branch, pullRequest: run.pullRequest, cancellable: run.cancellable }, { branch: null, pullRequest: null, cancellable: true });
  const failed = find(groups, "task", api.seeded.failed.id)!;
  assert.deepEqual({ branch: failed.branch, pullRequest: failed.pullRequest, discardable: failed.discardable }, { branch: api.seeded.failed.branch, pullRequest: null, discardable: true });
  const delivered = find(groups, "task", api.seeded.delivered.id)!;
  assert.deepEqual({ branch: delivered.branch, pullRequest: delivered.pullRequest, discardable: delivered.discardable }, { branch: api.seeded.delivered.branch, pullRequest: { number: api.seeded.delivered.number, url: api.seeded.delivered.url }, discardable: false });

  // Once git no longer has a branch, its row no longer offers it; a failed task with its copy left can still be discarded.
  git(api.repo, "worktree", "remove", "--force", String(api.server.db.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get(api.seeded.failed.id)!.worktree_path));
  git(api.repo, "branch", "-D", api.seeded.failed.branch);
  const after = find((await list(api)).groups, "task", api.seeded.failed.id)!;
  assert.deepEqual({ branch: after.branch, discardable: after.discardable }, { branch: null, discardable: false }, "nothing is left to discard");

  // A cancelled run cannot be cancelled again.
  assert.equal((await call(api, "POST", `/api/runs/${api.seeded.run}/cancel`, {})).status, 200);
  assert.equal(find((await list(api)).groups, "run", api.seeded.run)!.cancellable, false);
});
