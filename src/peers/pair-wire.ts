import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isWorkbench } from "../workbench.ts";
import { splitHostPort } from "./address.ts";
import { isId, lengthPrefixed, repositoryProblem, wellFormed } from "./envelope.ts";
import { publicKeyProblem, verifySignature, type WorkbenchKey } from "./key.ts";

/*
 * Pairing on the wire (Peers P5, ADR 0004 decision 3): the invite an owner passes on, the pair request the joining
 * side sends, and the answer the inviter signs. Each has one byte form, built as the envelope's is (a fixed prefix and
 * every field tagged and length-prefixed, `lengthPrefixed`), so no two different requests or answers give the same
 * bytes and no field can run into the next.
 *
 * The pair request is proved by an HMAC-SHA256 of its byte form made with the invite's 32-byte secret, so the secret
 * never crosses the network; the inviter recomputes it and compares in constant time. The answer is signed with the
 * inviter's Ed25519 key; the joining side checks the signature with the key the answer names, then that key's
 * fingerprint against the invite's (src/peers/pairings.ts, `joinPairing`), so a listener answering in the inviter's
 * place is refused.
 */

/** What an owner copies and passes on, outside Botbench: one line of letters, digits, "-", "_" and ".". */
export const INVITE_PREFIX = "botbench-invite-1.";
const MAX_INVITE_TEXT = 2000;

export interface Invite {
  id: string;
  /** The inviting workbench's name, a label only. */
  name: string;
  /** The inviting workbench's key fingerprint, which its answer must match. */
  fingerprint: string;
  /** The inviter's peer listener: "127.0.0.1:4790". */
  address: string;
  /** The repository the pairing will cover, by its delivery remote. */
  repository: string;
  expiresAt: string;
  /** The 32-byte one-time secret. */
  secret: Buffer;
}

const FINGERPRINT = /^[0-9a-f]{4}( [0-9a-f]{4}){4}$/;
const INVITE_FIELDS = ["v", "id", "name", "fingerprint", "address", "repository", "expiresAt", "secret"] as const;
const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isBase64url = (value: unknown, bytes: number): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === bytes && Buffer.from(value, "base64url").toString("base64url") === value;

