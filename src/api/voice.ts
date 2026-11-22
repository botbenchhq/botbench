import type http from "node:http";
import { audioFormat, DictationError } from "../dictation/dictation.ts";
import { sessionOf, TRANSCRIBE_PATH } from "./auth.ts";
import { json, type RouteContext } from "./router.ts";

/** The largest recording taken: five minutes of what a phone records is well under it. */
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024;

/** Signed-in devices with a transcription under way; one at a time each. */
const busy = new Set<string>();

/**
 * The dictation routes: whether dictation works on this Mac, and a recording turned into text. The text is answered and
 * forgotten: nothing about the recording or what was said is stored or logged. Returns false for any other request.
 */
export async function voiceRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/voice") {
    json(res, 200, await ctx.dictation.status());
    return true;
  }
  if (req.method !== "POST" || url.pathname !== TRANSCRIBE_PATH) return false;
  // The gate has checked the content type and the session; both are read again here so this route stands on its own.
  const format = audioFormat(req.headers["content-type"]);
  const session = sessionOf(req);
  if (format === null || session === undefined) return (json(res, 415, { error: "body must be a recording: audio/mp4, audio/webm, audio/ogg or audio/wav" }), true);
  if (busy.has(session)) return (json(res, 409, { error: "A recording from this device is already being transcribed. Wait for it to finish." }), true);
  busy.add(session);
  try {
    json(res, 200, { text: await ctx.dictation.transcribeUpload(req as AsyncIterable<Buffer>, format, ctx.maxRecordingBytes ?? MAX_RECORDING_BYTES) });
  } catch (err) {
    if (!(err instanceof DictationError)) throw err;
    json(res, err.status, { error: err.message });
  } finally {
    busy.delete(session);
  }
  return true;
}
