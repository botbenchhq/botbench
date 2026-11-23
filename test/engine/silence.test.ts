import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { taskDecision } from "../../src/engine/decision.ts";
import { setAskEveryCommand, type RunMode } from "../../src/engine/modes.ts";
import { createRun, createRuns, getRun, storePlan, type Runs } from "../../src/engine/run.ts";
import { durationWords, plannerSilenceReason, silenceReason } from "../../src/engine/silence.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, resumeNote, type Tasks } from "../../src/engine/task.ts";
import type { Driver } from "../../src/drivers/contract.ts";
import { launch, processGroupAlive } from "../../src/drivers/launch.ts";
import { openStore } from "../../src/store/db.ts";
import { processDriver, type ProcessDriver } from "../support/process-driver.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The silence limit through the engine, with real SQLite, a real temporary repository, the real permission broker on
// its socket and real agent processes in their own process groups (test/support/process-driver.ts): a builder or
// planner that stays alive and sends nothing is stopped, with its whole group, and a busy one or one waiting on the
// owner is not.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * A silent agent that is never stopped sleeps for ten minutes: the test fails long before that. Each test waits a few
 * silence limits of up to 10 seconds each (`limitFor`), on a machine that may be loaded.
 */
const WITHIN = { timeout: 180_000 };

/**
 * How long this machine takes, now, to start a shell that starts a child, records its number and waits for it: the
 * slowest of three tries. That is what each agent process here does before anything else, and a machine under load can
 * take far longer than an idle one. The silence limits below are set from it, so a stop the test means to be at the limit
 * is never brought on by a slow start, and a limit is never looser than it needs to be on an idle machine.
 */
