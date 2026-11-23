import type { PairingFriction, PeerCard, PeerMessage, ThreadFriction } from "../api/client.ts";

/*
 * The words and the order of things on the paired-workbench screens (Peers P5): a thread's messages with their state,
 * the friction numbers, and the invite's expiry. Pure, so the tests read them without a browser. Everything the other
 * workbench wrote is passed through as it is: the screens show it as plain text.
 */

/** A length of time as a person says it: "less than a minute", "1 minute", "12 minutes", "3 hours", "2 days". */
export function spanWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 1) return "less than a minute";
  if (minutes < 120) return unit(minutes, "minute");
  if (minutes < 48 * 60) return unit(Math.floor(minutes / 60), "hour");
  return unit(Math.floor(minutes / (24 * 60)), "day");
}

/** A clock time in this device's own time, "14:32". */
export const clockOf = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** What an open invite says about its life: "It works once, until 14:32." or, once past, that it has expired. */
export function inviteLife(expiresAt: string, now: number = Date.now()): { open: boolean; words: string } {
  if (Date.parse(expiresAt) <= now) return { open: false, words: "This invite has expired and can no longer be used. Make a new invite to pair." };
  return { open: true, words: `It works once, until ${clockOf(expiresAt)}. Withdraw it if you passed it to the wrong person.` };
}

/** One row of a thread: a message that was sent or received, or a draft that waits for the owner's Send. */
export interface ThreadRow {
  key: string;
  /** Who wrote it, as the row's label: "You", "Claude Code (your draft)" or the other workbench's name. */
  who: "you" | "draft" | "peer";
  kind: "question" | "answer";
  text: string;
  /** Its state in words: "Waiting for your Send", "Delivered", "Received" … as the server words them. */
  state: string;
  messageId: string;
}

export interface Thread {
  contextId: string;
  rows: ThreadRow[];
  /** The first message's text, for the thread's name in a list. */
  first: string;
  /** Whether a peer's card of this thread waits for the owner, or a draft waits for the Send. */
  waiting: boolean;
}

/**
 * The pairing's threads, the one with the newest message first, each with its messages oldest first and, at its end,
 * every agent's draft of that thread that waits for the owner's Send (a draft is not a message until it is sent).
 */
export function threadsOf(messages: readonly PeerMessage[], cards: readonly PeerCard[], pairingId: string): Thread[] {
  const byContext = new Map<string, { rows: ThreadRow[]; last: number }>();
  const at = (contextId: string) => {
    let t = byContext.get(contextId);
    if (t === undefined) byContext.set(contextId, (t = { rows: [], last: 0 }));
    return t;
  };
  messages.forEach((m, i) => {
    const t = at(m.contextId);
    t.rows.push({ key: `m ${m.direction} ${m.messageId}`, who: m.direction === "out" ? "you" : "peer", kind: m.kind, text: m.text, state: m.words, messageId: m.messageId });
    t.last = i + 1;
  });
  const mine = cards.filter((c) => c.pairingId === pairingId);
  for (const c of mine.filter((c) => c.direction === "out")) {
    at(c.contextId).rows.push({ key: `d ${c.messageId}`, who: "draft", kind: c.kind, text: c.text, state: "Waiting for your Send", messageId: c.messageId });
  }
  const waiting = new Set(mine.map((c) => c.contextId));
  return [...byContext.entries()]
    .sort(([, a], [, b]) => b.last - a.last)
    .map(([contextId, t]) => ({ contextId, rows: t.rows, first: t.rows[0]?.text ?? "", waiting: waiting.has(contextId) }));
}

/** The middle value of a list of waits, or null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The friction numbers of a pairing or one thread, in three short lines. */
export interface FrictionWords {
  answered: string;
  waited: string;
  asDrafted: string;
}

/** A pairing's or a thread's friction record (`GET /api/peers/friction`), as three plain lines with real counts. */
export function frictionWords(record: Pick<PairingFriction | ThreadFriction, "cardsAnswered" | "waitsMs"> & { cards: readonly { sentAsDrafted: boolean | null }[] }): FrictionWords {
  const n = record.cardsAnswered;
  const answered = n === 0 ? "No card answered yet." : `${n} ${n === 1 ? "card" : "cards"} answered by you.`;
  const mid = median(record.waitsMs);
  const longest = record.waitsMs.length === 0 ? null : Math.max(...record.waitsMs);
  const waited = mid === null ? "No wait to count yet." : record.waitsMs.length === 1 ? `It waited ${spanWords(mid)} for you.` : `They waited ${spanWords(mid)} for you in the middle, ${spanWords(longest!)} at most.`;
  const sent = record.cards.filter((c) => c.sentAsDrafted !== null);
  const exact = sent.filter((c) => c.sentAsDrafted === true).length;
  const asDrafted = sent.length === 0 ? "No draft by an agent sent yet." : `${exact} of ${sent.length} ${sent.length === 1 ? "draft" : "drafts"} sent exactly as drafted.`;
  return { answered, waited, asDrafted };
}

/** A pairing's record, with every card of its threads, for `frictionWords`. */
export const pairingCards = (p: PairingFriction): { sentAsDrafted: boolean | null }[] => p.threadRecords.flatMap((t) => t.cards);

/** Where the thread view of one thread is. */
export const threadHref = (pairingId: string, contextId: string): string => `#/paired/${pairingId}/threads/${contextId}`;
