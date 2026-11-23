import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import type { Driver } from "../../src/drivers/contract.ts";
import { killProcessGroup, processGroupAlive } from "../../src/drivers/launch.ts";
import { CONTINUE_PROMPT, stopRecordedGroup } from "../../src/engine/recover.ts";
import { createRuns, getRun, planTasks, type Runs } from "../../src/engine/run.ts";
import { taskEvidence } from "../../src/engine/stations.ts";
import { createTasks, getTask, TaskError, type Tasks } from "../../src/engine/task.ts";
import { DB_FILE, openStore } from "../../src/store/db.ts";
import type { Left, Order } from "../support/leave-running.ts";
import { buildReplayDriver, type BuildReplay, type BuildTurn } from "../support/replay-build.ts";
import { loadPlanRecording, planReplayDriver, THREE_TASKS, type PlanReplay } from "../support/replay-plan.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// Restart recovery (unit 15). Every Botbench that "stops" here is a real process running the real engine on a real store,
// killed with SIGKILL where it stands (test/support/leave-running.ts); the next start is a new engine over the same data
// folder. The processes left behind are real: the setup and check commands Botbench started itself, run confined in
// their own process groups, and a real process group recorded as a CLI's. No test here starts a CLI: an agent's turn is a
// session recorded from the real Claude Code, replayed through the driver contract (test/support/replay-build.ts), the
// one exception the owner approved. The same with the real CLI is test/live/recover.live.test.ts.

type T = { after(fn: () => unknown): void };
const SCRIPT = path.resolve(import.meta.dirname, "..", "support", "leave-running.ts");
/** The resume cursor the real CLI announced in the recorded turn the replay plays. */
const CURSOR = (loadPlanRecording().turns[0]!.events.find((event) => event.type === "session_started") as { resumeCursor: string }).resumeCursor;
const PROMPT = "Create hello.txt with the word hello.";
/**
 * A setup command that writes a file. The replayed "done" turn changes no file, and a task whose branch then holds no
 * change fails (test/engine/no-change.test.ts); a test whose task must reach review without the agent having written a
 * file before the stop has this as its setup.
 */
const WRITES = "printf 'hi\\n' > hello.txt";

interface Place {
  dir: string;
  home: string;
  repo: string;
  /** A file that, once it exists, lets the commands below that wait for it end at once. */
  go: string;
}

