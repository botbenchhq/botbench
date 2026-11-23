import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { chatHistory } from "../../src/api/chat.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { killProcessGroup, processGroupAlive } from "../../src/drivers/launch.ts";
import { RESTART_STOPPED } from "../../src/engine/recover.ts";
import { createTasks } from "../../src/engine/task.ts";
import { now, openStore } from "../../src/store/db.ts";
import { RESTART_STOPPED as SHOWN } from "../../web/src/api/client.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { tempDir } from "../support/repo.ts";
import { NO_PROCESS_LIST } from "../support/confined.ts";

// A chat or review turn a restart cut off (Codex, Grok, Antigravity: one CLI process for one turn, src/drivers/one-turn.ts).
// The process left behind is real: a child in its own process group, recorded on an attempt the way the one-turn session
// records its CLI. The store is real SQLite, opened again for the next start, whose start-up recovery is the real
// engine's. No CLI is started and nothing is replayed: recovery reads only the rows and the process.

type T = { after(fn: () => unknown): void };

function home(t: T): string {
  const dir = tempDir("botbench-turn-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "home");
}

/** A real process in a group of its own, as `launch` starts a CLI, stopped after the test whatever it found. */
function realGroup(t: T): number {
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  child.unref();
  const pgid = child.pid!;
  t.after(() => killProcessGroup(pgid).catch(() => {}));
  return pgid;
}

/**
 * A moment ago: recovery takes up only rows from before its start (`created_at < began`), and a row written in the same
 * millisecond as that start would be read as this start's own. A second is well inside the slack a CLI's start is given.
 */
const justBefore = (): string => new Date(Date.now() - 1000).toISOString();

/** The rows a one-turn session writes once its CLI is started and the prompt is sent: a running attempt with its group, the prompt, what came back so far. */
function oneTurnAttempt(db: DatabaseSync, o: { driver: string; pgid: number | null; createdAt?: string; chat?: string }): number {
  const at = o.createdAt ?? justBefore();
  const id = Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, NULL, NULL, 'running', ?, ?, ?)").run(o.driver, o.pgid, at, at).lastInsertRowid);
  const record = (event: DriverEvent): void => void db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(id, now(), event.type, JSON.stringify(event));
  record({ type: "user_prompt", text: "[From Botbench] framed prompt" });
  record({ type: "text", text: "Blue. It is" });
  if (o.chat !== undefined) {
    const round = Number(db.prepare("INSERT INTO chat_rounds (kind, message, compares, created_at) VALUES ('ask', ?, NULL, ?)").run(o.chat, at).lastInsertRowid);
    db.prepare("INSERT INTO chat_attempts (attempt_id, round_id, created_at) VALUES (?, ?, ?)").run(id, round, at);
  }
  return id;
}

/** The next start on the same data folder: the store opened again, a new broker, and the task engine, whose start-up recovery runs. */
async function startAgain(t: T, dir: string): Promise<DatabaseSync> {
  const db = openStore(dir);
  const broker = createBroker({ db, home: dir, onChange: () => {} });
  await broker.listen();
  const tasks = createTasks({ db, home: dir, driver: buildReplayDriver([]), broker, onEvent: () => {}, onTaskChange: () => {} });
  await tasks.idle();
  await tasks.close();
  await broker.close();
  t.after(() => db.close());
  return db;
}

const events = (db: DatabaseSync, id: number): { turn: number; payload: DriverEvent }[] =>
  db.prepare("SELECT turn, payload FROM events WHERE attempt_id = ? ORDER BY id").all(id).map((r) => ({ turn: Number(r.turn), payload: JSON.parse(String(r.payload)) as DriverEvent }));
const ends = (db: DatabaseSync, id: number) => events(db, id).filter((e) => e.payload.type === "turn_ended");
const attempt = (db: DatabaseSync, id: number) => ({ ...db.prepare("SELECT status, pgid FROM attempts WHERE id = ?").get(id) });
const STOPPED = { turn: 1, payload: { type: "turn_ended", reason: "interrupted", detail: RESTART_STOPPED } };

