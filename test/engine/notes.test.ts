import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { taskDecision } from "../../src/engine/decision.ts";
import { setAskEveryCommand, type RunMode } from "../../src/engine/modes.ts";
import { taskNotes, waitingNote } from "../../src/engine/notes.ts";
import { CONTINUE_PROMPT } from "../../src/engine/recover.ts";
import { createRun, createRuns, storePlan, type Runs } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, TaskError, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import type { Left, Order } from "../support/leave-running.ts";
import { buildReplayDriver, type AttemptScript, type BuildReplay } from "../support/replay-build.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// An owner's note to a task that is building (issue #78), through the engine, with real SQLite, a real temporary
// repository, the real permission broker and, where a test names them, the repository's real setup and check commands.
// No CLI is started: each builder's session is turns recorded from the real Claude Code and replayed through the driver
// contract (test/support/replay-build.ts), several turns in one session where the note is its next message. A restart is
// a real Botbench process killed where it stands (test/support/leave-running.ts) and a new engine over its data.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
const PROMPT = "Add a greeting file";
const NOTE = "Also say hello in the README, and keep it to one line.";
const ONE = [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }];
const WRITES = cmd("printf 'hi\\n' > hello.txt");
const CHECK = cmd("test -f hello.txt");

interface Line {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
  broker: Broker;
  builder: BuildReplay;
  tasks: Tasks;
  runs: Runs;
  /** Stop this Botbench in the ordinary way, as `close` on shutdown does, and close its store. Safe to call twice. */
  close(): Promise<void>;
}

async function line(t: T, script: readonly AttemptScript[], o: { hold?: readonly number[]; holdTurns?: readonly (readonly [number, number])[]; holdAt?: "prompt" | "session"; setup?: StationCommand[]; checks?: StationCommand[]; silenceLimitMs?: number; home?: string; repo?: string } = {}): Promise<Line> {
  const dir = o.home === undefined ? tempDir("botbench-notes-test-") : null;
  const home = o.home ?? path.join(dir!, "home");
  const db = openStore(home);
  const repo = o.repo ?? path.join(dir!, "repo");
  const base = o.repo === undefined ? initRepo(repo) : "";
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(script, { hold: o.hold ?? [], holdTurns: o.holdTurns ?? [], holdAt: o.holdAt ?? "prompt" });
  const repoCommands = () => ({ setup: o.setup ?? [], checks: o.checks ?? [] });
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", repoCommands, ...(o.silenceLimitMs === undefined ? {} : { silenceLimitMs: o.silenceLimitMs }), onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home, driver: builder, broker, model: "haiku", implementerModel: "haiku", line: tasks, repoCommands, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
  };
  t.after(async () => {
    await close();
    if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo, base, broker, builder, tasks, runs, close };
}

/** A run of one task in `mode`, its plan stored without a planner and approved, as its mode approves it. Its builder's first turn starts. */
function oneTask(e: Line, mode: RunMode): { runId: number; taskId: number } {
  const run = createRun(e.db, { repo: e.repo, prompt: PROMPT, baseCommit: e.base, mode });
  const stored = storePlan(e.db, run.id, ONE);
  return { runId: run.id, taskId: e.runs.approve(stored.id, stored.planVersion).tasks[0]!.id };
}

/** The messages an attempt's session was sent, in order, as its transcript holds them: [turn, text]. */
const sentIn = (db: DatabaseSync, attemptId: number): [number, string][] =>
  db.prepare("SELECT turn, payload FROM events WHERE attempt_id = ? AND type = 'user_prompt' ORDER BY id").all(attemptId).map((row) => [Number(row.turn), String(JSON.parse(String(row.payload)).text)]);
