import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../store/db.ts";
import { decideDraftCard, decideIncomingCard, threadFriction, type CardFriction } from "./cards.ts";
import { isId, isMessageKind, MESSAGE_KINDS, newId, settingsNoticeBody, type MessageKind, type RefusalReason, type SignedEnvelope } from "./envelope.ts";
import { PeerError } from "./errors.ts";
import type { WorkbenchKey } from "./key.ts";
import { peerOfWork } from "./asked-by.ts";
import { logPeer, type PeerLogRow } from "./log.ts";
import { ROUND_TRIPS, writeOutgoing } from "./messages.ts";
import { getPairing, kindSetting, maySend, ownReceiveSettings, pairingState, setKindByOwner, type KindDirection, type Pairing } from "./pairings.ts";

/*
 * Questions and answers between two paired workbenches, as the owner sees and moves them (Peers P5, ADR 0004 decisions
 * 6 to 11). The store keeps the rules (src/peers/messages.ts, cards.ts); this module is what the owner's routes and the
 * sender call.
 *
 * - The owner's own message is sent when they press Send: their route is the Send. It needs no card.
 * - A peer's question or answer is a card for the owner and nothing else; the owner answers it, gives it to Claude
 *   Code, or dismisses it. Answering it is the owner's own message in reply.
 * - An agent's draft is a card holding the exact text that will be sent (src/peers/drafts.ts makes it). Send or Don't
 *   send is the owner's; Send may carry the owner's edit, and the friction record says whether it went as drafted.
 * - Every send attempt, the first and each retry, checks this side's send setting and the peer's last receive setting.
 *   A kind switched off by then is not sent: it reads "Not sent: switched off" and is logged `peer_kind_refused`.
 */

const iso = (at: Date): string => at.toISOString();
const atomically = <T>(db: DatabaseSync, fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));
/** The repository's short name for a card ("api" for github.com/acme/api, or for a bare repository …/api.git on this Mac). */
export const repositoryWord = (repository: string): string => repository.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || repository;
const kindWords = (kind: MessageKind): string => (kind === "question" ? "a question" : "an answer");

/** How long an outgoing question or answer is tried before it reads "Not delivered" (decision 7). */
export const DELIVERY_WINDOW_MS = 24 * 3600_000;

const REASON_WORDS: Record<RefusalReason, string> = {
  pairing_ended: "it ended the pairing",
  not_confirmed: "the pairing is not confirmed there",
  wrong_repository: "it names another repository",
  message_conflict: "its id was used before for other content",
  wrong_shape: "it is not in the shape Botbench sends",
  wrong_parent: "it does not follow a message of the thread",
  sequence_reused: "its number was used before",
  kind_switched_off: "its owner switched this kind of message off",
  thread_full: "the thread has had its round trips",
  too_many_messages: "this workbench sent too many messages this hour",
  too_many_cards: "its owner has too many cards waiting from this workbench",
  kind_not_taken: "it does not take this kind of message",
};

export type SendState = "sending" | "delivered" | "refused" | "not_delivered" | "not_sent_switched_off" | "not_sent_ended";

/** What became of an outgoing question or answer, with the words its owner reads. */
export function sendState(db: DatabaseSync, p: Pairing, messageId: string, storedAt: string | null, at: Date = new Date()): { state: SendState; words: string } {
  const answer = db.prepare("SELECT kind, body FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND parent_id = ? AND kind IN ('acknowledgement', 'refusal')").get(p.id, messageId);
  if (answer?.kind === "acknowledgement") return { state: "delivered", words: "Delivered" };
  if (answer?.kind === "refusal") return { state: "refused", words: `Not taken by ${p.peerName}'s workbench: ${REASON_WORDS[String(answer.body) as RefusalReason] ?? "it gave no reason Botbench knows"}` };
  const outcome = db.prepare("SELECT outcome FROM peer_send_outcomes WHERE pairing_id = ? AND message_id = ?").get(p.id, messageId)?.outcome;
  if (outcome === "switched_off") return { state: "not_sent_switched_off", words: "Not sent: switched off" };
  if (outcome === "not_delivered") return { state: "not_delivered", words: "Not delivered" };
  if (storedAt === null) return { state: "not_sent_switched_off", words: "Not sent: switched off" };
  if (p.endedAt !== null) return { state: "not_sent_ended", words: "Not sent: the pairing ended" };
  if (Date.parse(storedAt) <= at.getTime() - DELIVERY_WINDOW_MS) return { state: "not_delivered", words: "Not delivered" };
  return { state: "sending", words: `Sending to ${p.peerName}'s workbench` };
}

