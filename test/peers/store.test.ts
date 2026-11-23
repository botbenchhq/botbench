import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { DB_FILE, openStore } from "../../src/store/db.ts";
import { envelopeBytes as envelopeBytesOf, newId, settingsNoticeBody, signEnvelope, type Envelope, type SignedEnvelope } from "../../src/peers/envelope.ts";
import { workbenchKey, type WorkbenchKey } from "../../src/peers/key.ts";
import { receiveEnvelope, writeOutgoing, type Outgoing } from "../../src/peers/messages.ts";
import {
  acceptPairRequest,
  closeExpiredInvites,
  confirmByOwner,
  createInvite,
  endPairing,
  getPairing,
  INVITE_LIFE_MS,
  joinPairing,
  kindSetting,
  newPairingKey,
  pairingState,
  requestDigest,
  setKindByOwner,
  withdrawInvite,
  type PairRequest,
} from "../../src/peers/pairings.ts";
import { decideDraftCard, decideIncomingCard, seeCard, showDraftCard, showIncomingCard, threadFriction } from "../../src/peers/cards.ts";
import { answerFor, ask, count, hmacCheck, pair, pairRequest, REPO, send, side, type Side } from "../support/peer-store.ts";

test("an invite is used once: a retried pair request gets the same pairing, another request on it is refused, and its secret is erased", (t) => {
  const alice = side(t);
  const bob = side(t);
  const invite = createInvite(alice.db, REPO);
  const files = (): Buffer[] => fs.readdirSync(alice.home).filter((n) => n.startsWith(DB_FILE)).map((n) => fs.readFileSync(path.join(alice.home, n)));
  assert.ok(files().some((bytes) => bytes.includes(invite.secret)), "while open, the secret is in the store, where the search below looks");
  const { request, hmac, bytes } = pairRequest(bob, invite.id, invite.secret);
  // A wrong HMAC makes nothing and leaves the invite open.
  const wrong = pairRequest(bob, invite.id, Buffer.alloc(32, 1));
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, wrong.request, hmacCheck(wrong.bytes, wrong.hmac)), { refused: "wrong_secret" });
  assert.equal(count(alice.db, "SELECT count(*) AS n FROM peer_pairings"), 0);

  const first = acceptPairRequest(alice.db, alice.key, request, hmacCheck(bytes, hmac));
  assert.ok("pairing" in first && !first.retried);
  assert.equal(first.pairing.peerFingerprint, bob.key.fingerprint);
  assert.equal(pairingState(first.pairing), "waiting_for_owner");
  // The same request twice more: the same pairing, though the secret that checked it is gone.
  for (let i = 0; i < 2; i++) {
    const again = acceptPairRequest(alice.db, alice.key, request, () => assert.fail("the secret is not read again"));
    assert.ok("pairing" in again && again.retried);
    assert.equal(again.pairing.id, first.pairing.id);
  }
  assert.equal(count(alice.db, "SELECT count(*) AS n FROM peer_pairings"), 1);
  // Another pairing key, or the same key with other content, on the used invite.
  const other = pairRequest(bob, invite.id, invite.secret);
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, other.request, hmacCheck(other.bytes, other.hmac)), { refused: "invite_used" });
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, { ...request, requestDigest: "0".repeat(64) }, () => true), { refused: "invite_used" });

  const row = alice.db.prepare("SELECT state, secret, closed_at FROM peer_invites WHERE id = ?").get(invite.id)!;
  assert.equal(row.state, "used");
  assert.equal(row.secret, null);
  // Not in the database file, its free pages or its write-ahead log either.
  for (const file of files()) assert.equal(file.includes(invite.secret), false, "no file of the store holds a copy of the secret");
});

