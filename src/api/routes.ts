import { maxRefineRounds } from "../config.ts";
import type http from "node:http";
import { CLAUDE_CODE } from "../drivers/claude-code.ts";
import { DriverUnavailableError, type Driver } from "../drivers/contract.ts";
import { IMPLEMENTER, PLANNER, REVIEWER, roleProblem } from "../engine/roles.ts";
import { chatScopeWords } from "./chat.ts";
import { BodyError, json, modelChoice, readJsonBody, type RouteContext } from "./router.ts";
import { eventsAfter, parseEventId } from "./stream.ts";
import { TurnError } from "./turns.ts";
import { usageReport } from "../usage.ts";
import type { BillingKind } from "../drivers/contract.ts";

/** The steps an agent can work in here, by the names a screen uses: the main agent plans and builds, a reviewer reviews. */
function agentRoles(ctx: RouteContext, agent: Driver): string[] {
  const roles: string[] = [];
  if (agent === ctx.driver) {
    if (roleProblem(PLANNER, agent.name, agent.capabilities) === null) roles.push("planner");
    if (roleProblem(IMPLEMENTER, agent.name, agent.capabilities) === null) roles.push("builder");
  }
  if (ctx.reviewers[agent.name] === agent && roleProblem(REVIEWER, agent.name, agent.capabilities) === null) roles.push("reviewer");
  return roles;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function startTurn(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!isObject(body) || typeof body.prompt !== "string" || body.prompt.trim() === "") return json(res, 400, { error: 'expected { "prompt": "...", "attemptId"?: number, "model"?: string | null }' });
  const model = modelChoice(body);
  const { attemptId } = body;
  if (attemptId !== undefined && !(typeof attemptId === "number" && Number.isSafeInteger(attemptId) && attemptId > 0)) return json(res, 400, { error: '"attemptId" must be an attempt id' });
  json(res, 200, await ctx.turns.start(body.prompt, attemptId, model));
}

/** POST /api/chat: one message, or a request to compare a round's answers, to one agent or several. */
async function sendChat(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(req);
  const shape = 'expected { "prompt": "...", "conversation": [ids of the earlier replies], "agents": [{ "agent": "codex", "model"?: string | null }], "compare"?: round id, "repository"?: "/full/path" }';
  if (!isObject(body) || !Array.isArray(body.conversation) || !Array.isArray(body.agents)) return json(res, 400, { error: shape });
  const compare = body.compare;
  if (compare !== undefined && !(typeof compare === "number" && Number.isSafeInteger(compare) && compare > 0)) return json(res, 400, { error: '"compare" must be the id of the answers to compare' });
  if (compare === undefined && (typeof body.prompt !== "string" || body.prompt.trim() === "")) return json(res, 400, { error: shape });
  if (!body.conversation.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return json(res, 400, { error: '"conversation" must be a list of ids' });
  const agents = body.agents.map((a) => {
    if (!isObject(a) || typeof a.agent !== "string") throw new BodyError(400, shape);
    return { agent: a.agent, model: modelChoice(a) };
  });
  const { repository } = body;
  if (repository !== undefined && typeof repository !== "string") return json(res, 400, { error: '"repository" must be the full path of a repository' });
  json(res, 200, { replies: await ctx.chat.send({ message: typeof body.prompt === "string" ? body.prompt : "", conversation: body.conversation as number[], agents, ...(compare === undefined ? {} : { compare }), ...(repository === undefined ? {} : { repository }) }) });
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
    } else if (method === "GET" && pathname === "/api/usage") {
      // The sign-in kind is the agent's own account of it; when it cannot say, it is unknown and only tokens are shown.
      const billing: Record<string, BillingKind> = { [CLAUDE_CODE]: await ctx.turns.probe().then((probe) => probe.billing, () => "unknown" as const) };
      json(res, 200, usageReport(ctx.db, { now: Date.now(), drivers: Object.keys(ctx.config.drivers), billing }));
    } else if (method === "GET" && pathname === "/api/agents") {
      // Each agent as its last check found it (kept for a short time, src/api/agents.ts), and the steps Botbench lets it work in.
      // "?fresh=1" waits for a check that ends after the request; otherwise a recent check answers at once.
      const fresh = url.searchParams.get("fresh") === "1";
      const check = fresh ? { ...(await ctx.agentChecks.fresh()), checking: false } : await ctx.agentChecks.read();
      const byName = new Map([ctx.driver, ...Object.values(ctx.reviewers)].filter((d): d is Driver => d !== undefined).map((d) => [d.name, d]));
      const agents = check.agents.map((a) => ({ ...a, roles: agentRoles(ctx, byName.get(a.agent)!), chat: chatScopeWords(byName.get(a.agent)!) }));
      // With the cap on rounds of fixes a run started now gets, which New run shows beside Review.
      json(res, 200, { agents, checkedAt: check.checkedAt, checking: check.checking, maxRefineRounds: maxRefineRounds(ctx.config) });
    } else if (method === "GET" && /^\/api\/agents\/[a-z-]{1,40}\/models$/.test(pathname)) {
      const name = pathname.split("/")[3]!;
      const reviewer = Object.hasOwn(ctx.reviewers, name) ? ctx.reviewers[name] : undefined;
      if (reviewer === undefined) return (json(res, 404, { error: "Botbench offers no such agent to choose a model for." }), true);
      json(res, 200, { driver: reviewer.name, ...(await reviewer.models()) });
    } else if (method === "GET" && pathname === "/api/stream") {
      ctx.stream.handle(req, res);
    } else if (method === "POST" && pathname === "/api/turns") {
      await startTurn(req, res, ctx);
    } else if (method === "POST" && pathname === "/api/chat") {
      await sendChat(req, res, ctx);
    } else if (method === "POST" && /^\/api\/turns\/\d{1,15}\/interrupt$/.test(pathname)) {
      const attemptId = Number(pathname.split("/")[3]);
      if (!(await ctx.chat.interrupt(attemptId))) await ctx.turns.interrupt(attemptId);
      json(res, 200, { interrupted: true });
    } else if (method === "GET" && /^\/api\/attempts\/\d{1,15}\/events$/.test(pathname)) {
      const attemptId = Number(pathname.split("/")[3]);
      const after = url.searchParams.has("after") ? parseEventId(url.searchParams.get("after")!) : 0;
      if (after === null) return (json(res, 400, { error: '"after" must be an event id' }), true);
      const attempt = ctx.db.prepare("SELECT status FROM attempts WHERE id = ?").get(attemptId);
      if (!attempt) return (json(res, 404, { error: "Botbench has no record of that conversation" }), true);
      const info = ctx.chat.info(attemptId);
      json(res, 200, { attemptId, status: attempt.status, turnRunning: ctx.turns.turnRunning(attemptId) || ctx.chat.turnRunning(attemptId), agent: info?.agent ?? CLAUDE_CODE, model: info?.model ?? null, round: info?.round ?? null, events: eventsAfter(ctx.db, after, attemptId) });
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
