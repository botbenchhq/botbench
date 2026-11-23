import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { taskPrompt, type PlanTask } from "../../src/engine/roles.ts";
import { approvePlan, createRun, createRuns, editPlan, getRun, RunError, storePlan, type Run, type Runs } from "../../src/engine/run.ts";
import { commandLists, DEFAULT_LIMIT_MS, runCommand, taskEvidence, type StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, moveTask, type Tasks } from "../../src/engine/task.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { migrate, openStore, schemaVersion } from "../../src/store/db.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { workbenchName } from "../../src/workbench.ts";
import { buildReplayDriver, type BuildReplay, type BuildTurn } from "../support/replay-build.ts";
import { checkoutState, git, initRepo, ownerCommit, botbenchBranches, tempDir, worktreeCount, write } from "../support/repo.ts";
import { NO_SANDBOX, NO_SANDBOX_OR_PROCESS_LIST } from "../support/confined.ts";

// The build line: a run's approved tasks are built one at a time, in plan order, each in its own worktree from the
// run's base commit, after the repository's setup commands. No test in this file starts a CLI: each builder's turn is a
// turn recorded from a real Claude Code session, replayed (test/support/replay-build.ts). Setup commands are real
// commands run by Botbench in the real worktree; the live build is in test/live/build.live.test.ts.

type T = { after(fn: () => unknown): void };

const THREE: PlanTask[] = [
  { title: "Add a greeting file", criteria: ["hello.txt exists"] },
  { title: "Add a farewell file", criteria: ["bye.txt exists"] },
  { title: "Describe both files", criteria: ["README.md names both"] },
];
const SETUP_WRITES: StationCommand = { command: "echo built by setup > setup-output.txt", limitMs: 10_000 };
// The replayed "done" turn changes no file, and a task whose branch holds no change fails (test/engine/no-change.test.ts):
// unless a test names its own setup commands, the repository's setup writes a file, so each task has work to hand over.
const DEFAULT_SETUP: StationCommand[] = [SETUP_WRITES];

interface Line {
  db: DatabaseSync;
  dir: string;
  home: string;
  repo: string;
  base: string;
  broker: Broker;
  driver: BuildReplay;
  tasks: Tasks;
  runs: Runs;
  runChanges: string[];
  taskChanges: string[];
}

async function line(t: T, script: BuildTurn[], o: { hold?: number[]; setup?: StationCommand[]; files?: Record<string, string>; hosts?: string[] } = {}): Promise<Line> {
  const dir = tempDir("botbench-build-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, o.files);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(script, { hold: o.hold ?? [] });
  const runChanges: string[] = [];
  const taskChanges: string[] = [];
  const tasks = createTasks({ db, home, driver, broker, model: "haiku", repoCommands: () => ({ setup: o.setup ?? DEFAULT_SETUP, checks: [] }), repoHosts: () => o.hosts ?? [], onEvent: () => {}, onTaskChange: (task) => taskChanges.push(`${task.id}:${task.status}`), onRunChange: (run) => runChanges.push(`${run.id}:${run.status}`) });
  const runs = createRuns({ db, home, driver, broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: (run) => runChanges.push(`${run.id}:${run.status}`), onTaskChange: () => {} });
  // Everything is stopped before the folder goes, so nothing still at work writes into it afterwards.
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, home, repo, base, broker, driver, tasks, runs, runChanges, taskChanges };
}

/** A run waiting for the owner with `tasks` as its plan, as the planner leaves one. */
function planned(e: Line, tasks: PlanTask[] = THREE): Run {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add two files and describe them", baseCommit: e.base, preapproved: ["npm test"] });
  return storePlan(e.db, run.id, tasks);
}
const taskWorktree = (e: Line, runId: number, taskId: number): string => path.join(e.home, "worktrees", `run-${runId}`, `task-${taskId}`);
const taskEvents = (db: DatabaseSync, id: number) => db.prepare("SELECT id, status, detail FROM task_events WHERE task_id = ? ORDER BY id").all(id).map((r) => ({ id: Number(r.id), status: String(r.status), detail: r.detail === null ? null : String(r.detail) }));
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