test("a chat turn and a review turn cut off by a restart: their CLI groups are stopped, the record is cleared, and each turn ends as stopped because Botbench restarted, once", { skip: NO_PROCESS_LIST, timeout: 30_000 }, async (t) => {
  const dir = home(t);
  const chatGroup = realGroup(t);
  const reviewGroup = realGroup(t);
  const before = openStore(dir);
  // Each recorded just after its CLI started, as `sendTurn` does.
  const chat = oneTurnAttempt(before, { driver: "grok", pgid: chatGroup, chat: "Name a colour" });
  const review = oneTurnAttempt(before, { driver: "codex", pgid: reviewGroup });
  before.close();
  assert.ok(processGroupAlive(chatGroup) && processGroupAlive(reviewGroup), "both CLIs outlived their Botbench");

  const db = await startAgain(t, dir);
  assert.equal(processGroupAlive(chatGroup), false, "the chat turn's process is gone");
  assert.equal(processGroupAlive(reviewGroup), false, "the review turn's process is gone");
  for (const id of [chat, review]) {
    assert.deepEqual(attempt(db, id), { status: "interrupted", pgid: null });
    assert.deepEqual(ends(db, id), [STOPPED], "one closing event, in the turn that was cut off");
    assert.equal(events(db, id).at(-1)!.payload.type, "turn_ended", "and it closes the turn");
  }
  // The chat as it is passed on keeps what was said; the stop adds no words of its own.
  assert.deepEqual(chatHistory(db, [chat]), [{ from: "owner", text: "Name a colour" }, { from: "Grok (its default model)", text: "Blue. It is" }]);
  // The screens show the detail as it is stored, by the same words.
  assert.equal(SHOWN, RESTART_STOPPED);

  // A further start adds nothing: the attempts no longer run.
  const third = await startAgain(t, dir);
  for (const id of [chat, review]) assert.deepEqual(ends(third, id), [STOPPED]);
});

test("a recorded group whose number now belongs to an unrelated process is not killed, and the turn is still recorded as stopped with the record cleared", { skip: NO_PROCESS_LIST, timeout: 30_000 }, async (t) => {
  const dir = home(t);
  // A real process that began an hour after the attempt was recorded, as one given the number again would.
  const stranger = realGroup(t);
  const before = openStore(dir);
  const id = oneTurnAttempt(before, { driver: "codex", pgid: stranger, createdAt: new Date(Date.now() - 3_600_000).toISOString(), chat: "Name a colour" });
  before.close();

  const db = await startAgain(t, dir);
  assert.equal(processGroupAlive(stranger), true, "the unrelated process runs on");
  assert.deepEqual(attempt(db, id), { status: "interrupted", pgid: null }, "and the attempt no longer names it");
  assert.deepEqual(ends(db, id), [STOPPED]);
});

test("a turn whose process number was never written down, or was cleared before its end was, is recorded as stopped too", { timeout: 30_000 }, async (t) => {
  const dir = home(t);
  const before = openStore(dir);
  const id = oneTurnAttempt(before, { driver: "antigravity", pgid: null, chat: "Name a colour" });
  before.close();
  const db = await startAgain(t, dir);
  assert.deepEqual(attempt(db, id), { status: "interrupted", pgid: null });
  assert.deepEqual(ends(db, id), [STOPPED]);
});

test("an attempt that ended in the ordinary way gets no stopped event: one whose turn has its end, and one no longer running", { skip: NO_PROCESS_LIST, timeout: 30_000 }, async (t) => {
  const dir = home(t);
  const group = realGroup(t);
  const before = openStore(dir);
  // Its turn ended, and its process was still being cleared up when Botbench stopped.
  const answered = oneTurnAttempt(before, { driver: "codex", pgid: group, chat: "Name a colour" });
  const end: DriverEvent = { type: "turn_ended", reason: "completed", detail: null };
  before.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(answered, now(), end.type, JSON.stringify(end));
  // Its status says it ended, though no end event was stored for it.
  const over = oneTurnAttempt(before, { driver: "grok", pgid: null, chat: "Name a colour" });
  before.prepare("UPDATE attempts SET status = 'failed' WHERE id = ?").run(over);
  // A session that had reported itself and been sent nothing: it had no turn to cut off.
  const at = justBefore();
  const unsent = Number(before.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', NULL, 'c', 'running', NULL, ?, ?)").run(at, at).lastInsertRowid);
  const started: DriverEvent = { type: "session_started", resumeCursor: "c", model: null, keySource: null };
  before.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 0, ?, ?, ?)").run(unsent, at, started.type, JSON.stringify(started));
  before.close();

  const db = await startAgain(t, dir);
  assert.equal(processGroupAlive(group), false, "what was left of it is stopped all the same");
  // Nothing of it runs any more (the attempt was marked so before this change too), and its finished turn is left as it ended.
  assert.deepEqual(attempt(db, answered), { status: "interrupted", pgid: null });
  assert.deepEqual(ends(db, answered).map((e) => e.payload), [end]);
  assert.deepEqual(attempt(db, over), { status: "failed", pgid: null });
  assert.deepEqual(ends(db, over), []);
  assert.deepEqual(attempt(db, unsent), { status: "interrupted", pgid: null });
  assert.deepEqual(ends(db, unsent), []);
});