const transcriptHas = (db: DatabaseSync, text: string): number => db.prepare("SELECT payload FROM events WHERE type = 'user_prompt'").all().filter((row) => JSON.parse(String(row.payload)).text === text).length;
const states = (db: DatabaseSync, taskId: number) => taskNotes(db, taskId).map((note) => [note.text, note.state]);
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a note sent while the builder works is its next message in the same attempt and session, in the owner's own words, after its first message and before the work is committed and checked", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, [["done", "done"]], { hold: [0], setup: [WRITES], checks: [CHECK] });
  const task = await e.tasks.start(e.repo, PROMPT);
  await e.builder.held(0);
  const attemptId = getTask(e.db, task.id)!.attemptId!;

  const sent = e.tasks.sendNote(task.id, NOTE);
  assert.equal(sent.note.text, NOTE);
  assert.equal(sent.note.state, "waiting");
  assert.equal(sent.replaced, null);
  assert.equal(waitingNote(e.db, task.id)?.text, NOTE);
  // A note still waiting is not in the transcript.
  assert.equal(transcriptHas(e.db, NOTE), 0);

  e.builder.release(0);
  await e.tasks.idle();
  const done = getTask(e.db, task.id)!;
  assert.equal(done.status, "awaiting_decision", done.reason ?? "");
  assert.equal(done.checks, "passed");
  // One attempt, one session: the note went to the session the task was working in, not a new task or a fresh one.
  assert.equal(e.builder.started.length, 1);
  assert.equal(done.attemptId, attemptId);
  assert.equal(e.builder.closed(), 1);
  assert.deepEqual(e.builder.prompts, [PROMPT, NOTE], "the owner's words exactly, with nothing marking them as outside text or as Botbench's");
  // The delivered note is in the transcript as the owner's message of the attempt's second turn, stored with its other events.
  assert.deepEqual(sentIn(e.db, attemptId), [[1, PROMPT], [2, NOTE]]);
  const delivered = taskNotes(e.db, task.id);
  assert.deepEqual(delivered.map((note) => [note.state, note.attemptId]), [["delivered", attemptId]]);
  assert.equal(waitingNote(e.db, task.id), null);

  // The order: the first turn ended, then the note's turn ran and ended, and only then were the checks started.
  const ends = e.db.prepare("SELECT id, turn, ts FROM events WHERE attempt_id = ? AND type = 'turn_ended' ORDER BY id").all(attemptId).map((row) => ({ id: Number(row.id), turn: Number(row.turn), ts: String(row.ts) }));
  assert.deepEqual(ends.map((end) => end.turn), [1, 2]);
  const noteSent = Number(e.db.prepare("SELECT id FROM events WHERE attempt_id = ? AND type = 'user_prompt' AND turn = 2").get(attemptId)!.id);
  assert.ok(ends[0]!.id < noteSent && noteSent < ends[1]!.id, "the note is sent once the first turn has ended");
  const checking = e.db.prepare("SELECT ts FROM task_events WHERE task_id = ? AND status = 'verifying' ORDER BY id LIMIT 1").get(task.id);
  assert.ok(checking !== undefined, "the checks ran");
  assert.ok(String(checking.ts) >= ends[1]!.ts, "the checks start after the note's turn ended");
  assert.ok(String(e.db.prepare("SELECT started_at AS at FROM evidence WHERE task_id = ? AND kind = 'check' ORDER BY id LIMIT 1").get(task.id)!.at) >= ends[1]!.ts);
});

