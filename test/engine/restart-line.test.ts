import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { summary } from "../../src/api/tasks.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import { CONTINUE_PROMPT } from "../../src/engine/recover.ts";
import { clockWords, createTasks, getTask, restartLine, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type AttemptScript, type BuildReplay } from "../support/replay-build.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// The one plain line a task carries when Botbench took it up again by itself after a restart (issue #156): set by the
// real recovery of a new engine over the store a stopped one left, read by the API's own summary, and cleared by the
// owner's note and by the task's end. Real SQLite, a real temporary repository and the real permission broker; the
// builder's turns are replayed from real Claude Code sessions (test/support/replay-build.ts: "refine" changes calc.py,
// "done" changes nothing). No repository command runs, so nothing here needs a sandbox of its own.

type T = { after(fn: () => unknown): void };

async function setUp(t: T) {
  const dir = tempDir("botbench-restart-line-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Calculator\n" });
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const engines: Tasks[] = [];
  /** A Botbench over this store, as a start makes one: its recovery runs at once. */
  const engine = (builder: BuildReplay): Tasks => {
    const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", onEvent: () => {}, onTaskChange: () => {} });
    engines.push(tasks);
    return tasks;
  };
  t.after(async () => {
    for (const tasks of engines) await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, repo, engine };
}

test("a building task Botbench took up again after a restart says so in one line with the time, on its summary, until the owner's note; one never restarted says nothing; at its end the line is gone", async (t) => {
  const s = await setUp(t);
  // Before: a task that finishes in the ordinary way, never restarted, and one mid-turn when Botbench stops.
  const first = buildReplayDriver(["done", ["refine", "done"]] as AttemptScript[], { hold: [1], holdAt: "session" });
  const before = s.engine(first);
  const plain = await before.start(s.repo, "Tidy the README");
  await before.idle();
  const task = await before.start(s.repo, "Add a function that adds two numbers");
  await first.held(1);
  assert.equal(summary(s.db, getTask(s.db, task.id)!).restartLine, null, "not restarted yet");
  // Botbench stops in the ordinary way while the turn runs: the task is left at building for the next start.
  await before.close();
  assert.equal(getTask(s.db, task.id)!.status, "building");

  // The next start's recovery takes it up again by itself, once; its re-driven turn is held so the line can be read.
  const second = buildReplayDriver([["refine", "done"]] as AttemptScript[], { hold: [0] });
  const after = s.engine(second);
  await second.held(0);
  assert.equal(second.prompts[0], CONTINUE_PROMPT);
  const taken = getTask(s.db, task.id)!;
  assert.equal(taken.status, "building");
  assert.equal(taken.restarts, 1);
  const at = String(s.db.prepare("SELECT ts FROM task_events WHERE task_id = ? AND detail LIKE 'Botbench restarted while this task was at work%' ORDER BY id DESC LIMIT 1").get(task.id)!.ts);
  const line = `Botbench restarted ${clockWords(new Date(at))} and took this task up again by itself.`;
  assert.match(line, /^Botbench restarted at \d\d:\d\d and took this task up again by itself\.$/);
  assert.equal(summary(s.db, taken).restartLine, line, "in the API's answer, with the time");
  assert.equal(restartLine(s.db, taken), line);
  // The task never restarted shows no such line.
  assert.equal(summary(s.db, getTask(s.db, plain.id)!).restartLine, null);

  // The owner's note to it, while it builds, clears the line: the owner has taken it up themselves.
  after.sendNote(task.id, "Keep it to one function.");
  assert.equal(summary(s.db, getTask(s.db, task.id)!).restartLine, null);

  second.release(0);
  await after.idle();
  const done = getTask(s.db, task.id)!;
  assert.equal(done.status, "awaiting_decision", done.reason ?? "");
  assert.equal(summary(s.db, done).restartLine, null, "the task reached an end");
});

test("the restart line goes when a second restart stops the task for the owner, and does not come back with the owner's Resume", async (t) => {
  const s = await setUp(t);
  const first = buildReplayDriver(["refine"] as AttemptScript[], { hold: [0], holdAt: "session" });
  const one = s.engine(first);
  const task = await one.start(s.repo, "Add a function that adds two numbers");
  await first.held(0);
  await one.close();

  // Taken up again once, by itself: the line says so. Botbench stops again during that turn.
  const second = buildReplayDriver(["refine"] as AttemptScript[], { hold: [0], holdAt: "session" });
  const two = s.engine(second);
  await second.held(0);
  assert.match(String(summary(s.db, getTask(s.db, task.id)!).restartLine), /^Botbench restarted at \d\d:\d\d and took this task up again by itself\.$/);
  await two.close();

  // A second restart stops it for the owner rather than taking it up again: it is at an end, and the line is gone.
  const third = buildReplayDriver(["refine"] as AttemptScript[], { hold: [0] });
  const three = s.engine(third);
  await three.idle();
  const stopped = getTask(s.db, task.id)!;
  assert.equal(stopped.status, "interrupted", stopped.reason ?? "");
  assert.equal(summary(s.db, stopped).restartLine, null);

  // The owner's Resume: at work again on the owner's word, with no line about a restart.
  three.resume(task.id);
  await third.held(0);
  const resumed = getTask(s.db, task.id)!;
  assert.equal(resumed.status, "building");
  assert.equal(resumed.restarts, 0);
  assert.equal(summary(s.db, resumed).restartLine, null);
  third.release(0);
  await three.idle();
  assert.equal(getTask(s.db, task.id)!.status, "awaiting_decision");
  assert.equal(summary(s.db, getTask(s.db, task.id)!).restartLine, null);
});

test("the restart line names the day as well when the restart was not today", () => {
  const at = new Date(2026, 10, 23, 9, 5);
  assert.equal(clockWords(at, new Date(2026, 10, 23, 18, 0)), "at 09:05");
  assert.equal(clockWords(at, new Date(2026, 10, 24, 8, 0)), "on Monday 23 November at 09:05");
});
