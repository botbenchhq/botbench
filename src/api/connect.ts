import type http from "node:http";
import { ConnectError } from "../drivers/connect.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

/*
 * Connecting an agent from Settings (U26). Every route needs the owner's session: the router is reached only through
 * the auth gate. The link and code a sign-in printed are in the answers to these routes while it waits, and nowhere else.
 *   GET  /api/agents/:driver/connect          where the agent's sign-in stands
 *   POST /api/agents/:driver/connect          start it (409 while one runs); answers once the link is there
 *   POST /api/agents/:driver/connect/code     { "code": "..." } the code the vendor's page showed, for a CLI that takes one
 *   POST /api/agents/:driver/connect/cancel   stop it
 *   POST /api/agents/:driver/disconnect       the CLI's own sign-out; answers with the new probe
 */

const ROUTE = /^\/api\/agents\/([a-z][a-z0-9-]{0,39})\/(connect|connect\/code|connect\/cancel|disconnect)$/;

export async function connectRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (match === null) return false;
  const [, driver, action] = match as unknown as [string, string, string];
  const method = req.method;
  try {
    if (method === "GET" && action === "connect") json(res, 200, ctx.connect.view(driver));
    else if (method === "POST" && action === "connect") json(res, 200, await ctx.connect.start(driver));
    else if (method === "POST" && action === "connect/code") {
      const body = await readJsonBody(req, 8 * 1024);
      json(res, 200, ctx.connect.sendCode(driver, typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined));
    } else if (method === "POST" && action === "connect/cancel") json(res, 200, await ctx.connect.cancel(driver));
    else if (method === "POST" && action === "disconnect") json(res, 200, { driver, ...(await ctx.connect.signOut(driver)) });
    else return false;
  } catch (err) {
    if (err instanceof ConnectError || err instanceof BodyError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
