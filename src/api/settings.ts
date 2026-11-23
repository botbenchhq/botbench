import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { chatWebAccess, isWebAccess, setChatWebAccess } from "../approvals/web-access.ts";
import { askEveryCommand, defaultMode, isRunMode, setAskEveryCommand, setDefaultMode } from "../engine/modes.ts";
import { chooseWorkbench, workbenchName, workbenchProblem } from "../workbench.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether this installation is on its first run: no chat, task or run has ever been stored in it. The store marks the
 * first one itself and keeps the mark (the `first_use` migration), so this never turns true again.
 */
export const firstRun = (db: DatabaseSync): boolean => db.prepare("SELECT 1 FROM first_use").get() === undefined;

/**
 * The owner's settings that Botbench keeps itself, not in the settings file: the mode a new run is given when none is
 * chosen, what Claude Code's web tools may do (approvals/web-access.ts), whether every command of a manual run asks
 * ("Ask before every command", engine/modes.ts), and the workbench's name unless the
 * settings file sets it (`GET` and `PUT /api/settings`), each of which may be sent alone; and whether the installation
 * is on its first run (`GET /api/first-run`). Returns false when the request is for none of them. Called only for
 * requests the auth gate let through.
 */
export async function settingsRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/first-run") return (json(res, 200, { firstRun: firstRun(ctx.db) }), true);
  if (url.pathname !== "/api/settings") return false;
  try {
    const current = () => ({ defaultMode: defaultMode(ctx.db, ctx.config.autonomy?.mode), chatWebAccess: chatWebAccess(ctx.db), askEveryCommand: askEveryCommand(ctx.db), workbench: { name: workbenchName(ctx.db), setInFile: ctx.config.workbench !== undefined } });
    if (req.method === "GET") {
      json(res, 200, current());
    } else if (req.method === "PUT") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
      const malformed = 'expected { "defaultMode": "manual" | "semi" | "full" }, { "chatWebAccess": "allow" | "ask" | "off" }, { "askEveryCommand": true | false } or { "workbench": "name" }';
      if (!isObject(body) || (body.defaultMode === undefined && body.workbench === undefined && body.chatWebAccess === undefined && body.askEveryCommand === undefined)) throw new BodyError(400, malformed);
      if (body.defaultMode !== undefined && !isRunMode(body.defaultMode)) throw new BodyError(400, malformed);
      if (body.chatWebAccess !== undefined && !isWebAccess(body.chatWebAccess)) throw new BodyError(400, malformed);
      if (body.askEveryCommand !== undefined && typeof body.askEveryCommand !== "boolean") throw new BodyError(400, malformed);
      if (body.workbench !== undefined) {
        if (ctx.config.workbench !== undefined) throw new BodyError(409, `The settings file names this workbench ${ctx.config.workbench} ("workbench"), so its name is changed there.`);
        const problem = workbenchProblem(body.workbench);
        if (problem !== null) throw new BodyError(400, problem);
      }
      if (isRunMode(body.defaultMode)) setDefaultMode(ctx.db, body.defaultMode);
      if (isWebAccess(body.chatWebAccess)) setChatWebAccess(ctx.db, body.chatWebAccess);
      if (typeof body.askEveryCommand === "boolean") setAskEveryCommand(ctx.db, body.askEveryCommand);
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
