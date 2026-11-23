import { createHash, randomUUID } from "node:crypto";
import { publicKeyProblem, verifySignature, type WorkbenchKey } from "./key.ts";

/*
 * The envelope (Peers P5, ADR 0004 decisions 2, 6 and 7): everything one workbench sends another, signed whole. The
 * signature is over one fixed byte form of every field (`envelopeBytes`) and over nothing else, and that byte form is
 * also what is checked: a receiver rebuilds it from the fields it read, so no field can be read that was not signed.
 *
 * The byte form is a fixed prefix and then each field in a fixed order, each written as one tag byte (0 absent, 1
 * present) and, when present, a 4-byte big-endian length and the field's UTF-8 bytes. A field cannot run into the next,
 * an absent field is never the same as an empty one, and two different envelopes never give the same bytes.
 *
 * Field names follow A2A's message where it has one (`messageId`; `contextId` for the thread), as the owner asked on
 * #154, so another product could be met later without renaming what is signed. The repository is the scope of a
 * pairing and of every message on it (decision 5): a repository by its delivery remote today, the one field that
 * names a repository.
 *
 * Kinds in the first slice: question and answer (decision 13), plus the five fixed-shape protocol kinds that leave
 * without the owner's Send (decision 9) and carry no text from the owner, an agent or a repository.
 */