function place(t: T): Place {
  const dir = tempDir("botbench-recover-");
  const home = path.join(dir, "home");
  // Whatever a Botbench left running here is stopped after the test, whatever the test found, and only once it is
  // known to be the one recorded (the check the next start makes), then the folder goes.
  t.after(async () => {
    if (fs.existsSync(path.join(home, DB_FILE))) {
      const db = openStore(home);
      const groups = db.prepare("SELECT pgid, spawned_at AS at FROM command_processes WHERE pgid IS NOT NULL UNION ALL SELECT pgid, created_at AS at FROM attempts WHERE pgid IS NOT NULL").all();
      db.close();
      await Promise.all(groups.map((row) => stopRecordedGroup(Number(row.pgid), typeof row.at === "string" ? row.at : null).catch(() => {})));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, "repo");
  initRepo(repo);
  return { dir, home, repo, go: path.join(dir, "go") };
}

/** A command that says it has begun, then runs for half a minute unless the place's go file exists. */
const waits = (p: Place): string => `echo begun > begun.txt; test -f ${p.go} && exit 0; sleep 30`;

/** Run a Botbench to the point `order` names and kill it there. */
function leave(t: T, p: Place, order: Omit<Order, "home" | "repo">): Left {
  const run = spawnSync(process.execPath, [SCRIPT, JSON.stringify({ home: p.home, repo: p.repo, ...order })], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.signal, "SIGKILL", `the Botbench that stops is killed where it stands: ${run.stderr}`);
  const left = JSON.parse(run.stdout) as Left;
  // The process the test started itself as a CLI that outlived its Botbench.
  if (left.survivor !== null) t.after(() => killProcessGroup(left.survivor!).catch(() => {}));
  return left;
}

interface Started {
  db: DatabaseSync;
  broker: Broker;
  tasks: Tasks;
  runs: Runs;
  close(): Promise<void>;
}

/** The next start on the same data folder: the store opened again, a new broker, and the engine, which recovers. */
async function startAgain(t: T, p: Place, o: { driver?: Driver; planner?: PlanReplay; setup?: string[]; checks?: string[] } = {}): Promise<Started> {
  const db = openStore(p.home);
  const broker = createBroker({ db, home: p.home, onChange: () => {} });
  await broker.listen();
  const driver = o.driver ?? buildReplayDriver([]);
  const repoCommands = () => ({ setup: (o.setup ?? []).map((command) => ({ command, limitMs: 60_000 })), checks: (o.checks ?? []).map((command) => ({ command, limitMs: 60_000 })) });
  const tasks = createTasks({ db, home: p.home, driver, broker, model: "haiku", repoCommands, onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home: p.home, driver: o.planner ?? driver, broker, line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
  };
  t.after(close);
  await runs.idle();
  await tasks.idle();
  return { db, broker, tasks, runs, close };
}

/** A replay driver that also notes, as each attempt starts, whether a process group is still running then. */
function watching(script: BuildTurn[], group: () => number | null): BuildReplay & { aliveAtStart: boolean[] } {
  const inner = buildReplayDriver(script);
  const aliveAtStart: boolean[] = [];
  return Object.assign(Object.create(inner) as BuildReplay, {
    aliveAtStart,
    startAttempt: (options: Parameters<Driver["startAttempt"]>[0]) => {
      const pgid = group();
      aliveAtStart.push(pgid !== null && processGroupAlive(pgid));
      return inner.startAttempt(options);
    },
    started: inner.started,
    prompts: inner.prompts,
  });
}

const row = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => ({ ...db.prepare(sql).get(...args) });
const restarts = (db: DatabaseSync, taskId: number): number => Number(db.prepare("SELECT restarts FROM tasks WHERE id = ?").get(taskId)!.restarts);
const lastNote = (db: DatabaseSync, taskId: number): string => String(db.prepare("SELECT detail FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId)!.detail ?? "");
const notes = (db: DatabaseSync, taskId: number): string => db.prepare("SELECT status, detail FROM task_events WHERE task_id = ? ORDER BY id").all(taskId).map((r) => `${r.status}: ${r.detail ?? ""}`).join("\n");
const evidenceOf = (db: DatabaseSync, taskId: number) => taskEvidence(db, taskId).map((e) => [e.kind, e.round, e.position, e.outcome]);
async function until(what: string, done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a restart mid-run: the finished task is not built again, a run waiting for plan approval still waits with its plan, the task that was mid-turn is re-driven once from its resume cursor, and the run goes on with its queued task after it", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { run: ["First", "Second", "Third"], waitingRun: ["Waiting one", "Waiting two"], setup: [WRITES], script: ["done", "done"], hold: 1, holdAt: "session", stopAt: "turn" });
  const [waitingId, runId] = s.runIds as [number, number];
  const [first, second, third] = s.taskIds as [number, number, number];

  const driver = buildReplayDriver(["done", "done"]);
  const again = await startAgain(t, p, { driver, setup: [WRITES] });
  // The finished task: as it was, and no attempt started for it.
  const done = getTask(again.db, first)!;
  assert.equal(done.status, "awaiting_decision");
  assert.ok(!driver.started.some((options) => options.cwd === done.worktreePath), "the finished task is not built again");
  // The one that was mid-turn: resumed from the session the CLI had reported, told what happened, and finished.
  const resumed = getTask(again.db, second)!;
  assert.equal(resumed.status, "awaiting_decision");
  // The model stays the one the task was started with (here the agent's own default), whatever is configured by now.
  assert.deepEqual([driver.started[0]!.cwd, driver.started[0]!.resumeCursor, driver.started[0]!.model], [resumed.worktreePath, CURSOR, resumed.requestedModel ?? undefined]);
  assert.equal(driver.prompts[0], CONTINUE_PROMPT);
  assert.equal(restarts(again.db, second), 1, "the retry is stored");
  assert.notEqual(resumed.attemptId, s.attemptId, "a new attempt took it up");
  assert.deepEqual(row(again.db, "SELECT status, pgid FROM attempts WHERE id = ?", s.attemptId!), { status: "interrupted", pgid: null });
  // Then the run goes on with the task it had not started, one at a time, after the resumed one.
  const last = getTask(again.db, third)!;
  assert.equal(last.status, "awaiting_decision");
  assert.equal(driver.started.length, 2);
  assert.equal(driver.started[1]!.cwd, last.worktreePath);
  assert.equal(driver.started[1]!.resumeCursor, undefined);
  assert.equal(getRun(again.db, runId)!.status, "awaiting_decision");
  // The run that waited for the owner's approval still does, with its plan.
  const waiting = getRun(again.db, waitingId)!;
  assert.equal(waiting.status, "awaiting_plan_approval");
  assert.deepEqual(planTasks(again.db, waitingId).map((task) => task.title), ["Waiting one", "Waiting two"]);
});

test("a task that was mid-turn: the CLI's process group that survived is stopped before anything is started in its copy; the task is re-driven from its resume cursor and finishes with what the agent wrote before the stop", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { task: PROMPT, script: ["done"], hold: 0, holdAt: "session", stopAt: "turn", survivor: true, wrote: "partial.txt" });
  const [taskId] = s.taskIds as [number];
  assert.ok(s.survivor !== null && processGroupAlive(s.survivor), "the survivor is running");

  const driver = watching(["done"], () => s.survivor);
  const again = await startAgain(t, p, { driver });
  assert.deepEqual(driver.aliveAtStart, [false], "no second agent was started beside the first in the same copy");
  assert.equal(processGroupAlive(s.survivor!), false);
  assert.deepEqual(row(again.db, "SELECT status, pgid FROM attempts WHERE id = ?", s.attemptId!), { status: "interrupted", pgid: null });
  assert.equal(driver.started.length, 1, "re-driven once");
  assert.equal(driver.started[0]!.resumeCursor, CURSOR);
  assert.equal(driver.prompts[0], CONTINUE_PROMPT);
  const task = getTask(again.db, taskId)!;
  assert.equal(task.status, "awaiting_decision");
  assert.equal(git(p.repo, "show", `${task.branch}:partial.txt`), "written by the agent before the stop\n");
  assert.equal(restarts(again.db, taskId), 1);
  assert.match(notes(again.db, taskId), /restart/);
});

test("a second interruption of the same task marks it stopped for the owner, with its work committed; the count is read from the store, not memory", { timeout: 90_000 }, async (t) => {
  const p = place(t);
  const first = leave(t, p, { task: PROMPT, script: ["done"], hold: 0, holdAt: "session", stopAt: "turn", wrote: "partial.txt" });
  const [taskId] = first.taskIds as [number];
  // The next Botbench re-drives it, and is killed in that turn too, its CLI left running.
  const second = leave(t, p, { existing: true, script: ["done"], hold: 0, holdAt: "session", stopAt: "turn", survivor: true });
  assert.notEqual(second.attemptId, first.attemptId);

  const driver = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { driver });
  assert.equal(processGroupAlive(second.survivor!), false, "what the second one left running is stopped too");
  assert.equal(driver.started.length, 0, "not re-driven a second time");
  const task = getTask(again.db, taskId)!;
  assert.equal(task.status, "interrupted");
  assert.match(task.reason!, /Botbench stopped .*twice/);
  assert.match(task.reason!, /Resume/);
  assert.equal(restarts(again.db, taskId), 1);
  assert.equal(git(p.repo, "show", `${task.branch}:partial.txt`), "written by the agent before the stop\n", "its work is committed to its branch");
  assert.equal(git(task.worktreePath!, "status", "--porcelain"), "");

  // A further start changes nothing about it.
  await again.close();
  const third = await startAgain(t, p, { driver });
  assert.equal(getTask(third.db, taskId)!.status, "interrupted");
  assert.equal(driver.started.length, 0);
});

test("a turn stopped before its CLI had reported a session is started again from the task's own prompt, once", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { task: PROMPT, setup: [WRITES], script: ["done"], hold: 0, holdAt: "prompt", stopAt: "turn" });
  const [taskId] = s.taskIds as [number];
  assert.equal(row(openStoreOnce(p.home), "SELECT resume_cursor FROM attempts WHERE id = ?", s.attemptId!).resume_cursor, null);
  const driver = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { driver, setup: [WRITES] });
  assert.equal(driver.started.length, 1);
  assert.equal(driver.started[0]!.resumeCursor, undefined);
  assert.equal(driver.prompts[0], PROMPT);
  assert.equal(getTask(again.db, taskId)!.status, "awaiting_decision");
  assert.equal(restarts(again.db, taskId), 1);
});

