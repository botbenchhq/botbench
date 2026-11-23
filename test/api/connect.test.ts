import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import type { SignInDefinition } from "../../src/drivers/sign-in.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { randomState, replayedClaude, CLAUDE_RECORDING } from "../support/replay-sign-in.ts";
import { tempDir } from "../support/repo.ts";
import { NO_PROCESS_LIST } from "../support/confined.ts";

// The connect routes over real HTTP and a real store. The sign-in is Claude Code's real output replayed as a child
// process (test/support/replay-sign-in.ts); the probe is the real Claude Code, pointed at an empty configuration
// directory for the whole file, so it reports signed out and nothing here can touch the owner's own sign-in.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const BARE: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };

const emptyConfig = tempDir("botbench-connect-api-claude-config-");
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = emptyConfig;
process.on("exit", () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  fs.rmSync(emptyConfig, { recursive: true, force: true });
});

async function start(t: T, signIn: SignInDefinition): Promise<{ server: BotbenchServer; home: string; base: string; headers: Record<string, string> }> {
  const dir = tempDir("botbench-connect-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const server = await startServer({ config: BARE, home, signInDelayMs: 1, signIns: [signIn] });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { server, home, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(base: string, headers: Record<string, string>, method: "GET" | "POST", route: string, body: unknown = method === "POST" ? {} : undefined): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { method, headers: { ...headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function until(read: () => Promise<{ body: Record<string, unknown> }>, done: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const end = Date.now() + 5000;
  for (;;) {
    const { body } = await read();
    if (done(body) || Date.now() > end) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const ROUTES: ["GET" | "POST", string][] = [
  ["GET", "/api/agents/claude-code/connect"],
  ["POST", "/api/agents/claude-code/connect"],
  ["POST", "/api/agents/claude-code/connect/code"],
  ["POST", "/api/agents/claude-code/connect/cancel"],
  ["POST", "/api/agents/claude-code/disconnect"],
];

test("every connect route needs a session, and a refused request starts nothing", { skip: NO_PROCESS_LIST }, async (t) => {
  const state = randomState();
  const { base } = await start(t, replayedClaude("wait", state));
  for (const [method, route] of ROUTES) {
    const res = await fetch(`${base}${route}`, { method, headers: JSON_TYPE, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(res.status, 401, `${method} ${route}`);
    await res.arrayBuffer();
  }
  const { execFileSync } = await import("node:child_process");
  assert.throws(() => execFileSync("pgrep", ["-f", state]), "no sign-in process was started");
});

test("start waits with the link, a second start is 409, a wrong code ends it with the CLI's own reason, and an unknown agent is 404", async (t) => {
  const state = randomState();
  const { base, headers } = await start(t, replayedClaude("wait", state));
  const connect = "/api/agents/claude-code/connect";
  const idle = await call(base, headers, "GET", connect);
  assert.deepEqual(idle, { status: 200, body: { driver: "claude-code", kind: "link", terminalCommand: "claude auth login", signOutCommand: "claude auth logout", keptByBotbench: false, takesCode: true, state: "idle", url: null, code: null, expiresAt: null, reason: null } });

  const started = await call(base, headers, "POST", connect);
  assert.equal(started.status, 200);
  assert.equal(started.body.state, "waiting");
  assert.equal(new URL(started.body.url as string).searchParams.get("state"), state);
  assert.deepEqual((await call(base, headers, "GET", connect)).body, started.body);

  const again = await call(base, headers, "POST", connect);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "Claude Code is already being connected or disconnected. Finish or cancel that first.");
  assert.equal((await call(base, headers, "POST", "/api/agents/claude-code/disconnect")).status, 409, "no sign-out while a sign-in runs");

  assert.equal((await call(base, headers, "POST", `${connect}/code`, { code: "two words" })).status, 400);
  assert.equal((await call(base, headers, "POST", `${connect}/code`, { code: "notarealcode0000#notarealstate0000" })).body.state, "checking");
  const failed = await until(() => call(base, headers, "GET", connect), (body) => body.state !== "checking");
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.");
  assert.equal(failed.url, null);

  assert.equal((await call(base, headers, "POST", `${connect}/cancel`)).status, 409, "nothing to cancel");
  assert.equal((await call(base, headers, "GET", "/api/agents/grok/connect")).status, 404);
  assert.equal((await call(base, headers, "POST", "/api/agents/grok/connect")).status, 404);
});

test("cancel ends the sign-in, and the live updates say each step without its link", async (t) => {
  const state = randomState();
  const { base, headers } = await start(t, replayedClaude("wait", state));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/stream`, { headers, signal: controller.signal });
  let frames = "";
  void (async () => {
    try {
      for await (const chunk of stream.body!) frames += Buffer.from(chunk).toString("utf8");
    } catch {
      // Aborted at the end of the test.
    }
  })();
  await call(base, headers, "POST", "/api/agents/claude-code/connect");
  const cancelled = await call(base, headers, "POST", "/api/agents/claude-code/connect/cancel");
  assert.equal(cancelled.body.state, "cancelled");
  const end = Date.now() + 3000;
  while (!frames.includes('"cancelled"') && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  const agentFrames = frames.split("\n\n").filter((frame) => frame.startsWith("event: agent"));
  assert.deepEqual(
    agentFrames.map((frame) => JSON.parse(frame.split("data: ")[1]!) as unknown),
    ["starting", "waiting", "cancelled"].map((s) => ({ driver: "claude-code", state: s })),
  );
  assert.equal(frames.includes(state), false);
});

test("nothing of a sign-in is written to the database, the event log or Botbench's log", async (t) => {
  const state = randomState();
  const written: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => (written.push(String(chunk)), out(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => (written.push(String(chunk)), err(chunk, ...rest))) as typeof process.stderr.write;
  t.after(() => ((process.stdout.write = out), (process.stderr.write = err)));

  const { server, home, base, headers } = await start(t, replayedClaude("wait", state));
  const connect = "/api/agents/claude-code/connect";
  // One sign-in cancelled, one ended by a wrong code: the link was shown in each.
  assert.match(String((await call(base, headers, "POST", connect)).body.url), new RegExp(state));
  await call(base, headers, "POST", `${connect}/cancel`);
  await call(base, headers, "POST", connect);
  await call(base, headers, "POST", `${connect}/code`, { code: `pasted${state}` });
  await until(() => call(base, headers, "GET", connect), (body) => body.state === "failed");

  assert.equal(server.db.prepare("SELECT count(*) AS n FROM events").get()!.n, 0, "the event log has nothing of it");
  for (const table of server.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name))) {
    const rows = JSON.stringify(server.db.prepare(`SELECT * FROM "${table}"`).all());
    assert.equal(rows.includes(state), false, `table ${table}`);
  }
  // Every file Botbench keeps, the database's own files included, read as bytes.
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));
  for (const file of files(home)) assert.equal(fs.readFileSync(file).includes(state), false, file);
  assert.equal(written.join("").includes(state), false, "Botbench's log");
  assert.ok(fs.readFileSync(CLAUDE_RECORDING, "utf8").includes("XXXXXXXX"), "the recording holds only placeholders");
});
