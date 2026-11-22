import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIN_TOKEN_FILE, MAX_WAITING_SIGN_INS, SESSION_COOKIE } from "../../src/api/auth.ts";
import { DEFAULT_CONFIG_FILE, loadConfig, type Config } from "../../src/config.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";

type T = { after(fn: () => unknown): void };

const JSON_TYPE = { "content-type": "application/json" };
const hasIpv6Loopback = Object.values(os.networkInterfaces()).flat().some((i) => i?.address === "::1");

/** Start the real server on a free port with its data in a temporary directory. */
async function start(t: T, overrides: Partial<Config> = {}, signInDelayMs = 1): Promise<{ server: SmeltServer; home: string; token: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smelt-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, ...overrides };
  const server = await startServer({ config, home, signInDelayMs });
  t.after(() => server.close());
  return { server, home, token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim() };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One real HTTP request through node:http, which lets a test choose `Host` and `Origin`. */
function request(o: { port: number; address?: string; method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: o.address ?? "127.0.0.1",
        port: o.port,
        method: o.method ?? "GET",
        path: o.path,
        headers: { ...o.headers, ...(o.body === undefined ? {} : { "content-length": String(Buffer.byteLength(o.body)) }) },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

function signIn(port: number, token: string, extra: { address?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return request({ port, address: extra.address, method: "POST", path: "/api/sign-in", headers: { ...JSON_TYPE, ...extra.headers }, body: JSON.stringify({ token }) });
}

/** The Set-Cookie header of a sign-in reply, and the `name=value` pair to send back. */
function sessionCookie(reply: Reply): { header: string; pair: string } {
  const all = reply.headers["set-cookie"] ?? [];
  assert.equal(all.length, 1, "exactly one cookie is set");
  const header = all[0]!;
  return { header, pair: header.split(";")[0]! };
}

const attributes = (setCookie: string): string[] => setCookie.split(";").slice(1).map((a) => a.trim().toLowerCase());

test("AE10: without a session every route but sign-in is refused, on the loopback address and on a second configured address", async (t) => {
  const listen = hasIpv6Loopback ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
  if (!hasIpv6Loopback) console.log("# no ::1 on this host: the second-address half of AE10 is not exercised");
  const { server, token } = await start(t, { listen });
  const port = server.port;
  const routes: Array<[string, string]> = [
    ["GET", "/health"],
    // "/" and "/index.html" are the client shell since unit 4: open, and covered in turns.test.ts.
    ["GET", "/src/server.ts"],
    ["GET", "/assets"],
    ["GET", "/api/sign-in"],
    ["GET", "/api/runs"],
    ["GET", `/${LOGIN_TOKEN_FILE}`],
    ["HEAD", "/health"],
    ["POST", "/health"],
    ["POST", "/api/sign-in/"],
    ["PUT", "/api/sign-in"],
    ["DELETE", "/api/runs/1"],
    ["PATCH", "/health"],
  ];
  for (const address of listen) {
    for (const [method, route] of routes) {
      const write = !["GET", "HEAD"].includes(method);
      const reply = await request({ port, address, method, path: route, headers: write ? JSON_TYPE : {}, body: write ? "{}" : undefined });
      assert.equal(reply.status, 401, `${method} ${route} on ${address}`);
      if (method !== "HEAD") assert.deepEqual(JSON.parse(reply.body), { error: "sign in required" });
      assert.equal(reply.headers["set-cookie"], undefined);
    }
    // A cookie that was never issued is no session either.
    const forged = await request({ port, address, path: "/health", headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` } });
    assert.equal(forged.status, 401, `forged cookie on ${address}`);
    const tokenAsCookie = await request({ port, address, path: "/health", headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    assert.equal(tokenAsCookie.status, 401, `the login token is not a session, on ${address}`);
  }

  // The one open route works from each address, and its session opens the rest.
  for (const address of listen) {
    const signedIn = await signIn(port, token, { address });
    assert.equal(signedIn.status, 200, `sign-in on ${address}`);
    const health = await request({ port, address, path: "/health", headers: { cookie: sessionCookie(signedIn).pair } });
    assert.equal(health.status, 200, `health with a session on ${address}`);
    assert.deepEqual(JSON.parse(health.body), { status: "ok", schemaVersion: 3 });
  }
});

test("signing in with the token sets a session cookie scripts cannot read; a wrong token is refused", async (t) => {
  const { server, token } = await start(t);
  const port = server.port;

  for (const wrong of ["", "nope", token.slice(0, -1), `${token}x`, token.toUpperCase()]) {
    const refused = await signIn(port, wrong);
    assert.equal(refused.status, 401, `token "${wrong === "" ? "" : "…"}" (${wrong.length} chars)`);
    assert.deepEqual(JSON.parse(refused.body), { error: "wrong token" });
    assert.equal(refused.headers["set-cookie"], undefined);
  }
  for (const body of ["{", "[]", "null", JSON.stringify({ token: 7 }), JSON.stringify({})]) {
    const malformed = await request({ port, method: "POST", path: "/api/sign-in", headers: JSON_TYPE, body });
    assert.equal(malformed.status, 400, body);
    assert.equal(malformed.headers["set-cookie"], undefined);
  }

  const first = await signIn(port, token);
  assert.equal(first.status, 200);
  const cookie = sessionCookie(first);
  assert.match(cookie.pair, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
  const attrs = attributes(cookie.header);
  assert.ok(attrs.includes("httponly"), cookie.header);
  assert.ok(attrs.includes("samesite=strict"), cookie.header);
  assert.ok(attrs.includes("path=/"), cookie.header);
  assert.ok(!attrs.includes("secure"), "plain HTTP on a listen address: a Secure cookie would never be sent back");

  // fetch works with the cookie too: this is what a browser does.
  const viaFetch = await fetch(`http://127.0.0.1:${port}/health`, { headers: { cookie: cookie.pair } });
  assert.equal(viaFetch.status, 200);
  await viaFetch.arrayBuffer();

  const second = await signIn(port, token);
  assert.notEqual(sessionCookie(second).pair, cookie.pair, "each sign-in gets its own random session id");
});

test("repeated wrong tokens are slowed down, and a correct sign-in resets the delay", async (t) => {
  const delay = 100;
  const { server, token } = await start(t, {}, delay);
  const timed = async (candidate: string): Promise<{ status: number; ms: number }> => {
    const began = performance.now();
    const reply = await signIn(server.port, candidate);
    return { status: reply.status, ms: performance.now() - began };
  };
  const slack = 5; // timers may fire a few milliseconds early

  const a = await timed("wrong-1");
  const b = await timed("wrong-2");
  const c = await timed("wrong-3");
  assert.deepEqual([a.status, b.status, c.status], [401, 401, 401]);
  assert.ok(b.ms >= delay - slack, `second wrong attempt waited ${b.ms}ms`);
  assert.ok(c.ms >= 2 * delay - slack, `third wrong attempt waited ${c.ms}ms`);

  // Sending guesses side by side does not get around the wait: they are answered one after another.
  const began = performance.now();
  const parallel = await Promise.all([timed("wrong-4"), timed("wrong-5")]);
  assert.deepEqual(parallel.map((p) => p.status), [401, 401]);
  assert.ok(performance.now() - began >= (4 + 8) * delay - slack, `two parallel guesses took ${performance.now() - began}ms`);

  // The owner's correct token still works, after the wait, and clears the count.
  const right = await timed(token);
  assert.equal(right.status, 200);
  const after = await timed("wrong-6");
  assert.equal(after.status, 401);
  assert.ok(after.ms < delay, `after a successful sign-in a wrong attempt is answered at once, took ${after.ms}ms`);
});

test("a flood of guesses is turned away unchecked instead of queueing without end", async (t) => {
  const { server, token } = await start(t, {}, 2000);
  assert.equal((await signIn(server.port, "wrong-0")).status, 401); // from here each attempt waits two seconds or more
  // These wait their turn; the test does not wait for them, and closing the server ends them.
  for (let i = 0; i < MAX_WAITING_SIGN_INS; i++) signIn(server.port, `queued-${i}`).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100)); // let them arrive
  const began = performance.now();
  for (const candidate of ["over-1", "over-2", token]) {
    const turnedAway = await signIn(server.port, candidate);
    assert.equal(turnedAway.status, 429, candidate === token ? "even the right token is not checked" : candidate);
    assert.equal(turnedAway.headers["set-cookie"], undefined);
  }
  assert.ok(performance.now() - began < 1500, "turned away at once, not after the wait");
});

test("with no extra address configured, Smelt listens on the loopback address only", async (t) => {
  const shipped = loadConfig({ defaults: DEFAULT_CONFIG_FILE });
  assert.deepEqual(shipped.listen, ["127.0.0.1"]);
  assert.deepEqual(shipped.publicHosts, []);
  const { server, token } = await start(t, { listen: shipped.listen, publicHosts: shipped.publicHosts });
  assert.deepEqual(server.addresses, ["127.0.0.1"]);
  assert.equal((await signIn(server.port, token)).status, 200);

  const connects = (address: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: address, port: server.port });
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
  assert.equal(await connects("127.0.0.1"), true);
  // Every other address this machine has, on every interface, must not answer on Smelt's port.
  const others = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i !== undefined && i.address !== "127.0.0.1")
    .map((i) => (i!.family === "IPv6" && i!.scopeid ? `${i!.address}%${i!.scopeid}` : i!.address));
  const answers = await Promise.all(others.map(connects));
  others.forEach((address, i) => assert.equal(answers[i], false, `nothing listens on ${address}`));
});

test("the token file is owner-only and the token is in no response after sign-in", async (t) => {
  const { server, home, token } = await start(t);
  const file = path.join(home, LOGIN_TOKEN_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.equal(server.newLoginToken, token, "the start that created the token hands it to the entry point");

  const port = server.port;
  const signedIn = await signIn(port, token);
  const cookie = sessionCookie(signedIn).pair;
  const replies = [
    signedIn,
    await signIn(port, "wrong"),
    await request({ port, path: "/health" }),
    await request({ port, path: "/health", headers: { cookie } }),
    await request({ port, path: `/${LOGIN_TOKEN_FILE}`, headers: { cookie } }),
    await request({ port, path: "/api/sign-in", headers: { cookie } }),
    await request({ port, method: "POST", path: "/health", headers: { cookie, ...JSON_TYPE }, body: JSON.stringify({ token }) }),
    await request({ port, path: "/health", headers: { cookie, host: "elsewhere.example" } }),
  ];
  assert.deepEqual(replies.map((r) => r.status), [200, 401, 401, 200, 404, 404, 404, 403]);
  for (const reply of replies) {
    assert.ok(!reply.body.includes(token), "token in a response body");
    assert.ok(!JSON.stringify(reply.headers).includes(token), "token in a response header");
  }

  // A second start on the same data directory keeps the token and has nothing to show.
  await server.close();
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const again = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => again.close());
  assert.equal(again.newLoginToken, undefined);
  assert.equal(fs.readFileSync(file, "utf8").trim(), token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Sessions live in memory: the restart signed the earlier session out, and the same token signs in again.
  assert.equal((await request({ port: again.port, path: "/health", headers: { cookie } })).status, 401);
  assert.equal((await signIn(again.port, token)).status, 200);
});

test("the entry point prints the token only on the start that created it", async (t) => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smelt-auth-entry-")), "home");
  t.after(() => fs.rmSync(path.dirname(home), { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../../src/server.ts", import.meta.url));

  /** Run the real process until it listens, use it, stop it, and return everything it wrote. */
  const run = async (use: (port: number) => Promise<void>): Promise<{ stdout: string; stderr: string }> => {
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as net.AddressInfo).port;
    probe.close();
    await once(probe, "close");

    const child = spawn(process.execPath, [entry], { env: { ...process.env, SMELT_HOME: home, SMELT_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => void child.kill("SIGKILL"));
    const exited = once(child, "exit");
    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.setEncoding("utf8");
    const listening = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("listening")) resolve();
      });
      void exited.then(() => reject(new Error(`the process exited before listening: ${stderr}`)));
    });
    await listening;
    await use(port);
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    return { stdout, stderr };
  };

  let token = "";
  const first = await run(async (port) => {
    token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
    assert.equal((await signIn(port, token)).status, 200);
  });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.stdout.split(token).length - 1, 1, "printed exactly once on the start that created it");
  assert.ok(!first.stderr.includes(token));

  const second = await run(async (port) => {
    assert.equal(fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim(), token, "the token survives a restart");
    assert.equal((await signIn(port, "wrong")).status, 401);
    const signedIn = await signIn(port, token);
    assert.equal(signedIn.status, 200);
    assert.equal((await request({ port, path: "/health", headers: { cookie: sessionCookie(signedIn).pair } })).status, 200);
  });
  assert.ok(!second.stdout.includes(token), "a later start does not print the token");
  assert.ok(!second.stderr.includes(token));
});

