import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { schemaVersion } from "../store/db.ts";
import type { Broker } from "../approvals/broker.ts";
import type { Config } from "../config.ts";
import type { Connect } from "../drivers/connect.ts";
import type { Dictation } from "../dictation/dictation.ts";
import { modelNameProblem, type Driver } from "../drivers/contract.ts";
import type { Deliveries } from "../engine/delivery.ts";
import type { Runs } from "../engine/run.ts";
import type { Tasks } from "../engine/task.ts";
import type { Push } from "../push.ts";
import { approvalRoutes } from "./approvals.ts";
import { boardRoutes } from "./board.ts";
import { pushRoutes } from "./push.ts";
import { connectRoutes } from "./connect.ts";
import { turnRoutes } from "./routes.ts";
import { runRoutes } from "./runs.ts";
import { settingsRoutes } from "./settings.ts";
import { isShellRequest, serveShell } from "./static.ts";
import type { EventStream } from "./stream.ts";
import { taskRoutes } from "./tasks.ts";
import { voiceRoutes } from "./voice.ts";
import { issueRoutes } from "./issues.ts";
import { peersRoutes } from "./peers.ts";
import type { Peers } from "../engine/peers.ts";
import type { CheckTogether } from "../engine/combined.ts";
import { checkTogetherRoutes } from "./check-together.ts";
import type { GitHub } from "../github.ts";
import type { Turns } from "./turns.ts";
import type { Chat } from "./chat.ts";
import type { AgentChecks } from "./agents.ts";

/** What a route may use. Later units add to this as they add routes. */
export interface RouteContext {
  db: DatabaseSync;
  config: Config;
  driver: Driver;
  /** The agents that can review a run's tasks, by name. */
  reviewers: Partial<Record<string, Driver>>;
  turns: Turns;
  /** The agents' last checks, kept for a short time. */
  agentChecks: AgentChecks;
  /** Chat with any agent, or several at once. */
  chat: Chat;
  tasks: Tasks;
  runs: Runs;
  broker: Broker;
  stream: EventStream;
  /** Notifications to the owner's devices. */
  push: Push;
  /** Connecting and disconnecting agents from Settings. */
  connect: Connect;
  /** Speech to text on this Mac, for the message box's microphone. */
  dictation: Dictation;
  /** The largest recording taken, when not the default (tests set a small one). */
  maxRecordingBytes?: number;
  /** Pushing accepted tasks' branches and opening their pull requests. */
  deliveries: Deliveries;
  /** What Botbench asks of GitHub through the owner's gh: pull requests, and reading an issue. */
  github: GitHub;
  /** Other workbenches' work on a repository's shared remote, read only. */
  peers: Peers;
  /** Checking a task together with another workbench's open pull request, and the owner's setting that requires it. */
  checkTogether: CheckTogether;
  /** Where the built client is. */
  clientDir: string;
}

/**
 * The request's address as a URL. A path is taken as written, so one that
 * starts with two slashes stays a path and is not read as a host name.
 */
export function requestUrl(req: http.IncomingMessage): URL {
  const raw = req.url ?? "/";
  try {
    return raw.startsWith("/") ? new URL(`http://botbench.invalid${raw}`) : new URL(raw, "http://botbench.invalid");
  } catch {
    // A target that is no address at all names no route, so it is treated as one: refused without a session, 404 with.
    return new URL("http://botbench.invalid/unreadable-request-target");
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
  // A HEAD reply carries the headers of the GET it stands for and no body.
  res.end(res.req.method === "HEAD" ? undefined : text);
}

/** Thrown by `readJsonBody`; `status` is the HTTP answer for it. */
export class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Read a request body as JSON, refusing one larger than `maxBytes`. */
export async function readJsonBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError(400, "body is not valid JSON");
  }
}

/**
 * The model a request asks for: a name, null for the CLI's own default, or undefined when the request names none
 * and the configured one applies. Anything that is not a plain model name is refused here, before the request does
 * anything else, because the name becomes an argument of the CLI.
 */
export function modelChoice(body: Record<string, unknown>): string | null | undefined {
  const { model } = body;
  if (model === undefined || model === null) return model;
  const problem = modelNameProblem(model);
  if (problem !== null) throw new BodyError(400, `"model" is not a model name. ${problem}`);
  return model as string;
}

/**
 * Refuse a task or run asked of an agent other than Claude Code: only Claude Code builds in a repository here. A request
 * that names none is Claude Code's.
 */
export function builderOnly(body: Record<string, unknown>): void {
  if (body.agent !== undefined && body.agent !== "claude-code") throw new BodyError(400, "Only Claude Code can work in a repository. Codex, Grok and Antigravity answer in a chat with no repository, from the conversation alone.");
}

/**
 * Every route except sign-in. The server calls this only after the auth gate
 * has let the request through, so nothing here is reachable without a session
 * except the client shell, which holds no data.
 * A later unit adds its route as another branch.
 */
export async function route(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const url = requestUrl(req);
  const { pathname } = url;
  if (isShellRequest(req.method, pathname)) return serveShell(req, res, ctx.clientDir, pathname);
  if (req.method === "GET" && pathname === "/health") {
    // Reads the database, so a healthy answer means the store is usable.
    json(res, 200, { status: "ok", schemaVersion: schemaVersion(ctx.db) });
    return;
  }
  if (await turnRoutes(req, res, ctx, url)) return;
  if (await checkTogetherRoutes(req, res, ctx, url)) return;
  if (await taskRoutes(req, res, ctx, url)) return;
  if (await runRoutes(req, res, ctx, url)) return;
  if (await issueRoutes(req, res, ctx, url)) return;
  if (await settingsRoutes(req, res, ctx, url)) return;
  if (await peersRoutes(req, res, ctx, url)) return;
  if (await approvalRoutes(req, res, ctx, url)) return;
  if (boardRoutes(req, res, ctx, url)) return;
  if (await pushRoutes(req, res, ctx, url)) return;
  if (await connectRoutes(req, res, ctx, url)) return;
  if (await voiceRoutes(req, res, ctx, url)) return;
  json(res, 404, { error: "not found" });
}
