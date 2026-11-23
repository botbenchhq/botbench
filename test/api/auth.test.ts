import assert from "node:assert/strict";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { LOGIN_TOKEN_FILE, MAX_WAITING_SIGN_INS, SESSION_COOKIE } from "../../src/api/auth.ts";
import { deviceLabel, SESSION_MAX_AGE_S } from "../../src/api/sessions.ts";
import { DEFAULT_CONFIG_FILE, loadConfig, type Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { removedAtEnd } from "../support/repo.ts";
import { fillLine } from "../support/sign-in-line.ts";

type T = { after(fn: () => unknown): void };

const JSON_TYPE = { "content-type": "application/json" };
const hasIpv6Loopback = Object.values(os.networkInterfaces()).flat().some((i) => i?.address === "::1");

/** Start the real server on a free port with its data in a temporary directory. */
async function start(t: T, overrides: Partial<Config> = {}, signInDelayMs = 1): Promise<{ server: BotbenchServer; home: string; token: string }> {
  const dir = removedAtEnd(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-auth-")));
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
    assert.deepEqual(JSON.parse(health.body), { status: "ok", schemaVersion: MIGRATIONS.length });
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
  assert.ok(attrs.includes(`max-age=${90 * 24 * 60 * 60}`), `the device stays signed in for 90 days: ${cookie.header}`);
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

  // What is measured, and why it holds on a loaded machine. Each wrong attempt sets the wait before the next is
  // checked, counted from the moment it was itself checked. That moment comes after the client sent it and before the
  // client has its answer, and a loaded machine can spend much of the next wait just delivering that answer, so the
  // time of one request alone proves nothing (this test used to fail that way). What load cannot shorten: from the
  // moment attempt n is sent to the moment attempt n+1 is answered, at least the wait attempt n set passes. So attempts
  // are timed from one's sending to a later one's answer. Load only adds to these times, so they fall short only when
  // the wait is: removed (the pair below takes about 0), or not growing (the parallel pair takes about 2 delays where
  // 8 are due; seen failing both ways).
  const pair = async (first: string, second: string): Promise<{ statuses: number[]; ms: number }> => {
    const began = performance.now();
    const statuses = [(await signIn(server.port, first)).status, (await signIn(server.port, second)).status];
    return { statuses, ms: performance.now() - began };
  };
  assert.equal((await timed("wrong-1")).status, 401); // the first failure: the next one waits 1 delay
  // wrong-2 waits 1 delay and sets 2 for wrong-3, so wrong-3 is answered at least 2 delays after wrong-2 was sent. This
  // shows there is a wait; a wait that did not grow would still take about 2 delays here (1 left of wrong-2's, 1 of
  // wrong-3's), and it is the 8 delays below that show the doubling.
  const second = await pair("wrong-2", "wrong-3");
  assert.deepEqual(second.statuses, [401, 401]);
  assert.ok(second.ms >= 2 * delay - slack, `from sending the second wrong token to the third's answer took ${second.ms}ms; the third must wait 2 delays (${2 * delay}ms) after the second is checked`);

  // Sending guesses side by side does not get around the wait: they are answered one after another. wrong-4 waits the
  // 4 delays wrong-3 set and sets 8, so the fifth is answered at least 8 delays after the fourth was checked, which is
  // after `began`; checked side by side, both would be answered within the 4 delays the third set off.
  const began = performance.now();
  const parallel = await Promise.all([timed("wrong-4"), timed("wrong-5")]);
  assert.deepEqual(parallel.map((p) => p.status), [401, 401]);
  assert.ok(performance.now() - began >= 8 * delay - slack, `two parallel guesses took ${performance.now() - began}ms; the fifth must wait 8 delays (${8 * delay}ms) after the fourth is checked`);

  // The owner's correct token still works, after the 16-delay wait, and clears the count. Shown by the wait after it:
  // two wrong tokens now cost one delay between them, as at the start. Had the count stayed at five, the second would
  // wait 32 delays. The upper bound is half that plus what two requests cost this machine right now, measured in this
  // run: a pair of right tokens, which wait for nothing, taken three times and the slowest kept. Load adds the same to
  // both, so it cannot push a real reset past the bound, and a count that was not reset is still 16 delays beyond it.
  const right = await timed(token);
  assert.equal(right.status, 200);
  let requests = 0;
  for (let i = 0; i < 3; i++) {
    const free = await pair(token, token);
    assert.deepEqual(free.statuses, [200, 200]);
    requests = Math.max(requests, free.ms);
  }
  const reset = await pair("wrong-6", "wrong-7");
  assert.deepEqual(reset.statuses, [401, 401]);
  assert.ok(reset.ms >= delay - slack, `after a successful sign-in, a second wrong token still waits one delay: took ${reset.ms}ms`);
  assert.ok(reset.ms < 16 * delay + requests, `after a successful sign-in, two wrong tokens took ${reset.ms}ms, and two requests take this machine ${requests}ms now: the count was not reset (32 delays, ${32 * delay}ms, is what a count of five costs)`);
});

test("a flood of guesses is turned away unchecked instead of queueing without end", async (t) => {
  // A long first wait, so that nothing leaves the line while the test looks, however slow the machine.
  const delay = 30_000;
  const { server, token } = await start(t, {}, delay);
  assert.equal((await signIn(server.port, "wrong-0")).status, 401); // from here each attempt waits the delay or more
  // These wait their turn; the test does not wait for them, and closing the server ends them.
  for (let i = 0; i < MAX_WAITING_SIGN_INS; i++) signIn(server.port, `queued-${i}`).catch(() => undefined);
  // The line is full once a wrong guess is turned away; one sent before that joins it (test/support/sign-in-line.ts).
  await fillLine(() => signIn(server.port, "over-0").then((reply) => reply.status));
  for (const candidate of ["over-1", "over-2", token]) {
    const began = performance.now();
    const turnedAway = await signIn(server.port, candidate);
    assert.equal(turnedAway.status, 429, candidate === token ? "even the right token is not checked" : candidate);
    assert.equal(turnedAway.headers["set-cookie"], undefined);
    assert.ok(performance.now() - began < delay, "turned away at once, not after the wait");
  }
});

test("with no extra address configured, Botbench listens on the loopback address only", async (t) => {
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
  // Every other address this machine has, on every interface, must not answer on Botbench's port.
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
  // Sessions are kept in the database: the restart left the earlier session signed in, and the token still signs in.
  assert.equal((await request({ port: again.port, path: "/health", headers: { cookie } })).status, 200);
  assert.equal((await signIn(again.port, token)).status, 200);
});

test("the entry point prints the token only on the start that created it", async (t) => {
  const home = path.join(removedAtEnd(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-auth-entry-"))), "home");
  t.after(() => fs.rmSync(path.dirname(home), { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../../src/server.ts", import.meta.url));

  /** Run the real process until it listens, use it, stop it, and return everything it wrote. */
  const run = async (use: (port: number) => Promise<void>): Promise<{ stdout: string; stderr: string }> => {
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as net.AddressInfo).port;
    probe.close();
    await once(probe, "close");

    const child = spawn(process.execPath, [entry], { env: { ...process.env, BOTBENCH_HOME: home, BOTBENCH_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
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
  let secret = "";
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
    secret = sessionCookie(signedIn).pair.split("=")[1]!;
    // A wrong session and an ended one are logged nowhere with their value either.
    await request({ port, path: "/health", headers: { cookie: `${SESSION_COOKIE}=${secret}x` } });
  });
  assert.ok(!second.stdout.includes(token), "a later start does not print the token");
  assert.ok(!second.stderr.includes(token));
  assert.ok(secret.length >= 43);
  assert.ok(!`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`.includes(secret), "the session secret is in no log line");
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

  // The same requests with Botbench's own origin and a JSON body are accepted.
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
  for (const flag of ["secure", "httponly", "samesite=strict", "path=/", `max-age=${90 * 24 * 60 * 60}`]) assert.ok(attrs.includes(flag), `${flag} in ${secure.header}`);
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

// Staying signed in (a device keeps its session for 90 days, across restarts) and the owner's list of signed-in devices.

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPHONE_HOME_SCREEN = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

test("a device is labelled from its browser's User-Agent, and an unknown one is just a browser", () => {
  assert.equal(deviceLabel(IPHONE_SAFARI), "iPhone · Safari");
  assert.equal(deviceLabel(IPHONE_HOME_SCREEN), "iPhone · Home Screen app");
  assert.equal(deviceLabel(MAC_CHROME), "Mac · Chrome");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15"), "Mac · Safari");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1"), "iPhone · Chrome");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0"), "Mac · Edge");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:145.0) Gecko/20100101 Firefox/145.0"), "Mac · Firefox");
  assert.equal(deviceLabel("curl/8.7.1"), "Browser");
  assert.equal(deviceLabel(""), "Browser");
  assert.equal(deviceLabel(undefined), "Browser");
});

test("a User-Agent made to make a pattern backtrack is labelled at once: the work grows with its length, not its square", () => {
  // "Version/" and a long run of digits with no "Safari/" after it: the pattern this replaced, `Version\/[\d.]+.*Safari\/`,
  // tried every split of the digits between its two repeats: about 4 seconds for this one (CodeQL alert 1).
  const hostile = `Mozilla/5.0 (Macintosh) Version/${"1".repeat(100_000)}`;
  const began = performance.now();
  assert.equal(deviceLabel(hostile), "Mac");
  assert.equal(deviceLabel(`${hostile} Safari/605.1.15`), "Mac", "what lies past the first 512 characters is not read");
  // Under a quarter of what the old pattern took, and loose enough for a loaded machine.
  assert.ok(performance.now() - began < 1000, `took ${performance.now() - began}ms`);
});

interface SessionRow {
  id: number;
  secret_hash: string;
  device: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}
const rows = (server: BotbenchServer): SessionRow[] => server.db.prepare("SELECT * FROM browser_sessions ORDER BY id").all() as unknown as SessionRow[];
const secretOf = (reply: Reply): string => sessionCookie(reply).pair.split("=")[1]!;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const daysFromNow = (days: number): string => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

/** Every byte of every file in the data folder, the database's write-ahead log included. */
function dataFolderBytes(home: string): string {
  return fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name)).toString("latin1")).join("\n");
}

test("a session is stored as a hash only, survives the server being closed and started again over the same data folder, and works there", async (t) => {
  const { server, home, token } = await start(t);
  const reply = await signIn(server.port, token, { headers: { "user-agent": IPHONE_SAFARI } });
  const secret = secretOf(reply);
  assert.ok(Buffer.from(secret, "base64url").length >= 16, "at least 128 bits");
  const [row] = rows(server);
  assert.equal(row!.secret_hash, sha256(secret), "the SHA-256 of the secret");
  assert.equal(row!.device, "iPhone · Safari");
  assert.ok(Math.abs(Date.parse(row!.expires_at) - Date.now() - SESSION_MAX_AGE_S * 1000) < 60_000, "expires in 90 days");
  assert.equal(row!.last_used_at, row!.created_at);
  assert.ok(!dataFolderBytes(home).includes(secret), "the secret itself is in no file of the data folder");

  await server.close();
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const again = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => again.close());
  assert.equal((await request({ port: again.port, path: "/api/session", headers: { cookie: sessionCookie(reply).pair } })).status, 200);
  // Something that merely looks like the stored hash is no session.
  assert.equal((await request({ port: again.port, path: "/health", headers: { cookie: `${SESSION_COOKIE}=${row!.secret_hash}` } })).status, 401);
  assert.ok(!dataFolderBytes(home).includes(secret));
});

test("an expired session is refused and its row removed, on use and at start", async (t) => {
  const { server, home, token } = await start(t);
  const a = await signIn(server.port, token);
  const b = await signIn(server.port, token);
  server.db.prepare("UPDATE browser_sessions SET expires_at = ? WHERE secret_hash = ?").run(daysFromNow(-1 / 24), sha256(secretOf(a)));
  const refused = await request({ port: server.port, path: "/health", headers: { cookie: sessionCookie(a).pair } });
  assert.equal(refused.status, 401);
  assert.deepEqual(rows(server).map((r) => r.secret_hash), [sha256(secretOf(b))], "the expired row is gone, the other kept");

  // One that expires while Botbench is stopped is gone after the next start, before anything uses it.
  server.db.prepare("UPDATE browser_sessions SET expires_at = ?").run(daysFromNow(-1));
  await server.close();
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const again = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => again.close());
  assert.deepEqual(rows(again), []);
  assert.equal((await request({ port: again.port, path: "/health", headers: { cookie: sessionCookie(b).pair } })).status, 401);
});