test("a second note before delivery replaces the first, which is kept as replaced; a note that arrives during the note's own turn is delivered the same way, after it", async (t) => {
  const e = await line(t, [["done", "done", "done"]], { hold: [0], holdTurns: [[0, 1]] });
  const task = await e.tasks.start(e.repo, PROMPT);
  await e.builder.held(0);
  const first = e.tasks.sendNote(task.id, "Use British spelling.");
  const second = e.tasks.sendNote(task.id, NOTE);
  assert.equal(second.replaced?.id, first.note.id);
  assert.deepEqual(states(e.db, task.id), [["Use British spelling.", "replaced"], [NOTE, "waiting"]]);
  assert.equal(waitingNote(e.db, task.id)?.text, NOTE);

  e.builder.release(0);
  await e.builder.held(0, 1);
  // The note's turn is under way: the next note waits for it to end.
  assert.equal(getTask(e.db, task.id)!.status, "building");
  const third = e.tasks.sendNote(task.id, "And a line in the changelog.");
  assert.equal(third.replaced, null, "the delivered note is not replaced");
  assert.equal(transcriptHas(e.db, "And a line in the changelog."), 0);
  e.builder.release(0, 1);
  await e.tasks.idle();

  assert.deepEqual(e.builder.prompts, [PROMPT, NOTE, "And a line in the changelog."]);
  assert.equal(e.builder.started.length, 1);
  const attemptId = getTask(e.db, task.id)!.attemptId!;
  assert.deepEqual(sentIn(e.db, attemptId).map(([turn]) => turn), [1, 2, 3]);
  assert.deepEqual(states(e.db, task.id), [["Use British spelling.", "replaced"], [NOTE, "delivered"], ["And a line in the changelog.", "delivered"]]);
  // The replaced note was never sent.
  assert.equal(transcriptHas(e.db, "Use British spelling."), 0);
});

test("a note to a task that is not building, or to none, is refused with the reason and nothing is stored", async (t) => {
  const e = await line(t, [["done"]]);
  assert.throws(() => e.tasks.sendNote(99, NOTE), (err: unknown) => err instanceof TaskError && err.status === 404 && err.message === "No such task.");
  const task = await e.tasks.start(e.repo, PROMPT);
  await e.tasks.idle();
  // The replayed turn changed nothing, so the task failed: a note can no longer reach its builder.
  assert.equal(getTask(e.db, task.id)!.status, "failed");
  assert.throws(() => e.tasks.sendNote(task.id, NOTE), (err: unknown) => err instanceof TaskError && err.status === 409 && /^This task failed, so a note can no longer reach Claude Code\./.test(err.message));
  assert.deepEqual(taskNotes(e.db, task.id), []);
});

test("a waiting note is not sent when the turn does not complete: a cancelled run, a silent builder and an error each mark it not delivered, saying why", async (t) => {
  // A cancelled run.
  const cancel = await line(t, [["done", "done"]], { hold: [0] });
  const planned = oneTask(cancel, "manual");
  await cancel.builder.held(0);
  cancel.tasks.sendNote(planned.taskId, NOTE);
  cancel.runs.cancel(planned.runId);
  await cancel.tasks.idle();
  assert.equal(getTask(cancel.db, planned.taskId)!.status, "cancelled");
  assert.equal(cancel.builder.prompts.length, 1, "only the task's own prompt was sent");
  assert.equal(transcriptHas(cancel.db, NOTE), 0);
  const [cancelled] = taskNotes(cancel.db, planned.taskId);
  assert.deepEqual([cancelled!.state, cancelled!.reason], ["not_delivered", "The run was cancelled before Claude Code finished, so your note was not sent."]);

  // A builder that went silent and was stopped.
  const silent = await line(t, [["done", "done"]], { hold: [0], silenceLimitMs: 200 });
  const quiet = await silent.tasks.start(silent.repo, PROMPT);
  await silent.builder.held(0);
  silent.tasks.sendNote(quiet.id, NOTE);
  await silent.tasks.idle();
  assert.equal(getTask(silent.db, quiet.id)!.status, "interrupted");
  assert.deepEqual(silent.builder.prompts, [PROMPT]);
  assert.match(taskNotes(silent.db, quiet.id)[0]!.reason!, /^Claude Code went silent and was stopped before it finished, so your note was not sent\./);
  assert.equal(transcriptHas(silent.db, NOTE), 0);

  // A turn that ended with an error. The recorded "ask" turn continues only after an allow; denied, the replay ends the
  // turn with an error of its own, which stands here for any turn that ended with one (it is not read as what the CLI does).
  const failing = await line(t, [["ask", "done"]]);
  setAskEveryCommand(failing.db, true);
  const asking = await failing.tasks.start(failing.repo, PROMPT);
  await until("the builder asks", () => listApprovals(failing.db, "pending").length > 0);
  failing.tasks.sendNote(asking.id, NOTE);
  failing.broker.answer(listApprovals(failing.db, "pending")[0]!.id, "decline");
  await failing.tasks.idle();
  assert.equal(getTask(failing.db, asking.id)!.status, "failed");
  assert.deepEqual(failing.builder.prompts, [PROMPT]);
  assert.equal(taskNotes(failing.db, asking.id)[0]!.reason, "Claude Code ended with an error before it finished, so your note was not sent.");
});

