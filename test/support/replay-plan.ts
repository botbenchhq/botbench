import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Driver, DriverCapabilities, DriverProbe, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import type { DriverEvent, TurnEndReason } from "../../src/drivers/events.ts";

/*
 * Replays turns of the planner session captured from a real Claude Code run (test/recordings/planner-plans.json)
 * through the driver contract. This is the exception to "real CLIs only" the owner approved, for a scenario a live
 * model cannot be made to produce on demand: a planner that returns a plan Botbench does not accept.
 *
 * What is real: every event after the prompt is one the real CLI produced, in its order, within its turn.
 * What is not: the CLI produced each turn for the capture's prompt, and the replay plays it after whatever prompt
 * its caller sends, in the order the test names; that difference is the scenario. The replay's own are the answers
 * to `probe` and `models`, where in an attempt the recorded session announcement is placed, and the turn's end when
 * it is stopped. No test may read those as what a CLI does.
 */

export interface PlanRecording {
  about: string;
  /** The CLI version that produced the session, as `claude --version` printed it. */
  cli: string;
  model: string;
  recordedAt: string;
  turns: { prompt: string; events: DriverEvent[] }[];
}

/** The recorded turns by what they hold. */
export const NO_TASKS = 0;
export const EMPTY_TASK = 1;
export const THREE_TASKS = 2;

export function loadPlanRecording(): PlanRecording {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "planner-plans.json"), "utf8")) as PlanRecording;
}

// As the real Claude Code driver reports them: its sessions were recorded with every command in its sandbox.
const CAPABILITIES: DriverCapabilities = { resume: true, interrupt: true, permissionRequests: true, edits: true, confinedCommands: true };
const now = (): string => new Date().toISOString();

export interface PlanReplay extends Driver {
  /** What each attempt was started with, in order. */
  readonly started: StartAttemptOptions[];
  /** Every prompt sent, in order. */
  readonly prompts: string[];
  /** How many sessions were closed. */
  closed(): number;
}

/**
 * A driver whose turns are the recorded ones named by `order`, one for each prompt sent, across however many attempts
 * are started. `hold`, when given, is awaited at the start of every turn, so a test can act while a turn is running.
 */
export function planReplayDriver(recording: PlanRecording, order: readonly number[], hold?: () => Promise<void>): PlanReplay {
  const started: StartAttemptOptions[] = [];
  const prompts: string[] = [];
  let next = 0;
  let closed = 0;
  const announced = recording.turns.flatMap((turn) => turn.events).find((event) => event.type === "session_started")!;
  const probe = (): Promise<DriverProbe> => Promise.resolve({ installed: true, version: recording.cli, supported: true, signedIn: true, billing: "unknown", problem: null });

  const session = (db: DatabaseSync, attemptId: number): DriverSession => {
    const listeners = new Set<(event: DriverEvent) => void>();
    let stopped = false;
    let over = false;
    let playing: Promise<TurnEndReason> | null = null;
    let turn = 0;
    const record = (event: DriverEvent): void => {
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(attemptId, turn, now(), event.type, JSON.stringify(event));
      if (event.type === "session_started") db.prepare("UPDATE attempts SET model = ?, updated_at = ? WHERE id = ?").run(event.model, now(), attemptId);
      for (const listener of listeners) listener(event);
    };
    const end = (reason: TurnEndReason, detail: string | null): TurnEndReason => {
      record({ type: "turn_ended", reason, detail });
      if (reason !== "completed") db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(reason === "interrupted" ? "interrupted" : "failed", now(), attemptId);
      return reason;
    };
    const play = async (prompt: string): Promise<TurnEndReason> => {
      turn += 1;
      prompts.push(prompt);
      // The prompt is the caller's own; what follows is what the real CLI did in the recorded turn.
      record({ type: "user_prompt", text: prompt });
      const recorded = recording.turns[order[next++] ?? -1];
      if (recorded === undefined) return end("error", "The test named no recorded turn for this prompt.");
      // The real CLI announces its session at the start of every turn; the recording holds that announcement once, in
      // the session's first turn. An attempt whose first replayed turn is a later one is given it here.
      if (turn === 1 && !recorded.events.some((event) => event.type === "session_started")) record(announced);
      if (hold) await hold();
      for (const event of recorded.events) {
        if (event.type === "user_prompt") continue;
        await new Promise((resolve) => setImmediate(resolve));
        if (stopped) return end("interrupted", "The replay was stopped.");
        if (event.type === "turn_ended") return end(event.reason, event.detail);
        record(event);
      }
      return end("error", "The recorded turn has no end.");
    };
    const interruptTurn = async (): Promise<void> => {
      stopped = true;
      await playing;
    };
    return {
      attemptId,
      capabilities: CAPABILITIES,
      resumeCursor: () => null,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendTurn: (prompt) => {
        if (stopped) return Promise.reject(new Error("This replayed attempt is over."));
        playing = play(prompt).finally(() => (playing = null));
        return playing;
      },
      interruptTurn,
      respondToRequest: () => Promise.reject(new Error("The recorded turns hold no permission request.")),
      close: async () => {
        await interruptTurn();
        if (over) return;
        over = true;
        closed += 1;
        db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), attemptId);
      },
    };
  };

  return {
    name: "claude-code",
    capabilities: CAPABILITIES,
    started,
    prompts,
    closed: () => closed,
    probe,
    // A recording holds no list of models.
    models: () => Promise.resolve({ source: "config", models: [], default: null, cliDefault: null }),
    startAttempt: (options) => {
      started.push(options);
      const at = now();
      const attemptId = Number(options.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', ?, NULL, 'running', NULL, ?, ?)").run(options.model ?? null, at, at).lastInsertRowid);
      return Promise.resolve(session(options.db, attemptId));
    },
  };
}