/** The kinds that carry a person's or an agent's text, in the first slice. The other six of decision 6 follow later. */
export const MESSAGE_KINDS = ["question", "answer"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
/** The fixed-shape kinds. A response (acknowledgement, refusal) answers one message and has no place in the sequence. */
export const PROTOCOL_KINDS = ["acknowledgement", "refusal", "settings_notice", "end_notice", "pair_confirmation"] as const;
export type ProtocolKind = (typeof PROTOCOL_KINDS)[number];
export type EnvelopeKind = MessageKind | ProtocolKind;
export const isMessageKind = (kind: unknown): kind is MessageKind => (MESSAGE_KINDS as readonly unknown[]).includes(kind);
export const isResponseKind = (kind: unknown): boolean => kind === "acknowledgement" || kind === "refusal";

/**
 * Botbench's fixed reason codes, the only body a refusal may have. `pairing_ended` is ADR 0004's; the others name the
 * rule a message broke, in the order the receiving end checks them.
 */
export const REFUSAL_REASONS = [
  "pairing_ended",
  "not_confirmed",
  "wrong_repository",
  "message_conflict",
  "wrong_shape",
  "wrong_parent",
  "sequence_reused",
  "kind_switched_off",
  "thread_full",
  "too_many_messages",
  "too_many_cards",
  // The receiving end does not take this kind on the route it came by, or not yet at all (a question or an answer
  // before anything can show it).
  "kind_not_taken",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** The most characters (Unicode code points, as SQLite counts them) a message's body may have. */
export const MAX_BODY = 8000;

export interface Envelope {
  pairingId: string;
  kind: EnvelopeKind;
  /** Chosen by the sender, unique per pairing. */
  messageId: string;
  /** The thread. Null on a protocol kind. */
  contextId: string | null;
  /** The message this one answers or follows; for a response, the message it responds to. */
  parentId: string | null;
  /** The scope: the pairing's repository, by its delivery remote. */
  repository: string;
  senderKey: string;
  recipientKey: string;
  /** This sender's number for it on this pairing, from 1. 0 on a response, which is matched by its parent instead. */
  sequence: number;
  /** When the sender made it (ISO 8601, UTC). Shown, never used to order. */
  time: string;
  body: string;
}

/** An envelope and its signature as they travel: the signature is base64url. */
export interface SignedEnvelope {
  envelope: Envelope;
  signature: string;
}

/** Whether `text` has no lone surrogate, so it has exactly one UTF-8 form. */
export const wellFormed = (text: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

const PREFIX = Buffer.from("botbench peer envelope 1\n", "utf8");
const FIELDS = ["pairingId", "kind", "messageId", "contextId", "parentId", "repository", "senderKey", "recipientKey", "sequence", "time", "body"] as const;

/**
 * A fixed prefix and then each value in order, as one tag byte (0 absent, 1 present) and, when present, a 4-byte
 * big-endian length and the value's UTF-8 bytes: the one byte form of everything Botbench signs or MACs for a peer.
 */
export function lengthPrefixed(prefix: Buffer, values: readonly (string | null)[], names: readonly string[] = []): Buffer {
  const parts: Buffer[] = [prefix];
  for (const [i, value] of values.entries()) {
    if (value === null) {
      parts.push(Buffer.from([0]));
      continue;
    }
    if (!wellFormed(value)) throw new Error(`The ${names[i] ?? `field ${i + 1}`} is not well-formed text, so it has no one byte form.`);
    const bytes = Buffer.from(value, "utf8");
    const head = Buffer.alloc(5);
    head[0] = 1;
    head.writeUInt32BE(bytes.length, 1);
    parts.push(head, bytes);
  }
  return Buffer.concat(parts);
}

/** The one byte form of an envelope that is signed and checked. */
export function envelopeBytes(e: Envelope): Buffer {
  return lengthPrefixed(PREFIX, FIELDS.map((field) => (typeof e[field] === "number" ? String(e[field]) : (e[field] as string | null))), FIELDS.map((field) => `envelope's ${field}`));
}

/** The SHA-256 of an envelope's byte form, hex: what tells a replay (same bytes) from a conflict (same id, other bytes). */
export const envelopeDigest = (e: Envelope): string => createHash("sha256").update(envelopeBytes(e)).digest("hex");

/**
 * The envelope `value` holds when each field has the right type (text, null where allowed, a whole number), or null.
 * Nothing in it is checked beyond its type: that comes after the signature.
 */
export function asEnvelope(value: unknown): Envelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(v, field))) return null;
  const text = (field: string): boolean => typeof v[field] === "string";
  const maybe = (field: string): boolean => v[field] === null || typeof v[field] === "string";
  if (!["pairingId", "kind", "messageId", "repository", "senderKey", "recipientKey", "time", "body"].every(text)) return null;
  if (!maybe("contextId") || !maybe("parentId") || !Number.isSafeInteger(v.sequence)) return null;
  // A lone surrogate would be written as U+FFFD, so two different strings would give one byte form.
  if (FIELDS.some((field) => typeof v[field] === "string" && !wellFormed(v[field] as string))) return null;
  return {
    pairingId: v.pairingId as string,
    kind: v.kind as EnvelopeKind,
    messageId: v.messageId as string,
    contextId: v.contextId as string | null,
    parentId: v.parentId as string | null,
    repository: v.repository as string,
    senderKey: v.senderKey as string,
    recipientKey: v.recipientKey as string,
    sequence: v.sequence as number,
    time: v.time as string,
    body: v.body as string,
  };
}

/** A random id for a pairing, a message or a thread. */
export const newId = (): string => randomUUID();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** Why `repository` cannot name a pairing's scope, or null: one line of 1 to 500 characters, with no control character. */
export function repositoryProblem(repository: unknown): string | null {
  return typeof repository === "string" && repository.length >= 1 && repository.length <= 500 && repository === repository.trim() && !/[\0-\x1f\x7f]/.test(repository)
    ? null
    : "A pairing's repository is its delivery remote, as one line of 1 to 500 characters, such as github.com/jon-lange/botbench.";
}

const codePoints = (text: string): number => [...text].length;
const isTime = (value: string): boolean => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

/** A settings notice's body: each first-slice kind and whether this side receives it, in a fixed order. */
export function settingsNoticeBody(receive: Readonly<Record<MessageKind, boolean>>): string {
  return MESSAGE_KINDS.map((kind) => `${kind}:${receive[kind] ? "on" : "off"}`).join(",");
}
/** The receive settings a settings notice's body holds, or null when it is not exactly in that form. */
export function parseSettingsNotice(body: string): Record<MessageKind, boolean> | null {
  const parts = body.split(",");
  if (parts.length !== MESSAGE_KINDS.length) return null;
  const out = {} as Record<MessageKind, boolean>;
  for (const [i, kind] of MESSAGE_KINDS.entries()) {
    if (parts[i] === `${kind}:on`) out[kind] = true;
    else if (parts[i] === `${kind}:off`) out[kind] = false;
    else return null;
  }
  return out;
}