test("a foreign Origin, or a body that is not JSON, is refused on a write route", async (t) => {
  const { server, token } = await start(t);
  const port = server.port;
  const own = `http://127.0.0.1:${port}`;
  const post = (headers: Record<string, string>, body = JSON.stringify({ token })): Promise<Reply> =>
    request({ port, method: "POST", path: "/api/sign-in", headers, body });

  for (const origin of ["https://evil.example", "http://evil.example", `http://evil.example:${port}`, `https://127.0.0.1:${port}`, "http://127.0.0.1", `http://127.0.0.1:${port + 1}`, "null", ""]) {
    const refused = await post({ ...JSON_TYPE, origin });
    assert.equal(refused.status, 403, `Origin "${origin}"`);
    assert.equal(refused.headers["set-cookie"], undefined, `Origin "${origin}" must not sign in`);
  }
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/json"]) {
    const refused = await post({ "content-type": contentType });
    assert.equal(refused.status, 415, contentType);
    assert.equal(refused.headers["set-cookie"], undefined);
  }
  const noType = await request({ port, method: "POST", path: "/api/sign-in", body: JSON.stringify({ token }) });
  assert.equal(noType.status, 415, "no content type at all");

  // The same requests with Smelt's own origin and a JSON body are accepted.
  const ok = await post({ "content-type": "application/json; charset=utf-8", origin: own });
  assert.equal(ok.status, 200);
  assert.equal((await post({ ...JSON_TYPE, origin: `http://localhost:${port}` })).status, 200);
  const cookie = sessionCookie(ok).pair;

  // Behind the gate the same checks hold for a signed-in browser.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const foreign = await request({ port, method, path: "/health", headers: { cookie, ...JSON_TYPE, origin: "https://evil.example" }, body: "{}" });
    assert.equal(foreign.status, 403, `${method} with a foreign Origin`);
    const form = await request({ port, method, path: "/health", headers: { cookie, "content-type": "text/plain", origin: own }, body: "a=b" });
    assert.equal(form.status, 415, `${method} with a non-JSON body`);
    const fine = await request({ port, method, path: "/health", headers: { cookie, ...JSON_TYPE, origin: own }, body: "{}" });
    assert.equal(fine.status, 404, `${method} passes the checks and finds no such route`);
  }
});

