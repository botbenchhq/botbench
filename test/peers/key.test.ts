import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";
import { fingerprintOf, publicKeyProblem, verifySignature, WORKBENCH_KEY_FILE, workbenchKey } from "../../src/peers/key.ts";

function tempHome(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the workbench key is made at first need, owner-only, and the same key is read every time after", (t) => {
  const home = tempHome(t);
  const file = path.join(home, WORKBENCH_KEY_FILE);
  assert.equal(fs.existsSync(file), false, "no key before something needs one");
  const first = workbenchKey(home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(publicKeyProblem(first.publicKey), null);
  const again = workbenchKey(home);
  assert.equal(again.publicKey, first.publicKey);
  assert.equal(again.fingerprint, first.fingerprint);
  // A file loosened by something else is narrowed again when read.
  fs.chmodSync(file, 0o644);
  workbenchKey(home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // What it signs, its public key checks, and another key does not.
  const bytes = Buffer.from("a message");
  const signature = first.sign(bytes);
  assert.equal(verifySignature(first.publicKey, bytes, signature), true);
  assert.equal(verifySignature(first.publicKey, Buffer.from("a messagf"), signature), false);
});

test("a second data folder gets a different key, and the fingerprint is the key's alone", (t) => {
  const a = workbenchKey(tempHome(t));
  const b = workbenchKey(tempHome(t));
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(verifySignature(b.publicKey, Buffer.from("x"), a.sign(Buffer.from("x"))), false);
  assert.match(a.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
  assert.equal(fingerprintOf(a.publicKey), a.fingerprint);
  // Pinned: the same 32 bytes always give these digits, in this and any later version.
  assert.equal(fingerprintOf(Buffer.alloc(32, 7).toString("base64url")), "4bb0 6f8e 4e3a 7715 d201");
});

test("nothing a log, a JSON answer or an inspection can reach holds the private key", (t) => {
  const home = tempHome(t);
  const key = workbenchKey(home);
  const pem = fs.readFileSync(path.join(home, WORKBENCH_KEY_FILE), "utf8");
  const secret = pem.split("\n").filter((line) => line !== "" && !line.startsWith("-----")).join("");
  assert.ok(secret.length > 40);
  const shown = [JSON.stringify(key), inspect(key, { showHidden: true, depth: 10 }), String(Object.values(key)), Object.keys(key).join(",")];
  for (const text of shown) {
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("PRIVATE"), false);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(key)), { publicKey: key.publicKey, fingerprint: key.fingerprint });
  assert.equal(Object.isFrozen(key), true);
});

test("a key file that holds something else stops with what to do, and is never replaced by itself", (t) => {
  const home = tempHome(t);
  const file = path.join(home, WORKBENCH_KEY_FILE);
  fs.writeFileSync(file, "not a key\n", { mode: 0o600 });
  assert.throws(() => workbenchKey(home), /does not hold this workbench's key.*new invite/s);
  assert.equal(fs.readFileSync(file, "utf8"), "not a key\n");
});
