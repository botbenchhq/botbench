import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import type { PlanTask } from "../../src/engine/roles.ts";
import { approvePlan, createRun, createRuns, getRun, storePlan, type Run, type Runs } from "../../src/engine/run.ts";
import { taskEvidence, type StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, moveTask, type Tasks } from "../../src/engine/task.ts";
import { openStore, schemaVersion } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { buildReplayDriver, type BuildReplay, type BuildTurn } from "../support/replay-build.ts";
import { initRepo, tempDir, write } from "../support/repo.ts";
import { V10_SCHEMA } from "../support/schema-v10.ts";
import { NO_SANDBOX, NO_SANDBOX_OR_PROCESS_LIST } from "../support/confined.ts";

// The verify station: after a task is built and Botbench has committed the work, the repository's check commands run in
// the task's worktree, each with a time limit, and each result is evidence on the task. No test here starts a CLI: each
// builder's turn is replayed from a real Claude Code session (test/support/replay-build.ts). The check commands are
// real commands, run by Botbench in the real worktree; a verify with Claude Code is in test/live/verify.live.test.ts.

type T = { after(fn: () => unknown): void };
const TWO: PlanTask[] = [
  { title: "Add a greeting file", criteria: ["hello.txt exists"] },
  { title: "Add a farewell file", criteria: ["bye.txt exists"] },
];
const cmd = (command: string, limitMs = 10_000): StationCommand => ({ command, limitMs });
// The replayed "done" turn changes no file, and a task whose branch holds no change fails before its checks
// (test/engine/no-change.test.ts): unless a test names its own setup commands, the repository's setup writes a file.
const SETUP_WRITES = cmd("printf 'hi\\n' > hello.txt");

interface Line {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
  broker: Broker;
  driver: BuildReplay;
  tasks: Tasks;
  runs: Runs;
  taskChanges: string[];
}

async function line(t: T, script: BuildTurn[], o: { setup?: StationCommand[]; checks?: StationCommand[]; files?: Record<string, string>; hold?: number[]; checkFixRounds?: number } = {}): Promise<Line> {
  const dir = tempDir("botbench-verify-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, o.files);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(script, { hold: o.hold ?? [] });
  const taskChanges: string[] = [];
  // No rounds of fixes for a failing check: this is the station itself (the loop is in check-fix.test.ts).
  const tasks = createTasks({ db, home, driver, broker, model: "haiku", checkFixRounds: o.checkFixRounds ?? 0, repoCommands: () => ({ setup: o.setup ?? [SETUP_WRITES], checks: o.checks ?? [] }), onEvent: () => {}, onTaskChange: (task) => taskChanges.push(`${task.id}:${task.status}`) });
  const runs = createRuns({ db, home, driver, broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo, base, broker, driver, tasks, runs, taskChanges };
}

function planned(e: Line, tasks: PlanTask[] = TWO): Run {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add two files", baseCommit: e.base });
  return storePlan(e.db, run.id, tasks);
}
const checks = (db: DatabaseSync, id: number) => taskEvidence(db, id).filter((row) => row.kind === "check");
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("after the build, each check command runs in the task's worktree and a passing and a failing check are each stored with their output and exit status; the task shows Checking while they run", { skip: NO_SANDBOX }, async (t) => {
  const failing = "echo two tests failed; echo expected 1 got 2 >&2; exit 2";
  const e = await line(t, ["done"], { setup: [cmd("echo built by setup > built.txt")], checks: [cmd("cat built.txt; pwd"), cmd(failing)] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.checks, "failed");
  const rows = checks(e.db, task.id);
  assert.deepEqual(rows.map((row) => [row.position, row.command, row.outcome, row.exitCode]), [[1, "cat built.txt; pwd", "passed", 0], [2, failing, "failed", 2]]);
  assert.equal(rows[0]!.output, `built by setup\n${task.worktreePath}\n`, "the check ran in the task's worktree, on the committed work");
  assert.match(rows[1]!.output, /two tests failed/);
  assert.match(rows[1]!.output, /expected 1 got 2/);
  for (const row of rows) assert.ok(row.durationMs >= 0 && row.limitMs === 10_000 && row.endedAt >= row.startedAt);
  // The checks ran after Botbench committed the work, while the task said Checking.
  const states = e.taskChanges.filter((change) => change.startsWith(`${task.id}:`)).map((change) => change.split(":")[1]);
  const verifying = states.indexOf("verifying");
  assert.ok(verifying > states.lastIndexOf("building") && verifying < states.indexOf("awaiting_decision"), states.join(" "));
  const events = e.db.prepare("SELECT status, detail FROM task_events WHERE task_id = ? ORDER BY id").all(task.id).map((r) => String(r.status));
  assert.deepEqual(events.slice(-2), ["verifying", "awaiting_decision"]);
});

test("every check passing marks the task as checks passed", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { checks: [cmd("true"), cmd("echo fine")] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.deepEqual([task.status, task.checks], ["awaiting_decision", "passed"]);
  assert.deepEqual(checks(e.db, task.id).map((row) => row.outcome), ["passed", "passed"]);
});

test("AE3: a failing check marks the task as checks failed, it still goes on to Ready for review, and the run still reaches its end", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done"], { checks: [cmd("echo the suite failed; exit 1")] });
  const run = planned(e);
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await e.tasks.idle();
  for (const made of tasks) {
    const task = getTask(e.db, made.id)!;
    assert.deepEqual([task.status, task.checks], ["awaiting_decision", "failed"]);
    assert.match(checks(e.db, task.id)[0]!.output, /the suite failed/);
  }
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_decision");
});

test("a repository with no check commands: the task says so as 'none', with no check evidence, and is never marked as passed", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"]);
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.deepEqual([task.status, task.checks], ["awaiting_decision", "none"]);
  assert.deepEqual(checks(e.db, task.id), []);
  assert.ok(!e.taskChanges.includes(`${task.id}:verifying`), "no Checking without checks");
});

test("a check that passes its time limit is killed with its child processes and recorded as timed out, and the task is checks failed", { skip: NO_SANDBOX_OR_PROCESS_LIST, timeout: 30_000 }, async (t) => {
  // A check may write only inside the task's copy (U27), so the child's number is left there.
  const e = await line(t, ["done"], { checks: [cmd("sh stall.sh child.pid", 1000), cmd("echo after the stalled one")], files: { "README.md": "# Sample\n", "stall.sh": 'sleep 300 &\necho $! > "$1"\nsleep 300\n' } });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  const pids = path.join(task.worktreePath!, "child.pid");
  assert.deepEqual([task.status, task.checks], ["awaiting_decision", "failed"]);
  const [stalled, after] = checks(e.db, task.id);
  assert.deepEqual([stalled!.outcome, stalled!.exitCode], ["timed_out", null]);
  assert.ok(stalled!.durationMs >= 1000 && stalled!.durationMs < 10_000);
  assert.equal(after!.outcome, "passed", "the checks after a timed-out one still run");
  const child = Number(fs.readFileSync(pids, "utf8"));
  await until("the stalled check's child is gone", () => !alive(child), 3000);
  assert.deepEqual(execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(pids)), []);
});