test("an invite lives 15 minutes, a withdrawn or expired one is refused, and neither keeps its secret", (t) => {
  const alice = side(t);
  const bob = side(t);
  const at = new Date("2026-11-23T10:00:00.000Z");
  const late = createInvite(alice.db, REPO, at);
  const { request, hmac, bytes } = pairRequest(bob, late.id, late.secret);
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, request, hmacCheck(bytes, hmac), new Date(at.getTime() + INVITE_LIFE_MS)), { refused: "invite_expired" });
  const withdrawn = createInvite(alice.db, REPO, at);
  assert.equal(withdrawInvite(alice.db, withdrawn.id, at), true);
  assert.equal(withdrawInvite(alice.db, withdrawn.id, at), false);
  const w = pairRequest(bob, withdrawn.id, withdrawn.secret);
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, w.request, hmacCheck(w.bytes, w.hmac), at), { refused: "invite_withdrawn" });
  const swept = createInvite(alice.db, REPO, at);
  closeExpiredInvites(alice.db, new Date(at.getTime() + INVITE_LIFE_MS - 1));
  assert.equal(alice.db.prepare("SELECT state FROM peer_invites WHERE id = ?").get(swept.id)!.state, "open");
  closeExpiredInvites(alice.db, new Date(at.getTime() + INVITE_LIFE_MS));
  assert.equal(count(alice.db, "SELECT count(*) AS n FROM peer_invites WHERE secret IS NOT NULL"), 0);
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, { ...request, inviteId: newId() }, () => true), { refused: "invite_unknown" });
  // The table holds the rule too: a closed invite never opens again, and no open one is without its secret.
  assert.throws(() => alice.db.prepare("UPDATE peer_invites SET state = 'open', closed_at = NULL, secret = randomblob(32) WHERE id = ?").run(swept.id), /never opens again/);
  assert.throws(() => alice.db.prepare("INSERT INTO peer_invites (id, secret, repository, created_at, expires_at, state) VALUES (?, NULL, ?, ?, ?, 'open')").run(newId(), REPO, at.toISOString(), at.toISOString()), /CHECK constraint/);
  assert.throws(() => alice.db.prepare("UPDATE peer_invites SET expires_at = '2099-01-01T00:00:00.000Z'").run(), /kept as it was made/);
  assert.throws(() => alice.db.prepare("DELETE FROM peer_invites").run(), /never deleted/);
});

test("the joining side accepts an answer only from the key the invite named, and both owners must confirm before anything moves", (t) => {
  const alice = side(t);
  const bob = side(t);
  const mallory = side(t);
  const sentKey = newPairingKey();
  assert.deepEqual(joinPairing(bob.db, bob.key, answerFor(alice, newId(), sentKey, { key: mallory.key.publicKey })), { refused: "wrong_key" });
  // An answer for another repository than the invite showed, or to another request than bob's.
  assert.deepEqual(joinPairing(bob.db, bob.key, answerFor(alice, newId(), sentKey, { repository: "github.com/jon-lange/other" })), { refused: "wrong_request" });
  assert.deepEqual(joinPairing(bob.db, bob.key, answerFor(alice, newId(), sentKey, { answeredKey: newPairingKey() })), { refused: "wrong_request" });
  assert.equal(count(bob.db, "SELECT count(*) AS n FROM peer_pairings"), 0);

  const invite = createInvite(alice.db, REPO);
  const { request, hmac, bytes } = pairRequest(bob, invite.id, invite.secret);
  const accepted = acceptPairRequest(alice.db, alice.key, request, hmacCheck(bytes, hmac));
  assert.ok("pairing" in accepted);
  const id = accepted.pairing.id;
  joinPairing(bob.db, bob.key, answerFor(alice, id, request.pairingKey));
  // Before alice's owner confirms, neither side sends or takes a question.
  assert.equal((writeOutgoing(alice.db, alice.key, { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "hi" }) as { refused: string }).refused, "not_confirmed");
  assert.equal((writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "hi" }) as { refused: string }).refused, "not_confirmed");
  // A question bob's side would refuse, signed by alice, before alice's confirmation reached it.
  const early = signEnvelope({ pairingId: id, kind: "question", messageId: newId(), contextId: newId(), parentId: null, repository: REPO, senderKey: alice.key.publicKey, recipientKey: bob.key.publicKey, sequence: 1, time: new Date().toISOString(), body: "hi" }, alice.key);
  const refused = receiveEnvelope(bob.db, bob.key, early);
  assert.ok(refused.outcome === "refused" && refused.reason === "not_confirmed");
  assert.equal(count(bob.db, "SELECT count(*) AS n FROM peer_messages WHERE direction = 'in'"), 0);
  // A pair confirmation signed with another key changes nothing.
  confirmByOwner(alice.db, id);
  const forged = signEnvelope({ pairingId: id, kind: "pair_confirmation", messageId: newId(), contextId: null, parentId: null, repository: REPO, senderKey: mallory.key.publicKey, recipientKey: bob.key.publicKey, sequence: 1, time: new Date().toISOString(), body: "" }, mallory.key);
  assert.ok(receiveEnvelope(bob.db, bob.key, forged).outcome === "refused");
  assert.equal(pairingState(getPairing(bob.db, id)!), "waiting_for_peer");
  // A second pairing is refused while one is in force: one pairing per installation in the first slice.
  const second = createInvite(alice.db, REPO);
  const s = pairRequest(side(t), second.id, second.secret);
  assert.deepEqual(acceptPairRequest(alice.db, alice.key, s.request, hmacCheck(s.bytes, s.hmac)), { refused: "already_paired" });
});

