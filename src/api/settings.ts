import type http from "node:http";
import { defaultMode, isRunMode, setDefaultMode } from "../engine/modes.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The owner's settings that Botbench keeps itself, not in the settings file: the mode a new run is given when none is
 * chosen (`GET` and `PUT /api/settings`). Returns false when the request is for neither. Called only for requests the
 * auth gate let through.
 */
export async function settingsRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
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
