import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createTask, getTask, moveTask, type Task } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { git, initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// "Bring up to date with main" over real HTTP (#201), against a real Botbench server, a real temporary repository and
// real SQLite. The task is put where a finished build leaves it by Botbench's own worktree, commit and state functions,
// as the other task API tests do; the update itself is the engine's, with the repository's real check command. Main
// moves by a real commit in the repository, and the merge is clean, so no agent is started.

type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };

async function start(t: { after(fn: () => unknown): void }): Promise<{ server: BotbenchServer; base: string; headers: Record<string, string>; home: string; repo: string }> {
  const dir = tempDir("botbench-update-api-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: { checks: ["test -f hello.txt"] } } } as Config;
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

/** A task whose work is committed and checked, ready for review, as a finished build leaves it. */
async function readyTask(api: { server: BotbenchServer; home: string; repo: string }): Promise<Task> {
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(api.server.db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  moveTask(api.server.db, task.id, "verifying", { headCommit: committed.commit });
  return moveTask(api.server.db, task.id, "awaiting_decision", { checks: "passed" });
}

test("the task screen reads how far a ready task's branch is behind main; Bring up to date merges it, runs the checks again and hands the task back; it is refused without a session, for no such task and when there is nothing to bring in", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const api = await start(t);
  const call = async (method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Body };
  };
  const task = await readyTask(api);
  const view = async (): Promise<Body> => (await call("GET", `/api/tasks/${task.id}`)).body;
  assert.deepEqual((await view()).mainUpdate, { choice: "ask", branch: "main", behind: 0, problem: null, underWay: false, line: null, updates: [] });
  const refused = await call("POST", `/api/tasks/${task.id}/update-with-main`, {});
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /already holds everything on main/);

  write(api.repo, "README.md", "# Sample\n\nMoved on.\n");
  const mainHead = ownerCommit(api.repo, "main moves on");
  assert.equal(((await view()).mainUpdate as Body).behind, 1);

  const anonymous = await fetch(`${api.base}/api/tasks/${task.id}/update-with-main`, { method: "POST", headers: JSON_TYPE, body: "{}" });
  assert.equal(anonymous.status, 401);
  await anonymous.arrayBuffer();
  assert.equal((await call("POST", "/api/tasks/9999/update-with-main", {})).status, 404);

  const started = await call("POST", `/api/tasks/${task.id}/update-with-main`, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, "building");
  const deadline = Date.now() + 30_000;
  while (getTask(api.server.db, task.id)!.status !== "awaiting_decision") {
    assert.ok(Date.now() < deadline, `never ready again: ${getTask(api.server.db, task.id)!.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = await view();
  const update = after.mainUpdate as Body;
  assert.equal(update.behind, 0);
  assert.equal(update.line, "Brought up to date with main: Botbench merged 1 commit with no conflict, then ran the checks again.");
  assert.equal((update.updates as Body[])[0]!.outcome, "merged");
  assert.equal(after.checks, "passed");
  assert.equal(git(api.repo, "rev-parse", `${after.headCommit}^2`).trim(), mainHead);
});
