import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { taskEvidence } from "../../src/engine/stations.ts";
import { createTask, getTask, moveTask, type Task } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { initRepo, tempDir, write } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// The Resume route over real HTTP, against a real Botbench server, a real temporary repository and real SQLite. Tasks
// are put where a restart leaves them by Botbench's own worktree, commit and state functions, as the other task API
// tests do. The one Resume that goes through here runs only the repository's real check commands: no agent is started.
// A Resume that re-drives an agent is in test/engine/recover.test.ts (a recorded session), test/live/recover.live.test.ts
// and e2e/resume.e2e.ts (the real Claude Code).

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
  const dir = tempDir("botbench-resume-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

/** A task whose work is committed and whose checks were stopped by a restart, as Botbench leaves it. */
async function stoppedInChecks(api: Api): Promise<Task> {
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(api.server.db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  moveTask(api.server.db, task.id, "verifying", { headCommit: committed.commit });
  return moveTask(api.server.db, task.id, "interrupted", { reason: "Botbench stopped twice while this task's checks ran. The work is committed to its branch. Resume runs the checks again." });
}

test("Resume is refused without a session, for a task that does not exist, and for a task in any state but stopped, each with a plain reason; nothing changes", async (t) => {
  const api = await start(t);
  const task = await stoppedInChecks(api);
  const res = await fetch(`${api.base}/api/tasks/${task.id}/resume`, { method: "POST", headers: JSON_TYPE, body: "{}" });
  assert.equal(res.status, 401);
  await res.arrayBuffer();
  assert.equal(getTask(api.server.db, task.id)!.status, "interrupted");
  assert.equal((await call(api, "POST", "/api/tasks/9999/resume", {})).status, 404);

  // Written after the start, so the engine is not building them: each stands where it is put.
  const others: [Task, RegExp][] = [[createTask(api.server.db, { repo: api.repo, prompt: "queued" }), /queued/]];
  for (const [status, word] of [["failed", /failed/], ["cancelled", /cancelled/]] as const) {
    const other = createTask(api.server.db, { repo: api.repo, prompt: status });
    others.push([moveTask(api.server.db, other.id, status, { reason: `It ${status}.` }), word]);
  }
  const ready = createTask(api.server.db, { repo: api.repo, prompt: "ready" });
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${ready.runId}`, task: `task-${ready.id}` });
  moveTask(api.server.db, ready.id, "building", { worktree });
  others.push([getTask(api.server.db, ready.id)!, /working/]);
  for (const [other, word] of others) {
    const refused = await call(api, "POST", `/api/tasks/${other.id}/resume`, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    // A failed task is refused too: only one failed because its builder changed no file can be resumed (test/engine/no-change.test.ts).
    assert.match(String(refused.body.error), /Only a stopped task, or one whose builder changed no file, can be resumed/);
    assert.match(String(refused.body.error), word);
    assert.equal(getTask(api.server.db, other.id)!.status, other.status);
  }
  // A stopped task that never got a copy of the project has nothing to resume.
  const bare = createTask(api.server.db, { repo: api.repo, prompt: "bare" });
  moveTask(api.server.db, bare.id, "interrupted", { reason: "Botbench stopped before this task started." });
  const nothing = await call(api, "POST", `/api/tasks/${bare.id}/resume`, {});
  assert.equal(nothing.status, 409);
  assert.match(String(nothing.body.error), /nothing to resume/);
  assert.equal(getTask(api.server.db, bare.id)!.status, "interrupted");
});

test("Resume of a task stopped during its checks runs the checks again from the start on the committed work and the task becomes ready for review; the stopped run of them stays on record", { skip: NO_SANDBOX }, async (t) => {
  const api = await start(t);
  const task = await stoppedInChecks(api);
  const resumed = await call(api, "POST", `/api/tasks/${task.id}/resume`, {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.status, "verifying");
  const again = await call(api, "POST", `/api/tasks/${task.id}/resume`, {});
  assert.equal(again.status, 409);
  const deadline = Date.now() + 20_000;
  while (getTask(api.server.db, task.id)!.status === "verifying") {
    if (Date.now() > deadline) assert.fail("the checks did not finish");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const after = getTask(api.server.db, task.id)!;
  assert.deepEqual([after.status, after.checks, after.headCommit], ["awaiting_decision", "passed", task.headCommit]);
  assert.deepEqual(taskEvidence(api.server.db, task.id).map((e) => [e.kind, e.round, e.position, e.outcome]), [["check", 1, 1, "passed"]]);
  const shown = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
  assert.equal(shown.status, "awaiting_decision");
});
