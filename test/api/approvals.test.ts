import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createTask, moveTask } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { createWorktree } from "../../src/worktrees.ts";
import type { Left } from "../support/leave-pending.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// No test in this file starts a driver: the requests are made to the server's own broker, as a driver's session would.
// Approvals that come from Claude Code are in test/live/approval.live.test.ts.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  dir: string;
  base: string;
  headers: Record<string, string>;
  taskId: number;
  attemptId: number;
}

/** A real server, and a task that stands where a task being built stands: at `building`, in a real worktree, with an attempt. */
async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-apr-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();

  const repo = path.join(dir, "repo");
  initRepo(repo);
  const task = createTask(server.db, { repo, prompt: "run the marker script" });
  const worktree = await createWorktree({ repo, home, run: "run-00000001", task: `task-${task.id}` });
  const attemptId = Number(server.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  moveTask(server.db, task.id, "building", { worktree, attemptId });
  return { server, dir, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! }, taskId: task.id, attemptId };
}

async function get(api: Api, route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${api.base}${route}`, { headers: api.headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function post(api: Api, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${api.base}${route}`, { method: "POST", headers: { ...api.headers, ...JSON_TYPE }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ask = (api: Api, command: string, toolCallId: string) =>
  api.server.broker.request({ taskId: api.taskId, attemptId: api.attemptId, role: "implementer", tool: "Bash", command, cwd: ".", reason: "The agent's own words", toolCallId });

/** Read the real event stream and collect the approval announcements it carries. */
async function approvalAnnouncements(t: T, api: Api): Promise<Record<string, unknown>[]> {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const res = await fetch(`${api.base}/api/stream`, { headers: api.headers, signal: abort.signal });
  assert.equal(res.status, 200);
  const seen: Record<string, unknown>[] = [];
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const data = lines.find((l) => l.startsWith("data: "));
          if (data && lines.includes("event: approval")) seen.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
        }
      }
    } catch {
      // Aborted when the test ends.
    }
  })();
  return seen;
}

