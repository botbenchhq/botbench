import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import type { Driver, DriverCapabilities, DriverSession, StartAttemptOptions } from "../../src/drivers/contract.ts";
import { limitedEnd } from "../../src/drivers/claude-code.ts";
import type { DriverEvent, PermissionResponse, TurnEndReason } from "../../src/drivers/events.ts";
import { killProcessGroup, launch, processGroupAlive } from "../../src/drivers/launch.ts";

/*
 * A driver whose every attempt is a real process group, for the silence limit (src/engine/silence.ts): its tests need
 * an agent process that stays alive and sends nothing, which no live model can be made to do on demand, and a recorded
 * session cannot be, as it has no process.
 *
 * What is real: the process, started by Botbench's own `launch` as `/bin/sh -c <script>` in its own group in the
 * task's copy, with Botbench's allowlisted environment; the children it starts; the group recorded on the attempt as
 * the Claude Code driver records it; the stop, by Botbench's own `killProcessGroup`; and the permission check: each
 * request is put to the real broker on its real socket, as Claude Code's pre-tool hook puts it, before it is asked.
 * What is not: the events. Sending the turn writes a line `go` to the process's input, which each script reads first.
 * Each line the process prints is stored as a `text` event; a line `ask <command>` is stored
 * as a request to run that shell command, and the answer is written to the process's input as a line `allow` or
 * `deny`. A line `limit <ISO time>` (or `limit` alone) is stored as the agent reporting that its usage limit was reached
 * and resets then (or gives no time), in the shape the Claude Code driver gives it; a turn that then ends in error ends
 * as the Claude Code driver ends one after a limit (`limitedEnd`). The turn ends when the process ends: exit code 0 is a
 * completed turn. With `resume`, each attempt reports a session when its turn is sent: the one it was started to take
 * up, or a new one. No test may read these events as what a CLI does.
 */

// As the Claude Code driver reports them, but with no session to take up again: the process reports none.
const CAPABILITIES: DriverCapabilities = { resume: false, interrupt: true, permissionRequests: true, edits: true, confinedCommands: true };
type RateLimit = Extract<DriverEvent, { type: "rate_limit" }>;
const now = (): string => new Date().toISOString();

export interface ProcessDriver extends Driver {
  /** The process group of each attempt, in the order they were started. */
  readonly groups: number[];
  /** Every prompt sent, in order. */
  readonly prompts: string[];
  /** What each attempt was started with, in order: the session it was to take up, and the model. */
  readonly starts: { resumeCursor: string | null; model: string | null }[];
}