function openStoreOnce(home: string): DatabaseSync {
  const db = openStore(home);
  setImmediate(() => db.close());
  return db;
}

test("a recorded process group whose number now belongs to an unrelated process is never killed: the record is cleared and the process runs on", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { task: PROMPT, script: ["done"], hold: 0, holdAt: "session", stopAt: "turn" });
  // A real process that has nothing to do with Botbench, under the number recorded for the CLI and for a command. It
  // began an hour after the attempt and the command were recorded, as a process that was given the number again would.
  const stranger = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  stranger.unref();
  t.after(() => killProcessGroup(stranger.pid!).catch(() => {}));
  const db = openStore(p.home);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare("UPDATE attempts SET pgid = ?, created_at = ? WHERE id = ?").run(stranger.pid!, hourAgo, s.attemptId!);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-command-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  db.prepare("INSERT INTO command_processes (task_id, kind, round, position, command, limit_ms, tmp_dir, pgid, spawned_at, created_at) VALUES (?, 'setup', 1, 1, 'npm ci', 60000, ?, ?, ?, ?)").run(s.taskIds[0]!, tmp, stranger.pid!, hourAgo, hourAgo);
  db.close();

  const again = await startAgain(t, p, { driver: buildReplayDriver(["done"]) });
  assert.equal(processGroupAlive(stranger.pid!), true, "the unrelated process is left running");
  assert.equal(row(again.db, "SELECT pgid FROM attempts WHERE id = ?", s.attemptId!).pgid, null, "and the attempt no longer names it");
  assert.equal(row(again.db, "SELECT pgid FROM command_processes WHERE tmp_dir = ?", tmp).pgid, null, "nor does the command");
  assert.equal(fs.existsSync(tmp), false, "the command's own temporary folder is removed all the same");
});