test("a check that edits the worktree does not change the committed work; nothing it leaves is committed", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { checks: [cmd("echo left by a check > check-output.txt")] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.equal(task.checks, "passed");
  // The one commit on the branch is Botbench's, of what setup wrote, made after the turn and before the checks.
  assert.equal(execFileSync("git", ["-C", e.repo, "rev-parse", `${task.headCommit}^`], { encoding: "utf8" }).trim(), task.baseCommit, "the commit is the one Botbench made after the turn, before the checks");
  assert.equal(execFileSync("git", ["-C", e.repo, "rev-parse", task.branch!], { encoding: "utf8" }).trim(), task.headCommit);
  assert.throws(() => execFileSync("git", ["-C", e.repo, "show", `${task.branch}:check-output.txt`], { stdio: "pipe" }), "what the check wrote is not on the branch");
  assert.ok(fs.existsSync(path.join(task.worktreePath!, "check-output.txt")), "it is left, uncommitted, in the copy");
});

test("cancelling a run while its checks run stops the check and records it as stopped; the task is cancelled with its work kept", { skip: NO_SANDBOX, timeout: 30_000 }, async (t) => {
  const e = await line(t, ["done", "done"], { checks: [cmd("sleep 30", 60_000)] });
  const run = planned(e);
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await until("checks are running", () => getTask(e.db, tasks[0]!.id)!.status === "verifying");
  await new Promise((resolve) => setTimeout(resolve, 200));
  e.runs.cancel(run.id);
  await e.tasks.idle();
  const first = getTask(e.db, tasks[0]!.id)!;
  assert.equal(first.status, "cancelled");
  assert.deepEqual(checks(e.db, first.id).map((row) => row.outcome), ["stopped"]);
  assert.notEqual(first.checks, "passed");
  assert.equal(getTask(e.db, tasks[1]!.id)!.status, "cancelled");
  assert.equal(e.driver.started.length, 1);
});