test("a question is stored once: the same bytes get the same acknowledgement, other bytes under its id are refused and logged", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const q = ask(alice, id);
  const first = receiveEnvelope(bob.db, bob.key, q);
  assert.equal(first.outcome, "stored");
  for (let i = 0; i < 3; i++) {
    const again = receiveEnvelope(bob.db, bob.key, q);
    assert.equal(again.outcome, "replayed");
    assert.deepEqual((again as { acknowledgement: unknown }).acknowledgement, (first as { acknowledgement: unknown }).acknowledgement);
  }
  assert.equal(count(bob.db, "SELECT count(*) AS n FROM peer_messages WHERE direction = 'in' AND kind = 'question'"), 1);
  // Same id, other text, properly signed by alice: refused, kept as it first came, and in the action log as the peer's.
  const changed = signEnvelope({ ...q.envelope, body: "Something else entirely." }, alice.key);
  const conflict = receiveEnvelope(bob.db, bob.key, changed);
  assert.ok(conflict.outcome === "refused" && conflict.reason === "message_conflict");
  assert.equal(conflict.refusal?.envelope.body, "message_conflict");
  assert.equal(bob.db.prepare("SELECT body FROM peer_messages WHERE message_id = ?").get(q.envelope.messageId)!.body, q.envelope.body);
  const log = bob.db.prepare("SELECT * FROM action_log WHERE rule = 'peer_message_conflict'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.asked_by, "peer");
  assert.equal(log[0]!.asked_by_pairing_id, id);
  assert.equal(log[0]!.asked_by_peer_name, "alice");
  assert.equal(log[0]!.asked_by_peer_fingerprint, alice.key.fingerprint);
  // One flipped byte of the body, with the old signature: not alice's, nothing stored, no signed answer.
  const flipped = receiveEnvelope(bob.db, bob.key, { envelope: { ...q.envelope, messageId: newId(), body: q.envelope.body.replace("W", "w") }, signature: q.signature });
  assert.ok(flipped.outcome === "refused" && flipped.reason === "bad_signature" && flipped.refusal === null);
  // A new id with a sequence number already used.
  const reused = signEnvelope({ ...q.envelope, messageId: newId(), contextId: newId() }, alice.key);
  const r = receiveEnvelope(bob.db, bob.key, reused);
  assert.ok(r.outcome === "refused" && r.reason === "sequence_reused");
  // The acknowledgement reaches alice once; a replayed one, or one for a message alice never sent, changes nothing.
  const ack = (first as { acknowledgement: SignedEnvelope }).acknowledgement;
  assert.equal(receiveEnvelope(alice.db, alice.key, ack).outcome, "stored");
  assert.equal(receiveEnvelope(alice.db, alice.key, ack).outcome, "replayed");
  const second = signEnvelope({ ...ack.envelope, messageId: newId() }, bob.key);
  assert.ok((receiveEnvelope(alice.db, alice.key, second) as { reason: string }).reason === "wrong_parent");
  const invented = signEnvelope({ ...ack.envelope, messageId: newId(), parentId: newId() }, bob.key);
  assert.ok((receiveEnvelope(alice.db, alice.key, invented) as { reason: string }).reason === "wrong_parent");
});

test("peer messages, pairing ends and kind settings are append-only, and a message id appears once per pairing", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  receiveEnvelope(bob.db, bob.key, ask(alice, id));
  for (const table of ["peer_messages", "peer_kind_settings"]) {
    assert.throws(() => bob.db.exec(`UPDATE ${table} SET pairing_id = pairing_id`), /append-only/, table);
    assert.throws(() => bob.db.exec(`DELETE FROM ${table}`), /append-only/, table);
  }
  const row = bob.db.prepare("SELECT * FROM peer_messages WHERE direction = 'in' AND kind = 'question'").get()!;
  // INSERT OR REPLACE would delete the old row first; the delete trigger refuses that too.
  const columns = Object.keys(row).filter((c) => c !== "id");
  assert.throws(() => bob.db.prepare(`INSERT OR REPLACE INTO peer_messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => (c === "body" ? "rewritten" : (row[c] as string | number)))), /append-only/);
  assert.throws(() => bob.db.prepare(`INSERT INTO peer_messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => (c === "sequence" ? 99 : (row[c] as string | number)))), /UNIQUE constraint failed: peer_messages.pairing_id, peer_messages.message_id/);
  endPairing(bob.db, bob.key, id, "owner_ended");
  assert.throws(() => bob.db.exec("UPDATE peer_pairing_ends SET how = 'end_notice'"), /append-only/);
  assert.throws(() => bob.db.exec("DELETE FROM peer_pairing_ends"), /append-only/);
  assert.throws(() => bob.db.exec("DELETE FROM peer_pairings"), /never deleted/);
  assert.throws(() => bob.db.exec("UPDATE peer_pairings SET peer_key = own_key"), /kept as it was made/);
});

