import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { schemaVersion } from "../store/db.ts";

/** What a route may use. Later units add to this as they add routes. */
export interface RouteContext {
  db: DatabaseSync;
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
 * Every route except sign-in. The server calls this only after the auth gate
 * has let the request through, so nothing here is reachable without a session.
 * A later unit adds its route as another branch.
 */
export async function route(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://smelt.invalid");
  if (req.method === "GET" && pathname === "/health") {
    // Reads the database, so a healthy answer means the store is usable.
    json(res, 200, { status: "ok", schemaVersion: schemaVersion(ctx.db) });
    return;
  }
  json(res, 404, { error: "not found" });
}
