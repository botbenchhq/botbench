import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../store/db.ts";
import { WORKBENCH_RULE, isWorkbench } from "../workbench.ts";
import { MESSAGE_KINDS, envelopeDigest, isId, newId, repositoryProblem, signEnvelope, type MessageKind, type SignedEnvelope } from "./envelope.ts";
import { fingerprintOf, publicKeyProblem, type WorkbenchKey } from "./key.ts";
import { logPeer } from "./log.ts";

/*
 * Pairings in the store (Peers P5, ADR 0004 decisions 3, 4 and 11). No network: what the peer listener will call, kept
 * here so every rule is a store rule with a test against real SQLite.
 *
 * Invites. An invite holds a 32-byte one-time secret, kept only while the invite is open, for 15 minutes, used once.
 * Using it, its expiry and withdrawing it each erase the secret in the same write that closes it, and SQLite is told
 * to overwrite what it frees (`secure_delete`), so the bytes do not stay in the database file's free pages.
 *
 * The pair request is safe to retry (Rakazo's device pairing, `packages/contracts/src/account/user-devices.ts`: a
 * random key the joining side chooses, kept with what it made). The inviter keeps the joiner's pairing key and the
 * digest of the request it accepted. The same key with the same request gets the same pairing again, though the secret
 * that checked it is gone, because the digest proves it is the request that was checked. Any other request on a used
 * invite is refused.
 *
 * A pairing is in force only when this side's owner confirmed the peer's fingerprint and this side holds the other
 * owner's confirmation, and it has no end row. An end row is append-only and final: nothing more is stored for that
 * pairing, nothing on it changes, and a new invite makes a new pairing with a new id.
 */

export const INVITE_LIFE_MS = 15 * 60 * 1000;
/** The first slice: one pairing per installation (decision 13). */
const MAX_PAIRINGS = 1;

export type InviteRefusal = "invite_unknown" | "invite_expired" | "invite_used" | "invite_withdrawn";
export type PairRefusal = InviteRefusal | "wrong_secret" | "already_paired" | "wrong_request";

export interface Pairing {
  id: string;
  role: "inviter" | "joiner";
  ownKey: string;
  peerKey: string;
  peerName: string;
  peerFingerprint: string;
  peerAddress: string;
  repository: string;
  createdAt: string;
  ownerConfirmedAt: string | null;
  peerConfirmedAt: string | null;
  endedAt: string | null;
}
export type PairingState = "waiting_for_owner" | "waiting_for_peer" | "in_force" | "ended";

const toPairing = (row: Record<string, unknown>): Pairing => ({
  id: String(row.id),
  role: row.role === "inviter" ? "inviter" : "joiner",
  ownKey: String(row.own_key),
  peerKey: String(row.peer_key),
  peerName: String(row.peer_name),
  peerFingerprint: String(row.peer_fingerprint),
  peerAddress: String(row.peer_address),
  repository: String(row.repository),
  createdAt: String(row.created_at),
  ownerConfirmedAt: row.owner_confirmed_at == null ? null : String(row.owner_confirmed_at),
  peerConfirmedAt: row.peer_confirmed_at == null ? null : String(row.peer_confirmed_at),
  endedAt: row.ended_at == null ? null : String(row.ended_at),
});

/** In a transaction of its own, or in the caller's when one is open. */
const atomically = <T>(db: DatabaseSync, fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));
const iso = (at: Date): string => at.toISOString();

/** A pairing by its id, with its end when it has one; null when this workbench has none by that id. */
export function getPairing(db: DatabaseSync, id: string): Pairing | null {
  const row = db.prepare("SELECT p.*, e.ended_at FROM peer_pairings p LEFT JOIN peer_pairing_ends e ON e.pairing_id = p.id WHERE p.id = ?").get(id);
  return row === undefined ? null : toPairing(row);
}

export function pairingState(p: Pairing): PairingState {
  if (p.endedAt !== null) return "ended";
  if (p.ownerConfirmedAt === null) return "waiting_for_owner";
  if (p.peerConfirmedAt === null) return "waiting_for_peer";
  return "in_force";
}

/**
 * Run `fn` with SQLite overwriting whatever it frees, so an erased secret leaves no copy in the database's free space.
 * Outside a transaction the write-ahead log is then folded into the database and emptied, so no earlier copy of the
 * page stays in it either; inside one, the caller does that once it commits (`foldLog`).
 */
