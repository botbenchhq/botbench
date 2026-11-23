import assert from "node:assert/strict";
import { fillLine } from "../support/sign-in-line.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIN_TOKEN_FILE, MAX_WAITING_SIGN_INS } from "../../src/api/auth.ts";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_LIFETIME_MS, REFUSAL_WORDS } from "../../src/api/pairing.ts";
import { DB_FILE } from "../../src/store/db.ts";
import { startServer, type StartOptions } from "../../src/server.ts";
import { removedAtEnd } from "../support/repo.ts";

// Adding a device with a one-time code, through the real server: real HTTP, the real store in a temporary directory,
// and a short lifetime asked of the server for the expiry, never a changed clock.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function tempHome(t: T): string {
  const dir = removedAtEnd(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-pairing-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "home");
}

async function start(t: T, options: Partial<StartOptions> = {}): Promise<{ base: string; home: string; token: string }> {
  const home = tempHome(t);
  const server = await startServer({ config: { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} }, home, signInDelayMs: 1, ...options });
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.port}`, home, token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim() };
}

interface SignedIn {
  status: number;
  body: { error?: string; refused?: string; signedIn?: boolean };
  setCookie: string | null;
}

async function signIn(base: string, body: unknown, userAgent = MAC_CHROME): Promise<SignedIn> {
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: { ...JSON_TYPE, "user-agent": userAgent }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as SignedIn["body"], setCookie: res.headers.get("set-cookie") };
}

const cookieOf = (setCookie: string | null): string => {
  assert.ok(setCookie, "a session cookie is set");
  return setCookie.split(";")[0]!;
};

async function newCode(base: string, cookie: string): Promise<{ code: string; expiresAt: string }> {
  const res = await fetch(`${base}/api/devices/pairing`, { method: "POST", headers: { ...JSON_TYPE, cookie }, body: "{}" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("cache-control"), "no-store");
  return (await res.json()) as { code: string; expiresAt: string };
}

async function owner(base: string, token: string): Promise<string> {
  const reply = await signIn(base, { token });
  assert.equal(reply.status, 200);
  return cookieOf(reply.setCookie);
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** The rows of the pairing table, read from the store file as another process would. */
function pairingRows(home: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(home, DB_FILE), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM device_pairing").all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

test("only a signed-in device can make a code; it is 8 symbols with no look-alikes, valid for 5 minutes", async (t) => {
  const { base, token } = await start(t);
  const refused = await fetch(`${base}/api/devices/pairing`, { method: "POST", headers: JSON_TYPE, body: "{}" });
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: "sign in required" });
  const forged = await fetch(`${base}/api/devices/pairing`, { method: "POST", headers: { ...JSON_TYPE, cookie: "botbench_session=forged" }, body: "{}" });
  assert.equal(forged.status, 401);

  const cookie = await owner(base, token);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    // The code's life starts while it is being made: between the request and its answer, however long a loaded machine takes.
    const asked = Date.now();
    const { code, expiresAt } = await newCode(base, cookie);
    const answered = Date.now();
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    assert.ok([...code].every((c) => PAIRING_CODE_ALPHABET.includes(c)), code);
    assert.doesNotMatch(code, /[01IO]/);
    const expires = Date.parse(expiresAt);
    // The stored time is whole milliseconds or seconds: a second's leeway on each side for its rounding.
    assert.ok(expires >= asked + PAIRING_LIFETIME_MS - 1000 && expires <= answered + PAIRING_LIFETIME_MS + 1000, `expires ${expires - asked}ms after it was asked for, ${expires - answered}ms after the answer`);
    seen.add(code);
  }
  assert.equal(seen.size, 20, "each code is new");
});

test("a code signs a device in once, ignoring case, spaces and dashes, with the same cookie and device label as the token; the second use is refused", async (t) => {
  const { base, token } = await start(t);
  const tokenSignIn = await signIn(base, { token });
  const cookie = cookieOf(tokenSignIn.setCookie);
  const { code } = await newCode(base, cookie);

  const typed = ` ${code.slice(0, 4).toLowerCase()} - ${code.slice(4)} `;
  const paired = await signIn(base, { code: typed }, IPHONE_SAFARI);
  assert.equal(paired.status, 200);
  assert.deepEqual(paired.body, { signedIn: true });
  const attributes = (setCookie: string | null): string => setCookie!.split(";").slice(1).join(";");
  assert.equal(attributes(paired.setCookie), attributes(tokenSignIn.setCookie), "the same cookie attributes as a token sign-in");
  const phone = cookieOf(paired.setCookie);
  assert.notEqual(phone, cookie);

  // An ordinary session: it reaches the routes and is listed among the devices, labelled from its browser.
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie: phone } })).status, 200);
  const devices = (await (await fetch(`${base}/api/devices`, { headers: { cookie: phone } })).json()) as { devices: { device: string; current: boolean }[] };
  assert.deepEqual(devices.devices.map((d) => [d.device, d.current]), [["Mac · Chrome", false], ["iPhone · Safari", true]]);

  const again = await signIn(base, { code });
  assert.equal(again.status, 401);
  assert.deepEqual(again.body, { error: REFUSAL_WORDS.used, refused: "used" });
  assert.equal(again.setCookie, null, "no session for a used code");
  assert.equal(devices.devices.length, 2);
});

test("a code expires after its lifetime, is refused as expired, and its pairing is dropped from the store", async (t) => {
  const { base, home, token } = await start(t, { pairingLifetimeMs: 300 });
  const { code } = await newCode(base, await owner(base, token));
  assert.equal(pairingRows(home).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const late = await signIn(base, { code });
  assert.equal(late.status, 401);
  assert.deepEqual(late.body, { error: REFUSAL_WORDS.expired, refused: "expired" });
  assert.equal(late.setCookie, null);
  assert.deepEqual(pairingRows(home), [], "the expired pairing is gone");
  // Once dropped, the store no longer knows it: it reads as a code that was never issued.
  assert.equal((await signIn(base, { code })).body.refused, "wrong");
});

test("a new code cancels the one before it, which is then refused; a code never issued and one that is not a code get the wrong-code answer", async (t) => {
  const { base, home, token } = await start(t);
  const cookie = await owner(base, token);
  const first = await newCode(base, cookie);
  const second = await newCode(base, cookie);
  assert.equal(pairingRows(home).length, 1, "at most one pairing is held");

  const cancelled = await signIn(base, { code: first.code });
  assert.equal(cancelled.status, 401);
  assert.deepEqual(cancelled.body, { error: REFUSAL_WORDS.replaced, refused: "replaced" });
  assert.equal(cancelled.setCookie, null);

  const never = [...second.code].map((c) => PAIRING_CODE_ALPHABET[(PAIRING_CODE_ALPHABET.indexOf(c) + 1) % PAIRING_CODE_ALPHABET.length]).join("");
  for (const wrong of [never, "", "not a code at all", "ABCD"]) {
    const reply = await signIn(base, { code: wrong });
    assert.equal(reply.status, 401, JSON.stringify(wrong));
    assert.deepEqual(reply.body, { error: REFUSAL_WORDS.wrong, refused: "wrong" });
    assert.equal(reply.setCookie, null);
  }
  // None of those spent the newer code.
  assert.equal((await signIn(base, { code: second.code })).status, 200);

  for (const body of [{}, { token, code: second.code }, { code: 12345678 }]) {
    const reply = await signIn(base, body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.equal(reply.setCookie, null);
  }
});

test("a code dies with the device that made it: signed out, or signed out by Sign out everywhere else, its code no longer signs in", async (t) => {
  const { base, home, token } = await start(t);
  const mac = await owner(base, token);
  const devices = async (): Promise<{ id: number; device: string; current: boolean }[]> =>
    ((await (await fetch(`${base}/api/devices`, { headers: { cookie: mac } })).json()) as { devices: { id: number; device: string; current: boolean }[] }).devices;

  // A stolen session makes a code; the owner then signs that session out.
  const stolen = cookieOf((await signIn(base, { token }, IPHONE_SAFARI)).setCookie);
  const { code } = await newCode(base, stolen);
  const thief = (await devices()).find((d) => !d.current)!;
  assert.equal((await fetch(`${base}/api/devices/${thief.id}/sign-out`, { method: "POST", headers: { ...JSON_TYPE, cookie: mac }, body: "{}" })).status, 200);
  assert.deepEqual(pairingRows(home), [], "its pairing went with it");
  const late = await signIn(base, { code });
  assert.equal(late.status, 401);
  assert.equal(late.body.refused, "wrong");
  assert.equal(late.setCookie, null);

  // The same through Sign out everywhere else.
  const another = cookieOf((await signIn(base, { token }, IPHONE_SAFARI)).setCookie);
  const second = await newCode(base, another);
  assert.equal((await fetch(`${base}/api/devices/sign-out-others`, { method: "POST", headers: { ...JSON_TYPE, cookie: mac }, body: "{}" })).status, 200);
  assert.deepEqual(pairingRows(home), []);
  assert.equal((await signIn(base, { code: second.code })).setCookie, null);
  assert.deepEqual((await devices()).map((d) => d.current), [true], "only the owner's own device is signed in");

  // The owner's own code is not touched by signing the others out.
  const mine = await newCode(base, mac);
  assert.equal((await fetch(`${base}/api/devices/sign-out-others`, { method: "POST", headers: { ...JSON_TYPE, cookie: mac }, body: "{}" })).status, 200);
  assert.equal((await signIn(base, { code: mine.code })).status, 200);
});

test("wrong codes and wrong tokens share one slow-down: the same failure count, the same doubling delay, reset by a right code", async (t) => {
  // 200 ms, so the reset's upper bound below (8 delays) leaves the same 1.6 s for two requests as the token test's does.
  const delay = 200;
  const { base, token } = await start(t, { signInDelayMs: delay });
  const { code } = await newCode(base, await owner(base, token));
  const slack = 5; // timers may fire a few milliseconds early
  // Each wait is counted from when the attempt before it was checked, which is before the client has that attempt's
  // answer: on a loaded machine, delivering the answer can use up much of the next wait, so one request's own time
  // proves nothing (this test used to fail that way). Load cannot shorten the time from sending attempt n to the answer
  // of attempt n+1, which holds at least the wait attempt n set, so attempts are timed in pairs. Load only adds to those
  // times: they fall short only when the wait is removed (the first pair takes about 0), is kept apart for codes and
  // tokens (about 1 delay where 2 are due), or does not double (the second pair takes about 2 delays where 8 are due).
  const pair = async (first: unknown, second: unknown): Promise<{ statuses: number[]; ms: number }> => {
    const began = performance.now();
    const statuses = [(await signIn(base, first)).status, (await signIn(base, second)).status];
    return { statuses, ms: performance.now() - began };
  };

  assert.equal((await signIn(base, { token: "wrong-1" })).status, 401); // one failure: the next guess waits 1 delay
  // A wrong code after the wrong token waits that 1 delay and sets 2, which the wrong token after it waits: one count.
  const mixed = await pair({ code: "ZZZZ-ZZZZ" }, { token: "wrong-3" });
  assert.deepEqual(mixed.statuses, [401, 401]);
  assert.ok(mixed.ms >= 2 * delay - slack, `from sending a wrong code to the answer of the wrong token after it took ${mixed.ms}ms; the token must wait 2 delays (${2 * delay}ms) after the code is checked`);

  // The fourth wrong guess waits 4 delays and sets 8, and the right code waits its turn behind them, then signs in.
  const turn = await pair({ code: "YYYY-YYYY" }, { code });
  assert.deepEqual(turn.statuses, [401, 200]);
  assert.ok(turn.ms >= 8 * delay - slack, `from sending the fourth wrong guess to the right code's answer took ${turn.ms}ms; the code must wait 8 delays (${8 * delay}ms) after the guess is checked`);

  // The right code cleared the count, for tokens too: two wrong tokens now cost one delay between them, as at the start.
  // Had the count stayed at four, the second would wait 16 delays. The upper bound is half that plus what two requests
  // cost this machine right now, measured in this run: a pair of the owner's right tokens, which wait for nothing (the
  // count is already clear), taken three times and the slowest kept. Load adds the same to both, so it cannot push a
  // real reset past the bound, and a count that was not reset is still 8 delays beyond it.
  let requests = 0;
  for (let i = 0; i < 3; i++) {
    const free = await pair({ token }, { token });
    assert.deepEqual(free.statuses, [200, 200]);
    requests = Math.max(requests, free.ms);
  }
  const reset = await pair({ token: "wrong-5" }, { token: "wrong-6" });
  assert.deepEqual(reset.statuses, [401, 401]);
  assert.ok(reset.ms >= delay - slack, `after a right code, a second wrong token still waits one delay: took ${reset.ms}ms`);
  assert.ok(reset.ms < 8 * delay + requests, `after a right code, two wrong tokens took ${reset.ms}ms, and two requests take this machine ${requests}ms now: the count was not reset (16 delays, ${16 * delay}ms, is what a count of four costs)`);
});