test("a Host listed in publicHosts is accepted and its session cookie is Secure; an unknown Host is refused", async (t) => {
  const name = "mac.tailnet.ts.net";
  const { server, token } = await start(t, { publicHosts: [name] });
  const port = server.port;

  // What `tailscale serve` forwards to the loopback listener: the HTTPS name as Host, the HTTPS origin.
  const viaProxy = await signIn(port, token, { headers: { host: name, origin: `https://${name}` } });
  assert.equal(viaProxy.status, 200);
  const secure = sessionCookie(viaProxy);
  const attrs = attributes(secure.header);
  for (const flag of ["secure", "httponly", "samesite=strict", "path=/"]) assert.ok(attrs.includes(flag), `${flag} in ${secure.header}`);
  assert.equal((await request({ port, path: "/health", headers: { host: name, cookie: secure.pair } })).status, 200);
  assert.equal((await request({ port, path: "/health", headers: { host: name } })).status, 401, "the HTTPS name needs a session like any other");
  assert.equal((await signIn(port, token, { headers: { host: name.toUpperCase(), origin: `https://${name}` } })).status, 200, "host names compare without case");
  assert.equal((await signIn(port, token, { headers: { host: name, origin: `http://${name}` } })).status, 403, "the HTTPS name's origin is https");

  // The plain listener still gives a cookie a plain-HTTP browser will send back.
  const direct = await signIn(port, token);
  assert.ok(!attributes(sessionCookie(direct).header).includes("secure"));
  const cookie = sessionCookie(direct).pair;
  assert.equal((await request({ port, path: "/health", headers: { host: `localhost:${port}`, cookie } })).status, 200);

  // Any other Host is refused, session or not, sign-in included.
  for (const host of ["evil.example", `evil.example:${port}`, "other.tailnet.ts.net", `${name}.evil.example`, `127.0.0.1:${port + 1}`, "127.0.0.1", "localhost", `${name}:${port}`]) {
    const refused = await request({ port, path: "/health", headers: { host, cookie } });
    assert.equal(refused.status, 403, `Host "${host}"`);
    assert.deepEqual(JSON.parse(refused.body), { error: "host not allowed" });
    const noSignIn = await signIn(port, token, { headers: { host } });
    assert.equal(noSignIn.status, 403, `sign-in with Host "${host}"`);
    assert.equal(noSignIn.headers["set-cookie"], undefined);
  }

  // An empty or absent Host, written straight onto a socket because node:http always sends one.
  const raw = (head: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => socket.end(head));
      let reply = "";
      socket.setEncoding("utf8").on("data", (chunk: string) => (reply += chunk));
      socket.on("end", () => resolve(reply)).on("error", reject);
    });
  assert.match(await raw(`GET /health HTTP/1.1\r\nHost:\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403 /);
  assert.match(await raw(`GET /health HTTP/1.1\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
  assert.match(await raw(`GET /health HTTP/1.0\r\nCookie: ${cookie}\r\n\r\n`), /^HTTP\/1\.1 403 /, "HTTP/1.0 with no Host");

  // Without the name in the configuration the same request is refused.
  const { server: plain, token: plainToken } = await start(t);
  assert.equal((await signIn(plain.port, plainToken, { headers: { host: name, origin: `https://${name}` } })).status, 403);
});