test("AE1: deleting one of three planned tasks and approving creates exactly two task worktrees, from the run's base commit, built in plan order; the run is then ready for review", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done"]);
  const run = planned(e);
  const edited = editPlan(e.db, run.id, [THREE[0], THREE[2]], run.planVersion);
  // The owner works on after the plan was made: the tasks are built from the commit the plan was made from all the same.
  write(e.repo, "later.txt", "the owner's later work\n");
  ownerCommit(e.repo, "later work");
  const before = checkoutState(e.repo);

  const { tasks } = e.runs.approve(run.id, edited.planVersion);
  assert.equal(tasks.length, 2);
  await e.tasks.idle();

  assert.equal(worktreeCount(e.repo), 3, "the owner's checkout and exactly two task worktrees");
  assert.deepEqual(botbenchBranches(e.repo), tasks.map((task) => `botbench/${workbenchName(e.db)}/run-${run.id}/task-${task.id}`));
  for (const [i, made] of tasks.entries()) {
    const built = getTask(e.db, made.id)!;
    assert.equal(built.status, "awaiting_decision", `task ${i + 1}: ${built.reason}`);
    assert.equal(built.baseCommit, e.base);
    assert.equal(built.worktreePath, taskWorktree(e, run.id, made.id));
    // The one commit on the branch is Botbench's, of what setup wrote; it sits on the run's base commit.
    assert.equal(git(built.worktreePath!, "rev-parse", "HEAD^").trim(), e.base);
    assert.equal(fs.existsSync(path.join(built.worktreePath!, "later.txt")), false);
  }
  // Each builder was started in its own worktree, able to edit there, through the gate, on the run's model, with the plan item as its prompt.
  assert.equal(e.driver.started.length, 2);
  for (const [i, started] of e.driver.started.entries()) {
    assert.equal(started.cwd, taskWorktree(e, run.id, tasks[i]!.id));
    assert.equal(started.allowEdits, true);
    assert.notEqual(started.readOnly, true);
    assert.equal(started.model, "haiku");
    assert.ok(started.gate && started.gate.socketPath === e.broker.socketPath);
  }
  assert.deepEqual(e.driver.prompts, [taskPrompt(THREE[0]!), taskPrompt(THREE[2]!)]);
  assert.equal(e.driver.open(), 0, "no builder session is left open");
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_decision");
  assert.equal(e.runChanges.at(-1), `${run.id}:awaiting_decision`);
  assert.deepEqual(checkoutState(e.repo), before, "the owner's checkout is untouched");
});

test("tasks build strictly one after another: the second task's worktree does not exist until the first has finished", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done"], { hold: [0] });
  const run = planned(e, THREE.slice(0, 2));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await e.driver.held(0);
  const [first, second] = tasks.map((task) => task.id) as [number, number];
  assert.equal(getTask(e.db, first)!.status, "building");
  assert.equal(getTask(e.db, second)!.status, "queued");
  assert.equal(getTask(e.db, second)!.worktreePath, null);
  assert.equal(fs.existsSync(taskWorktree(e, run.id, second)), false);
  assert.equal(worktreeCount(e.repo), 2);
  assert.equal(e.driver.started.length, 1);
  assert.equal(getRun(e.db, run.id)!.status, "running");

  e.driver.release(0);
  await e.tasks.idle();
  const firstEnd = taskEvents(e.db, first).find((event) => event.status === "awaiting_decision")!;
  const secondStart = taskEvents(e.db, second).find((event) => event.status === "building")!;
  assert.ok(firstEnd.id < secondStart.id, "the second task started only after the first was finished");
  assert.deepEqual([first, second].map((id) => getTask(e.db, id)!.status), ["awaiting_decision", "awaiting_decision"]);
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_decision");
});

test("the tasks of a run are built on the run's build model, not on the configured one: the builder's attempt is started with it", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"]);
  const run = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, requestedModel: "opus", buildModel: "sonnet" }).id, THREE.slice(0, 1));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await e.tasks.idle();
  assert.equal(getTask(e.db, tasks[0]!.id)!.status, "awaiting_decision", getTask(e.db, tasks[0]!.id)!.reason ?? "");
  assert.deepEqual(e.driver.started.map((started) => started.model), ["sonnet"], "the line's configured model is haiku; the run asked for sonnet");
});