/** Botbench stops sending a message: its kind was switched off by this attempt, or 24 hours passed. Once per message. */
export function stopSending(db: DatabaseSync, p: Pairing, messageId: string, kind: MessageKind, outcome: "switched_off" | "not_delivered", at: Date = new Date()): void {
  atomically(db, () => {
    if (db.prepare("SELECT 1 FROM peer_send_outcomes WHERE pairing_id = ? AND message_id = ?").get(p.id, messageId) !== undefined) return;
    db.prepare("INSERT INTO peer_send_outcomes (pairing_id, message_id, outcome, at) VALUES (?, ?, ?, ?)").run(p.id, messageId, outcome, iso(at));
    if (outcome === "switched_off") {
      const own = kindSetting(db, p.id, "own", "send", kind);
      logPeer(db, { rule: "peer_kind_refused", command: `${kind} not sent`, detail: `${kindWords(kind)[0]!.toUpperCase()}${kindWords(kind).slice(1)} to ${p.peerName}'s workbench (message ${messageId}) was not sent: ${own ? `${p.peerName}'s workbench no longer takes a ${kind} from you` : `you switched off sending a ${kind} to ${p.peerName}`}. It reads "Not sent: switched off".`, at });
    } else {
      logPeer(db, { rule: "peer_message", command: `${kind} not delivered`, detail: `${kindWords(kind)[0]!.toUpperCase()}${kindWords(kind).slice(1)} to ${p.peerName}'s workbench (message ${messageId}) was tried for 24 hours and never acknowledged. Botbench stopped trying; it reads "Not delivered".`, at });
    }
  });
}

/**
 * Before each attempt to send a stored question or answer, the first and each retry: whether it may still go. When its
 * kind is switched off by now, on this side or by the peer's last settings, it is stopped and false is returned.
 */
export function stillAllowed(db: DatabaseSync, signed: SignedEnvelope, at: Date = new Date()): boolean {
  const e = signed.envelope;
  if (!isMessageKind(e.kind)) return true;
  if (maySend(db, e.pairingId, e.kind)) return true;
  const p = getPairing(db, e.pairingId);
  if (p !== null) stopSending(db, p, e.messageId, e.kind, "switched_off", at);
  return false;
}

const inForce = (db: DatabaseSync, pairingId: unknown): Pairing => {
  const p = typeof pairingId === "string" ? getPairing(db, pairingId) : null;
  if (p === null) throw new PeerError(404, "There is no pairing by that id.");
  const state = pairingState(p);
  if (state === "ended") throw new PeerError(409, `The pairing with ${p.peerName} has ended. Nothing is sent to its workbench any more.`);
  if (state !== "in_force") throw new PeerError(409, `The pairing with ${p.peerName} is not confirmed by both owners yet, so nothing can be sent.`);
  return p;
};

export interface SentMessage {
  pairingId: string;
  messageId: string;
  contextId: string;
  kind: MessageKind;
  state: SendState;
  words: string;
}

interface Placed {
  kind: MessageKind;
  contextId: string;
  parentId: string | null;
}

/**
 * Where a message goes in its thread: an answer answers a question the peer sent; a question with no parent opens a
 * new thread, and one with a parent follows that message in its thread.
 */
function place(db: DatabaseSync, p: Pairing, kind: MessageKind, parentId: string | null): Placed {
  if (parentId === null) {
    if (kind === "answer") throw new PeerError(400, "An answer names the question it answers.");
    return { kind, contextId: newId(), parentId: null };
  }
  const parent = db.prepare("SELECT direction, kind, context_id FROM peer_messages WHERE pairing_id = ? AND message_id = ? AND kind IN ('question', 'answer')").get(p.id, parentId);
  if (parent === undefined) throw new PeerError(404, `There is no question or answer by that id with ${p.peerName}.`);
  if (kind === "answer" && (parent.kind !== "question" || parent.direction !== "in")) throw new PeerError(400, `An answer answers a question ${p.peerName}'s workbench sent.`);
  if (kind === "answer" && db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND direction = 'out' AND kind = 'answer' AND parent_id = ?").get(p.id, parentId) !== undefined) throw new PeerError(409, `That question from ${p.peerName} has been answered already. Ask a question in the thread to go on.`);
  return { kind, contextId: String(parent.context_id), parentId };
}

export interface SendOptions {
  roundTrips?: number;
  at?: Date;
}

/**
 * Write a question or an answer that leaves on the owner's Send: checked, signed and stored before it is sent, then
 * tried until acknowledged. When its kind is switched off now, nothing is stored or sent, and the answer says so.
 */
function writeOnSend(db: DatabaseSync, key: WorkbenchKey, p: Pairing, placed: Placed, text: string, messageId: string, o: SendOptions): SentMessage | { refused: RefusalReason; problem: string } {
  const at = o.at ?? new Date();
  const written = writeOutgoing(db, key, { pairingId: p.id, kind: placed.kind, contextId: placed.contextId, parentId: placed.parentId, body: text, messageId }, { roundTrips: o.roundTrips ?? ROUND_TRIPS, at });
  if ("refused" in written) return written;
  return { pairingId: p.id, messageId, contextId: placed.contextId, kind: placed.kind, ...sendState(db, p, messageId, iso(at), at) };
}

const refusedWords = (p: Pairing, kind: MessageKind, r: { refused: RefusalReason; problem: string }, roundTrips: number): PeerError => {
  if (r.refused === "thread_full") return new PeerError(409, `This thread with ${p.peerName} has had its ${roundTrips} round trips, so nothing more is sent in it. Start a new question to go on.`);
  if (r.refused === "wrong_parent") return new PeerError(400, r.problem);
  if (r.refused === "wrong_shape") return new PeerError(400, r.problem);
  return new PeerError(409, `The ${kind} was not sent: ${r.problem}`);
};

/** A kind switched off when the owner pressed Send: nothing is stored or sent, and the row says so. */
function switchedOffAtSend(db: DatabaseSync, p: Pairing, kind: MessageKind, messageId: string, contextId: string, at: Date, about: Partial<PeerLogRow> = {}): SentMessage {
  const own = kindSetting(db, p.id, "own", "send", kind);
  logPeer(db, { ...about, rule: "peer_kind_refused", command: `${kind} not sent`, detail: `${kindWords(kind)[0]!.toUpperCase()}${kindWords(kind).slice(1)} to ${p.peerName}'s workbench was not sent when you pressed Send: ${own ? `${p.peerName}'s workbench does not take a ${kind} from you` : `you switched off sending a ${kind} to ${p.peerName}`}.`, at });
  return { pairingId: p.id, messageId, contextId, kind, state: "not_sent_switched_off", words: "Not sent: switched off" };
}

/**
 * The owner's own question or answer, sent as they press Send. `parentId` names the message it follows: the peer's
 * question it answers, or a message of the thread a question follows; none opens a new thread. A card of the peer's
 * still waiting on the message it follows is decided as answered by the owner.
 */
export function ownerSend(db: DatabaseSync, key: WorkbenchKey, input: { pairingId: unknown; kind: unknown; text: unknown; parentId?: unknown }, o: SendOptions = {}): SentMessage {
  const at = o.at ?? new Date();
  const roundTrips = o.roundTrips ?? ROUND_TRIPS;
  const p = inForce(db, input.pairingId);
  if (!isMessageKind(input.kind)) throw new PeerError(400, `A message to ${p.peerName} is a question or an answer.`);
  if (typeof input.text !== "string" || input.text.trim() === "") throw new PeerError(400, "Write the message to send.");
  const parentId = input.parentId === undefined || input.parentId === null ? null : isId(input.parentId) ? input.parentId : null;
  if (input.parentId !== undefined && input.parentId !== null && parentId === null) throw new PeerError(400, "The message this follows is named by its id.");
  const kind = input.kind;
  const text = input.text;
  return atomically(db, () => {
    const placed = place(db, p, kind, parentId);
    const messageId = newId();
    if (!maySend(db, p.id, kind)) return switchedOffAtSend(db, p, kind, messageId, placed.contextId, at);
    const sent = writeOnSend(db, key, p, placed, text, messageId, o);
    if ("refused" in sent) throw refusedWords(p, kind, sent, roundTrips);
    if (parentId !== null && db.prepare("SELECT 1 FROM peer_cards WHERE pairing_id = ? AND direction = 'in' AND message_id = ? AND decided_at IS NULL").get(p.id, parentId) !== undefined) {
      decideIncomingCard(db, p.id, parentId, "answered", at);
    }
    logPeer(db, { rule: "peer_message", command: `${kind} sent by you`, detail: `You pressed Send on ${kindWords(kind)} to ${p.peerName}'s workbench (message ${messageId}, thread ${placed.contextId}, ${[...text].length} characters). Only this text leaves this Mac, and only to ${p.peerName}'s workbench; it is tried until it is acknowledged, for up to 24 hours.`, at });
    return sent;
  });
}

/** A card of the peer's still waiting for this owner. */
function waitingIncoming(db: DatabaseSync, p: Pairing, messageId: unknown): { kind: MessageKind; contextId: string } {
  const row = typeof messageId === "string" ? db.prepare("SELECT kind, context_id FROM peer_cards WHERE pairing_id = ? AND direction = 'in' AND message_id = ? AND decided_at IS NULL").get(p.id, messageId) : undefined;
  if (row === undefined) throw new PeerError(404, `There is no card from ${p.peerName} waiting by that id: it was decided already, or never shown.`);
  return { kind: String(row.kind) as MessageKind, contextId: String(row.context_id) };
}

/**
 * Answer it yourself: the owner's own reply to the peer's card, sent on Send. To a question it is the answer; to an
 * answer of the peer's it is the owner's next question in the thread.
 */
export function answerCard(db: DatabaseSync, key: WorkbenchKey, pairingId: unknown, messageId: unknown, text: unknown, o: SendOptions = {}): SentMessage {
  const p = inForce(db, pairingId);
  const card = waitingIncoming(db, p, messageId);
  return ownerSend(db, key, { pairingId: p.id, kind: card.kind === "question" ? "answer" : "question", text, parentId: messageId }, o);
}

/** Dismiss: the card is closed by the owner, and nothing is sent. */
export function dismissCard(db: DatabaseSync, pairingId: unknown, messageId: unknown, at: Date = new Date()): void {
  const p = typeof pairingId === "string" ? getPairing(db, pairingId) : null;
  if (p === null) throw new PeerError(404, "There is no pairing by that id.");
  atomically(db, () => {
    const card = waitingIncoming(db, p, messageId);
    decideIncomingCard(db, p.id, String(messageId), "dismissed", at);
    logPeer(db, { rule: "peer_message", command: `${card.kind} dismissed`, detail: `You dismissed the card for ${kindWords(card.kind)} from ${p.peerName}'s workbench (message ${String(messageId)}). Nothing was sent, and no agent was given it.`, at });
  });
}

/** An agent's draft as its card holds it. */
export interface Draft {
  id: number;
  pairingId: string;
  messageId: string;
  contextId: string;
  parentId: string | null;
  kind: MessageKind;
  body: string;
  runId: number | null;
  chatId: number | null;
  taskId: number | null;
  /** The agent that drafted it, by its product name. */
  agent: string;
  draftedAt: string;
}
const toDraft = (row: Record<string, unknown>): Draft => ({
  id: Number(row.id),
  pairingId: String(row.pairing_id),
  messageId: String(row.message_id),
  contextId: String(row.context_id),
  parentId: row.parent_id == null ? null : String(row.parent_id),
  kind: String(row.kind) as MessageKind,
  body: String(row.body),
  runId: row.run_id == null ? null : Number(row.run_id),
  chatId: row.chat_id == null ? null : Number(row.chat_id),
  taskId: row.task_id == null ? null : Number(row.task_id),
  agent: String(row.agent),
  draftedAt: String(row.drafted_at),
});

function waitingDraft(db: DatabaseSync, p: Pairing, messageId: unknown): Draft {
  const row = typeof messageId === "string" ? db.prepare("SELECT d.* FROM peer_drafts d JOIN peer_cards c ON c.pairing_id = d.pairing_id AND c.direction = 'out' AND c.message_id = d.message_id WHERE d.pairing_id = ? AND d.message_id = ? AND c.decided_at IS NULL").get(p.id, messageId) : undefined;
  if (row === undefined) throw new PeerError(404, "There is no draft waiting for you by that id: it was decided already, or never shown.");
  return toDraft(row);
}

/** Who a draft's rows name: the peer whose message its work was given, else this workbench's agent. */
const draftRow = (d: Draft) => ({ taskId: d.taskId, runId: d.runId, asked: { by: "agent" as const, pairingId: null, peerName: null, peerFingerprint: null } });

/**
 * Send, on an agent's draft card: the owner's Send. The text sent is the card's, or the owner's edit of it. The kind is
 * checked again now; switched off, it is not sent and reads "Not sent: switched off".
 */
export function sendDraft(db: DatabaseSync, key: WorkbenchKey, pairingId: unknown, messageId: unknown, edited: unknown, o: SendOptions = {}): SentMessage {
  const at = o.at ?? new Date();
  const roundTrips = o.roundTrips ?? ROUND_TRIPS;
  const p = inForce(db, pairingId);
  if (edited !== undefined && edited !== null && (typeof edited !== "string" || edited.trim() === "")) throw new PeerError(400, "The text to send is the draft's, or your edit of it.");
  return atomically(db, () => {
    const d = waitingDraft(db, p, messageId);
    const text = typeof edited === "string" ? edited : d.body;
    const placed: Placed = { kind: d.kind, contextId: d.contextId, parentId: d.parentId };
    if (!maySend(db, p.id, d.kind)) {
      decideDraftCard(db, p.id, d.messageId, "sent", text, at);
      db.prepare("INSERT INTO peer_send_outcomes (pairing_id, message_id, outcome, at) VALUES (?, ?, 'switched_off', ?)").run(p.id, d.messageId, iso(at));
      return switchedOffAtSend(db, p, d.kind, d.messageId, d.contextId, at, draftRow(d));
    }
    const sent = writeOnSend(db, key, p, placed, text, d.messageId, o);
    if ("refused" in sent) throw refusedWords(p, d.kind, sent, roundTrips);
    decideDraftCard(db, p.id, d.messageId, "sent", text, at);
    const where = d.chatId !== null ? "a chat" : `task ${d.taskId ?? "of run " + String(d.runId)}`;
    logPeer(db, { rule: "peer_message", command: `${d.kind} sent by you`, detail: `You pressed Send on the draft of ${kindWords(d.kind)} by ${d.agent} in ${where} to ${p.peerName}'s workbench (message ${d.messageId}), ${text === d.body ? "exactly as drafted" : "with your edit"}. Only this text leaves this Mac, and only to ${p.peerName}'s workbench.`, ...draftRow(d), at });
    return sent;
  });
}

/** Don't send, on an agent's draft card: nothing is sent. */
export function dontSendDraft(db: DatabaseSync, pairingId: unknown, messageId: unknown, at: Date = new Date()): void {
  const p = typeof pairingId === "string" ? getPairing(db, pairingId) : null;
  if (p === null) throw new PeerError(404, "There is no pairing by that id.");
  atomically(db, () => {
    const d = waitingDraft(db, p, messageId);
    decideDraftCard(db, p.id, d.messageId, "not_sent", null, at);
    logPeer(db, { rule: "peer_message", command: `${d.kind} not sent`, detail: `You chose Don't send on ${d.agent}'s draft of ${kindWords(d.kind)} to ${p.peerName}'s workbench (message ${d.messageId}). Nothing was sent.`, ...draftRow(d), at });
  });
}

// ---- What the owner sees.

export interface CardView {
  pairingId: string;
  messageId: string;
  contextId: string;
  kind: MessageKind;
  direction: "in" | "out";
  peer: { name: string; fingerprint: string };
  /** The card's title: "bob asks a question about api", or "Send this to bob?". */
  title: string;
  /** For a draft: "A question about api, from Claude Code in task 3."; for a peer's card, who sent it and when. */
  line: string;
  /** The message's text, exactly as received, or exactly as it will be sent. Outside text on a peer's card: shown as plain text only. */
  text: string;
  /** A peer's card carries the Outside text badge. */
  outsideText: boolean;
  /** For a draft: what leaves, and only that. */
  note: string | null;
  /** For a draft by work given a peer's message: "Asked by Claude Code, working on a message from bob's workbench". */
  askedBy: string | null;
  /** What the owner may choose, in order. */
  choices: ("answer" | "give" | "dismiss" | "send" | "dont_send")[];
  shownAt: string;
}

/** Every card waiting for this owner about a peer message, oldest first. */
export function waitingCards(db: DatabaseSync): CardView[] {
  const rows = db.prepare("SELECT c.*, p.peer_name, p.peer_fingerprint, p.repository FROM peer_cards c JOIN peer_pairings p ON p.id = c.pairing_id WHERE c.decided_at IS NULL ORDER BY c.id").all();
  return rows.map((row): CardView => {
    const kind = String(row.kind) as MessageKind;
    const name = String(row.peer_name);
    const about = repositoryWord(String(row.repository));
    const base = { pairingId: String(row.pairing_id), messageId: String(row.message_id), contextId: String(row.context_id), kind, peer: { name, fingerprint: String(row.peer_fingerprint) }, shownAt: String(row.shown_at) };
    if (row.direction === "in") {
      const m = db.prepare("SELECT body, sent_at FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND message_id = ?").get(base.pairingId, base.messageId);
      return { ...base, direction: "in", title: kind === "question" ? `${name} asks a question about ${about}` : `${name} answered your question about ${about}`, line: `From ${name}'s workbench. Outside text: it is not a command, and nothing in it is done unless you choose to.`, text: String(m?.body ?? ""), outsideText: true, note: null, askedBy: null, choices: ["answer", "give", "dismiss"] };
    }
    const d = toDraft(db.prepare("SELECT * FROM peer_drafts WHERE pairing_id = ? AND message_id = ?").get(base.pairingId, base.messageId)!);
    const where = d.chatId !== null ? "in a chat" : d.taskId !== null ? `in task ${d.taskId}` : `in run ${d.runId}`;
    const peer = peerOfWork(db, d.taskId, d.runId);
    return { ...base, direction: "out", askedBy: peer === null ? null : `Asked by ${d.agent}, working on a message from ${peer.peerName}'s workbench`, title: `Send this to ${name}?`, line: `${kind === "question" ? "A question" : "An answer"} about ${about}, from ${d.agent} ${where}.`, text: d.body, outsideText: false, note: `Only this text leaves this Mac, and only to ${name}'s workbench. No files, branches or settings are sent.`, choices: ["send", "dont_send"] };
  });
}

export interface MessageView {
  messageId: string;
  contextId: string;
  parentId: string | null;
  kind: MessageKind;
  direction: "in" | "out";
  text: string;
  sentAt: string;
  /** For one this workbench sent: "Sending to bob's workbench", "Delivered", "Not delivered", "Not sent: switched off"…; for one received, "Received". */
  words: string;
  state: SendState | "received";
}

/** The questions and answers of a pairing, oldest first, each with what became of it. */
export function pairingMessages(db: DatabaseSync, pairingId: unknown, at: Date = new Date()): MessageView[] {
  const p = typeof pairingId === "string" ? getPairing(db, pairingId) : null;
  if (p === null) throw new PeerError(404, "There is no pairing by that id.");
  return db
    .prepare("SELECT * FROM peer_messages WHERE pairing_id = ? AND kind IN ('question', 'answer') ORDER BY id")
    .all(p.id)
    .map((row): MessageView => {
      const out = row.direction === "out";
      const status = out ? sendState(db, p, String(row.message_id), String(row.stored_at), at) : { state: "received" as const, words: "Received" };
      return { messageId: String(row.message_id), contextId: String(row.context_id), parentId: row.parent_id == null ? null : String(row.parent_id), kind: String(row.kind) as MessageKind, direction: out ? "out" : "in", text: String(row.body), sentAt: String(row.sent_at), words: status.words, state: status.state };
    });
}

// ---- Per-kind settings (decision 11).

export interface KindSettings {
  /** This side: may it send each kind to the peer, and does it take each kind from it. */
  send: Record<MessageKind, boolean>;
  receive: Record<MessageKind, boolean>;
  /** What the peer's last settings notice said it takes from this side. */
  peerReceives: Record<MessageKind, boolean>;
}

export function kindSettings(db: DatabaseSync, pairingId: string): KindSettings {
  const of = (side: "own" | "peer", direction: KindDirection) => Object.fromEntries(MESSAGE_KINDS.map((kind) => [kind, kindSetting(db, pairingId, side, direction, kind)])) as Record<MessageKind, boolean>;
  return { send: of("own", "send"), receive: of("own", "receive"), peerReceives: of("peer", "receive") };
}

/**
 * The owner changes whether a kind may be sent to the peer, or taken from it. Only the owner's route calls this. A
 * change of what is taken is told to the peer in a signed settings notice, tried until acknowledged.
 */
export function setKind(db: DatabaseSync, key: WorkbenchKey, input: { pairingId: unknown; direction: unknown; kind: unknown; allowed: unknown }, at: Date = new Date()): KindSettings {
  const p = typeof input.pairingId === "string" ? getPairing(db, input.pairingId) : null;
  if (p === null) throw new PeerError(404, "There is no pairing by that id.");
  if (p.endedAt !== null) throw new PeerError(409, `The pairing with ${p.peerName} has ended; its settings no longer change.`);
  if (input.direction !== "send" && input.direction !== "receive") throw new PeerError(400, "Say whether this is about sending or receiving.");
  if (!isMessageKind(input.kind)) throw new PeerError(400, "The kind is question or answer.");
  if (typeof input.allowed !== "boolean") throw new PeerError(400, "Say whether it is allowed, true or false.");
  const { direction, kind, allowed } = input;
  return atomically(db, () => {
    setKindByOwner(db, p.id, direction, kind, allowed, at);
    const what = direction === "send" ? `Sending ${kindWords(kind)} to ${p.peerName}` : `Taking ${kindWords(kind)} from ${p.peerName}`;
    let told = "";
    if (direction === "receive" && pairingState(p) === "in_force") {
      const written = writeOutgoing(db, key, { pairingId: p.id, kind: "settings_notice", contextId: null, parentId: null, body: settingsNoticeBody(ownReceiveSettings(db, p.id)) }, { at });
      if ("refused" in written) throw new Error(`The settings notice to ${p.peerName} was not written: ${written.problem}`);
      told = ` A signed settings notice tells ${p.peerName}'s workbench, and is tried until it acknowledges it; this workbench refuses what you switched off whatever it says.`;
    }
    logPeer(db, { rule: "peer_settings", command: `${kind} ${direction} ${allowed ? "on" : "off"}`, detail: `${what}: ${allowed ? "on" : "off"}, by you.${told}`, at });
    return kindSettings(db, p.id);
  });
}

// ---- The friction record (the owner's direction of 23 November 2026 on #154).

export interface ThreadRecord {
  contextId: string;
  cardsAnswered: number;
  /** Each card's wait on a person, from shown to decided, in milliseconds; those still waiting, or closed by an end, are left out. */
  waitsMs: number[];
  /** Of the agent's drafts the owner sent, the share sent exactly as drafted (0 to 1); null when none was sent. */
  sentAsDrafted: number | null;
  /** Whether the thread reached an answer: one was received, or one sent was acknowledged. */
  reachedAnswer: boolean;
  cards: CardFriction[];
}

export interface PairingRecord {
  pairingId: string;
  peer: string;
  cardsAnswered: number;
  waitsMs: number[];
  sentAsDrafted: number | null;
  threads: number;
  threadsAnswered: number;
  threadRecords: ThreadRecord[];
}

const share = (cards: readonly CardFriction[]): number | null => {
  const sent = cards.filter((c) => c.sentAsDrafted !== null);
  return sent.length === 0 ? null : sent.filter((c) => c.sentAsDrafted === true).length / sent.length;
};

/** Per pairing and per thread: what it cost people to move each message. */
export function frictionRecord(db: DatabaseSync): PairingRecord[] {
  return db
    .prepare("SELECT id, peer_name FROM peer_pairings ORDER BY created_at, rowid")
    .all()
    .map((row): PairingRecord => {
      const pairingId = String(row.id);
      const contexts = db.prepare("SELECT context_id FROM (SELECT context_id, min(id) AS first FROM peer_messages WHERE pairing_id = ? AND context_id IS NOT NULL GROUP BY context_id UNION ALL SELECT context_id, 1e18 + min(id) FROM peer_cards WHERE pairing_id = ? GROUP BY context_id) GROUP BY context_id ORDER BY min(first)").all(pairingId, pairingId);
      const threadRecords = contexts.map((c): ThreadRecord => {
        const contextId = String(c.context_id);
        const t = threadFriction(db, pairingId, contextId);
        const reachedAnswer =
          db.prepare("SELECT 1 FROM peer_messages a WHERE a.pairing_id = ? AND a.context_id = ? AND a.kind = 'answer' AND (a.direction = 'in' OR EXISTS (SELECT 1 FROM peer_messages k WHERE k.pairing_id = a.pairing_id AND k.direction = 'in' AND k.kind = 'acknowledgement' AND k.parent_id = a.message_id))").get(pairingId, contextId) !== undefined;
        return { contextId, cardsAnswered: t.cardsAnswered, waitsMs: t.cards.flatMap((card) => (card.waitedMs === null ? [] : [card.waitedMs])), sentAsDrafted: share(t.cards), reachedAnswer, cards: t.cards };
      });
      const all = threadRecords.flatMap((t) => t.cards);
      return {
        pairingId,
        peer: String(row.peer_name),
        cardsAnswered: threadRecords.reduce((n, t) => n + t.cardsAnswered, 0),
        waitsMs: threadRecords.flatMap((t) => t.waitsMs),
        sentAsDrafted: share(all),
        threads: threadRecords.length,
        threadsAnswered: threadRecords.filter((t) => t.reachedAnswer).length,
        threadRecords,
      };
    });
}