function erasing<T>(db: DatabaseSync, fn: () => T): T {
  const before = Number(db.prepare("PRAGMA secure_delete").get()?.secure_delete ?? 0);
  db.exec("PRAGMA secure_delete = ON");
  try {
    return fn();
  } finally {
    db.exec(`PRAGMA secure_delete = ${before === 1 ? "ON" : "OFF"}`);
    foldLog(db);
  }
}
/**
 * Fold the write-ahead log into the database and empty it, when no transaction is open. Throws when another reader kept
 * it from finishing, as the erased secret may then still be in the log.
 */
const foldLog = (db: DatabaseSync): void => {
  if (db.isTransaction) return;
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (Number(row?.busy ?? 0) !== 0) throw new Error("Botbench erased an invite's secret but could not empty the database's write-ahead log, because another process is reading the database. The secret may still be in the database's -wal file until it is emptied: stop that process, then start Botbench again.");
};
/** The functions that erase a secret do it in a write of their own, so that they can empty the log after it. */
const ownWrite = (db: DatabaseSync, what: string): void => {
  if (db.isTransaction) throw new Error(`${what} erases an invite's secret and must not run inside another write: call it on its own.`);
};

/** Close every open invite whose 15 minutes have passed, erasing its secret, each with its row in the action log. The ids closed. */
export function closeExpiredInvites(db: DatabaseSync, at: Date = new Date()): string[] {
  return erasing(db, () =>
    atomically(db, () => {
      const closed = db.prepare("UPDATE peer_invites SET state = 'expired', secret = NULL, closed_at = ? WHERE state = 'open' AND expires_at <= ? RETURNING id, repository").all(iso(at), iso(at));
      for (const row of closed) logPeer(db, { rule: "peer_invite", command: "invite expired", detail: `The invite ${String(row.id)} to pair on ${String(row.repository)} expired unused; its secret is erased.`, at });
      return closed.map((row) => String(row.id));
    }),
  );
}

/**
 * Make an invite for `repository`. The secret is returned this once, to be put in the invite the owner passes on; it
 * is never shown again or logged.
 */
export function createInvite(db: DatabaseSync, repository: string, at: Date = new Date(), lifeMs: number = INVITE_LIFE_MS): { id: string; secret: Buffer; expiresAt: string } {
  const problem = repositoryProblem(repository);
  if (problem !== null) throw new Error(problem);
  closeExpiredInvites(db, at);
  const id = newId();
  const secret = randomBytes(32);
  if (!Number.isSafeInteger(lifeMs) || lifeMs < 1 || lifeMs > INVITE_LIFE_MS) throw new Error("An invite lives at most 15 minutes.");
  const expiresAt = iso(new Date(at.getTime() + lifeMs));
  db.prepare("INSERT INTO peer_invites (id, secret, repository, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, 'open')").run(id, secret, repository, iso(at), expiresAt);
  return { id, secret, expiresAt };
}

/** Withdraw an open invite, erasing its secret. False when it was no longer open. */
export function withdrawInvite(db: DatabaseSync, id: string, at: Date = new Date()): boolean {
  ownWrite(db, "Withdrawing an invite");
  return erasing(db, () => Number(db.prepare("UPDATE peer_invites SET state = 'withdrawn', secret = NULL, closed_at = ? WHERE id = ? AND state = 'open'").run(iso(at), id).changes) === 1);
}

const inviteRefusal = (state: unknown): InviteRefusal => (state === "used" ? "invite_used" : state === "withdrawn" ? "invite_withdrawn" : "invite_expired");

/** The open invite `id` with its secret and repository, or why it cannot be used. An expired one is closed first. */
function openInvite(db: DatabaseSync, id: string, at: Date): { secret: Buffer; repository: string } | { refused: InviteRefusal } {
  closeExpiredInvites(db, at);
  const row = db.prepare("SELECT state, secret, repository FROM peer_invites WHERE id = ?").get(id);
  if (row === undefined) return { refused: "invite_unknown" };
  if (row.state !== "open" || !(row.secret instanceof Uint8Array)) return { refused: inviteRefusal(row.state) };
  return { secret: Buffer.from(row.secret), repository: String(row.repository) };
}

/** The pairings that have no end, so count against the first slice's one. */
const livePairings = (db: DatabaseSync): number => Number(db.prepare("SELECT count(*) AS n FROM peer_pairings p WHERE NOT EXISTS (SELECT 1 FROM peer_pairing_ends e WHERE e.pairing_id = p.id)").get()?.n ?? 0);

