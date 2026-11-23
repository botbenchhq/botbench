import type http from "node:http";
import { checkRepository, TaskError } from "../engine/task.ts";
import { json, type RouteContext } from "./router.ts";

/** The most repositories the Work screen asks about at once: the ones used most recently. */
const MAX_REPOSITORIES = 10;

/**
 * What other workbenches have in flight, read only: `GET /api/peers?path=<repository>` for one repository (the
 * composer, the task screen), and `GET /api/peers` for each repository the owner has used (the Work screen). Returns
 * false when the request is for neither. Called only for requests the auth gate let through.
 */
export async function peersRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (req.method !== "GET" || url.pathname !== "/api/peers") return false;
  const given = url.searchParams.getAll("path");
  if (given.length > 1) {
    json(res, 400, { error: 'Give one "path".' });
    return true;
  }
  if (given.length === 1) {
    let repo: string;
    try {
      repo = await checkRepository(given[0]);
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      json(res, err.status, { error: err.message });
      return true;
    }
    json(res, 200, { view: await ctx.peers.view(repo) });
    return true;
  }
  const used = ctx.db.prepare(`SELECT repo_path AS repo FROM (SELECT repo_path, created_at FROM tasks UNION ALL SELECT repo_path, created_at FROM runs) GROUP BY repo_path ORDER BY MAX(created_at) DESC LIMIT ${MAX_REPOSITORIES}`).all().map((row) => String(row.repo));
  json(res, 200, { views: await Promise.all(used.map((repo) => ctx.peers.view(repo))) });
  return true;
}