test("an ended pairing refuses everything that names it, on both sides, and is never started again", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const q = ask(alice, id);
  // The question is a card for bob's owner as it is stored (decision 8).
  const got = receiveEnvelope(bob.db, bob.key, q);
  // Alice's owner asks a second question while bob's notice of the end is lost.
  const pending = ask(alice, id);
  const ended = endPairing(bob.db, bob.key, id, "owner_ended");
  assert.ok(ended?.notice);
  assert.equal(ended.notice.envelope.kind, "end_notice");
  assert.equal(endPairing(bob.db, bob.key, id, "owner_ended"), null, "ending twice changes nothing");
  assert.equal(pairingState(getPairing(bob.db, id)!), "ended");
  // Its waiting card was closed, by nobody.
  assert.equal(threadFriction(bob.db, id, q.envelope.contextId!).cards[0]!.decision, "closed_by_end");
  assert.equal(threadFriction(bob.db, id, q.envelope.contextId!).cardsAnswered, 0);
  // Nothing more is written for it, by any path.
  assert.equal((writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "answer", contextId: q.envelope.contextId, parentId: q.envelope.messageId, body: "x" }) as { refused: string }).refused, "pairing_ended");
  assert.throws(() => bob.db.prepare("INSERT INTO peer_messages SELECT NULL, pairing_id, direction, kind, ?, context_id, parent_id, repository, sender_key, recipient_key, sequence + 100, sent_at, body, digest, signature, stored_at FROM peer_messages WHERE kind = 'question'").run(newId()), /has ended/);
  assert.throws(() => bob.db.prepare("UPDATE peer_pairings SET owner_confirmed_at = NULL WHERE id = ?").run(id), /never changes/);
  assert.equal(confirmByOwner(bob.db, id), false);
  // Alice's next message gets a signed pairing_ended refusal; once alice holds it, alice has ended the pairing too.
  const refused = receiveEnvelope(bob.db, bob.key, pending);
  assert.ok(refused.outcome === "refused" && refused.reason === "pairing_ended" && refused.refusal !== null);
  // The same refusal signed by another key changes nothing on alice's side.
  const mallory = side(t);
  const forged = { envelope: { ...refused.refusal.envelope, senderKey: mallory.key.publicKey }, signature: "" };
  forged.signature = mallory.key.sign(Buffer.from("x")).toString("base64url");
  assert.equal(receiveEnvelope(alice.db, alice.key, forged).outcome, "refused");
  assert.equal(pairingState(getPairing(alice.db, id)!), "in_force");
  assert.equal(receiveEnvelope(alice.db, alice.key, refused.refusal).outcome, "stored");
  assert.equal(pairingState(getPairing(alice.db, id)!), "ended");
  assert.equal(alice.db.prepare("SELECT how FROM peer_pairing_ends WHERE pairing_id = ?").get(id)!.how, "pairing_ended_refusal");
  assert.equal(receiveEnvelope(alice.db, alice.key, got.outcome === "stored" ? got.acknowledgement! : assert.fail()).outcome, "refused", "even an acknowledgement for the ended pairing");
  // A new invite pairs the same two keys again, under a new id; the old id stays refused.
  const again = pair(alice, bob);
  assert.notEqual(again, id);
  assert.equal(pairingState(getPairing(bob.db, again)!), "in_force");
  assert.ok((receiveEnvelope(bob.db, bob.key, ask(alice, again)) as { outcome: string }).outcome === "stored");
  const old = signEnvelope({ ...pending.envelope, messageId: newId(), sequence: 50 }, alice.key);
  assert.ok((receiveEnvelope(bob.db, bob.key, old) as { reason: string }).reason === "pairing_ended");
});

test("the end notice ends the pairing on the other side, and is accepted only from the paired key", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const { notice } = endPairing(alice.db, alice.key, id, "owner_ended")!;
  // Signed by another key: under that key's name, or under alice's.
  const mallory = side(t);
  const theirs = signEnvelope({ ...notice!.envelope, messageId: newId(), senderKey: mallory.key.publicKey }, mallory.key);
  assert.equal((receiveEnvelope(bob.db, bob.key, theirs) as { reason: string }).reason, "bad_signature");
  const asAlice = { envelope: { ...notice!.envelope, messageId: newId() }, signature: mallory.key.sign(envelopeBytesOf({ ...notice!.envelope })).toString("base64url") };
  assert.equal((receiveEnvelope(bob.db, bob.key, asAlice) as { reason: string }).reason, "bad_signature");
  assert.equal(pairingState(getPairing(bob.db, id)!), "in_force");
  const got = receiveEnvelope(bob.db, bob.key, notice!);
  assert.ok(got.outcome === "stored" && got.acknowledgement === null);
  assert.equal(pairingState(getPairing(bob.db, id)!), "ended");
  assert.equal(bob.db.prepare("SELECT ended_by, how FROM peer_pairing_ends").get()!.how, "end_notice");
});