test("a command's process group whose leader has ended while what it started runs on is stopped, and the rest of a group recorded with no start time is never touched", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { task: PROMPT, setup: [waits(p)], stopAt: "setup" });
  const db = openStore(p.home);
  // A group whose leader is gone and whose member runs on, recorded as a command Botbench started a moment ago.
  const leader = spawn("/bin/sh", ["-c", "sleep 600 >/dev/null 2>&1 & exit 0"], { detached: true, stdio: "ignore" });
  const pgid = leader.pid!;
  t.after(() => killProcessGroup(pgid).catch(() => {}));
  const at = new Date().toISOString();
  await new Promise((resolve) => leader.once("exit", resolve));
  assert.equal(processGroupAlive(pgid), true, "the member runs on without its leader");
  db.prepare("INSERT INTO command_processes (task_id, kind, round, position, command, limit_ms, tmp_dir, pgid, spawned_at, created_at) VALUES (?, 'setup', 1, 9, 'a command', 60000, NULL, ?, ?, ?)").run(s.taskIds[0]!, pgid, at, at);
  db.close();
  fs.writeFileSync(p.go, "");
  await startAgain(t, p, { setup: [waits(p)], driver: buildReplayDriver(["done"]) });
  await until("the group is gone", () => !processGroupAlive(pgid));
});

