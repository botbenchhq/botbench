import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { summary } from "../../src/api/tasks.ts";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import { noteRoundLine, taskNoteRounds } from "../../src/engine/note-rounds.ts";
import { taskNotes } from "../../src/engine/notes.ts";
import { taskReviews } from "../../src/engine/review.ts";
import { createRun, createRuns, getRun, storePlan, type Runs } from "../../src/engine/run.ts";
import { taskEvidence, type StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, TaskError, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type AttemptScript, type BuildReplay } from "../support/replay-build.ts";
import { reviewReplayDriver, type ReviewReplay, type ReviewSession } from "../support/replay-review.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// The owner's note to a task that is ready for review (issue #156), through the engine, with real SQLite, a real
// temporary repository, the real permission broker and, where a test names them, the repository's real setup and check
// commands. No CLI is started: the builder's turns are replayed from real Claude Code sessions (test/support/replay-build.ts;
// "refine" is a real turn that changed calc.py from `a - b` to `a + b`, "done" one that changed nothing) and the
// reviewer's from real `codex exec` sessions (test/support/replay-review.ts). The store's side of the round, with no
// sandbox, is in test/note-round-checks.test.ts.

type T = { after(fn: () => unknown): void };
const TASK = [{ title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b), which returns the sum of a and b"] }];
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
// The build leaves the defect the recorded review found; the check fails on it and passes once the note's round fixes it.
const SETUP = [cmd("printf 'def add(a, b):\\n    return a - b\\n' > calc.py")];
const CHECKS = [cmd("grep -q 'a + b' calc.py")];
const NOTE = "add(a, b) must return the sum: fix calc.py so it adds.";

interface Line {
  db: DatabaseSync;
  repo: string;
  base: string;
  broker: Broker;
  builder: BuildReplay;
  reviewer: ReviewReplay;
  tasks: Tasks;
  runs: Runs;
  states: string[];
}

async function line(t: T, builds: AttemptScript[], reviews: ReviewSession[], o: { hold?: number[]; holdAt?: "prompt" | "session"; commands?: boolean } = {}): Promise<Line> {
  const dir = tempDir("botbench-note-round-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, { "README.md": "# Calculator\n" });
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(builds, { hold: o.hold ?? [], ...(o.holdAt ? { holdAt: o.holdAt } : {}) });
  const reviewer = reviewReplayDriver(reviews);
  const states: string[] = [];
  const commands = o.commands === false ? { setup: [], checks: [] } : { setup: SETUP, checks: CHECKS };
  // Rounds of fixes for a failing check, and for a review, are other loops (check-fix.test.ts, refine.test.ts): off here.
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", checkFixRounds: 0, reviewers: { codex: reviewer }, repoCommands: () => commands, onEvent: () => {}, onTaskChange: (task) => states.push(task.status) });
  const runs = createRuns({ db, home, driver: builder, broker, model: "haiku", implementerModel: "haiku", reviewers: { codex: reviewer }, line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, repo, base, broker, builder, reviewer, tasks, runs, states };
}

/** Approve a one-task run with Codex as its reviewer and no rounds of fixes for its review; returns the run and its task. */
function approved(e: Line, mode: "manual" | "semi" | "full" = "manual"): { runId: number; taskId: number } {
  const run = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Add a function", baseCommit: e.base, reviewer: { agent: "codex", model: "gpt-6-luna" }, maxRefineRounds: 0, mode }).id, TASK);
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  return { runId: run.id, taskId: tasks[0]!.id };
}

const checkRounds = (db: DatabaseSync, id: number): string[] => taskEvidence(db, id).filter((row) => row.kind === "check").map((row) => `${row.round}:${row.outcome}`);
/** The messages an attempt's session was sent, in order, as its transcript holds them: [turn, text]. */
const sentIn = (db: DatabaseSync, attemptId: number): [number, string][] =>
  db.prepare("SELECT turn, payload FROM events WHERE attempt_id = ? AND type = 'user_prompt' ORDER BY id").all(attemptId).map((row) => [Number(row.turn), String(JSON.parse(String(row.payload)).text)]);

test("a note to a task that is ready for review is the owner's words as the next prompt of the builder's own session, in the same copy under the same check; Botbench commits, runs the checks and the review again, and the task is ready for review again", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "refine"], ["review", "second-review"]);
  const { runId, taskId } = approved(e);
  await e.tasks.idle();
  const before = getTask(e.db, taskId)!;
  assert.equal(before.status, "awaiting_decision", before.reason ?? "");
  assert.equal(before.checks, "failed");
  assert.equal(getRun(e.db, runId)!.status, "awaiting_decision");
  assert.deepEqual(checkRounds(e.db, taskId), ["1:failed"]);
  const buildAttempt = before.attemptId!;

  const sent = e.tasks.sendNote(taskId, NOTE);
  assert.equal(sent.note.text, NOTE);
  assert.equal(sent.note.forRound, true);
  // On the owner's word the task is at work again at once, and so is its run.
  assert.equal(getTask(e.db, taskId)!.status, "building");
  assert.equal(getRun(e.db, runId)!.status, "running");
  await e.tasks.idle();

  const after = getTask(e.db, taskId)!;
  assert.equal(after.status, "awaiting_decision", after.reason ?? "");
  // A new builder turn, in the same copy, under the same gate and confinement, taking up the build's own session.
  assert.equal(e.builder.started.length, 2);
  const [build, round] = e.builder.started;
  assert.equal(round!.cwd, build!.cwd);
  assert.equal(round!.allowEdits, true);
  assert.ok(round!.gate !== undefined, "its requests go to the same permission check");
  assert.deepEqual(round!.confinement, build!.confinement);
  assert.equal(round!.model, "haiku");
  assert.equal(round!.resumeCursor, String(e.db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(buildAttempt)!.resume_cursor));
  // Its prompt is the note, exactly as typed, with nothing marking it as Botbench's or as outside text.
  assert.equal(e.builder.prompts[1], NOTE);
  assert.notEqual(after.attemptId, buildAttempt);
  assert.deepEqual(sentIn(e.db, after.attemptId!), [[1, NOTE]]);
  assert.deepEqual(taskNotes(e.db, taskId).map((note) => [note.state, note.attemptId, note.forRound]), [["delivered", after.attemptId, true]]);

  // A new commit with the change, new check evidence that passes and updates what the checks found, and a new review of it.
  const [first, second] = taskReviews(e.db, taskId);
  assert.notEqual(after.headCommit, before.headCommit);
  assert.match(git(e.repo, "show", `${after.headCommit}:calc.py`), /return a \+ b/);
  assert.deepEqual(checkRounds(e.db, taskId), ["1:failed", "2:passed"]);
  assert.equal(after.checks, "passed");
  assert.equal(e.reviewer.started.length, 2);
  assert.equal(first!.headCommit, before.headCommit);
  assert.equal(second!.headCommit, after.headCommit);
  assert.doesNotMatch(e.reviewer.prompts[1]!, /This is your review number 2/, "the reviewer reads the new version afresh: no round of fixes for its review came between");
  const [noted] = taskNoteRounds(e.db, taskId);
  assert.deepEqual([noted!.outcome, noted!.changed, noted!.fromCommit, noted!.headCommit, noted!.afterReviews, noted!.attemptId], ["finished", true, before.headCommit, after.headCommit, 1, after.attemptId]);
  assert.equal(noteRoundLine(e.db, after), null, "it changed the work");
  assert.equal(getRun(e.db, runId)!.status, "awaiting_decision");
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM approvals").get()!.n, 0, "nothing was asked of the owner");
});

