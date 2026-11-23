import type http from "node:http";
import { defaultMode, isRunMode, setDefaultMode } from "../engine/modes.ts";
import { chooseWorkbench, workbenchName, workbenchProblem } from "../workbench.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The owner's settings that Botbench keeps itself, not in the settings file: the mode a new run is given when none is
 * chosen, and the workbench's name unless the settings file sets it (`GET` and `PUT /api/settings`). Either may be
 * sent alone. Returns false when the request is for neither. Called only for requests the
 * auth gate let through.
 */
export async function settingsRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/settings") return false;
  try {
    const current = () => ({ defaultMode: defaultMode(ctx.db, ctx.config.autonomy?.mode), workbench: { name: workbenchName(ctx.db), setInFile: ctx.config.workbench !== undefined } });
    if (req.method === "GET") {
      json(res, 200, current());
    } else if (req.method === "PUT") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
      const malformed = 'expected { "defaultMode": "manual" | "semi" | "full" } or { "workbench": "name" }';
      if (!isObject(body) || (body.defaultMode === undefined && body.workbench === undefined)) throw new BodyError(400, malformed);
      if (body.defaultMode !== undefined && !isRunMode(body.defaultMode)) throw new BodyError(400, malformed);
      if (body.workbench !== undefined) {
        if (ctx.config.workbench !== undefined) throw new BodyError(409, `The settings file names this workbench ${ctx.config.workbench} ("workbench"), so its name is changed there.`);
        const problem = workbenchProblem(body.workbench);
        if (problem !== null) throw new BodyError(400, problem);
      }
      if (isRunMode(body.defaultMode)) setDefaultMode(ctx.db, body.defaultMode);
      if (body.workbench !== undefined) chooseWorkbench(ctx.db, body.workbench, "owner");
      json(res, 200, current());
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