test("a task stopped during setup, before any agent turn: the setup command at work is recorded as stopped by the restart, its process group and temporary folder are gone, and setup runs again once from the start before the agent starts", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const setup = ["echo one >> setup-runs.txt", waits(p)];
  const s = leave(t, p, { task: PROMPT, setup, stopAt: "setup" });
  const [taskId] = s.taskIds as [number];
  const peek = openStore(p.home);
  const open = peek.prepare("SELECT * FROM command_processes WHERE ended_at IS NULL").all().map((r) => ({ ...r }));
  peek.close();
  assert.equal(open.length, 1, "Botbench recorded the command at work");
  const [left] = open as [{ pgid: number; tmp_dir: string; kind: string; position: number; spawned_at: string }];
  assert.deepEqual([left.kind, left.position], ["setup", 2]);
  assert.ok(processGroupAlive(left.pgid), "the command outlived its Botbench");
  assert.ok(fs.existsSync(left.tmp_dir), "and so did its temporary folder");

  fs.writeFileSync(p.go, "");
  const driver = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { setup, driver });
  assert.equal(processGroupAlive(left.pgid), false);
  assert.equal(fs.existsSync(left.tmp_dir), false);
  assert.deepEqual(row(again.db, "SELECT count(*) AS n FROM command_processes WHERE pgid IS NOT NULL OR ended_at IS NULL").n, 0);
  // Evidence is only added to: the command the restart stopped stays, as stopped, and the rerun follows it.
  assert.deepEqual(evidenceOf(again.db, taskId), [["setup", 1, 1, "passed"], ["setup", 1, 2, "stopped"], ["setup", 2, 1, "passed"], ["setup", 2, 2, "passed"]]);
  assert.match(taskEvidence(again.db, taskId)[1]!.output, /Botbench stopped/);
  const task = getTask(again.db, taskId)!;
  assert.equal(fs.readFileSync(path.join(task.worktreePath!, "setup-runs.txt"), "utf8"), "one\none\n", "setup ran again from its first command");
  assert.equal(driver.started.length, 1);
  assert.equal(driver.prompts[0], PROMPT, "the agent starts with the task's own prompt: it had never started");
  assert.equal(task.status, "awaiting_decision");
  assert.equal(restarts(again.db, taskId), 1);
});

test("a task stopped during setup a second time is stopped for the owner, and nothing more runs in its copy", { timeout: 90_000 }, async (t) => {
  const p = place(t);
  const setup = ["echo one >> setup-runs.txt", waits(p)];
  const s = leave(t, p, { task: PROMPT, setup, stopAt: "setup" });
  const [taskId] = s.taskIds as [number];
  fs.rmSync(path.join(s.worktree!, "begun.txt"));
  leave(t, p, { existing: true, setup, taskId, stopAt: "setup" });
  const driver = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { setup, driver });
  const task = getTask(again.db, taskId)!;
  assert.equal(task.status, "interrupted");
  assert.match(task.reason!, /setup/i);
  assert.equal(fs.readFileSync(path.join(task.worktreePath!, "setup-runs.txt"), "utf8"), "one\none\n");
  assert.deepEqual(evidenceOf(again.db, taskId).map((e) => e[3]), ["passed", "stopped", "passed", "stopped"]);
  assert.equal(driver.started.length, 0);
  assert.deepEqual(row(again.db, "SELECT count(*) AS n FROM command_processes WHERE pgid IS NOT NULL").n, 0);
});

test("a task whose agent turn had started is never set up again after a restart, even though its setup is not repeatable: only the turn is re-driven", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const setup = ["echo one >> setup-runs.txt"];
  const s = leave(t, p, { task: PROMPT, setup, script: ["done"], hold: 0, holdAt: "session", stopAt: "turn", wrote: "partial.txt" });
  const [taskId] = s.taskIds as [number];
  const driver = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { setup, driver });
  const task = getTask(again.db, taskId)!;
  assert.equal(task.status, "awaiting_decision");
  assert.equal(git(p.repo, "show", `${task.branch}:setup-runs.txt`), "one\n", "setup ran once, before the agent");
  assert.deepEqual(evidenceOf(again.db, taskId), [["setup", 1, 1, "passed"]]);
  assert.equal(driver.started[0]!.resumeCursor, CURSOR);
});

