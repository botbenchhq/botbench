import type http from "node:http";
import { actionLog, actionLogPage, APPROVAL_STATUSES, ApprovalError, listApprovals, MAX_LOG_PAGE, MAX_NOTE, type ApprovalStatus } from "../approvals/broker.ts";
import { listStanding } from "../approvals/grants.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** An id is 1 to 15 digits with no leading zero, so it is always a number SQLite stores exactly. */
const ID = /^[1-9]\d{0,14}$/;

async function answer(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, id: number): Promise<void> {
  const body = await readJsonBody(req);
  // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
  if (!isObject(body) || (body.decision !== "allow" && body.decision !== "decline")) throw new ApprovalError(400, 'expected { "decision": "allow" | "decline", "note"?: "...", "standing"?: true }');
  const { note, standing } = body;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > MAX_NOTE)) throw new ApprovalError(400, `"note" must be text of at most ${MAX_NOTE} characters.`);
  if (standing !== undefined && typeof standing !== "boolean") throw new ApprovalError(400, '"standing" must be true or false.');
  if (standing === true && body.decision !== "allow") throw new ApprovalError(400, '"standing" goes with the decision "allow" only.');
  // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
  if (standing === true && typeof note === "string" && note.trim() !== "") throw new ApprovalError(400, 'A note goes with a decline; "standing" takes none.');
  // The flag asks; the broker decides, from its own records, whether this request may be given standing permission.
  if (standing === true) json(res, 200, ctx.broker.grantStanding(id));
  else json(res, 200, { approval: ctx.broker.answer(id, body.decision, note ?? null) });
}

/** One query parameter that may be given once: its value, or undefined when absent. Anything else is refused with `problem`. */
function single(url: URL, name: string, shape: RegExp, problem: string): string | undefined {
  const given = url.searchParams.getAll(name);
  if (given.length > 1 || (given.length === 1 && !shape.test(given[0]!))) throw new ApprovalError(400, problem);
  return given[0];
}

/**
 * The approval routes: the approvals (all, or those with one status), the owner's answer to one, the standing
 * permissions and taking one back, and the action log. Returns false when the request is for none of them.
 * Called only for requests the auth gate let through, which is the only way an approval is ever answered and
 * a standing permission given or taken back.
 */
export async function approvalRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method;
  const one = /^\/api\/approvals\/([1-9]\d{0,14})$/.exec(pathname);
  const reply = /^\/api\/approvals\/([1-9]\d{0,14})\/answer$/.exec(pathname);
  const revoke = /^\/api\/grants\/([1-9]\d{0,14})\/revoke$/.exec(pathname);
  try {
    if (method === "GET" && pathname === "/api/approvals") {
      const given = url.searchParams.getAll("status");
      if (given.length > 1 || (given.length === 1 && !APPROVAL_STATUSES.includes(given[0] as ApprovalStatus))) throw new ApprovalError(400, `"status" must be one of: ${APPROVAL_STATUSES.join(", ")}.`);
      // A pending card that may offer standing permission carries the offer: the scope the grant would have.
      const approvals = listApprovals(ctx.db, given[0] as ApprovalStatus | undefined).map((approval) => {
        const standingOffer = approval.status === "pending" ? ctx.broker.standingOffer(approval.id) : null;
        return standingOffer === null ? approval : { ...approval, standingOffer };
      });
      json(res, 200, { approvals });
    } else if (method === "POST" && one) {
      await answer(req, res, ctx, Number(one[1]));
    } else if (method === "POST" && reply) {
      // The owner's answer to an agent's question: their own text, which the broker checks, stores as given and only ever hands the agent.
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields for a caller whose request was malformed; the client never sends one.
      if (!isObject(body) || typeof body.answer !== "string") throw new ApprovalError(400, 'expected { "answer": "..." }');
      json(res, 200, { approval: ctx.broker.answerQuestion(Number(reply[1]), body.answer) });
    } else if (method === "GET" && pathname === "/api/grants") {
      json(res, 200, { grants: listStanding(ctx.db), offerStandingAfter: ctx.broker.offerStandingAfter });
    } else if (method === "POST" && revoke) {
      // The body says nothing; it is read so that a write is always a whole JSON request.
      await readJsonBody(req);
      json(res, 200, { revoked: ctx.broker.revokeStanding(Number(revoke[1])) });
    } else if (method === "GET" && pathname === "/api/action-log") {
      const task = single(url, "taskId", ID, '"taskId" must be a task id.');
      const before = single(url, "before", ID, '"before" must be the id of a log entry.');
      const limit = single(url, "limit", /^[1-9]\d{0,2}$/, `"limit" must be a whole number from 1 to ${MAX_LOG_PAGE}.`);
      if (limit !== undefined && Number(limit) > MAX_LOG_PAGE) throw new ApprovalError(400, `"limit" must be a whole number from 1 to ${MAX_LOG_PAGE}.`);
      const taskId = task === undefined ? undefined : Number(task);
      // Without paging: everything, oldest first. With it: one page, newest first, and whether older entries exist.
      if (before === undefined && limit === undefined) json(res, 200, { entries: actionLog(ctx.db, taskId) });
      else json(res, 200, actionLogPage(ctx.db, { ...(before === undefined ? {} : { before: Number(before) }), ...(limit === undefined ? {} : { limit: Number(limit) }), ...(taskId === undefined ? {} : { taskId }) }));
    } else {
      return false;
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof ApprovalError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
