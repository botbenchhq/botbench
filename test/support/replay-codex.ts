import fs from "node:fs";
import path from "node:path";
import { CODEX_BUILD_CAPABILITIES } from "../../src/drivers/codex.ts";
import { startAppServerSession, type AppServerTransport, type CodexAppServerSession } from "../../src/drivers/codex-app-server.ts";
import type { Driver, DriverCapabilities, DriverProbe, StartAttemptOptions } from "../../src/drivers/contract.ts";

/*
 * Replays the shape of a `codex app-server` build session (test/fixtures/codex-app-server/shape.json, from the messages
 * measured live in docs/security/codex-app-server-check.md) to Botbench's real Codex session over its transport, until a
 * capture made by scripts/capture-codex-app-server.ts exists. This is the owner's exception to "real CLIs only": a
 * session replayed through the driver contract, for scenarios a live model cannot produce on demand (an escalation, a
 * looser sandbox reported mid-turn, a request Botbench does not know).
 *
 * What is real: CodexAppServerSession and everything after it, the attempt row and its events, and every answer the
 * session writes back, which a test reads from `sent`. What is not: the server. Nothing is run; the one thing a replayed
 * message writes is a file the shape says Codex added inside the copy, so that the work changes as it did. Its answers to initialize, thread/start
 * and turn/start, and its messages for a turn, are the shape's, played in order; after an approval request it plays the
 * shape's `accepted` messages when the session's answer accepts and `declined` otherwise. No test may read these
 * messages as what Codex does beyond what the document recorded.
 */

export type Step =
  | { notify: { method: string; params: unknown } }
  | { request: { method: string; params: Record<string, unknown> }; accepted: Step[]; declined: Step[] }
  | { end: "completed" | "failed" | "interrupted"; error?: string };

export interface CodexShape {
  about: string;
  cli: string;
  initialize: unknown;
  threadStart: Record<string, unknown>;
  settings: Record<string, unknown>;
  looserSettings: Record<string, unknown>;
  turns: Record<string, Step[]>;
}

export type ShapeTurn = "inside" | "escalate" | "patch" | "permissions" | "unknown" | "looser" | "wait";

export const loadShape = (): CodexShape => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "fixtures", "codex-app-server", "shape.json"), "utf8")) as CodexShape;

/** The shape with the task's copy, a folder outside it and Codex's folder filled in. */
function filled(shape: CodexShape, o: { cwd: string; outside: string }): CodexShape {
  const text = JSON.stringify(shape).replaceAll("$CWD", o.cwd).replaceAll("$OUTSIDE", o.outside).replaceAll("$HOME_CODEX", path.join(o.outside, ".codex"));
  const parsed = JSON.parse(text) as CodexShape;
  // A mid-turn report of looser settings is the shape's `looserSettings`.
  return JSON.parse(JSON.stringify(parsed).replaceAll('"$LOOSER"', JSON.stringify(parsed.looserSettings))) as CodexShape;
}

export interface ReplayTransport extends AppServerTransport {
  /** Every message the session wrote, in order. */
  readonly sent: Record<string, unknown>[];
  /** Whether the session stopped the server. */
  stopped(): boolean;
}

/**
 * A transport that answers as the shape does. `turns` are the shape's turns for each turn/start, in order.
 * `settings` replaces the thread's reported settings (to report a looser one before the first turn); `noSettings` sends none.
 */
