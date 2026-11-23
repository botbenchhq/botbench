import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import { checkRepository, TaskError } from "../engine/task.ts";
import { workbenchName } from "../workbench.ts";
import { joinHostPort } from "./address.ts";
import { isMessageKind, newId, settingsNoticeBody, type EnvelopeKind, type MessageKind, type SignedEnvelope } from "./envelope.ts";
import { fingerprintOf, WORKBENCH_KEY_FILE, workbenchKey, type WorkbenchKey } from "./key.ts";
import { createPeerHandler, createPeerServer } from "./listener.ts";
import { logPeer } from "./log.ts";
import { repositoryWord, answerCard, dismissCard, dontSendDraft, frictionRecord, kindSettings, ownerSend, pairingMessages, sendDraft, setKind, stillAllowed, stopSending, waitingCards, type CardView, type KindSettings, type MessageView, type PairingRecord, type SentMessage } from "./conversation.ts";
import { receiveEnvelope, ROUND_TRIPS, toSigned, writeOutgoing } from "./messages.ts";
import { inviteText, proveRequest, readInvite, readPairAnswer, type Invite } from "./pair-wire.ts";
import {
  closeExpiredInvites,
  confirmByOwner,
  createInvite,
  endPairing,
  getPairing,
  INVITE_LIFE_MS,
  joinPairing,
  newPairingKey,
  ownReceiveSettings,
  pairingState,
  withdrawInvite,
  type EndHow,
  type Pairing,
  type PairingState,
} from "./pairings.ts";
import { transaction } from "../store/db.ts";
const atomicIn = (db: DatabaseSync) => <T>(fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));
import type { GivenMessage } from "../engine/task.ts";
import { decideIncomingCard } from "./cards.ts";
import { PeerError } from "./errors.ts";
import { pairingScope } from "./scope.ts";
import { postToPeer, type PeerRoute } from "./transport.ts";

/*
 * Pairing with another workbench, end to end (Peers P5, ADR 0004 decisions 1, 3 and 4): the peer listener, the owner's
 * steps (invite, withdraw, paste, confirm, refuse, end), and the fixed-shape traffic that leaves without a Send
 * (decision 9). The store keeps every rule (src/peers/pairings.ts, messages.ts); this module moves bytes and logs.
 *
 * - Invite (inviter). The invite is one line holding the listener's address, the key fingerprint, the repository, this
 *   workbench's name and the one-time secret. It is returned once to the owner's request and never logged or kept
 *   anywhere but the store's open invite. Expired invites are swept at start, every minute and at the moment each one
 *   expires, so an expired secret does not stay in the store until something else touches invites.
 * - Paste and confirm (joiner). A pasted invite is held in memory only, with a random pairing key, until it expires or
 *   is used; the owner sees the inviter's name, fingerprint and repository before confirming. Confirm sends the pair
 *   request; pressing it again after a failure sends the same request, so a lost answer makes no second pairing. The
 *   answer is accepted only when signed by a key whose fingerprint is the invite's.
 * - The inviter's owner confirms the joiner's fingerprint, and the signed confirmation is retried until acknowledged.
 *   Until the joiner holds it, the joiner reads "Waiting for <name> to confirm" and sends nothing. A refused
 *   fingerprint ends the pairing with a signed end notice instead.
 * - Each side then sends its receive settings in a signed settings notice, retried the same way.
 * - End pairing, from either side, takes effect here at once; the end notice is sent once, without waiting.
 *
 * Outgoing pair confirmations and settings notices are retried with back-off for 24 hours, while the pairing has not
 * ended, from what the store holds, so a restart of either side loses nothing.
 */

export { PeerError } from "./errors.ts";

/** How long an outgoing message is retried before Botbench stops trying (decision 7). */
export { DELIVERY_WINDOW_MS } from "./conversation.ts";
import { DELIVERY_WINDOW_MS } from "./conversation.ts";
const FIRST_RETRY_MS = 1000;
export const MAX_RETRY_MS = 15_000;
/** Pasted invites held at once, waiting for the owner's confirm. */
const MAX_JOINS = 5;
const SWEEP_MS = 60_000;

export interface PairingView {
  id: string;
  state: PairingState;
  /** What the pairing's state says to the owner, in a sentence. */
  words: string;
  /** Whether this workbench made the invite or used it. */
  role: "inviter" | "joiner";
  peer: { name: string; fingerprint: string; address: string };
  ownFingerprint: string;
  repository: string;
  createdAt: string;
  endedAt: string | null;
}

export interface JoinView {
  id: string;
  name: string;
  fingerprint: string;
  repository: string;
  address: string;
  expiresAt: string;
  ownFingerprint: string;
}

