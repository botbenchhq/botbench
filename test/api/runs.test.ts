import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import type { PlanTask } from "../../src/engine/roles.ts";
import { createRun, MAX_SPEC_BYTES, storePlan } from "../../src/engine/run.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";
import { checkoutState, initRepo, tempDir, worktreeCount } from "../support/repo.ts";

// No test in this file starts a driver: a run that is started for real reaches Claude Code, and is in
// test/live/plan.live.test.ts. Here runs are put in the store as the engine stores them, and the routes act on them.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const THREE: PlanTask[] = [
  { title: "Add a greeting file", criteria: ["hello.txt exists", "It holds hi"] },
  { title: "Add a farewell file", criteria: ["bye.txt exists"] },
  { title: "Describe both files", criteria: ["README.md names both"] },
];

interface Api {
  server: SmeltServer;
  dir: string;
  home: string;
  repo: string;
  commit: string;
  base: string;
  headers: Record<string, string>;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("smelt-runs-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const commit = initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { server, dir, home, repo, commit, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

type Body = Record<string, unknown>;
async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}
const count = (api: Api, table: string): number => Number(api.server.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

/** A run waiting for the owner, stored as the engine stores one once its planner has answered. */
function planned(api: Api, tasks: PlanTask[] = THREE): { id: number; planVersion: number } {
  const run = createRun(api.server.db, { repo: api.repo, prompt: "Add two files and describe them", baseCommit: api.commit, preapproved: ["npm test"] });
  const waiting = storePlan(api.server.db, run.id, tasks);
  return { id: run.id, planVersion: waiting.planVersion };
}

test("every run route refuses a request without a session", async (t) => {
  const api = await start(t);
  const run = planned(api);
  const routes: [string, string, unknown?][] = [
    ["POST", "/api/runs", { repo: api.repo, prompt: "plan this" }],
    ["GET", "/api/runs"],
    ["GET", `/api/runs/${run.id}`],
    ["PATCH", `/api/runs/${run.id}/plan`, { planVersion: run.planVersion, tasks: THREE.slice(0, 1) }],
    ["POST", `/api/runs/${run.id}/plan/approve`, { planVersion: run.planVersion }],
    ["POST", `/api/runs/${run.id}/plan/request-changes`, { planVersion: run.planVersion, feedback: "fewer" }],
    ["POST", `/api/runs/${run.id}/cancel`, {}],
  ];
  for (const [method, route, body] of routes) {
    for (const without of [{}, { cookie: "smelt_session=not-a-session" }] as Record<string, string>[]) {
      const res = await fetch(`${api.base}${route}`, { method, headers: { ...without, ...(body ? JSON_TYPE : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, 401, `${method} ${route} without a session`);
      assert.deepEqual(await res.json(), { error: "sign in required" });
    }
  }
  // Nothing came of the refused requests: one run, still waiting, its plan whole, no task.
  assert.equal(count(api, "runs"), 1);
  assert.equal(count(api, "tasks"), 0);
  const still = await call(api, "GET", `/api/runs/${run.id}`);
  assert.deepEqual([still.status, still.body.status, (still.body.plan as unknown[]).length], [200, "awaiting_plan_approval", 3]);
  assert.equal(worktreeCount(api.repo), 1);
});

test("starting a run takes exactly one of a prompt and a spec file, a usable repository and a plain model name; a refused start stores no run", async (t) => {
  const api = await start(t);
  const spec = path.join(api.dir, "spec.md");
  fs.writeFileSync(spec, "# Spec\n");
  const bad: [unknown, number, RegExp][] = [
    ["not json", 400, /JSON/],
    [[], 400, /expected/],
    [{ prompt: "p" }, 400, /expected|repo/],
    [{ repo: api.repo }, 400, /one of|prompt/i],
    [{ repo: api.repo, prompt: "p", specPath: spec }, 400, /one of|not both/i],
    [{ repo: api.repo, prompt: "" }, 400, /prompt/],
    [{ repo: api.repo, prompt: 5 }, 400, /prompt/],
    [{ repo: api.repo, prompt: "x".repeat(20_001) }, 400, /too long/],
    [{ repo: "relative/path", prompt: "p" }, 400, /full path/],
    [{ repo: path.join(api.dir, "missing"), prompt: "p" }, 400, /does not exist/],
    [{ repo: api.dir, prompt: "p" }, 400, /not a git repository/],
    [{ repo: api.repo, prompt: "p", model: "--dangerously-skip-permissions" }, 400, /model/],
    [{ repo: api.repo, prompt: "p", preapproved: "npm test" }, 400, /preapproved/],
    [{ repo: api.repo, prompt: "p", preapproved: ["ls | sh"] }, 400, /cannot be pre-approved/],
  ];
  for (const [body, status, words] of bad) {
    const res = await call(api, "POST", "/api/runs", body);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 90));
    assert.match(String(res.body.error), words, JSON.stringify(body).slice(0, 90));
  }
  assert.equal(count(api, "runs"), 0);
  assert.equal(count(api, "attempts"), 0, "no planner was started");
  assert.equal(worktreeCount(api.repo), 1);
});

test("a spec file that is missing, relative, too large, not a regular file, not text or not a .md file is refused in words before any run exists", async (t) => {
  const api = await start(t);
  const before = checkoutState(api.repo);
  const file = (name: string, content: string | Buffer): string => {
    fs.writeFileSync(path.join(api.dir, name), content);
    return path.join(api.dir, name);
  };
  fs.mkdirSync(path.join(api.dir, "folder.md"));
  execFileSync("mkfifo", [path.join(api.dir, "pipe.md")]);
  const bad: [unknown, RegExp][] = [
    [path.join(api.dir, "missing.md"), /does not exist/],
    ["spec.md", /full path/],
    ["../spec.md", /full path/],
    [7, /specPath|full path/],
    [file("big.md", "x".repeat(MAX_SPEC_BYTES + 1)), /too large/],
    [path.join(api.dir, "folder.md"), /not a regular file/],
    [path.join(api.dir, "pipe.md"), /not a regular file/],
    [file("binary.md", Buffer.from([0x23, 0x00, 0xff, 0xfe])), /not text/],
    [file("notes.pem", "text"), /\.md/],
    [path.join(api.home, LOGIN_TOKEN_FILE), /\.md|Smelt's own/],
  ];
  for (const [specPath, words] of bad) {
    const res = await call(api, "POST", "/api/runs", { repo: api.repo, specPath });
    assert.equal(res.status, 400, String(specPath));
    assert.match(String(res.body.error), words, String(specPath));
    assert.doesNotMatch(JSON.stringify(res.body), /BEGIN|\\u0000/, "nothing of a refused file is echoed");
  }
  assert.equal(count(api, "runs"), 0);
  assert.equal(count(api, "attempts"), 0);
  assert.equal(worktreeCount(api.repo), 1);
  assert.deepEqual(checkoutState(api.repo), before);
  assert.deepEqual((await call(api, "GET", "/api/runs")).body, { runs: [] });
});

test("a run is read with its plan and listed newest first; an unknown run is 404", async (t) => {
  const api = await start(t);
  const first = planned(api);
  const second = planned(api, THREE.slice(0, 1));
  const one = await call(api, "GET", `/api/runs/${first.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(
    { ...one.body, createdAt: null, updatedAt: null },
    {
      id: first.id, repo: fs.realpathSync(api.repo), prompt: "Add two files and describe them", specPath: null, specText: null, title: "Add two files and describe them",
      status: "awaiting_plan_approval", reason: null, requestedModel: null, plannerModel: null, baseCommit: api.commit, attemptId: null, planVersion: first.planVersion,
      plan: THREE, tasks: [], preapproved: ["npm test"], waitingOnApproval: false, createdAt: null, updatedAt: null,
    },
  );
  const list = await call(api, "GET", "/api/runs");
  assert.deepEqual((list.body.runs as Body[]).map((run) => [run.id, run.status, run.title, run.taskCount]), [[second.id, "awaiting_plan_approval", "Add two files and describe them", 1], [first.id, "awaiting_plan_approval", "Add two files and describe them", 3]]);
  // A run no planner has been started for says so: it names no attempt.
  const unplanned = createRun(api.server.db, { repo: api.repo, prompt: "waits its turn", baseCommit: api.commit });
  assert.deepEqual((((await call(api, "GET", "/api/runs")).body.runs as Body[])[0]!), { ...(((await call(api, "GET", "/api/runs")).body.runs as Body[])[0]!), id: unplanned.id, status: "planning", attemptId: null, taskCount: 0 });
  for (const route of ["/api/runs/999", "/api/runs/999/cancel", "/api/runs/999/plan/approve"]) {
    const res = await call(api, route.endsWith("999") ? "GET" : "POST", route, route.endsWith("999") ? undefined : { planVersion: 1 });
    assert.deepEqual([res.status, res.body.error], [404, "No such run."], route);
  }
  // An id that is no id names no route.
  assert.equal((await call(api, "GET", "/api/runs/0")).status, 404);
  assert.equal((await call(api, "GET", "/api/runs/1e3")).status, 404);
});

test("a plan edit is validated and stored; approving creates one queued task per plan task; every later change is refused with 409", async (t) => {
  const api = await start(t);
  const run = planned(api);
  const plan = `/api/runs/${run.id}/plan`;
  const badEdits: [unknown, RegExp][] = [
    ["not json", /JSON/],
    [{ tasks: THREE }, /planVersion/],
    [{ planVersion: run.planVersion }, /tasks/],
    [{ planVersion: run.planVersion, tasks: [] }, /at least 1 task/],
    [{ planVersion: run.planVersion, tasks: [{ title: "", criteria: ["c"] }] }, /title/],
    [{ planVersion: run.planVersion, tasks: [{ title: "t", criteria: [] }] }, /criterion/],
    [{ planVersion: run.planVersion, tasks: [{ title: "t", criteria: ["x".repeat(600)] }] }, /characters/],
    [{ planVersion: run.planVersion, tasks: Array.from({ length: 21 }, () => THREE[0]) }, /at most 20/],
    [{ planVersion: "1", tasks: THREE }, /planVersion/],
  ];
  for (const [body, words] of badEdits) {
    const res = await call(api, "PATCH", plan, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(String(res.body.error), words);
  }
  assert.deepEqual((await call(api, "GET", `/api/runs/${run.id}`)).body.plan, THREE, "a refused edit changed nothing");

  const edited = [{ title: "Add a greeting file <b>now</b>", criteria: ["hello.txt exists"] }, THREE[2]!];
  const saved = await call(api, "PATCH", plan, { planVersion: run.planVersion, tasks: edited });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.plan, edited, "text is stored and returned as text");
  assert.notEqual(saved.body.planVersion, run.planVersion);
  // The window that still shows the old plan can neither edit nor approve it.
  assert.equal((await call(api, "PATCH", plan, { planVersion: run.planVersion, tasks: THREE })).status, 409);
  const stale = await call(api, "POST", `${plan}/approve`, { planVersion: run.planVersion });
  assert.equal(stale.status, 409);
  assert.match(String(stale.body.error), /changed/);
  assert.equal((await call(api, "POST", `${plan}/approve`, {})).status, 400);
  assert.equal(count(api, "tasks"), 0);

  // Two windows approve at the same moment: one approval, one set of tasks.
  const version = saved.body.planVersion;
  const both = await Promise.all([call(api, "POST", `${plan}/approve`, { planVersion: version }), call(api, "POST", `${plan}/approve`, { planVersion: version })]);
  assert.deepEqual(both.map((res) => res.status).sort(), [200, 409]);
  const approved = both.find((res) => res.status === 200)!.body;
  assert.equal(approved.status, "running");
  assert.deepEqual((approved.tasks as Body[]).map((task) => [task.status, task.title]), [["queued", "Add a greeting file <b>now</b>"], ["queued", "Describe both files"]]);
  assert.equal(count(api, "tasks"), 2);
  assert.equal(worktreeCount(api.repo), 1, "no worktree is made by approving");
  assert.equal(fs.existsSync(path.join(api.home, "worktrees")), false);
  // The tasks are real task rows: the task routes know them, with the run's pre-approved commands.
  const tasks = (await call(api, "GET", "/api/tasks")).body.tasks as Body[];
  assert.deepEqual(tasks.map((task) => [task.status, task.preapproved, task.ofPlan]), [["queued", ["npm test"], run.id], ["queued", ["npm test"], run.id]]);

  // Approved: the plan is fixed, and nothing in this version stops or changes the run.
  const after = (await call(api, "GET", `/api/runs/${run.id}`)).body;
  for (const [method, route, body] of [
    ["PATCH", plan, { planVersion: after.planVersion, tasks: THREE }],
    ["POST", `${plan}/approve`, { planVersion: after.planVersion }],
    ["POST", `${plan}/request-changes`, { planVersion: after.planVersion, feedback: "fewer tasks" }],
    ["POST", `/api/runs/${run.id}/cancel`, {}],
  ] as [string, string, unknown][]) {
    const res = await call(api, method, route, body);
    assert.equal(res.status, 409, `${method} ${route} after approval`);
    assert.match(String(res.body.error), /approved/);
  }
  assert.equal(count(api, "tasks"), 2);
  assert.deepEqual((await call(api, "GET", `/api/runs/${run.id}`)).body.plan, edited);
});

test("cancel ends a run that waits for approval, once; request-changes needs feedback and a run that waits; state changes are announced on the event stream", async (t) => {
  const api = await start(t);
  const run = planned(api);
  // The stream, read as a browser reads it.
  const streamed = await fetch(`${api.base}/api/stream`, { headers: api.headers });
  const reader = streamed.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  let text = "";
  const until = async (words: RegExp): Promise<string> => {
    const deadline = Date.now() + 5000;
    while (!words.test(text)) {
      assert.ok(Date.now() < deadline, `the stream never said ${words}; it said ${text}`);
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString("utf8");
    }
    return text;
  };
  await until(/connected/);

  for (const [body, words] of [[{ planVersion: run.planVersion }, /feedback/], [{ planVersion: run.planVersion, feedback: "  " }, /feedback/], [{ planVersion: run.planVersion, feedback: "x".repeat(5001) }, /too long/], [{ feedback: "fewer" }, /planVersion/]] as [unknown, RegExp][]) {
    const res = await call(api, "POST", `/api/runs/${run.id}/plan/request-changes`, body);
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), words);
  }
  assert.equal((await call(api, "POST", `/api/runs/${run.id}/plan/request-changes`, { planVersion: run.planVersion + 1, feedback: "fewer" })).status, 409);

  const cancelled = await call(api, "POST", `/api/runs/${run.id}/cancel`, {});
  assert.deepEqual([cancelled.status, cancelled.body.status], [200, "cancelled"]);
  assert.match(await until(/event: run\ndata: [^\n]*"cancelled"/), new RegExp(`event: run\\ndata: \\{"runId":${run.id},"status":"cancelled"\\}`));
  for (const [method, route, body] of [
    ["POST", `/api/runs/${run.id}/cancel`, {}],
    ["POST", `/api/runs/${run.id}/plan/approve`, { planVersion: run.planVersion }],
    ["PATCH", `/api/runs/${run.id}/plan`, { planVersion: run.planVersion, tasks: THREE }],
    ["POST", `/api/runs/${run.id}/plan/request-changes`, { planVersion: run.planVersion, feedback: "fewer" }],
  ] as [string, string, unknown][]) {
    const res = await call(api, method, route, body);
    assert.equal(res.status, 409, `${method} ${route} after cancel`);
    assert.match(String(res.body.error), /cancelled/);
  }
  assert.equal(count(api, "tasks"), 0);
  assert.equal(count(api, "attempts"), 0, "no planner was started by any refused request");

  // An approval is announced too, with the tasks it queued.
  const other = planned(api);
  await call(api, "POST", `/api/runs/${other.id}/plan/approve`, { planVersion: other.planVersion });
  const said = await until(new RegExp(`"runId":${other.id},"status":"running"`));
  assert.match(said, /event: task\ndata: [^\n]*"status":"queued"/);
});
