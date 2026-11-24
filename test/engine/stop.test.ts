import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import { processGroupAlive } from "../../src/drivers/launch.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { MAX_NOTE, taskNotes } from "../../src/engine/notes.ts";
import { approvePlan, createRun, getRun, storePlan } from "../../src/engine/run.ts";
import { createTasks, getTask, OWNER_STOPPED, resumeNote, resumeTakesNote, TaskError, type Task, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { processDriver, type ProcessDriver } from "../support/process-driver.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The owner's Stop on one working task, and a note sent with Resume, through the engine: real SQLite, a real temporary
// git repository, the real permission broker. The agent is a real process that writes a file and keeps its turn under
// way until it is stopped (test/support/process-driver.ts), which no live model does on demand. No test reads its
// events as what a CLI does.

type T = { after(fn: () => unknown): void };
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const WITHIN = { timeout: 30_000 };

async function until(ready: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}.`);
    await pause(20);
  }
}

const writesAndWaits = (file: string): string => `read go; echo ${file} > ${file}.txt; echo started; sleep 600 & wait`;
const writesAndFinishes = (file: string): string => `read go; echo ${file} > ${file}.txt; echo done`;

interface Line {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
  broker: Broker;
  tasks: Tasks;
}

async function line(t: T, driver: ProcessDriver): Promise<Line> {
  const dir = tempDir("bb-stop-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, { "README.md": "# Sample\n" });
  const broker = createBroker({ db, home, onChange: () => {} });
  const tasks = createTasks({ db, home, driver, broker, repoCommands: () => ({ setup: [], checks: [] }), onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo, base, broker, tasks };
}

/** A run of planned tasks in `mode`, its plan approved; the line builds it. */
function planned(e: Line, mode: RunMode, titles: string[]): Task[] {
  const run = createRun(e.db, { repo: e.repo, prompt: titles[0]!, baseCommit: e.base, mode, builder: null, reviewer: null, onLimit: "wait", preapproved: [] });
  const stored = storePlan(e.db, run.id, titles.map((title) => ({ title, criteria: [`${title}: done`] })));
  const tasks = approvePlan(e.db, run.id, stored.planVersion, null, mode === "full" ? "mode" : "owner").tasks;
  e.tasks.buildRun(run.id);
  return tasks;
}

const said = (db: DatabaseSync, taskId: number, text: string): boolean => {
  const attempt = getTask(db, taskId)?.attemptId;
  return attempt != null && db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND type = 'text' AND payload LIKE ?").get(attempt, `%${text}%`) !== undefined;
};
const history = (db: DatabaseSync, taskId: number): { status: string; detail: string | null }[] => db.prepare("SELECT status, detail FROM task_events WHERE task_id = ? ORDER BY id").all(taskId).map((row) => ({ status: String(row.status), detail: row.detail === null ? null : String(row.detail) }));
const filesOn = (repo: string, base: string, branch: string): string[] => git(repo, "diff", "--name-only", `${base}..${branch}`).split("\n").filter((f) => f !== "").sort();

test("Stop on a working task ends its agent's process, keeps what it wrote in the task's copy and on its branch, leaves the task Stopped with the owner's stop in its history, and the task can be resumed", WITHIN, async (t) => {
  const driver = processDriver([writesAndWaits("one"), writesAndFinishes("two")], { resume: true });
  const e = await line(t, driver);
  const task = await e.tasks.start(e.repo, "Add one.txt");
  assert.equal(e.tasks.canStop(task.id), false, "not before its agent is at work");
  await until(() => said(e.db, task.id, "started"), "the agent is at work");
  assert.equal(e.tasks.canStop(task.id), true);
  const working = getTask(e.db, task.id)!;

  await e.tasks.stop(task.id);
  await until(() => getTask(e.db, task.id)!.status === "interrupted", "the task is stopped");
  const stopped = getTask(e.db, task.id)!;
  assert.equal(stopped.reason, OWNER_STOPPED);
  assert.equal(processGroupAlive(driver.groups[0]!), false, "nothing of the agent is left running");
  // What it wrote: in the copy, which is kept, and committed to the task's branch.
  assert.equal(stopped.worktreePath, working.worktreePath);
  assert.equal(fs.readFileSync(path.join(stopped.worktreePath!, "one.txt"), "utf8"), "one\n");
  assert.deepEqual(filesOn(e.repo, e.base, stopped.branch!), ["one.txt"]);
  // The stop is in the task's history, which only ever grows: who asked, then where it left the task.
  const events = history(e.db, task.id);
  assert.ok(events.some((event) => event.status === "building" && event.detail !== null && event.detail.includes("stopped by the owner")), JSON.stringify(events));
  assert.equal(events.at(-1)!.status, "interrupted");
  assert.equal(e.tasks.canStop(task.id), false);
  assert.notEqual(resumeNote(e.db, stopped), null);
  assert.equal(resumeTakesNote(e.db, stopped), true);

  // Resumed with a note: the same session is taken up, and the note is in the agent's first message, after Botbench's own words.
  e.tasks.resume(task.id, "Name the file two.txt this time.");
  await until(() => getTask(e.db, task.id)!.status === "awaiting_decision", "the resumed task is ready for review");
  assert.deepEqual(driver.starts.map((start) => start.resumeCursor), [null, `session-${working.attemptId}`]);
  assert.ok(history(e.db, task.id).some((event) => event.detail !== null && event.detail.includes("resumed by the owner, with a note")));
  const prompt = driver.prompts[1]!;
  assert.ok(prompt.startsWith("[From Botbench, not from the owner] The owner stopped your work on this task before it finished."), prompt);
  assert.ok(prompt.endsWith("\n\nName the file two.txt this time."), prompt);
  assert.equal(driver.prompts.length, 2, "the note is not sent a second time");
  const [note] = taskNotes(e.db, task.id);
  assert.deepEqual([note!.text, note!.state, note!.attemptId], ["Name the file two.txt this time.", "delivered", getTask(e.db, task.id)!.attemptId]);
  assert.deepEqual(filesOn(e.repo, e.base, stopped.branch!), ["one.txt", "two.txt"]);
});

test("Stop is refused, with a plain reason and nothing changed, for a task that does not exist and for one whose agent is not at work", WITHIN, async (t) => {
  const driver = processDriver([writesAndFinishes("one")], { resume: true });
  const e = await line(t, driver);
  await assert.rejects(e.tasks.stop(9999), (err: unknown) => err instanceof TaskError && err.status === 404);
  const task = await e.tasks.start(e.repo, "Add one.txt");
  await until(() => getTask(e.db, task.id)!.status === "awaiting_decision", "the task is ready for review");
  await assert.rejects(e.tasks.stop(task.id), (err: unknown) => err instanceof TaskError && err.status === 409 && /Only a task whose agent is working can be stopped\. This task is ready for review\./.test(err.message));
  assert.equal(getTask(e.db, task.id)!.status, "awaiting_decision");
});

test("a stopped task of a fully autonomous run is Stopped, never accepted: the run's mode decides nothing about it, and the run goes on with its next task as after any stopped task", WITHIN, async (t) => {
  const driver = processDriver([writesAndWaits("one"), writesAndFinishes("two")], { resume: true });
  const e = await line(t, driver);
  const [first, second] = planned(e, "full", ["Add one.txt", "Add two.txt"]);
  await until(() => said(e.db, first!.id, "started"), "the agent is at work");
  await e.tasks.stop(first!.id);
  await until(() => getTask(e.db, first!.id)!.status === "interrupted", "the task is stopped");
  await e.tasks.idle();
  assert.equal(getTask(e.db, first!.id)!.status, "interrupted");
  assert.equal(e.db.prepare("SELECT 1 FROM decisions WHERE task_id = ?").get(first!.id), undefined, "no decision was made for it");
  // The second task was built in its own copy; the run is not done while the first is stopped.
  assert.notEqual(getTask(e.db, second!.id)!.status, "queued");
  assert.notEqual(getTask(e.db, second!.id)!.worktreePath, getTask(e.db, first!.id)!.worktreePath);
  assert.notEqual(getRun(e.db, first!.runId!)!.status, "done");
});

test("a note with Resume is refused when it is empty or too long, and for a task whose Resume starts no agent; nothing is resumed and nothing is stored", WITHIN, async (t) => {
  const driver = processDriver([writesAndWaits("one")], { resume: true });
  const e = await line(t, driver);
  const task = await e.tasks.start(e.repo, "Add one.txt");
  await until(() => said(e.db, task.id, "started"), "the agent is at work");
  await e.tasks.stop(task.id);
  await until(() => getTask(e.db, task.id)!.status === "interrupted", "the task is stopped");
  assert.throws(() => e.tasks.resume(task.id, "   "), (err: unknown) => err instanceof TaskError && err.status === 400);
  assert.throws(() => e.tasks.resume(task.id, "x".repeat(MAX_NOTE + 1)), (err: unknown) => err instanceof TaskError && err.status === 400 && err.message === `The note is too long: ${MAX_NOTE} characters at most.`);
  assert.equal(getTask(e.db, task.id)!.status, "interrupted");
  assert.deepEqual(taskNotes(e.db, task.id), []);

  // A task stopped in its checks: Resume runs the checks again and starts no agent, so there is nobody to read a note.
  e.db.prepare("INSERT INTO task_events (task_id, ts, status, detail) SELECT id, updated_at, 'verifying', NULL FROM tasks WHERE id = ?").run(task.id);
  e.db.prepare("INSERT INTO task_events (task_id, ts, status, detail) SELECT id, updated_at, 'interrupted', NULL FROM tasks WHERE id = ?").run(task.id);
  const inChecks = getTask(e.db, task.id)!;
  assert.equal(resumeTakesNote(e.db, inChecks), false);
  assert.throws(() => e.tasks.resume(task.id, "Try again"), (err: unknown) => err instanceof TaskError && err.status === 409 && /no agent/.test(err.message));
  assert.equal(getTask(e.db, task.id)!.status, "interrupted");
  assert.deepEqual(taskNotes(e.db, task.id), []);
});
