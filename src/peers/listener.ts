import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { EnvelopeKind } from "./envelope.ts";
import type { WorkbenchKey } from "./key.ts";
import { logPeer } from "./log.ts";
import { receiveEnvelope, type Received } from "./messages.ts";
import { asPairRequest, hmacMatches, signPairAnswer, wireRequestDigest, type SignedPairAnswer } from "./pair-wire.ts";
import { acceptPairRequest, getPairing, type Pairing } from "./pairings.ts";
import { splitHostPort } from "./address.ts";
import { MAX_PEER_BYTES, PEER_ROUTES, peerPath, type PeerRoute } from "./transport.ts";

/*
 * The peer listener (Peers P5, ADR 0004 decision 1): a second HTTP listener, separate from the owner's API, with four
 * routes (pair, message, settings, end) and nothing else. It never reads a cookie, a login token or any header but the
 * body's type and length, and no owner route is reachable through it: every other method or path is 404. Nothing
 * here reads a file, a task, a transcript or a setting for a caller (decision 5).
 *
 * Every request is a POST of at most 64 KB of JSON, with time limits on the headers and the whole request. Anything
 * unexpected is refused, and nothing a caller sends can throw past a handler. A caller with no pairing, or whose
 * signature is not its pairing's key's, gets one fixed refusal whatever the reason, so it learns nothing about which
 * pairings or invites exist. Requests are bounded per caller address, and pair requests also per invite, so the pair
 * route cannot be used to guess at invites (the HMAC already makes that infeasible).
 *
 * What each route takes: `pair` the pair request; `message` a question, an answer, the pair confirmation, an
 * acknowledgement and a refusal; `settings` the settings notice; `end` the end notice. A kind on another kind's route
 * gets a signed refusal (`kind_not_taken`). A question or an answer the store takes becomes a card for the owner, in
 * the same write (src/peers/messages.ts), and nothing else: the listener never starts, wakes or answers an agent.
 */

/** What each route takes, by kind. One route per kind. */
const ROUTE_KINDS: Record<Exclude<PeerRoute, "pair">, readonly EnvelopeKind[]> = {
  message: ["question", "answer", "pair_confirmation", "acknowledgement", "refusal"],
  settings: ["settings_notice"],
  end: ["end_notice"],
};

/** The one refusal a caller gets when Botbench will not say why: no pairing, a wrong key or HMAC, an unusable invite. */
export const NOT_TAKEN = { error: "This workbench did not take the request.", refused: "not_taken" } as const;
export const TOO_MANY = { error: "Too many requests to this workbench; wait a minute, then try again.", refused: "too_many" } as const;

/** Requests any one caller address may make in a minute, on every route together. */
export const REQUESTS_PER_MINUTE = 120;
/** Pair requests any one caller address may make in a minute. */
export const PAIR_REQUESTS_PER_MINUTE = 20;
/** Pair requests that may name one invite in its whole life; a joining workbench retries a few times at most. */
export const PAIR_REQUESTS_PER_INVITE = 10;
/** The most callers or invites counted at once; past it a new one is refused until old windows pass. */
const MAX_COUNTED = 2000;

/** A count per key in fixed windows: `take` is false once `limit` is reached within `windowMs`. */
function counter(limit: number, windowMs: number, now: () => number) {
  const counts = new Map<string, { since: number; n: number }>();
  return (key: string): boolean => {
    const at = now();
    let entry = counts.get(key);
    if (entry !== undefined && at - entry.since >= windowMs) entry = undefined;
    if (entry === undefined) {
      if (counts.size >= MAX_COUNTED) for (const [k, v] of counts) if (at - v.since >= windowMs) counts.delete(k);
      // Deny on failure: with every slot still in its window, a new caller is refused rather than let past the count.
      if (counts.size >= MAX_COUNTED) return false;
      entry = { since: at, n: 0 };
      counts.set(key, entry);
    }
    entry.n += 1;
    return entry.n <= limit;
  };
}

export interface PeerListenerOptions {
  db: DatabaseSync;
  /** This workbench's key, or null while it has none (no pairing can exist then). */
  key: () => WorkbenchKey | null;
  /** A peer's envelope was stored: what follows from it (a settings notice after a confirmation) is the caller's. */
  onStored?: (pairing: Pairing, kind: EnvelopeKind) => void;
  /** `peers.roundTripsPerThread`: 3 when absent. */
  roundTrips?: number;
  now?: () => number;
}

