import type http from "node:http";
import { json, type RouteContext } from "./router.ts";

/*
 * The issue watch's routes (engine/watch.ts, ADR 0008), each reading or changing only Botbench's own store; none asks
 * GitHub anything or starts anything:
 *   GET  /api/watch                              each watched repository's state, and the proposals on Work
 *   GET  /api/watch/proposals/<id>               one proposal, for Start to open the composer on its issue
 *   POST /api/watch/proposals/<id>/dismiss       the owner dismisses it: it is never proposed again
 * A proposal's title and author are outside text, sent as data for the client to show as plain text.
 */

const ONE = /^\/api\/watch\/proposals\/([1-9]\d{0,14})(\/dismiss)?$/;
const GONE = "That issue is no longer proposed on Work: it was dismissed, or a run was started from it.";

/** Returns false when the request is for none of these. Called only for requests the auth gate let through. */
export function watchRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): boolean {
  if (req.method === "GET" && url.pathname === "/api/watch") {
    json(res, 200, { watches: ctx.watch.status(), proposals: ctx.watch.proposals() });
    return true;
  }
  const one = ONE.exec(url.pathname);
  if (one === null) return false;
  const id = Number(one[1]);
  if (req.method === "GET" && one[2] === undefined) {
    const proposal = ctx.watch.proposal(id);
    if (proposal === null) json(res, 404, { error: GONE });
    else json(res, 200, { proposal });
    return true;
  }
  if (req.method === "POST" && one[2] !== undefined) {
    if (ctx.watch.dismiss(id)) json(res, 200, { dismissed: true });
    else json(res, 404, { error: GONE });
    return true;
  }
  return false;
}
