import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { taskDecision } from "../../src/engine/decision.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { createRun, createRuns, getRun, storePlan, type Runs } from "../../src/engine/run.ts";
import { plannerSilenceReason, silenceReason } from "../../src/engine/silence.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, resumeNote, type Tasks } from "../../src/engine/task.ts";
import { processGroupAlive } from "../../src/drivers/launch.ts";
import { openStore } from "../../src/store/db.ts";
import { processDriver, type ProcessDriver } from "../support/process-driver.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The silence limit through the engine, with real SQLite, a real temporary repository, the real permission broker on
// its socket and real agent processes in their own process groups (test/support/process-driver.ts): a builder or
// planner that stays alive and sends nothing is stopped, with its whole group, and a busy one or one waiting on the
// owner is not.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** A silent agent that is never stopped sleeps for ten minutes: the test fails long before that. */
const WITHIN = { timeout: 30_000 };

/** Wait until `ready` holds, checking every 20 ms; fails after `ms`. */
async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
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

async function line(t: T, scripts: readonly string[], limitMs: number, o: { checks?: StationCommand[] } = {}): Promise<Line> {
  const dir = tempDir("botbench-silence-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = processDriver(scripts);
  const repoCommands = () => ({ setup: [], checks: o.checks ?? [] });
  const tasks = createTasks({ db, home, driver, broker, repoCommands, silenceLimitMs: limitMs, onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home, driver, broker, line: tasks, repoCommands, silenceLimitMs: limitMs, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    for (const group of driver.groups) assert.equal(processGroupAlive(group), false, `process group ${group} is left running`);
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
  const limitMs = 500;
  const pids = tempDir("botbench-silence-pids-");
  t.after(() => fs.rmSync(pids, { recursive: true, force: true }));
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
  assert.match(task.reason!, /^Claude Code went silent: it sent nothing for 0\.5 seconds while it was working, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started\./);
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
  const limitMs = 400;
  const e = await line(t, ["read go; echo ask npm test; read answer; sleep 600 & wait"], limitMs);

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
  const limitMs = 400;
  // About 1.8 seconds of work, a line every 0.15 seconds, then a change to the copy.
  const e = await line(t, ["read go; i=0; while [ $i -lt 12 ]; do echo working $i; sleep 0.15; i=$((i+1)); done; printf 'hi\\n' > hello.txt"], limitMs);

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
  const limitMs = 800;
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
  const limitMs = 400;
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
  const limitMs = 400;
  const e = await line(t, ["read go; sleep 600 & wait"], limitMs);
  const run = await e.runs.start({ repo: e.repo, prompt: "Add a greeting file", mode: "manual" });
  await e.runs.idle();

  const failed = getRun(e.db, run.id)!;
  assert.equal(failed.status, "failed", failed.reason ?? "");
  assert.equal(failed.reason, plannerSilenceReason("Claude Code", limitMs));
  assert.match(failed.reason!, /^The planner went silent: Claude Code sent nothing for 0\.4 seconds while it was planning/);
  assert.equal(processGroupAlive(e.driver.groups[0]!), false);
  assert.equal(e.db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(failed.attemptId!)?.pgid, null);
});
