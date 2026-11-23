import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { defaultMode, isRunMode, setDefaultMode } from "../engine/modes.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether this installation is on its first run: no chat, task or run has ever been stored in it. The store marks the
 * first one itself and keeps the mark (the `first_use` migration), so this never turns true again.
 */
export const firstRun = (db: DatabaseSync): boolean => db.prepare("SELECT 1 FROM first_use").get() === undefined;

/**
 * The owner's settings that Botbench keeps itself, not in the settings file: the mode a new run is given when none is
 * chosen (`GET` and `PUT /api/settings`); and whether the installation is on its first run (`GET /api/first-run`).
 * Returns false when the request is for none of them. Called only for requests the auth gate let through.
 */
export async function settingsRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/first-run") return (json(res, 200, { firstRun: firstRun(ctx.db) }), true);
  if (url.pathname !== "/api/settings") return false;
  try {
    if (req.method === "GET") {
      json(res, 200, { defaultMode: defaultMode(ctx.db, ctx.config.autonomy?.mode) });
    } else if (req.method === "PUT") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
      if (!isObject(body) || !isRunMode(body.defaultMode)) throw new BodyError(400, 'expected { "defaultMode": "manual" | "semi" | "full" }');
      setDefaultMode(ctx.db, body.defaultMode);
      json(res, 200, { defaultMode: body.defaultMode });
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