test("a task stopped during its checks: the check at work is recorded as stopped by the restart, and the checks run again once from the start on the same commit", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const checks = ["true", waits(p)];
  const s = leave(t, p, { task: PROMPT, setup: [WRITES], checks, script: ["done"], stopAt: "checks" });
  const [taskId] = s.taskIds as [number];
  const peek = openStore(p.home);
  const before = getTask(peek, taskId)!;
  peek.close();
  assert.equal(before.status, "verifying");

  fs.writeFileSync(p.go, "");
  const driver = buildReplayDriver([]);
  const again = await startAgain(t, p, { setup: [WRITES], checks, driver });
  const task = getTask(again.db, taskId)!;
  assert.equal(task.status, "awaiting_decision");
  assert.equal(task.checks, "passed", "what the checks found is the rerun's");
  assert.equal(task.headCommit, before.headCommit, "nothing is committed again: what a check left is not on the branch");
  // The first row is the setup command that gives the task a change to check; setup is not run again for the checks.
  assert.deepEqual(evidenceOf(again.db, taskId), [["setup", 1, 1, "passed"], ["check", 1, 1, "passed"], ["check", 1, 2, "stopped"], ["check", 2, 1, "passed"], ["check", 2, 2, "passed"]]);
  assert.equal(driver.started.length, 0, "no agent is started for the checks");
  assert.equal(restarts(again.db, taskId), 1);

  // Stopped during the checks twice: the owner is left to resume it.
  const q = place(t);
  const checks2 = ["true", waits(q)];
  const first = leave(t, q, { task: PROMPT, setup: [WRITES], checks: checks2, script: ["done"], stopAt: "checks" });
  fs.rmSync(path.join(first.worktree!, "begun.txt"));
  leave(t, q, { existing: true, setup: [WRITES], checks: checks2, taskId: first.taskIds[0]!, stopAt: "checks" });
  const third = await startAgain(t, q, { setup: [WRITES], checks: checks2 });
  const twice = getTask(third.db, first.taskIds[0]!)!;
  assert.equal(twice.status, "interrupted");
  assert.match(twice.reason!, /checks/);
  assert.equal(twice.checks, null);
  // The setup row first, then the two rounds of checks.
  assert.deepEqual(evidenceOf(third.db, twice.id).map((e) => e[3]), ["passed", "passed", "stopped", "passed", "stopped"]);
});

test("a run that was being planned is planned again once from the start, read-only in a fresh copy; stopped while planning a second time, it fails and says to start it again", { timeout: 90_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { planning: "Plan three small files.", stopAt: "planning" });
  const [runId] = s.runIds as [number];
  const planner = planReplayDriver(loadPlanRecording(), [THREE_TASKS]);
  const again = await startAgain(t, p, { planner });
  const run = getRun(again.db, runId)!;
  assert.equal(run.status, "awaiting_plan_approval");
  assert.equal(planTasks(again.db, runId).length, 3);
  assert.equal(planner.started.length, 1);
  assert.equal(planner.started[0]!.resumeCursor, undefined, "planning starts again from the start");
  assert.equal(planner.started[0]!.readOnly, true);
  assert.equal(Number(row(again.db, "SELECT restarts FROM runs WHERE id = ?", runId).restarts), 1);
  assert.equal(fs.existsSync(path.join(p.home, "worktrees", `run-${runId}`, "planner")), false);

  const q = place(t);
  const one = leave(t, q, { planning: "Plan three small files.", stopAt: "planning" });
  leave(t, q, { existing: true, planning: undefined, stopAt: "planning" } as Omit<Order, "home" | "repo">);
  const planner2 = planReplayDriver(loadPlanRecording(), [THREE_TASKS]);
  const third = await startAgain(t, q, { planner: planner2 });
  const failed = getRun(third.db, one.runIds[0]!)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.reason!, /Botbench stopped .*twice.*Start the run again/);
  assert.equal(planner2.started.length, 0);
});

