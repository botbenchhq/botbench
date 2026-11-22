import assert from "node:assert/strict";
import { MIGRATIONS } from "../src/store/schema.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { LOGIN_TOKEN_FILE } from "../src/api/auth.ts";
import { startServer, type SmeltServer } from "../src/server.ts";
import { DB_FILE } from "../src/store/db.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

/** Start the real server on a free port with its data in a temporary directory. */
async function start(t: { after(fn: () => unknown): void }, overrides: Partial<Config> = {}): Promise<{ server: SmeltServer; home: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smelt-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, ...overrides };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  return { server, home };
}

/** Sign in over real HTTP with the token Smelt wrote under `home`; returns the session cookie to send back. */
async function signIn(port: number, home: string): Promise<{ cookie: string }> {
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${port}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! };
}

test("the running server answers a health request and created its data directory owner-only", async (t) => {
  const { server, home } = await start(t);
  assert.ok(server.port > 0);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(path.join(home, DB_FILE)), 0o600);

  const res = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: await signIn(server.port, home) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { status: "ok", schemaVersion: MIGRATIONS.length });
});

test("the server answers nothing else: other paths and other methods get 404", async (t) => {
  const { server, home } = await start(t);
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { ...(await signIn(server.port, home)), "content-type": "application/json" };
  // "/" and "/index.html" are the client shell since unit 4, covered in test/api/turns.test.ts.
  for (const p of ["/health/", "/healthz", "/health/db", "/api/health", "/index.htm", "/assets", "/favicon.ico"]) {
    const res = await fetch(base + p, { headers });
    assert.equal(res.status, 404, `GET ${p}`);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${base}/health`, { method, headers, body: "{}" });
    assert.equal(res.status, 404, `${method} /health`);
    await res.arrayBuffer();
  }
});

test("the server listens on the configured addresses only", async (t) => {
  const { server: loopbackOnly } = await start(t);
  assert.deepEqual(loopbackOnly.addresses, ["127.0.0.1"]);
  await assert.rejects(fetch(`http://[::1]:${loopbackOnly.port}/health`), "nothing listens on an address that was not configured");

  if (!Object.values(os.networkInterfaces()).flat().some((i) => i?.address === "::1")) return; // no IPv6 loopback on this host
  const { server: both, home } = await start(t, { listen: ["127.0.0.1", "::1"] });
  assert.deepEqual(both.addresses, ["127.0.0.1", "::1"]);
  const headers = await signIn(both.port, home);
  for (const host of ["127.0.0.1", "[::1]"]) {
    const res = await fetch(`http://${host}:${both.port}/health`, { headers });
    assert.equal(res.status, 200, host);
    await res.arrayBuffer();
  }
});

test("closing the server stops it answering and releases the database", async (t) => {
  const { server, home } = await start(t);
  const url = `http://127.0.0.1:${server.port}/health`;
  const headers = await signIn(server.port, home);
  assert.equal((await fetch(url, { headers })).status, 200);
  await server.close();
  await assert.rejects(fetch(url, { headers }));
  assert.equal(server.db.isOpen, false);
});

test("starting on a port that is taken fails and leaves the first server working", async (t) => {
  const { server, home } = await start(t);
  await assert.rejects(start(t, { port: server.port }), /EADDRINUSE/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`, { headers: await signIn(server.port, home) })).status, 200);
});

test("npm start's entry point creates the data directory, answers health, and exits on SIGTERM", async (t) => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smelt-entry-")), "home");
  t.after(() => fs.rmSync(path.dirname(home), { recursive: true, force: true }));
  // Ask the OS for a free port, then hand it to the real process.
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, "close");

  const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const child = spawn(process.execPath, [entry], { env: { ...process.env, SMELT_HOME: home, SMELT_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => void child.kill("SIGKILL"));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) { out += chunk; if (out.includes("listening")) break; }
  assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${port}`));

  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: await signIn(port, home) });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "ok");
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, DB_FILE)).mode & 0o777, 0o600);

  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});
