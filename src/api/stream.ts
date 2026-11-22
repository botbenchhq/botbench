import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { DriverEvent } from "../drivers/events.ts";
import { json } from "./router.ts";

/** One stored event as the client receives it, from the stream or from a transcript request. */
export interface StoredEvent {
  attemptId: number;
  /** The row id in `events`. Ids only grow, so "everything after id N" is a complete answer. */
  id: number;
  turn: number;
  /** When the event was stored, as the database has it. */
  ts: string;
  type: DriverEvent["type"];
  payload: DriverEvent;
}

function toStored(row: Record<string, unknown>): StoredEvent {
  return { attemptId: Number(row.attempt_id), id: Number(row.id), turn: Number(row.turn), ts: String(row.ts), type: String(row.type) as DriverEvent["type"], payload: JSON.parse(String(row.payload)) as DriverEvent };
}

/** Stored events with an id above `after`, oldest first; one attempt's, or everyone's. */
export function eventsAfter(db: DatabaseSync, after: number, attemptId?: number): StoredEvent[] {
  const rows =
    attemptId === undefined
      ? db.prepare("SELECT id, attempt_id, turn, ts, type, payload FROM events WHERE id > ? ORDER BY id").all(after)
      : db.prepare("SELECT id, attempt_id, turn, ts, type, payload FROM events WHERE attempt_id = ? AND id > ? ORDER BY id").all(attemptId, after);
  return rows.map(toStored);
}

/** Read an event id a client sent. Null when it is not a whole number from 0 up. */
export function parseEventId(text: string): number | null {
  return /^\d{1,15}$/.test(text) ? Number(text) : null;
}

export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface EventStream {
  /** Answer `GET /api/stream`. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): void;
  /** Tell the stream that events were stored. It reads them from the database and sends each client what it has not had. */
  notify(): void;
  /** Tell every client that a task reached a state. Clients read the task itself from its route. */
  announceTask(task: { id: number; status: string; attemptId: number | null }): void;
  /** Tell every client that an approval was asked for or answered. Clients read the approvals from their route. */
  announceApproval(approval: { id: number; taskId: number | null; runId: number | null; status: string }): void;
  /** Tell every client that a run reached a state or its plan changed. Clients read the run itself from its route. */
  announceRun(run: { id: number; status: string }): void;
  clients(): number;
  /** End every open stream. */
  close(): void;
}

/**
 * The one server-sent-events stream. It sends rows of the `events` table and
 * nothing else: a client's place in the stream is the id of the last row it
 * was sent, the same number the SSE `id:` field carries. A client that
 * reconnects with `Last-Event-ID` (or `?after=` on its first connection, where
 * a browser cannot set the header) is sent every row after that id from the
 * database and then stays live, so it sees no gap and no repeat. Stored events
 * are unnamed SSE messages. The named events are `heartbeat`, `task`, `run` and
 * `approval`: an announcement says which task or approval changed and carries
 * no id, so it never moves a client's place. A client that was away reads the
 * task or the pending approvals from their routes.
 */
export function createEventStream(db: DatabaseSync, heartbeatMs = DEFAULT_HEARTBEAT_MS): EventStream {
  const cursors = new Map<http.ServerResponse, number>();

  const send = (res: http.ServerResponse, events: StoredEvent[]): void => {
    for (const event of events) {
      if (event.id <= cursors.get(res)!) continue;
      // JSON.stringify leaves no raw newline, so one event is always one data line.
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      cursors.set(res, event.id);
    }
  };

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const header = req.headers["last-event-id"];
    const query = new URL(req.url ?? "/", "http://smelt.invalid").searchParams.get("after");
    // The header is the browser's own account of what it last received, so it wins over the address it first connected with.
    const given = typeof header === "string" ? header : query;
    const newest = Number(db.prepare("SELECT coalesce(max(id), 0) AS id FROM events").get()!.id);
    let after = newest;
    if (given !== null) {
      const parsed = parseEventId(given);
      if (parsed === null) return json(res, 400, { error: "Last-Event-ID and after must be an event id" });
      after = parsed;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.write("retry: 1000\n: connected\n\n");
    cursors.set(res, after);
    if (after < newest) send(res, eventsAfter(db, after));
    // A comment keeps the connection open through anything in between; the named event lets the client
    // see that the stream is alive, so it can tell a silent stream from a dead one. Neither carries an id.
    const heartbeat = setInterval(() => res.write(": heartbeat\nevent: heartbeat\ndata: {}\n\n"), heartbeatMs);
    heartbeat.unref();
    res.on("close", () => {
      clearInterval(heartbeat);
      cursors.delete(res);
    });
  };

  const notify = (): void => {
    if (cursors.size === 0) return;
    const events = eventsAfter(db, Math.min(...cursors.values()));
    for (const res of cursors.keys()) send(res, events);
  };

  const announceTask = (task: { id: number; status: string; attemptId: number | null }): void => {
    const frame = `event: task\ndata: ${JSON.stringify({ taskId: task.id, status: task.status, attemptId: task.attemptId })}\n\n`;
    for (const res of cursors.keys()) res.write(frame);
  };

  const announceRun = (run: { id: number; status: string }): void => {
    const frame = `event: run\ndata: ${JSON.stringify({ runId: run.id, status: run.status })}\n\n`;
    for (const res of cursors.keys()) res.write(frame);
  };

  const announceApproval = (approval: { id: number; taskId: number | null; runId: number | null; status: string }): void => {
    // Which approval and where it stands, and nothing of the command: the card is read from its route.
    const frame = `event: approval\ndata: ${JSON.stringify({ approvalId: approval.id, taskId: approval.taskId, runId: approval.runId, status: approval.status })}\n\n`;
    for (const res of cursors.keys()) res.write(frame);
  };

  const close = (): void => {
    for (const res of [...cursors.keys()]) res.destroy();
    cursors.clear();
  };

  return { handle, notify, announceTask, announceRun, announceApproval, clients: () => cursors.size, close };
}
