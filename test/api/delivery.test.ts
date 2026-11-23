import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { decideTask } from "../../src/engine/decision.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { createTask, moveTask, type Task } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { replayGitHub, type Replay } from "../support/replay-github.ts";
import { git, initRepo, tempDir, write } from "../support/repo.ts";

// The delivery routes and fields over real HTTP, against a real Botbench server, real git with a bare repository on
// disk as the remote, and real SQLite. No driver is started. The pull-request step replays output captured once from
// the real gh, through the server's GitHub seam (test/support/replay-github.ts, the owner's approved exception).

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };
const ADDRESS = "https://github.com/botbenchhq/botbench-delivery-fixture.git";

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
  bare: string;
  replay: Replay;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-delivery-api-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", bare);
  git(repo, "config", `url.${bare}.insteadOf`, ADDRESS);
  git(repo, "remote", "add", "origin", ADDRESS);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const replay = replayGitHub();
  const server = await startServer({ config, home, signInDelayMs: 1, github: replay.github });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, base, home, repo, bare, replay, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

async function ready(api: Api, task: Task): Promise<void> {
  const worktree = await createWorktree({ repo: api.repo, home: api.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(api.server.db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  moveTask(api.server.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
}

const waitFor = async (what: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (await what()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out");
};

test("a run's delivery is one of two choices, refused before anything exists otherwise, and shown on the run and its tasks", async (t) => {
  const api = await start(t);
  for (const delivery of ["force", "push", 1, {}]) {
    const res = await call(api, "POST", "/api/runs", { repo: api.repo, prompt: "plan this", delivery });
    assert.equal(res.status, 400, String(delivery));
    assert.match(String(res.body.error), /"delivery" must be "branch".*or "pull_request"/);
  }
  assert.equal(api.server.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0, "no run was made");

  const run = createRun(api.server.db, { repo: api.repo, prompt: "Add a greeting", baseCommit: git(api.repo, "rev-parse", "HEAD").trim(), delivery: "pull_request" });
  const planned = storePlan(api.server.db, run.id, [{ title: "Add a greeting file", criteria: ["hello.txt says hi"] }]);
  const [task] = approvePlan(api.server.db, run.id, planned.planVersion).tasks;
  const shown = (await call(api, "GET", `/api/runs/${run.id}`)).body;
  assert.equal(shown.delivery, "pull_request");
  const row = (shown.tasks as Body[])[0]!;
  assert.deepEqual(row.pullRequest, { choice: "pull_request", state: "none", number: null, url: null, adopted: false, prState: null, pushed: false, repository: null, base: null, remote: null, branch: null, problem: null, at: null });

  // Accepted over HTTP: the run's choice delivers it, and the task and the run's row say so.
  await ready(api, task!);
  assert.equal((await call(api, "POST", `/api/tasks/${task!.id}/accept`, {})).status, 200);
  await waitFor(async () => ((await call(api, "GET", `/api/tasks/${task!.id}`)).body.pullRequest as Body).state === "opened");
  const detail = (await call(api, "GET", `/api/tasks/${task!.id}`)).body;
  const pr = detail.pullRequest as Body;
  assert.match(String(pr.url), /^https:\/\/github\.com\/.+\/pull\/\d+$/);
  assert.equal(pr.base, "main");
  assert.equal(detail.pullRequestTarget, null, "nothing more to confirm");
  const again = (await call(api, "GET", `/api/runs/${run.id}`)).body;
  assert.equal(((again.tasks as Body[])[0]!.pullRequest as Body).number, pr.number);
  assert.equal(api.replay.opened.length, 1);
});

test("Open a pull request on an accepted task that kept its branch: needs a session, names what was shown, then delivers; a second is refused", async (t) => {
  const api = await start(t);
  const task = createTask(api.server.db, { repo: api.repo, prompt: "create hello.txt" });
  await ready(api, task);
  const before = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
  assert.equal(before.pullRequestTarget, null, "not offered before the task is accepted");
  assert.equal((await call(api, "POST", `/api/tasks/${task.id}/pull-request`, { remote: "origin", branch: before.branch })).status, 409);
  await decideTask(api.server.db, { taskId: task.id, decision: "accept" });

  const shown = (await call(api, "GET", `/api/tasks/${task.id}`)).body;
  assert.deepEqual(shown.pullRequestTarget, { remote: "origin", address: ADDRESS, repository: "github.com/botbenchhq/botbench-delivery-fixture", branch: shown.branch, base: null });
  assert.equal((shown.pullRequest as Body).choice, "branch");

  const anonymous = await fetch(`${api.base}/api/tasks/${task.id}/pull-request`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ remote: "origin", branch: shown.branch }) });
  assert.equal(anonymous.status, 401);
  await anonymous.arrayBuffer();
  const wrong = await call(api, "POST", `/api/tasks/${task.id}/pull-request`, { remote: "origin", branch: "botbench/elsewhere" });
  assert.equal(wrong.status, 409);
  assert.match(String(wrong.body.error), /not the one you were shown/);

  const sent = await call(api, "POST", `/api/tasks/${task.id}/pull-request`, { remote: "origin", branch: shown.branch });
  assert.equal(sent.status, 200);
  await waitFor(async () => ((await call(api, "GET", `/api/tasks/${task.id}`)).body.pullRequest as Body).state === "opened");
  assert.equal(git(api.bare, "rev-parse", `refs/heads/${String(shown.branch)}`).trim(), shown.headCommit);
  const second = await call(api, "POST", `/api/tasks/${task.id}/pull-request`, { remote: "origin", branch: shown.branch });
  assert.equal(second.status, 409);
  assert.match(String(second.body.error), /already has its pull request/);

  // Activity lists each step under its own rule.
  const log = (await call(api, "GET", "/api/action-log")).body;
  const steps = (log.entries as Body[]).filter((e) => e.rule === "delivery");
  assert.equal(steps.length, 3);
});