test("a message for another repository, an answer to no question and an over-long one are refused, with a reason, storing nothing", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const thread = newId();
  const q = ask(alice, id, thread);
  receiveEnvelope(bob.db, bob.key, q);
  const base = (over: Partial<Envelope>): SignedEnvelope => signEnvelope({ ...q.envelope, messageId: newId(), sequence: 40 + Math.floor(Math.random() * 1000), ...over }, alice.key);
  const reason = (s: SignedEnvelope): string => (receiveEnvelope(bob.db, bob.key, s) as { reason: string }).reason;
  const before = count(bob.db, "SELECT count(*) AS n FROM peer_messages");
  assert.equal(reason(base({ repository: "github.com/jon-lange/other" })), "wrong_repository");
  // An answer whose parent is alice's own question, one whose parent is in another thread, one with no stored parent.
  assert.equal(reason(base({ kind: "answer", parentId: q.envelope.messageId })), "wrong_parent");
  assert.equal(reason(base({ kind: "answer", parentId: newId() })), "wrong_parent");
  // A question with no parent in a thread that is open.
  assert.equal(reason(base({ parentId: null })), "wrong_parent");
  // Over-long: alice's own side would not sign it, so a modified sender's signer is used.
  const long = { ...q.envelope, messageId: newId(), contextId: newId(), sequence: 77, body: "x".repeat(8001) };
  const longSigned = { envelope: long, signature: alice.key.sign(envelopeBytesOf(long)).toString("base64url") };
  const longResult = receiveEnvelope(bob.db, bob.key, longSigned);
  assert.ok(longResult.outcome === "refused" && longResult.reason === "wrong_shape");
  assert.match(longResult.problem, /at most 8,000 characters/);
  assert.equal(count(bob.db, "SELECT count(*) AS n FROM peer_messages"), before);
  // The sending end refuses the same, before anything is stored.
  const out = writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "answer", contextId: thread, parentId: newId(), body: "x" });
  assert.equal((out as { refused: string }).refused, "wrong_parent");
  assert.equal((writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "answer", contextId: thread, parentId: q.envelope.messageId, body: "x".repeat(8001) }) as { refused: string }).refused, "wrong_shape");
  assert.ok("sent" in writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "answer", contextId: thread, parentId: q.envelope.messageId, body: "id, name, expiresAt" }));
});
test("a thread holds 3 round trips, counted at both ends, and the cap can be set from 1 to 10", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const thread = newId();
  let parent: string | null = null;
  for (let round = 0; round < 3; round++) {
    const q = ask(alice, id, thread, parent);
    assert.equal(receiveEnvelope(bob.db, bob.key, q).outcome, "stored");
    const a = send(bob, { pairingId: id, kind: "answer", contextId: thread, parentId: q.envelope.messageId, body: `answer ${round}` });
    assert.equal(receiveEnvelope(alice.db, alice.key, a).outcome, "stored");
    parent = a.envelope.messageId;
  }
  // The seventh: alice's own side refuses it, and bob refuses one from a sender that skips its own check.
  assert.equal((writeOutgoing(alice.db, alice.key, { pairingId: id, kind: "question", contextId: thread, parentId: parent, body: "one more?" }) as { refused: string }).refused, "thread_full");
  const seventh = signEnvelope({ pairingId: id, kind: "question", messageId: newId(), contextId: thread, parentId: parent, repository: REPO, senderKey: alice.key.publicKey, recipientKey: bob.key.publicKey, sequence: 90, time: new Date().toISOString(), body: "one more?" }, alice.key);
  assert.equal((receiveEnvelope(bob.db, bob.key, seventh) as { reason: string }).reason, "thread_full");
  // With a cap of 4 the same message is taken; a cap outside 1 to 10 is refused outright.
  assert.equal(receiveEnvelope(bob.db, bob.key, seventh, { roundTrips: 4 }).outcome, "stored");
  assert.throws(() => receiveEnvelope(bob.db, bob.key, seventh, { roundTrips: 11 }), /from 1 to 10/);
  assert.throws(() => writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "x" }, { roundTrips: 0 }), /from 1 to 10/);
  // Three questions in a row from one side fill its half of a thread with a cap of 3.
  const other = newId();
  let last: string | null = null;
  for (let i = 0; i < 3; i++) last = ask(alice, id, other, last).envelope.messageId;
  assert.equal((writeOutgoing(alice.db, alice.key, { pairingId: id, kind: "question", contextId: other, parentId: last, body: "and?" }) as { refused: string }).refused, "thread_full");
});

