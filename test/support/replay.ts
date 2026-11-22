import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import type { Driver, DriverCapabilities, DriverProbe, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import type { DriverEvent, PermissionResponse, TurnEndReason } from "../../src/drivers/events.ts";

/*
 * Replays a session captured from a real Claude Code run through the driver contract. This is the one exception
 * to "real CLIs only" the owner approved, for a scenario a live model cannot be made to produce on demand.
 *
 * What is real: every event after the prompt is one the real CLI produced, in its order, and each recorded tool call
 * is put to the real permission gate as the CLI's pre-tool hook put it.
 * What is not: the CLI produced those events for the prompt in the recording, and the replay plays them after
 * whatever prompt its caller sends; that difference is the scenario. The replay's own are the answers to `probe` and `models`,
 * and the turn's end when it is stopped or given an answer the recording has no continuation for (it says so in
 * an error). No test may read those as what a CLI does.
 */

export interface Recording {
  about: string;
  /** The CLI version that produced the session, as `claude --version` printed it. */
  cli: string;
  recordedAt: string;
  /** The session the recorded attempts belong to. */
  resumeCursor: string;
  /** The prompts the recorded attempts were given. */
  prompts: string[];
  /** What the pre-tool hook reported for each permission request: its directory relative to the worktree. */
  approvals: { attempt: number; tool: string; command: string; cwd: string; toolCallId: string; status: string }[];
  /** The events of each attempt, in order: the first, and the one that resumed it. */
  attempts: DriverEvent[][];
}

export function loadRecording(name: string): Recording {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", name), "utf8")) as Recording;
}

const CAPABILITIES: DriverCapabilities = { resume: true, interrupt: true, permissionRequests: true };
const now = (): string => new Date().toISOString();

class ReplaySession implements DriverSession {
  readonly capabilities = CAPABILITIES;
  private readonly listeners = new Set<(event: DriverEvent) => void>();
  private answer: ((response: unknown) => void) | null = null;
  private stopped = false;
  private playing: Promise<TurnEndReason> | null = null;

  readonly attemptId: number;
  private readonly db: DatabaseSync;
  private readonly recording: Recording;
  private readonly options: StartAttemptOptions;

  constructor(attemptId: number, db: DatabaseSync, recording: Recording, options: StartAttemptOptions) {
    this.attemptId = attemptId;
    this.db = db;
    this.recording = recording;
    this.options = options;
  }

  resumeCursor(): string {
    return this.recording.resumeCursor;
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(event: DriverEvent): void {
    this.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(this.attemptId, now(), event.type, JSON.stringify(event));
    for (const listener of this.listeners) listener(event);
  }

  private end(reason: TurnEndReason, detail: string | null): TurnEndReason {
    this.record({ type: "turn_ended", reason, detail });
    this.db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(reason === "completed" ? "ended" : reason === "interrupted" ? "interrupted" : "failed", now(), this.attemptId);
    return reason;
  }

  sendTurn(prompt: string): Promise<TurnEndReason> {
    if (this.playing) return Promise.reject(new Error("This recording holds one turn, and it was already sent."));
    this.playing = this.play(prompt);
    return this.playing;
  }

  private async play(prompt: string): Promise<TurnEndReason> {
    // The prompt is the caller's own; what follows is what the real CLI did in the recorded turn.
    this.record({ type: "user_prompt", text: prompt });
    const recorded = this.recording.attempts[1]!.filter((event) => event.type !== "user_prompt");
    let given: unknown = null;
    for (const event of recorded) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.stopped) return this.end("interrupted", "The replay was stopped.");
      if (event.type === "turn_ended") return this.end(event.reason, event.detail);
      if (event.type === "permission_resolved") {
        const allowed = typeof given === "object" && given !== null && (given as PermissionResponse).decision === "allow";
        if ((event.decision === "allowed") !== allowed) {
          const detail = `The recording continues only after this request was ${event.decision}; it has nothing for another answer.`;
          this.record({ type: "error", message: detail, raw: null });
          return this.end("error", detail);
        }
      }
      this.record(event);
      if (event.type === "tool_call") {
        // The CLI's pre-tool hook asked the gate about the call, from the directory that was recorded for it.
        const hook = this.recording.approvals.find((a) => a.toolCallId === event.id);
        const gate = this.options.gate;
        if (hook && gate) await askBroker(gate.socketPath, gate.secret, { tool_name: event.name, tool_input: event.input, tool_use_id: event.id, cwd: path.resolve(this.options.cwd, hook.cwd) });
      }
      if (event.type === "permission_request") {
        given = await new Promise((resolve) => (this.answer = resolve));
        this.answer = null;
        if (this.stopped) {
          this.record({ type: "permission_resolved", id: event.id, toolCallId: event.toolCallId, decision: "cancelled", note: null });
          return this.end("interrupted", "The replay was stopped.");
        }
      }
    }
    return this.end("error", "The recording ended without ending its turn.");
  }

  respondToRequest(_requestId: string, response: unknown): Promise<void> {
    if (!this.answer) return Promise.reject(new Error("No permission request is waiting in this replay."));
    this.answer(response);
    return Promise.resolve();
  }

  async interruptTurn(): Promise<void> {
    this.stopped = true;
    this.answer?.(null);
    await this.playing;
  }

  close(): Promise<void> {
    return this.interruptTurn();
  }
}

/** A driver whose one session is the recorded resumed attempt. It resumes the recorded session and no other. */
export function replayDriver(recording: Recording): Driver {
  const probe = (): Promise<DriverProbe> => Promise.resolve({ installed: true, version: recording.cli, supported: true, signedIn: true, billing: "unknown", problem: null });
  return {
    name: "claude-code",
    capabilities: CAPABILITIES,
    probe,
    // A recording holds no list of models.
    models: () => Promise.resolve({ source: "config", models: [], default: null, cliDefault: null }),
    startAttempt: (options) => {
      if (options.resumeCursor !== recording.resumeCursor) return Promise.reject(new Error(`This recording resumes session ${recording.resumeCursor} and holds nothing for ${options.resumeCursor ?? "a new session"}.`));
      const at = now();
      const attemptId = Number(
        options.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', ?, ?, 'running', NULL, ?, ?)").run(options.model ?? null, recording.resumeCursor, at, at).lastInsertRowid,
      );
      return Promise.resolve(new ReplaySession(attemptId, options.db, recording, options));
    },
  };
}