/** The invite as the one line an owner copies. It holds the secret: it is shown once to the owner and never logged. */
export function inviteText(invite: Invite): string {
  const fields = { v: 1, id: invite.id, name: invite.name, fingerprint: invite.fingerprint, address: invite.address, repository: invite.repository, expiresAt: invite.expiresAt, secret: invite.secret.toString("base64url") };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

export const INVITE_UNREADABLE = "This is not a Botbench invite, or part of it is missing. Copy the whole invite again, in one piece, and paste it.";

/** The invite `text` holds, or why it holds none. The sentence never repeats what was pasted. */
export function readInvite(text: unknown): Invite | { problem: string } {
  if (typeof text !== "string") return { problem: INVITE_UNREADABLE };
  const line = text.trim();
  if (line.length > MAX_INVITE_TEXT || !line.startsWith(INVITE_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(line.slice(INVITE_PREFIX.length))) return { problem: INVITE_UNREADABLE };
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(line.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return { problem: INVITE_UNREADABLE };
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return { problem: INVITE_UNREADABLE };
  const f = fields as Record<string, unknown>;
  if (Object.keys(f).length !== INVITE_FIELDS.length || !INVITE_FIELDS.every((k) => Object.hasOwn(f, k)) || f.v !== 1) return { problem: INVITE_UNREADABLE };
  if (!isId(f.id) || typeof f.name !== "string" || !isWorkbench(f.name) || typeof f.fingerprint !== "string" || !FINGERPRINT.test(f.fingerprint)) return { problem: INVITE_UNREADABLE };
  if (splitHostPort(f.address) === null) return { problem: "The invite names an address that is not loopback or private, so Botbench does not send anything to it. Ask for a new invite from a workbench whose peer listener is on a private network." };
  if (typeof f.repository !== "string" || repositoryProblem(f.repository) !== null || !isTime(f.expiresAt) || !isBase64url(f.secret, 32)) return { problem: INVITE_UNREADABLE };
  return { id: f.id, name: f.name, fingerprint: f.fingerprint, address: f.address as string, repository: f.repository, expiresAt: f.expiresAt, secret: Buffer.from(f.secret, "base64url") };
}

/** A pair request's fields, as they travel and as they are proved. */
export interface PairRequestFields {
  inviteId: string;
  /** The joiner's random retry key: 64 hex digits. */
  pairingKey: string;
  /** The joiner's public key. */
  key: string;
  name: string;
  /** The joiner's peer listener, where the inviter's confirmation will go. */
  address: string;
  /** The repository the joiner's owner saw in the invite. */
  repository: string;
}
export interface WirePairRequest extends PairRequestFields {
  /** HMAC-SHA256 of `pairRequestBytes`, made with the invite's secret: base64url, 43 characters. */
  hmac: string;
}

const REQUEST_PREFIX = Buffer.from("botbench pair request 1\n", "utf8");
const REQUEST_FIELDS = ["inviteId", "pairingKey", "key", "name", "address", "repository"] as const;

/** The one byte form of a pair request that its HMAC covers. */
export const pairRequestBytes = (r: PairRequestFields): Buffer => lengthPrefixed(REQUEST_PREFIX, REQUEST_FIELDS.map((f) => r[f]), REQUEST_FIELDS.map((f) => `pair request's ${f}`));

export const pairRequestHmac = (r: PairRequestFields, secret: Buffer): Buffer => createHmac("sha256", secret).update(pairRequestBytes(r)).digest();

/** The request proved with the invite's secret, ready to send. */
export const proveRequest = (r: PairRequestFields, secret: Buffer): WirePairRequest => ({ ...r, hmac: pairRequestHmac(r, secret).toString("base64url") });

/** Whether `request.hmac` was made with `secret` over the request's fields, compared in constant time. */
export function hmacMatches(request: WirePairRequest, secret: Buffer): boolean {
  const given = Buffer.from(request.hmac, "base64url");
  const expected = pairRequestHmac(request, secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The digest a pair request is kept by on the inviter's side: SHA-256 of its byte form and its HMAC, so a retry with
 * the same key and content is known as the request that was checked, after the secret that checked it is gone.
 */
export const wireRequestDigest = (request: WirePairRequest): string => createHash("sha256").update(pairRequestBytes(request)).update(Buffer.from(request.hmac, "base64url")).digest("hex");

/** The pair request `value` holds when every field has its exact form, or null. */
export function asPairRequest(value: unknown): WirePairRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const fields = [...REQUEST_FIELDS, "hmac"];
  if (Object.keys(v).length !== fields.length || !fields.every((k) => typeof v[k] === "string" && wellFormed(v[k] as string))) return null;
  if (!isId(v.inviteId) || !/^[0-9a-f]{64}$/.test(v.pairingKey as string) || publicKeyProblem(v.key) !== null || !isWorkbench(v.name as string)) return null;
  if (splitHostPort(v.address) === null || repositoryProblem(v.repository) !== null || !isBase64url(v.hmac, 32)) return null;
  return { inviteId: v.inviteId, pairingKey: v.pairingKey as string, key: v.key as string, name: v.name as string, address: v.address as string, repository: v.repository as string, hmac: v.hmac as string };
}

/** The inviter's answer: the new pairing, for this request, by this key. */
export interface PairAnswerFields {
  pairingId: string;
  inviteId: string;
  /** The joiner's pairing key, from its request. */
  pairingKey: string;
  repository: string;
  /** The inviter's public key, which signs the answer. */
  inviterKey: string;
  /** The joiner's public key, from its request. */
  joinerKey: string;
}
export interface SignedPairAnswer {
  answer: PairAnswerFields;
  signature: string;
}

const ANSWER_PREFIX = Buffer.from("botbench pair answer 1\n", "utf8");
const ANSWER_FIELDS = ["pairingId", "inviteId", "pairingKey", "repository", "inviterKey", "joinerKey"] as const;

export const pairAnswerBytes = (a: PairAnswerFields): Buffer => lengthPrefixed(ANSWER_PREFIX, ANSWER_FIELDS.map((f) => a[f]), ANSWER_FIELDS.map((f) => `pair answer's ${f}`));

/** The answer signed with the inviter's key. Ed25519 is deterministic, so the same answer always has the same bytes. */
export function signPairAnswer(a: PairAnswerFields, key: WorkbenchKey): SignedPairAnswer {
  if (a.inviterKey !== key.publicKey) throw new Error("Botbench signs a pair answer only with the key it names.");
  return { answer: { ...a }, signature: key.sign(pairAnswerBytes(a)).toString("base64url") };
}

/**
 * The answer `value` holds when its fields have their exact form and the key it names signed it, or null. It is to
 * this side's own request only when the invite, pairing key, repository and joining key are the ones this side sent;
 * whether the signing key is the invite's is `joinPairing`'s to say.
 */
export function readPairAnswer(value: unknown, sent: WirePairRequest): PairAnswerFields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { answer, signature } = value as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof answer !== "object" || answer === null || Array.isArray(answer) || typeof signature !== "string" || !isBase64url(signature, 64)) return null;
  const a = answer as Record<string, unknown>;
  if (Object.keys(a).length !== ANSWER_FIELDS.length || !ANSWER_FIELDS.every((k) => typeof a[k] === "string" && wellFormed(a[k] as string))) return null;
  const fields = Object.fromEntries(ANSWER_FIELDS.map((k) => [k, a[k] as string])) as unknown as PairAnswerFields;
  if (!isId(fields.pairingId) || publicKeyProblem(fields.inviterKey) !== null) return null;
  if (!verifySignature(fields.inviterKey, pairAnswerBytes(fields), Buffer.from(signature, "base64url"))) return null;
  if (fields.inviteId !== sent.inviteId || fields.pairingKey !== sent.pairingKey || fields.repository !== sent.repository || fields.joinerKey !== sent.key) return null;
  return fields;
}