const peerProblem = (peer: { key: string; name: string; address: string }, ownKey: string): string | null => {
  if (publicKeyProblem(peer.key) !== null) return publicKeyProblem(peer.key);
  if (peer.key === ownKey) return "A workbench cannot pair with itself.";
  if (!isWorkbench(peer.name)) return WORKBENCH_RULE;
  if (typeof peer.address !== "string" || peer.address.length < 1 || peer.address.length > 300 || /[\s\0-\x1f\x7f]/.test(peer.address)) return "A peer's address is one host and port, such as 127.0.0.1:4790.";
  return null;
};

function insertDefaults(db: DatabaseSync, pairingId: string, at: string): void {
  const insert = db.prepare("INSERT INTO peer_kind_settings (pairing_id, side, direction, kind, allowed, set_by, set_at) VALUES (?, ?, ?, ?, 1, 'pairing', ?)");
  for (const kind of MESSAGE_KINDS) {
    insert.run(pairingId, "own", "send", kind, at);
    insert.run(pairingId, "own", "receive", kind, at);
    // Until the peer's first settings notice, its receive settings are the ones every pairing starts with: all on.
    insert.run(pairingId, "peer", "receive", kind, at);
  }
}

export interface PairRequest {
  inviteId: string;
  /** The joiner's random retry key: 64 hex digits. */
  pairingKey: string;
  /** The SHA-256, hex, of the whole request as it arrived, its HMAC included. */
  requestDigest: string;
  peer: { key: string; name: string; address: string };
}

/**
 * The inviter's side of a pair request. `secretMatches` is given the open invite's secret and says whether the
 * request's HMAC was made with it (compared in constant time by the caller). A new pairing is made, waiting for this
 * owner's confirmation (the joiner's owner confirmed before sending), the invite is closed and its secret erased, and
 * every kind is switched on both ways, all in one write. The same pairing key with the same request returns that
 * pairing again; anything else on a used invite is refused.
 */