export interface PeerLink {
  /** The listener's address and port once listening ("127.0.0.1:4790"); null when the settings leave it off. */
  address(): string | null;
  listen(): Promise<void>;
  close(): Promise<void>;
  makeInvite(repo: unknown): Promise<{ id: string; invite: string; repository: string; expiresAt: string }>;
  withdrawInvite(id: string): void;
  paste(invite: unknown, repo: unknown): Promise<JoinView>;
  confirmJoin(id: string): Promise<PairingView>;
  confirmPairing(id: string): PairingView;
  refusePairing(id: string): PairingView;
  endPairing(id: string): PairingView;
  overview(): { listening: string | null; fingerprint: string | null; pairings: PairingView[]; invites: { id: string; repository: string; expiresAt: string }[] };
  /** The owner's own question or answer, sent as they press Send. */
  send(input: { pairingId: unknown; kind: unknown; text: unknown; parentId?: unknown }): SentMessage;
  /** Answer it yourself, on a peer's card. */
  answerCard(pairingId: unknown, messageId: unknown, text: unknown): SentMessage;
  dismissCard(pairingId: unknown, messageId: unknown): void;
  /** Send or Don't send, on an agent's draft card. */
  sendDraft(pairingId: unknown, messageId: unknown, edited: unknown): SentMessage;
  dontSendDraft(pairingId: unknown, messageId: unknown): void;
  cards(): CardView[];
  messages(pairingId: unknown): MessageView[];
  kinds(pairingId: unknown): KindSettings;
  setKind(input: { pairingId: unknown; direction: unknown; kind: unknown; allowed: unknown }): KindSettings;
  friction(): PairingRecord[];
  /** Give it to Claude Code, first step: check the card and the copy, and say what the task is given. */
  prepareGive(pairingId: unknown, messageId: unknown, repo: unknown, allowHosts: unknown): Promise<{ repo: string; prompt: string; given: GivenMessage }>;
  /** Give it to Claude Code, last step, in the write that stores the task: the card is decided, naming it. Throws (409) when it was decided meanwhile. */
  markGiven(pairingId: unknown, messageId: unknown, taskId: number): void;
}

export interface PeerLinkOptions {
  db: DatabaseSync;
  home: string;
  config: Config;
  /** How long an invite lives; 15 minutes, and never more, unless a test asks for less. */
  inviteLifeMs?: number;
  /** The longest wait between two tries of an outgoing confirmation or notice. */
  maxRetryMs?: number;
}

interface Join {
  invite: Invite;
  repo: string;
  pairingKey: string;
  inFlight?: Promise<PairingView>;
}

