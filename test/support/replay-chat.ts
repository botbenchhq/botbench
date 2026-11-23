import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ANTIGRAVITY, ANTIGRAVITY_CAPABILITIES, agyReader } from "../../src/drivers/antigravity.ts";
import { CODEX, CODEX_CAPABILITIES, readCodexLine } from "../../src/drivers/codex.ts";
import type { Driver, DriverCapabilities, DriverProbe, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import { DriverUnavailableError } from "../../src/drivers/contract.ts";
import type { DriverEvent, TurnEndReason } from "../../src/drivers/events.ts";
import { GROK, GROK_CAPABILITIES, grokReader } from "../../src/drivers/grok.ts";
import type { LineResult } from "../../src/drivers/one-turn.ts";

/*
 * Replays sessions captured from real `codex exec`, `grok -p` and `agy` runs through the driver contract, as the agents
 * a chat asks (the owner's approved exception to "real CLIs only", for engine and screen tests).
 *
 * What is real: every line a session plays is one the real CLI printed, in its order, and it becomes events through
 * Botbench's own reader for that CLI.
 *   "chat"       test/recordings/chat-turns.json: the CLI's answer to Botbench's chat prompt (one earlier exchange, one question)
 *   "compare"    the same file, Codex only: its comparison of the three answers
 *   "review"     test/recordings/<agent>-review.json: the CLI's review of a diff that adds calc.py with `return a - b`
 *   "signed-out" the same file: the CLI with no sign-in, which ended the turn as failed
 * What is not: the CLI printed those lines for the capture's prompt, and the replay plays them after whatever prompt its
 * caller sends. The replay's own are the answers to `probe` and `models`, the hold ("hang": the session waits until it
 * is stopped, having played nothing), and the turn's end when it is stopped. No test may read those as what a CLI does.
 */

export type ChatSession = "chat" | "compare" | "review" | "signed-out" | "hang";
type Agent = typeof CODEX | typeof GROK | typeof ANTIGRAVITY;

const RECORDINGS = path.resolve(import.meta.dirname, "..", "recordings");
const load = (file: string): { sessions: Record<string, { lines: string[] }> } => JSON.parse(fs.readFileSync(path.join(RECORDINGS, file), "utf8"));

const READERS: Record<Agent, { capabilities: DriverCapabilities; reader: () => (line: string) => LineResult; review: string; model: string }> = {
  [CODEX]: { capabilities: CODEX_CAPABILITIES, reader: () => readCodexLine, review: "codex-review.json", model: "gpt-6-luna" },
  [GROK]: { capabilities: GROK_CAPABILITIES, reader: grokReader, review: "grok-review.json", model: "grok-4.7-build-fast" },
  [ANTIGRAVITY]: { capabilities: ANTIGRAVITY_CAPABILITIES, reader: agyReader, review: "antigravity-review.json", model: "gemini-3.8-flash-low" },
};

/** The lines a session plays. */
function linesOf(agent: Agent, session: Exclude<ChatSession, "hang">): string[] {
  if (session === "review" || session === "signed-out") return load(READERS[agent].review).sessions[session]!.lines;
  if (session === "compare" && agent !== CODEX) throw new Error("Only Codex's comparison was recorded.");
  return load("chat-turns.json").sessions[session === "compare" ? "compare" : agent]!.lines;
}

export interface ChatReplay extends Driver {
  readonly started: StartAttemptOptions[];
  readonly prompts: string[];
}

const now = (): string => new Date().toISOString();

/** `agent` whose `n`th attempt plays the `n`th of `sessions` (the last for any after). With `problem`, its probe says it cannot be used. */
export function chatReplayDriver(agent: Agent, sessions: ChatSession | readonly ChatSession[] = "chat", o: { problem?: string } = {}): ChatReplay {
  const { capabilities, reader, model } = READERS[agent];
  const script = typeof sessions === "string" ? [sessions] : sessions;
  const started: StartAttemptOptions[] = [];
  const prompts: string[] = [];
  const probe = (): Promise<DriverProbe> => Promise.resolve({ installed: true, version: "replay", supported: true, signedIn: o.problem === undefined, billing: "subscription", problem: o.problem ?? null });

  const open = (db: DatabaseSync, attemptId: number, session: ChatSession): DriverSession => {
    const listeners = new Set<(event: DriverEvent) => void>();
    let stop: (() => void) | null = null;
    let playing: Promise<TurnEndReason> | null = null;
    const record = (event: DriverEvent, status: string | null = null): void => {
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attemptId, now(), event.type, JSON.stringify(event));
      if (status !== null) db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), attemptId);
      for (const listener of listeners) listener(event);
    };
    const play = async (prompt: string): Promise<TurnEndReason> => {
      prompts.push(prompt);
      record({ type: "user_prompt", text: prompt });
      const stopped = new Promise<"stopped">((resolve) => (stop = () => resolve("stopped")));
      const read = reader();
      const events = session === "hang" ? [] : linesOf(agent, session).flatMap((line) => read(line).events);
      for (const event of events) {
        if ((await Promise.race([stopped, new Promise((resolve) => setImmediate(resolve))])) === "stopped") break;
        if (event.type === "turn_ended") {
          record(event, event.reason === "completed" ? null : "failed");
          return event.reason;
        }
        record(event);
      }
      if (session === "hang") await stopped;
      record({ type: "turn_ended", reason: "interrupted", detail: "The replay was stopped." }, "interrupted");
      return "interrupted";
    };
    const interruptTurn = async (): Promise<void> => {
      stop?.();
      await playing;
    };
    return {
      attemptId,
      capabilities,
      resumeCursor: () => null,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendTurn: (prompt) => {
        if (playing !== null) return Promise.reject(new Error("One message per session."));
        playing = play(prompt);
        return playing;
      },
      interruptTurn,
      respondToRequest: () => Promise.reject(new Error("A chat turn here asks for nothing.")),
      close: async () => {
        await interruptTurn();
        db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), attemptId);
      },
    };
  };

  return {
    name: agent,
    capabilities,
    started,
    prompts,
    probe,
    models: () => Promise.resolve({ source: "config", models: [{ id: model }], default: null, cliDefault: null }),
    startAttempt: async (options) => {
      const found = await probe();
      if (found.problem !== null) throw new DriverUnavailableError(found);
      started.push(options);
      const at = now();
      const id = Number(options.db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run(agent, options.model ?? null, at, at).lastInsertRowid);
      return open(options.db, id, script[Math.min(started.length - 1, script.length - 1)]!);
    },
  };
}