test("a session used more than a day after it was last renewed gets a fresh 90 days and the same cookie again; otherwise no cookie is sent", async (t) => {
  const { server, token } = await start(t, { publicHosts: ["mac.tailnet.ts.net"] });
  const reply = await signIn(server.port, token, { headers: { host: "mac.tailnet.ts.net", origin: "https://mac.tailnet.ts.net" } });
  const cookie = sessionCookie(reply).pair;
  const fresh = await request({ port: server.port, path: "/health", headers: { host: "mac.tailnet.ts.net", cookie } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers["set-cookie"], undefined, "renewed less than a day ago: nothing to send");

  // Signed in 89 days ago and last renewed then: one day of the 90 is left.
  server.db.prepare("UPDATE browser_sessions SET expires_at = ?").run(daysFromNow(1));
  const renewed = await request({ port: server.port, path: "/health", headers: { host: "mac.tailnet.ts.net", cookie } });
  assert.equal(renewed.status, 200);
  const again = sessionCookie(renewed);
  assert.equal(again.pair, cookie, "the same secret, sent again with a new lifetime");
  for (const flag of ["secure", "httponly", "samesite=strict", "path=/", `max-age=${SESSION_MAX_AGE_S}`]) assert.ok(attributes(again.header).includes(flag), `${flag} in ${again.header}`);
  assert.ok(Math.abs(Date.parse(rows(server)[0]!.expires_at) - Date.now() - SESSION_MAX_AGE_S * 1000) < 60_000, "the stored expiry moved too");

  // Renewed just now, so the next request sends nothing again.
  assert.equal((await request({ port: server.port, path: "/health", headers: { host: "mac.tailnet.ts.net", cookie } })).headers["set-cookie"], undefined);
  // On loopback a renewal is not Secure, as at sign-in.
  server.db.prepare("UPDATE browser_sessions SET expires_at = ?").run(daysFromNow(80));
  const direct = await request({ port: server.port, path: "/health", headers: { cookie } });
  assert.ok(!attributes(sessionCookie(direct).header).includes("secure"));
});

test("the last-used time is written at most once a minute", async (t) => {
  const { server, token } = await start(t);
  const cookie = sessionCookie(await signIn(server.port, token)).pair;
  const signedInAt = rows(server)[0]!.last_used_at;
  for (let i = 0; i < 3; i++) assert.equal((await request({ port: server.port, path: "/health", headers: { cookie } })).status, 200);
  assert.equal(rows(server)[0]!.last_used_at, signedInAt, "used within the minute: not written");

  const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  server.db.prepare("UPDATE browser_sessions SET last_used_at = ?").run(twoMinutesAgo);
  await request({ port: server.port, path: "/health", headers: { cookie } });
  const touched = rows(server)[0]!.last_used_at;
  assert.ok(Date.parse(touched) > Date.parse(twoMinutesAgo) + 60_000, "a minute later: written");
  await request({ port: server.port, path: "/health", headers: { cookie } });
  assert.equal(rows(server)[0]!.last_used_at, touched);
});

/** Open the event stream with a session; resolves once it is connected, with a promise for its end. */
function openStream(port: number, cookie: string): Promise<{ ended: Promise<void>; isOpen: () => boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/stream", headers: { cookie }, agent: false }, (res) => {
      assert.equal(res.statusCode, 200);
      let open = true;
      const ended = new Promise<void>((done) => {
        res.on("close", () => ((open = false), done()));
        res.on("error", () => ((open = false), done()));
      });
      res.once("data", () => resolve({ ended, isOpen: () => open }));
    });
    req.on("error", () => undefined);
    req.setTimeout(5000, () => reject(new Error("the stream did not open")));
  });
}

