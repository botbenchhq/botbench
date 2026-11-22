import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { now } from "../../src/store/db.ts";

// No test in this file starts a driver: turns that reach Claude Code are in test/live/turns.live.test.ts.

type T = { after(fn: () => unknown): void };

const JSON_TYPE = { "content-type": "application/json" };

/** A client directory with real files in it, plus a file beside it that must never be served. */
function clientDir(t: T): { dir: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "dist");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><title>Botbench</title><script type="module" src="/assets/app-1a2b.js"></script>');
  fs.writeFileSync(path.join(dir, "assets", "app-1a2b.js"), "console.log('botbench');");
  fs.writeFileSync(path.join(dir, "assets", "app-1a2b.css"), "body{margin:0}");
  fs.writeFileSync(path.join(dir, "assets", "geist-1a2b.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  const outside = path.join(root, "outside.js");
  fs.writeFileSync(outside, "not part of the client");
  fs.symlinkSync(outside, path.join(dir, "assets", "link.js"));
  return { dir, outside };
}

async function start(t: T, options: { clientDir?: string; heartbeatMs?: number } = {}): Promise<{ server: BotbenchServer; home: string; token: string; base: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-turns-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home, signInDelayMs: 1, ...options });
  t.after(() => server.close());
  return { server, home, token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim(), base: `http://127.0.0.1:${server.port}` };
}

async function signIn(base: string, token: string): Promise<{ cookie: string }> {
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! };
}

/** One request with the path sent exactly as written: `fetch` would tidy `..` away before sending. */
function raw(port: number, rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Store an attempt the way a driver does, without starting one. */
function insertAttempt(db: DatabaseSync, status = "ended"): number {
  const at = now();
  return Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', NULL, NULL, ?, NULL, ?, ?)").run(status, at, at).lastInsertRowid);
}

function insertEvent(db: DatabaseSync, attemptId: number, turn: number, event: DriverEvent): number {
  return Number(db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(attemptId, turn, now(), event.type, JSON.stringify(event)).lastInsertRowid);
}

const isStored = (f: StreamFrame): boolean => f.data !== null && f.event === null;

interface StreamFrame {
  id: string | null;
  data: string | null;
  comment: string | null;
  /** The SSE event name; null for a stored event, which is sent unnamed. */
  event: string | null;
}

/** Open the event stream over real HTTP and collect its frames until `close` is called. */
async function openStream(base: string, headers: Record<string, string>, query = ""): Promise<{ status: number; contentType: string; frames: StreamFrame[]; ended: Promise<void>; waitFor(n: number, pick?: (f: StreamFrame) => boolean): Promise<StreamFrame[]>; close(): void }> {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/stream${query}`, { headers, signal: abort.signal });
  const frames: StreamFrame[] = [];
  const waker: { wake: (() => void) | null } = { wake: null };
  let ended: Promise<void> = Promise.resolve();
  if (res.ok && res.body) {
    ended = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body!) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame: StreamFrame = { id: null, data: null, comment: null, event: null };
            for (const line of buffer.slice(0, end).split("\n")) {
              if (line.startsWith("id: ")) frame.id = line.slice(4);
              else if (line.startsWith("data: ")) frame.data = line.slice(6);
              else if (line.startsWith("event: ")) frame.event = line.slice(7);
              else if (line.startsWith(":")) frame.comment = line.slice(1).trim();
            }
            buffer = buffer.slice(end + 2);
            frames.push(frame);
            waker.wake?.();
          }
        }
      } catch {
        // Aborted by close().
      }
    })();
  } else {
    await res.arrayBuffer();
  }
  const waitFor = async (n: number, pick: (f: StreamFrame) => boolean = isStored): Promise<StreamFrame[]> => {
    const deadline = Date.now() + 5000;
    while (frames.filter(pick).length < n) {
      if (Date.now() > deadline) throw new Error(`expected ${n} frames, got ${JSON.stringify(frames)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        waker.wake = () => (clearTimeout(timer), resolve());
      });
    }
    return frames.filter(pick);
  };
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", frames, ended, waitFor, close: () => abort.abort() };
}