test("Botbench shut down in the ordinary way during a turn leaves the task where it was, uncommitted, and the next start continues it from its resume cursor", { timeout: 60_000 }, async (t) => {
  const p = place(t);
  const db = openStore(p.home);
  const broker = createBroker({ db, home: p.home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(["done"], { hold: [0], holdAt: "session" });
  const repoCommands = () => ({ setup: [{ command: WRITES, limitMs: 60_000 }], checks: [] });
  const tasks = createTasks({ db, home: p.home, driver, broker, model: "haiku", repoCommands, onEvent: () => {}, onTaskChange: () => {} });
  const started = await tasks.start(p.repo, PROMPT, "haiku");
  await driver.held(0);
  await tasks.close();
  await broker.close();
  const stopped = getTask(db, started.id)!;
  assert.equal(stopped.status, "building", "left for the next start");
  assert.equal(stopped.headCommit, null);
  assert.match(lastNote(db, started.id), /next start/);
  db.close();

  const next = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { driver: next, setup: [WRITES] });
  assert.equal(next.started[0]!.resumeCursor, CURSOR);
  assert.equal(getTask(again.db, started.id)!.status, "awaiting_decision");
});

test("Resume re-drives a stopped task from its resume cursor, told what happened, and it finishes; its run goes on and ends again; a second Resume, and a Resume of a task in any other state, is refused with a plain reason", { timeout: 120_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { run: ["Only"], script: ["done"], hold: 0, holdAt: "session", stopAt: "turn", wrote: "partial.txt" });
  leave(t, p, { existing: true, script: ["done"], hold: 0, holdAt: "session", stopAt: "turn" });
  const [runId] = s.runIds as [number];
  const [taskId] = s.taskIds as [number];
  const driver = buildReplayDriver(["done", "done"], { hold: [0] });
  const again = await startAgain(t, p, { driver });
  assert.equal(getTask(again.db, taskId)!.status, "interrupted");
  assert.equal(getRun(again.db, runId)!.status, "done", "with nothing to review, the run ends; Resume takes it up again");

  const resumed = again.tasks.resume(taskId);
  assert.equal(resumed.status, "building");
  assert.throws(() => again.tasks.resume(taskId), (err: unknown) => err instanceof TaskError && err.status === 409 && /already/.test(err.message));
  await driver.held(0);
  assert.equal(getRun(again.db, runId)!.status, "running");
  driver.release(0);
  await again.tasks.idle();
  assert.equal(driver.started[0]!.resumeCursor, CURSOR);
  assert.equal(driver.prompts[0], CONTINUE_PROMPT);
  const task = getTask(again.db, taskId)!;
  assert.equal(task.status, "awaiting_decision");
  assert.equal(git(p.repo, "show", `${task.branch}:partial.txt`), "written by the agent before the stop\n");
  assert.equal(restarts(again.db, taskId), 0, "the owner's Resume starts the count again");
  assert.match(notes(again.db, taskId), /resumed by the owner/);
  assert.equal(getRun(again.db, runId)!.status, "awaiting_decision");

  // Every other state is refused, with what it is in words.
  assert.throws(() => again.tasks.resume(taskId), (err: unknown) => err instanceof TaskError && err.status === 409 && /Only a stopped task, or one whose builder changed no file, can be resumed/.test(err.message) && /ready for review/.test(err.message));
  assert.throws(() => again.tasks.resume(999), (err: unknown) => err instanceof TaskError && err.status === 404);
  assert.equal(driver.started.length, 1);
});

test("Resume of a task stopped before its CLI had reported a session starts a fresh turn with the task's own prompt", { timeout: 120_000 }, async (t) => {
  const p = place(t);
  const s = leave(t, p, { task: PROMPT, setup: [WRITES], script: ["done"], hold: 0, holdAt: "prompt", stopAt: "turn" });
  leave(t, p, { existing: true, setup: [WRITES], script: ["done"], hold: 0, holdAt: "prompt", stopAt: "turn" });
  const driver = buildReplayDriver(["done"]);
  const again = await startAgain(t, p, { driver, setup: [WRITES] });
  const [taskId] = s.taskIds as [number];
  assert.equal(getTask(again.db, taskId)!.status, "interrupted");
  again.tasks.resume(taskId);
  await again.tasks.idle();
  assert.equal(driver.started[0]!.resumeCursor, undefined);
  assert.equal(driver.prompts[0], PROMPT);
  assert.equal(getTask(again.db, taskId)!.status, "awaiting_decision");
});