test("a peer may send 30 messages an hour and have 10 cards waiting; past that a message is refused", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  // Well after the pairing's own messages, so only these count in the hour.
  const at = new Date(Date.now() + 7 * 24 * 3600_000);
  const asked: SignedEnvelope[] = [];
  for (let i = 0; i < 10; i++) {
    const q = ask(alice, id);
    assert.equal(receiveEnvelope(bob.db, bob.key, q, { at }).outcome, "stored");
    asked.push(q);
  }
  const eleventh = ask(alice, id);
  assert.equal((receiveEnvelope(bob.db, bob.key, eleventh, { at }) as { reason: string }).reason, "too_many_cards");
  // Once the owner dismisses one, the next is taken.
  decideIncomingCard(bob.db, id, asked[0]!.envelope.messageId, "dismissed", at);
  assert.equal(receiveEnvelope(bob.db, bob.key, eleventh, { at }).outcome, "stored");
  // 30 in the hour, cards or not: the 31st is refused, and taken an hour later.
  const dismissAll = () => {
    for (const row of bob.db.prepare("SELECT message_id FROM peer_cards WHERE decided_at IS NULL").all()) decideIncomingCard(bob.db, id, String(row.message_id), "dismissed", at);
  };
  for (let i = 0; i < 19; i++) {
    // Each stored question is a card, so the owner keeps the waiting ones under ten.
    if (i % 9 === 0) dismissAll();
    assert.equal(receiveEnvelope(bob.db, bob.key, ask(alice, id), { at }).outcome, "stored");
  }
  dismissAll();
  const thirtyFirst = ask(alice, id);
  assert.equal((receiveEnvelope(bob.db, bob.key, thirtyFirst, { at: new Date(at.getTime() + 60_000) }) as { reason: string }).reason, "too_many_messages");
  assert.equal(receiveEnvelope(bob.db, bob.key, thirtyFirst, { at: new Date(at.getTime() + 3600_000) }).outcome, "stored");
});

test("each kind can be switched off per peer for sending and receiving; the receiving end's no decides and stores no body", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  for (const db of [alice.db, bob.db]) for (const direction of ["send", "receive"] as const) for (const kind of ["question", "answer"] as const) assert.equal(kindSetting(db, id, "own", direction, kind), true, "all on at pairing");
  setKindByOwner(bob.db, id, "receive", "question", false);
  // Alice has not heard yet, so her side sends it; bob's side refuses it and keeps nothing of it.
  const q = ask(alice, id, newId(), null, "a secret plan");
  const refused = receiveEnvelope(bob.db, bob.key, q);
  assert.ok(refused.outcome === "refused" && refused.reason === "kind_switched_off" && refused.refusal?.envelope.body === "kind_switched_off");
  assert.equal(count(bob.db, "SELECT count(*) AS n FROM peer_messages WHERE body LIKE '%secret plan%'"), 0);
  // Bob's settings notice reaches alice; from then her side refuses to send a question.
  const notice = send(bob, { pairingId: id, kind: "settings_notice", contextId: null, parentId: null, body: settingsNoticeBody({ question: false, answer: true }) });
  assert.equal(receiveEnvelope(alice.db, alice.key, notice).outcome, "stored");
  assert.equal((writeOutgoing(alice.db, alice.key, { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "x" }) as { refused: string }).refused, "kind_switched_off");
  // Alice's own send setting is checked too.
  setKindByOwner(bob.db, id, "send", "question", false);
  assert.equal((writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "x" }) as { refused: string }).refused, "kind_switched_off");
  setKindByOwner(bob.db, id, "send", "question", true);
  assert.ok("sent" in writeOutgoing(bob.db, bob.key, { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "x" }));
  // Only the owner switches its own side; a notice only ever records the peer's receive settings.
  assert.throws(() => bob.db.prepare("INSERT INTO peer_kind_settings (pairing_id, side, direction, kind, allowed, set_by, set_at) VALUES (?, 'own', 'receive', 'question', 1, 'peer_notice', ?)").run(id, new Date().toISOString()), /CHECK constraint/);
  assert.equal(kindSetting(bob.db, id, "own", "receive", "question"), false);
});

