import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CHAT_ROLE, type Admission, type Broker } from "../approvals/broker.ts";
import { summarize } from "../approvals/gate.ts";
import type { Driver, DriverProbe, DriverSession } from "../drivers/contract.ts";
import type { TurnEndReason } from "../drivers/events.ts";

export const SCRATCH_DIR = "scratch";
export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;

/** A request that cannot be met; `status` is the HTTP answer for it. */
export class TurnError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Turns {
  probe(): Promise<DriverProbe>;
  /**
   * Send a prompt. Without `attemptId` a new attempt starts. With one, the
   * turn goes to that attempt's session if it is still open; otherwise a new
   * attempt resumes it from its stored cursor, and the returned id is the new one.
   * Resolves as soon as the turn has been handed to the CLI.
   * `model` is the model asked for: a name, null for the CLI's own default, or left out for the configured one.
   * An open session keeps the model it was started on, so a turn that asks for another one continues the
   * conversation in a new attempt on that model. `onAttempt` is called with a new attempt's id before its prompt is sent.
   */
  start(prompt: string, attemptId?: number, model?: string | null, onAttempt?: (attemptId: number) => void): Promise<{ attemptId: number; turn: number }>;
  /** Stop the attempt's running turn. Resolves once it has ended. */
  interrupt(attemptId: number): Promise<void>;
  /** Whether a turn is running in the attempt right now. */
  turnRunning(attemptId: number): boolean;
  /** Whether any turn is running now. */
  anyRunning(): boolean;
  /** Close every open session, leaving no CLI process behind. */
  close(): Promise<void>;
}

interface Open {
  session: DriverSession;
  /** The attempt's right to ask through the permission broker. */
  admission: Admission;
  /** The model the session was started with; undefined for the CLI's own default. */
  model: string | undefined;
  busy: boolean;
  idle?: NodeJS.Timeout;
}

/**
 * Turns outside any repository: Claude Code in a chat. Every attempt works in one folder inside Botbench's own data
 * directory, the chat's folder, confined, its commands with no network. What the CLI would ask a person goes through
 * the permission broker as a chat's request (approvals/broker.ts): the owner answers it on the chat's screen, and the
 * turn waits until then. A chat has no grant; its web tools follow the owner's setting "Web access in chat".
 */
