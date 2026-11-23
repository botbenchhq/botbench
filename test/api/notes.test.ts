import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { MAX_NOTE } from "../../src/engine/notes.ts";
import { createTask, moveTask, type Task, type TaskStatus } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { initRepo, tempDir, write } from "../support/repo.ts";

// The note route over real HTTP, against a real Botbench server, a real temporary repository and real SQLite. No driver
// is started: a task is put at each state the way the engine stores it, with Botbench's own worktree and commit
// functions where a state needs committed work, as the task and decision API tests do. A note delivered to a real
// builder session is in test/engine/notes.test.ts, and on the task screen in e2e/note.e2e.ts.

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
  const dir = tempDir("botbench-notes-api-");
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

/** POST a note; `body` is sent as it is when it is a string, else as JSON. */
async function send(api: Api, taskId: number, body: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}/api/tasks/${taskId}/notes`, { method: "POST", headers: { ...api.headers, ...JSON_TYPE }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}
async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}
const stored = (api: Api, taskId: number): number => Number(api.server.db.prepare("SELECT count(*) AS n FROM task_notes WHERE task_id = ?").get(taskId)!.n);

/** A task at `building` in its own copy of the project, as the engine leaves one while its builder works. */
async function building(api: Api): Promise<Task> {
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  return moveTask(api.server.db, task.id, "building", { worktree });
}

/** A task at Ready for review with one committed file. */
async function ready(api: Api): Promise<Task> {
  const task = await building(api);
  write(task.worktreePath!, "hello.txt", "hi\n");
  const committed = await commitWork({ path: task.worktreePath!, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  return moveTask(api.server.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed" });
}

test("a note to a building task is queued and answered as stored; a second replaces the first, which is kept as replaced; the task's summary carries the one waiting", async (t) => {
  const api = await start(t);
  const task = await building(api);
  const res = await fetch(`${api.base}/api/tasks/${task.id}/notes`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ text: "x" }) });
  assert.equal(res.status, 401, "only for a signed-in device");
  await res.arrayBuffer();

  const first = await send(api, task.id, { text: "Use British spelling." });
  assert.equal(first.status, 200);
  const note = first.body.note as Body;
  assert.deepEqual({ text: note.text, state: note.state, taskId: note.taskId, reason: note.reason, attemptId: note.attemptId }, { text: "Use British spelling.", state: "waiting", taskId: task.id, reason: null, attemptId: null });
  assert.match(String(note.sentAt), /^\d{4}-\d\d-\d\dT/);
  assert.equal(first.body.replaced, null);
  const shown = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
  assert.deepEqual(shown.waitingNote, { id: note.id, text: "Use British spelling.", sentAt: note.sentAt, replacedOne: false, forRound: false });
  assert.equal(shown.undeliveredNote, null);

  const second = await send(api, task.id, { text: "Also say hello in the README." });
  assert.equal(second.status, 200);
  assert.equal((second.body.replaced as Body).id, note.id);
  assert.equal((second.body.replaced as Body).state, "replaced");
  const rows = api.server.db.prepare("SELECT text, state FROM task_notes WHERE task_id = ? ORDER BY id").all(task.id).map((row) => [row.text, row.state]);
  assert.deepEqual(rows, [["Use British spelling.", "replaced"], ["Also say hello in the README.", "waiting"]]);
  const listed = ((await call(api, "GET", "/api/tasks")).body.tasks as Body[]).find((one) => one.id === task.id)!;
  assert.deepEqual({ ...(listed.waitingNote as Body), id: undefined, sentAt: undefined }, { id: undefined, text: "Also say hello in the README.", sentAt: undefined, replacedOne: true, forRound: false });
});

test("an empty note, one over the length limit, one that is not text, and a body that is not JSON are refused with a plain reason, and nothing is stored", async (t) => {
  const api = await start(t);
  const task = await building(api);
  const cases: [unknown, RegExp][] = [
    [{ text: "" }, /^Write a note first: it is empty\.$/],
    [{ text: "   \n\t" }, /^Write a note first: it is empty\.$/],
    // A body the client never sends is told the shape the route takes, as the other routes tell a malformed one.
    [{}, /^expected \{ "text": "the note" \}$/],
    [{ text: 42 }, /^expected \{ "text": "the note" \}$/],
    [[], /^expected \{ "text": "the note" \}$/],
    [{ text: "x".repeat(MAX_NOTE + 1) }, new RegExp(`^The note is too long: ${MAX_NOTE} characters at most\\.$`)],
    ["{ not json", /^Botbench could not read the note: it was not sent as JSON\.$/],
  ];
  for (const [body, reason] of cases) {
    const refused = await send(api, task.id, body);
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(String(refused.body.error), reason);
  }
  assert.equal(stored(api, task.id), 0);
  // At the limit it is taken; and a note is stored exactly as typed, its indentation and line breaks included.
  assert.equal((await send(api, task.id, { text: "x".repeat(MAX_NOTE) })).status, 200);
  const indented = "    keep this indented\n  and this\n";
  assert.equal(((await send(api, task.id, { text: indented })).body.note as Body).text, indented);
});

test("a note to a task that is neither building nor ready for review, or to no task, is refused with the reason and the right status, and nothing is stored for it; so is one to a task ready for review whose builder recorded no session to take up", async (t) => {
  const api = await start(t);
  assert.deepEqual(await send(api, 999, { text: "hello" }), { status: 404, body: { error: "No such task." } });

  const at = async (status: TaskStatus | "discarded"): Promise<Task> => {
    if (status === "queued") return createTask(api.server.db, { repo: api.repo, prompt: "queued" });
    if (status === "accepted" || status === "rejected") {
      const task = await ready(api);
      const decided = await call(api, "POST", `/api/tasks/${task.id}/${status === "accepted" ? "accept" : "reject"}`, status === "accepted" ? {} : { branch: "keep" });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      return task;
    }
    if (status === "awaiting_decision") return ready(api);
    if (status === "discarded") {
      const task = await building(api);
      moveTask(api.server.db, task.id, "failed", { reason: "It ended." });
      const discarded = await call(api, "POST", `/api/tasks/${task.id}/discard`, {});
      assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
      return task;
    }
    const task = await building(api);
    return moveTask(api.server.db, task.id, status, status === "failed" || status === "interrupted" || status === "cancelled" ? { reason: "It ended." } : {});
  };
  // `ready` stores no builder session: a note round would have none to take up (test/engine/note-round.test.ts has one that does).
  const expected: [TaskStatus | "discarded", string][] = [
    ["queued", "This task has not started yet, so there is nothing for a note to follow. You can send one once Claude Code is working on it."],
    ["verifying", "Botbench is running this task's checks, so a note cannot reach Claude Code now. You can send one once the task is ready for review."],
    ["reviewing", "This task is being reviewed, so a note cannot reach Claude Code now. You can send one once the task is ready for review."],
    ["awaiting_decision", "Claude Code recorded no session for this task to take up, so a note cannot reach it."],
    ["failed", "This task failed, so a note can no longer reach Claude Code."],
    ["discarded", "This task failed, so a note can no longer reach Claude Code."],
    ["interrupted", "This task is stopped, so a note cannot reach Claude Code. Resume it first, if it offers Resume."],
    ["cancelled", "This task was cancelled, so a note can no longer reach Claude Code."],
    ["accepted", "This task was accepted, so a note can no longer reach Claude Code."],
    ["rejected", "This task was rejected, so a note can no longer reach Claude Code."],
  ];
  for (const [status, reason] of expected) {
    const task = await at(status);
    const shown = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
    assert.equal(shown.status, status === "discarded" ? "failed" : status);
    if (status === "discarded") assert.notEqual((shown.remains as Body | null)?.discardedAt ?? null, null, "its copy and branch were discarded");
    assert.deepEqual(await send(api, task.id, { text: "One more thing." }), { status: 409, body: { error: reason } }, status);
    assert.equal(stored(api, task.id), 0, `nothing stored for a task that is ${status}`);
    // Refused, it stays where it was.
    assert.equal((await call(api, "GET", `/api/tasks/${task.id}`)).body.status, status === "discarded" ? "failed" : status);
  }
});

test("a task that leaves building with a note still waiting marks it not delivered, with the reason, and its summary says so", async (t) => {
  const api = await start(t);
  const task = await building(api);
  assert.equal((await send(api, task.id, { text: "Also update the README." })).status, 200);
  // The task ends without its builder's work going on, as a stop with no turn running leaves it.
  moveTask(api.server.db, task.id, "interrupted", { reason: "It was stopped." });
  const shown = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
  assert.equal(shown.waitingNote, null);
  assert.deepEqual({ ...(shown.undeliveredNote as Body), id: undefined, sentAt: undefined }, { id: undefined, text: "Also update the README.", sentAt: undefined, reason: "The task was stopped before your note could be sent." });
});