async function until(what: string, done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("every approval route refuses a request without a session, and an answer sent without one decides nothing", async (t) => {
  const api = await start(t);
  const waiting = ask(api, "sh make-marker.sh", "toolu_a1");
  const id = api.server.broker.pending()[0]!.id;
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/approvals"],
    ["GET", "/api/approvals?status=pending"],
    ["POST", `/api/approvals/${id}`, { decision: "allow" }],
    ["POST", `/api/approvals/${id}/answer`, { answer: "Hi" }],
    ["GET", "/api/action-log"],
    ["GET", `/api/action-log?taskId=${api.taskId}`],
  ];
  for (const [method, route, body] of routes) {
    for (const without of [{}, { cookie: "botbench_session=not-a-session" }] as Record<string, string>[]) {
      const res = await fetch(`${api.base}${route}`, { method, headers: { ...without, ...(body ? JSON_TYPE : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, 401, `${method} ${route} without a session`);
      assert.deepEqual(await res.json(), { error: "sign in required" });
    }
  }
  // A write from another site's page is refused as well, session or not.
  const foreign = await fetch(`${api.base}/api/approvals/${id}`, { method: "POST", headers: { ...api.headers, ...JSON_TYPE, origin: "https://elsewhere.example" }, body: JSON.stringify({ decision: "allow" }) });
  assert.equal(foreign.status, 403);
  await foreign.arrayBuffer();
  assert.equal(api.server.broker.pending()[0]!.status, "pending", "the request is still waiting");

  // With a session the same addresses are real routes.
  assert.equal((await get(api, "/api/approvals")).status, 200);
  assert.equal((await get(api, "/api/action-log")).status, 200);
  assert.equal((await post(api, `/api/approvals/${id}`, { decision: "decline" })).status, 200);
  assert.equal((await waiting).decision, "decline");
});

test("Claude Code's question is listed with its question and choices; the owner's answer over the API goes back keyed by the question; a second answer is 409 and a malformed one is 400", async (t) => {
  const api = await start(t);
  const input = { questions: [{ question: "Which greeting should I use?", header: "Greeting", options: [{ label: "Hello", description: "The long one" }, { label: "Hi", description: "" }], multiSelect: false }] };
  const waiting = api.server.broker.request({ taskId: api.taskId, attemptId: api.attemptId, role: "implementer", tool: "AskUserQuestion", command: JSON.stringify(input), input, cwd: ".", reason: null, toolCallId: "toolu_q1" });
  const listed = (await get(api, "/api/approvals?status=pending")).body.approvals as Record<string, unknown>[];
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0]!.question, listed[0]!.answer, listed[0]!.command], [{ text: "Which greeting should I use?", header: "Greeting", choices: [{ label: "Hello", description: "The long one" }, { label: "Hi", description: "" }] }, null, "Which greeting should I use?"]);
  const id = listed[0]!.id as number;
  for (const bad of [{}, { answer: 3 }, { answer: "   " }, { answer: "x".repeat(2001) }]) assert.equal((await post(api, `/api/approvals/${id}/answer`, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.equal((await post(api, `/api/approvals/${id}`, { decision: "allow" })).status, 409, "not answered with Allow");
  const answered = await post(api, `/api/approvals/${id}/answer`, { answer: "Hi" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual((await waiting).answers, { "Which greeting should I use?": "Hi" });
  assert.equal((await post(api, `/api/approvals/${id}/answer`, { answer: "Hello" })).status, 409);
  assert.equal((await post(api, `/api/approvals/${id + 41}/answer`, { answer: "Hello" })).status, 404);
});

test("a pending approval is listed with what the card shows, answering it resolves the waiting request, and both changes are announced on the stream", async (t) => {
  const api = await start(t);
  const announced = await approvalAnnouncements(t, api);
  assert.deepEqual((await get(api, "/api/approvals?status=pending")).body, { approvals: [] });
  assert.equal((await get(api, `/api/tasks/${api.taskId}`)).body.waitingOnApproval, false);

  let answer: unknown = null;
  const waiting = ask(api, "sh make-marker.sh", "toolu_b1").then((a) => (answer = a));
  await until("the request to be announced", () => announced.length === 1);
  const listed = (await get(api, "/api/approvals?status=pending")).body.approvals as Record<string, unknown>[];
  assert.equal(listed.length, 1);
  const approval = listed[0]!;
  assert.deepEqual(
    { ...approval, id: 0, createdAt: "" },
    { id: 0, taskId: api.taskId, chat: false, runId: null, taskTitle: "run the marker script", attemptId: api.attemptId, role: "implementer", tool: "Bash", command: "sh make-marker.sh", cwd: ".", reason: "The agent's own words", toolCallId: "toolu_b1", status: "pending", note: null, createdAt: "", resolvedAt: null, parkedAt: null, storedDecision: null, outsideText: false, asksBecause: "Botbench could not tell what this would run, or which of its agents asked.", target: null, question: null, answer: null },
  );
  assert.deepEqual(announced[0], { approvalId: approval.id, taskId: api.taskId, runId: null, status: "pending" });
  // The task says it is waiting on the owner, in its own description and in the list.
  assert.equal((await get(api, `/api/tasks/${api.taskId}`)).body.waitingOnApproval, true);
  assert.equal((await get(api, `/api/tasks/${api.taskId}`)).body.status, "building", "waiting is not a station of its own");
  assert.deepEqual(((await get(api, "/api/tasks")).body.tasks as Record<string, unknown>[]).map((x) => x.waitingOnApproval), [true]);
  assert.equal(answer, null, "nothing has answered yet");

  const allowed = await post(api, `/api/approvals/${approval.id as number}`, { decision: "allow" });
  assert.equal(allowed.status, 200);
  assert.equal((allowed.body.approval as Record<string, unknown>).status, "allowed");
  await waiting;
  assert.deepEqual(answer, { decision: "allow", note: null, approvalId: approval.id, refused: null });
  await until("the answer to be announced", () => announced.length === 2);
  assert.deepEqual(announced[1], { approvalId: approval.id, taskId: api.taskId, runId: null, status: "allowed" });
  assert.deepEqual((await get(api, "/api/approvals?status=pending")).body, { approvals: [] });
  assert.deepEqual(((await get(api, "/api/approvals?status=allowed")).body.approvals as Record<string, unknown>[]).map((a) => a.id), [approval.id]);
  assert.deepEqual(((await get(api, "/api/approvals")).body.approvals as Record<string, unknown>[]).map((a) => a.status), ["allowed"]);
  assert.equal((await get(api, `/api/tasks/${api.taskId}`)).body.waitingOnApproval, false);

  // Both the asking and the decision are in the action log, for this task and for no other.
  const log = (await get(api, `/api/action-log?taskId=${api.taskId}`)).body.entries as Record<string, unknown>[];
  assert.deepEqual(log.map((e) => [e.rule, e.taskId, e.attemptId, e.approvalId, e.tool, e.command]), [
    ["asked_owner", api.taskId, api.attemptId, approval.id, "Bash", "sh make-marker.sh"],
    ["owner_allowed", api.taskId, api.attemptId, approval.id, "Bash", "sh make-marker.sh"],
  ]);
  assert.deepEqual((await get(api, "/api/action-log")).body.entries, log);
  assert.deepEqual((await get(api, `/api/action-log?taskId=${api.taskId + 1}`)).body, { entries: [] });
});

test("a decline carries its note; an unknown approval is 404, a second answer is 409, and a malformed answer is 400 and decides nothing", async (t) => {
  const api = await start(t);
  const waiting = ask(api, "sh make-marker.sh", "toolu_c1");
  const id = api.server.broker.pending()[0]!.id;

  assert.deepEqual(await post(api, `/api/approvals/${id + 41}`, { decision: "allow" }), { status: 404, body: { error: "No such approval." } });
  for (const bad of [{}, { decision: "yes" }, { decision: "ALLOW" }, { decision: true }, { decision: ["allow"] }, { decision: "decline", note: 7 }, { decision: "decline", note: "x".repeat(2001) }, ["allow"], "allow"]) {
    const res = await post(api, `/api/approvals/${id}`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal((await post(api, `/api/approvals/${id}`, "{not json")).status, 400);
  for (const address of ["/api/approvals/0", "/api/approvals/abc", "/api/approvals/1/extra", "/api/approvals/-1"]) {
    assert.equal((await post(api, address, { decision: "allow" })).status, 404, address);
  }
  assert.equal((await get(api, "/api/approvals?status=everything")).status, 400);
  assert.equal((await get(api, "/api/action-log?taskId=abc")).status, 400);
  assert.equal(api.server.broker.pending().length, 1, "still waiting after every refused answer");

  const declined = await post(api, `/api/approvals/${id}`, { decision: "decline", note: "  not this one  " });
  assert.equal(declined.status, 200);
  assert.deepEqual([(declined.body.approval as Record<string, unknown>).status, (declined.body.approval as Record<string, unknown>).note], ["declined", "not this one"]);
  assert.deepEqual(await waiting, { decision: "decline", note: "not this one", approvalId: id, refused: null });

  const second = await post(api, `/api/approvals/${id}`, { decision: "allow" });
  assert.equal(second.status, 409);
  assert.match(String(second.body.error), /already declined/);
  assert.equal((await post(api, `/api/approvals/${id}`, { decision: "decline" })).status, 409);
  const log = (await get(api, "/api/action-log")).body.entries as Record<string, unknown>[];
  assert.deepEqual(log.map((e) => [e.rule, e.detail]), [["asked_owner", null], ["owner_declined", "not this one"]]);
});

test("closing the server leaves no approval pending and no socket behind", async (t) => {
  const api = await start(t);
  const waiting = ask(api, "sh make-marker.sh", "toolu_d1");
  const socket = api.server.broker.socketPath;
  assert.equal(fs.statSync(socket).isSocket(), true);
  await api.server.close();
  assert.equal((await waiting).decision, "decline");
  assert.equal(fs.existsSync(socket), false);
});

test("after a restart, an approval asked before it is still listed, says so, and its task is shown as parked; an answer without a session stores nothing", async (t) => {
  const dir = tempDir("botbench-apr-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  // A real Botbench process that was killed while a task waited for the owner. The owner's answer itself re-drives
  // the task with the real CLI, so that part is in test/live/recover-approval.live.test.ts.
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "..", "support", "leave-pending.ts"), JSON.stringify({ home, repo, cursor: "0b7b7c9e-4a51-4c0e-9d0c-0d3f8f6f2a11", commands: ["sh make-marker.sh"] })], { encoding: "utf8" });
  const left = JSON.parse(run.stdout) as Left;

  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signedIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await signedIn.arrayBuffer();
  const api: Api = { server, dir, base, headers: { cookie: signedIn.headers.getSetCookie()[0]!.split(";")[0]! }, taskId: left.taskId, attemptId: left.attemptId };

  const pending = (await get(api, "/api/approvals?status=pending")).body.approvals as Record<string, unknown>[];
  assert.deepEqual(pending.map((a) => [a.id, a.taskId, a.attemptId, a.command, a.cwd, a.status, a.storedDecision]), [[left.approvalIds[0], left.taskId, left.attemptId, "sh make-marker.sh", ".", "pending", null]]);
  assert.equal(typeof pending[0]!.parkedAt, "string");
  const task = (await get(api, `/api/tasks/${left.taskId}`)).body;
  assert.deepEqual([task.status, task.waitingOnApproval, task.parked, task.resuming, task.reason, task.attemptId], ["building", true, true, false, null, left.attemptId]);

  const res = await fetch(`${base}/api/approvals/${left.approvalIds[0]}`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ decision: "allow" }) });
  assert.equal(res.status, 401);
  await res.arrayBuffer();
  const after = (await get(api, "/api/approvals")).body.approvals as Record<string, unknown>[];
  assert.deepEqual(after.map((a) => [a.status, a.storedDecision]), [["pending", null]]);
  assert.deepEqual(((await get(api, "/api/action-log")).body.entries as Record<string, unknown>[]).map((e) => e.rule), ["asked_owner"]);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 1, "nothing was started");

  // Shutting down again leaves it as it is: still pending, for the next start.
  await server.close();
  const again = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => again.close());
  assert.deepEqual(again.broker.pending().map((a) => [a.id, a.parkedAt]), [[left.approvalIds[0], pending[0]!.parkedAt]]);
});