/**
 * Why `e` does not have its kind's fixed shape, as a sentence, or null. This is the shape alone; whether a parent is a
 * stored question of the same thread is the store's to say (src/peers/messages.ts).
 */
export function envelopeProblem(e: Envelope): string | null {
  if (!isId(e.pairingId)) return "The pairing id is not an id Botbench makes.";
  if (!isId(e.messageId)) return "The message id is not an id Botbench makes.";
  if (publicKeyProblem(e.senderKey) !== null || publicKeyProblem(e.recipientKey) !== null) return "A sender or recipient key is not a workbench key.";
  if (e.senderKey === e.recipientKey) return "The sender and the recipient are the same key.";
  const scope = repositoryProblem(e.repository);
  if (scope !== null) return scope;
  if (!isTime(e.time)) return "The time is not an ISO 8601 time in UTC.";
  if (isMessageKind(e.kind)) {
    if (!isId(e.contextId)) return `A ${e.kind} needs a thread.`;
    if (e.sequence < 1) return `A ${e.kind} needs a sequence number from 1.`;
    if (e.body.trim() === "") return `A ${e.kind} needs some text.`;
    if (codePoints(e.body) > MAX_BODY) return `A ${e.kind} is at most ${MAX_BODY.toLocaleString("en-US")} characters; this one has ${codePoints(e.body).toLocaleString("en-US")}.`;
    if (e.kind === "answer" && !isId(e.parentId)) return "An answer needs the question it answers as its parent.";
    if (e.parentId !== null && !isId(e.parentId)) return "The parent is not a message id.";
    return null;
  }
  if (!(PROTOCOL_KINDS as readonly string[]).includes(e.kind)) return `Botbench does not take messages of the kind ${JSON.stringify(e.kind).slice(0, 60)}.`;
  if (e.contextId !== null) return `A ${e.kind} belongs to no thread.`;
  if (isResponseKind(e.kind)) {
    if (e.sequence !== 0) return `A ${e.kind} takes no sequence number (0).`;
    if (!isId(e.parentId)) return `A ${e.kind} names the message it answers as its parent.`;
  } else {
    if (e.sequence < 1) return `A ${e.kind} needs a sequence number from 1.`;
    if (e.parentId !== null) return `A ${e.kind} has no parent.`;
  }
  // No free text in a protocol kind: an empty body, a reason code, or the settings in their one form.
  if (e.kind === "refusal") return (REFUSAL_REASONS as readonly string[]).includes(e.body) ? null : "A refusal's body is one of Botbench's reason codes.";
  if (e.kind === "settings_notice") return parseSettingsNotice(e.body) === null ? "A settings notice's body lists each kind with on or off, in Botbench's order." : null;
  return e.body === "" ? null : `A ${e.kind} carries no text.`;
}

/** Sign `e` with this workbench's key. Refuses an envelope that is not in its kind's shape, or that this key did not send. */
export function signEnvelope(e: Envelope, key: WorkbenchKey): SignedEnvelope {
  const problem = envelopeProblem(e);
  if (problem !== null) throw new Error(`Botbench did not sign this ${e.kind}: ${problem}`);
  if (e.senderKey !== key.publicKey) throw new Error(`Botbench did not sign this ${e.kind}: it names another sender than this workbench.`);
  return { envelope: e, signature: key.sign(envelopeBytes(e)).toString("base64url") };
}

/** Whether `signature` is `publicKey`'s signature of exactly this envelope, sent by that key. */
export function verifyEnvelope(e: Envelope, signature: unknown, publicKey: string): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, "base64url").toString("base64url") !== signature || e.senderKey !== publicKey) return false;
  if (FIELDS.some((field) => typeof e[field] === "string" && !wellFormed(e[field] as string))) return false;
  return verifySignature(publicKey, envelopeBytes(e), Buffer.from(signature, "base64url"));
}
