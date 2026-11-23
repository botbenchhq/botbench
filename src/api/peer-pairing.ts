import type http from "node:http";
import { PeerError } from "../peers/service.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

/*
 * The owner's routes for pairing with another workbench (Peers P5, ADR 0004 decisions 3 and 4). Called only for
 * requests the auth gate let through: none of them is reachable from the peer listener, which has routes of its own.
 *
 *   GET  /api/peers/pairings                 this workbench's fingerprint, its pairings and open invites
 *   POST /api/peers/invites                  { repo }: a new invite, returned this once (one line to pass on)
 *   POST /api/peers/invites/:id/withdraw     withdraw an open invite
 *   POST /api/peers/joins                    { invite, repo }: paste an invite; see its name, fingerprint, repository
 *   POST /api/peers/joins/:id/confirm        confirm the pasted invite: send the pair request
 *   POST /api/peers/pairings/:id/confirm     the inviter's owner confirms the other workbench's fingerprint
 *   POST /api/peers/pairings/:id/refuse      the inviter's owner refuses it: the pairing ends with a signed notice
 *   POST /api/peers/pairings/:id/end         End pairing, from either side
 */

const ID = "([0-9a-f-]{36})";

export async function peerPairingRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/peers/")) return false;
  const link = ctx.peerLink;
  const body = async (): Promise<Record<string, unknown>> => {
    const value = await readJsonBody(req, 8 * 1024);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BodyError(400, "The request body is a JSON object.");
    return value as Record<string, unknown>;
  };
  const match = (pattern: string): string | null => (req.method === "POST" ? (new RegExp(`^${pattern}$`).exec(pathname)?.[1] ?? null) : null);
  try {
    if (req.method === "GET" && pathname === "/api/peers/pairings") {
      json(res, 200, link.overview());
      return true;
    }
    if (req.method === "POST" && pathname === "/api/peers/invites") {
      const { repo } = await body();
      // The invite holds the secret: it is in this answer only, never in a log line (cache-control no-store).
      json(res, 200, await link.makeInvite(repo));
      return true;
    }
    let id = match(`/api/peers/invites/${ID}/withdraw`);
    if (id !== null) {
      link.withdrawInvite(id);
      json(res, 200, { withdrawn: id });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/peers/joins") {
      const { invite, repo } = await body();
      json(res, 200, { join: await link.paste(invite, repo) });
      return true;
    }
    if ((id = match(`/api/peers/joins/${ID}/confirm`)) !== null) {
      json(res, 200, { pairing: await link.confirmJoin(id) });
      return true;
    }
    if ((id = match(`/api/peers/pairings/${ID}/confirm`)) !== null) {
      json(res, 200, { pairing: link.confirmPairing(id) });
      return true;
    }
    if ((id = match(`/api/peers/pairings/${ID}/refuse`)) !== null) {
      json(res, 200, { pairing: link.refusePairing(id) });
      return true;
    }
    if ((id = match(`/api/peers/pairings/${ID}/end`)) !== null) {
      json(res, 200, { pairing: link.endPairing(id) });
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