/** A driver whose `n`th attempt runs `scripts[n]`, or the last script once they run out. */
export function processDriver(scripts: readonly string[], o: { resume?: boolean; name?: string } = {}): ProcessDriver {
  const groups: number[] = [];
  const prompts: string[] = [];
  const starts: { resumeCursor: string | null; model: string | null }[] = [];
  const capabilities: DriverCapabilities = { ...CAPABILITIES, resume: o.resume === true };

  const session = (db: DatabaseSync, attemptId: number, script: string, options: StartAttemptOptions): DriverSession => {
    const { child, pgid } = launch("/bin/sh", ["-c", script], { cwd: options.cwd });
    db.prepare("UPDATE attempts SET pgid = ?, updated_at = ? WHERE id = ?").run(pgid, now(), attemptId);
    groups.push(pgid);
    const listeners = new Set<(event: DriverEvent) => void>();
    const asking = new Map<string, Extract<DriverEvent, { type: "permission_request" }>>();
    let running: ((reason: TurnEndReason) => void) | null = null;
    let interrupting = false;
    let asked = 0;
    let limit: RateLimit | null = null;
    const cursor = options.resumeCursor ?? `session-${attemptId}`;
    let lines = Promise.resolve();
    child.stdin.on("error", () => {});
    child.stderr.resume();

    const record = (event: DriverEvent): void => {
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attemptId, now(), event.type, JSON.stringify(event));
      for (const listener of listeners) listener(event);
    };
    const end = (reason: TurnEndReason, detail: string | null): void => {
      const resolve = running;
      if (resolve === null) return;
      running = null;
      for (const [id, request] of asking) record({ type: "permission_resolved", id, toolCallId: request.toolCallId, decision: "cancelled", note: null });
      asking.clear();
      record(limitedEnd({ type: "turn_ended", reason, detail }, limit));
      db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(reason === "completed" ? "ended" : reason === "interrupted" ? "interrupted" : "failed", now(), attemptId);
      resolve(reason);
    };
    const exited = new Promise<void>((resolve) => {
      // Every line the process printed is read before its end is recorded.
      child.once("close", (code, signal) => void lines.then(() => {
        end(interrupting ? "interrupted" : code === 0 ? "completed" : "error", interrupting ? "The process was stopped." : code === 0 ? null : `The process ended with ${signal ?? `code ${code}`}.`);
        // What the process started may outlive it in its group.
        void killProcessGroup(pgid)
          .catch(() => {})
          .then(() => {
            if (!processGroupAlive(pgid)) db.prepare("UPDATE attempts SET pgid = NULL, updated_at = ? WHERE id = ?").run(now(), attemptId);
            resolve();
          });
      }));
    });

    const onLine = async (line: string): Promise<void> => {
      if (running === null) return;
      const limited = /^limit(?: (\S+))?$/.exec(line);
      if (limited !== null) {
        limit = { type: "rate_limit", limited: true, status: "rejected", resetsAt: limited[1] ?? null };
        return record(limit);
      }
      const ask = /^ask (.+)$/.exec(line);
      if (ask === null) return record({ type: "text", text: line });
      asked += 1;
      const toolCallId = `call-${attemptId}-${asked}`;
      const input = { command: ask[1]! };
      // The pre-tool hook's report first, as Claude Code's hook gives it, so the broker knows the directory the call is made from.
      if (options.gate) await askBroker(options.gate.socketPath, options.gate.secret, { tool_name: "Bash", tool_input: input, tool_use_id: toolCallId, cwd: options.cwd });
      const request = { type: "permission_request" as const, id: `request-${attemptId}-${asked}`, toolCallId, name: "Bash", input, reason: null };
      asking.set(request.id, request);
      record(request);
    };
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      lines = lines.then(() => onLine(line));
    });

    const interruptTurn = async (): Promise<void> => {
      if (running === null) return;
      interrupting = true;
      await killProcessGroup(pgid);
      await exited;
    };
    return {
      attemptId,
      capabilities,
      resumeCursor: () => (o.resume === true ? cursor : null),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendTurn: (prompt) => {
        if (running !== null || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error("This process holds one turn, and it was already sent."));
        prompts.push(prompt);
        const done = new Promise<TurnEndReason>((resolve) => (running = resolve));
        record({ type: "user_prompt", text: prompt });
        if (o.resume === true) {
          db.prepare("UPDATE attempts SET resume_cursor = ?, updated_at = ? WHERE id = ?").run(cursor, now(), attemptId);
          record({ type: "session_started", resumeCursor: cursor, model: options.model ?? null, keySource: "none" });
        }
        // Each script begins with `read go`, so nothing it prints comes before its turn is sent.
        if (child.stdin.writable) child.stdin.write("go\n");
        return done;
      },
      interruptTurn,
      respondToRequest: (id, response) => {
        const request = asking.get(id);
        if (!request) return Promise.reject(new Error(`No request ${id} is waiting in this process.`));
        asking.delete(id);
        const given = (typeof response === "object" && response !== null ? response : {}) as Partial<PermissionResponse>;
        const allowed = given.decision === "allow";
        record({ type: "permission_resolved", id, toolCallId: request.toolCallId, decision: allowed ? (given.mode ? "mode" : "allowed") : given.refused ? "denied" : "declined", note: given.refused ?? given.note ?? null });
        if (child.stdin.writable) child.stdin.write(allowed ? "allow\n" : "deny\n");
        return Promise.resolve();
      },
      close: async () => {
        if (running !== null) return interruptTurn();
        child.stdin.end();
        await killProcessGroup(pgid);
        await exited;
      },
    };
  };

  // `name`: the agent the driver stands in for in the engine's own bookkeeping (a hand-off between two of these, whose
  // engine logic is under test); its events are still this driver's, never what that agent's CLI does.
  const name = o.name ?? "claude-code";
  return {
    name,
    capabilities,
    groups,
    prompts,
    starts,
    probe: () => Promise.resolve({ installed: true, version: null, supported: true, signedIn: true, billing: "unknown", problem: null }),
    models: () => Promise.resolve({ source: "config", models: [], default: null, cliDefault: null }),
    startAttempt: (options) => {
      starts.push({ resumeCursor: options.resumeCursor ?? null, model: options.model ?? null });
      const at = now();
      const attemptId = Number(options.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'running', NULL, ?, ?)").run(name, options.model ?? null, at, at).lastInsertRowid);
      return Promise.resolve(session(options.db, attemptId, scripts[Math.min(groups.length, scripts.length - 1)]!, options));
    },
  };
}
