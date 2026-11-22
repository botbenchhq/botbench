import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import type { Driver, DriverCapabilities, DriverProbe, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import type { DriverEvent, PermissionResponse, TurnEndReason } from "../../src/drivers/events.ts";
import { loadRecording } from "./replay.ts";
import { loadPlanRecording } from "./replay-plan.ts";

/*
 * Replays turns captured from real Claude Code sessions as the turns of a run's builders, through the driver contract.
 * This is the exception to "real CLIs only" the owner approved, for scenarios a live model cannot be made to produce on
 * demand: a turn that is still running at the moment a test acts (a cancel, a second task that must not start yet), and
 * a request for permission that is left waiting.
 *
 * The recorded turns:
 *   "done"  the first turn of test/recordings/planner-plans.json: the real CLI opened a session, wrote text and ended.
 *   "ask"   the resumed attempt of test/recordings/redrive-other-request.json: the real CLI asked to run `sh other.sh`,
 *           waited for permission, was allowed, ran it and ended.
 * What is real: every event after the prompt is one the real CLI produced, in its order, and each recorded tool call is
 * put to the real permission gate as the CLI's pre-tool hook put it.
 * What is not: the CLI produced those events for the prompts in the recordings, and the replay plays them after
 * whatever prompt its caller sends, in a worktree the recording never saw; nothing is written to the worktree by a
 * replayed tool call. The replay's own are the answers to `probe` and `models`, the hold a test puts on a turn, and the
 * turn's end when it is stopped or given an answer the recording has no continuation for. No test may read those as
 * what a CLI does.
 */

export type BuildTurn = "done" | "ask";

const CAPABILITIES: DriverCapabilities = { resume: true, interrupt: true, permissionRequests: true };
const now = (): string => new Date().toISOString();

function recordedTurns(): Record<BuildTurn, { events: DriverEvent[]; hookCwd: Map<string, string> }> {
  const plan = loadPlanRecording();
  const redrive = loadRecording("redrive-other-request.json");
  return {
    done: { events: plan.turns[0]!.events, hookCwd: new Map() },
    ask: { events: redrive.attempts[1]!, hookCwd: new Map(redrive.approvals.filter((a) => a.attempt === 2).map((a) => [a.toolCallId, a.cwd])) },
  };
}

export interface BuildReplay extends Driver {
  /** What each attempt was started with, in order. */
  readonly started: StartAttemptOptions[];
  /** Every prompt sent, in order. */
  readonly prompts: string[];
  /** How many sessions were closed. */
  closed(): number;
  /** How many sessions are open now. */
  open(): number;
  /** Let the turn of the attempt started `n`th (from 0) go on, when the test holds it. */
  release(n: number): void;
  /** Resolves when the turn of the attempt started `n`th (from 0) has begun and is held. */
  held(n: number): Promise<void>;
}

/**
 * A driver whose `n`th started attempt plays `script[n]`. With `hold`, the turns whose numbers it lists wait until the
 * test calls `release(n)`; a stopped turn stops waiting. They wait after the prompt is recorded, or with `holdAt:
 * "session"` once the recorded session announcement is played (so the attempt has the resume cursor a real CLI reports
 * at that point, and the turn is under way).
 */
export function buildReplayDriver(script: readonly BuildTurn[], o: { hold?: readonly number[]; holdAt?: "prompt" | "session" } = {}): BuildReplay {
  const turns = recordedTurns();
  const started: StartAttemptOptions[] = [];
  const prompts: string[] = [];
  const releases = new Map<number, () => void>();
  const gates = new Map<number, Promise<void>>();
  const arrived = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  const arrival = (n: number): { promise: Promise<void>; resolve: () => void } => {
    let entry = arrived.get(n);
    if (!entry) {
      let resolve!: () => void;
      entry = { promise: new Promise<void>((r) => (resolve = r)), resolve };
      arrived.set(n, entry);
    }
    return entry;
  };
  for (const n of o.hold ?? []) gates.set(n, new Promise<void>((resolve) => releases.set(n, resolve)));
  let closed = 0;
  let open = 0;
  const probe = (): Promise<DriverProbe> => Promise.resolve({ installed: true, version: loadPlanRecording().cli, supported: true, signedIn: true, billing: "unknown", problem: null });

  const session = (db: DatabaseSync, attemptId: number, n: number, options: StartAttemptOptions): DriverSession => {
    const listeners = new Set<(event: DriverEvent) => void>();
    let stopped = false;
    let stop: () => void = () => {};
    const stopping = new Promise<void>((resolve) => (stop = resolve));
    let answer: ((response: unknown) => void) | null = null;
    let playing: Promise<TurnEndReason> | null = null;
    let over = false;
    const record = (event: DriverEvent): void => {
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attemptId, now(), event.type, JSON.stringify(event));
      if (event.type === "session_started") db.prepare("UPDATE attempts SET model = ?, resume_cursor = ?, updated_at = ? WHERE id = ?").run(event.model, event.resumeCursor, now(), attemptId);
      for (const listener of listeners) listener(event);
    };
    const end = (reason: TurnEndReason, detail: string | null): TurnEndReason => {
      record({ type: "turn_ended", reason, detail });
      db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(reason === "completed" ? "ended" : reason === "interrupted" ? "interrupted" : "failed", now(), attemptId);
      return reason;
    };
    const play = async (prompt: string): Promise<TurnEndReason> => {
      prompts.push(prompt);
      // The prompt is the caller's own; what follows is what the real CLI did in the recorded turn.
      record({ type: "user_prompt", text: prompt });
      const kind = script[n];
      if (kind === undefined) return end("error", "The test named no recorded turn for this attempt.");
      const gate = gates.get(n);
      const atSession = o.holdAt === "session";
      if (!atSession) {
        arrival(n).resolve();
        if (gate) await Promise.race([gate, stopping]);
      }
      const recorded = turns[kind];
      let given: unknown = null;
      for (const event of recorded.events) {
        if (event.type === "user_prompt") continue;
        await new Promise((resolve) => setImmediate(resolve));
        if (stopped) return end("interrupted", "The replay was stopped.");
        if (event.type === "turn_ended") return end(event.reason, event.detail);
        if (event.type === "permission_resolved") {
          const allowed = typeof given === "object" && given !== null && (given as PermissionResponse).decision === "allow";
          if ((event.decision === "allowed") !== allowed) {
            const detail = `The recording continues only after this request was ${event.decision}; it has nothing for another answer.`;
            record({ type: "error", message: detail, raw: null });
            return end("error", detail);
          }
        }
        record(event);
        if (atSession && event.type === "session_started") {
          arrival(n).resolve();
          if (gate) await Promise.race([gate, stopping]);
        }
        if (event.type === "tool_call") {
          // The CLI's pre-tool hook asked the gate about the call, from the directory that was recorded for it.
          const cwd = recorded.hookCwd.get(event.id);
          if (cwd !== undefined && options.gate) await askBroker(options.gate.socketPath, options.gate.secret, { tool_name: event.name, tool_input: event.input, tool_use_id: event.id, cwd: path.resolve(options.cwd, cwd) });
        }
        if (event.type === "permission_request") {
          given = await new Promise((resolve) => (answer = resolve));
          answer = null;
          if (stopped) {
            record({ type: "permission_resolved", id: event.id, toolCallId: event.toolCallId, decision: "cancelled", note: null });
            return end("interrupted", "The replay was stopped.");
          }
        }
      }
      return end("error", "The recorded turn has no end.");
    };
    const interruptTurn = async (): Promise<void> => {
      stopped = true;
      stop();
      answer?.(null);
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
        if (playing || stopped) return Promise.reject(new Error("This replayed attempt holds one turn, and it was already sent."));
        playing = play(prompt);
        return playing;
      },
      interruptTurn,
      respondToRequest: (_id, response) => {
        if (!answer) return Promise.reject(new Error("No permission request is waiting in this replay."));
        answer(response);
        return Promise.resolve();
      },
      close: async () => {
        await interruptTurn();
        if (over) return;
        over = true;
        closed += 1;
        open -= 1;
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
    open: () => open,
    release: (n) => releases.get(n)?.(),
    held: (n) => arrival(n).promise,
    probe,
    // A recording holds no list of models.
    models: () => Promise.resolve({ source: "config", models: [], default: null, cliDefault: null }),
    startAttempt: (options) => {
      const n = started.length;
      started.push(options);
      open += 1;
      const at = now();
      const attemptId = Number(options.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', ?, NULL, 'running', NULL, ?, ?)").run(options.model ?? null, at, at).lastInsertRowid);
      return Promise.resolve(session(options.db, attemptId, n, options));
    },
  };
}