export function replayTransport(o: { cwd: string; outside: string; turns: readonly ShapeTurn[]; settings?: Record<string, unknown>; noSettings?: boolean; settingsFirst?: boolean; threadStart?: Record<string, unknown> }): ReplayTransport {
  const shape = filled(loadShape(), o);
  const sent: Record<string, unknown>[] = [];
  const lineListeners: ((line: string) => void)[] = [];
  const exitListeners: ((how: string, stderr: string | null) => void)[] = [];
  let over = false;
  let turnIndex = 0;
  let nextServerId = 0;
  const threadId = String((shape.threadStart.thread as Record<string, unknown>).id);
  /** The approval request waiting for the session's answer, by its id, and what follows it. */
  const waiting = new Map<number, { method: string; accepted: Step[]; declined: Step[]; rest: Step[]; turnId: string }>();
  const emit = (message: Record<string, unknown>): void => {
    setImmediate(() => {
      if (!over) for (const listener of lineListeners) listener(JSON.stringify(message));
    });
  };
  /** A file Codex reports it added inside the copy is written there, so that the work changes as it did; nothing is written outside it. */
  const land = (params: unknown): void => {
    const item = (params as { item?: { type?: string; status?: string; changes?: { path: string; kind: { type: string }; diff: string }[] } }).item;
    if (item?.type !== "fileChange" || item.status !== "completed") return;
    for (const change of item.changes ?? []) {
      const inside = path.relative(o.cwd, change.path);
      if (change.kind.type === "add" && inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside)) fs.writeFileSync(change.path, change.diff);
    }
  };
  const play = (steps: Step[], turnId: string): void => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if ("notify" in step) {
        if (step.notify.method === "item/completed") land(step.notify.params);
        emit({ method: step.notify.method, params: { threadId, turnId, ...(step.notify.params as object) } });
      }
      else if ("request" in step) {
        const id = nextServerId++;
        waiting.set(id, { method: step.request.method, accepted: step.accepted, declined: step.declined, rest: steps.slice(i + 1), turnId });
        emit({ id, method: step.request.method, params: { threadId, turnId, ...step.request.params } });
        return;
      } else {
        emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], status: step.end, error: step.error === undefined ? null : { message: step.error, codexErrorInfo: null, additionalDetails: null } } } });
        return;
      }
    }
  };
  const accepts = (method: string, result: unknown): boolean => {
    if (typeof result !== "object" || result === null) return false;
    const r = result as Record<string, unknown>;
    if (method === "item/permissions/requestApproval") return typeof r.permissions === "object" && r.permissions !== null && Object.keys(r.permissions).length > 0;
    return r.decision === "accept";
  };
  return {
    pgid: 0,
    sent,
    stopped: () => over,
    onLine: (listener) => void lineListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
    send: (message) => {
      if (over) return;
      sent.push(message);
      const { id, method } = message;
      if (typeof method === "string" && id !== undefined) {
        if (method === "initialize") return emit({ id, result: shape.initialize });
        if (method === "thread/start") {
          // `settingsFirst`: the thread's settings are reported before thread/start is answered.
          if (o.settingsFirst === true) emit({ method: "thread/settings/updated", params: { threadId, threadSettings: o.settings ?? shape.settings } });
          emit({ id, result: o.threadStart ?? shape.threadStart });
          if (o.noSettings !== true && o.settingsFirst !== true) emit({ method: "thread/settings/updated", params: { threadId, threadSettings: o.settings ?? shape.settings } });
          return;
        }
        if (method === "turn/start") {
          const name = o.turns[turnIndex++];
          const turnId = `turn-${turnIndex}`;
          emit({ id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } });
          emit({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null } } });
          if (name !== undefined) play(shape.turns[name]!, turnId);
          return;
        }
        if (method === "turn/interrupt") {
          emit({ id, result: {} });
          emit({ method: "turn/completed", params: { threadId, turn: { id: (message.params as Record<string, unknown>).turnId, items: [], status: "interrupted", error: null } } });
          return;
        }
        return emit({ id, error: { code: -32601, message: `the replay has no answer to ${method}` } });
      }
      // The session's answer to an approval request: the shape goes on as it was answered.
      if (typeof id === "number" && waiting.has(id)) {
        const w = waiting.get(id)!;
        waiting.delete(id);
        play([...(accepts(w.method, message.result) ? w.accepted : w.declined), ...w.rest], w.turnId);
      }
    },
    stop: async () => {
      if (over) return;
      over = true;
      for (const listener of exitListeners) listener("was stopped", null);
    },
  };
}

export interface CodexBuildReplay extends Driver {
  /** The transport of each attempt, in order. */
  readonly transports: ReplayTransport[];
  /** The sessions started, in order. */
  readonly sessions: CodexAppServerSession[];
  readonly started: StartAttemptOptions[];
}

const PROBE: DriverProbe = { installed: true, version: "0.171.0", supported: true, signedIn: true, billing: "subscription", problem: null };

/** Codex as a builder whose `n`th attempt plays `attempts[n]` (the shape's turns for that attempt), the last once they run out. */
export function codexBuildReplay(attempts: readonly (readonly ShapeTurn[])[], o: { outside: string; settings?: Record<string, unknown>; approvalTimeoutMs?: number; capabilities?: DriverCapabilities }): CodexBuildReplay {
  const transports: ReplayTransport[] = [];
  const sessions: CodexAppServerSession[] = [];
  const started: StartAttemptOptions[] = [];
  return {
    name: "codex",
    capabilities: o.capabilities ?? CODEX_BUILD_CAPABILITIES,
    transports,
    sessions,
    started,
    probe: async () => PROBE,
    models: async () => ({ source: "config", models: [], default: null, cliDefault: null }),
    startAttempt: async (options) => {
      started.push(options);
      if (options.allowEdits !== true || options.gate === undefined) throw new Error("This replay builds only.");
      const transport = replayTransport({ cwd: options.cwd, outside: o.outside, turns: attempts[Math.min(transports.length, attempts.length - 1)] ?? [], ...(o.settings ? { settings: o.settings } : {}) });
      transports.push(transport);
      const session = await startAppServerSession({ db: options.db, transport, cwd: options.cwd, capabilities: CODEX_BUILD_CAPABILITIES, ...(options.model ? { model: options.model } : {}), ...(o.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: o.approvalTimeoutMs }) });
      sessions.push(session);
      return session;
    },
  };
}