test("without a session every new API route is refused", async (t) => {
  const { base } = await start(t);
  const routes: Array<[string, string]> = [
    ["GET", "/api/session"],
    ["GET", "/api/driver"],
    ["POST", "/api/turns"],
    ["POST", "/api/turns/1/interrupt"],
    ["GET", "/api/attempts/1/events"],
    ["GET", "/api/attempts/1/events?after=0"],
    ["GET", "/api/stream"],
    ["GET", "/health"],
    // Not part of the shell, so not open either.
    ["GET", "/api/index.html"],
    ["GET", "/assets"],
    ["GET", "/src/server.ts"],
    ["POST", "/"],
    ["POST", "/assets/app-1a2b.js"],
  ];
  for (const [method, route] of routes) {
    const write = method !== "GET";
    const res = await fetch(base + route, { method, headers: write ? JSON_TYPE : {}, body: write ? JSON.stringify({ prompt: "hi" }) : undefined });
    assert.equal(res.status, 401, `${method} ${route}`);
    assert.deepEqual(await res.json(), { error: "sign in required" });
  }
});

test("the page's one inline script, which applies the owner's appearance choice before the first paint, is allowed by its hash and nothing else is", async (t) => {
  const { dir } = clientDir(t);
  const inline = 'document.documentElement.setAttribute("data-theme", "dark");';
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Botbench</title><script>${inline}</script><script type="module" src="/assets/app-1a2b.js"></script>`);
  const { base } = await start(t, { clientDir: dir });
  const csp = (await fetch(base + "/")).headers.get("content-security-policy") ?? "";
  const hash = createHash("sha256").update(inline).digest("base64");
  assert.match(csp, new RegExp(`(^|; )script-src 'self' 'sha256-${hash.replace(/[+/]/g, "\\$&")}'(;|$)`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  // A page with no inline script allows none.
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><title>Botbench</title><script type="module" src="/assets/app-1a2b.js"></script>');
  assert.doesNotMatch((await fetch(base + "/")).headers.get("content-security-policy") ?? "", /sha256/);
});

test("the client shell is served without a session, and /api/session says 401 before sign-in and 200 after", async (t) => {
  const { dir } = clientDir(t);
  const { base, token } = await start(t, { clientDir: dir });

  for (const p of ["/", "/index.html"]) {
    const page = await fetch(base + p);
    assert.equal(page.status, 200, p);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html; charset=utf-8/);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    // The page may load scripts, styles, fonts and data from Botbench itself and nowhere else.
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
    assert.equal(await page.text(), fs.readFileSync(path.join(dir, "index.html"), "utf8"));
    assert.equal(page.headers.get("set-cookie"), null);
  }
  const types: Array<[string, RegExp]> = [
    ["/assets/app-1a2b.js", /^text\/javascript; charset=utf-8/],
    ["/assets/app-1a2b.css", /^text\/css; charset=utf-8/],
    ["/assets/geist-1a2b.woff2", /^font\/woff2$/],
  ];
  for (const [p, type] of types) {
    const asset = await fetch(base + p);
    assert.equal(asset.status, 200, p);
    assert.match(asset.headers.get("content-type") ?? "", type, p);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), fs.readFileSync(path.join(dir, p)));
  }
  const head = await fetch(`${base}/assets/app-1a2b.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(fs.statSync(path.join(dir, "assets", "app-1a2b.js")).size));
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/assets/`)).status, 401, "the directory itself is not part of the shell");
  assert.equal((await fetch(`${base}/assets/sub/`)).status, 404, "a directory is not a file");

  const before = await fetch(`${base}/api/session`);
  assert.equal(before.status, 401);
  await before.arrayBuffer();
  const headers = await signIn(base, token);
  const after = await fetch(`${base}/api/session`, { headers });
  assert.equal(after.status, 200);
  assert.deepEqual(await after.json(), { signedIn: true });
  // Health is still behind the session, as before.
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
  // A shell path on a host Botbench does not serve is refused like any other request.
  assert.equal((await raw(Number(new URL(base).port), "/", { host: "evil.example" })).status, 403);
});

test("a server whose client has not been built says so instead of serving a page", async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-noclient-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const { base } = await start(t, { clientDir: path.join(empty, "dist") });
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /npm run build --prefix web/);
});

test("path traversal out of the client directory is refused, with and without a session", async (t) => {
  const { dir, outside } = clientDir(t);
  const { base, token, server, home } = await start(t, { clientDir: dir });
  const cookie = (await signIn(base, token)).cookie;
  const secret = fs.readFileSync(outside, "utf8");
  const loginToken = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const attempts = [
    "/assets/../../outside.js",
    "/assets/..%2f..%2foutside.js",
    "/assets/..%2F..%2Foutside.js",
    "/assets/%2e%2e/%2e%2e/outside.js",
    "/assets/%2e%2e%2f%2e%2e%2foutside.js",
    "/assets/..%5c..%5coutside.js",
    "/assets/....//....//outside.js",
    "/assets//../../outside.js",
    "/assets/%00/../../outside.js",
    "/assets/app-1a2b.js%00.txt",
    "/assets/%zz",
    "/../outside.js",
    "/..%2foutside.js",
    "//outside.js",
    `/assets/..%2f..%2f..%2f${encodeURIComponent(path.relative(path.dirname(dir), path.join(home, LOGIN_TOKEN_FILE)))}`,
    // A link inside the client directory that points out of it.
    "/assets/link.js",
  ];
  for (const attempt of attempts) {
    for (const headers of [{}, { cookie }] as Array<Record<string, string>>) {
      const reply = await raw(server.port, attempt, headers);
      assert.ok([400, 401, 404].includes(reply.status), `${attempt} answered ${reply.status}`);
      assert.equal(reply.body.includes(secret), false, `${attempt} leaked the file`);
      assert.equal(reply.body.includes(loginToken), false, `${attempt} leaked the login token`);
    }
  }
  // A request target that is not an address at all is refused like any unknown path, and Botbench keeps running.
  const garbled = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(server.port, "127.0.0.1", () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`));
    let reply = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => (reply += chunk));
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
  });
  assert.match(garbled, /^HTTP\/1\.1 40[01] /);
  // The file is still served by its real path, so the refusals above are not a server that serves nothing.
  assert.equal((await raw(server.port, "/assets/app-1a2b.js")).status, 200);
});