test("a failing setup command fails its task with the reason and its output before any agent turn starts, the commands after it do not run, and the run goes on with the next task", { skip: NO_SANDBOX }, async (t) => {
  const failing = "echo preparing the copy; echo it broke >&2; exit 3";
  const e = await line(t, ["done", "done"], { setup: [{ command: "echo first step", limitMs: 10_000 }, { command: failing, limitMs: 10_000 }, { command: "echo never runs > never.txt", limitMs: 10_000 }] });
  const run = planned(e, THREE.slice(0, 2));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await e.tasks.idle();

  for (const made of tasks) {
    const failed = getTask(e.db, made.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.reason!, /setup command/i);
    assert.match(failed.reason!, /exit code 3/);
    assert.equal(failed.attemptId, null, "no agent was started for it");
    const evidence = taskEvidence(e.db, made.id);
    assert.deepEqual(evidence.map((row) => [row.kind, row.position, row.command, row.outcome, row.exitCode]), [["setup", 1, "echo first step", "passed", 0], ["setup", 2, failing, "failed", 3]]);
    assert.match(evidence[0]!.output, /first step/);
    assert.match(evidence[1]!.output, /preparing the copy/);
    assert.match(evidence[1]!.output, /it broke/);
    assert.equal(evidence[1]!.truncated, false);
    assert.ok(evidence[1]!.durationMs >= 0 && evidence[1]!.limitMs === 10_000);
    assert.equal(fs.existsSync(path.join(failed.worktreePath!, "never.txt")), false, "the command after the failing one did not run");
  }
  assert.equal(e.driver.started.length, 0, "no agent turn started for either task");
  assert.equal(Number(e.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n), 0);
  // Changed in unit 16: this test pinned "awaiting_decision" here, a run waiting for a decision when no task was ready
  // for review. With every task failed there is nothing to decide, so the run went on past the failed task and ended.
  assert.equal(getRun(e.db, run.id)!.status, "done", "the run went on past the failed task and reached its end: done, with nothing to review");
  assert.deepEqual(e.runChanges.at(-1), `${run.id}:done`);
});

test("how many setup commands a round holds is recorded before the first runs, so a count shown while the third waits is out of three", { skip: NO_SANDBOX, timeout: 30_000 }, async (t) => {
  const waits = "while [ ! -f go ]; do sleep 0.05; done; echo third";
  const e = await line(t, ["done"], { setup: [{ command: "echo first", limitMs: 10_000 }, { command: waits, limitMs: 20_000 }, { command: "echo third", limitMs: 10_000 }] });
  const run = planned(e, THREE.slice(0, 1));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  const id = tasks[0]!.id;
  await until("the second setup command is running", () => taskEvidence(e.db, id).length === 1 && getTask(e.db, id)!.worktreePath !== null);
  assert.deepEqual(commandLists(e.db, id), [{ kind: "setup", round: 1, total: 3 }], "the whole list is known while its second command runs");
  fs.writeFileSync(path.join(getTask(e.db, id)!.worktreePath!, "go"), "");
  await e.tasks.idle();
  assert.equal(taskEvidence(e.db, id).filter((row) => row.kind === "setup").length, 3);
  assert.deepEqual(commandLists(e.db, id), [{ kind: "setup", round: 1, total: 3 }]);
});

test("a setup command that passes its time limit is killed with its child processes and recorded as timed out; a stand-alone task runs setup commands too", { skip: NO_SANDBOX_OR_PROCESS_LIST, timeout: 30_000 }, async (t) => {
  // A setup command may write only inside the task's copy (U27), so the child's number is left there.
  const stall = 'sleep 300 &\necho $! > "$1"\nsleep 300\n';
  const e = await line(t, ["done"], { setup: [{ command: "sh stall.sh child.pid", limitMs: 1000 }], files: { "README.md": "# Sample\n", "stall.sh": stall } });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();

  const failed = getTask(e.db, started.id)!;
  const pids = path.join(failed.worktreePath!, "child.pid");
  assert.equal(failed.status, "failed");
  assert.match(failed.reason!, /did not finish within 1 second/);
  const [evidence] = taskEvidence(e.db, started.id);
  assert.equal(evidence!.outcome, "timed_out");
  assert.equal(evidence!.exitCode, null);
  assert.ok(evidence!.durationMs >= 1000 && evidence!.durationMs < 10_000, String(evidence!.durationMs));
  const child = Number(fs.readFileSync(pids, "utf8"));
  assert.ok(child > 0);
  // Killed at once; the system takes a moment to clear a killed process away.
  await until("the background child of the setup command was killed with it", () => !alive(child), 3000);
  const left = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(pids));
  assert.deepEqual(left, [], "nothing of the setup command is left running");
  assert.equal(e.driver.started.length, 0);
});

