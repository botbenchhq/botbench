import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../store/db.ts";
import {
  asEnvelope,
  envelopeDigest,
  envelopeProblem,
  isId,
  isMessageKind,
  isResponseKind,
  newId,
  parseSettingsNotice,
  signEnvelope,
  verifyEnvelope,
  type Envelope,
  type EnvelopeKind,
  type MessageKind,
  type RefusalReason,
  type SignedEnvelope,
} from "./envelope.ts";
import type { WorkbenchKey } from "./key.ts";
import { confirmByPeer, endPairing, getPairing, maySend, mayReceive, nextSequence, pairingState, recordPeerReceive, storeEnvelope, type Pairing } from "./pairings.ts";

/*
 * Peer messages in the store (Peers P5, ADR 0004 decisions 4, 6, 7 and 8). Every envelope sent or received is in
 * `peer_messages`, append-only. No network: these are what the peer listener and the sender will call.
 *
 * Receiving checks, in this order, and stores nothing until all pass: the pairing is known, the signature is the
 * pairing's key's over the whole envelope (before anything else in it is read), the pairing has not ended, it is in
 * force (a pair confirmation and an end notice excepted), the repository is the pairing's, the message id is new, the
 * kind has its shape, the parent is right, the sequence number is new, the kind is switched on here, and the limits
 * hold. Idempotent by message id (Open Agent Bridge, `src/lib/messaging.ts`: a retry key and a digest of the payload):
 * the same id with the same bytes gets the acknowledgement stored the first time; the same id with other bytes is
 * refused and written to the action log.
 *
 * An acknowledgement and a refusal answer one message this side sent, and only one each, so a replayed or invented one
 * changes nothing. A refusal is signed only for a message whose signature was checked; it is not stored on this side.
 */

/** The cap on round trips in a thread when the settings say nothing (`peers.roundTripsPerThread`). */
export const ROUND_TRIPS = 3;
export const MIN_ROUND_TRIPS = 1;
export const MAX_ROUND_TRIPS = 10;
/** Per peer: the most messages it may send in an hour, and the most cards it may have waiting (decision 8). */
export const MESSAGES_PER_HOUR = 30;
export const WAITING_CARDS = 10;

/** In a transaction of its own, or in the caller's when one is open. */
const atomically = <T>(db: DatabaseSync, fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));
const iso = (at: Date): string => at.toISOString();

const roundTripsOf = (cap: number): number => {
  if (!Number.isSafeInteger(cap) || cap < MIN_ROUND_TRIPS || cap > MAX_ROUND_TRIPS) throw new Error(`The cap on round trips in a thread is a whole number from ${MIN_ROUND_TRIPS} to ${MAX_ROUND_TRIPS}.`);
  return cap;
};

/**
 * Whether the thread has room for one more message from `direction`: a thread of `cap` round trips holds 2 × cap
 * messages, cap from each side (decision 6). Counted over both directions, so it holds at both ends.
 */
export function threadFull(db: DatabaseSync, pairingId: string, contextId: string, direction: "in" | "out", cap: number = ROUND_TRIPS): boolean {
  const limit = roundTripsOf(cap);
  const row = db.prepare("SELECT count(*) AS total, count(*) FILTER (WHERE direction = ?) AS mine FROM peer_messages WHERE pairing_id = ? AND context_id = ? AND kind IN ('question', 'answer')").get(direction, pairingId, contextId);
  return Number(row?.total ?? 0) >= 2 * limit || Number(row?.mine ?? 0) >= limit;
}

/**
 * Whether the peer has sent its 30 messages in the hour before `at`. Every kind with a sequence number counts, a
 * settings notice too; acknowledgements and refusals do not, as each answers one message this side sent.
 */
export function tooManyThisHour(db: DatabaseSync, pairingId: string, at: Date): boolean {
  const since = iso(new Date(at.getTime() - 3600_000));
  const row = db.prepare("SELECT count(*) AS n FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND sequence > 0 AND stored_at > ?").get(pairingId, since);
  return Number(row?.n ?? 0) >= MESSAGES_PER_HOUR;
}

/** Whether the peer already has 10 cards waiting for this owner. */
export function tooManyWaiting(db: DatabaseSync, pairingId: string): boolean {
  const row = db.prepare("SELECT count(*) AS n FROM peer_cards WHERE pairing_id = ? AND direction = 'in' AND decided_at IS NULL").get(pairingId);
  return Number(row?.n ?? 0) >= WAITING_CARDS;
}

interface Stored {
  direction: "in" | "out";
  kind: string;
  contextId: string | null;
}
const storedMessage = (db: DatabaseSync, pairingId: string, messageId: string): Stored | null => {
  const row = db.prepare("SELECT direction, kind, context_id FROM peer_messages WHERE pairing_id = ? AND message_id = ?").get(pairingId, messageId);
  return row === undefined ? null : { direction: row.direction === "in" ? "in" : "out", kind: String(row.kind), contextId: row.context_id == null ? null : String(row.context_id) };
};