test("GET /api/attempts/:id/events returns stored events in order, and only those after an id", async (t) => {
  const { base, token, server } = await start(t);
  const headers = await signIn(base, token);
  const other = insertAttempt(server.db);
  const attempt = insertAttempt(server.db);
  const stored: Array<[number, DriverEvent]> = [
    [1, { type: "user_prompt", text: "Reply with exactly the word: pong" }],
    [1, { type: "session_started", resumeCursor: "cursor-1", model: "haiku", keySource: "none" }],
    [1, { type: "text", text: "pong <script>alert(1)</script>" }],
    [1, { type: "usage", inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    [1, { type: "turn_ended", reason: "completed", detail: null }],
    [2, { type: "user_prompt", text: "again" }],
  ];
  const ids: number[] = [];
  for (const [turn, event] of stored) {
    ids.push(insertEvent(server.db, attempt, turn, event));
    // Another attempt's events sit between them and must not show up.
    insertEvent(server.db, other, 1, { type: "text", text: "from the other attempt" });
  }

  const all = await fetch(`${base}/api/attempts/${attempt}/events`, { headers });
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), {
    attemptId: attempt,
    status: "ended",
    turnRunning: false,
    // Who answered, for a chat several agents may answer; this attempt no chat started is Claude Code's, with no round.
    agent: "claude-code",
    model: null,
    round: null,
    events: stored.map(([turn, event], i) => ({ attemptId: attempt, id: ids[i], turn, ts: String(server.db.prepare("SELECT ts FROM events WHERE id = ?").get(ids[i]!)!.ts), type: event.type, payload: event })),
  });

  const later = (await (await fetch(`${base}/api/attempts/${attempt}/events?after=${ids[2]}`, { headers })).json()) as { events: Array<{ id: number; type: string }> };
  assert.deepEqual(later.events.map((e) => e.id), ids.slice(3));
  assert.deepEqual(later.events.map((e) => e.type), ["usage", "turn_ended", "user_prompt"]);
  const none = (await (await fetch(`${base}/api/attempts/${attempt}/events?after=${ids.at(-1)}`, { headers })).json()) as { events: unknown[] };
  assert.deepEqual(none.events, []);

  assert.equal((await fetch(`${base}/api/attempts/9999/events`, { headers })).status, 404);
  for (const bad of ["abc", "-1", "1.5", ""]) {
    assert.equal((await fetch(`${base}/api/attempts/${attempt}/events?after=${bad}`, { headers })).status, 400, `after=${bad}`);
  }
  assert.equal((await fetch(`${base}/api/attempts/${attempt}/events`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: "{}" })).status, 404);
});

