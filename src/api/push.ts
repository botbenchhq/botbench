import type http from "node:http";
import { PushError } from "../push.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

/** The endpoint a request names, or null. */
const endpointOf = (body: unknown): string | null => (typeof body === "object" && body !== null && typeof (body as { endpoint?: unknown }).endpoint === "string" ? (body as { endpoint: string }).endpoint : null);

/**
 * The notification routes (unit 23): the key a browser subscribes with, turning notifications on and off for one
 * device, whether this device is on, and a test notification. All need a session, as every route does.
 */
export async function pushRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/push")) return false;
  const method = req.method;
  try {
    if (method === "GET" && pathname === "/api/push") {
      json(res, 200, { publicKey: ctx.push.publicKey });
    } else if (method === "POST" && pathname === "/api/push/subscriptions") {
      ctx.push.subscribe(await readJsonBody(req, 8192));
      json(res, 200, { subscribed: true });
    } else if (method === "POST" && (pathname === "/api/push/unsubscribe" || pathname === "/api/push/check" || pathname === "/api/push/test")) {
      const endpoint = endpointOf(await readJsonBody(req, 8192));
      // voice: not on screen. The client always sends the endpoint the browser holds.
      if (endpoint === null) return (json(res, 400, { error: 'expected { "endpoint": "..." }' }), true);
      if (pathname === "/api/push/unsubscribe") json(res, 200, { removed: ctx.push.unsubscribe(endpoint) });
      else if (pathname === "/api/push/check") json(res, 200, { subscribed: ctx.push.subscribed(endpoint) });
      else {
        await ctx.push.sendTest(endpoint);
        json(res, 200, { sent: true });
      }
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof PushError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
