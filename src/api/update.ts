import type http from "node:http";
import { isUpdateMode, UpdateRefused } from "../update.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Updating Botbench (src/update.ts): `GET /api/update` is the running version, the latest release the last check
 * found and how an update is going; `POST /api/update` starts updating to that release (the owner's "Update now");
 * `PUT /api/update` with `{ "mode": "tap" | "auto" }` saves whether it updates on a tap or by itself. Returns false when
 * the request is for none of them. Called only for requests the auth gate let through.
 */
export async function updateRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/update") return false;
  try {
    if (req.method === "GET") {
      json(res, 200, ctx.updates.status());
    } else if (req.method === "POST") {
      ctx.updates.start();
      json(res, 202, ctx.updates.status());
    } else if (req.method === "PUT") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own field for a caller whose request was malformed.
      if (!isObject(body) || !isUpdateMode(body.mode)) throw new BodyError(400, 'expected { "mode": "tap" | "auto" }');
      ctx.updates.setMode(body.mode);
      json(res, 200, ctx.updates.status());
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError) json(res, err.status, { error: err.message });
    else if (err instanceof UpdateRefused) json(res, 409, { error: err.message });
    else throw err;
  }
  return true;
}
