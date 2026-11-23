import fs from "node:fs";
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
 *   "refused" test/recordings/full-refused-push.json: as the builder of a fully autonomous run the real CLI asked to run
 *           `git push origin HEAD`, Botbench refused it without asking anyone, and the CLI ended its turn.
 *   "refine" the refine turn of test/recordings/refine-round.json: sent Botbench's refine prompt with a real Codex
 *           review, the real CLI read calc.py, changed `a - b` to `a + b` with its Edit tool and replied in the asked form.
 * A test may also bring a turn of its own from a fixture under test/fixtures (`FixtureTurn`), recorded from a real CLI
 * session by a capture script, whose `about` says how.
 * An attempt may be given several recorded turns, in order (a list in place of one): its session then takes one message
 * after another, as the real CLI's session does, each played as its own turn of the one attempt, numbered from 1. This is
 * for an owner's note delivered as the next message of the same session (engine/notes.ts); each turn is still a recorded
 * real one, played after whatever message the caller sends.
 * What is real: every event after the prompt is one the real CLI produced, in its order, and each recorded tool call is
 * put to the real permission gate as the CLI's pre-tool hook put it.
 * What is not: the CLI produced those events for the prompts in the recordings, and the replay plays them after
 * whatever prompt its caller sends, in a worktree the recording never saw. Nothing is written to the worktree by a
 * replayed tool call, with one exception: when the "refine" turn's edit returns, the files the real turn left changed in
 * its copy (recorded with it) are written into the worktree, so that the work changes as it did. The replay's own are the answers to `probe` and `models`, the hold a test puts on a turn, and the
 * turn's end when it is stopped or given an answer the recording has no continuation for. No test may read those as
 * what a CLI does.
 */

export type BuildTurn = "done" | "ask" | "refused" | "refine";
/** A turn a test brings from a fixture of its own (under test/fixtures), played as the named ones are, up to its first end of turn. Its `about` says how it was recorded. */
export interface FixtureTurn {
  about: string;
  events: DriverEvent[];
}

interface RefineRecording {
  refine: { events: DriverEvent[]; files: Record<string, string> };
}
export const loadRefineRecording = (): RefineRecording & { sessions: Record<string, { lines: string[] }> } =>
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "refine-round.json"), "utf8"));

// As the real Claude Code driver reports them: its sessions were recorded with every command in its sandbox.
const CAPABILITIES: DriverCapabilities = { resume: true, interrupt: true, permissionRequests: true, edits: true, confinedCommands: true };
const now = (): string => new Date().toISOString();