test("a stand-alone task's setup output is evidence on it, and what setup wrote is committed by Botbench with the agent's work", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { setup: [SETUP_WRITES] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const built = getTask(e.db, started.id)!;
  assert.equal(built.status, "awaiting_decision", built.reason ?? "");
  assert.deepEqual(taskEvidence(e.db, started.id).map((row) => [row.position, row.command, row.outcome, row.exitCode]), [[1, SETUP_WRITES.command, "passed", 0]]);
  assert.equal(git(e.repo, "show", `${built.branch}:setup-output.txt`), "built by setup\n");
  assert.equal(built.worktreePath, taskWorktree(e, built.runId!, built.id), "a task of its own is under its own run's folder");
});

test("cancelling a running run stops the active turn, commits what it had, keeps the finished task's branch, marks the unstarted task cancelled, and ends the run as cancelled", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done", "done"], { hold: [1], setup: [SETUP_WRITES] });
  const run = planned(e);
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  const [first, second, third] = tasks.map((task) => task.id) as [number, number, number];
  await e.driver.held(1);
  assert.equal(getTask(e.db, first)!.status, "awaiting_decision");

  const cancelled = e.runs.cancel(run.id);
  assert.equal(cancelled.status, "cancelled");
  // The unstarted task is cancelled at once, in the same write as the run.
  assert.equal(getTask(e.db, third)!.status, "cancelled");
  await e.tasks.idle();

  const done = getTask(e.db, first)!;
  assert.equal(done.status, "awaiting_decision");
  assert.equal(git(e.repo, "show", `${done.branch}:setup-output.txt`), "built by setup\n", "the finished task's branch is kept");
  const stopped = getTask(e.db, second)!;
  assert.equal(stopped.status, "cancelled");
  assert.match(stopped.reason!, /cancelled/);
  const ends = e.db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'turn_ended'").all(stopped.attemptId).map((row) => JSON.parse(String(row.payload)).reason);
  assert.deepEqual(ends, ["interrupted"], "the active turn was stopped");
  assert.equal(git(e.repo, "show", `${stopped.branch}:setup-output.txt`), "built by setup\n", "what the stopped task had is committed to its branch");
  const unstarted = getTask(e.db, third)!;
  assert.deepEqual([unstarted.worktreePath, unstarted.branch, unstarted.attemptId], [null, null, null]);
  assert.match(unstarted.reason!, /cancelled/);
  assert.equal(e.driver.started.length, 2, "the third task was never started");
  assert.equal(e.driver.open(), 0);
  assert.equal(getRun(e.db, run.id)!.status, "cancelled", "a cancelled run does not become ready for review");
  assert.throws(() => e.runs.cancel(run.id), (err) => err instanceof RunError && err.status === 409);
  assert.equal(worktreeCount(e.repo), 3, "both started tasks keep their worktrees; the third has none");
});

test("cancelling while setup runs kills the setup command and builds nothing more", { skip: NO_SANDBOX, timeout: 30_000 }, async (t) => {
  const e = await line(t, ["done"], { setup: [{ command: "sleep 30", limitMs: 60_000 }] });
  const run = planned(e, THREE.slice(0, 2));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await until("setup is running", () => getTask(e.db, tasks[0]!.id)!.status === "building");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const at = Date.now();
  e.runs.cancel(run.id);
  await e.tasks.idle();
  assert.ok(Date.now() - at < 10_000, "the setup command did not run to its end");
  assert.deepEqual(tasks.map((task) => getTask(e.db, task.id)!.status), ["cancelled", "cancelled"]);
  assert.deepEqual(taskEvidence(e.db, tasks[0]!.id).map((row) => row.outcome), ["stopped"]);
  assert.equal(e.driver.started.length, 0);
});