export function acceptPairRequest(db: DatabaseSync, key: WorkbenchKey, request: PairRequest, secretMatches: (secret: Buffer) => boolean, at: Date = new Date()): { pairing: Pairing; retried: boolean } | { refused: PairRefusal } {
  if (!/^[0-9a-f]{64}$/.test(request.pairingKey) || !/^[0-9a-f]{64}$/.test(request.requestDigest)) return { refused: "wrong_request" };
  if (peerProblem(request.peer, key.publicKey) !== null) return { refused: "wrong_request" };
  ownWrite(db, "Accepting a pair request");
  const outcome = transaction(db, (): { pairing: Pairing; retried: boolean } | { refused: PairRefusal } => {
    const made = db.prepare("SELECT id, pairing_key, request_digest FROM peer_pairings WHERE invite_id = ?").get(request.inviteId);
    if (made !== undefined) {
      if (made.pairing_key === request.pairingKey && made.request_digest === request.requestDigest) return { pairing: getPairing(db, String(made.id))!, retried: true };
      return { refused: "invite_used" };
    }
    const invite = openInvite(db, request.inviteId, at);
    if ("refused" in invite) return invite;
    if (!secretMatches(invite.secret)) return { refused: "wrong_secret" };
    if (livePairings(db) >= MAX_PAIRINGS) return { refused: "already_paired" };
    const id = newId();
    const when = iso(at);
    erasing(db, () => db.prepare("UPDATE peer_invites SET state = 'used', secret = NULL, closed_at = ? WHERE id = ?").run(when, request.inviteId));
    db.prepare(
      "INSERT INTO peer_pairings (id, role, invite_id, pairing_key, request_digest, own_key, peer_key, peer_name, peer_fingerprint, peer_address, repository, created_at, owner_confirmed_at, peer_confirmed_at) VALUES (?, 'inviter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    ).run(id, request.inviteId, request.pairingKey, request.requestDigest, key.publicKey, request.peer.key, request.peer.name, fingerprintOf(request.peer.key), request.peer.address, invite.repository, when, when);
    insertDefaults(db, id, when);
    return { pairing: getPairing(db, id)!, retried: false };
  });
  foldLog(db);
  return outcome;
}

/** A new pairing key for a pair request: 32 random bytes as hex. */
export const newPairingKey = (): string => randomBytes(32).toString("hex");
/** The digest a pair request is kept by. */
export const requestDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface PairAnswer {
  /** What the invite said, which this owner confirmed before the request was sent: the inviter's fingerprint and the repository. */
  invite: { fingerprint: string; repository: string };
  /** The pairing key this side sent in its request. */
  sentPairingKey: string;
  /** What the inviter's signed answer says. */
  answer: { pairingId: string; pairingKey: string; repository: string; peer: { key: string; name: string; address: string } };
}

/**
 * The joiner's side, once the inviter's signed answer has been checked: the pairing as the joiner holds it, confirmed
 * by its own owner and waiting for the inviter's confirmation. Refused when the key that answered is not the one whose
 * fingerprint was in the invite, so a listener that answers in the inviter's place makes no pairing. The same answer
 * again returns the same pairing.
 */
export function joinPairing(db: DatabaseSync, key: WorkbenchKey, joined: PairAnswer, at: Date = new Date()): { pairing: Pairing } | { refused: "wrong_key" | "wrong_request" | "already_paired" } {
  const answer = joined.answer;
  if (!isId(answer.pairingId) || !/^[0-9a-f]{64}$/.test(answer.pairingKey) || repositoryProblem(answer.repository) !== null || peerProblem(answer.peer, key.publicKey) !== null) return { refused: "wrong_request" };
  if (fingerprintOf(answer.peer.key) !== joined.invite.fingerprint) return { refused: "wrong_key" };
  // The answer is to this side's own request, for the repository its owner saw in the invite.
  if (answer.pairingKey !== joined.sentPairingKey || answer.repository !== joined.invite.repository) return { refused: "wrong_request" };
  return atomically(db, () => {
    const have = getPairing(db, answer.pairingId);
    if (have !== null) return have.role === "joiner" && have.peerKey === answer.peer.key && have.repository === answer.repository ? { pairing: have } : { refused: "wrong_request" };
    if (livePairings(db) >= MAX_PAIRINGS) return { refused: "already_paired" };
    const when = iso(at);
    db.prepare(
      "INSERT INTO peer_pairings (id, role, invite_id, pairing_key, request_digest, own_key, peer_key, peer_name, peer_fingerprint, peer_address, repository, created_at, owner_confirmed_at, peer_confirmed_at) VALUES (?, 'joiner', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(answer.pairingId, answer.pairingKey, key.publicKey, answer.peer.key, answer.peer.name, joined.invite.fingerprint, answer.peer.address, answer.repository, when, when);
    insertDefaults(db, answer.pairingId, when);
    return { pairing: getPairing(db, answer.pairingId)! };
  });
}

/** This side's owner confirmed the peer's fingerprint. False when there was nothing to confirm (already, or ended). */
export function confirmByOwner(db: DatabaseSync, pairingId: string, at: Date = new Date()): boolean {
  const p = getPairing(db, pairingId);
  if (p === null || pairingState(p) !== "waiting_for_owner") return false;
  db.prepare("UPDATE peer_pairings SET owner_confirmed_at = ? WHERE id = ?").run(iso(at), pairingId);
  return true;
}

/** This side now holds the other owner's signed confirmation (src/peers/messages.ts, on a pair confirmation). */
export function confirmByPeer(db: DatabaseSync, pairingId: string, at: Date = new Date()): boolean {
  return Number(db.prepare("UPDATE peer_pairings SET peer_confirmed_at = ? WHERE id = ? AND peer_confirmed_at IS NULL").run(iso(at), pairingId).changes) === 1;
}

export type EndHow = "owner_ended" | "fingerprint_refused" | "end_notice" | "pairing_ended_refusal";

/**
 * End a pairing: the end row, and the peer's cards still waiting closed, in one write. Messages to the peer that it
 * never acknowledged are not sent again, as the pairing is no longer in force. When this side's owner ended it, the
 * signed end notice is stored just before the end and returned, to be sent once. Ending an ended pairing changes
 * nothing and returns null.
 */
export function endPairing(db: DatabaseSync, key: WorkbenchKey, pairingId: string, how: EndHow, at: Date = new Date()): { notice: SignedEnvelope | null } | null {
  return atomically(db, () => {
    const p = getPairing(db, pairingId);
    if (p === null || p.endedAt !== null) return null;
    const when = iso(at);
    let notice: SignedEnvelope | null = null;
    if (how === "owner_ended" || how === "fingerprint_refused") {
      notice = signEnvelope({ pairingId, kind: "end_notice", messageId: newId(), contextId: null, parentId: null, repository: p.repository, senderKey: key.publicKey, recipientKey: p.peerKey, sequence: nextSequence(db, pairingId), time: when, body: "" }, key);
      storeEnvelope(db, notice, "out", at);
    }
    db.prepare("INSERT INTO peer_pairing_ends (pairing_id, ended_by, how, ended_at) VALUES (?, ?, ?, ?)").run(pairingId, how === "owner_ended" || how === "fingerprint_refused" ? "owner" : "peer", how, when);
    db.prepare("UPDATE peer_cards SET decided_at = ?, decision = 'closed_by_end' WHERE pairing_id = ? AND decided_at IS NULL").run(when, pairingId);
    return { notice };
  });
}

/** The next sequence number this side gives a message on a pairing. */
export function nextSequence(db: DatabaseSync, pairingId: string): number {
  return Number(db.prepare("SELECT coalesce(max(sequence), 0) + 1 AS n FROM peer_messages WHERE pairing_id = ? AND direction = 'out'").get(pairingId)?.n ?? 1);
}

/** Write one signed envelope to `peer_messages`, with its digest. */
export function storeEnvelope(db: DatabaseSync, signed: SignedEnvelope, direction: "in" | "out", at: Date, digest: string = envelopeDigest(signed.envelope)): void {
  const e = signed.envelope;
  db.prepare(
    "INSERT INTO peer_messages (pairing_id, direction, kind, message_id, context_id, parent_id, repository, sender_key, recipient_key, sequence, sent_at, body, digest, signature, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(e.pairingId, direction, e.kind, e.messageId, e.contextId, e.parentId, e.repository, e.senderKey, e.recipientKey, e.sequence, e.time, e.body, digest, signed.signature, iso(at));
}

export type KindSide = "own" | "peer";
export type KindDirection = "send" | "receive";

/** The latest setting for one kind on a pairing. A pairing's settings are written when it is made, so there is always one. */
export function kindSetting(db: DatabaseSync, pairingId: string, side: KindSide, direction: KindDirection, kind: MessageKind): boolean {
  const row = db.prepare("SELECT allowed FROM peer_kind_settings WHERE pairing_id = ? AND side = ? AND direction = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(pairingId, side, direction, kind);
  return row?.allowed === 1;
}

/** This side may send `kind` on the pairing: its own send setting and the peer's last receive setting both allow it. */
export const maySend = (db: DatabaseSync, pairingId: string, kind: MessageKind): boolean => kindSetting(db, pairingId, "own", "send", kind) && kindSetting(db, pairingId, "peer", "receive", kind);
/** This side takes `kind` from the peer. Its own setting decides, whatever the other side says. */
export const mayReceive = (db: DatabaseSync, pairingId: string, kind: MessageKind): boolean => kindSetting(db, pairingId, "own", "receive", kind);

/** The owner changed whether a kind may be sent or received on a pairing. Only the owner, in Settings, calls this. */
export function setKindByOwner(db: DatabaseSync, pairingId: string, direction: KindDirection, kind: MessageKind, allowed: boolean, at: Date = new Date()): void {
  db.prepare("INSERT INTO peer_kind_settings (pairing_id, side, direction, kind, allowed, set_by, set_at) VALUES (?, 'own', ?, ?, ?, 'owner', ?)").run(pairingId, direction, kind, allowed ? 1 : 0, iso(at));
}

/** This side's receive settings, as its settings notice tells them. */
export function ownReceiveSettings(db: DatabaseSync, pairingId: string): Record<MessageKind, boolean> {
  return Object.fromEntries(MESSAGE_KINDS.map((kind) => [kind, mayReceive(db, pairingId, kind)])) as Record<MessageKind, boolean>;
}

/**
 * Record the receive settings the peer's signed notice gave. Its sequence number orders notices: an older one that
 * arrives after a newer one is stored as received but changes nothing.
 */
export function recordPeerReceive(db: DatabaseSync, pairingId: string, settings: Readonly<Record<MessageKind, boolean>>, sequence: number, at: Date): void {
  const newer = db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND kind = 'settings_notice' AND sequence > ?").get(pairingId, sequence);
  if (newer !== undefined) return;
  const insert = db.prepare("INSERT INTO peer_kind_settings (pairing_id, side, direction, kind, allowed, set_by, set_at) VALUES (?, 'peer', 'receive', ?, ?, 'peer_notice', ?)");
  for (const kind of MESSAGE_KINDS) insert.run(pairingId, kind, settings[kind] ? 1 : 0, iso(at));
}