test("Botbench stopping while a note waits marks it not delivered; the next start takes the task up again and does not send it, and the note is still there with its reason", async (t) => {
  const dir = tempDir("botbench-notes-stop-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const first = await line(t, [["done", "done"]], { hold: [0], holdAt: "session", home, repo });
  const task = await first.tasks.start(repo, PROMPT);
  await first.builder.held(0);
  first.tasks.sendNote(task.id, NOTE);
  await first.close();
  const kept = openStore(home);
  assert.equal(getTask(kept, task.id)!.status, "building", "left for the next start");
  assert.deepEqual(states(kept, task.id), [[NOTE, "not_delivered"]]);
  assert.equal(taskNotes(kept, task.id)[0]!.reason, "Botbench stopped before Claude Code finished, so your note was not sent. You can send it again once the task is working.");
  kept.close();

  const again = await line(t, [["done"]], { home, repo });
  await again.tasks.idle();
  assert.deepEqual(again.builder.prompts, [CONTINUE_PROMPT], "the task is taken up again, and the note is not sent");
  assert.deepEqual(states(again.db, task.id), [[NOTE, "not_delivered"]]);
  assert.equal(transcriptHas(again.db, NOTE), 0);
});

const LEAVE = path.resolve(import.meta.dirname, "..", "support", "leave-running.ts");
/** Run a real Botbench to the point `order` names and kill it there, as a crash would. */
function leave(home: string, repo: string, order: Omit<Order, "home" | "repo">): Left {
  const run = spawnSync(process.execPath, [LEAVE, JSON.stringify({ home, repo, ...order })], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.signal, "SIGKILL", `the Botbench that stops is killed where it stands: ${run.stderr}`);
  return JSON.parse(run.stdout) as Left;
}

test("a restart does not lose a waiting note and does not send one twice: killed with a note waiting, the next start delivers it once after the turn it takes up; killed during the note's own turn, it is not sent again", { timeout: 60_000 }, async (t) => {
  const dir = tempDir("botbench-notes-restart-");

  // Killed while the note waits for the first turn to end.
  const waitingHome = path.join(dir, "waiting", "home");
  const waitingRepo = path.join(dir, "waiting", "repo");
  initRepo(waitingRepo);
  const left = leave(waitingHome, waitingRepo, { task: PROMPT, script: [["done"]], hold: 0, holdAt: "session", note: NOTE, stopAt: "turn" });
  const [taskId] = left.taskIds as [number];
  const taken = await line(t, [["done", "done"]], { home: waitingHome, repo: waitingRepo });
  await taken.tasks.idle();
  assert.deepEqual(taken.builder.prompts, [CONTINUE_PROMPT, NOTE], "taken up in its session, then the note, once");
  const resumed = getTask(taken.db, taskId)!.attemptId!;
  assert.notEqual(resumed, left.attemptId);
  assert.deepEqual(taskNotes(taken.db, taskId).map((note) => [note.state, note.attemptId]), [["delivered", resumed]]);
  assert.equal(transcriptHas(taken.db, NOTE), 1);

  // Killed while the note's own turn was under way: it was delivered then, and is not sent a second time.
  const sentHome = path.join(dir, "sent", "home");
  const sentRepo = path.join(dir, "sent", "repo");
  initRepo(sentRepo);
  const during = leave(sentHome, sentRepo, { task: PROMPT, script: [["done", "done"]], hold: 0, holdTurn: 1, holdAt: "session", note: NOTE, stopAt: "turn" });
  const [sentTask] = during.taskIds as [number];
  const after = await line(t, [["done"]], { home: sentHome, repo: sentRepo });
  await after.tasks.idle();
  assert.deepEqual(after.builder.prompts, [CONTINUE_PROMPT]);
  assert.deepEqual(taskNotes(after.db, sentTask).map((note) => [note.state, note.attemptId]), [["delivered", during.attemptId]]);
  assert.equal(transcriptHas(after.db, NOTE), 1, "the note is in the transcript once, in the session it was sent to");
});

test("the note's turn asks through the permission check as the build does: a semi-autonomous run's confined command runs on the mode's rule, logged under the same attempt", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, [["done", "ask"]], { hold: [0], setup: [WRITES], checks: [CHECK] });
  const { taskId } = oneTask(e, "semi");
  await e.builder.held(0);
  e.tasks.sendNote(taskId, NOTE);
  e.builder.release(0);
  await e.tasks.idle();
  const task = getTask(e.db, taskId)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(e.builder.prompts[1], NOTE);
  assert.equal(listApprovals(e.db).length, 0, "nothing was put to the owner");
  const ran = actionLog(e.db, taskId).filter((entry) => entry.rule === "mode_allowed");
  assert.deepEqual(ran.map((entry) => [entry.command, entry.attemptId]), [["sh other.sh", task.attemptId]]);
  assert.equal(taskDecision(e.db, taskId), null, "the owner still decides");
});