test("an approval pending in task 1 keeps task 2 queued, with no worktree, until the owner answers", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["ask", "done"]);
  const run = planned(e, THREE.slice(0, 2));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  const [first, second] = tasks.map((task) => task.id) as [number, number];
  await until("a request waits for the owner", () => e.broker.pending().length === 1);
  const [asking] = e.broker.pending();
  assert.deepEqual([asking!.taskId, asking!.role, asking!.command], [first, "implementer", "sh other.sh"]);
  // Well after the request: nothing moved on.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(getTask(e.db, second)!.status, "queued");
  assert.equal(fs.existsSync(taskWorktree(e, run.id, second)), false);
  assert.equal(e.driver.started.length, 1);

  e.broker.answer(asking!.id, "allow");
  await e.tasks.idle();
  assert.deepEqual([first, second].map((id) => getTask(e.db, id)!.status), ["awaiting_decision", "awaiting_decision"]);
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_decision");
});

test("cancelling a run while its task waits for an answer closes the pending approval and builds nothing more", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["ask", "done"]);
  const run = planned(e, THREE.slice(0, 2));
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await until("a request waits for the owner", () => e.broker.pending().length === 1);
  e.runs.cancel(run.id);
  await e.tasks.idle();
  assert.deepEqual(listApprovals(e.db, "pending"), []);
  assert.deepEqual(listApprovals(e.db).map((approval) => approval.status), ["superseded"]);
  assert.deepEqual(tasks.map((task) => getTask(e.db, task.id)!.status), ["cancelled", "cancelled"]);
  assert.equal(e.driver.started.length, 1);
  assert.equal(getRun(e.db, run.id)!.status, "cancelled");
});

