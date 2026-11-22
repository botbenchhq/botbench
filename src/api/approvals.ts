import type http from "node:http";
import { actionLog, APPROVAL_STATUSES, ApprovalError, listApprovals, MAX_NOTE, type ApprovalStatus } from "../approvals/broker.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function answer(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, id: number): Promise<void> {
  const body = await readJsonBody(req);
  if (!isObject(body) || (body.decision !== "allow" && body.decision !== "decline")) throw new ApprovalError(400, 'expected { "decision": "allow" | "decline", "note"?: "..." }');
  const { note } = body;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > MAX_NOTE)) throw new ApprovalError(400, `"note" must be text of at most ${MAX_NOTE} characters.`);
  json(res, 200, { approval: ctx.broker.answer(id, body.decision, note ?? null) });
}

/**
 * The approval routes: the approvals (all, or those with one status), the
 * owner's answer to one, and the action log. Returns false when the request is
 * for none of them. Called only for requests the auth gate let through, which
 * is the only way an approval is ever answered.
 */
export async function approvalRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method;
  const one = /^\/api\/approvals\/([1-9]\d{0,14})$/.exec(pathname);
  try {
    if (method === "GET" && pathname === "/api/approvals") {
      const given = url.searchParams.getAll("status");
      if (given.length > 1 || (given.length === 1 && !APPROVAL_STATUSES.includes(given[0] as ApprovalStatus))) throw new ApprovalError(400, `"status" must be one of: ${APPROVAL_STATUSES.join(", ")}.`);
      json(res, 200, { approvals: listApprovals(ctx.db, given[0] as ApprovalStatus | undefined) });
    } else if (method === "POST" && one) {
      await answer(req, res, ctx, Number(one[1]));
    } else if (method === "GET" && pathname === "/api/action-log") {
      const given = url.searchParams.getAll("taskId");
      if (given.length > 1 || (given.length === 1 && !/^[1-9]\d{0,14}$/.test(given[0]!))) throw new ApprovalError(400, '"taskId" must be a task id.');
      json(res, 200, { entries: actionLog(ctx.db, given.length === 1 ? Number(given[0]) : undefined) });
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof ApprovalError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
