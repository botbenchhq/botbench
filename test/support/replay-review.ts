import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CODEX, CODEX_CAPABILITIES, parseCodexLine } from "../../src/drivers/codex.ts";
import type { Driver, DriverProbe, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import { DriverUnavailableError } from "../../src/drivers/contract.ts";
import type { DriverEvent, TurnEndReason } from "../../src/drivers/events.ts";

/*
 * Replays a session captured from a real `codex exec` run (test/recordings/codex-review.json) through the driver
 * contract, as a run's reviewer. This is the exception to "real CLIs only" the owner approved, for scenarios a live
 * model cannot produce on demand: a reviewer that fails, and one that is still working when its time limit passes.
 *
 * What is real: every line the session plays is one the real CLI printed, in its order, and it becomes events through
 * Botbench's own parser (`parseCodexLine`).
 *   "review"      the CLI's review of a diff that adds calc.py with `return a - b`: verdict concerns, one finding
 *   "signed-out"  the same prompt with no sign-in: the CLI retried, then ended the turn as failed with a 401
 * What is not: the CLI printed those lines for the capture's prompt and copy, and the replay plays them after whatever
 * prompt its caller sends. The replay's own are the answers to `probe` and `models`, the hold ("hang": the session
 * announces itself and then waits until it is stopped), and the turn's end when it is stopped. No test may read those as
 * what a CLI does.
 */

export type ReviewSession = "review" | "signed-out" | "hang";

interface Recording {
  cli: string;
  sessions: Record<"review" | "signed-out", { lines: string[] }>;
}
export const loadReviewRecording = (): Recording => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "codex-review.json"), "utf8")) as Recording;

export interface ReviewReplay extends Driver {
  readonly started: StartAttemptOptions[];
  readonly prompts: string[];
  /** How many sessions were closed. */
  closed(): number;
}

const now = (): string => new Date().toISOString();

/** A Codex reviewer whose every attempt plays `session`. With `problem`, the probe says Codex cannot be used and nothing starts. */
export function reviewReplayDriver(session: ReviewSession, o: { problem?: string } = {}): ReviewReplay {
  const recording = loadReviewRecording();
  const started: StartAttemptOptions[] = [];
  const prompts: string[] = [];
  let closed = 0;
  const probe = (): Promise<DriverProbe> =>
    Promise.resolve({ installed: true, version: "0.171.0", supported: true, signedIn: o.problem === undefined, billing: "subscription", problem: o.problem ?? null });

  const open = (db: DatabaseSync, attemptId: number): DriverSession => {
    const listeners = new Set<(event: DriverEvent) => void>();
    let stop: (() => void) | null = null;
    let playing: Promise<TurnEndReason> | null = null;
    let sent = false;
    const record = (event: DriverEvent): void => {
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attemptId, now(), event.type, JSON.stringify(event));
      for (const listener of listeners) listener(event);
    };
    const play = async (prompt: string): Promise<TurnEndReason> => {
      prompts.push(prompt);
      record({ type: "user_prompt", text: prompt });
      const stopped = new Promise<"stopped">((resolve) => (stop = () => resolve("stopped")));
      const lines = session === "hang" ? recording.sessions.review.lines.slice(0, 2) : recording.sessions[session].lines;
      for (const event of lines.flatMap(parseCodexLine)) {
        if ((await Promise.race([stopped, new Promise((resolve) => setImmediate(resolve))])) === "stopped") break;
        if (event.type === "turn_ended") {
          record(event);
          return event.reason;
        }
        record(event);
      }
      if (session === "hang") await stopped;
      record({ type: "turn_ended", reason: "interrupted", detail: "The replay was stopped." });
      return "interrupted";
    };
    const interruptTurn = async (): Promise<void> => {
      stop?.();
      await playing;
    };
    return {
      attemptId,
      capabilities: CODEX_CAPABILITIES,
      resumeCursor: () => null,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendTurn: (prompt) => {
        if (sent) return Promise.reject(new Error("Botbench gives Codex one message per session."));
        sent = true;
        playing = play(prompt);
        return playing;
      },
      interruptTurn,
      respondToRequest: () => Promise.reject(new Error("A review asks for nothing.")),
      close: async () => {
        await interruptTurn();
        closed += 1;
        db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), attemptId);
      },
    };
  };

  return {
    name: CODEX,
    capabilities: CODEX_CAPABILITIES,
    started,
    prompts,
    closed: () => closed,
    probe,
    models: () => Promise.resolve({ source: "config", models: [{ id: "gpt-6-luna" }], default: null, cliDefault: null }),
    startAttempt: async (options) => {
      const found = await probe();
      if (found.problem !== null) throw new DriverUnavailableError(found);
      started.push(options);
      const at = now();
      const id = Number(options.db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run(CODEX, options.model ?? null, at, at).lastInsertRowid);
      return open(options.db, id);
    },
  };
}
