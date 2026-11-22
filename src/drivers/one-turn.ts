import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "../store/db.ts";
import type { DriverCapabilities, DriverSession } from "./contract.ts";
import type { DriverEvent, TurnEndReason } from "./events.ts";
import { killProcessGroup, launch, processGroupAlive, type CliChild } from "./launch.ts";

/*
 * One CLI process for one turn, for the reviewers (Codex, Grok, Antigravity): the prompt goes on the CLI's input, one
 * JSON object per output line is read into normalized events, and the process group is killed when the turn ends, is
 * stopped, or `stop` says it must not go on. Nothing can be answered: a reviewer asks for nothing.
 */

/** What one line of a CLI's output gave: its events, and why the turn must stop now (null when it may go on). */
export interface LineResult {
  events: DriverEvent[];
  stop: string | null;
}

export interface OneTurnSpec {
  /** The agent's name as a screen shows it, for the session's own messages. */
  agent: string;
  command: string;
  args: string[];
  cwd: string;
  extraEnv: Record<string, string>;
  capabilities: DriverCapabilities;
  /** What is written to the CLI's input for `prompt`. Never the command line, where any process on the Mac could read it. */
  input(prompt: string): string;
  /** A reader for this turn's output lines. It may keep state across lines (a reply sent in pieces). */
  reader(): (line: string) => LineResult;
  /** Called once the process is gone. */
  cleanup?(): void;
}

const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export class OneTurnSession implements DriverSession {
  readonly attemptId: number;
  readonly capabilities: DriverCapabilities;
  private readonly db: DatabaseSync;
  private readonly spec: OneTurnSpec;
  private readonly listeners = new Set<(event: DriverEvent) => void>();
  private turn = 0;
  private child: CliChild | null = null;
  private pgid = 0;
  private running: { resolve: (reason: TurnEndReason) => void } | null = null;
  private exited: Promise<void> = Promise.resolve();
  private interrupting = false;
  private over = false;
  private cursor: string | null = null;
  private stderrTail = "";
  private readonly called = new Set<string>();

  constructor(db: DatabaseSync, attemptId: number, spec: OneTurnSpec) {
    this.db = db;
    this.attemptId = attemptId;
    this.spec = spec;
    this.capabilities = spec.capabilities;
  }

  resumeCursor(): string | null {
    return this.cursor;
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One turn per session: a reviewer here neither keeps a session nor resumes one. */
  sendTurn(prompt: string): Promise<TurnEndReason> {
    if (this.over || this.turn > 0) return Promise.reject(new Error(`This session with ${this.spec.agent} has ended: Botbench gives ${this.spec.agent} one message per session.`));
    this.turn = 1;
    const done = new Promise<TurnEndReason>((resolve) => (this.running = { resolve }));
    this.record({ type: "user_prompt", text: prompt });
    const { child, pgid } = launch(this.spec.command, this.spec.args, { cwd: this.spec.cwd, extraEnv: this.spec.extraEnv });
    this.child = child;
    this.pgid = pgid;
    if (pgid) this.db.prepare("UPDATE attempts SET pgid = ?, updated_at = ? WHERE id = ?").run(pgid, now(), this.attemptId);
    const read = this.spec.reader();
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(read(line)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-2000)));
    child.stdin.on("error", () => {});
    let spawnError: Error | null = null;
    child.on("error", (err) => (spawnError = err));
    this.exited = new Promise((resolve) => child.once("close", (code, signal) => void this.onExit(code, signal, spawnError).finally(resolve)));
    child.stdin.end(this.spec.input(prompt));
    return done;
  }

  async interruptTurn(): Promise<void> {
    if (!this.running) return;
    this.interrupting = true;
    if (this.pgid) await killProcessGroup(this.pgid);
    await this.exited;
  }

  respondToRequest(requestId: string): Promise<void> {
    return Promise.reject(new Error(`${this.spec.agent} cannot be answered in Botbench: no request ${requestId} can be waiting, as a review asks for nothing.`));
  }

  async close(): Promise<void> {
    if (this.running) await this.interruptTurn();
    this.over = true;
    if (this.pgid) await killProcessGroup(this.pgid).catch(() => {});
    await this.exited;
    if (this.turn === 0) this.spec.cleanup?.();
    this.db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), this.attemptId);
  }

  private onLine({ events, stop }: LineResult): void {
    for (const event of events) {
      if (event.type === "turn_ended") {
        if (this.running) this.endTurn(event.reason, event.detail);
        continue;
      }
      if (event.type === "tool_call") {
        if (this.called.has(event.id)) continue;
        this.called.add(event.id);
      }
      if (event.type === "session_started") this.cursor = event.resumeCursor;
      this.record(event);
    }
    if (stop !== null && this.running) {
      this.endTurn("error", stop);
      if (this.pgid) void killProcessGroup(this.pgid).catch(() => {});
    }
  }

  private endTurn(reason: TurnEndReason, detail: string | null): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    const status = reason === "completed" ? null : reason === "interrupted" ? "interrupted" : "failed";
    this.record({ type: "turn_ended", reason, detail }, status);
    running.resolve(reason);
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): Promise<void> {
    if (this.running) {
      if (this.interrupting) this.endTurn("interrupted", `${this.spec.agent} was stopped.`);
      else {
        const how = spawnError ? spawnError.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
        const message = `${this.spec.agent} ${how} before it finished.`;
        this.record({ type: "error", message, raw: this.stderrTail.trim() === "" ? null : shorten(this.stderrTail.trim()) });
        this.endTurn("error", message);
      }
    }
    if (this.pgid) await killProcessGroup(this.pgid).catch(() => {});
    if (!processGroupAlive(this.pgid)) this.db.prepare("UPDATE attempts SET pgid = NULL, updated_at = ? WHERE id = ?").run(now(), this.attemptId);
    this.db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), this.attemptId);
    this.over = true;
    this.spec.cleanup?.();
  }

  private record(event: DriverEvent, status: string | null = null): void {
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(this.attemptId, this.turn, now(), event.type, JSON.stringify(event));
      if (status !== null) this.db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), this.attemptId);
    });
    for (const listener of this.listeners) listener(event);
  }
}

/** Make the attempt one review turn runs in, and its session. */
export function startOneTurn(db: DatabaseSync, driver: string, model: string | null, spec: OneTurnSpec): OneTurnSession {
  const at = now();
  const { lastInsertRowid } = db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'running', NULL, ?, ?)").run(driver, model, at, at);
  return new OneTurnSession(db, Number(lastInsertRowid), spec);
}
