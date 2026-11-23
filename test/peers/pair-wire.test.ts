import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { newId } from "../../src/peers/envelope.ts";
import { workbenchKey } from "../../src/peers/key.ts";
import {
  asPairRequest,
  hmacMatches,
  INVITE_PREFIX,
  inviteText,
  pairAnswerBytes,
  pairRequestBytes,
  proveRequest,
  readInvite,
  readPairAnswer,
  signPairAnswer,
  wireRequestDigest,
  type Invite,
  type PairRequestFields,
} from "../../src/peers/pair-wire.ts";
import { newPairingKey } from "../../src/peers/pairings.ts";

// The byte forms of pairing on the wire (ADR 0004 decision 3): the pair request its HMAC covers, the inviter's signed
// answer, and the one line an owner passes on.

const keyIn = (t: { after(fn: () => void): void }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-pair-wire-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return workbenchKey(home);
};

const fields = (key: string, over: Partial<PairRequestFields> = {}): PairRequestFields => ({ inviteId: newId(), pairingKey: newPairingKey(), key, name: "bob", address: "127.0.0.1:4791", repository: "github.com/botbenchhq/botbench", ...over });

test("the pair request's byte form is a fixed prefix and each field tagged and length-prefixed, in a fixed order", (t) => {
  const r = fields(keyIn(t).publicKey);
  const bytes = pairRequestBytes(r);
  const prefix = Buffer.from("botbench pair request 1\n");
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  let at = prefix.length;
  for (const value of [r.inviteId, r.pairingKey, r.key, r.name, r.address, r.repository]) {
    assert.equal(bytes[at], 1, "present");
    const length = bytes.readUInt32BE(at + 1);
    assert.equal(bytes.subarray(at + 5, at + 5 + length).toString("utf8"), value);
    at += 5 + length;
  }
  assert.equal(at, bytes.length, "nothing else");
});

test("moving text across a field boundary changes the bytes, so no two requests share an HMAC", (t) => {
  const key = keyIn(t).publicKey;
  const a = fields(key, { name: "bob", address: "127.0.0.1:4791" });
  assert.notDeepEqual(pairRequestBytes(a), pairRequestBytes({ ...a, name: "bob1", address: "27.0.0.1:4791" }));
  assert.notDeepEqual(pairRequestBytes(a), pairRequestBytes({ ...a, repository: `${a.repository}x` }));
  assert.throws(() => pairRequestBytes({ ...a, name: "bo\uD800b" }), /not well-formed text/);
});

test("the HMAC is HMAC-SHA256 of that byte form with the invite's secret, and is checked in full against every field", (t) => {
  const secret = randomBytes(32);
  const r = proveRequest(fields(keyIn(t).publicKey), secret);
  assert.equal(r.hmac, createHmac("sha256", secret).update(pairRequestBytes(r)).digest("base64url"));
  assert.equal(hmacMatches(r, secret), true);
  assert.equal(hmacMatches(r, randomBytes(32)), false, "another secret");
  for (const change of [{ name: "eve" }, { address: "127.0.0.1:4792" }, { pairingKey: newPairingKey() }, { repository: "github.com/x/y" }, { inviteId: newId() }]) {
    assert.equal(hmacMatches({ ...r, ...change }, secret), false, JSON.stringify(change));
  }
  assert.equal(hmacMatches({ ...r, hmac: Buffer.alloc(32).toString("base64url") }, secret), false);
  // The digest the inviter keeps covers the HMAC too: a retry is known as the request that was checked.
  assert.equal(wireRequestDigest(r), wireRequestDigest({ ...r }));
  assert.notEqual(wireRequestDigest(r), wireRequestDigest(proveRequest(r, randomBytes(32))));
});

test("a pair request is read only in its exact form", (t) => {
  const r = proveRequest(fields(keyIn(t).publicKey), randomBytes(32));
  assert.deepEqual(asPairRequest(JSON.parse(JSON.stringify(r))), r);
  for (const bad of [null, [], "x", { ...r, extra: 1 }, { ...r, hmac: "short" }, { ...r, pairingKey: "ABC" }, { ...r, address: "8.8.8.8:1" }, { ...r, name: "Not A Name" }, { ...r, key: "x" }, { ...r, inviteId: "1" }, { ...r, repository: "" }, Object.fromEntries(Object.entries(r).filter(([k]) => k !== "name"))]) {
    assert.equal(asPairRequest(bad), null, JSON.stringify(bad));
  }
});