test("a note round that changes nothing runs no checks and no review again, and the task is ready for review again with a plain line saying so", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done"], ["review"]);
  const { taskId } = approved(e);
  await e.tasks.idle();
  const before = getTask(e.db, taskId)!;
  assert.equal(before.status, "awaiting_decision");

  e.tasks.sendNote(taskId, "Is calc.py right as it is?");
  await e.tasks.idle();
  const after = getTask(e.db, taskId)!;
  assert.equal(after.status, "awaiting_decision", after.reason ?? "");
  assert.equal(e.builder.started.length, 2, "the builder's session was taken up for the note");
  assert.equal(after.headCommit, before.headCommit);
  assert.equal(after.checks, "failed", "what the checks found for this version stands");
  assert.deepEqual(checkRounds(e.db, taskId), ["1:failed"]);
  assert.equal(e.reviewer.started.length, 1);
  assert.equal(taskReviews(e.db, taskId).length, 1);
  assert.deepEqual(taskNoteRounds(e.db, taskId).map((r) => [r.outcome, r.changed]), [["finished", false]]);
  assert.equal(noteRoundLine(e.db, after), "Claude Code changed nothing for your note, so the checks and the review were not run again.");
  assert.equal(summary(e.db, after).noteRoundLine, "Claude Code changed nothing for your note, so the checks and the review were not run again.");
  // A second note is a round of its own, on the same version.
  e.tasks.sendNote(taskId, "Then leave it.");
  assert.equal(getTask(e.db, taskId)!.status, "building");
  assert.equal(summary(e.db, getTask(e.db, taskId)!).noteRoundLine, null, "the line is about a round that brought the task back");
});