async function pace(): Promise<number> {
  const dir = tempDir("botbench-silence-pace-");
  let slowest = 0;
  for (let i = 0; i < 3; i++) {
    const began = performance.now();
    const { child } = launch("/bin/sh", ["-c", `sleep 0 & echo $! > '${dir}/pid'; wait`], { cwd: dir });
    child.stdin.end();
    child.stdout.resume();
    child.stderr.resume();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    slowest = Math.max(slowest, performance.now() - began);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return slowest;
}
/**
 * A silence limit of at least `floorMs` and at least twenty of this machine's starts (`pace`), in whole tenths of a
 * second; at most 10 seconds, still ten of the slowest starts seen under load, so that a test waiting several limits stays
 * within its time.
 */
const limitFor = async (floorMs: number): Promise<number> => Math.min(10_000, Math.ceil(Math.max(floorMs, 20 * (await pace())) / 100) * 100);

/** Wait until `ready` holds, checking every 20 ms; fails after `ms`. */
async function until(ready: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}.`);
    await pause(20);
  }
}

/** Whether a process is still running. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

interface Line {
  dir: string;
  db: DatabaseSync;
  repo: string;
  base: string;
  broker: Broker;
  driver: ProcessDriver;
  tasks: Tasks;
  runs: Runs;
}

async function line(t: T, scripts: readonly string[] | Driver, limitMs: number, o: { checks?: StationCommand[]; files?: Record<string, string> } = {}): Promise<Line> {
  const dir = tempDir("botbench-silence-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, o.files);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = Array.isArray(scripts) ? processDriver(scripts as readonly string[]) : (scripts as ProcessDriver);
  const repoCommands = () => ({ setup: [], checks: o.checks ?? [] });
  const tasks = createTasks({ db, home, driver, broker, repoCommands, silenceLimitMs: limitMs, onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home, driver, broker, line: tasks, repoCommands, silenceLimitMs: limitMs, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    for (const group of driver.groups ?? []) assert.equal(processGroupAlive(group), false, `process group ${group} is left running`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, repo, base, broker, driver, tasks, runs };
}

/** A run of one task in `mode`, its plan stored without a planner and approved. */
function oneTask(e: Line, mode: RunMode): { runId: number; taskId: number } {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a greeting file", baseCommit: e.base, mode, reviewer: null });
  const stored = storePlan(e.db, run.id, [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }]);
  const { tasks } = e.runs.approve(stored.id, stored.planVersion);
  return { runId: run.id, taskId: tasks[0]!.id };
}

/** The stored events of an attempt, in order, with their times. */
const events = (db: DatabaseSync, attemptId: number): { type: string; at: number }[] =>
  db.prepare("SELECT type, ts FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => ({ type: String(row.type), at: Date.parse(String(row.ts)) }));

/** Commits on the task's branch that are not on its base. */
const commitsOf = (repo: string, base: string, branch: string): string[] => git(repo, "rev-list", `${base}..${branch}`).split("\n").filter((line) => line !== "");

test("a builder that stays alive and sends nothing is stopped at the limit with its whole process group, and the task is Stopped, not Failed, with Resume offered and no commit the agent did not write", WITHIN, async (t) => {
  const limitMs = await limitFor(500);
  const pids = tempDir("botbench-silence-pids-");
  // Two children in the agent's group, which record their numbers outside its copy; the agent prints nothing at all.
  const e = await line(t, [`read go; sleep 600 & echo $! > '${pids}/a'; sleep 600 & echo $! > '${pids}/b'; wait`], limitMs);

  const started = await e.tasks.start(e.repo, "Add a greeting file");
  await until(() => fs.existsSync(path.join(pids, "b")) && fs.readFileSync(path.join(pids, "b"), "utf8").trim() !== "", "the agent's children have started");
  const children = ["a", "b"].map((name) => Number(fs.readFileSync(path.join(pids, name), "utf8").trim()));
  assert.ok(children.every(alive), "the agent's children run while it is silent");
  await e.tasks.idle();

  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "interrupted", task.reason ?? "");
  assert.equal(task.reason, silenceReason("Claude Code", limitMs));
  assert.match(task.reason!, /^Claude Code went silent: it sent nothing for \d+(\.\d)? seconds? while it was working, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started\./);
  // The whole group is gone: its leader and both children, and the attempt no longer names a group.
  assert.equal(processGroupAlive(e.driver.groups[0]!), false);
  for (const child of children) assert.equal(alive(child), false, `child ${child} of the agent is still running`);
  assert.equal(e.db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(task.attemptId!)?.pgid, null);
  // Stopped at the limit, not before it: the time from the prompt to the stop.
  const stored = events(e.db, task.attemptId!);
  assert.deepEqual(stored.map((event) => event.type), ["user_prompt", "turn_ended"]);
  assert.ok(stored[1]!.at - stored[0]!.at >= limitMs, `stopped after ${stored[1]!.at - stored[0]!.at} ms`);
  // Resume is offered, and it carries on in the same copy.
  assert.equal(resumeNote(e.db, task), "Resume starts Claude Code again in the task's copy of the project, with the files as they were left, and asks it to carry on where it stopped.");
  // The agent wrote nothing, so the branch holds no commit and the copy no change.
  assert.deepEqual(commitsOf(e.repo, e.base, task.branch!), []);
  assert.equal(git(task.worktreePath!, "status", "--porcelain"), "");
});

test("a builder waiting on the owner's answer is not stopped however long the owner takes, and the silence clock starts again from the answer", WITHIN, async (t) => {
  const limitMs = await limitFor(400);
  const e = await line(t, ["read go; echo ask npm test; read answer; sleep 600 & wait"], limitMs);
  // A confined command runs without asking unless the owner turned on Ask before every command.
  setAskEveryCommand(e.db, true);

  const started = await e.tasks.start(e.repo, "Run the tests");
  await until(() => listApprovals(e.db, "pending").length === 1, "the request waits for the owner");
  // The owner takes four times the limit.
  await pause(limitMs * 4);
  assert.equal(getTask(e.db, started.id)!.status, "building");
  const attemptId = getTask(e.db, started.id)!.attemptId!;
  assert.equal(events(e.db, attemptId).some((event) => event.type === "turn_ended"), false, "the turn was not stopped while it waited");

  e.broker.answer(listApprovals(e.db, "pending")[0]!.id, "allow");
  await e.tasks.idle();

  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "interrupted", task.reason ?? "");
  assert.equal(task.reason, silenceReason("Claude Code", limitMs));
  const stored = events(e.db, attemptId);
  assert.deepEqual(stored.map((event) => event.type), ["user_prompt", "permission_request", "permission_resolved", "turn_ended"]);
  const [, asked, answered, ended] = stored as [unknown, { at: number }, { at: number }, { at: number }];
  // The clock ran from the answer, for the whole limit, and the wait before it did not count.
  assert.ok(ended.at - answered.at >= limitMs, `stopped ${ended.at - answered.at} ms after the answer`);
  assert.ok(answered.at - asked.at >= limitMs * 4, `the owner took ${answered.at - asked.at} ms`);
  assert.equal(processGroupAlive(e.driver.groups[0]!), false);
});

test("a long build that keeps sending events runs past the limit in total and is not stopped; once its turn has ended the limit does nothing", WITHIN, async (t) => {
  // A line every 0.15 seconds, each a new `sleep` started: the limit leaves room for this machine's slowest start, and
  // the build runs for more than three limits in all.
  const limitMs = await limitFor(400);
  const lines = Math.ceil((limitMs * 3.5) / 150);
  const e = await line(t, [`read go; i=0; while [ $i -lt ${lines} ]; do echo working $i; sleep 0.15; i=$((i+1)); done; printf 'hi\\n' > hello.txt`], limitMs);

  const started = await e.tasks.start(e.repo, "Add a greeting file");
  await e.tasks.idle();

  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  const stored = events(e.db, task.attemptId!);
  assert.equal(stored.at(-1)!.type, "turn_ended");
  assert.ok(stored.at(-1)!.at - stored[0]!.at > limitMs * 3, `the build took ${stored.at(-1)!.at - stored[0]!.at} ms`);
  assert.equal(JSON.parse(String(e.db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'turn_ended'").get(task.attemptId!)!.payload)).reason, "completed");
  assert.equal(commitsOf(e.repo, e.base, task.branch!).length, 1);

  // Past the limit again after the turn: nothing more happens to the task or its attempt.
  await pause(limitMs * 2);
  assert.equal(getTask(e.db, started.id)!.status, "awaiting_decision");
  assert.equal(events(e.db, task.attemptId!).length, stored.length);
});

test("the owner's cancel of a silent builder's run ends the task as cancelled, and the silence limit then does nothing", WITHIN, async (t) => {
  const limitMs = await limitFor(800);
  const e = await line(t, ["read go; sleep 600 & wait"], limitMs);
  const { runId, taskId } = oneTask(e, "manual");
  await until(() => getTask(e.db, taskId)?.attemptId !== null && e.driver.prompts.length === 1, "the builder's turn is under way");

  e.runs.cancel(runId);
  await e.tasks.idle();
  const task = getTask(e.db, taskId)!;
  assert.equal(task.status, "cancelled", task.reason ?? "");
  assert.doesNotMatch(task.reason!, /silent/);
  const count = events(e.db, task.attemptId!).length;

  await pause(limitMs + 400);
  assert.equal(getTask(e.db, taskId)!.status, "cancelled");
  assert.equal(events(e.db, task.attemptId!).length, count, "nothing was stored after the cancel");
});

test("with the limit off, a silent builder is left to work", WITHIN, async (t) => {
  const e = await line(t, ["read go; sleep 600 & wait"], 0);
  const started = await e.tasks.start(e.repo, "Add a greeting file");
  await until(() => e.driver.prompts.length === 1, "the builder's turn is under way");
  await pause(800);
  assert.equal(getTask(e.db, started.id)!.status, "building");
  assert.equal(processGroupAlive(e.driver.groups[0]!), true);
});

test("a fully autonomous run hands a task stopped for silence back to the owner: it is not accepted, nothing is merged, and Resume is offered", WITHIN, async (t) => {
  const limitMs = await limitFor(400);
  const e = await line(t, ["read go; sleep 600 & wait"], limitMs, { checks: [cmd("test -f hello.txt")] });
  const { runId, taskId } = oneTask(e, "full");
  await e.tasks.idle();

  const task = getTask(e.db, taskId)!;
  assert.equal(task.status, "interrupted", task.reason ?? "");
  assert.equal(task.reason, silenceReason("Claude Code", limitMs));
  assert.equal(taskDecision(e.db, taskId), null, "no decision was made for the owner");
  assert.notEqual(resumeNote(e.db, task), null);
  // The run has nothing to review and waits on no decision of the mode's.
  assert.equal(getRun(e.db, runId)!.status, "done");
  assert.equal(git(e.repo, "rev-parse", "main").trim(), e.base, "nothing was merged into the base branch");
  assert.deepEqual(commitsOf(e.repo, e.base, task.branch!), []);
  assert.equal(processGroupAlive(e.driver.groups[0]!), false);
});

test("a planner that stays alive and sends nothing is stopped at the limit with its process group, and the run fails saying so", WITHIN, async (t) => {
  const limitMs = await limitFor(400);
  const e = await line(t, ["read go; sleep 600 & wait"], limitMs);
  const run = await e.runs.start({ repo: e.repo, prompt: "Add a greeting file", mode: "manual" });
  await e.runs.idle();

  const failed = getRun(e.db, run.id)!;
  assert.equal(failed.status, "failed", failed.reason ?? "");
  assert.equal(failed.reason, plannerSilenceReason("Claude Code", limitMs));
  assert.match(failed.reason!, /^The planner went silent: Claude Code sent nothing for \d+(\.\d)? seconds? while it was planning/);
  assert.equal(processGroupAlive(e.driver.groups[0]!), false);
  assert.equal(e.db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(failed.attemptId!)?.pgid, null);
});

// A command the agent runs, through a real Claude Code session: the recorded turn in which the CLI asked to run
// `sh other.sh`, was allowed, and returned (test/recordings/redrive-other-request.json, the "ask" turn of
// test/support/replay-build.ts). The replay runs the recorded command for real in the task's copy, where the test's
// other.sh sleeps without printing, and plays the CLI's result only when it has exited: the CLI prints nothing while its
// command runs, exactly as here.

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Allow every request of the task's agent that waits, as the owner would, until the test ends. */
function allowAll(t: T, e: Line): void {
  const timer = setInterval(() => {
    for (const approval of listApprovals(e.db, "pending")) e.broker.answer(approval.id, "allow");
  }, 20);
  t.after(() => clearInterval(timer));
}

/** The stored events of an attempt with their payloads, in order. */
const payloads = (db: DatabaseSync, attemptId: number): { type: string; at: number; payload: Record<string, unknown> }[] =>
  db.prepare("SELECT type, ts, payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => ({ type: String(row.type), at: Date.parse(String(row.ts)), payload: JSON.parse(String(row.payload)) as Record<string, unknown> }));

test("a builder whose command runs quietly for many times the silence limit, within the command's own limit, is not stopped: the clock waits for the command", WITHIN, async (t) => {
  const limitMs = await limitFor(400);
  // Four limits of a real sleep, printing nothing, then a change to the copy; the recorded call names no limit of its
  // own, so it has Claude Code's two minutes.
  const sleepMs = limitMs * 4;
  const e = await line(t, buildReplayDriver(["ask"], { run: {} }), limitMs, { files: { "README.md": "# Sample\n", "other.sh": `sleep ${sleepMs / 1000}\nprintf 'hi\\n' > hello.txt\n` } });
  allowAll(t, e);

  const started = await e.tasks.start(e.repo, "Run the tests");
  // Halfway through the command, past twice the limit, the task is still at work.
  await until(() => getTask(e.db, started.id)!.attemptId !== null && payloads(e.db, getTask(e.db, started.id)!.attemptId!).some((event) => event.type === "permission_resolved"), "the command was allowed");
  await pause(limitMs * 2);
  assert.equal(getTask(e.db, started.id)!.status, "building", "stopped while its command ran within its own limit");
  await e.tasks.idle();

  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  const stored = payloads(e.db, task.attemptId!);
  const call = stored.find((event) => event.type === "tool_call")!;
  const result = stored.find((event) => event.type === "tool_result")!;
  assert.equal((call.payload.input as { command: string }).command, "sh other.sh");
  // Between the call and its result the agent sent nothing but its request and Botbench's answer, for longer than the
  // sleep, which is four silence limits.
  const quiet = stored.slice(stored.indexOf(call) + 1, stored.indexOf(result)).map((event) => event.type);
  assert.deepEqual(quiet, ["rate_limit", "permission_request", "permission_resolved"]);
  const resolved = stored.find((event) => event.type === "permission_resolved")!;
  assert.ok(result.at - resolved.at >= sleepMs, `the command ran for ${result.at - resolved.at} ms`);
  assert.equal(stored.at(-1)!.type, "turn_ended");
  assert.equal(stored.at(-1)!.payload.reason, "completed");
  // The command's change is the task's work.
  assert.equal(git(e.repo, "show", `${task.branch!}:hello.txt`), "hi\n");
});

test("a command past its own time limit is still stopped: once that limit has passed the silence limit counts again, and the task says which command ran and for how long", WITHIN, async (t) => {
  const limitMs = await limitFor(400);
  const pids = tempDir("botbench-silence-pids-");
  t.after(() => fs.rmSync(pids, { recursive: true, force: true }));
  // The call is given its own limit of one silence limit; the command would sleep ten minutes.
  const e = await line(t, buildReplayDriver(["ask"], { run: { timeoutMs: limitMs } }), limitMs, { files: { "README.md": "# Sample\n", "other.sh": `sleep 600 & echo $! > '${pids}/sleep'\nwait\n` } });
  allowAll(t, e);

  const started = await e.tasks.start(e.repo, "Run the tests");
  await e.tasks.idle();

  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "interrupted", task.reason ?? "");
  assert.match(task.reason!, new RegExp(`^Claude Code went silent: it sent nothing more while its command sh other\\.sh ran for \\d+(\\.\\d)? seconds?, past the command's own time limit of ${escaped(durationWords(limitMs))} and then the silence limit of ${escaped(durationWords(limitMs))} in Botbench's settings, so Botbench stopped it and everything it had started\\. The work done up to then is committed\\. Resume starts Claude Code again where it left off\\.$`));
  const stored = payloads(e.db, task.attemptId!);
  const call = stored.find((event) => event.type === "tool_call")!;
  assert.equal((call.payload.input as { timeout: number }).timeout, limitMs);
  // Not before the command's own limit and the silence limit after it: from the call to the stop.
  const ended = stored.at(-1)!;
  assert.equal(ended.type, "turn_ended");
  assert.ok(ended.at - call.at >= limitMs * 2, `stopped ${ended.at - call.at} ms after the call`);
  assert.equal(stored.some((event) => event.type === "tool_result"), false, "the command never returned");
  // The command and everything it started are gone.
  const sleeper = Number(fs.readFileSync(path.join(pids, "sleep"), "utf8").trim());
  await until(() => !alive(sleeper), "the command's sleep is stopped");
});

test("the owner's time to allow a command is not the command's: its own limit counts from the answer, so a quiet command after a long wait is not stopped", WITHIN, async (t) => {
  const limitMs = await limitFor(400);
  // The call's own limit is one silence limit; the owner takes three to answer; then the command sleeps one and a half,
  // printing nothing: past its limit counted from the call, within it counted from the answer.
  const sleepMs = limitMs * 1.5;
  const e = await line(t, buildReplayDriver(["ask"], { run: { timeoutMs: limitMs } }), limitMs, { files: { "README.md": "# Sample\n", "other.sh": `sleep ${sleepMs / 1000}\nprintf 'hi\\n' > hello.txt\n` } });
  setAskEveryCommand(e.db, true);

  const started = await e.tasks.start(e.repo, "Run the tests");
  await until(() => listApprovals(e.db, "pending").length === 1, "the request waits for the owner");
  await pause(limitMs * 3);
  e.broker.answer(listApprovals(e.db, "pending")[0]!.id, "allow");
  await e.tasks.idle();

  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  const stored = payloads(e.db, task.attemptId!);
  const call = stored.find((event) => event.type === "tool_call")!;
  const resolved = stored.find((event) => event.type === "permission_resolved")!;
  const result = stored.find((event) => event.type === "tool_result")!;
  assert.ok(result.at - call.at >= limitMs * 2 + limitMs, `from the call to its result took ${result.at - call.at} ms: more than its own limit and the silence limit after it`);
  assert.ok(result.at - resolved.at >= sleepMs, `the command ran for ${result.at - resolved.at} ms`);
  assert.equal(git(e.repo, "show", `${task.branch!}:hello.txt`), "hi\n");
});
