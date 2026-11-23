import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openStore } from "../../src/store/db.ts";
import { newId, type SignedEnvelope } from "../../src/peers/envelope.ts";
import { workbenchKey, type WorkbenchKey } from "../../src/peers/key.ts";
import { receiveEnvelope, writeOutgoing, type Outgoing } from "../../src/peers/messages.ts";
import { removedAtEnd } from "./repo.ts";
import { acceptPairRequest, confirmByOwner, createInvite, getPairing, joinPairing, newPairingKey, pairingState, requestDigest, type PairRequest } from "../../src/peers/pairings.ts";

// Two workbenches' stores in one test, each with its own real key and real SQLite, paired by the store's own steps
// (no network): what the store tests of Peers P5 share.

export const REPO = "github.com/botbenchhq/botbench";

export interface Side {
  home: string;
  db: DatabaseSync;
  key: WorkbenchKey;
}
export function side(t: { after(fn: () => void): void }): Side {
  const home = removedAtEnd(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-peers-")));
  const s: Side = { home, db: openStore(home), key: workbenchKey(home) };
  t.after(() => {
    s.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return s;
}

/** A pair request as the joining side makes it: its fields and an HMAC of them made with the invite's secret. */
export function pairRequest(b: Side, inviteId: string, secret: Buffer, pairingKey = newPairingKey()): { request: PairRequest; hmac: Buffer; bytes: Buffer } {
  const fields = { inviteId, pairingKey, key: b.key.publicKey, name: "bob", address: "127.0.0.1:4791" };
  const body = Buffer.from(JSON.stringify(fields));
  const hmac = createHmac("sha256", secret).update(body).digest();
  const bytes = Buffer.concat([body, hmac]);
  return { request: { inviteId, pairingKey, requestDigest: requestDigest(bytes), peer: { key: fields.key, name: fields.name, address: fields.address } }, hmac, bytes };
}
export const hmacCheck = (bytes: Buffer, hmac: Buffer) => (secret: Buffer): boolean => timingSafeEqual(createHmac("sha256", secret).update(bytes.subarray(0, bytes.length - 32)).digest(), hmac);

/** What bob's side holds once alice's signed answer to its request arrived. */
export const answerFor = (alice: Side, pairingId: string, pairingKey: string, over: { key?: string; repository?: string; answeredKey?: string } = {}) => ({
  invite: { fingerprint: alice.key.fingerprint, repository: REPO },
  sentPairingKey: pairingKey,
  answer: { pairingId, pairingKey: over.answeredKey ?? pairingKey, repository: over.repository ?? REPO, peer: { key: over.key ?? alice.key.publicKey, name: "alice", address: "127.0.0.1:4790" } },
});

/** Alice invites, bob joins, both owners confirm, and alice's confirmation reaches bob: a pairing in force both ways. */
export function pair(alice: Side, bob: Side): string {
  const invite = createInvite(alice.db, REPO);
  const { request, hmac, bytes } = pairRequest(bob, invite.id, invite.secret);
  const accepted = acceptPairRequest(alice.db, alice.key, request, hmacCheck(bytes, hmac));
  assert.ok("pairing" in accepted);
  const id = accepted.pairing.id;
  const joined = joinPairing(bob.db, bob.key, answerFor(alice, id, request.pairingKey));
  assert.ok("pairing" in joined);
  assert.equal(pairingState(getPairing(bob.db, id)!), "waiting_for_peer");
  assert.equal(confirmByOwner(alice.db, id), true);
  const confirmation = writeOutgoing(alice.db, alice.key, { pairingId: id, kind: "pair_confirmation", contextId: null, parentId: null, body: "" });
  assert.ok("sent" in confirmation);
  const got = receiveEnvelope(bob.db, bob.key, confirmation.sent);
  assert.equal(got.outcome, "stored");
  assert.equal(receiveEnvelope(alice.db, alice.key, (got as { acknowledgement: SignedEnvelope }).acknowledgement).outcome, "stored");
  assert.equal(pairingState(getPairing(bob.db, id)!), "in_force");
  return id;
}

export const send = (from: Side, m: Outgoing, o = {}): SignedEnvelope => {
  const out = writeOutgoing(from.db, from.key, m, o);
  if (!("sent" in out)) assert.fail(`not sent: ${out.refused}: ${out.problem}`);
  return out.sent;
};
export const ask = (from: Side, pairingId: string, contextId = newId(), parentId: string | null = null, body = "Which field names does the login answer use?"): SignedEnvelope => send(from, { pairingId, kind: "question", contextId, parentId, body });
export const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => Number(db.prepare(sql).get(...args)?.n);