test("the event stream replays stored events after Last-Event-ID, each with its row id, and sends heartbeats", async (t) => {
  const { base, token, server } = await start(t, { heartbeatMs: 50 });
  const headers = await signIn(base, token);
  const attempt = insertAttempt(server.db);
  const ids = [
    insertEvent(server.db, attempt, 1, { type: "user_prompt", text: "hi" }),
    insertEvent(server.db, attempt, 1, { type: "text", text: "line one\nline two" }),
    insertEvent(server.db, attempt, 1, { type: "turn_ended", reason: "completed", detail: null }),
  ];

  const resumed = await openStream(base, { ...headers, "last-event-id": String(ids[0]) });
  t.after(resumed.close);
  assert.equal(resumed.status, 200);
  assert.match(resumed.contentType, /^text\/event-stream/);
  const frames = await resumed.waitFor(2);
  assert.deepEqual(frames.map((f) => f.id), [String(ids[1]), String(ids[2])]);
  // Each event carries the time it was stored, as the database has it: the client works out how long a reply took from these and from nothing else.
  const storedAt = (id: number): string => String(server.db.prepare("SELECT ts FROM events WHERE id = ?").get(id)!.ts);
  assert.deepEqual(JSON.parse(frames[0]!.data!), { attemptId: attempt, id: ids[1], turn: 1, ts: storedAt(ids[1]!), type: "text", payload: { type: "text", text: "line one\nline two" } });
  assert.deepEqual(JSON.parse(frames[1]!.data!), { attemptId: attempt, id: ids[2], turn: 1, ts: storedAt(ids[2]!), type: "turn_ended", payload: { type: "turn_ended", reason: "completed", detail: null } });
  assert.match(storedAt(ids[1]!), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  const beats = await resumed.waitFor(2, (f) => f.comment === "heartbeat");
  assert.ok(beats.length >= 2, "heartbeat comments keep the connection open");
  // Each heartbeat is also a named event the client can see, and has no id, so it never moves the resume point.
  assert.deepEqual(beats[0], { id: null, data: "{}", comment: "heartbeat", event: "heartbeat" });
  assert.equal(resumed.frames.filter(isStored).length, 2, "nothing is sent twice");

  // `after` in the address does the same for a first connection, which cannot set the header from a browser.
  const viaQuery = await openStream(base, headers, `?after=${ids[1]}`);
  t.after(viaQuery.close);
  assert.deepEqual((await viaQuery.waitFor(1)).map((f) => f.id), [String(ids[2])]);

  // With neither, a stream starts at now: nothing already stored is replayed.
  const fresh = await openStream(base, headers);
  t.after(fresh.close);
  await fresh.waitFor(2, (f) => f.comment === "heartbeat");
  assert.equal(fresh.frames.filter(isStored).length, 0);

  const bad = await openStream(base, { ...headers, "last-event-id": "abc" });
  assert.equal(bad.status, 400);
});

test("a disconnected stream client is forgotten, and closing the server ends open streams", async (t) => {
  const { base, token, server } = await start(t, { heartbeatMs: 20 });
  const headers = await signIn(base, token);
  const first = await openStream(base, headers);
  const second = await openStream(base, headers);
  await second.waitFor(1, (f) => f.comment === "heartbeat");
  assert.equal(server.streamClients(), 2);
  first.close();
  const deadline = Date.now() + 3000;
  while (server.streamClients() !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(server.streamClients(), 1);
  await server.close();
  assert.equal(server.streamClients(), 0);
  // The client's side of the stream really ended.
  await second.ended;
});

test("POST /api/turns and interrupt refuse a bad body or an unknown attempt before anything is started", async (t) => {
  const { base, token, server } = await start(t);
  const headers = { ...(await signIn(base, token)), ...JSON_TYPE };
  for (const body of ["{}", '{"prompt":""}', '{"prompt":"   "}', '{"prompt":5}', "[]", '{"prompt":"hi","attemptId":"1"}', '{"prompt":"hi","attemptId":1.5}']) {
    const res = await fetch(`${base}/api/turns`, { method: "POST", headers, body });
    assert.equal(res.status, 400, body);
    await res.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/api/turns`, { method: "POST", headers, body: "{not json" })).status, 400);
  const unknown = await fetch(`${base}/api/turns`, { method: "POST", headers, body: JSON.stringify({ prompt: "hi", attemptId: 4242 }) });
  assert.equal(unknown.status, 404);
  assert.equal((await fetch(`${base}/api/turns/4242/interrupt`, { method: "POST", headers, body: "{}" })).status, 404);
  // An attempt that exists but has no turn running has nothing to interrupt.
  const idle = insertAttempt(server.db);
  assert.equal((await fetch(`${base}/api/turns/${idle}/interrupt`, { method: "POST", headers, body: "{}" })).status, 409);
  // An attempt that never got a resume cursor cannot be continued.
  const noCursor = await fetch(`${base}/api/turns`, { method: "POST", headers, body: JSON.stringify({ prompt: "hi", attemptId: idle }) });
  assert.equal(noCursor.status, 409);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 1, "no attempt was started");
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM events").get()!.n, 0);
});

test("the scratch directory turns work in is created owner-only inside the data directory", async (t) => {
  const { home } = await start(t);
  const scratch = path.join(home, "scratch");
  assert.equal(fs.statSync(scratch).isDirectory(), true);
  assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
});
