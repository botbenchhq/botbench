import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { acpLines } from "../../src/drivers/acp-turn.ts";
import { AGY_CHAT_TOOLS, AGY_WEB_TOOLS, ANTIGRAVITY, ANTIGRAVITY_CAPABILITIES } from "../../src/drivers/antigravity.ts";
import { CODEX, CODEX_CAPABILITIES, readCodexLine } from "../../src/drivers/codex.ts";
import type { Driver, DriverCapabilities, DriverProbe, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import { DriverUnavailableError } from "../../src/drivers/contract.ts";
import type { DriverEvent, TurnEndReason } from "../../src/drivers/events.ts";
import { GROK, GROK_CAPABILITIES, grokReader } from "../../src/drivers/grok.ts";
import type { LineResult } from "../../src/drivers/one-turn.ts";
import { ReplaySession } from "./replay.ts";

/*
 * Replays sessions captured from real `codex exec`, `grok -p` and `agy acp` runs through the driver contract, as the agents
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
/**
 * Lines a test wrote in the form the CLI prints, for what no capture holds (a web search). They go through the same
 * reader; the test that uses them says they are constructed, and no test may read them as what a CLI did.
 */
export interface ConstructedSession {
  lines: readonly string[];
}
type Agent = typeof CODEX | typeof GROK | typeof ANTIGRAVITY;

const RECORDINGS = path.resolve(import.meta.dirname, "..", "recordings");
const load = (file: string): { sessions: Record<string, { lines: string[] }> } => JSON.parse(fs.readFileSync(path.join(RECORDINGS, file), "utf8"));

const READERS: Record<Agent, { capabilities: DriverCapabilities; reader: () => (line: string) => LineResult; review: string; model: string }> = {
  [CODEX]: { capabilities: CODEX_CAPABILITIES, reader: () => readCodexLine, review: "codex-review.json", model: "gpt-6-luna" },
  [GROK]: { capabilities: GROK_CAPABILITIES, reader: grokReader, review: "grok-review.json", model: "grok-4.7-build-fast" },
  // Antigravity's chat, review and signed-out sessions are all in test/recordings/antigravity-acp.json.
  [ANTIGRAVITY]: { capabilities: ANTIGRAVITY_CAPABILITIES, reader: acpLines("Antigravity", [...AGY_CHAT_TOOLS, ...AGY_WEB_TOOLS]), review: "antigravity-acp.json", model: "gemini-3.8-flash-low" },
};

/** The lines a session plays. */
function linesOf(agent: Agent, session: Exclude<ChatSession, "hang">): string[] {
  if (session === "review" || session === "signed-out") return load(READERS[agent].review).sessions[session]!.lines;
  if (session === "compare" && agent !== CODEX) throw new Error("Only Codex's comparison was recorded.");
  if (agent === ANTIGRAVITY) return load(READERS[agent].review).sessions[session]!.lines;
  return load("chat-turns.json").sessions[session === "compare" ? "compare" : agent]!.lines;
}

export interface ChatReplay extends Driver {
  readonly started: StartAttemptOptions[];
  readonly prompts: string[];
}

const now = (): string => new Date().toISOString();

/** `agent` whose `n`th attempt plays the `n`th of `sessions` (the last for any after). With `problem`, its probe says it cannot be used. */
export function chatReplayDriver(agent: Agent, sessions: ChatSession | readonly ChatSession[] | ConstructedSession = "chat", o: { problem?: string } = {}): ChatReplay {
  const { capabilities, reader, model } = READERS[agent];
  const script: readonly (ChatSession | ConstructedSession)[] = typeof sessions === "string" || !Array.isArray(sessions) ? [sessions as ChatSession | ConstructedSession] : sessions;
  const started: StartAttemptOptions[] = [];
  const prompts: string[] = [];
  const probe = (): Promise<DriverProbe> => Promise.resolve({ installed: true, version: "replay", supported: true, signedIn: o.problem === undefined, billing: "subscription", problem: o.problem ?? null });

  const open = (db: DatabaseSync, attemptId: number, session: ChatSession | ConstructedSession): DriverSession => {
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
      const lines = typeof session === "object" ? session.lines : session === "hang" ? [] : linesOf(agent, session);
      // A call reported again once it is over is stored once, as OneTurnSession (src/drivers/one-turn.ts) stores it.
      const called = new Set<string>();
      const events = lines.flatMap((line) => read(line).events).filter((e) => e.type !== "tool_call" || (!called.has(e.id) && called.add(e.id) !== undefined));
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

/** The chat turns of Claude Code in test/recordings/chat-fetch.json (test/support/capture-chat-fetch.ts). */
export type ClaudeChatSession = "allowed" | "declined";

export interface ClaudeChatReplay extends Driver {
  readonly started: StartAttemptOptions[];
  /** Every answer Botbench gave a permission request, as the driver received it. */
  readonly responses: unknown[];
}

/**
 * Claude Code in a chat, replaying a real chat turn that asked to fetch https://example.com: its `n`th attempt plays
 * the `n`th of `sessions` (the last for any after). Each recorded call is put to the real permission gate as the CLI's
 * hook put it, from the chat's folder. The recorded turn continues only after the answer it was given (replay.ts).
 */
export function claudeChatReplay(sessions: readonly ClaudeChatSession[]): ClaudeChatReplay {
  const recording = load("chat-fetch.json") as unknown as { cli: string; sessions: Record<ClaudeChatSession, DriverEvent[]> };
  const started: StartAttemptOptions[] = [];
  const responses: unknown[] = [];
  return {
    name: "claude-code",
    capabilities: { resume: true, interrupt: true, permissionRequests: true, edits: true, confinedCommands: true },
    started,
    responses,
    probe: () => Promise.resolve({ installed: true, version: recording.cli, supported: true, signedIn: true, billing: "subscription", problem: null }),
    models: () => Promise.resolve({ source: "config", models: [], default: null, cliDefault: null }),
    startAttempt: (options) => {
      const events = recording.sessions[sessions[Math.min(started.length, sessions.length - 1)]!];
      started.push(options);
      const cursor = (events.find((e) => e.type === "session_started") as { resumeCursor: string }).resumeCursor;
      const at = now();
      const attemptId = Number(options.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', ?, ?, 'running', NULL, ?, ?)").run(options.model ?? null, cursor, at, at).lastInsertRowid);
      const session = new ReplaySession(attemptId, options.db, { resumeCursor: cursor, events, hookCwd: () => "." }, options);
      const respond = session.respondToRequest.bind(session);
      session.respondToRequest = (id, response) => {
        responses.push(response);
        return respond(id, response);
      };
      return Promise.resolve(session);
    },
  };
}
