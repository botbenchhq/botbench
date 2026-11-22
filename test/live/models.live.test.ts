import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import { modelNameProblem } from "../../src/drivers/contract.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";

// These tests start the real Claude Code on the owner's login, through Smelt's HTTP API.
// Every prompt is tiny and every model named here is one of the cheapest the CLI lists.

const TURN_TIMEOUT = 180_000;
const JSON_TYPE = { "content-type": "application/json" };
/** A full model name the CLI lists, and an alias it lists for a different model. Both are its cheapest family. */
const FULL_NAME = "claude-haiku-4-5-20251001";
const ALIAS = "haiku";

async function start(t: TestContext): Promise<{ server: SmeltServer; base: string; headers: Record<string, string> }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smelt-live-models-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: ALIAS, models: ["sonnet"] } }, roles: { implementer: { driver: "claude-code" } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function sendTurn(base: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<{ attemptId: number; turn: number }> {
  const res = await fetch(`${base}/api/turns`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify(body) });
  const answer = (await res.json()) as { attemptId: number; turn: number };
  assert.equal(res.status, 200, JSON.stringify(answer));
  return answer;
}

interface Stored {
  status: string;
  turnRunning: boolean;
  events: StoredEvent[];
}
const transcript = async (base: string, headers: Record<string, string>, attemptId: number): Promise<Stored> => (await (await fetch(`${base}/api/attempts/${attemptId}/events`, { headers })).json()) as Stored;

/** Wait until the attempt's turn has ended, and return what is stored of the attempt. */
async function turnEnded(base: string, headers: Record<string, string>, attemptId: number, turn: number): Promise<StoredEvent[]> {
  const deadline = Date.now() + TURN_TIMEOUT - 30_000;
  for (;;) {
    const { events } = await transcript(base, headers, attemptId);
    if (events.some((e) => e.turn === turn && e.type === "turn_ended")) return events;
    if (Date.now() > deadline) throw new Error(`turn ${turn} of attempt ${attemptId} did not end; got ${events.map((e) => e.type).join(", ")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sessionModel = (events: StoredEvent[]): string | null => {
  const started = events.find((e) => e.payload.type === "session_started");
  return started?.payload.type === "session_started" ? started.payload.model : null;
};

/** Every process the system knows in this process group, as ps sees it. */
function processesInGroup(pgid: number): string[] {
  return execFileSync("ps", ["-A", "-o", "pgid=,pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[0]) === pgid);
}
/** The `claude` processes this test process started that are still there. */
const ownCliProcesses = (): string[] =>
  execFileSync("ps", ["-A", "-o", "ppid=,pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[0]) === process.pid && /claude/.test(line));

async function gone(pgid: number): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  while (processesInGroup(pgid).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return processesInGroup(pgid);
}

test("live: GET /api/models returns the list the real Claude Code reports, says it is the CLI's, and gives the configured default; no turn is started and no process is left", { timeout: 60_000 }, async (t) => {
  const { server, base, headers } = await start(t);
  const res = await fetch(`${base}/api/models`, { headers });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as { driver: string; source: string; models: { id: string; label?: string }[]; default: string | null; cliDefault: string | null };
  assert.deepEqual(Object.keys(body).sort(), ["cliDefault", "default", "driver", "models", "source"]);
  assert.equal(body.driver, "claude-code");
  assert.equal(body.source, "cli", "the list is the CLI's own, not the configured one");
  assert.equal(body.default, ALIAS);
  assert.ok(body.models.length > 1, "more than the one configured name");
  for (const model of body.models) {
    assert.equal(modelNameProblem(model.id), null, model.id);
    assert.deepEqual(Object.keys(model).filter((k) => k !== "id" && k !== "label" && k !== "resolved"), []);
    if ("resolved" in model) assert.equal(modelNameProblem((model as { resolved: string }).resolved), null, "the full name an alias stands for is a model name and nothing else");
  }
  const ids = body.models.map((m) => m.id);
  // The names this file's turns use are ones the CLI itself offers, and so is an alias its own help names.
  for (const id of [FULL_NAME, ALIAS, "sonnet"]) assert.ok(ids.includes(id), `the CLI lists ${id}; it listed ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("default"), "the CLI's own default is not offered as a name");
  assert.ok(typeof body.cliDefault === "string" && body.cliDefault.length > 0, "the CLI says what its own default is");
  // The CLI's answer also describes the account; none of that is passed on.
  assert.doesNotMatch(text, /@|email|organization|subscription/i);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no attempt was started");
  assert.deepEqual(ownCliProcesses(), []);
});

test("live: a turn started with a chosen model reports that model in its session event and on the attempt row; the next turn, on another model, reports the other one", { timeout: 2 * TURN_TIMEOUT }, async (t) => {
  const { server, base, headers } = await start(t);
  const attempt = (id: number) => server.db.prepare("SELECT model, status, pgid FROM attempts WHERE id = ?").get(id)!;

  const first = await sendTurn(base, headers, { prompt: "Reply with exactly the word: heron", model: FULL_NAME });
  const firstGroup = Number(attempt(first.attemptId).pgid);
  assert.match(processesInGroup(firstGroup).join("\n"), new RegExp(`--model ${FULL_NAME}( |$)`, "m"));
  const firstEvents = await turnEnded(base, headers, first.attemptId, first.turn);
  assert.deepEqual(firstEvents.at(-1)!.payload, { type: "turn_ended", reason: "completed", detail: null });
  assert.equal(sessionModel(firstEvents), FULL_NAME, "the model named, not the configured one");
  assert.equal(attempt(first.attemptId).model, FULL_NAME);

  // Another model for the same conversation: it continues in a new attempt on that model, and the first one's process goes.
  const second = await sendTurn(base, headers, { prompt: "Which word did I ask you for? Reply with only that word.", attemptId: first.attemptId, model: ALIAS });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.deepEqual(processesInGroup(firstGroup), []);
  const secondGroup = Number(attempt(second.attemptId).pgid);
  assert.match(processesInGroup(secondGroup).join("\n"), new RegExp(`--model ${ALIAS} `));
  const secondEvents = await turnEnded(base, headers, second.attemptId, second.turn);
  assert.deepEqual(secondEvents.at(-1)!.payload, { type: "turn_ended", reason: "completed", detail: null });
  const answered = sessionModel(secondEvents);
  assert.match(String(answered), /^claude-haiku-/);
  assert.notEqual(answered, FULL_NAME, "the other model answered");
  assert.equal(attempt(second.attemptId).model, answered, "the attempt row holds what the CLI reported, not the alias asked for");
  assert.match(secondEvents.map((e) => (e.payload.type === "text" ? e.payload.text : "")).join(" "), /heron/i, "it is the same conversation");

  await server.close();
  assert.deepEqual(processesInGroup(secondGroup), []);
});

test("live: a model name the CLI does not know ends the turn as an error in the CLI's own words, and no process is left", { timeout: TURN_TIMEOUT }, async (t) => {
  const { server, base, headers } = await start(t);
  const unknown = "smelt-no-such-model-1";
  const started = await sendTurn(base, headers, { prompt: "Reply with exactly the word: wren", model: unknown });
  const pgid = Number(server.db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(started.attemptId)!.pgid);
  const events = await turnEnded(base, headers, started.attemptId, started.turn);

  const end = events.at(-1)!.payload;
  assert.equal(end.type === "turn_ended" && end.reason, "error");
  const words = /issue with the selected model \(smelt-no-such-model-1\)/;
  assert.match(String(end.type === "turn_ended" && end.detail), words);
  assert.ok(events.some((e) => e.payload.type === "error" && words.test(e.payload.message)), "an error event carries the CLI's sentence");
  assert.doesNotMatch(events.map((e) => (e.payload.type === "text" ? e.payload.text : "")).join(" "), /wren/i, "nothing answered");

  assert.deepEqual(await gone(pgid), [], "the CLI process is not kept after the failed turn");
  const row = server.db.prepare("SELECT status, pgid FROM attempts WHERE id = ?").get(started.attemptId)!;
  assert.notEqual(row.status, "running");
  assert.equal(row.pgid, null);
  assert.equal((await transcript(base, headers, started.attemptId)).turnRunning, false);
});