function recordedTurns(): Record<BuildTurn, { events: DriverEvent[]; hookCwd: Map<string, string>; files?: Record<string, string> }> {
  const plan = loadPlanRecording();
  const redrive = loadRecording("redrive-other-request.json");
  const refused = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "full-refused-push.json"), "utf8")) as { events: DriverEvent[]; refused: { toolCallId: string; cwd: string }[] };
  const refine = loadRefineRecording().refine;
  return {
    done: { events: plan.turns[0]!.events, hookCwd: new Map() },
    ask: { events: redrive.attempts[1]!, hookCwd: new Map(redrive.approvals.filter((a) => a.attempt === 2).map((a) => [a.toolCallId, a.cwd])) },
    refused: { events: refused.events, hookCwd: new Map(refused.refused.map((r) => [r.toolCallId, r.cwd])) },
    refine: { events: refine.events, hookCwd: new Map(), files: refine.files },
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** What one attempt plays: one recorded turn, or several, one for each message its session is sent. */
export type AttemptScript = BuildTurn | FixtureTurn | readonly (BuildTurn | FixtureTurn)[];

export interface BuildReplay extends Driver {
  /** What each attempt was started with, in order. */
  readonly started: StartAttemptOptions[];
  /** Every prompt sent, in order. */
  readonly prompts: string[];
  /** How many sessions were closed. */
  closed(): number;
  /** How many sessions are open now. */
  open(): number;
  /** Let the turn of the attempt started `n`th (from 0) go on, when the test holds it; `turn` (from 0) for a later one of its turns. */
  release(n: number, turn?: number): void;
  /** Resolves when the turn of the attempt started `n`th (from 0) has begun and is held; `turn` (from 0) for a later one of its turns. */
  held(n: number, turn?: number): Promise<void>;
}

/**
 * A driver whose `n`th started attempt plays `script[n]`. With `hold`, the turns whose numbers it lists wait until the
 * test calls `release(n)`; a stopped turn stops waiting. They wait after the prompt is recorded, or with `holdAt:
 * "session"` once the recorded session announcement is played (so the attempt has the resume cursor a real CLI reports
 * at that point, and the turn is under way). `holdTurns` holds later turns of an attempt, each as `[attempt, turn]` from 0.
 */
export function buildReplayDriver(script: readonly AttemptScript[], o: { hold?: readonly number[]; holdTurns?: readonly (readonly [number, number])[]; holdAt?: "prompt" | "session" } = {}): BuildReplay {
  const turns = recordedTurns();
  const started: StartAttemptOptions[] = [];
  const prompts: string[] = [];
  // Holds are kept by attempt and turn, both from 0: `hold` names the first turn of an attempt.
  const key = (n: number, turn: number): string => `${n}:${turn}`;
  const releases = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  const arrived = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const arrival = (n: number, turn: number): { promise: Promise<void>; resolve: () => void } => {
    let entry = arrived.get(key(n, turn));
    if (!entry) {
      let resolve!: () => void;
      entry = { promise: new Promise<void>((r) => (resolve = r)), resolve };
      arrived.set(key(n, turn), entry);
    }
    return entry;
  };
  for (const [n, turn] of [...(o.hold ?? []).map((n) => [n, 0] as const), ...(o.holdTurns ?? [])]) gates.set(key(n, turn), new Promise<void>((resolve) => releases.set(key(n, turn), resolve)));
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
    let running = false;
    let over = false;
    /** How many messages this attempt was sent so far; the turn playing is the last of them. */
    let sent = 0;
    const given = script[n];
    const planned: readonly (BuildTurn | FixtureTurn)[] = given === undefined ? [] : Array.isArray(given) ? given : [given as BuildTurn | FixtureTurn];
    const record = (event: DriverEvent): void => {
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(attemptId, Math.max(sent, 1), now(), event.type, JSON.stringify(event));
      if (event.type === "session_started") db.prepare("UPDATE attempts SET model = ?, resume_cursor = ?, updated_at = ? WHERE id = ?").run(event.model, event.resumeCursor, now(), attemptId);
      for (const listener of listeners) listener(event);
    };
    const end = (reason: TurnEndReason, detail: string | null): TurnEndReason => {
      record({ type: "turn_ended", reason, detail });
      db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(reason === "completed" ? "ended" : reason === "interrupted" ? "interrupted" : "failed", now(), attemptId);
      return reason;
    };
    const play = async (prompt: string, turn: number): Promise<TurnEndReason> => {
      prompts.push(prompt);
      // The prompt is the caller's own; what follows is what the real CLI did in the recorded turn.
      record({ type: "user_prompt", text: prompt });
      const kind = planned[turn];
      if (kind === undefined) return end("error", "The test named no recorded turn for this attempt.");
      const gate = gates.get(key(n, turn));
      const atSession = o.holdAt === "session";
      if (!atSession) {
        arrival(n, turn).resolve();
        if (gate) await Promise.race([gate, stopping]);
      }
      const recorded = typeof kind === "string" ? turns[kind] : { events: kind.events, hookCwd: new Map<string, string>(), files: undefined };
      const edits = new Set(recorded.events.flatMap((event) => (event.type === "tool_call" && EDIT_TOOLS.has(event.name) ? [event.id] : [])));
      let given: unknown = null;
      for (const event of recorded.events) {
        if (event.type === "user_prompt") continue;
        await new Promise((resolve) => setImmediate(resolve));
        if (stopped) return end("interrupted", "The replay was stopped.");
        if (event.type === "turn_ended") return end(event.reason, event.detail);
        if (event.type === "tool_result" && edits.has(event.id) && !event.isError && recorded.files) {
          for (const [file, content] of Object.entries(recorded.files)) fs.writeFileSync(path.join(options.cwd, file), content);
        }
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
          arrival(n, turn).resolve();
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
        // One turn at a time, as the real CLI's session takes them; a further one only when the test gave this attempt several.
        if (running || stopped || over) return Promise.reject(new Error("This replayed attempt is still on its turn, or was stopped."));
        if (sent > 0 && sent >= planned.length) return Promise.reject(new Error(planned.length <= 1 ? "This replayed attempt holds one turn, and it was already sent." : `This replayed attempt holds ${planned.length} turns, and all were already sent.`));
        const turn = sent;
        sent += 1;
        running = true;
        playing = play(prompt, turn).finally(() => (running = false));
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
    release: (n, turn = 0) => releases.get(key(n, turn))?.(),
    held: (n, turn = 0) => arrival(n, turn).promise,
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
