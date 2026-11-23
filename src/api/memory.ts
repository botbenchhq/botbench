import type http from "node:http";
import { editNote, forgetNote, listNotes, MAX_MEMORY_BYTES, MAX_NOTE_CHARS, MemoryError } from "../engine/memory.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const NOTE_ROUTE = /^\/api\/memory\/([1-9][0-9]{0,8})$/;

/**
 * The owner's notes in the workbench memory store (engine/memory.ts), for Settings → Memory: `GET /api/memory` lists
 * them newest first, each with the version an edit or a forget must carry; `PUT /api/memory/<n>` with
 * `{ "text", "hash" }` edits one; `DELETE /api/memory/<n>` with `{ "hash" }` forgets one. A note is named by its number
 * only, so no request names a file. Saving a new note is not here: only the owner's own chat message does that
 * (api/chat.ts). Returns false when the request is for none of them. Called only for requests the auth gate let
 * through.
 */
export async function memoryRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const list = () => ({ notes: listNotes(ctx.home), maxNoteChars: MAX_NOTE_CHARS, maxKb: MAX_MEMORY_BYTES / 1024 });
  try {
    if (pathname === "/api/memory" && req.method === "GET") {
      json(res, 200, list());
      return true;
    }
    const match = NOTE_ROUTE.exec(pathname);
    if (match === null || (req.method !== "PUT" && req.method !== "DELETE")) return false;
    const id = Number(match[1]);
    const body = await readJsonBody(req);
    // voice: not on screen. It names the API's own fields for a caller whose request was malformed; the client never sends one.
    if (req.method === "PUT") {
      if (!isObject(body) || typeof body.text !== "string" || typeof body.hash !== "string") throw new BodyError(400, 'expected { "text": "the note", "hash": "the version it was read at" }');
      json(res, 200, { note: editNote(ctx.db, ctx.home, id, body.text, body.hash) });
    } else {
      if (!isObject(body) || typeof body.hash !== "string") throw new BodyError(400, 'expected { "hash": "the version it was read at" }');
      forgetNote(ctx.db, ctx.home, id, body.hash);
      json(res, 200, list());
    }
  } catch (err) {
    if (err instanceof BodyError || err instanceof MemoryError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