const send = (res: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
};

class Refused extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super("refused");
    this.status = status;
    this.body = body;
  }
}

/** The body of a request as JSON, at most 64 KB, refused before it is parsed when larger. */
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_PEER_BYTES) throw new Refused(413, { error: "A request to this workbench is at most 64 KB.", refused: "too_large" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PEER_BYTES) throw new Refused(413, { error: "A request to this workbench is at most 64 KB.", refused: "too_large" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Refused(400, { error: "The request is not JSON.", refused: "unreadable" });
  }
}

/** The peer listener's request handler. `listen` puts it on the owner's address. */
export function createPeerHandler(o: PeerListenerOptions): http.RequestListener {
  const now = o.now ?? Date.now;
  const perCaller = counter(REQUESTS_PER_MINUTE, 60_000, now);
  const pairPerCaller = counter(PAIR_REQUESTS_PER_MINUTE, 60_000, now);
  const pairPerInvite = counter(PAIR_REQUESTS_PER_INVITE, 24 * 3600_000, now);
  const refusedSince = new Map<string, { last: number; count: number }>();

  /** A refused request, in the action log at most once a minute per pairing or caller, with how many since the last row. */
  const noteRefused = (who: { pairing?: Pairing; source: string }, what: string): void => {
    const key = who.pairing === undefined ? `source ${who.source}` : `pairing ${who.pairing.id}`;
    // Past the most callers counted, every further one shares one entry, so many addresses still write one row a minute.
    const counted = refusedSince.has(key) || refusedSince.size < MAX_COUNTED ? key : "many callers";
    let entry = refusedSince.get(counted);
    if (entry === undefined) {
      entry = { last: 0, count: 0 };
      refusedSince.set(counted, entry);
    }
    entry.count += 1;
    if (now() - entry.last < 60_000) return;
    const count = entry.count;
    entry.last = now();
    entry.count = 0;
    const from = who.pairing === undefined ? `a caller at ${who.source} with no pairing here` : `${who.pairing.peerName}'s workbench`;
    logPeer(o.db, { rule: "peer_refused", command: what, detail: `Refused ${count === 1 ? "a request" : `${count} requests`} from ${from} since the last entry; the last was: ${what}.`, ...(who.pairing === undefined ? {} : { byPeer: who.pairing }) });
  };

  /**
   * A message of a kind this owner switched off for the peer: one row naming the peer and the kind, at most one a
   * minute per pairing and kind (with how many since), so a peer that keeps sending cannot fill the log.
   */
  const kindRefusedSince = new Map<string, { last: number; count: number }>();
  const noteKindRefused = (p: Pairing, kind: string): void => {
    const key = `${p.id} ${kind}`;
    let entry = kindRefusedSince.get(key);
    if (entry === undefined) {
      if (kindRefusedSince.size >= MAX_COUNTED) kindRefusedSince.clear();
      entry = { last: 0, count: 0 };
      kindRefusedSince.set(key, entry);
    }
    entry.count += 1;
    if (now() - entry.last < 60_000) return;
    const count = entry.count;
    entry.last = now();
    entry.count = 0;
    logPeer(o.db, { rule: "peer_kind_refused", command: `${kind} not taken`, detail: `${p.peerName}'s workbench sent ${count === 1 ? `a ${kind}` : `${count} messages of the kind ${kind}`}, which you switched off for it. ${count === 1 ? "It was" : "They were"} refused with a signed reply: no card, and nothing of ${count === 1 ? "its" : "their"} text kept.`, byPeer: p });
  };

  const pair = (body: unknown, source: string): { status: number; body: unknown } => {
    const request = asPairRequest(body);
    const key = o.key();
    if (request === null || key === null) {
      noteRefused({ source }, "a pair request that is not one");
      return { status: 403, body: NOT_TAKEN };
    }
    // Only an invite this workbench made is counted, so random ids cannot use up the count of a real one.
    const invited = o.db.prepare("SELECT repository FROM peer_invites WHERE id = ?").get(request.inviteId);
    if (invited === undefined) {
      noteRefused({ source }, "a pair request this workbench did not take");
      return { status: 403, body: NOT_TAKEN };
    }
    if (!pairPerInvite(request.inviteId)) {
      noteRefused({ source }, `pair request number ${PAIR_REQUESTS_PER_INVITE + 1} or more for one invite`);
      return { status: 429, body: TOO_MANY };
    }
    // The confirmation will go to the address the request names: only to the address the request came from, so whoever
    // holds an invite cannot point this workbench at another service on the network.
    if (splitHostPort(request.address)?.address !== source.replace(/^::ffff:/, "")) {
      noteRefused({ source }, "a pair request naming another address than the one it came from");
      return { status: 403, body: NOT_TAKEN };
    }
    // The repository the joining owner saw must be the invite's; the HMAC covers it, so only a broken joiner differs.
    const outcome = acceptPairRequest(o.db, key, { inviteId: request.inviteId, pairingKey: request.pairingKey, requestDigest: wireRequestDigest(request), peer: { key: request.key, name: request.name, address: request.address } }, (secret) => hmacMatches(request, secret) && invited.repository === request.repository);
    if ("refused" in outcome) {
      if (outcome.refused === "already_paired") {
        logPeer(o.db, { rule: "peer_pairing", command: "pair request refused", detail: `A pair request from ${request.name} at ${request.address} with a valid invite was refused: this workbench is already paired, and the first version pairs with one workbench at a time. The invite is still open.` });
        return { status: 409, body: { error: "This workbench is already paired with another workbench. Its owner can end that pairing and send a new invite.", refused: "already_paired" } };
      }
      noteRefused({ source }, "a pair request this workbench did not take");
      return { status: 403, body: NOT_TAKEN };
    }
    const p = outcome.pairing;
    // A pairing that has ended is never started again: a replayed request for it gets no answer (a new invite pairs again).
    if (p.endedAt !== null) {
      noteRefused({ source }, "a pair request again for a pairing that has ended");
      return { status: 403, body: NOT_TAKEN };
    }
    const answer: SignedPairAnswer = signPairAnswer({ pairingId: p.id, inviteId: request.inviteId, pairingKey: request.pairingKey, repository: p.repository, inviterKey: key.publicKey, joinerKey: p.peerKey }, key);
    if (outcome.retried) {
      logPeer(o.db, { rule: "peer_protocol", command: "pair answer sent again", detail: `${p.peerName} sent its pair request again with the same pairing key and content; it got the same answer, and no second pairing was made.`, byPeer: p });
    } else {
      logPeer(o.db, { rule: "peer_pairing", command: "pair request accepted", detail: `${p.peerName} at ${p.peerAddress} used the invite ${request.inviteId} to pair on ${p.repository}, with the key fingerprint ${p.peerFingerprint}. The invite is used and its secret erased. The pairing waits for you to compare the fingerprint and confirm.`, byPeer: p });
      logPeer(o.db, { rule: "peer_protocol", command: "pair answer sent", detail: `The signed answer naming pairing ${p.id} went to ${p.peerName}.`, byPeer: p });
    }
    return { status: 200, body: answer };
  };

  const envelope = (route: Exclude<PeerRoute, "pair">, body: unknown, source: string): { status: number; body: unknown } => {
    const key = o.key();
    const wire = typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 2 && "envelope" in body && "signature" in body ? (body as { envelope: unknown; signature: unknown }) : null;
    if (wire === null || key === null) {
      noteRefused({ source }, `a ${route} request that is not a signed envelope`);
      return { status: 403, body: NOT_TAKEN };
    }
    const received: Received = receiveEnvelope(o.db, key, wire, { kinds: ROUTE_KINDS[route], ...(o.roundTrips === undefined ? {} : { roundTrips: o.roundTrips }) });
    if (received.outcome === "refused") {
      const p = received.refusal === null ? null : getPairing(o.db, received.refusal.envelope.pairingId);
      if (received.refusal === null || p === null) {
        noteRefused({ source }, `a ${route} request with no pairing here or not signed by its key`);
        return { status: 403, body: NOT_TAKEN };
      }
      const kind = String(wire.envelope && (wire.envelope as { kind?: unknown }).kind).slice(0, 40);
      // A kind this owner switched off: no card, no body stored, and its own row naming the peer and the kind (decision 11).
      if (received.reason === "kind_switched_off") noteKindRefused(p, kind);
      else noteRefused({ pairing: p, source }, `a ${kind}, answered with a signed refusal (${received.reason})`);
      return { status: 409, body: { response: received.refusal } };
    }
    const p = getPairing(o.db, received.envelope.pairingId)!;
    if (received.outcome === "stored") {
      const e = received.envelope;
      const acked = received.acknowledgement === null ? "" : " Botbench acknowledged it.";
      if (e.kind === "pair_confirmation") logPeer(o.db, { rule: "peer_pairing", command: "confirmed by the peer", detail: `${p.peerName}'s owner confirmed this workbench's fingerprint: the pairing ${p.id} is in force on both sides.${acked}`, byPeer: p });
      else if (e.kind === "end_notice") logPeer(o.db, { rule: "peer_pairing", command: "ended by the peer's notice", detail: `${p.peerName}'s owner ended the pairing ${p.id}. Nothing more is sent to it or taken from it.`, byPeer: p });
      else if (e.kind === "question" || e.kind === "answer") logPeer(o.db, { rule: "peer_message", command: `${e.kind} received`, detail: `${p.peerName}'s workbench sent ${e.kind === "question" ? "a question" : "an answer"} (message ${e.messageId}, thread ${e.contextId}). It is a card for you, with the Outside text badge, and nothing else: no agent sees it unless you give it to one.${acked}`, byPeer: p });
      else if (e.kind === "refusal" && e.body === "pairing_ended") logPeer(o.db, { rule: "peer_pairing", command: "ended by the peer's refusal", detail: `${p.peerName}'s workbench refused a message because it ended the pairing ${p.id}; the refusal is signed with its key, so the pairing has ended here too.`, byPeer: p });
      else logPeer(o.db, { rule: "peer_protocol", command: `${e.kind.replace("_", " ")} received`, detail: `${p.peerName}'s workbench sent a ${e.kind.replace("_", " ")} on pairing ${p.id}.${acked}`, byPeer: p });
      try {
        o.onStored?.(p, e.kind);
      } catch (err) {
        // Stored and acknowledged all the same: what follows is retried from the store or the next start.
        console.error(`After a ${e.kind} from ${p.peerName}'s workbench, the next step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: 200, body: received.acknowledgement === null ? {} : { response: received.acknowledgement } };
  };

  return (req, res) => {
    const source = req.socket.remoteAddress ?? "unknown";
    const handle = async (): Promise<{ status: number; body: unknown }> => {
      const route = PEER_ROUTES.find((r) => peerPath(r) === req.url);
      // Nothing but the four routes: every other method and path, the owner's included, is not here.
      if (req.method !== "POST" || route === undefined) return { status: 404, body: { error: "not found" } };
      if (!perCaller(source)) return { status: 429, body: TOO_MANY };
      if (route === "pair" && !pairPerCaller(source)) return { status: 429, body: TOO_MANY };
      // A browser page cannot use this listener: it sends an Origin, and a JSON body needs a preflight Botbench never answers.
      if (req.headers.origin !== undefined) return { status: 403, body: NOT_TAKEN };
      if ((req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return { status: 415, body: { error: "A request to this workbench is JSON.", refused: "unreadable" } };
      const body = await readBody(req);
      return route === "pair" ? pair(body, source) : envelope(route, body, source);
    };
    handle()
      .catch((err: unknown) => {
        if (err instanceof Refused) return { status: err.status, body: err.body };
        // Deny on failure: what went wrong stays in this process's log. The caller is told to try again, not refused,
        // since what it asked for may already be stored (a pairing made, a message kept) and a retry gets the same answer.
        console.error(`The peer listener could not answer a request: ${err instanceof Error ? err.message : String(err)}`);
        return { status: 503, body: { error: "This workbench could not answer just now; try again.", refused: "try_again" } };
      })
      .then(({ status, body }) => {
        if (res.headersSent) return;
        // A refused body may still be arriving: it is not read further, and the connection is closed after the answer.
        if (!req.complete) res.setHeader("connection", "close");
        send(res, status, body);
      })
      .catch(() => res.destroy());
  };
}

/** A server for the handler, with the listener's limits: small headers, time limits, few connections. */
export function createPeerServer(handler: http.RequestListener): http.Server {
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 2_000, maxHeaderSize: 8 * 1024, connectionsCheckingInterval: 1_000 }, handler);
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}
