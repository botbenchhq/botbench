import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import { decideTask } from "../../src/engine/decision.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { createRun, createRuns, getRun, storePlan, type Runs } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, TaskError, type Tasks } from "../../src/engine/task.ts";
import { LIMIT_CANCELLED, LIMIT_PROMPT, limitAgainReason, retryTime, USAGE_LIMIT_WAIT_MS } from "../../src/engine/usage-limit.ts";
import { processGroupAlive } from "../../src/drivers/launch.ts";
import { openStore } from "../../src/store/db.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { processDriver, type ProcessDriver } from "../support/process-driver.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// A builder's usage limit through the engine, with real SQLite, a real temporary repository, the real permission broker
// on its socket and real agent processes in their own process groups (test/support/process-driver.ts). No capture in
// test/recordings/ holds a usage limit being reached (no real one was observed while recording), so the agent's report
// of it is the shape the Claude Code driver gives it (a `rate_limit` event with `limited`, then a turn that ends in
// error), printed by the process as a line `limit <time>`.

type T = { after(fn: () => unknown): void };
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const WITHIN = { timeout: 30_000 };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });

async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}.`);
    await pause(20);
  }
}

/** A builder that writes a file and then reports that its usage limit was reached, resetting at `resetsAt` (or at no time it gives). */
const limited = (file: string, resetsAt: string | null): string => `read go; echo ${file} > ${file}.txt; echo limit${resetsAt === null ? "" : ` ${resetsAt}`}; exit 1`;
/** A builder that writes a file and finishes. */
const finishes = (file: string): string => `read go; echo ${file} > ${file}.txt; echo done`;
/** A time `ms` from now, as the agent gives a reset time. */
const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString();

interface Engine {
  driver: ProcessDriver;
  broker: Broker;
  tasks: Tasks;
  runs: Runs;
  close(): Promise<void>;
}

interface Line {
  dir: string;
  home: string;
  db: DatabaseSync;
  repo: string;
  base: string;
  /** Start Botbench's engine over the store, as a start of Botbench does. */
  open(scripts: readonly string[]): Promise<Engine>;
}

async function line(t: T, o: { waitMs?: number; checks?: StationCommand[] } = {}): Promise<Line> {
  // A short name: the broker's socket goes below it, and a socket's path has a length limit.
  const dir = tempDir("bb-limit-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const engines: Engine[] = [];
  const repoCommands = () => ({ setup: [], checks: o.checks ?? [] });
  const open = async (scripts: readonly string[]): Promise<Engine> => {
    const broker = createBroker({ db, home, onChange: () => {} });
    await broker.listen();
    const driver = processDriver(scripts, { resume: true });
    const tasks = createTasks({ db, home, driver, broker, repoCommands, usageLimitWaitMs: o.waitMs ?? USAGE_LIMIT_WAIT_MS, onEvent: () => {}, onTaskChange: () => {} });
    const runs = createRuns({ db, home, driver, broker, line: tasks, repoCommands, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
    let closed = false;
    const engine: Engine = {
      driver, broker, tasks, runs,
      close: async () => {
        if (closed) return;
        closed = true;
        await runs.close();
        await tasks.close();
        await broker.close();
      },
    };
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    for (const engine of engines) await engine.close();
    db.close();
    for (const engine of engines) for (const group of engine.driver.groups) assert.equal(processGroupAlive(group), false, `process group ${group} is left running`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, home, db, repo, base, open };
}

/** A run whose plan, stored without a planner, holds `titles` as its tasks, approved in `mode`. */
function planned(e: Line, engine: Engine, mode: RunMode, titles: readonly string[]): { runId: number; taskIds: number[] } {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add files", baseCommit: e.base, mode, reviewer: null, oneTask: titles.length === 1 });
  const stored = storePlan(e.db, run.id, titles.map((title) => ({ title, criteria: [`${title} exists`] })));
  const { tasks } = engine.runs.approve(stored.id, stored.planVersion);
  return { runId: run.id, taskIds: tasks.map((task) => task.id) };
}

const history = (db: DatabaseSync, taskId: number): string[] => db.prepare("SELECT status FROM task_events WHERE task_id = ? ORDER BY id").all(taskId).map((row) => String(row.status));
const filesOn = (repo: string, base: string, branch: string): string[] => git(repo, "diff", "--name-only", `${base}..${branch}`).split("\n").filter((f) => f !== "").sort();
const attemptStart = (db: DatabaseSync, attemptId: number): number => Date.parse(String(db.prepare("SELECT created_at FROM attempts WHERE id = ?").get(attemptId)!.created_at));

test("the time to try again is the agent's reset time when it gives one in the future, and otherwise the configured wait from now", () => {
  const now = Date.parse("2026-11-22T14:00:00.000Z");
  assert.equal(retryTime("2026-11-22T14:30:00.000Z", now, 60_000), "2026-11-22T14:30:00.000Z");
  for (const none of [null, "2026-11-22T13:59:59.000Z", "2026-11-22T14:00:00.000Z", "not a time", ""]) assert.equal(retryTime(none, now, 30 * 60_000), "2026-11-22T14:30:00.000Z", String(none));
  assert.equal(USAGE_LIMIT_WAIT_MS, 30 * 60_000);
});

test("a builder's turn that ends on a usage limit waits, its work committed, until the reset time the agent gave; then the same session is resumed once, with the task's own model, and the task goes on to Ready for review without using up a restart", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 60 * 60_000 });
  const resetsAt = inMs(1500);
  const engine = await e.open([limited("one", resetsAt), finishes("two")]);
  const started = await engine.tasks.start(e.repo, "Add two files", "haiku");

  await until(() => getTask(e.db, started.id)!.status === "waiting_for_limit", "the task waits for the limit");
  const waiting = getTask(e.db, started.id)!;
  assert.equal(waiting.retryAt, resetsAt, "the agent's own reset time");
  assert.equal(waiting.restarts, 0);
  // Its work up to the limit is committed, as for any stop.
  assert.deepEqual(filesOn(e.repo, e.base, waiting.branch!), ["one.txt"]);
  assert.equal(waiting.headCommit, git(e.repo, "rev-parse", waiting.branch!).trim());
  const firstAttempt = waiting.attemptId!;
  assert.equal(e.db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'turn_ended'").get(firstAttempt)!.payload, JSON.stringify({ type: "turn_ended", reason: "error", detail: "The process ended with code 1.", usageLimit: { resetsAt } }));
  // Nothing more is started before the time.
  await pause(300);
  assert.equal(getTask(e.db, started.id)!.status, "waiting_for_limit");
  assert.equal(engine.driver.starts.length, 1);

  await until(() => getTask(e.db, started.id)!.status === "awaiting_decision", "the resumed task is ready for review");
  const done = getTask(e.db, started.id)!;
  assert.deepEqual(engine.driver.starts, [{ resumeCursor: null, model: "haiku" }, { resumeCursor: `session-${firstAttempt}`, model: "haiku" }]);
  assert.equal(engine.driver.prompts[1], LIMIT_PROMPT);
  assert.ok(attemptStart(e.db, done.attemptId!) >= Date.parse(resetsAt), "resumed at the time, not before");
  assert.equal(done.restarts, 0, "the resume is not one of Botbench's restarts");
  assert.equal(done.retryAt, null);
  assert.deepEqual(filesOn(e.repo, e.base, done.branch!), ["one.txt", "two.txt"]);
  assert.deepEqual(history(e.db, started.id), ["queued", "building", "building", "waiting_for_limit", "building", "building", "awaiting_decision"]);
});

test("with no reset time from the agent, the task waits for the configured wait from when the limit was reached", WITHIN, async (t) => {
  const waitMs = 45 * 60_000;
  const e = await line(t, { waitMs });
  const engine = await e.open([limited("one", null)]);
  const before = Date.now();
  const started = await engine.tasks.start(e.repo, "Add a file");
  await until(() => getTask(e.db, started.id)!.status === "waiting_for_limit", "the task waits for the limit");
  const at = Date.parse(getTask(e.db, started.id)!.retryAt!);
  assert.ok(at >= before + waitMs && at <= Date.now() + waitMs, `tries again at ${new Date(at).toISOString()}`);
});

test("a resumed turn that reaches the usage limit again stops the task for the owner, saying so in plain words; it does not wait a second time, and Resume takes it up", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 300 });
  const engine = await e.open([limited("one", null), limited("two", null), finishes("three")]);
  const started = await engine.tasks.start(e.repo, "Add three files");

  await until(() => getTask(e.db, started.id)!.status === "interrupted", "the task is stopped");
  const stopped = getTask(e.db, started.id)!;
  assert.equal(stopped.reason, limitAgainReason("Claude Code"));
  assert.equal(stopped.reason, "Claude Code reached its usage limit again when Botbench tried once more after waiting for it to reset, so Botbench stopped this task instead of waiting a second time. The work done up to then is committed. Resume tries again when you choose.");
  assert.equal(engine.driver.starts.length, 2);
  assert.deepEqual(filesOn(e.repo, e.base, stopped.branch!), ["one.txt", "two.txt"]);
  await pause(600);
  assert.equal(engine.driver.starts.length, 2, "no third start without the owner");
  assert.deepEqual(history(e.db, started.id).filter((s) => s === "waiting_for_limit"), ["waiting_for_limit"]);

  engine.tasks.resume(started.id);
  await until(() => getTask(e.db, started.id)!.status === "awaiting_decision", "the resumed task is ready for review");
  assert.equal(engine.driver.starts.length, 3);
});

test("a restart during the turn that resumed after the wait gives the task no second wait: reaching the limit again stops it for the owner", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 300 });
  const first = await e.open([limited("one", null), "read go; echo working; sleep 600 & wait"]);
  const started = await first.tasks.start(e.repo, "Add two files");
  await until(() => first.driver.prompts.length === 2, "the turn resumed after the wait is under way");
  await first.close();
  assert.equal(getTask(e.db, started.id)!.status, "building", "left for the next start, as any turn Botbench's stop cuts off");

  // The next start takes the turn up again once, as a restart; that turn reaches the limit again.
  const second = await e.open([limited("two", null)]);
  await until(() => getTask(e.db, started.id)!.status === "interrupted", "the task is stopped");
  const stopped = getTask(e.db, started.id)!;
  assert.equal(stopped.reason, limitAgainReason("Claude Code"));
  assert.equal(stopped.restarts, 1);
  assert.deepEqual(history(e.db, started.id).filter((s) => s === "waiting_for_limit"), ["waiting_for_limit"]);
  await pause(600);
  assert.equal(second.driver.starts.length, 1, "nothing more was started without the owner");
});

test("a restart while a task waits keeps the wait: after it the task is still waiting with the same time, and the session is resumed at that time", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 60 * 60_000 });
  const resetsAt = inMs(2000);
  const first = await e.open([limited("one", resetsAt)]);
  const started = await first.tasks.start(e.repo, "Add two files");
  await until(() => getTask(e.db, started.id)!.status === "waiting_for_limit", "the task waits for the limit");
  const attempt = getTask(e.db, started.id)!.attemptId!;
  await first.close();

  // A new Botbench over the same store.
  const second = await e.open([finishes("two")]);
  await pause(200);
  const kept = getTask(e.db, started.id)!;
  assert.equal(kept.status, "waiting_for_limit");
  assert.equal(kept.retryAt, resetsAt);
  assert.equal(second.driver.starts.length, 0);
  await until(() => getTask(e.db, started.id)!.status === "awaiting_decision", "the task is resumed and ready for review");
  assert.deepEqual(second.driver.starts, [{ resumeCursor: `session-${attempt}`, model: null }]);
  assert.ok(attemptStart(e.db, getTask(e.db, started.id)!.attemptId!) >= Date.parse(resetsAt));
  assert.equal(getTask(e.db, started.id)!.restarts, 0);
});

test("a task whose time to try again passed while Botbench was stopped is resumed at once when it starts", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 60 * 60_000 });
  const resetsAt = inMs(800);
  const first = await e.open([limited("one", resetsAt)]);
  const started = await first.tasks.start(e.repo, "Add two files");
  await until(() => getTask(e.db, started.id)!.status === "waiting_for_limit", "the task waits for the limit");
  await first.close();
  await pause(Math.max(0, Date.parse(resetsAt) - Date.now()) + 200);

  const opened = Date.now();
  const second = await e.open([finishes("two")]);
  await until(() => getTask(e.db, started.id)!.status === "awaiting_decision", "the task is resumed and ready for review", 5000);
  assert.equal(second.driver.starts.length, 1);
  assert.ok(attemptStart(e.db, getTask(e.db, started.id)!.attemptId!) - opened < 3000, "resumed at once");
});

test("a run cancelled while a task waits ends that task as cancelled with its work committed; it never resumes, also after a restart, and the run's queued task is cancelled too", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 60 * 60_000 });
  const resetsAt = inMs(1000);
  const first = await e.open([limited("one", resetsAt), finishes("two")]);
  const { runId, taskIds } = planned(e, first, "semi", ["one", "two"]);
  await until(() => getTask(e.db, taskIds[0]!)!.status === "waiting_for_limit", "the first task waits for the limit");

  first.runs.cancel(runId);
  const cancelled = getTask(e.db, taskIds[0]!)!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reason, LIMIT_CANCELLED);
  assert.deepEqual(filesOn(e.repo, e.base, cancelled.branch!), ["one.txt"]);
  assert.equal(getTask(e.db, taskIds[1]!)!.status, "cancelled");
  await pause(Math.max(0, Date.parse(resetsAt) - Date.now()) + 400);
  assert.equal(first.driver.starts.length, 1, "nothing was started after the cancel");
  await first.close();

  const second = await e.open([finishes("two")]);
  await pause(400);
  assert.equal(second.driver.starts.length, 0);
  assert.equal(getTask(e.db, taskIds[0]!)!.status, "cancelled");
  assert.equal(getRun(e.db, runId)!.status, "cancelled");
});

test("while a task waits for a usage limit, Resume and a decision on it are refused in plain words", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 60 * 60_000 });
  const engine = await e.open([limited("one", null)]);
  const started = await engine.tasks.start(e.repo, "Add a file");
  await until(() => getTask(e.db, started.id)!.status === "waiting_for_limit", "the task waits for the limit");

  assert.throws(() => engine.tasks.resume(started.id), (err: unknown) => {
    assert.ok(err instanceof TaskError);
    assert.equal(err.status, 409);
    assert.equal(err.message, "Only a stopped task, or one whose builder changed no file, can be resumed. This task is waiting for a usage limit to reset, and Botbench tries again by itself at the time it shows.");
    return true;
  });
  await assert.rejects(decideTask(e.db, { taskId: started.id, decision: "accept" }), (err: unknown) => {
    assert.ok(err instanceof TaskError);
    assert.equal(err.status, 409);
    assert.equal(err.message, `Task ${started.id} is not ready for review: it is waiting for a usage limit to reset. Only a task that is ready for review can be accepted or rejected.`);
    return true;
  });
  assert.equal(getTask(e.db, started.id)!.status, "waiting_for_limit");
});

test("the tasks queued behind a waiting task do not start until it has resumed and reached an end, and the run stays at work meanwhile, neither done nor failed", WITHIN, async (t) => {
  const e = await line(t, { waitMs: 60 * 60_000 });
  const resetsAt = inMs(1500);
  const engine = await e.open([limited("one", resetsAt), finishes("one-more"), finishes("two")]);
  const { runId, taskIds } = planned(e, engine, "semi", ["one", "two"]);
  await until(() => getTask(e.db, taskIds[0]!)!.status === "waiting_for_limit", "the first task waits for the limit");
  await engine.tasks.idle();

  assert.equal(getTask(e.db, taskIds[1]!)!.status, "queued");
  assert.equal(getRun(e.db, runId)!.status, "running");
  assert.equal(engine.driver.starts.length, 1);

  await until(() => getTask(e.db, taskIds[1]!)!.status === "awaiting_decision", "the second task is built");
  assert.equal(getTask(e.db, taskIds[0]!)!.status, "awaiting_decision");
  // The second task started only once the first had reached its end.
  const firstEnded = Date.parse(String(e.db.prepare("SELECT ts FROM task_events WHERE task_id = ? AND status = 'awaiting_decision'").get(taskIds[0]!)!.ts));
  const secondBegan = Date.parse(String(e.db.prepare("SELECT ts FROM task_events WHERE task_id = ? AND status = 'building' ORDER BY id LIMIT 1").get(taskIds[1]!)!.ts));
  assert.ok(secondBegan >= firstEnded);
  await until(() => getRun(e.db, runId)!.status === "awaiting_decision", "the run waits for decisions");
});

/** What became of a fully autonomous run's one task: its state and the reason it gives. */
async function fullRunEnd(t: T, scripts: readonly string[], checks: StationCommand[]): Promise<{ status: string; reason: string | null }> {
  const e = await line(t, { waitMs: 300, checks });
  const engine = await e.open(scripts);
  // The task names both files, so neither is a file the plan did not expect.
  const { taskIds } = planned(e, engine, "full", ["Add one.txt and two.txt"]);
  await until(() => ["accepted", "awaiting_decision", "failed", "interrupted"].includes(getTask(e.db, taskIds[0]!)!.status) && engine.driver.starts.length === scripts.length, "the task reaches an end");
  await engine.tasks.idle();
  const task = getTask(e.db, taskIds[0]!)!;
  return { status: task.status, reason: task.reason };
}

test("a fully autonomous run waits and resumes without the owner, and holds the task for the owner on exactly the conditions it would without the wait", WITHIN, async (t) => {
  // No checks ran: held for the owner, with and without a usage limit on the way.
  const direct = await fullRunEnd(t, [`read go; echo one > one.txt; echo two > two.txt; echo done`], []);
  const waited = await fullRunEnd(t, [limited("one", null), finishes("two")], []);
  assert.equal(direct.status, "awaiting_decision");
  assert.match(direct.reason ?? "", /^It needs your review: No checks ran on it\./);
  assert.deepEqual(waited, direct);
});

test("a fully autonomous run that waited for a usage limit accepts the task on exactly the conditions it would without the wait", { ...WITHIN, skip: NO_SANDBOX }, async (t) => {
  const checks = [cmd("test -f one.txt && test -f two.txt")];
  const direct = await fullRunEnd(t, [`read go; echo one > one.txt; echo two > two.txt; echo done`], checks);
  const waited = await fullRunEnd(t, [limited("one", null), finishes("two")], checks);
  assert.equal(direct.status, "accepted", direct.reason ?? "");
  assert.deepEqual(waited, direct);
});
