import assert from "node:assert/strict";
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

// Adding a device with a one-time code, through the real server: real HTTP, the real store in a temporary directory,
// and a short lifetime asked of the server for the expiry, never a changed clock.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function tempHome(t: T): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-pairing-"));
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
  const before = Date.now();
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const { code, expiresAt } = await newCode(base, cookie);
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    assert.ok([...code].every((c) => PAIRING_CODE_ALPHABET.includes(c)), code);
    assert.doesNotMatch(code, /[01IO]/);
    const lifetime = Date.parse(expiresAt) - before;
    assert.ok(lifetime > PAIRING_LIFETIME_MS - 5000 && lifetime <= PAIRING_LIFETIME_MS + 5000, `valid for ${lifetime}ms`);
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

test("wrong codes and wrong tokens share one slow-down: the same failure count, the same doubling delay, reset by a right code", async (t) => {
  const delay = 100;
  const { base, token } = await start(t, { signInDelayMs: delay });
  const { code } = await newCode(base, await owner(base, token));
  const slack = 5; // timers may fire a few milliseconds early
  const timed = async (body: unknown): Promise<{ status: number; ms: number }> => {
    const began = performance.now();
    const reply = await signIn(base, body);
    return { status: reply.status, ms: performance.now() - began };
  };

  const a = await timed({ token: "wrong-1" });
  const b = await timed({ code: "ZZZZ-ZZZZ" });
  const c = await timed({ token: "wrong-3" });
  const d = await timed({ code: "YYYY-YYYY" });
  assert.deepEqual([a.status, b.status, c.status, d.status], [401, 401, 401, 401]);
  assert.ok(b.ms >= delay - slack, `a wrong code after a wrong token waited ${b.ms}ms`);
  assert.ok(c.ms >= 2 * delay - slack, `a wrong token after a wrong code waited ${c.ms}ms`);
  assert.ok(d.ms >= 4 * delay - slack, `the fourth wrong guess waited ${d.ms}ms`);

  // The right code still signs in after the wait, and clears the count for tokens too.
  const right = await timed({ code });
  assert.equal(right.status, 200);
  assert.ok(right.ms >= 8 * delay - slack, `the right code waited its turn, ${right.ms}ms`);
  const after = await timed({ token: "wrong-5" });
  assert.equal(after.status, 401);
  assert.ok(after.ms < delay, `after a right code a wrong token is answered at once, took ${after.ms}ms`);
});

test("codes wait in the same bounded line as tokens: once it is full, even a right code is turned away unchecked and stays unused", async (t) => {
  const { base, token } = await start(t, { signInDelayMs: 2000 });
  const { code } = await newCode(base, await owner(base, token));
  assert.equal((await signIn(base, { code: "WRONG-ONE" })).status, 401); // from here each attempt waits two seconds or more
  for (let i = 0; i < MAX_WAITING_SIGN_INS; i++) signIn(base, i % 2 === 0 ? { code: `QUEUED${i}` } : { token: `queued-${i}` }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100)); // let them arrive
  const began = performance.now();
  for (const body of [{ code: "OVER-ONE" }, { token }, { code }]) {
    const turnedAway = await signIn(base, body);
    assert.equal(turnedAway.status, 429, JSON.stringify(body));
    assert.equal(turnedAway.setCookie, null);
  }
  assert.ok(performance.now() - began < 1500, "turned away at once, not after the wait");
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
});
