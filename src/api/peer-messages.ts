import type http from "node:http";
import { TaskError } from "../engine/task.ts";
import { PeerError } from "../peers/service.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

/*
 * The owner's routes for questions and answers with a paired workbench (Peers P5, ADR 0004 decisions 6 to 12). Called
 * only for requests the auth gate let through; none is reachable from the peer listener. Each route that sends is the
 * owner's Send: nothing of the two kinds leaves this Mac any other way.
 *
 *   GET  /api/peers/cards                                    every card waiting for you about a peer message
 *   GET  /api/peers/friction                                 the friction record, per pairing and per thread
 *   GET  /api/peers/pairings/:id/messages                    the pairing's questions and answers, each with its state
 *   POST /api/peers/pairings/:id/messages                    { kind, text, parentId? }: your own message, sent now
 *   POST /api/peers/pairings/:id/cards/:message/answer       { text }: Answer it yourself, on a peer's card
 *   POST /api/peers/pairings/:id/cards/:message/give         { repo, allowHosts }: Give it to Claude Code, as a new task in
 *                                                            your copy of the pairing's repository, marked as outside text
 *   POST /api/peers/pairings/:id/cards/:message/dismiss      Dismiss a peer's card
 *   POST /api/peers/pairings/:id/cards/:message/seen         { direction }: a signed-in device drew this card for the
 *                                                            first time (the friction record's "shown"); changes nothing else
 *   POST /api/peers/pairings/:id/drafts/:message/send        { text? }: Send an agent's draft, or your edit of it
 *   POST /api/peers/pairings/:id/drafts/:message/dont-send   Don't send an agent's draft
 *   GET  /api/peers/pairings/:id/kinds                       what may be sent to and taken from the peer, per kind
 *   POST /api/peers/pairings/:id/kinds                       { direction, kind, allowed }: change one
 *
 * The friction record's "shown" is when a signed-in device first drew the card, as the client says with `seen` when it
 * renders one; for a card decided before any device drew it (through these routes alone), when the server made it.
 * Its waits are from that moment to the owner's decision.
 */

export const SHOWN_MEANS = "when a signed-in device first drew the card; for a card decided before any device drew it, when the server made it";

const ID = "([0-9a-f-]{36})";

export async function peerMessageRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/peers/")) return false;
  const link = ctx.peerLink;
  const body = async (): Promise<Record<string, unknown>> => {
    const value = await readJsonBody(req, 64 * 1024);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BodyError(400, "The request body is a JSON object.");
    return value as Record<string, unknown>;
  };
  const on = (method: string, pattern: string): string[] | null => (req.method === method ? (new RegExp(`^${pattern}$`).exec(pathname)?.slice(1) ?? null) : null);
  try {
    if (on("GET", "/api/peers/cards") !== null) {
      json(res, 200, { cards: link.cards() });
      return true;
    }
    if (on("GET", "/api/peers/friction") !== null) {
      json(res, 200, { shown: SHOWN_MEANS, pairings: link.friction() });
      return true;
    }
    let m: string[] | null;
    if ((m = on("GET", `/api/peers/pairings/${ID}/messages`)) !== null) {
      json(res, 200, { messages: link.messages(m[0]) });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/messages`)) !== null) {
      const { kind, text, parentId } = await body();
      json(res, 200, { message: link.send({ pairingId: m[0], kind, text, parentId }) });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/cards/${ID}/answer`)) !== null) {
      const { text } = await body();
      json(res, 200, { message: link.answerCard(m[0], m[1], text) });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/cards/${ID}/give`)) !== null) {
      const { repo, allowHosts } = await body();
      const given = await link.prepareGive(m[0], m[1], repo, allowHosts);
      // The card is decided in the same write that stores the task: a second Give finds it decided and starts nothing.
      const task = await ctx.tasks.startGiven(given.repo, given.prompt, given.given, (taskId) => link.markGiven(m![0], m![1], taskId)).catch((err: unknown) => {
        throw err instanceof TaskError ? new PeerError(err.status, err.message) : err;
      });
      json(res, 200, { taskId: task.id });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/cards/${ID}/dismiss`)) !== null) {
      link.dismissCard(m[0], m[1]);
      json(res, 200, { dismissed: m[1] });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/cards/${ID}/seen`)) !== null) {
      const { direction } = await body();
      link.seeCard(m[0], direction, m[1]);
      json(res, 200, { seen: m[1] });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/drafts/${ID}/send`)) !== null) {
      const { text } = await body();
      json(res, 200, { message: link.sendDraft(m[0], m[1], text) });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/drafts/${ID}/dont-send`)) !== null) {
      link.dontSendDraft(m[0], m[1]);
      json(res, 200, { notSent: m[1] });
      return true;
    }
    if ((m = on("GET", `/api/peers/pairings/${ID}/kinds`)) !== null) {
      json(res, 200, { kinds: link.kinds(m[0]) });
      return true;
    }
    if ((m = on("POST", `/api/peers/pairings/${ID}/kinds`)) !== null) {
      const { direction, kind, allowed } = await body();
      json(res, 200, { kinds: link.setKind({ pairingId: m[0], direction, kind, allowed }) });
      return true;
    }
  } catch (err) {
    if (err instanceof PeerError || err instanceof BodyError) {
      json(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }
  return false;
}