const routeOf = (kind: EnvelopeKind): PeerRoute => (kind === "settings_notice" ? "settings" : kind === "end_notice" ? "end" : "message");
const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createPeerLink(o: PeerLinkOptions): PeerLink {
  const { db, home, config } = o;
  const listen = config.peers?.listen;
  const lifeMs = o.inviteLifeMs ?? INVITE_LIFE_MS;
  const maxRetryMs = o.maxRetryMs ?? MAX_RETRY_MS;
  const roundTrips = config.peers?.roundTripsPerThread ?? ROUND_TRIPS;
  const atomic = atomicIn(db);
  let server: http.Server | null = null;
  let bound: string | null = null;
  let key: WorkbenchKey | null = null;
  // The key is made at the first invite or paste (decision 2); until then no pairing exists for it to answer for.
  const ownKey = (): WorkbenchKey => (key ??= workbenchKey(home));
  const keyIfMade = (): WorkbenchKey | null => key ?? (fs.existsSync(path.join(home, WORKBENCH_KEY_FILE)) ? ownKey() : null);
  const joins = new Map<string, Join>();
  const abort = new AbortController();
  const retries = new Map<number, { attempts: number; next: number }>();
  const inFlight = new Set<Promise<unknown>>();
  const expiries = new Set<NodeJS.Timeout>();
  let passing = false;
  let closed = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  };

  const requireListener = (): string => {
    if (bound === null) throw new PeerError(409, 'Pairing needs the listener for paired workbenches. Set "peers": { "listen": { "address": "127.0.0.1", "port": 4790 } } in your settings file, using a loopback or private address, and start Botbench again.');
    return bound;
  };
  const pairingOf = (id: string): Pairing => {
    const p = typeof id === "string" ? getPairing(db, id) : null;
    if (p === null) throw new PeerError(404, "There is no pairing by that id.");
    return p;
  };

  const view = (p: Pairing): PairingView => {
    const state = pairingState(p);
    // The inviter's confirmation: acknowledged, refused, or still on its way.
    const answer = p.role === "joiner" ? "acknowledgement" : (db.prepare("SELECT r.kind, r.body FROM peer_messages c JOIN peer_messages r ON r.pairing_id = c.pairing_id AND r.parent_id = c.message_id AND r.direction = 'in' AND r.kind IN ('acknowledgement', 'refusal') WHERE c.pairing_id = ? AND c.direction = 'out' AND c.kind = 'pair_confirmation'").get(p.id)?.kind ?? null);
    const sentence =
      state === "ended" ? "Ended"
      : state === "waiting_for_peer" ? `Waiting for ${p.peerName} to confirm`
      : state === "waiting_for_owner" ? `${p.peerName} asks to pair. Check that ${p.peerName}'s fingerprint is ${p.peerFingerprint}, then confirm or refuse.`
      : answer === "acknowledgement" ? "Paired"
      : answer === "refusal" ? `${p.peerName}'s workbench did not take your confirmation. End this pairing and send a new invite.`
      : `Paired. Sending your confirmation to ${p.peerName}'s workbench`;
    return { id: p.id, state, words: sentence, role: p.role, peer: { name: p.peerName, fingerprint: p.peerFingerprint, address: p.peerAddress }, ownFingerprint: fingerprintFor(p), repository: p.repository, createdAt: p.createdAt, endedAt: p.endedAt };
  };
  const fingerprintFor = (p: Pairing): string => (key?.publicKey === p.ownKey ? key.fingerprint : ownKey().fingerprint);

  const dropJoin = (id: string): void => {
    const join = joins.get(id);
    if (join === undefined) return;
    join.invite.secret.fill(0);
    joins.delete(id);
  };

  const sweep = (): void => {
    try {
      closeExpiredInvites(db);
    } catch (err) {
      console.error(`Closing expired invites failed: ${words(err)}`);
    }
    for (const [id, join] of joins) if (Date.parse(join.invite.expiresAt) <= Date.now()) dropJoin(id);
  };

  /**
   * Each pairing in force on both sides whose receive settings this side has not sent yet gets its settings notice
   * now (decision 11): the joiner once it holds the confirmation, the inviter once the joiner acknowledged it. Worked
   * out from the store at every pass, so a stop between the two steps loses nothing.
   */
  const sendSettings = (): void => {
    const due = db
      .prepare(
        `SELECT p.id FROM peer_pairings p WHERE p.owner_confirmed_at IS NOT NULL AND p.peer_confirmed_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM peer_pairing_ends e WHERE e.pairing_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM peer_messages m WHERE m.pairing_id = p.id AND m.direction = 'out' AND m.kind = 'settings_notice')
           AND (p.role = 'joiner' OR EXISTS (SELECT 1 FROM peer_messages c JOIN peer_messages r ON r.pairing_id = c.pairing_id AND r.parent_id = c.message_id AND r.direction = 'in' AND r.kind = 'acknowledgement' WHERE c.pairing_id = p.id AND c.direction = 'out' AND c.kind = 'pair_confirmation'))`,
      )
      .all();
    for (const row of due) {
      const p = getPairing(db, String(row.id))!;
      const takes = ownReceiveSettings(db, p.id);
      const written = writeOutgoing(db, ownKey(), { pairingId: p.id, kind: "settings_notice", contextId: null, parentId: null, body: settingsNoticeBody(takes) });
      if ("refused" in written) {
        console.error(`This workbench's settings notice to ${p.peerName} was not written: ${written.problem}`);
        continue;
      }
      logPeer(db, { rule: "peer_protocol", command: "settings notice sent", detail: `What this workbench takes from ${p.peerName} (questions ${takes.question ? "on" : "off"}, answers ${takes.answer ? "on" : "off"}) is being sent to ${p.peerName}'s workbench until it acknowledges it.` });
    }
  };

  // ---- Outgoing: confirmations and settings notices, retried until answered, the pairing ends, or 24 hours pass.

  const pending = (): { rowId: number; signed: SignedEnvelope }[] =>
    db
      .prepare(
        `SELECT m.* FROM peer_messages m WHERE m.direction = 'out' AND m.kind IN ('pair_confirmation', 'settings_notice', 'question', 'answer') AND m.stored_at > ?
           AND NOT EXISTS (SELECT 1 FROM peer_messages r WHERE r.pairing_id = m.pairing_id AND r.direction = 'in' AND r.parent_id = m.message_id AND r.kind IN ('acknowledgement', 'refusal'))
           AND NOT EXISTS (SELECT 1 FROM peer_send_outcomes s WHERE s.pairing_id = m.pairing_id AND s.message_id = m.message_id)
           AND NOT EXISTS (SELECT 1 FROM peer_pairing_ends e WHERE e.pairing_id = m.pairing_id)
         ORDER BY m.id`,
      )
      .all(new Date(Date.now() - DELIVERY_WINDOW_MS).toISOString())
      .map((row) => ({ rowId: Number(row.id), signed: toSigned(row) }));

  /** What the peer answered to `sent`: stored when it is that peer's signed acknowledgement or refusal. True when answered. */
  const takeAnswer = (sent: SignedEnvelope, body: unknown): boolean => {
    if (!isObject(body) || !isObject(body.response)) return false;
    const received = receiveEnvelope(db, ownKey(), { envelope: body.response.envelope, signature: body.response.signature }, { kinds: ["acknowledgement", "refusal"] });
    if (received.outcome === "refused") {
      // Unsigned, signed with another key, or for nothing this side sent: it changes nothing, and the message is tried again.
      console.error(`An answer to ${sent.envelope.kind} ${sent.envelope.messageId} was not taken: ${received.problem}`);
      return false;
    }
    if (received.envelope.parentId !== sent.envelope.messageId) return false;
    if (received.outcome === "replayed") return true;
    const p = getPairing(db, sent.envelope.pairingId)!;
    const e = received.envelope;
    if (e.kind === "refusal" && e.body === "pairing_ended") {
      logPeer(db, { rule: "peer_pairing", command: "ended by the peer's refusal", detail: `${p.peerName}'s workbench refused the ${sent.envelope.kind.replace("_", " ")} because it ended the pairing ${p.id}; the refusal is signed with its key, so the pairing has ended here too.`, byPeer: p });
    } else if (e.kind === "refusal" && isMessageKind(sent.envelope.kind)) {
      logPeer(db, { rule: "peer_message", command: `${sent.envelope.kind} not taken by the peer`, detail: `${p.peerName}'s workbench did not take the ${sent.envelope.kind} (message ${sent.envelope.messageId}), with the reason ${e.body}. It is not sent again.`, byPeer: p });
    } else if (isMessageKind(sent.envelope.kind)) {
      logPeer(db, { rule: "peer_message", command: `${sent.envelope.kind} delivered`, detail: `${p.peerName}'s workbench acknowledged the ${sent.envelope.kind} (message ${sent.envelope.messageId}): it is a card for its owner.`, byPeer: p });
    } else if (e.kind === "refusal") {
      logPeer(db, { rule: "peer_protocol", command: "refused by the peer", detail: `${p.peerName}'s workbench refused the ${sent.envelope.kind.replace("_", " ")} with the reason ${e.body}.`, byPeer: p });
    } else if (sent.envelope.kind === "pair_confirmation") {
      logPeer(db, { rule: "peer_pairing", command: "confirmation acknowledged", detail: `${p.peerName}'s workbench holds your confirmation: the pairing ${p.id} is in force on both sides.`, byPeer: p });
    }
    return true;
  };

  const attempt = async (rowId: number, signed: SignedEnvelope): Promise<void> => {
    const p = getPairing(db, signed.envelope.pairingId);
    if (p === null || p.endedAt !== null) return;
    // Every attempt, the first and each retry, checks both settings again (decision 11): switched off, it is not sent.
    if (!stillAllowed(db, signed)) {
      retries.delete(rowId);
      return;
    }
    let answered = false;
    try {
      const reply = await postToPeer(p.peerAddress, routeOf(signed.envelope.kind), signed, abort.signal);
      answered = takeAnswer(signed, reply.body);
    } catch (err) {
      if (!closed) console.error(`Sending the ${signed.envelope.kind.replace("_", " ")} to ${p.peerName}'s workbench at ${p.peerAddress} failed, and it will be tried again: ${words(err)}`);
    }
    if (answered) {
      retries.delete(rowId);
      return;
    }
    const tries = (retries.get(rowId)?.attempts ?? 0) + 1;
    retries.set(rowId, { attempts: tries, next: Date.now() + Math.min(FIRST_RETRY_MS * 2 ** (tries - 1), maxRetryMs) });
  };

  const pass = async (): Promise<void> => {
    if (passing || closed) return;
    passing = true;
    try {
      sendSettings();
      expireUndelivered();
      for (const { rowId, signed } of pending()) {
        if (closed) break;
        if ((retries.get(rowId)?.next ?? 0) > Date.now()) continue;
        await attempt(rowId, signed);
      }
    } catch (err) {
      console.error(`Sending to a paired workbench failed: ${words(err)}`);
    } finally {
      passing = false;
    }
  };
  function kick(): void {
    if (!closed && bound !== null) void track(pass());
  }

  /** A question or an answer tried for 24 hours and never answered: it reads "Not delivered", and is tried no more. */
  const expireUndelivered = (): void => {
    const due = db
      .prepare(
        `SELECT m.pairing_id, m.message_id, m.kind FROM peer_messages m WHERE m.direction = 'out' AND m.kind IN ('question', 'answer') AND m.stored_at <= ?
           AND NOT EXISTS (SELECT 1 FROM peer_messages r WHERE r.pairing_id = m.pairing_id AND r.direction = 'in' AND r.parent_id = m.message_id AND r.kind IN ('acknowledgement', 'refusal'))
           AND NOT EXISTS (SELECT 1 FROM peer_send_outcomes s WHERE s.pairing_id = m.pairing_id AND s.message_id = m.message_id)
           AND NOT EXISTS (SELECT 1 FROM peer_pairing_ends e WHERE e.pairing_id = m.pairing_id)`,
      )
      .all(new Date(Date.now() - DELIVERY_WINDOW_MS).toISOString());
    for (const row of due) stopSending(db, getPairing(db, String(row.pairing_id))!, String(row.message_id), String(row.kind) as MessageKind, "not_delivered");
  };

  /** End notice: sent once, not waited for, and never retried (decision 4). */
  const sendOnce = (p: Pairing, notice: SignedEnvelope): void => {
    void track(
      postToPeer(p.peerAddress, "end", notice, abort.signal).then(
        (reply) => {
          if (reply.status !== 200) console.log(`${p.peerName}'s workbench did not take the end notice (${reply.status}); the pairing has ended here all the same.`);
        },
        (err: unknown) => console.log(`The end notice to ${p.peerName}'s workbench at ${p.peerAddress} was not delivered (${words(err)}); the pairing has ended here all the same, and its next message gets a signed refusal.`),
      ),
    );
  };

  const end = (p: Pairing, how: Extract<EndHow, "owner_ended" | "fingerprint_refused">): PairingView => {
    const ended = endPairing(db, ownKey(), p.id, how);
    if (ended === null) throw new PeerError(409, "This pairing has ended already.");
    const after = getPairing(db, p.id)!;
    logPeer(db, { rule: "peer_pairing", command: how === "owner_ended" ? "ended by you" : "fingerprint refused", detail: how === "owner_ended" ? `You ended the pairing ${p.id} with ${p.peerName}. Its messages are refused from now on, and nothing more is sent to it.` : `You refused ${p.peerName}'s fingerprint ${p.peerFingerprint}, so the pairing ${p.id} ended before it was in force.` });
    if (ended.notice !== null) {
      if (bound !== null) {
        logPeer(db, { rule: "peer_protocol", command: "end notice sent", detail: `The signed end notice for pairing ${p.id} is sent to ${p.peerName}'s workbench once; Botbench does not wait for an answer.` });
        sendOnce(after, ended.notice);
      }
    }
    return view(after);
  };

  const confirmedJoin = async (id: string, join: Join): Promise<PairingView> => {
    const address = requireListener();
    const live = db.prepare("SELECT 1 FROM peer_pairings p WHERE NOT EXISTS (SELECT 1 FROM peer_pairing_ends e WHERE e.pairing_id = p.id)").get();
    if (live !== undefined) throw new PeerError(409, "This workbench is already paired with another workbench, and the first version pairs with one at a time. End that pairing first.");
    const { invite } = join;
    const key = ownKey();
    const request = proveRequest({ inviteId: invite.id, pairingKey: join.pairingKey, key: key.publicKey, name: workbenchName(db), address, repository: invite.repository }, invite.secret);
    logPeer(db, { rule: "peer_protocol", command: "pair request sent", detail: `Your confirm sent a pair request for the invite ${invite.id} to ${invite.name}'s workbench at ${invite.address}, proved with the invite and never carrying its secret.` });
    let reply: Awaited<ReturnType<typeof postToPeer>>;
    try {
      reply = await postToPeer(invite.address, "pair", request, abort.signal);
    } catch (err) {
      console.error(`The pair request to ${invite.address} failed: ${words(err)}`);
      throw new PeerError(502, `Botbench could not reach ${invite.name}'s workbench at ${invite.address}. Check that it is running with its listener for paired workbenches on, then confirm again.`);
    }
    const refusedBy = (why: string): never => {
      dropJoin(id);
      logPeer(db, { rule: "peer_pairing", command: "join refused", detail: `${invite.name}'s workbench at ${invite.address} did not pair on ${invite.repository} with the invite ${invite.id}: ${why}` });
      throw new PeerError(409, why);
    };
    // It could not answer just now: what it was asked may be stored already, and the same request again gets the same answer.
    if (reply.status >= 500) throw new PeerError(502, `${invite.name}'s workbench could not answer just now. Confirm again in a moment.`);
    if (reply.status === 429) throw new PeerError(429, `${invite.name}'s workbench is getting too many requests. Wait a minute, then confirm again.`);
    if (reply.status === 409 && isObject(reply.body) && reply.body.refused === "already_paired") refusedBy(`${invite.name}'s workbench is already paired with another workbench. Ask ${invite.name} to end that pairing and send a new invite.`);
    if (reply.status !== 200) refusedBy(`${invite.name}'s workbench did not take the invite. It may have expired, been withdrawn or been used already. Ask ${invite.name} for a new invite.`);
    const answer = readPairAnswer(reply.body, request);
    if (answer === null) throw new PeerError(502, `The answer from ${invite.address} is not a signed Botbench answer to this request, so nothing was paired. Confirm again to send the same request.`);
    const joined = joinPairing(db, key, { invite: { fingerprint: invite.fingerprint, repository: invite.repository }, sentPairingKey: join.pairingKey, answer: { pairingId: answer.pairingId, pairingKey: answer.pairingKey, repository: answer.repository, peer: { key: answer.inviterKey, name: invite.name, address: invite.address } } });
    if ("refused" in joined) {
      if (joined.refused === "wrong_key") {
        refusedBy(`The workbench that answered at ${invite.address} is not the one in the invite: its fingerprint is ${fingerprintOf(answer.inviterKey)}, and the invite's is ${invite.fingerprint}. Nothing was paired, and nothing more is sent to it.`);
      }
      refusedBy(joined.refused === "already_paired" ? "This workbench is already paired with another workbench. End that pairing first." : "The answer does not match the request this workbench sent, so nothing was paired.");
    }
    if (!("pairing" in joined)) throw new Error("unreachable");
    dropJoin(id);
    const p = joined.pairing;
    logPeer(db, { rule: "peer_pairing", command: "joined", detail: `You confirmed ${p.peerName}'s fingerprint ${p.peerFingerprint} and paired on ${p.repository} (pairing ${p.id}). Nothing is sent to ${p.peerName} until its owner confirms this workbench's fingerprint.` });
    return view(p);
  };

  return {
    address: () => bound,

    async listen() {
      if (listen === undefined) return;
      const handler = createPeerHandler({
        db,
        key: keyIfMade,
        roundTrips,
        onStored: (_p, kind) => {
          // The joiner holds the inviter's confirmation now: the pairing is in force, and its settings go to the peer.
          if (kind === "pair_confirmation") kick();
        },
      });
      server = createPeerServer(handler);
      const s = server;
      const port = await new Promise<number>((resolve, reject) => {
        s.once("error", reject);
        s.listen(listen.port, listen.address, () => {
          s.off("error", reject);
          resolve((s.address() as AddressInfo).port);
        });
      });
      bound = joinHostPort(listen.address, port);
      sweep();
      const sweeper = setInterval(sweep, SWEEP_MS);
      sweeper.unref();
      const ticker = setInterval(() => void track(pass()), 1000);
      ticker.unref();
      abort.signal.addEventListener("abort", () => {
        clearInterval(sweeper);
        clearInterval(ticker);
      });
      kick();
    },

    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      for (const expiry of expiries) clearTimeout(expiry);
      await Promise.allSettled([...inFlight]);
      for (const id of [...joins.keys()]) dropJoin(id);
      const s = server;
      if (s !== null && s.listening) {
        await new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        });
      }
    },

    async makeInvite(repoInput) {
      const address = requireListener();
      const repo = await checkRepository(repoInput).catch((err: unknown) => {
        throw err instanceof TaskError ? new PeerError(err.status, err.message) : err;
      });
      const scope = await pairingScope(config, repo);
      if ("problem" in scope) throw new PeerError(400, scope.problem);
      const key = ownKey();
      const made = createInvite(db, scope.repository, new Date(), lifeMs);
      // Swept at the moment it expires, so its secret does not wait for the minute's sweep.
      const expiry = setTimeout(() => {
        expiries.delete(expiry);
        sweep();
      }, lifeMs + 10);
      expiry.unref();
      expiries.add(expiry);
      try {
        logPeer(db, { rule: "peer_invite", command: "invite made", detail: `You made the invite ${made.id} to pair on ${scope.repository}. It can be used once, until ${made.expiresAt}.` });
        return { id: made.id, invite: inviteText({ id: made.id, name: workbenchName(db), fingerprint: key.fingerprint, address, repository: scope.repository, expiresAt: made.expiresAt, secret: made.secret }), repository: scope.repository, expiresAt: made.expiresAt };
      } finally {
        made.secret.fill(0);
      }
    },

    withdrawInvite(id) {
      const row = typeof id === "string" ? db.prepare("SELECT state FROM peer_invites WHERE id = ?").get(id) : undefined;
      if (row === undefined) throw new PeerError(404, "There is no invite by that id.");
      if (!withdrawInvite(db, id)) throw new PeerError(409, `This invite cannot be withdrawn: it was ${String(row.state)} already.`);
      logPeer(db, { rule: "peer_invite", command: "invite withdrawn", detail: `You withdrew the invite ${id}; its secret is erased, and it can no longer be used.` });
    },

    async paste(text, repoInput) {
      requireListener();
      const invite = readInvite(text);
      if ("problem" in invite) throw new PeerError(400, invite.problem);
      const own = ownKey();
      const refuse = (status: number, message: string): never => {
        invite.secret.fill(0);
        throw new PeerError(status, message);
      };
      if (Date.parse(invite.expiresAt) <= Date.now()) refuse(410, `This invite expired at ${invite.expiresAt}. Ask ${invite.name} for a new one.`);
      if (invite.fingerprint === own.fingerprint) refuse(400, "This invite was made by this workbench. Pass it to the other workbench's owner to paste there.");
      const repo = await checkRepository(repoInput).catch((err: unknown) => refuse(err instanceof TaskError ? err.status : 400, words(err)));
      const scope = await pairingScope(config, repo);
      if ("problem" in scope) refuse(400, scope.problem);
      if ("repository" in scope && scope.repository !== invite.repository) refuse(400, `This invite is for ${invite.repository}, and the copy you chose is of ${scope.repository}. Choose your copy of ${invite.repository}.`);
      if (joins.size >= MAX_JOINS) sweep();
      if (joins.size >= MAX_JOINS) refuse(429, "Too many invites are pasted and waiting for your confirm. Wait until they expire, then paste this one again.");
      const id = newId();
      joins.set(id, { invite, repo, pairingKey: newPairingKey() });
      return { id, name: invite.name, fingerprint: invite.fingerprint, repository: invite.repository, address: invite.address, expiresAt: invite.expiresAt, ownFingerprint: own.fingerprint };
    },

    confirmJoin(id) {
      const join = joins.get(id);
      if (join === undefined) return Promise.reject(new PeerError(404, "There is no pasted invite by that id. Paste the invite again."));
      if (Date.parse(join.invite.expiresAt) <= Date.now()) {
        dropJoin(id);
        return Promise.reject(new PeerError(410, `This invite expired. Ask ${join.invite.name} for a new one.`));
      }
      // Pressed twice: one request on the wire, one answer.
      join.inFlight ??= track(confirmedJoin(id, join)).finally(() => {
        join.inFlight = undefined;
      });
      return join.inFlight;
    },

    confirmPairing(id) {
      const p = pairingOf(id);
      if (p.role !== "inviter" || pairingState(p) !== "waiting_for_owner") throw new PeerError(409, pairingState(p) === "ended" ? "This pairing has ended." : "There is nothing for you to confirm on this pairing.");
      if (!confirmByOwner(db, p.id)) throw new PeerError(409, "There is nothing for you to confirm on this pairing.");
      const written = writeOutgoing(db, ownKey(), { pairingId: p.id, kind: "pair_confirmation", contextId: null, parentId: null, body: "" });
      if ("refused" in written) throw new Error(`The confirmation for pairing ${p.id} was not written: ${written.problem}`);
      logPeer(db, { rule: "peer_pairing", command: "confirmed by you", detail: `You confirmed ${p.peerName}'s fingerprint ${p.peerFingerprint}. The signed confirmation is sent to ${p.peerName}'s workbench until it acknowledges it.` });
      logPeer(db, { rule: "peer_protocol", command: "pair confirmation sent", detail: `The signed confirmation of pairing ${p.id} is being sent to ${p.peerName}'s workbench at ${p.peerAddress}.` });
      kick();
      return view(getPairing(db, p.id)!);
    },

    refusePairing(id) {
      const p = pairingOf(id);
      if (p.role !== "inviter" || pairingState(p) !== "waiting_for_owner") throw new PeerError(409, pairingState(p) === "ended" ? "This pairing has ended." : "There is no fingerprint for you to refuse on this pairing. To stop working with this workbench, end the pairing.");
      return end(p, "fingerprint_refused");
    },

    endPairing(id) {
      return end(pairingOf(id), "owner_ended");
    },

    send(input) {
      const sent = ownerSend(db, ownKey(), input, { roundTrips });
      kick();
      return sent;
    },
    answerCard(pairingId, messageId, text) {
      const sent = answerCard(db, ownKey(), pairingId, messageId, text, { roundTrips });
      kick();
      return sent;
    },
    dismissCard: (pairingId, messageId) => dismissCard(db, pairingId, messageId),
    sendDraft(pairingId, messageId, edited) {
      const sent = sendDraft(db, ownKey(), pairingId, messageId, edited, { roundTrips });
      kick();
      return sent;
    },
    dontSendDraft: (pairingId, messageId) => dontSendDraft(db, pairingId, messageId),
    cards: () => waitingCards(db),
    messages: (pairingId) => pairingMessages(db, pairingId),
    kinds: (pairingId) => kindSettings(db, pairingOf(String(pairingId)).id),
    setKind(input) {
      const settings = setKind(db, ownKey(), input);
      kick();
      return settings;
    },
    friction: () => frictionRecord(db),
    async prepareGive(pairingId, messageId, repoInput, allowHosts) {
      const p = pairingOf(String(pairingId));
      if (pairingState(p) === "ended") throw new PeerError(409, `The pairing with ${p.peerName} has ended.`);
      if (typeof allowHosts !== "boolean") throw new PeerError(400, "Say whether the task's commands may reach this repository's network hosts (allowHosts, true or false). They reach none unless you tick them.");
      const card = typeof messageId === "string" ? db.prepare("SELECT c.kind, m.body FROM peer_cards c JOIN peer_messages m ON m.pairing_id = c.pairing_id AND m.message_id = c.message_id AND m.direction = 'in' WHERE c.pairing_id = ? AND c.direction = 'in' AND c.message_id = ? AND c.decided_at IS NULL").get(p.id, messageId) : undefined;
      if (card === undefined) throw new PeerError(404, `There is no card from ${p.peerName} waiting by that id: it was decided already, or never shown.`);
      const repo = await checkRepository(repoInput).catch((err: unknown) => {
        throw err instanceof TaskError ? new PeerError(err.status, err.message) : err;
      });
      const scope = await pairingScope(config, repo);
      if ("problem" in scope) throw new PeerError(400, scope.problem);
      if (scope.repository !== p.repository) throw new PeerError(400, `This pairing is on ${p.repository}, and the copy you chose is of ${scope.repository}. Choose your copy of ${p.repository}.`);
      const about = repositoryWord(p.repository);
      const question = card.kind === "question";
      // voice: not on screen until unit 4 shows tasks given a message; the task's title is its first line.
      const prompt = `${question ? `Answer ${p.peerName}'s question about ${about}.` : `Work on ${p.peerName}'s answer about ${about}.`}\n\nThe ${question ? "question" : "answer"} is below, as outside text from ${p.peerName}'s workbench. Read this repository as you need to. Nothing is sent to ${p.peerName}'s workbench unless the owner sends it.`;
      return { repo, prompt, given: { pairingId: p.id, messageId: String(messageId), peerName: p.peerName, peerFingerprint: p.peerFingerprint, allowHosts } };
    },
    markGiven(pairingId, messageId, taskId) {
      const p = pairingOf(String(pairingId));
      if (pairingState(p) === "ended") throw new PeerError(409, `The pairing with ${p.peerName} has ended.`);
      const waiting = db.prepare("SELECT 1 FROM peer_cards WHERE pairing_id = ? AND direction = 'in' AND message_id = ? AND decided_at IS NULL").get(p.id, String(messageId));
      if (waiting === undefined) throw new PeerError(409, `That card from ${p.peerName} was decided already; nothing more was started.`);
      atomic(() => {
        decideIncomingCard(db, p.id, String(messageId), "given_to_agent");
        logPeer(db, { rule: "peer_message", command: "given to Claude Code", detail: `You gave the message ${String(messageId)} from ${p.peerName}'s workbench to Claude Code as task ${taskId}. The task is marked as having read outside text: no command is allowed in advance or always, it cannot be fully autonomous, and its commands reach no network host unless you ticked them.` });
      });
    },

    overview() {
      sweep();
      const made = keyIfMade();
      const pairings = db.prepare("SELECT id FROM peer_pairings ORDER BY created_at DESC, rowid DESC").all().map((row) => view(getPairing(db, String(row.id))!));
      const invites = db.prepare("SELECT id, repository, expires_at FROM peer_invites WHERE state = 'open' ORDER BY created_at DESC").all().map((row) => ({ id: String(row.id), repository: String(row.repository), expiresAt: String(row.expires_at) }));
      return { listening: bound, fingerprint: made?.fingerprint ?? null, pairings, invites };
    },
  };
}