test("the owner lists the signed-in devices, signs one out, and signs out everywhere else; each ends at once, its open live updates included", async (t) => {
  const { server, token } = await start(t);
  const port = server.port;
  const phone = sessionCookie(await signIn(port, token, { headers: { "user-agent": IPHONE_SAFARI } })).pair;
  const homeScreen = sessionCookie(await signIn(port, token, { headers: { "user-agent": IPHONE_HOME_SCREEN } })).pair;
  const mac = sessionCookie(await signIn(port, token, { headers: { "user-agent": MAC_CHROME } })).pair;
  const own = { ...JSON_TYPE, origin: `http://127.0.0.1:${port}` };

  assert.equal((await request({ port, path: "/api/devices" })).status, 401, "the list needs a session");
  const listed = await request({ port, path: "/api/devices", headers: { cookie: mac } });
  assert.equal(listed.status, 200);
  const { devices } = JSON.parse(listed.body) as { devices: Array<{ id: number; device: string; signedInAt: string; lastUsedAt: string; current: boolean }> };
  assert.deepEqual(devices.map((d) => [d.device, d.current]), [["iPhone · Safari", false], ["iPhone · Home Screen app", false], ["Mac · Chrome", true]]);
  for (const d of devices) assert.deepEqual(Object.keys(d).sort(), ["current", "device", "id", "lastUsedAt", "signedInAt"]);
  for (const r of rows(server)) assert.ok(!listed.body.includes(r.secret_hash), "no hash in the list");

  // The Home Screen app has the live updates open; signing it out from the Mac ends them at once, and its session.
  const homeStream = await openStream(port, homeScreen);
  const macStream = await openStream(port, mac);
  const homeId = devices[1]!.id;
  const ended = await request({ port, method: "POST", path: `/api/devices/${homeId}/sign-out`, headers: { cookie: mac, ...own }, body: "{}" });
  assert.equal(ended.status, 200);
  assert.equal(ended.headers["set-cookie"], undefined, "another device's sign-out leaves this one's cookie alone");
  await homeStream.ended;
  assert.equal((await request({ port, path: "/health", headers: { cookie: homeScreen } })).status, 401);
  assert.equal(macStream.isOpen(), true, "the Mac's own live updates stay open");
  assert.equal(rows(server).length, 2);
  assert.equal((await request({ port, method: "POST", path: `/api/devices/${homeId}/sign-out`, headers: { cookie: mac, ...own }, body: "{}" })).status, 404, "already gone");
  assert.equal((await request({ port, method: "POST", path: "/api/devices/x/sign-out", headers: { cookie: mac, ...own }, body: "{}" })).status, 404);

  // Everywhere else: the phone goes, the Mac stays.
  const others = await request({ port, method: "POST", path: "/api/devices/sign-out-others", headers: { cookie: mac, ...own }, body: "{}" });
  assert.equal(others.status, 200);
  assert.equal((await request({ port, path: "/health", headers: { cookie: phone } })).status, 401);
  assert.equal((await request({ port, path: "/health", headers: { cookie: mac } })).status, 200);
  assert.equal(rows(server).length, 1);
  assert.equal(macStream.isOpen(), true);

  // Signing this device out deletes its row, clears its cookie and ends its live updates.
  const self = await request({ port, method: "POST", path: `/api/devices/${devices[2]!.id}/sign-out`, headers: { cookie: mac, ...own }, body: "{}" });
  assert.equal(self.status, 200);
  const cleared = sessionCookie(self);
  assert.equal(cleared.pair, `${SESSION_COOKIE}=`);
  for (const flag of ["httponly", "samesite=strict", "path=/", "max-age=0"]) assert.ok(attributes(cleared.header).includes(flag), `${flag} in ${cleared.header}`);
  await macStream.ended;
  assert.deepEqual(rows(server), []);
  assert.equal((await request({ port, path: "/health", headers: { cookie: mac } })).status, 401);

  // The routes are writes like any other: a foreign origin cannot sign a device out.
  const next = sessionCookie(await signIn(port, token)).pair;
  const foreign = await request({ port, method: "POST", path: "/api/devices/sign-out-others", headers: { cookie: next, ...JSON_TYPE, origin: "https://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
});
