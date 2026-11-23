import type http from "node:http";
import { checkTogetherRequired, checkTogetherView, setCheckTogetherRequired } from "../engine/combined.ts";
import { checkRepository, getTask, TaskError, words } from "../engine/task.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checking a task together with another workbench's open pull request (engine/combined.ts):
 *   GET  /api/tasks/<id>/check-together   the setting, what is running, each result with whether it still stands, and the open pull requests it can be checked with
 *   POST /api/tasks/<id>/check-together   { "pullRequest": N }: the owner's "Check together with pull request #N"; answers 202 once it has started
 *   GET  /api/repos/check-together?path=  whether the owner requires checking together on a repository
 *   PUT  /api/repos/check-together        { "path": "/repo", "required": true | false }: the owner sets or removes it
 * Only requests the auth gate let through get here, so each is the owner's own: a session is the owner's, and nothing
 * an agent runs can hold one (its commands cannot read Botbench's data folder, where the sign-in token is). The setting
 * is written here and nowhere else. Returns false when the request is for none of these.
 */
export async function checkTogetherRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const one = /^\/api\/tasks\/([1-9]\d{0,14})\/check-together$/.exec(url.pathname);
  const setting = url.pathname === "/api/repos/check-together";
  if (one === null && !setting) return false;
  try {
    if (one !== null && req.method === "GET") {
      const task = getTask(ctx.db, Number(one[1]));
      if (task === null) throw new TaskError(404, "No such task.");
      json(res, 200, await checkTogetherView({ db: ctx.db, peers: ctx.peers, checkTogether: ctx.checkTogether, task }));
    } else if (one !== null && req.method === "POST") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
      if (!isObject(body)) throw new TaskError(400, 'expected { "pullRequest": number }');
      const { finished } = await ctx.checkTogether.start(Number(one[1]), body.pullRequest);
      finished.catch((err: unknown) => console.error(`Checking task ${one[1]} together failed: ${words(err)}`));
      json(res, 202, { running: body.pullRequest });
    } else if (setting && req.method === "GET") {
      const given = url.searchParams.getAll("path");
      if (given.length !== 1) throw new TaskError(400, 'Give one "path".');
      const repo = await checkRepository(given[0]);
      json(res, 200, { path: repo, required: checkTogetherRequired(ctx.db, repo) });
    } else if (setting && req.method === "PUT") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
      if (!isObject(body) || typeof body.path !== "string" || typeof body.required !== "boolean") throw new TaskError(400, 'expected { "path": "/full/path", "required": true | false }');
      const repo = await checkRepository(body.path);
      setCheckTogetherRequired(ctx.db, repo, body.required);
      json(res, 200, { path: repo, required: checkTogetherRequired(ctx.db, repo) });
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof TaskError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