test("the friction record answers, per thread, cards a person answered, how long each waited, and whether a draft went as drafted", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const thread = newId();
  const t0 = Date.parse("2026-11-23T10:00:00.000Z");
  // Alice's agent drafts a question; the owner sends it unchanged after 90 seconds.
  const draft = "Which field names does the login answer use?";
  const messageId = newId();
  showDraftCard(alice.db, { pairingId: id, messageId, contextId: thread, kind: "question", draft, draftedAt: new Date(t0) }, new Date(t0 + 1000));
  const q = send(alice, { pairingId: id, kind: "question", contextId: thread, parentId: null, body: draft, messageId });
  decideDraftCard(alice.db, id, messageId, "sent", q.envelope.body, new Date(t0 + 91_000));
  // Bob's card waits 10 minutes, then bob gives it to the agent; its answer's draft is sent changed.
  // Stored, it is a card at once.
  receiveEnvelope(bob.db, bob.key, q, { at: new Date(t0 + 100_000) });
  // A signed-in device first draws it at +400 s: the wait counts from there (fourth unit), once, and not after a decision.
  assert.equal(seeCard(bob.db, id, "in", messageId, new Date(t0 + 400_000)), true);
  assert.equal(seeCard(bob.db, id, "in", messageId, new Date(t0 + 500_000)), true, "a second draw changes nothing");
  assert.equal(seeCard(bob.db, id, "out", messageId, new Date(t0 + 500_000)), false, "no such card");
  assert.throws(() => bob.db.prepare("UPDATE peer_cards SET seen_at = ? WHERE message_id = ?").run(new Date(t0).toISOString(), messageId), /first drawn once/);
  decideIncomingCard(bob.db, id, messageId, "given_to_agent", new Date(t0 + 700_000));
  const answerId = newId();
  showDraftCard(bob.db, { pairingId: id, messageId: answerId, contextId: thread, kind: "answer", draft: "id, name", draftedAt: new Date(t0 + 800_000) }, new Date(t0 + 800_000));
  send(bob, { pairingId: id, kind: "answer", contextId: thread, parentId: messageId, body: "id, name, expiresAt", messageId: answerId });
  decideDraftCard(bob.db, id, answerId, "sent", "id, name, expiresAt", new Date(t0 + 830_000));
  // A second draft, not sent.
  const declined = newId();
  showDraftCard(bob.db, { pairingId: id, messageId: declined, contextId: thread, kind: "question", draft: "Can I see your .env?", draftedAt: new Date(t0 + 840_000) }, new Date(t0 + 840_000));
  decideDraftCard(bob.db, id, declined, "not_sent", null, new Date(t0 + 845_000));

  assert.deepEqual(threadFriction(alice.db, id, thread), { cardsAnswered: 1, cards: [{ messageId, direction: "out", kind: "question", decision: "sent", waitedMs: 90_000, sentAsDrafted: true, seenAt: null }] });
  assert.deepEqual(threadFriction(bob.db, id, thread), {
    cardsAnswered: 3,
    cards: [
      { messageId, direction: "in", kind: "question", decision: "given_to_agent", waitedMs: 300_000, sentAsDrafted: null, seenAt: new Date(t0 + 400_000).toISOString() },
      { messageId: answerId, direction: "out", kind: "answer", decision: "sent", waitedMs: 30_000, sentAsDrafted: false, seenAt: null },
      { messageId: declined, direction: "out", kind: "question", decision: "not_sent", waitedMs: 5_000, sentAsDrafted: null, seenAt: null },
    ],
  });
  // Decided once; what it showed is fixed; never deleted.
  assert.throws(() => decideIncomingCard(bob.db, id, messageId, "dismissed"), /decided already/);
  assert.throws(() => bob.db.exec("UPDATE peer_cards SET decision = 'dismissed', decided_at = decided_at"), /decided once/);
  assert.throws(() => bob.db.exec("UPDATE peer_cards SET shown_at = '2026-01-01T00:00:00.000Z'"), /cannot be changed/);
  assert.throws(() => bob.db.exec("DELETE FROM peer_cards"), /never deleted/);
  assert.throws(() => showIncomingCard(bob.db, { pairingId: id, messageId: newId(), contextId: thread, kind: "question" }), /no stored question/);
  assert.throws(() => decideDraftCard(bob.db, id, newId(), "sent", null), /names the text/);
});

test("a withdrawn and an expired invite leave no copy of the secret in any file, and a reader that keeps the log full stops the erase loudly", (t) => {
  const alice = side(t);
  const files = (): Buffer[] => fs.readdirSync(alice.home).filter((n) => n.startsWith(DB_FILE)).map((n) => fs.readFileSync(path.join(alice.home, n)));
  const at = new Date("2026-11-23T10:00:00.000Z");
  const withdrawn = createInvite(alice.db, REPO, at);
  const expired = createInvite(alice.db, REPO, at);
  assert.ok(files().some((b) => b.includes(withdrawn.secret)) && files().some((b) => b.includes(expired.secret)));
  withdrawInvite(alice.db, withdrawn.id, at);
  closeExpiredInvites(alice.db, new Date(at.getTime() + INVITE_LIFE_MS));
  for (const file of files()) {
    assert.equal(file.includes(withdrawn.secret), false);
    assert.equal(file.includes(expired.secret), false);
  }
  // A second connection in the middle of a read keeps the log from being emptied: the erase says so rather than pass.
  const reader = openStore(alice.home);
  t.after(() => reader.close());
  const open = createInvite(alice.db, REPO);
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM peer_invites").get();
  assert.throws(() => withdrawInvite(alice.db, open.id), /could not empty the database's write-ahead log/);
  reader.exec("COMMIT");
  // Inside a caller's own write it refuses at once, as it could not empty the log after.
  alice.db.exec("BEGIN");
  assert.throws(() => withdrawInvite(alice.db, open.id), /must not run inside another write/);
  alice.db.exec("ROLLBACK");
});

test("a send retry sends the same signed bytes again, after the settings are checked again", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const m: Outgoing = { pairingId: id, kind: "question", contextId: newId(), parentId: null, body: "Which port?", messageId: newId() };
  const first = send(alice, m);
  const retry = send(alice, m);
  assert.deepEqual(retry, first);
  assert.equal(count(alice.db, "SELECT count(*) AS n FROM peer_messages WHERE message_id = ?", m.messageId!), 1);
  assert.throws(() => writeOutgoing(alice.db, alice.key, { ...m, body: "Which host?" }), /written already with other content/);
  setKindByOwner(alice.db, id, "send", "question", false);
  assert.equal((writeOutgoing(alice.db, alice.key, m) as { refused: string }).refused, "kind_switched_off");
});

