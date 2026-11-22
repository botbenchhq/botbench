import type http from "node:http";
import { CLAUDE_CODE } from "../drivers/claude-code.ts";
import { DriverUnavailableError } from "../drivers/contract.ts";
import { BodyError, json, modelChoice, readJsonBody, type RouteContext } from "./router.ts";
import { eventsAfter, parseEventId } from "./stream.ts";
import { TurnError } from "./turns.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function startTurn(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!isObject(body) || typeof body.prompt !== "string" || body.prompt.trim() === "") return json(res, 400, { error: 'expected { "prompt": "...", "attemptId"?: number, "model"?: string | null }' });
  const model = modelChoice(body);
  const { attemptId } = body;
  if (attemptId !== undefined && !(typeof attemptId === "number" && Number.isSafeInteger(attemptId) && attemptId > 0)) return json(res, 400, { error: '"attemptId" must be an attempt id' });
  json(res, 200, await ctx.turns.start(body.prompt, attemptId, model));
}

/**
 * The turn routes: the driver's state, sending and stopping a turn, an
 * attempt's transcript, and the live stream. Returns false when the request is
 * for none of them. Called only for requests the auth gate let through.
 */
export async function turnRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method;
  try {
    if (method === "GET" && pathname === "/api/session") {
      json(res, 200, { signedIn: true });
    } else if (method === "GET" && pathname === "/api/driver") {
      json(res, 200, { driver: CLAUDE_CODE, ...(await ctx.turns.probe()) });
    } else if (method === "GET" && pathname === "/api/models") {
      // The driver's own account of what can be chosen. It answers in seconds or falls back to the configured list.
      json(res, 200, { driver: CLAUDE_CODE, ...(await ctx.driver.models()) });
    } else if (method === "GET" && pathname === "/api/stream") {
      ctx.stream.handle(req, res);
    } else if (method === "POST" && pathname === "/api/turns") {
      await startTurn(req, res, ctx);
    } else if (method === "POST" && /^\/api\/turns\/\d{1,15}\/interrupt$/.test(pathname)) {
      await ctx.turns.interrupt(Number(pathname.split("/")[3]));
      json(res, 200, { interrupted: true });
    } else if (method === "GET" && /^\/api\/attempts\/\d{1,15}\/events$/.test(pathname)) {
      const attemptId = Number(pathname.split("/")[3]);
      const after = url.searchParams.has("after") ? parseEventId(url.searchParams.get("after")!) : 0;
      if (after === null) return (json(res, 400, { error: '"after" must be an event id' }), true);
      const attempt = ctx.db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId);
      if (!attempt) return (json(res, 404, { error: "no such attempt" }), true);
      json(res, 200, { attemptId, status: attempt.status, turnRunning: ctx.turns.turnRunning(attemptId), events: eventsAfter(ctx.db, after, attemptId) });
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof TurnError) json(res, err.status, { error: err.message });
    // The CLI cannot be driven: say why, with the probe, so the client can show it in words.
    else if (err instanceof DriverUnavailableError) json(res, 409, { error: err.message, driver: { driver: CLAUDE_CODE, ...err.probe } });
    else throw err;
  }
  return true;
}