test("codes wait in the same bounded line as tokens: once it is full, even a right code is turned away unchecked and stays unused", async (t) => {
  // A long first wait, so that nothing leaves the line while the test looks, however slow the machine.
  const delay = 30_000;
  const { base, token } = await start(t, { signInDelayMs: delay });
  const { code } = await newCode(base, await owner(base, token));
  assert.equal((await signIn(base, { code: "WRONG-ONE" })).status, 401); // from here each attempt waits the delay or more
  for (let i = 0; i < MAX_WAITING_SIGN_INS; i++) signIn(base, i % 2 === 0 ? { code: `QUEUED${i}` } : { token: `queued-${i}` }).catch(() => undefined);
  // The line is full once a wrong guess is turned away. One that arrives before it is full joins the line instead, and
  // waits there: the test does not wait for it, and the next guess is sent.
  await fillLine(() => signIn(base, { code: "OVER-ONE" }).then((reply) => reply.status));
  for (const body of [{ code: "OVER-TWO" }, { token }, { code }]) {
    const began = performance.now();
    const turnedAway = await signIn(base, body);
    assert.equal(turnedAway.status, 429, JSON.stringify(body));
    assert.equal(turnedAway.setCookie, null);
    assert.ok(performance.now() - began < delay, "turned away at once, not after the wait");
  }
});