test("settings notices apply in their own order, a replayed one adds nothing, and an ended pairing's settings and cards no longer change", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const older = send(bob, { pairingId: id, kind: "settings_notice", contextId: null, parentId: null, body: settingsNoticeBody({ question: true, answer: true }) });
  const newer = send(bob, { pairingId: id, kind: "settings_notice", contextId: null, parentId: null, body: settingsNoticeBody({ question: false, answer: true }) });
  assert.equal(receiveEnvelope(alice.db, alice.key, newer).outcome, "stored");
  assert.equal(receiveEnvelope(alice.db, alice.key, older).outcome, "stored");
  assert.equal(kindSetting(alice.db, id, "peer", "receive", "question"), false, "the older notice, arriving late, changed nothing");
  const rows = count(alice.db, "SELECT count(*) AS n FROM peer_kind_settings");
  assert.equal(receiveEnvelope(alice.db, alice.key, newer).outcome, "replayed");
  assert.equal(count(alice.db, "SELECT count(*) AS n FROM peer_kind_settings"), rows);
  // A draft card for a kind the peer does not take is not raised.
  assert.throws(() => showDraftCard(alice.db, { pairingId: id, messageId: newId(), contextId: newId(), kind: "question", draft: "x", draftedAt: new Date() }), /switched off/);
  endPairing(alice.db, alice.key, id, "owner_ended");
  assert.throws(() => setKindByOwner(alice.db, id, "receive", "answer", false), /settings no longer change/);
  assert.throws(() => showDraftCard(alice.db, { pairingId: id, messageId: newId(), contextId: newId(), kind: "answer", draft: "x", draftedAt: new Date() }), /not in force/);
  assert.throws(() => alice.db.prepare("INSERT INTO peer_cards (pairing_id, direction, message_id, context_id, kind, shown_at) VALUES (?, 'in', ?, ?, 'question', ?)").run(id, newId(), newId(), new Date().toISOString()), /no card is raised/);
});

test("a lone surrogate in any field is refused before its bytes are made, and conflicts are logged at most once a minute with their evidence", (t) => {
  const alice = side(t);
  const bob = side(t);
  const id = pair(alice, bob);
  const q = ask(alice, id);
  const lone = { ...q.envelope, body: "a\ud800b" };
  const r = receiveEnvelope(bob.db, bob.key, { envelope: lone, signature: q.signature });
  assert.ok(r.outcome === "refused" && r.reason === "unreadable");
  assert.throws(() => envelopeBytesOf(lone), /not well-formed/);
  assert.equal(receiveEnvelope(bob.db, bob.key, q).outcome, "stored");
  const at = new Date();
  for (let i = 0; i < 5; i++) {
    const changed = signEnvelope({ ...q.envelope, body: `other ${i}` }, alice.key);
    assert.equal((receiveEnvelope(bob.db, bob.key, changed, { at }) as { reason: string }).reason, "message_conflict");
  }
  const log = bob.db.prepare("SELECT detail FROM action_log WHERE rule = 'peer_message_conflict'").all();
  assert.equal(log.length, 1);
  assert.match(String(log[0]!.detail), /digest [0-9a-f]{64}, signature [A-Za-z0-9_-]{86}/);
  const later = signEnvelope({ ...q.envelope, body: "later" }, alice.key);
  receiveEnvelope(bob.db, bob.key, later, { at: new Date(at.getTime() + 61_000) });
  assert.equal(count(bob.db, "SELECT count(*) AS n FROM action_log WHERE rule = 'peer_message_conflict'"), 2);
  // Only ever the peer's, and about no task or run.
  assert.throws(() => bob.db.prepare("INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES (?, 'peer_message_conflict', 'peer', '', '')").run(at.toISOString()), /CHECK constraint/);
  bob.db.exec("PRAGMA foreign_keys = OFF");
  assert.throws(() => bob.db.prepare("INSERT INTO action_log (ts, task_id, rule, tool, command, cwd, asked_by, asked_by_pairing_id, asked_by_peer_name, asked_by_peer_fingerprint) VALUES (?, 1, 'peer_message_conflict', 'peer', '', '', 'peer', ?, 'alice', 'f')").run(at.toISOString(), id), /CHECK constraint/);
  bob.db.exec("PRAGMA foreign_keys = ON");
});
