import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { checkoutState, git, initRepo, botbenchBranches, tempDir, worktreeCount } from "../support/repo.ts";

// A run built end to end on the real Claude Code, on the owner's login, through Botbench's HTTP API, in a real temporary
// repository: the planner plans, the owner's edit fixes the plan to two tiny tasks, the owner approves, and the build
// line builds them one after the other. Every prompt is tiny and both roles ask for the cheapest model.

const RUN_TIMEOUT = 420_000;
const JSON_TYPE = { "content-type": "application/json" };

interface Live {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
}
type Body = Record<string, unknown>;

async function start(t: TestContext, files: Record<string, string>, setup: string[]): Promise<Live> {
  const dir = tempDir("botbench-live-build-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, files);
  const config: Config = {
    port: 0,
    listen: ["127.0.0.1"],
    drivers: { "claude-code": {} },
    roles: { planner: { driver: "claude-code", model: "haiku" }, implementer: { driver: "claude-code", model: "haiku" } },
    repositories: { [repo]: { setup } },
  };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(live: Live, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${live.base}${route}`, { method, headers: { ...live.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

/**
 * Wait until `done` holds for the run. A request of the planner that waits for the owner is declined (it only reads);
 * a request of a builder is handed to `onBuilderAsks`.
 */
async function until(live: Live, runId: number, done: (run: Body) => boolean, onBuilderAsks: (approval: Body) => Promise<void>): Promise<Body> {
  const deadline = Date.now() + RUN_TIMEOUT - 60_000;
  for (;;) {
    const run = (await call(live, "GET", `/api/runs/${runId}`)).body;
    if (done(run)) return run;
    for (const approval of (await call(live, "GET", "/api/approvals?status=pending")).body.approvals as Body[]) {
      if (approval.taskId === null) await call(live, "POST", `/api/approvals/${approval.id}`, { decision: "decline", note: "Read files instead; no commands while planning." });
      else await onBuilderAsks(approval);
    }
    if (Date.now() > deadline) assert.fail(`timed out; the run is ${JSON.stringify(run).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Start a run, wait for the planner's plan, set the plan to `tasks` as the owner may, and approve it. */
async function approveAs(live: Live, tasks: { title: string; criteria: string[] }[], preapproved: string[], onBuilderAsks: (approval: Body) => Promise<void>): Promise<{ runId: number; taskIds: number[] }> {
  const started = await call(live, "POST", "/api/runs", { repo: live.repo, prompt: "Plan exactly two tasks: create one.txt, and create two.txt. Do not run any command; the README is all there is to read.", preapproved });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const runId = Number(started.body.runId);
  const waiting = await until(live, runId, (run) => run.status !== "planning", onBuilderAsks);
  assert.equal(waiting.status, "awaiting_plan_approval", String(waiting.reason));
  const edited = await call(live, "PATCH", `/api/runs/${runId}/plan`, { planVersion: waiting.planVersion, tasks });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const approved = await call(live, "POST", `/api/runs/${runId}/plan/approve`, { planVersion: edited.body.planVersion });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { runId, taskIds: (approved.body.tasks as Body[]).map((task) => Number(task.id)) };
}

const taskEvents = (live: Live, id: number) => live.server.db.prepare("SELECT id, status FROM task_events WHERE task_id = ? ORDER BY id").all(id).map((r) => ({ id: Number(r.id), status: String(r.status) }));

test("live: a two-task run builds the first task fully before starting the second; each ends with Botbench's commit on its own branch, after the setup command ran in its copy; the source checkout is unchanged", { timeout: RUN_TIMEOUT }, async (t) => {
  const live = await start(t, { "README.md": "# Sample\n" }, ["echo setting up the copy"]);
  const before = checkoutState(live.repo);
  const asked: Body[] = [];
  const { runId, taskIds } = await approveAs(
    live,
    [
      { title: "Create the file one.txt containing the single word one", criteria: ["one.txt exists at the top of the repository and holds the word one"] },
      { title: "Create the file two.txt containing the single word two", criteria: ["two.txt exists at the top of the repository and holds the word two"] },
    ],
    [],
    async (approval) => {
      asked.push(approval);
      await call(live, "POST", `/api/approvals/${approval.id}`, { decision: "decline", note: "Only write the file with your edit tool; run no command." });
    },
  );
  let sawSecondQueuedWhileFirstBuilt = false;
  const end = await until(live, runId, (run) => {
    const [first, second] = run.tasks as Body[];
    if (first!.status === "building" && second!.status === "queued" && second!.branch === null) sawSecondQueuedWhileFirstBuilt = true;
    return run.status !== "running";
  }, async (approval) => {
    asked.push(approval);
    await call(live, "POST", `/api/approvals/${approval.id}`, { decision: "decline", note: "Only write the file with your edit tool; run no command." });
  });
  assert.equal(end.status, "awaiting_decision");
  assert.ok(sawSecondQueuedWhileFirstBuilt, "the second task was seen queued, with no branch, while the first was being built");

  const [first, second] = taskIds as [number, number];
  const firstEnd = taskEvents(live, first).find((e) => e.status === "awaiting_decision")!;
  const secondStart = taskEvents(live, second).find((e) => e.status === "building")!;
  assert.ok(firstEnd && secondStart && firstEnd.id < secondStart.id, "the second task started only after the first had finished");

  assert.deepEqual(botbenchBranches(live.repo), taskIds.map((id) => `botbench/run-${runId}/task-${id}`));
  for (const [i, id] of taskIds.entries()) {
    const task = (await call(live, "GET", `/api/tasks/${id}`)).body;
    assert.equal(task.status, "awaiting_decision", String(task.reason));
    const word = i === 0 ? "one" : "two";
    assert.equal(git(live.repo, "show", `${task.branch}:${word}.txt`).trim(), word);
    assert.equal(git(live.repo, "log", "-1", "--format=%an <%ae>", String(task.branch)).trim(), "Botbench <botbench@localhost>");
    assert.equal(git(live.repo, "rev-list", "--count", `${task.baseCommit}..${task.branch}`).trim(), "1", "one commit, Botbench's, on the task's branch");
    assert.deepEqual((task.files as Body[]).map((f) => f.path), [`${word}.txt`], "each task's branch holds its own work only");
    assert.deepEqual((task.evidence as Body[]).map((row) => [row.kind, row.command, row.outcome, row.exitCode]), [["setup", "echo setting up the copy", "passed", 0]]);
    assert.match(String((task.evidence as Body[])[0]!.output), /setting up the copy/);
  }
  assert.equal(worktreeCount(live.repo), 3);
  assert.deepEqual(checkoutState(live.repo), before, "the owner's checkout is as it was");
  assert.equal(fs.existsSync(path.join(live.repo, "one.txt")) || fs.existsSync(path.join(live.repo, "two.txt")), false);
});

test("live (AE8): a two-task run whose builders use only the commands allowed for the run and edits in their copies reaches the end of its build with no approval created", { timeout: RUN_TIMEOUT }, async (t) => {
  const script = (word: string): string => `#!/bin/sh\necho ${word} > "$(dirname "$0")/${word}.txt"\n`;
  const live = await start(t, { "README.md": "# Sample\n", "make-one.sh": script("one"), "make-two.sh": script("two") }, []);
  const { runId, taskIds } = await approveAs(
    live,
    [
      { title: "Run the command `sh make-one.sh` once with your Bash tool and run no other command", criteria: ["one.txt exists and holds the word one"] },
      { title: "Run the command `sh make-two.sh` once with your Bash tool, then write the file notes.txt holding the word done with your Write tool; run no other command and read nothing", criteria: ["two.txt holds the word two", "notes.txt holds the word done"] },
    ],
    ["sh make-one.sh", "sh make-two.sh"],
    async (approval) => assert.fail(`a builder asked: ${String(approval.command)}`),
  );
  const end = await until(live, runId, (run) => run.status !== "running", async (approval) => assert.fail(`a builder asked: ${String(approval.command)}`));
  assert.equal(end.status, "awaiting_decision");
  const builderApprovals = live.server.db.prepare(`SELECT count(*) AS n FROM approvals WHERE task_id IN (${taskIds.join(", ")})`).get()!.n;
  assert.equal(builderApprovals, 0, "no approval was created for any builder");
  for (const [i, id] of taskIds.entries()) {
    const task = (await call(live, "GET", `/api/tasks/${id}`)).body;
    assert.equal(task.status, "awaiting_decision", String(task.reason));
    const word = i === 0 ? "one" : "two";
    assert.match(git(live.repo, "show", `${task.branch}:${word}.txt`), new RegExp(`^${word}\\n`));
    if (i === 1) assert.match(git(live.repo, "show", `${task.branch}:notes.txt`), /done/, "the edit in the copy is committed too");
    const log = (await call(live, "GET", `/api/action-log?taskId=${id}`)).body.entries as Body[];
    assert.ok(log.some((entry) => entry.rule === "preapproved" && entry.command === `sh make-${word}.sh`), JSON.stringify(log));
    assert.ok(log.every((entry) => entry.rule === "preapproved" || entry.rule === "auto_worktree_edit"), JSON.stringify(log));
  }
});
