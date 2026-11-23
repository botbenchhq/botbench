import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { IMPLEMENTER, roleProblem, type PlanTask } from "../../src/engine/roles.ts";
import { CodexDriver } from "../../src/drivers/codex.ts";
import { approvePlan, createRun, MAX_SPEC_BYTES, storePlan } from "../../src/engine/run.ts";
import { insertEvidence } from "../../src/engine/stations.ts";
import { moveTask } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { checkoutState, initRepo, tempDir, worktreeCount } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

/** Codex's roles here: a reviewer, and a builder too where the installed Codex can build (its probe says so; inside a sandbox, or with no Codex, it cannot). */
async function codexRoles(): Promise<string[]> {
  const codex = new CodexDriver();
  await codex.probe();
  return roleProblem(IMPLEMENTER, "codex", codex.capabilities) === null ? ["builder", "reviewer"] : ["reviewer"];
}

// No test in this file starts a driver: a run that is started for real reaches Claude Code, and is in
// test/live/plan.live.test.ts. Here runs are put in the store as the engine stores them, and the routes act on them.
// An approved plan is really built, up to the repository's setup command, which fails or is cancelled before any
// builder could start; a build with Claude Code is in test/live/build.live.test.ts.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const THREE: PlanTask[] = [
  { title: "Add a greeting file", criteria: ["hello.txt exists", "It holds hi"] },
  { title: "Add a farewell file", criteria: ["bye.txt exists"] },
  { title: "Describe both files", criteria: ["README.md names both"] },
];

interface Api {
  server: BotbenchServer;
  dir: string;
  home: string;
  repo: string;
  commit: string;
  base: string;
  headers: Record<string, string>;
}

/** The repository's setup command fails, so a task an approval queues is built up to its setup and no further: no CLI ever starts here. */
const FAILING_SETUP = "echo preparing the copy; exit 1";