test("the inviter's answer is signed over its own byte form and taken only for the request this side sent", (t) => {
  const alice = keyIn(t);
  const bob = keyIn(t);
  const sent = proveRequest(fields(bob.publicKey), randomBytes(32));
  const answer = { pairingId: newId(), inviteId: sent.inviteId, pairingKey: sent.pairingKey, repository: sent.repository, inviterKey: alice.publicKey, joinerKey: bob.publicKey };
  const signed = signPairAnswer(answer, alice);
  assert.deepEqual(signPairAnswer(answer, alice), signed, "Ed25519 is deterministic: a retried request gets the same bytes");
  assert.ok(pairAnswerBytes(answer).subarray(0, 23).equals(Buffer.from("botbench pair answer 1\n")));
  assert.deepEqual(readPairAnswer(JSON.parse(JSON.stringify(signed)), sent), answer);
  // Signed by another key than the one it names, changed after signing, or for another request: refused.
  assert.equal(readPairAnswer({ answer, signature: bob.sign(pairAnswerBytes(answer)).toString("base64url") }, sent), null);
  assert.equal(readPairAnswer({ ...signed, answer: { ...answer, pairingId: newId() } }, sent), null);
  assert.equal(readPairAnswer(signed, { ...sent, pairingKey: newPairingKey() }), null);
  assert.equal(readPairAnswer(signed, { ...sent, inviteId: newId() }), null);
  const forOther = { ...answer, joinerKey: alice.publicKey === bob.publicKey ? answer.joinerKey : keyIn(t).publicKey };
  assert.equal(readPairAnswer(signPairAnswer(forOther, alice), sent), null, "an answer made for another joining key");
  assert.equal(readPairAnswer({ ...signed, extra: 1 }, sent), null);
  assert.throws(() => signPairAnswer({ ...answer, inviterKey: bob.publicKey }, alice), /only with the key it names/);
});

test("the invite is one line safe to paste, read back whole, and refused whole when anything is off, without repeating what was pasted", (t) => {
  const alice = keyIn(t);
  const invite: Invite = { id: newId(), name: "alice", fingerprint: alice.fingerprint, address: "127.0.0.1:4790", repository: "github.com/botbenchhq/botbench", expiresAt: new Date(Date.now() + 60_000).toISOString(), secret: randomBytes(32) };
  const text = inviteText(invite);
  assert.ok(text.startsWith(INVITE_PREFIX));
  assert.match(text, /^[A-Za-z0-9._-]+$/, "letters, digits, '.', '-' and '_' only: no space, quote, slash or line break");
  assert.ok(text.length < 600);
  assert.deepEqual(readInvite(`  ${text}\n`), invite, "the spaces and line break a paste brings are trimmed");
  const body = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  const remade = (over: Record<string, unknown>) => INVITE_PREFIX + Buffer.from(JSON.stringify({ ...body, ...over })).toString("base64url");
  for (const bad of [text.slice(0, -4), `x${text}`, `${text} more`, text.replace(INVITE_PREFIX, "botbench-invite-2."), remade({ secret: randomBytes(16).toString("base64url") }), remade({ fingerprint: "nope" }), remade({ v: 2 }), remade({ extra: 1 }), remade({ expiresAt: "tomorrow" }), "", 42]) {
    const read = readInvite(bad);
    assert.ok("problem" in read, String(bad));
    if (typeof bad === "string" && bad.length > 0) assert.ok(!read.problem.includes(bad.slice(INVITE_PREFIX.length, INVITE_PREFIX.length + 20)), "the problem does not repeat the paste");
  }
  const publicAddress = readInvite(remade({ address: "8.8.8.8:4790" }));
  assert.ok("problem" in publicAddress && /not loopback or private/.test(publicAddress.problem));
});