test("the note's turn asks through the permission check as the build does: in a manual run with Ask before every command on, its command waits for the owner's answer", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, [["done", "ask"]], { hold: [0], setup: [WRITES], checks: [CHECK] });
  setAskEveryCommand(e.db, true);
  const { taskId } = oneTask(e, "manual");
  await e.builder.held(0);
  e.tasks.sendNote(taskId, NOTE);
  e.builder.release(0);
  await until("the note's turn asks the owner", () => listApprovals(e.db, "pending").length > 0);
  const pending = listApprovals(e.db, "pending");
  assert.deepEqual(pending.map((a) => [a.taskId, a.command, a.attemptId, a.asksBecause]), [[taskId, "sh other.sh", getTask(e.db, taskId)!.attemptId, "Ask before every command is on in Settings."]]);
  e.broker.answer(pending[0]!.id, "allow");
  await e.tasks.idle();
  assert.equal(getTask(e.db, taskId)!.status, "awaiting_decision");
  assert.deepEqual(actionLog(e.db, taskId).filter((entry) => entry.rule === "owner_allowed").map((entry) => entry.command), ["sh other.sh"]);
});

test("a fully autonomous run honours the note the same way: what its turn asks that the safety rules name is still refused without asking anyone, and not run", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, [["done", "refused"]], { hold: [0], setup: [WRITES], checks: [CHECK] });
  const { taskId } = oneTask(e, "full");
  await e.builder.held(0);
  e.tasks.sendNote(taskId, NOTE);
  e.builder.release(0);
  await e.tasks.idle();
  const task = getTask(e.db, taskId)!;
  assert.equal(e.builder.prompts[1], NOTE);
  assert.equal(listApprovals(e.db).length, 0, "nobody was asked");
  const refused = actionLog(e.db, taskId).filter((entry) => entry.rule === "mode_refused");
  assert.deepEqual(refused.map((entry) => [entry.command, entry.attemptId, entry.refusal]), [["git push origin HEAD", task.attemptId, "floor"]]);
  const told = e.db.prepare("SELECT payload FROM events WHERE type = 'permission_resolved' AND attempt_id = ?").all(task.attemptId!).map((row) => JSON.parse(String(row.payload)).decision);
  assert.deepEqual(told, ["denied"]);
  assert.equal(task.status, "awaiting_decision", "not accepted with a refusal on the safety rules");
  assert.equal(taskDecision(e.db, taskId), null);
});
