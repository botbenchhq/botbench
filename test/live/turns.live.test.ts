import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";

// These tests start the real Claude Code on the owner's login, through Smelt's
// HTTP API. Every prompt is tiny and asks for the cheapest model.

const TURN_TIMEOUT = 180_000;
const JSON_TYPE = { "content-type": "application/json" };

async function start(t: TestContext, options: { idleCloseMs?: number } = {}): Promise<{ server: SmeltServer; base: string; headers: Record<string, string>; home: string }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smelt-live-turns-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } } };
  const server = await startServer({ config, home, signInDelayMs: 1, ...options });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

/** Read the real event stream and collect what it carries. */
async function openStream(t: TestContext, base: string, headers: Record<string, string>, query = ""): Promise<{ events: StoredEvent[]; sseIds: string[]; until(done: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]>; close(): void }> {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const res = await fetch(`${base}/api/stream${query}`, { headers, signal: abort.signal });
  assert.equal(res.status, 200);
  const events: StoredEvent[] = [];
  const sseIds: string[] = [];
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const data = lines.find((l) => l.startsWith("data: "));
          // Named events are heartbeats, not stored events.
          if (!data || lines.some((l) => l.startsWith("event: "))) continue;
          events.push(JSON.parse(data.slice(6)) as StoredEvent);
          sseIds.push(lines.find((l) => l.startsWith("id: "))?.slice(4) ?? "");
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  const until = async (done: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]> => {
    const deadline = Date.now() + TURN_TIMEOUT - 30_000;
    while (!done(events)) {
      if (Date.now() > deadline) throw new Error(`the stream did not deliver what was expected; got ${events.map((e) => `${e.attemptId}:${e.type}`).join(", ")}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return [...events];
  };
  return { events, sseIds, until, close: () => abort.abort() };
}

async function sendTurn(base: string, headers: Record<string, string>, prompt: string, attemptId?: number): Promise<{ attemptId: number; turn: number }> {
  const res = await fetch(`${base}/api/turns`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify({ prompt, ...(attemptId === undefined ? {} : { attemptId }) }) });
  const body = (await res.json()) as { attemptId: number; turn: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

const transcript = async (base: string, headers: Record<string, string>, attemptId: number, after?: number) =>
  (await (await fetch(`${base}/api/attempts/${attemptId}/events${after === undefined ? "" : `?after=${after}`}`, { headers })).json()) as { status: string; turnRunning: boolean; events: StoredEvent[] };

const ended = (attemptId: number, turn: number) => (events: StoredEvent[]) => events.some((e) => e.attemptId === attemptId && e.turn === turn && e.type === "turn_ended");
const textOf = (events: StoredEvent[]): string => events.map((e) => (e.payload.type === "text" ? e.payload.text : "")).join(" ").toLowerCase();

/** Every `claude` process working in the given directory's scratch space, as ps sees it. */
function cliProcesses(pgid: number): string[] {
  return execFileSync("ps", ["-A", "-o", "pgid=,pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[0]) === pgid);
}

test("live: the driver's state is reported, and a turn started through the API streams its events in order", { timeout: TURN_TIMEOUT }, async (t) => {
  const { server, base, headers, home } = await start(t);

  const driver = (await (await fetch(`${base}/api/driver`, { headers })).json()) as Record<string, unknown>;
  assert.deepEqual({ ...driver, version: null }, { driver: "claude-code", installed: true, version: null, supported: true, signedIn: true, billing: "subscription", problem: null });
  assert.match(String(driver.version), /^\d+\.\d+\.\d+$/);

  const stream = await openStream(t, base, headers);
  const prompt = "Reply with exactly the word: pong";
  const started = await sendTurn(base, headers, prompt);
  assert.ok(Number.isInteger(started.attemptId) && started.attemptId > 0);
  assert.equal(started.turn, 1);

  // The turn is running while the reply is awaited, and the CLI works in the scratch directory, not in this repository.
  const row = server.db.prepare("SELECT driver, model, status, pgid FROM attempts WHERE id = ?").get(started.attemptId)!;
  assert.equal(row.driver, "claude-code");
  assert.equal(row.status, "running");
  const pgid = Number(row.pgid);
  const cwd = execFileSync("lsof", ["-a", "-p", String(pgid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  assert.match(cwd, new RegExp(`n${fs.realpathSync(path.join(home, "scratch"))}\\n`));
  assert.match(cliProcesses(pgid).join("\n"), /--model haiku/);

  const events = (await stream.until(ended(started.attemptId, 1))).filter((e) => e.attemptId === started.attemptId);
  const types = events.map((e) => e.type);
  assert.equal(types[0], "user_prompt");
  assert.deepEqual(events[0]!.payload, { type: "user_prompt", text: prompt });
  const text = types.indexOf("text");
  const usage = types.indexOf("usage");
  const end = types.indexOf("turn_ended");
  assert.ok(text > 0 && text < usage && usage < end, `expected user_prompt, text, usage, turn_ended in order, got ${types.join(", ")}`);
  assert.equal(end, types.length - 1);
  assert.deepEqual(events[end]!.payload, { type: "turn_ended", reason: "completed", detail: null });
  assert.match(textOf(events), /pong/);
  assert.ok(events.every((e) => e.turn === 1 && e.type === e.payload.type));
  // Ids rise strictly, and the SSE id of each frame is the event's row id.
  assert.deepEqual(stream.sseIds, stream.events.map((e) => String(e.id)));
  assert.ok(events.every((e, i) => i === 0 || e.id > events[i - 1]!.id));

  // The stream carried exactly what is stored.
  const stored = await transcript(base, headers, started.attemptId);
  assert.deepEqual(stored.events, events);
  assert.equal(stored.turnRunning, false);

  // Closing the server leaves no CLI process behind.
  assert.ok(cliProcesses(pgid).length > 0, "the session is still open after its turn");
  await server.close();
  assert.deepEqual(cliProcesses(pgid), []);
});

test("live: a late client fetches the transcript, then gets only new events; a reconnect with Last-Event-ID has no gaps and no repeats; a closed attempt is resumed", { timeout: 2 * TURN_TIMEOUT }, async (t) => {
  // A short idle time, so the first attempt's CLI process is closed before the second turn and has to be resumed.
  const { server, base, headers } = await start(t, { idleCloseMs: 300 });

  const first = await sendTurn(base, headers, "The secret word is kiwi. Reply with exactly the word: ok");
  const watcher = await openStream(t, base, headers);
  await watcher.until(ended(first.attemptId, 1));
  watcher.close();

  // A client that arrives after the turn: the whole transcript, in order.
  const full = await transcript(base, headers, first.attemptId);
  assert.deepEqual(full.events.map((e) => e.type).filter((type) => ["user_prompt", "text", "turn_ended"].includes(type)), ["user_prompt", "text", "turn_ended"]);
  const lastSeen = full.events.at(-1)!.id;

  // The idle session is closed and its process gone, so continuing means resuming from the cursor.
  const closed = (): boolean => server.db.prepare("SELECT status FROM attempts WHERE id = ?").get(first.attemptId)!.status === "ended";
  const deadline = Date.now() + 20_000;
  while (!closed() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed(), true, "the idle session was closed");

  // It then opens the stream from where the transcript ended, and stays on it through the next turn.
  const late = await openStream(t, base, headers, `?after=${lastSeen}`);
  const second = await sendTurn(base, headers, "What is the secret word? Reply with only that word.", first.attemptId);
  assert.notEqual(second.attemptId, first.attemptId, "a resumed session is a new attempt");
  assert.equal(second.turn, 1);
  const live = await late.until(ended(second.attemptId, 1));
  const stored = await transcript(base, headers, second.attemptId);
  assert.deepEqual(live, stored.events, "the late client got the new turn's events and nothing older");
  late.close();

  // A browser that lost the stream part-way reconnects with the id of the last event it received.
  const cut = Math.floor(stored.events.length / 2);
  const resumed = await openStream(t, base, { ...headers, "last-event-id": String(stored.events[cut - 1]!.id) }, `?after=${lastSeen}`);
  const got = await resumed.until((events) => events.length >= stored.events.length - cut);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(resumed.events, stored.events.slice(cut), "exactly the events after the last one seen");
  assert.deepEqual([...live.slice(0, cut), ...got], stored.events, "together: no gap and no repeat");
  assert.match(textOf(stored.events), /kiwi/, "the resumed attempt recalls the first turn");
  // The first attempt's transcript is unchanged.
  assert.deepEqual((await transcript(base, headers, first.attemptId)).events, full.events);
  assert.deepEqual((await transcript(base, headers, first.attemptId, lastSeen)).events, []);
});

test("live: a running turn is stopped through the API, and a second prompt to a busy attempt is refused", { timeout: TURN_TIMEOUT }, async (t) => {
  const { server, base, headers } = await start(t);
  const stream = await openStream(t, base, headers);
  const started = await sendTurn(base, headers, "Write a 1500 word essay about rivers.");
  assert.equal((await transcript(base, headers, started.attemptId)).turnRunning, true);

  const busy = await fetch(`${base}/api/turns`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify({ prompt: "hi", attemptId: started.attemptId }) });
  assert.equal(busy.status, 409);
  await busy.arrayBuffer();

  await stream.until((events) => events.some((e) => e.type === "session_started"));
  const pgid = Number(server.db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(started.attemptId)!.pgid);
  const stop = await fetch(`${base}/api/turns/${started.attemptId}/interrupt`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: "{}" });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { interrupted: true });

  const events = await stream.until(ended(started.attemptId, 1));
  const last = events.at(-1)!;
  assert.ok(last.payload.type === "turn_ended" && last.payload.reason === "interrupted");
  const after = await transcript(base, headers, started.attemptId);
  assert.equal(after.status, "interrupted");
  assert.equal(after.turnRunning, false);
  assert.deepEqual(cliProcesses(pgid), []);
  const again = await fetch(`${base}/api/turns/${started.attemptId}/interrupt`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: "{}" });
  assert.equal(again.status, 409);
  await again.arrayBuffer();
});