test("only the code's SHA-256 is stored, and the code is in no table, no store file and no line the process writes", async (t) => {
  const home = tempHome(t);
  const entry = fileURLToPath(new URL("../../src/server.ts", import.meta.url));
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, "close");

  // The real entry point, as the owner starts it, so everything it logs is caught.
  const child = spawn(process.execPath, [entry], { env: { ...process.env, BOTBENCH_HOME: home, BOTBENCH_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => void child.kill("SIGKILL"));
  const exited = once(child, "exit");
  let output = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("listening")) resolve();
    });
    void exited.then(() => reject(new Error(`the process exited before listening: ${output}`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const cookie = await owner(base, fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim());
  const replaced = (await newCode(base, cookie)).code;
  const { code } = await newCode(base, cookie);
  const rows = pairingRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.code_hash, sha256(code));
  assert.equal(rows[0]!.replaced_hash, sha256(replaced));
  for (const plain of [code, replaced]) {
    for (const value of Object.values(rows[0]!)) assert.ok(!String(value).includes(plain), "the code is in no column");
  }
  // The signs-ins: one with the code, a second refused, a cancelled one and a wrong one.
  assert.equal((await signIn(base, { code: code.toLowerCase() })).status, 200);
  assert.equal((await signIn(base, { code })).status, 401);
  assert.equal((await signIn(base, { code: replaced })).status, 401);
  assert.equal((await signIn(base, { code: "ZZZZ-ZZZZ" })).status, 401);

  child.kill("SIGTERM");
  const [status] = await exited;
  assert.equal(status, 0, output);
  // Every file of the store, the write-ahead log included, and everything the process wrote.
  for (const file of fs.readdirSync(home)) {
    const full = path.join(home, file);
    if (!fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full).toString("latin1");
    for (const plain of [code, replaced]) assert.ok(!bytes.includes(plain), `the code is not in ${file}`);
  }
  for (const plain of [code, replaced, code.toLowerCase()]) assert.ok(!output.includes(plain), "the code is in nothing the process wrote");
  assert.ok(!output.includes("ZZZZ-ZZZZ"), "nor is a wrong code");
  // What happened is in the log, in words, without the code: each code made, and the device it added.
  assert.equal(output.match(/A one-time code to add a device was made on device \d+ \(Mac · Chrome\)\./g)?.length, 2, output);
  assert.match(output, /A device was added with a one-time code: device \d+ \(Mac · Chrome\), from the code made on device \d+\./);
  assert.equal(output.match(/was added with a one-time code/g)?.length, 1, "only the sign-in that worked");
});