test("after a restart, a running run's task that was being prepared, before any agent turn, is started again once, and its unstarted tasks are built after it in order; the run reaches its end", { skip: NO_SANDBOX }, async (t) => {
  const dir = tempDir("botbench-build-restart-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const run = storePlan(db, createRun(db, { repo, prompt: "three files", baseCommit: base }).id, THREE);
  const { tasks } = approvePlan(db, run.id, run.planVersion, "haiku");
  // What a Botbench that stopped mid-build leaves: the first task building in its worktree, with a file half-written.
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${tasks[0]!.id}` });
  moveTask(db, tasks[0]!.id, "building", { worktree });
  write(worktree.path, "partial.txt", "written before the stop\n");

  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(["done", "done", "done"]);
  const engine = createTasks({ db, home, driver, broker, repoCommands: () => ({ setup: DEFAULT_SETUP, checks: [] }), onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await engine.close();
    await broker.close();
  });
  await engine.idle();
  const after = tasks.map((task) => getTask(db, task.id)!);
  assert.deepEqual(after.map((task) => task.status), ["awaiting_decision", "awaiting_decision", "awaiting_decision"]);
  assert.equal(git(repo, "show", `${after[0]!.branch}:partial.txt`), "written before the stop\n");
  assert.equal(driver.started.length, 3, "the task that never reached its agent is started once, then the others");
  assert.deepEqual(driver.started.map((s) => s.cwd), after.map((task) => task.worktreePath));
  assert.equal(driver.prompts[0], taskPrompt(THREE[0]!), "with its own prompt: no agent had started on it");
  assert.equal(getRun(db, run.id)!.status, "awaiting_decision");
});

test("setup evidence is append-only: a row cannot be changed, deleted or replaced", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { setup: [{ command: "echo ready", limitMs: 10_000 }] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const [row] = taskEvidence(e.db, started.id);
  assert.ok(row);
  assert.throws(() => e.db.prepare("UPDATE evidence SET outcome = 'failed' WHERE id = ?").run(row.id), /append-only/);
  assert.throws(() => e.db.prepare("UPDATE evidence SET output = 'nothing' WHERE id = ?").run(row.id), /append-only/);
  assert.throws(() => e.db.prepare("DELETE FROM evidence WHERE id = ?").run(row.id), /append-only/);
  assert.throws(
    () => e.db.prepare("INSERT OR REPLACE INTO evidence (id, task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) SELECT id, task_id, kind, position, command, 'failed', 1, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms FROM evidence WHERE id = ?").run(row.id),
    /append-only/,
  );
  assert.deepEqual(taskEvidence(e.db, started.id), [row]);
});

test("a database at the previous schema version gains the evidence table and keeps its runs and tasks", (t) => {
  const dir = tempDir("botbench-build-migrate-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const old = new DatabaseSync(path.join(home, "botbench.sqlite"));
  migrate(old, MIGRATIONS.slice(0, 9));
  assert.equal(schemaVersion(old), 9);
  old.exec("INSERT INTO runs (id, kind, repo_path, prompt, created_at, updated_at) VALUES (4, 'single', '/r', 'p', 't', 't')");
  old.exec("INSERT INTO tasks (id, run_id, repo_path, prompt, status, created_at, updated_at) VALUES (7, 4, '/r', 'p', 'awaiting_decision', 't', 't')");
  old.close();
  const db = openStore(home);
  t.after(() => db.close());
  assert.ok(schemaVersion(db) >= 10);
  assert.equal(getTask(db, 7)!.status, "awaiting_decision");
  assert.deepEqual(taskEvidence(db, 7), []);
});

test("Botbench runs an owner's command in a directory with a time limit, in its own process group, without the caller's git variables, and keeps the end of a long output", { skip: NO_SANDBOX, timeout: 30_000 }, async (t) => {
  const dir = tempDir("botbench-command-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = "/somewhere/else";
  t.after(() => (before === undefined ? delete process.env.GIT_DIR : (process.env.GIT_DIR = before)));

  const confinement = { dataDir: tempDir("botbench-command-home-"), allowedHosts: [] };
  t.after(() => fs.rmSync(confinement.dataDir, { recursive: true, force: true }));
  const passed = await runCommand({ command: 'pwd; echo "git dir: ${GIT_DIR:-none}"', cwd: dir, limitMs: 10_000, confinement });
  assert.equal(passed.outcome, "passed");
  assert.equal(passed.exitCode, 0);
  assert.match(passed.output, new RegExp(`^${dir}\\ngit dir: none\\n$`));

  const failed = await runCommand({ command: "echo out; echo err >&2; exit 7", cwd: dir, limitMs: 10_000, confinement });
  assert.deepEqual([failed.outcome, failed.exitCode, failed.signal], ["failed", 7, null]);
  assert.match(failed.output, /out/);
  assert.match(failed.output, /err/);

  const long = await runCommand({ command: "i=0; while [ $i -lt 30000 ]; do echo line $i; i=$((i+1)); done; echo the last line", cwd: dir, limitMs: 20_000, confinement });
  assert.equal(long.outcome, "passed");
  assert.equal(long.truncated, true);
  assert.match(long.output, /the last line\n$/, "the end of the output is kept");
  assert.ok(long.output.length <= 210_000);

  // A program that leaves a child behind when it ends does not leave it running.
  const pidFile = path.join(dir, "bg.pid");
  const leftBehind = await runCommand({ command: `sleep 300 > /dev/null 2>&1 & echo $! > ${pidFile}`, cwd: dir, limitMs: 10_000, confinement });
  assert.equal(leftBehind.outcome, "passed");
  await until("the left-behind child is gone", () => !alive(Number(fs.readFileSync(pidFile, "utf8"))), 3000);

  const abort = new AbortController();
  const stopping = runCommand({ command: "sleep 30", cwd: dir, limitMs: 60_000, signal: abort.signal, confinement });
  setTimeout(() => abort.abort(), 100);
  const stopped = await stopping;
  assert.equal(stopped.outcome, "stopped");
  assert.ok(stopped.durationMs < 5000);
  assert.equal(DEFAULT_LIMIT_MS, 600_000);
});

// Found by the critique pass, each first seen failing.

/** A Botbench home in which a run's first task waited for the owner's answer when Botbench stopped: parked at building, with its worktree and a session to resume. */
async function parkedRun(t: T): Promise<{ db: DatabaseSync; home: string; repo: string; run: Run; taskIds: number[]; worktree: string; approvalId: number }> {
  const dir = tempDir("botbench-build-parked-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const run = storePlan(db, createRun(db, { repo, prompt: "two files", baseCommit: base }).id, THREE.slice(0, 2));
  const { tasks } = approvePlan(db, run.id, run.planVersion, "haiku");
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${tasks[0]!.id}`, commit: base });
  const at = new Date().toISOString();
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', 'haiku', 'a-session', 'interrupted', NULL, ?, ?)").run(at, at).lastInsertRowid);
  moveTask(db, tasks[0]!.id, "building", { worktree, attemptId });
  const approvalId = Number(db.prepare("INSERT INTO approvals (task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (?, ?, 'implementer', 'Bash', 'sh other.sh', '.', NULL, 'toolu_parked', 'pending', ?)").run(tasks[0]!.id, attemptId, at).lastInsertRowid);
  db.prepare("UPDATE approvals SET parked_at = ? WHERE id = ?").run(at, approvalId);
  return { db, home, repo, run, taskIds: tasks.map((task) => task.id), worktree: worktree.path, approvalId };
}