export function createTurns(options: { db: DatabaseSync; home: string; driver: Driver; broker: Broker; model?: string; onEvent: () => void; idleCloseMs?: number }): Turns {
  const { db, driver } = options;
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const scratch = path.join(options.home, SCRATCH_DIR);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  fs.chmodSync(scratch, 0o700);
  // The resolved path: Claude Code keys a session by it, and a resumed attempt must be in the same place.
  const cwd = fs.realpathSync(scratch);

  const open = new Map<number, Open>();
  let closed = false;

  const attemptRow = (id: number) => db.prepare("SELECT status, resume_cursor FROM attempts WHERE id = ?").get(id);

  // Sessions on their way out. A session writes to the database until its process is gone, so shutdown waits for these too.
  const closing = new Set<Promise<void>>();
  const closingById = new Map<number, Promise<void>>();
  /** Close a session and wait until its process is gone, also when another caller already began closing it. */
  const drop = async (id: number): Promise<void> => {
    const entry = open.get(id);
    if (!entry) return closingById.get(id);
    open.delete(id);
    clearTimeout(entry.idle);
    // Once the process is gone, nothing of the attempt is left waiting for the owner.
    const done = entry.session.close().finally(() => entry.admission.release());
    closing.add(done);
    closingById.set(id, done);
    try {
      await done;
    } finally {
      closing.delete(done);
      closingById.delete(id);
    }
  };

  const lastTurn = (id: number): number => Number(db.prepare("SELECT coalesce(max(turn), 0) AS turn FROM events WHERE attempt_id = ?").get(id)!.turn);

  const send = (id: number, entry: Open, prompt: string): { attemptId: number; turn: number } => {
    clearTimeout(entry.idle);
    entry.busy = true;
    const before = lastTurn(id);
    // The driver stores the prompt before this returns, so the turn's number can be read back.
    const done = entry.session.sendTurn(prompt);
    const settle = (reason?: TurnEndReason): void => {
      entry.busy = false;
      // After any turn that ended in an error (a model the CLI does not know, for one) the process is not kept;
      // the conversation continues from its cursor in a new attempt.
      if (reason === "error") return void drop(id).catch(() => {});
      // An idle CLI process is not kept for ever: the attempt can be resumed from its cursor.
      entry.idle = setTimeout(() => void drop(id).catch(() => {}), idleCloseMs);
      entry.idle.unref();
    };
    done.then(settle, () => settle());
    const turn = lastTurn(id);
    // No new turn in the store means the session refused the prompt (its CLI has just gone): say so, do not pretend.
    if (turn === before) throw new TurnError(409, "The prompt was not accepted: the session has ended. Send it again to continue in a new one.");
    return { attemptId: id, turn };
  };

  // Attempts being started. Shutdown waits for them, so none comes up after the database has closed.
  const starting = new Set<Promise<unknown>>();
  const begin = async (prompt: string, model: string | undefined, resumeCursor?: string, onAttempt?: (attemptId: number) => void): Promise<{ attemptId: number; turn: number }> => {
    const admission = options.broker.admit({ chat: true, role: CHAT_ROLE, worktree: cwd, confined: driver.capabilities.confinedCommands === true });
    // A chat works in no repository: its commands reach no network. What the CLI would ask goes through the gate.
    const launching = driver.startAttempt({ db, cwd, gate: { socketPath: admission.socketPath, secret: admission.secret }, confinement: { dataDir: options.home, allowedHosts: [] }, ...(model ? { model } : {}), ...(resumeCursor ? { resumeCursor } : {}) });
    starting.add(launching);
    let session: DriverSession;
    try {
      session = await launching.finally(() => starting.delete(launching));
    } catch (err) {
      admission.release();
      throw err;
    }
    admission.bind(session.attemptId);
    if (closed) {
      const done = session.close().finally(() => admission.release());
      closing.add(done);
      await done.finally(() => closing.delete(done));
      throw new TurnError(503, "Botbench is shutting down.");
    }
    /** Permission requests the CLI is still waiting on, by request id. */
    const asking = new Set<string>();
    const attemptId = session.attemptId;
    session.onEvent((event) => {
      if (event.type === "permission_request") {
        asking.add(event.id);
        // The broker never rejects: whatever fails on the way to the owner comes back as a decline.
        void options.broker
          .request({ taskId: null, chat: true, attemptId, role: CHAT_ROLE, tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
          // A request the CLI has stopped waiting for has no one to tell.
          .then((answer) => (asking.has(event.id) ? session.respondToRequest(event.id, { decision: answer.decision, note: answer.note, refused: answer.refused, files: answer.files !== undefined, web: answer.web !== undefined, chat: answer.chat !== undefined, bookkeeping: answer.bookkeeping !== undefined }) : undefined))
          .catch((err: unknown) => console.error(`Answering a permission request of chat attempt ${attemptId} failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      if (event.type === "permission_resolved") {
        asking.delete(event.id);
        // The CLI gave up on the request (the turn was stopped): its card must not stay answerable.
        if (event.decision === "cancelled") admission.supersede(event.toolCallId);
      }
    });
    session.onEvent(options.onEvent);
    const entry: Open = { session, admission, model, busy: false };
    open.set(session.attemptId, entry);
    onAttempt?.(session.attemptId);
    return send(session.attemptId, entry, prompt);
  };

  const start = async (prompt: string, attemptId?: number, choice?: string | null, onAttempt?: (attemptId: number) => void): Promise<{ attemptId: number; turn: number }> => {
    if (closed) throw new TurnError(503, "Botbench is shutting down.");
    const model = choice === undefined ? options.model : (choice ?? undefined);
    if (attemptId === undefined) return begin(prompt, model, undefined, onAttempt);
    const row = attemptRow(attemptId);
    if (!row) throw new TurnError(404, "Botbench has no record of that conversation.");
    const entry = open.get(attemptId);
    if (entry?.busy) throw new TurnError(409, "Claude Code is still working on the last message. Wait for it to finish, or stop it.");
    if (entry && row.status === "running" && (choice === undefined || entry.model === model)) return send(attemptId, entry, prompt);
    // The session is over (stopped, failed, closed while idle, or from before a restart), or another model was asked for: continue it in a new attempt.
    await drop(attemptId);
    if (closed) throw new TurnError(503, "Botbench is shutting down.");
    if (typeof row.resume_cursor !== "string" || row.resume_cursor === "") throw new TurnError(409, "This conversation cannot be continued: it ended before Claude Code saved its place. Start a new chat.");
    return begin(prompt, model, row.resume_cursor, onAttempt);
  };

  const interrupt = async (attemptId: number): Promise<void> => {
    if (!attemptRow(attemptId)) throw new TurnError(404, "Botbench has no record of that conversation.");
    const entry = open.get(attemptId);
    if (!entry?.busy) throw new TurnError(409, "Nothing is running in this conversation, so there is nothing to stop.");
    await entry.session.interruptTurn();
  };

  const close = async (): Promise<void> => {
    closed = true;
    await Promise.allSettled([...starting]);
    await Promise.allSettled([...open.keys()].map((id) => drop(id)));
    await Promise.allSettled([...closing]);
  };

  return { probe: () => driver.probe(), start, interrupt, turnRunning: (id) => open.get(id)?.busy === true, anyRunning: () => [...open.values()].some((e) => e.busy), close };
}
