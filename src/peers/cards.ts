import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isId, isMessageKind, type MessageKind } from "./envelope.ts";
import { getPairing, maySend, pairingState } from "./pairings.ts";

/*
 * The friction record (the owner's direction of 23 November 2026 on #154, `docs/product/peers-autonomy-tradeoff.md`):
 * what it cost people to move each message of a thread. One row per card a person is shown about a peer message:
 * an incoming message's card (Answer it yourself, Give it to Claude Code, Dismiss) or an agent's outgoing draft
 * (Send, Don't send). Each row keeps when it was drafted (an outgoing draft), shown and decided, and for an outgoing
 * draft the SHA-256 of the text drafted and of the text sent, so the record can say whether it went exactly as drafted.
 * A card closed because its pairing ended was decided by nobody and is not counted as answered.
 *
 * This is the store and one query. No screen shows it, and no card is raised by anything yet: the units that put
 * these cards in front of the owner write them.
 */

export type IncomingDecision = "answered" | "given_to_agent" | "dismissed";
export type OutgoingDecision = "sent" | "not_sent";

const iso = (at: Date): string => at.toISOString();
export const textDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface CardFor {
  pairingId: string;
  messageId: string;
  contextId: string;
  kind: MessageKind;
}

/** The card for a message the peer sent, shown to the owner now. */
export function showIncomingCard(db: DatabaseSync, c: CardFor, at: Date = new Date()): void {
  check(c);
  const stored = db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND direction = 'in' AND message_id = ? AND context_id = ? AND kind = ?").get(c.pairingId, c.messageId, c.contextId, c.kind);
  if (stored === undefined) throw new Error(`There is no stored ${c.kind} ${c.messageId} from the peer to show a card for.`);
  db.prepare("INSERT INTO peer_cards (pairing_id, direction, message_id, context_id, kind, shown_at) VALUES (?, 'in', ?, ?, ?, ?)").run(c.pairingId, c.messageId, c.contextId, c.kind, iso(at));
}

/** The card for an agent's draft to the peer: when the agent drafted it, the text it drafted, and when it was shown. */
export function showDraftCard(db: DatabaseSync, c: CardFor & { draft: string; draftedAt: Date }, at: Date = new Date()): void {
  check(c);
  // Decision 11: the sending end checks its own send setting and the peer's last receive settings before making a card.
  const p = getPairing(db, c.pairingId);
  if (p === null || pairingState(p) !== "in_force") throw new Error(`No card is raised for pairing ${c.pairingId}: it is not in force.`);
  if (!maySend(db, c.pairingId, c.kind)) throw new Error(`No card is raised: a ${c.kind} to ${p.peerName} is switched off.`);
  db.prepare("INSERT INTO peer_cards (pairing_id, direction, message_id, context_id, kind, drafted_at, draft_digest, shown_at) VALUES (?, 'out', ?, ?, ?, ?, ?, ?)").run(c.pairingId, c.messageId, c.contextId, c.kind, iso(c.draftedAt), textDigest(c.draft), iso(at));
}

/** The owner's decision on an incoming message's card. */
export function decideIncomingCard(db: DatabaseSync, pairingId: string, messageId: string, decision: IncomingDecision, at: Date = new Date()): void {
  decide(db, pairingId, "in", messageId, decision, null, at);
}

/** The owner's decision on a draft's card; for Send, the text that was sent. */
export function decideDraftCard(db: DatabaseSync, pairingId: string, messageId: string, decision: OutgoingDecision, sentText: string | null, at: Date = new Date()): void {
  if ((decision === "sent") !== (sentText !== null)) throw new Error("A sent card names the text that was sent, and only a sent card does.");
  decide(db, pairingId, "out", messageId, decision, sentText === null ? null : textDigest(sentText), at);
}

function decide(db: DatabaseSync, pairingId: string, direction: "in" | "out", messageId: string, decision: string, sentDigest: string | null, at: Date): void {
  const changed = db.prepare("UPDATE peer_cards SET decided_at = ?, decision = ?, sent_digest = ? WHERE pairing_id = ? AND direction = ? AND message_id = ? AND decided_at IS NULL").run(iso(at), decision, sentDigest, pairingId, direction, messageId).changes;
  if (Number(changed) !== 1) throw new Error(`There is no waiting card for message ${messageId}: it was decided already, or never shown.`);
}

function check(c: CardFor): void {
  if (!isId(c.pairingId) || !isId(c.messageId) || !isId(c.contextId) || !isMessageKind(c.kind)) throw new Error("A card names a pairing, a message and a thread by their ids, and a question or an answer.");
}

export interface CardFriction {
  messageId: string;
  direction: "in" | "out";
  kind: string;
  decision: string | null;
  /** From shown to decided, in milliseconds; null while it waits, and for a card its pairing's end closed. */
  waitedMs: number | null;
  /** An outgoing draft: whether the text sent is exactly the text drafted; null when not sent, and on an incoming card. */
  sentAsDrafted: boolean | null;
}

export interface ThreadFriction {
  /** Cards a person decided: every decided card but those closed by the pairing's end. */
  cardsAnswered: number;
  cards: CardFriction[];
}

/** The friction record of one thread: each card, how long it waited on a person, and whether a draft went as drafted. */
export function threadFriction(db: DatabaseSync, pairingId: string, contextId: string): ThreadFriction {
  const rows = db.prepare("SELECT * FROM peer_cards WHERE pairing_id = ? AND context_id = ? ORDER BY id").all(pairingId, contextId);
  const cards = rows.map((row): CardFriction => {
    const decision = row.decision == null ? null : String(row.decision);
    const byPerson = decision !== null && decision !== "closed_by_end";
    return {
      messageId: String(row.message_id),
      direction: row.direction === "in" ? "in" : "out",
      kind: String(row.kind),
      decision,
      waitedMs: byPerson ? Date.parse(String(row.decided_at)) - Date.parse(String(row.shown_at)) : null,
      // Sent means the owner pressed Send; a message whose kind was switched off by then never left, so it is no draft "sent as drafted".
      sentAsDrafted: decision === "sent" && db.prepare("SELECT 1 FROM peer_messages WHERE pairing_id = ? AND direction = 'out' AND message_id = ?").get(pairingId, String(row.message_id)) !== undefined ? row.sent_digest === row.draft_digest : null,
    };
  });
  return { cardsAnswered: cards.filter((c) => c.decision !== null && c.decision !== "closed_by_end").length, cards };
}