/**
 * Why a question or an answer cannot have the parent it names, sent in `direction`, or null. An answer answers a
 * question the other side sent in the same thread. A question with no parent opens a new thread; one with a parent
 * follows a message of the same thread.
 */
function parentProblem(db: DatabaseSync, e: Envelope, direction: "in" | "out"): string | null {
  if (e.parentId === null) {
    const used = db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND context_id = ?").get(e.pairingId, e.contextId);
    return used === undefined ? null : "A question with no parent opens a new thread, and this thread is open already.";
  }
  const parent = storedMessage(db, e.pairingId, e.parentId);
  if (parent === null || !isMessageKind(parent.kind) || parent.contextId !== e.contextId) return `The parent of this ${e.kind} is not a message of the same thread.`;
  if (e.kind === "answer" && (parent.kind !== "question" || parent.direction === direction)) return "An answer's parent is a question the other workbench sent in the same thread.";
  return null;
}

export const toSigned = (row: Record<string, unknown>): SignedEnvelope => ({
  envelope: {
    pairingId: String(row.pairing_id),
    kind: String(row.kind) as Envelope["kind"],
    messageId: String(row.message_id),
    contextId: row.context_id == null ? null : String(row.context_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    repository: String(row.repository),
    senderKey: String(row.sender_key),
    recipientKey: String(row.recipient_key),
    sequence: Number(row.sequence),
    time: String(row.sent_at),
    body: String(row.body),
  },
  signature: String(row.signature),
});

/** The acknowledgement this side made to the peer's message `messageId`, when it made and stored one. */
function storedAcknowledgement(db: DatabaseSync, pairingId: string, messageId: string): SignedEnvelope | null {
  const row = db.prepare("SELECT * FROM peer_messages WHERE pairing_id = ? AND direction = 'out' AND kind = 'acknowledgement' AND parent_id = ?").get(pairingId, messageId);
  return row === undefined ? null : toSigned(row);
}
/** A message this side wrote, as it was signed. */
function storedOutgoing(db: DatabaseSync, pairingId: string, messageId: string): SignedEnvelope | null {
  const row = db.prepare("SELECT * FROM peer_messages WHERE pairing_id = ? AND direction = 'out' AND message_id = ?").get(pairingId, messageId);
  return row === undefined ? null : toSigned(row);
}

const response = (key: WorkbenchKey, p: Pairing, kind: "acknowledgement" | "refusal", parentId: string, at: Date, body = ""): SignedEnvelope =>
  signEnvelope({ pairingId: p.id, kind, messageId: newId(), contextId: null, parentId, repository: p.repository, senderKey: key.publicKey, recipientKey: p.peerKey, sequence: 0, time: iso(at), body }, key);

export type Received =
  /** Stored now; `acknowledgement` is what goes back (null for a kind that is not acknowledged). */
  | { outcome: "stored"; envelope: Envelope; acknowledgement: SignedEnvelope | null }
  /** The same bytes again: nothing new stored, and the acknowledgement stored the first time goes back. */
  | { outcome: "replayed"; envelope: Envelope; acknowledgement: SignedEnvelope | null }
  /**
   * Nothing stored. `refusal` is signed when the message's own signature was checked, else null: an unknown pairing or
   * a bad signature gets no signed answer. `problem` says what was wrong, for the log.
   */
  | { outcome: "refused"; reason: RefusalReason | "unknown_pairing" | "bad_signature" | "unreadable"; refusal: SignedEnvelope | null; problem: string };

export interface ReceiveOptions {
  /** `peers.roundTripsPerThread`, 1 to 10; 3 when absent. */
  roundTrips?: number;
  at?: Date;
  /**
   * The kinds the caller takes here (the peer listener's route, or a response to a request this side made). Any other
   * kind, once its signature checked, gets a signed refusal (`kind_not_taken`) and nothing is stored. All when absent.
   */
  kinds?: readonly EnvelopeKind[];
}

/** Take one envelope from the peer: check it, store it, and say what goes back. */
export function receiveEnvelope(db: DatabaseSync, key: WorkbenchKey, wire: { envelope: unknown; signature: unknown }, o: ReceiveOptions = {}): Received {
  const at = o.at ?? new Date();
  const cap = roundTripsOf(o.roundTrips ?? ROUND_TRIPS);
  const e = asEnvelope(wire.envelope);
  if (e === null) return { outcome: "refused", reason: "unreadable", refusal: null, problem: "The envelope does not have Botbench's fields." };
  const result = atomically(db, (): Received => {
    const p = getPairing(db, e.pairingId);
    if (p === null) return { outcome: "refused", reason: "unknown_pairing", refusal: null, problem: "This workbench has no pairing by that id." };
    if (e.recipientKey !== p.ownKey || !verifyEnvelope(e, wire.signature, p.peerKey)) return { outcome: "refused", reason: "bad_signature", refusal: null, problem: "The signature is not the paired workbench's, over this envelope, to this workbench." };
    const refuse = (reason: RefusalReason, problem: string): Received => ({ outcome: "refused", reason, refusal: isResponseKind(e.kind) || !isId(e.messageId) ? null : response(key, p, "refusal", e.messageId, at, reason), problem });
    const state = pairingState(p);
    if (state === "ended") return refuse("pairing_ended", "This pairing has ended.");
    if (o.kinds !== undefined && !o.kinds.includes(e.kind)) return refuse("kind_not_taken", `This workbench does not take a ${String(e.kind).slice(0, 40)} here.`);
    const early = (e.kind === "pair_confirmation" && p.role === "joiner" && state === "waiting_for_peer") || e.kind === "end_notice";
    if (state !== "in_force" && !early) return refuse("not_confirmed", "This pairing is not yet confirmed by both owners.");
    if (e.repository !== p.repository) return refuse("wrong_repository", "The message names another repository than the pairing's.");

    const digest = envelopeDigest(e);
    const seen = db.prepare("SELECT digest FROM peer_messages WHERE pairing_id = ? AND message_id = ?").get(p.id, e.messageId);
    if (seen !== undefined) {
      if (seen.digest === digest) return { outcome: "replayed", envelope: e, acknowledgement: storedAcknowledgement(db, p.id, e.messageId) };
      logConflict(db, p, e, String(wire.signature), digest, at);
      return refuse("message_conflict", "This message id was used before for other content.");
    }
    const shape = envelopeProblem(e);
    if (shape !== null) return refuse("wrong_shape", shape);
    if (e.kind === "pair_confirmation" && p.role !== "joiner") return refuse("wrong_shape", "Only the workbench that sent the invite confirms a pairing this way.");
    if (isResponseKind(e.kind)) {
      // A response answers a message this side sent, once.
      const parent = storedMessage(db, p.id, e.parentId!);
      if (parent === null || parent.direction !== "out" || isResponseKind(parent.kind)) return refuse("wrong_parent", `This ${e.kind} answers no message this workbench sent.`);
      if (db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND parent_id = ? AND kind IN ('acknowledgement', 'refusal')").get(p.id, e.parentId) !== undefined) return refuse("wrong_parent", "That message was answered already.");
    } else if (db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND sequence = ?").get(p.id, e.sequence) !== undefined) {
      return refuse("sequence_reused", "Another message already had this sequence number.");
    }
    if (isMessageKind(e.kind)) {
      const parent = parentProblem(db, e, "in");
      if (parent !== null) return refuse("wrong_parent", parent);
      // The receiving end's own setting decides, before anything is stored (decision 11).
      if (!mayReceive(db, p.id, e.kind)) return refuse("kind_switched_off", `This workbench does not take a ${e.kind} from ${p.peerName}.`);
      if (threadFull(db, p.id, e.contextId!, "in", cap)) return refuse("thread_full", `This thread has had its ${cap} round trips.`);
    }
    if (!isResponseKind(e.kind) && e.kind !== "end_notice" && tooManyThisHour(db, p.id, at)) return refuse("too_many_messages", `${p.peerName} has sent ${MESSAGES_PER_HOUR} messages in the last hour.`);
    if (isMessageKind(e.kind) && tooManyWaiting(db, p.id)) return refuse("too_many_cards", `${p.peerName} has ${WAITING_CARDS} cards waiting already.`);

    storeEnvelope(db, { envelope: e, signature: String(wire.signature) }, "in", at, digest);
    let acknowledgement: SignedEnvelope | null = null;
    if (isMessageKind(e.kind) || e.kind === "pair_confirmation" || e.kind === "settings_notice") {
      acknowledgement = response(key, p, "acknowledgement", e.messageId, at);
      storeEnvelope(db, acknowledgement, "out", at);
    }
    if (e.kind === "pair_confirmation") confirmByPeer(db, p.id, at);
    if (e.kind === "settings_notice") recordPeerReceive(db, p.id, parseSettingsNotice(e.body)!, e.sequence, at);
    // The other side ended the pairing: by its notice, or by a signed refusal that names the end (decision 4).
    if (e.kind === "end_notice") endPairing(db, key, p.id, "end_notice", at);
    if (e.kind === "refusal" && e.body === "pairing_ended") endPairing(db, key, p.id, "pairing_ended_refusal", at);
    return { outcome: "stored", envelope: e, acknowledgement };
  });
  return result;
}

/**
 * A conflicting replay, in the action log, as the peer's doing, with the digest and signature of what was refused as
 * evidence. At most one row a minute per pairing (decision 8): within that minute, further conflicts are refused alike
 * and not written again.
 */
function logConflict(db: DatabaseSync, p: Pairing, e: Envelope, signature: string, digest: string, at: Date): void {
  const recent = db.prepare("SELECT 1 FROM action_log WHERE rule = 'peer_message_conflict' AND asked_by_pairing_id = ? AND ts > ?").get(p.id, iso(new Date(at.getTime() - 60_000)));
  if (recent !== undefined) return;
  db.prepare(
    "INSERT INTO action_log (ts, task_id, run_id, attempt_id, rule, tool, command, cwd, detail, asked_by, asked_by_pairing_id, asked_by_peer_name, asked_by_peer_fingerprint) VALUES (?, NULL, NULL, NULL, 'peer_message_conflict', 'peer', ?, '', ?, 'peer', ?, ?, ?)",
  ).run(iso(at), `${e.kind} ${e.messageId}`, `${p.peerName}'s workbench sent message ${e.messageId} again with other content; Botbench kept the first and refused this one. Refused envelope: digest ${digest}, signature ${signature}.`, p.id, p.peerName, p.peerFingerprint);
}

export interface Outgoing {
  pairingId: string;
  kind: MessageKind | "settings_notice" | "pair_confirmation";
  contextId: string | null;
  parentId: string | null;
  body: string;
  /** The message id the card showed, when it was drafted on a card; a new one when absent. */
  messageId?: string;
}

/**
 * Write one message to the peer before it is sent: signed, with the next sequence number, stored. Refused, with
 * nothing stored, when the pairing is not in force, the shape or parent is wrong, the kind is switched off on this side
 * or the peer's last settings refuse it, or the thread has had its round trips. Called at every send attempt by the
 * sender, so the settings are checked again each time.
 */
export function writeOutgoing(db: DatabaseSync, key: WorkbenchKey, m: Outgoing, o: ReceiveOptions = {}): { sent: SignedEnvelope } | { refused: RefusalReason; problem: string } {
  const at = o.at ?? new Date();
  const cap = roundTripsOf(o.roundTrips ?? ROUND_TRIPS);
  return atomically(db, () => {
    const p = getPairing(db, m.pairingId);
    if (p === null) throw new Error(`There is no pairing ${m.pairingId} to send to.`);
    const state = pairingState(p);
    if (state === "ended") return { refused: "pairing_ended" as const, problem: "This pairing has ended." };
    if (state !== "in_force") return { refused: "not_confirmed" as const, problem: "This pairing is not yet confirmed by both owners." };
    if (m.kind === "pair_confirmation" && p.role !== "inviter") return { refused: "wrong_shape" as const, problem: "Only the workbench that sent the invite sends the pair confirmation." };
    // A retry: the message was written before its first attempt. The same signed bytes go again, once the settings
    // are checked again (decision 11); different content under its id is a mistake of the caller.
    if (m.messageId !== undefined) {
      const stored = storedOutgoing(db, p.id, m.messageId);
      if (stored !== null) {
        const e = stored.envelope;
        if (e.kind !== m.kind || e.contextId !== m.contextId || e.parentId !== m.parentId || e.body !== m.body) throw new Error(`Message ${m.messageId} was written already with other content; a retry sends it as written.`);
        if (isMessageKind(e.kind) && !maySend(db, p.id, e.kind)) return { refused: "kind_switched_off" as const, problem: `A ${e.kind} to ${p.peerName} is switched off.` };
        return { sent: stored };
      }
    }
    const e: Envelope = { pairingId: p.id, kind: m.kind, messageId: m.messageId ?? newId(), contextId: m.contextId, parentId: m.parentId, repository: p.repository, senderKey: key.publicKey, recipientKey: p.peerKey, sequence: nextSequence(db, p.id), time: iso(at), body: m.body };
    const shape = envelopeProblem(e);
    if (shape !== null) return { refused: "wrong_shape" as const, problem: shape };
    if (isMessageKind(m.kind)) {
      const parent = parentProblem(db, e, "out");
      if (parent !== null) return { refused: "wrong_parent" as const, problem: parent };
      if (!maySend(db, p.id, m.kind)) return { refused: "kind_switched_off" as const, problem: `A ${m.kind} to ${p.peerName} is switched off.` };
      if (threadFull(db, p.id, e.contextId!, "out", cap)) return { refused: "thread_full" as const, problem: `This thread has had its ${cap} round trips.` };
    }
    const sent = signEnvelope(e, key);
    storeEnvelope(db, sent, "out", at);
    return { sent };
  });
}