test("a note round and a Resume queued behind another task's work report waiting, naming that task, in the API, then Working once their own work starts", async (t) => {
  // Task 1 builds and is ready for review ("refine" changes calc.py); task 2, started on its own, changes nothing and fails;
  // task 3 is held mid-turn. Task 1's note round and task 2's Resume then wait behind task 3.
  const e = await line(t, ["refine", "done", "done", "done", "done"], [], { hold: [2, 3], commands: false });
  const one = await e.tasks.start(e.repo, "Add a function that adds two numbers");
  await e.tasks.idle();
  assert.equal(getTask(e.db, one.id)!.status, "awaiting_decision");
  const two = await e.tasks.start(e.repo, "Tidy the README");
  await e.tasks.idle();
  assert.equal(getTask(e.db, two.id)!.status, "failed", "it changed no file, so the owner may resume it");
  const three = await e.tasks.start(e.repo, "Write the release notes");
  await e.builder.held(2);

  e.tasks.sendNote(one.id, NOTE);
  e.tasks.resume(two.id);
  for (const id of [one.id, two.id]) {
    const shown = summary(e.db, getTask(e.db, id)!);
    assert.equal(shown.status, "building");
    assert.deepEqual(shown.waitingFor, { taskId: three.id, title: "Write the release notes" }, `task ${id} waits behind task ${three.id}`);
    assert.equal(e.tasks.waitingFor(id), three.id);
  }
  assert.equal(summary(e.db, getTask(e.db, three.id)!).waitingFor, null, "the task at work waits for nothing");
  assert.equal(e.builder.started.length, 3, "nothing started beside task 3");

  // Task 3 ends; task 1's round starts and is held: it no longer waits, and task 2 now waits behind it.
  e.builder.release(2);
  await e.builder.held(3);
  const working = summary(e.db, getTask(e.db, one.id)!);
  assert.equal(working.status, "building");
  assert.equal(working.waitingFor, null);
  assert.equal(working.onNoteRound, true);
  assert.deepEqual(summary(e.db, getTask(e.db, two.id)!).waitingFor, { taskId: one.id, title: "Add a function that adds two numbers" });
  assert.equal(e.builder.prompts[3], NOTE);

  e.builder.release(3);
  await e.tasks.idle();
  assert.equal(summary(e.db, getTask(e.db, one.id)!).waitingFor, null);
  assert.equal(summary(e.db, getTask(e.db, two.id)!).waitingFor, null);
  assert.equal(getTask(e.db, one.id)!.status, "awaiting_decision");
});

test("a note to a task that is ready for review whose builder recorded no session to take up, or an empty one, is refused, stores nothing and starts nothing", async (t) => {
  const e = await line(t, ["refine"], [], { commands: false });
  const one = await e.tasks.start(e.repo, "Add a function that adds two numbers");
  await e.tasks.idle();
  assert.equal(getTask(e.db, one.id)!.status, "awaiting_decision");
  // The session it recorded is gone, as when a CLI kept none.
  e.db.prepare("UPDATE attempts SET resume_cursor = NULL WHERE id = ?").run(getTask(e.db, one.id)!.attemptId);
  assert.throws(() => e.tasks.sendNote(one.id, NOTE), (err: unknown) => err instanceof TaskError && err.status === 409 && err.message === "Claude Code recorded no session for this task to take up, so a note cannot reach it.");
  assert.throws(() => e.tasks.sendNote(one.id, "   "), (err: unknown) => err instanceof TaskError && err.status === 400);
  assert.equal(taskNotes(e.db, one.id).length, 0);
  assert.equal(getTask(e.db, one.id)!.status, "awaiting_decision");
  await e.tasks.idle();
  assert.equal(e.builder.started.length, 1);
});
