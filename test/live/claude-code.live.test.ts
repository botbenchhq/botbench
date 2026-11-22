import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { DriverUnavailableError, type DriverSession } from "../../src/drivers/contract.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { openStore } from "../../src/store/db.ts";

// These tests start the real Claude Code on the owner's login. Every prompt is
// tiny and asks for the cheapest model. Run with `npm run test:live`.

const MODEL = "haiku";
const TURN_TIMEOUT = 120_000;

function tempDir(t: TestContext, prefix: string): string {
  // The real path: Claude Code keys its sessions by the resolved working directory.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const opened = new WeakMap<DatabaseSync, DriverSession[]>();

function store(t: TestContext): DatabaseSync {
  const db = openStore(tempDir(t, "botbench-live-home-"));
  const sessions: DriverSession[] = [];
  opened.set(db, sessions);
  // Sessions write to the database as they stop, so they are closed before it.
  t.after(async () => {
    for (const session of sessions) await session.close();
    db.close();
  });
  return db;
}

/** Start an attempt that is closed before its database, whatever the test does. */
async function start(db: DatabaseSync, cwd: string, resumeCursor?: string): Promise<{ session: DriverSession; events: DriverEvent[] }> {
  const session = await new ClaudeCodeDriver().startAttempt({ db, cwd, model: MODEL, resumeCursor });
  opened.get(db)!.push(session);
  const events: DriverEvent[] = [];
  session.onEvent((event) => events.push(event));
  return { session, events };
}

const attemptRow = (db: DatabaseSync, id: number) => db.prepare("SELECT driver, model, resume_cursor, status, pgid FROM attempts WHERE id = ?").get(id)!;
const eventRows = (db: DatabaseSync, id: number) => db.prepare("SELECT turn, type, payload FROM events WHERE attempt_id = ? ORDER BY id").all(id);
const textOf = (events: DriverEvent[]): string => events.map((e) => (e.type === "text" ? e.text : "")).join(" ").toLowerCase();

/** Every process the system knows in this process group, as ps sees it. */
function processesInGroup(pgid: number): string[] {
  return execFileSync("ps", ["-A", "-o", "pgid=,pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[0]) === pgid);
}

test("live: a one-word turn yields text, usage and turn-end events in order, stored in the database", { timeout: TURN_TIMEOUT }, async (t) => {
  const db = store(t);
  const { session, events } = await start(db, tempDir(t, "botbench-live-cwd-"));

  const running = attemptRow(db, session.attemptId);
  assert.equal(running.driver, "claude-code");
  assert.equal(running.status, "running");
  assert.ok(typeof running.pgid === "number" && running.pgid > 1);
  // What the real process was started with, read back from the system.
  const [leader] = processesInGroup(running.pgid).filter((line) => Number(line.trim().split(/\s+/)[1]) === running.pgid);
  assert.match(leader ?? "", /--setting-sources project/);
  assert.match(leader ?? "", /--strict-mcp-config/);
  assert.match(leader ?? "", /--mcp-config \{"mcpServers":\{\}\}/);
  assert.doesNotMatch(leader ?? "", /dangerously/);

  const reason = await session.sendTurn("Reply with exactly the word: pong");
  assert.equal(reason, "completed");

  const types = events.map((e) => e.type);
  assert.equal(types[0], "user_prompt", "the prompt is the first event of its turn");
  assert.deepEqual(events[0], { type: "user_prompt", text: "Reply with exactly the word: pong" });
  assert.equal(types[1], "session_started");
  const text = types.indexOf("text");
  const usage = types.indexOf("usage");
  const ended = types.indexOf("turn_ended");
  assert.ok(text > 0 && text < usage && usage < ended, `expected text, usage, turn_ended in order, got ${types.join(", ")}`);
  assert.equal(ended, types.length - 1, "turn_ended is the last event of the turn");
  assert.equal(types.includes("error"), false);
  assert.match(textOf(events), /pong/);
  const usageEvent = events[usage];
  assert.ok(usageEvent?.type === "usage" && usageEvent.outputTokens > 0 && usageEvent.inputTokens + usageEvent.cacheReadTokens + usageEvent.cacheWriteTokens > 0);
  assert.equal("costUsd" in usageEvent, false, "no dollars are stored");
  assert.deepEqual(events[ended], { type: "turn_ended", reason: "completed", detail: null });

  // The database holds exactly what was emitted, in the same order, on turn 1.
  const rows = eventRows(db, session.attemptId);
  assert.deepEqual(rows.map((r) => r.type), types);
  assert.deepEqual(rows.map((r) => JSON.parse(String(r.payload))), events);
  assert.ok(rows.every((r) => r.turn === 1));

  const started = events[1];
  assert.ok(started?.type === "session_started" && started.resumeCursor.length > 0);
  const after = attemptRow(db, session.attemptId);
  assert.equal(after.resume_cursor, started.resumeCursor);
  assert.equal(session.resumeCursor(), started.resumeCursor);
  assert.match(String(after.model), /haiku/);

  await session.close();
  const closed = attemptRow(db, session.attemptId);
  assert.equal(closed.status, "ended");
  assert.equal(closed.pgid, null);
  assert.deepEqual(processesInGroup(running.pgid), []);
  await assert.rejects(session.sendTurn("again"), /has ended; start a new one/);
});

test("live: a second attempt resumed from the stored cursor recalls a word from the first", { timeout: 2 * TURN_TIMEOUT }, async (t) => {
  const db = store(t);
  const cwd = tempDir(t, "botbench-live-cwd-");

  const first = await start(db, cwd);
  assert.equal(await first.session.sendTurn("The secret word is kiwi. Reply with exactly the word: ok"), "completed");
  await first.session.close();
  const cursor = attemptRow(db, first.session.attemptId).resume_cursor;
  assert.ok(typeof cursor === "string" && cursor.length > 0);

  const second = await start(db, cwd, cursor);
  assert.notEqual(second.session.attemptId, first.session.attemptId);
  assert.equal(attemptRow(db, second.session.attemptId).resume_cursor, cursor);
  assert.equal(await second.session.sendTurn("What is the secret word? Reply with only that word."), "completed");
  assert.match(textOf(second.events), /kiwi/);
  assert.ok(eventRows(db, second.session.attemptId).some((r) => r.type === "text" && /kiwi/i.test(String(r.payload))));
});

test("live: a turn that reads a file yields a tool call, its result, then text", { timeout: TURN_TIMEOUT }, async (t) => {
  const db = store(t);
  const cwd = tempDir(t, "botbench-live-cwd-");
  fs.writeFileSync(path.join(cwd, "note.txt"), "walrus\n");
  const { session, events } = await start(db, cwd);

  assert.equal(await session.sendTurn("Read the file note.txt with the Read tool and reply with only the word it contains."), "completed");

  const call = events.find((e) => e.type === "tool_call");
  assert.ok(call?.type === "tool_call" && call.id.length > 0 && call.name.length > 0);
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result?.type === "tool_result");
  assert.equal(result.id, call.id, "the result is matched to its call");
  assert.equal(result.isError, false);
  assert.match(result.output, /walrus/);
  assert.ok(events.indexOf(call) < events.indexOf(result));
  assert.match(textOf(events.slice(events.indexOf(result))), /walrus/);
  assert.deepEqual(eventRows(db, session.attemptId).map((r) => r.type), events.map((e) => e.type));
});

test("live: interrupting a long turn ends it as interrupted and leaves no child process", { timeout: TURN_TIMEOUT }, async (t) => {
  const db = store(t);
  const { session, events } = await start(db, tempDir(t, "botbench-live-cwd-"));
  const pgid = attemptRow(db, session.attemptId).pgid as number;

  const turn = session.sendTurn("Write a 1500 word essay about rivers.");
  // Interrupt once the CLI has really begun the turn.
  await new Promise<void>((resolve) => {
    const stop = session.onEvent((event) => {
      if (event.type === "session_started") (stop(), resolve());
    });
  });
  assert.ok(processesInGroup(pgid).length > 0, "the CLI is running before the interrupt");
  await session.interruptTurn();

  assert.equal(await turn, "interrupted");
  const last = events.at(-1);
  assert.ok(last?.type === "turn_ended" && last.reason === "interrupted");
  assert.match(last.detail ?? "", /abort/, "the CLI itself confirmed the interrupt");
  assert.equal(events.filter((e) => e.type === "turn_ended").length, 1);
  assert.deepEqual(processesInGroup(pgid), [], "no process is left in the CLI's group");

  const row = attemptRow(db, session.attemptId);
  assert.equal(row.status, "interrupted");
  assert.equal(row.pgid, null);
  const rows = eventRows(db, session.attemptId);
  assert.deepEqual(JSON.parse(String(rows.at(-1)!.payload)), last);
  await assert.rejects(session.sendTurn("more"));
  await assert.rejects(session.respondToRequest("x", { decision: "allow" }), /No permission request x is waiting/);
});

test("live: the real CLI with an empty configuration directory is signed out and no turn starts", { timeout: TURN_TIMEOUT }, async (t) => {
  const db = store(t);
  const driver = new ClaudeCodeDriver({ configDir: tempDir(t, "botbench-live-config-") });

  const probe = await driver.probe();
  assert.equal(probe.installed, true);
  assert.equal(probe.supported, true);
  assert.match(probe.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(probe.signedIn, false);
  assert.equal(probe.billing, "unknown");
  assert.match(probe.problem ?? "", /signed out/);

  await assert.rejects(driver.startAttempt({ db, cwd: tempDir(t, "botbench-live-cwd-"), model: MODEL }), (err: unknown) => err instanceof DriverUnavailableError && err.probe.signedIn === false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()!.n, 0);
});

test("live: the owner's own login is reported as signed in on a subscription", { timeout: TURN_TIMEOUT }, async () => {
  const probe = await new ClaudeCodeDriver().probe();
  assert.deepEqual({ ...probe, version: null }, { installed: true, version: null, supported: true, signedIn: true, billing: "subscription", problem: null });
});