async function start(t: T, setup: string[] = [FAILING_SETUP]): Promise<Api> {
  const dir = tempDir("botbench-runs-api-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const commit = initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: { setup } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  // The server, with the engine an approval sets to work and its broker, is closed before its folder is removed, and a
  // removal that fails cannot leave it open. A setup that throws before here leaves the folder to tempDir's own removal.
  t.after(async () => {
    try {
      await server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
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

/** Read the run until `done` says so. */
async function untilRun(api: Api, id: number, done: (body: Body) => boolean): Promise<Body> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const body = (await call(api, "GET", `/api/runs/${id}`)).body;
    if (done(body)) return body;
    assert.ok(Date.now() < deadline, `the run never got there: ${JSON.stringify(body).slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
    for (const without of [{}, { cookie: "botbench_session=not-a-session" }] as Record<string, string>[]) {
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
    [{ repo: api.repo, prompt: "p", buildModel: "--dangerously-skip-permissions" }, 400, /build model/],
    [{ repo: api.repo, prompt: "p", buildModel: 5 }, 400, /build model/],
    [{ repo: api.repo, prompt: "p", preapproved: "npm test" }, 400, /preapproved/],
    [{ repo: api.repo, prompt: "p", preapproved: ["ls | sh"] }, 400, /cannot be allowed in advance/],
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
    [path.join(api.home, LOGIN_TOKEN_FILE), /\.md|Botbench's own/],
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
      status: "awaiting_plan_approval", reason: null, requestedModel: null, plannerModel: null, baseCommit: api.commit, attemptId: null, planVersion: first.planVersion, reviewer: null, mode: "manual", delivery: "branch", maxRefineRounds: 2, issue: null, outsideText: false, outsideHosts: false, oneTask: false, onLimit: "wait", issueHosts: [], claim: null, source: null,
      // A manual run can be made no stricter, and its mode was never changed.
      modeChoices: [], modeChanges: [],
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

test("a plan edit is validated and stored; approving creates one queued task per plan task; every later change is refused with 409", { skip: NO_SANDBOX }, async (t) => {
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
  // The tasks are real task rows: the task routes know them, with the run's pre-approved commands.
  const tasks = (await call(api, "GET", "/api/tasks")).body.tasks as Body[];
  assert.deepEqual(tasks.map((task) => [task.preapproved, task.ofPlan]), [[["npm test"], run.id], [["npm test"], run.id]]);

  // The run is built, one task after the other: each in its own worktree, where the setup command failed, so each failed with its output and no builder started.
  const built = await untilRun(api, run.id, (body) => body.status !== "running");
  // Changed in unit 16: this pinned "awaiting_decision". Both tasks failed, so nothing is ready for review and the run is done.
  assert.equal(built.status, "done");
  const rows = built.tasks as Body[];
  assert.deepEqual(rows.map((task) => [task.status, task.attemptId]), [["failed", null], ["failed", null]]);
  for (const task of rows) {
    assert.match(String(task.reason), /setup command/i);
    const [evidence] = task.evidence as Body[];
    assert.deepEqual([evidence!.kind, evidence!.command, evidence!.outcome, evidence!.exitCode], ["setup", FAILING_SETUP, "failed", 1]);
    assert.match(String(evidence!.output), /preparing the copy/);
    assert.equal(typeof evidence!.durationMs, "number");
  }
  assert.equal(worktreeCount(api.repo), 3, "one worktree for each approved task");
  assert.equal(count(api, "attempts"), 0, "no builder was started");

  // Approved: the plan is fixed; a run that has finished building has nothing left to cancel.
  for (const [method, route, body] of [
    ["PATCH", plan, { planVersion: built.planVersion, tasks: THREE }],
    ["POST", `${plan}/approve`, { planVersion: built.planVersion }],
    ["POST", `${plan}/request-changes`, { planVersion: built.planVersion, feedback: "fewer tasks" }],
  ] as [string, string, unknown][]) {
    const res = await call(api, method, route, body);
    assert.equal(res.status, 409, `${method} ${route} after approval`);
    assert.match(String(res.body.error), /approved/);
  }
  const late = await call(api, "POST", `/api/runs/${run.id}/cancel`, {});
  assert.equal(late.status, 409);
  assert.match(String(late.body.error), /built/);
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

test("a run that is building is cancelled over HTTP: the setup command at work is stopped, its tasks are cancelled, and the run and each task say so with their evidence", { skip: NO_SANDBOX, timeout: 30_000 }, async (t) => {
  const api = await start(t, ["sleep 30"]);
  const run = planned(api, THREE.slice(0, 2));
  const approved = await call(api, "POST", `/api/runs/${run.id}/plan/approve`, { planVersion: run.planVersion });
  assert.equal(approved.status, 200);
  await untilRun(api, run.id, (body) => (body.tasks as Body[])[0]!.status === "building");
  const cancelled = await call(api, "POST", `/api/runs/${run.id}/cancel`, {});
  assert.deepEqual([cancelled.status, cancelled.body.status], [200, "cancelled"]);
  const ended = await untilRun(api, run.id, (body) => (body.tasks as Body[]).every((task) => task.status === "cancelled"));
  assert.equal(ended.status, "cancelled");
  const [first, second] = ended.tasks as Body[];
  assert.deepEqual(((first!.evidence as Body[]) ?? []).map((row) => [row.command, row.outcome]), [["sleep 30", "stopped"]]);
  assert.deepEqual(second!.evidence, []);
  const task = (await call(api, "GET", `/api/tasks/${first!.id}`)).body;
  assert.equal(task.status, "cancelled");
  assert.match(String(task.reason), /cancelled/);
  assert.deepEqual((task.evidence as Body[]).map((row) => [row.kind, row.position, row.command, row.outcome]), [["setup", 1, "sleep 30", "stopped"]]);
  assert.equal(count(api, "attempts"), 0);
  assert.equal((await call(api, "POST", `/api/runs/${run.id}/cancel`, {})).status, 409);
});

test("a task's checks are read with it: the mark that says how they went and each check's evidence, on the task and on its run", async (t) => {
  const api = await start(t);
  const run = planned(api, THREE.slice(0, 1));
  const { tasks } = approvePlan(api.server.db, run.id, run.planVersion);
  const id = tasks[0]!.id;
  // A task as the build line leaves it once its checks ran: built, checked, one check failed.
  moveTask(api.server.db, id, "building");
  moveTask(api.server.db, id, "verifying");
  const ran = (command: string, outcome: "passed" | "failed", exitCode: number, output: string) => ({ command, outcome, exitCode, signal: null, output, truncated: false, limitMs: 600_000, startedAt: "2026-11-22T10:00:00.000Z", endedAt: "2026-11-22T10:00:02.000Z", durationMs: 2000 });
  insertEvidence(api.server.db, id, "check", 1, ran("npm test", "failed", 1, "1 failing"));
  insertEvidence(api.server.db, id, "check", 2, ran("npm run lint", "passed", 0, "clean"));
  moveTask(api.server.db, id, "awaiting_decision", { checks: "failed" });

  const task = (await call(api, "GET", `/api/tasks/${id}`)).body;
  assert.equal(task.checks, "failed");
  assert.deepEqual((task.evidence as Body[]).map((row) => [row.kind, row.position, row.command, row.outcome, row.exitCode, row.output]), [["check", 1, "npm test", "failed", 1, "1 failing"], ["check", 2, "npm run lint", "passed", 0, "clean"]]);
  const listed = ((await call(api, "GET", "/api/tasks")).body.tasks as Body[]).find((row) => row.id === id)!;
  assert.equal(listed.checks, "failed");
  const row = ((await call(api, "GET", `/api/runs/${run.id}`)).body.tasks as Body[])[0]!;
  assert.equal(row.checks, "failed");
  assert.equal((row.evidence as Body[]).length, 2);
});

test("a run's reviewer is refused in words when it is malformed, unknown, the builder's own agent and model, or an agent that cannot review yet; nothing is stored", async (t) => {
  const api = await start(t);
  const bad: [unknown, RegExp][] = [
    ["codex", /"reviewer" must be null, or/],
    [{ agent: "codex", model: "gpt-6-luna", extra: 1 }, /"reviewer" must be null, or/],
    [{ agent: "copilot", model: null }, /an agent Botbench does not know/],
    [{ agent: "codex", model: "--sandbox" }, /reviewer's model is not a model name/],
    // The builder here is Claude Code with its own default model.
    [{ agent: "claude-code", model: null }, /The reviewer must be a different model from the builder, and Claude Code with its own default model builds this run\./],
    [{ agent: "claude-code", model: "sonnet" }, /Claude Code cannot review a run\. Choose Codex, Grok, Antigravity, or no review\./],
  ];
  for (const [reviewer, words] of bad) {
    const res = await call(api, "POST", "/api/runs", { repo: api.repo, prompt: "plan this", reviewer });
    assert.equal(res.status, 400, JSON.stringify(reviewer));
    assert.match(String(res.body.error), words, JSON.stringify(reviewer));
  }
  assert.equal(count(api, "runs"), 0);
  assert.equal(count(api, "attempts"), 0, "no planner was started");
});

test("a run's screen names its reviewer, and a task's screen gives its review once there is one", async (t) => {
  const api = await start(t);
  const run = createRun(api.server.db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit, reviewer: { agent: "codex", model: "gpt-6-luna" } });
  const plain = createRun(api.server.db, { repo: api.repo, prompt: "Add another", baseCommit: api.commit });
  assert.deepEqual((await call(api, "GET", `/api/runs/${run.id}`)).body.reviewer, { agent: "codex", model: "gpt-6-luna" });
  assert.equal((await call(api, "GET", `/api/runs/${plain.id}`)).body.reviewer, null);
  const waiting = storePlan(api.server.db, run.id, THREE.slice(0, 1));
  const { tasks } = approvePlan(api.server.db, run.id, waiting.planVersion);
  const id = tasks[0]!.id;
  // Where a review leaves a task, as the engine writes it.
  moveTask(api.server.db, id, "building");
  moveTask(api.server.db, id, "reviewing", { checks: "none" });
  const reviewing = (await call(api, "GET", `/api/tasks/${id}`)).body;
  assert.deepEqual([reviewing.status, reviewing.reviewer, reviewing.review], ["reviewing", { agent: "codex", model: "gpt-6-luna" }, null]);
  api.server.db.prepare("INSERT INTO reviews (task_id, agent, model, attempt_id, outcome, verdict, text, problem, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, 'codex', 'gpt-6-luna', NULL, 'reviewed', 'concerns', ?, NULL, 120, 0, 'a', 'b', 4200)").run(id, "Verdict: concerns\nFindings:\n- calc.py:2: subtracts");
  const review = (await call(api, "GET", `/api/tasks/${id}`)).body.review as Record<string, unknown>;
  assert.deepEqual({ agent: review.agent, model: review.model, outcome: review.outcome, verdict: review.verdict, text: review.text, problem: review.problem, diffCut: review.diffCut }, { agent: "codex", model: "gpt-6-luna", outcome: "reviewed", verdict: "concerns", text: "Verdict: concerns\nFindings:\n- calc.py:2: subtracts", problem: null, diffCut: false });
});

test("the agents are listed with what each reports about itself, and each reviewer's models come from its CLI or the configuration, never made up", async (t) => {
  const api = await start(t);
  const agents = (await call(api, "GET", "/api/agents")).body.agents as Record<string, unknown>[];
  assert.deepEqual(agents.map((agent) => agent.agent), ["claude-code", "codex", "grok", "antigravity"]);
  for (const agent of agents) for (const key of ["installed", "version", "supported", "signedIn", "billing", "problem"]) assert.ok(key in agent, `${String(agent.agent)}: ${key}`);
  assert.deepEqual(agents.map((agent) => agent.roles), [["planner", "builder"], await codexRoles(), ["reviewer"], ["reviewer"]]);
  for (const reviewer of ["codex", "grok", "antigravity"]) {
    const models = (await call(api, "GET", `/api/agents/${reviewer}/models`)).body;
    assert.ok(models.source === "cli" || models.source === "config", reviewer);
    assert.equal(models.driver, reviewer);
  }
  assert.equal((await call(api, "GET", "/api/agents/gemini-cli/models")).status, 404);
  const refused = await fetch(`${api.base}/api/agents`);
  assert.equal(refused.status, 401);
});

test("a run says which model its tasks are to be built on, and its tasks say it too once its plan is approved", async (t) => {
  const api = await start(t);
  const run = storePlan(api.server.db, createRun(api.server.db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit, requestedModel: "opus", buildModel: "sonnet" }).id, THREE.slice(0, 1));
  const read = await call(api, "GET", `/api/runs/${run.id}`);
  assert.deepEqual([read.body.requestedModel, read.body.buildModel], ["opus", "sonnet"]);
  const approved = await call(api, "POST", `/api/runs/${run.id}/plan/approve`, { planVersion: run.planVersion });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const task = await call(api, "GET", `/api/tasks/${((approved.body.tasks as Body[])[0]!).id}`);
  assert.equal(task.body.requestedModel, "sonnet");
});