test("check evidence is append-only like setup evidence: a row cannot be changed, deleted or replaced", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { checks: [cmd("echo ok")] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const [row] = checks(e.db, started.id);
  assert.ok(row);
  assert.throws(() => e.db.prepare("UPDATE evidence SET outcome = 'failed' WHERE id = ?").run(row.id), /append-only/);
  assert.throws(() => e.db.prepare("DELETE FROM evidence WHERE id = ?").run(row.id), /append-only/);
  assert.throws(() => e.db.prepare("INSERT OR REPLACE INTO evidence (id, task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) SELECT id, task_id, kind, position, command, 'passed', 0, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms FROM evidence WHERE id = ?").run(row.id), /append-only/);
  // What the checks found is fixed on the task too, once written: it cannot be changed or cleared.
  assert.equal(getTask(e.db, started.id)!.checks, "passed");
  assert.throws(() => e.db.prepare("UPDATE tasks SET checks = 'failed' WHERE id = ?").run(started.id), /checks/);
  assert.throws(() => e.db.prepare("UPDATE tasks SET checks = NULL WHERE id = ?").run(started.id), /checks/);
});

test("after a restart, a task left at Checking has its checks run again once, as configured now, without committing what a check left, and its run goes on", { skip: NO_SANDBOX }, async (t) => {
  const dir = tempDir("botbench-verify-restart-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const run = storePlan(db, createRun(db, { repo, prompt: "two files", baseCommit: base }).id, TWO);
  const { tasks } = approvePlan(db, run.id, run.planVersion, "haiku");
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${tasks[0]!.id}`, commit: base });
  moveTask(db, tasks[0]!.id, "building", { worktree });
  moveTask(db, tasks[0]!.id, "verifying", { headCommit: base });
  write(worktree.path, "left-by-check.txt", "x\n");
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(["done"]);
  // The second task is built from the start, so its setup gives it a change; the first is past setup and only checked again.
  const engine = createTasks({ db, home, driver, broker, repoCommands: () => ({ setup: [SETUP_WRITES], checks: [] }), onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await engine.close();
    await broker.close();
  });
  await engine.idle();
  const first = getTask(db, tasks[0]!.id)!;
  // The checks are run again from the start, as the repository's settings list them now: here none.
  assert.equal(first.status, "awaiting_decision");
  assert.equal(first.checks, "none");
  assert.equal(first.headCommit, base);
  assert.throws(() => execFileSync("git", ["-C", repo, "show", `${first.branch}:left-by-check.txt`], { stdio: "pipe" }), "nothing a check left is committed at restart");
  assert.equal(getTask(db, tasks[1]!.id)!.status, "awaiting_decision");
  assert.equal(getRun(db, run.id)!.status, "awaiting_decision");
});

test("a database at the literal version 10 schema gains the check evidence and the task's checks mark, and keeps every row it had", (t) => {
  const dir = tempDir("botbench-verify-migrate-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const old = new DatabaseSync(path.join(home, "botbench.sqlite"));
  old.exec(V10_SCHEMA);
  old.exec("INSERT INTO runs (id, kind, repo_path, prompt, created_at, updated_at) VALUES (3, 'single', '/r', 'p', 't', 't')");
  old.exec("INSERT INTO tasks (id, run_id, repo_path, prompt, status, created_at, updated_at) VALUES (5, 3, '/r', 'p', 'failed', 't', 't')");
  old.exec("INSERT INTO evidence (id, task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) VALUES (8, 5, 'setup', 1, 'npm ci', 'failed', 1, NULL, 'npm ERR!', 0, 600000, 't1', 't2', 1200)");
  const before = old.prepare("SELECT * FROM evidence").all().map((r) => ({ ...r }));
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 11);
  // Every row is kept; unit 15 later numbers each as the first time its list was run, and #201 adds what a machine check needs (none here).
  assert.deepEqual(db.prepare("SELECT * FROM evidence").all().map((r) => ({ ...r })), before.map((r) => ({ ...r, round: 1, needs: null })));
  const task = getTask(db, 5)!;
  assert.deepEqual([task.status, task.checks], ["failed", null]);
  // The kept row is still append-only, and a check row can now be added.
  assert.throws(() => db.prepare("DELETE FROM evidence WHERE id = 8").run(), /append-only/);
  db.prepare("INSERT INTO evidence (task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) VALUES (5, 'check', 1, 'npm test', 'passed', 0, NULL, 'ok', 0, 600000, 't3', 't4', 10)").run();
  assert.deepEqual(taskEvidence(db, 5).map((row) => [row.id, row.kind]), [[8, "setup"], [9, "check"]]);
});