async function engineOn(t: T, p: { db: DatabaseSync; home: string }, script: BuildTurn[]): Promise<{ broker: Broker; driver: BuildReplay; tasks: Tasks; runs: Runs }> {
  const broker = createBroker({ db: p.db, home: p.home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(script);
  const tasks = createTasks({ db: p.db, home: p.home, driver, broker, repoCommands: () => ({ setup: DEFAULT_SETUP, checks: [] }), onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db: p.db, home: p.home, driver, broker, line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
  });
  await tasks.idle();
  return { broker, driver, tasks, runs };
}

test("critique: cancelling a run whose task is parked on an answer across a restart ends that task as cancelled, with its work committed, and closes the request", async (t) => {
  const p = await parkedRun(t);
  write(p.worktree, "partial.txt", "written before the stop\n");
  const e = await engineOn(t, p, ["done"]);
  assert.equal(getTask(p.db, p.taskIds[0]!)!.status, "building", "parked: it waits for the answer");
  assert.equal(getTask(p.db, p.taskIds[1]!)!.status, "queued", "and holds up the task after it");
  e.runs.cancel(p.run.id);
  await e.tasks.idle();
  const first = getTask(p.db, p.taskIds[0]!)!;
  assert.equal(first.status, "cancelled");
  assert.equal(git(p.repo, "show", `${first.branch}:partial.txt`), "written before the stop\n");
  assert.equal(getTask(p.db, p.taskIds[1]!)!.status, "cancelled");
  assert.deepEqual(listApprovals(p.db).map((approval) => approval.status), ["superseded"]);
  assert.equal(e.driver.started.length, 0);
});

test("critique: when a parked task cannot be resumed after the owner answers, its run still goes on with the tasks after it and reaches its end", { skip: NO_SANDBOX }, async (t) => {
  const p = await parkedRun(t);
  const e = await engineOn(t, p, ["done"]);
  assert.equal(getTask(p.db, p.taskIds[0]!)!.status, "building");
  // Its copy is gone by the time the answer comes, so it cannot be resumed.
  fs.rmSync(p.worktree, { recursive: true, force: true });
  e.broker.answer(p.approvalId, "allow");
  await until("the run reaches its end", () => getRun(p.db, p.run.id)!.status === "awaiting_decision");
  await e.tasks.idle();
  assert.notEqual(getTask(p.db, p.taskIds[0]!)!.status, "building");
  assert.equal(getTask(p.db, p.taskIds[1]!)!.status, "awaiting_decision");
});

test("critique: a command that ends by itself is recorded as it ended, even when its time limit or a stop comes while its output is still being read", { skip: NO_SANDBOX }, async (t) => {
  const dir = tempDir("botbench-command-race-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // It exits at once and leaves a child outside its group holding its output open, so Botbench is still reading when the limit passes.
  const abort = new AbortController();
  const ran = runCommand({ command: "perl -MPOSIX -e 'setsid(); sleep 3' & sleep 0.2; exit 0", cwd: dir, limitMs: 400, signal: abort.signal, confinement: { dataDir: path.join(dir, "no-home"), allowedHosts: [] } });
  setTimeout(() => abort.abort(), 600);
  const result = await ran;
  assert.deepEqual([result.outcome, result.exitCode], ["passed", 0]);
});

test("a task's setup commands run confined: one that reads Botbench's data folder is refused and fails its task before any agent starts, and the repository's allowed hosts reach them through Botbench's proxy", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { setup: [{ command: 'echo "proxy=${HTTPS_PROXY:-none}"', limitMs: 10_000 }, { command: "cat ../../../botbench.sqlite", limitMs: 10_000 }], hosts: ["registry.npmjs.org"] });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const failed = getTask(e.db, started.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(path.dirname(path.dirname(path.dirname(failed.worktreePath!))), e.home, "the copy is three folders below the data folder");
  const [proxy, store] = taskEvidence(e.db, started.id);
  assert.match(proxy!.output, /^proxy=http:\/\/127\.0\.0\.1:\d+$/m);
  assert.equal(store!.outcome, "failed");
  assert.match(store!.output, /Operation not permitted/);
  assert.equal(e.driver.started.length, 0);
});
