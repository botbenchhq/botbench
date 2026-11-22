import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "../store/db.ts";
import { DriverUnavailableError, type BillingKind, type Driver, type DriverCapabilities, type DriverProbe, type DriverSession, type ResumeCursor, type StartAttemptOptions } from "./contract.ts";
import type { DriverEvent, TurnEndReason } from "./events.ts";
import { checkVersion, killProcessGroup, launch, processGroupAlive, runCli, type CliChild } from "./launch.ts";

/*
 * Claude Code, driven over its stream-json protocol (seen on 2.1.322):
 *   stdin   one JSON object per line: {"type":"user","message":{"role":"user","content":"..."}}
 *           or {"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}
 *   stdout  one JSON object per line, per turn:
 *           system/init (session_id, model), assistant (message.content blocks),
 *           user (tool results), rate_limit_event, then result (usage, is_error, terminal_reason)
 * The process stays up between turns and exits when stdin closes.
 */

const COMMAND = "claude";
export const CLAUDE_CODE = "claude-code";

/** Attempt states this driver writes to `attempts.status`. */
export type AttemptStatus = "running" | "interrupted" | "failed" | "ended";

const CAPABILITIES: DriverCapabilities = { resume: true, interrupt: true, permissionRequests: false };

/**
 * The arguments every Claude Code attempt is started with. Only the project's
 * own settings load, and the only MCP servers are the ones named here, which is
 * none: the owner's personal settings, allow rules, hooks, plugins and MCP
 * servers stay out. Nothing can answer a permission prompt until the permission
 * broker exists, so anything that would ask is denied.
 */
export function claudeArgs(options: { model?: string; resumeCursor?: ResumeCursor } = {}): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--permission-prompts", "none",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.resumeCursor) args.push("--resume", options.resumeCursor);
  return args;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A tool result's content is a string or a list of blocks; the transcript keeps it as text. */
function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (isObject(block) && typeof block.text === "string" ? block.text : JSON.stringify(block))).join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/**
 * Turn one line of Claude Code's output into normalized events. Pure. A line
 * that is not a JSON object becomes an `error` event; a well-formed line that
 * carries nothing for the transcript becomes no events.
 */
export function parseClaudeLine(line: string): DriverEvent[] {
  if (line.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "error", message: "The CLI printed a line that is not JSON.", raw: shorten(line) }];
  }
  if (!isObject(parsed) || typeof parsed.type !== "string") {
    return [{ type: "error", message: "The CLI printed a line that is not a message.", raw: shorten(line) }];
  }

  switch (parsed.type) {
    case "system": {
      const session = str(parsed.session_id);
      return parsed.subtype === "init" && session ? [{ type: "session_started", resumeCursor: session, model: str(parsed.model), keySource: str(parsed.apiKeySource) }] : [];
    }
    case "assistant":
    case "user": {
      const content = isObject(parsed.message) ? parsed.message.content : undefined;
      if (!Array.isArray(content)) return [];
      const events: DriverEvent[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (parsed.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text !== "") {
          events.push({ type: "text", text: block.text });
        } else if (parsed.type === "assistant" && block.type === "tool_use") {
          events.push({ type: "tool_call", id: str(block.id) ?? "", name: str(block.name) ?? "", input: block.input ?? null });
        } else if (parsed.type === "user" && block.type === "tool_result") {
          events.push({ type: "tool_result", id: str(block.tool_use_id) ?? "", output: toolOutput(block.content), isError: block.is_error === true });
        }
      }
      return events;
    }
    case "rate_limit_event": {
      const info = isObject(parsed.rate_limit_info) ? parsed.rate_limit_info : {};
      const status = str(info.status) ?? "unknown";
      const resetsAt = typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null;
      return [{ type: "rate_limit", limited: status === "rejected", status, resetsAt }];
    }
    case "result": {
      const events: DriverEvent[] = [];
      if (isObject(parsed.usage)) {
        const u = parsed.usage;
        events.push({
          type: "usage",
          inputTokens: count(u.input_tokens),
          outputTokens: count(u.output_tokens),
          cacheReadTokens: count(u.cache_read_input_tokens),
          cacheWriteTokens: count(u.cache_creation_input_tokens),
        });
      }
      const terminal = str(parsed.terminal_reason);
      if (parsed.is_error !== true && parsed.subtype === "success") {
        events.push({ type: "turn_ended", reason: "completed", detail: null });
      } else if (terminal?.startsWith("aborted")) {
        events.push({ type: "turn_ended", reason: "interrupted", detail: terminal });
      } else {
        const detail = shorten([str(parsed.subtype), terminal, str(parsed.result)].filter(Boolean).join(": ") || "The turn failed.");
        events.push({ type: "error", message: detail, raw: null }, { type: "turn_ended", reason: "error", detail });
      }
      return events;
    }
    default:
      return [];
  }
}

interface AttemptChange {
  status?: AttemptStatus;
  resumeCursor?: ResumeCursor;
  model?: string | null;
  /** True once the process group is known to be gone. */
  clearPgid?: boolean;
}

class ClaudeCodeSession implements DriverSession {
  readonly attemptId: number;
  readonly capabilities = CAPABILITIES;
  /** The CLI's process group, for callers that need to check on it. */
  readonly pgid: number;
  private readonly db: DatabaseSync;
  private readonly child: CliChild;
  private readonly listeners = new Set<(event: DriverEvent) => void>();
  private readonly exited: Promise<void>;
  private turn = 0;
  private running: { done: Promise<TurnEndReason>; resolve: (reason: TurnEndReason) => void } | null = null;
  private interrupting = false;
  private announced = false;
  private closing = false;
  private hasExited = false;
  private status: AttemptStatus = "running";
  private cursor: ResumeCursor | null;
  private stderrTail = "";

  constructor(db: DatabaseSync, attemptId: number, child: CliChild, pgid: number, cursor: ResumeCursor | null) {
    this.db = db;
    this.attemptId = attemptId;
    this.child = child;
    this.pgid = pgid;
    this.cursor = cursor;

    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-2000)));
    // A write to a child that has just died fails here; the exit handler reports it.
    child.stdin.on("error", () => {});
    let spawnError: Error | null = null;
    child.on("error", (err) => (spawnError = err));
    this.exited = new Promise((resolve) => {
      child.once("close", (code, signal) => void this.onExit(code, signal, spawnError).finally(resolve));
    });
  }

  resumeCursor(): ResumeCursor | null {
    return this.cursor;
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendTurn(prompt: string): Promise<TurnEndReason> {
    if (this.hasExited || this.closing || this.status !== "running") return Promise.reject(new Error(`This attempt is ${this.hasExited || this.closing ? "over" : this.status}; start a new attempt to continue.`));
    if (this.running) return Promise.reject(new Error("A turn is already running in this attempt."));
    this.turn += 1;
    let resolve!: (reason: TurnEndReason) => void;
    const done = new Promise<TurnEndReason>((r) => (resolve = r));
    this.running = { done, resolve };
    this.write({ type: "user", message: { role: "user", content: prompt } });
    return done;
  }

  async interruptTurn(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.interrupting = true;
    this.write({ type: "control_request", request_id: `smelt-interrupt-${this.turn}`, request: { subtype: "interrupt" } });
    // The CLI normally ends the turn within milliseconds. If it does not, the turn is ended here.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running.done, new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    if (this.running) this.endTurn("interrupted", "The CLI did not confirm the interrupt in time.");
    await this.stopProcess();
  }

  respondToRequest(_requestId: string, _response: unknown): Promise<void> {
    return Promise.reject(new Error("Claude Code requests are not supported until the permission broker exists."));
  }

  async close(): Promise<void> {
    if (this.running) return this.interruptTurn();
    this.closing = true;
    if (!this.hasExited) {
      this.child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.exited, new Promise((r) => (timer = setTimeout(r, 3000)))]);
      clearTimeout(timer);
    }
    await this.stopProcess();
  }

  /** Kill whatever is left of the process group and wait until the exit has been recorded. */
  private async stopProcess(): Promise<void> {
    this.closing = true;
    await killProcessGroup(this.pgid);
    await this.exited;
  }

  private write(message: unknown): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    for (const event of parseClaudeLine(line)) {
      if (event.type === "session_started") {
        // A repository's own settings can hand the CLI an API key, which would bill a subscription
        // session as metered use. Stop the turn the moment the CLI says a key is in play.
        if (event.keySource !== null && event.keySource !== "none") {
          const detail = `Stopped: the CLI would pay for this turn with an API key (source: ${event.keySource}), not the signed-in login.`;
          this.record({ type: "error", message: detail, raw: null });
          if (this.running) this.endTurn("error", detail, "failed");
          void killProcessGroup(this.pgid).catch(() => {});
          return;
        }
        // The CLI announces the session at the start of every turn. Only a new cursor is news.
        if (this.announced && event.resumeCursor === this.cursor) continue;
        this.announced = true;
        this.cursor = event.resumeCursor;
        this.record(event, { resumeCursor: event.resumeCursor, model: event.model });
      } else if (event.type === "turn_ended") {
        // A result with no turn open is the late echo of a turn already ended here.
        if (this.running) this.endTurn(this.interrupting ? "interrupted" : event.reason, event.detail);
      } else {
        this.record(event);
      }
    }
  }

  /** Store the end of the running turn together with the status it causes, then release the caller. */
  private endTurn(reason: TurnEndReason, detail: string | null, status?: AttemptStatus): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    if (reason === "interrupted") status = "interrupted";
    if (status) this.status = status;
    this.record({ type: "turn_ended", reason, detail }, status ? { status } : undefined);
    running.resolve(reason);
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): Promise<void> {
    this.hasExited = true;
    if (this.running) {
      if (this.interrupting) {
        this.endTurn("interrupted", "The CLI exited.");
      } else {
        const how = spawnError ? spawnError.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
        const message = `Claude Code ${how} during a turn.`;
        this.record({ type: "error", message, raw: this.stderrTail.trim() === "" ? null : shorten(this.stderrTail.trim()) });
        this.endTurn("error", message, "failed");
      }
    }
    // The CLI itself is gone, but something it started may still be in its group.
    await killProcessGroup(this.pgid).catch(() => {});
    const change: AttemptChange = { clearPgid: !processGroupAlive(this.pgid) };
    if (this.status === "running") {
      this.status = this.closing ? "ended" : "failed";
      change.status = this.status;
    }
    this.updateAttempt(change);
  }

  /** Append the event, apply the attempt change it causes in the same transaction, then tell listeners. */
  private record(event: DriverEvent, change?: AttemptChange): void {
    const insert = (): void => {
      this.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(this.attemptId, this.turn, now(), event.type, JSON.stringify(event));
    };
    if (change) {
      transaction(this.db, () => {
        insert();
        this.updateAttempt(change);
      });
    } else {
      insert();
    }
    for (const listener of this.listeners) listener(event);
  }

  private updateAttempt(change: AttemptChange): void {
    const sets = ["updated_at = ?"];
    const values: (string | number | null)[] = [now()];
    if (change.status) (sets.push("status = ?"), values.push(change.status));
    if (change.resumeCursor) (sets.push("resume_cursor = ?"), values.push(change.resumeCursor));
    if (change.model) (sets.push("model = ?"), values.push(change.model));
    if (change.clearPgid) sets.push("pgid = NULL");
    this.db.prepare(`UPDATE attempts SET ${sets.join(", ")} WHERE id = ?`).run(...values, this.attemptId);
  }
}

export interface ClaudeCodeDriverOptions {
  /** Claude Code's configuration directory, for an owner who keeps it somewhere other than the default. */
  configDir?: string;
}

export class ClaudeCodeDriver implements Driver {
  readonly name = CLAUDE_CODE;
  readonly capabilities = CAPABILITIES;
  private readonly extraEnv: Record<string, string>;

  constructor(options: ClaudeCodeDriverOptions = {}) {
    this.extraEnv = options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {};
  }

  /**
   * Ask the CLI itself: `claude --version` for the version and
   * `claude auth status` for the login. No credential file is read.
   */
  async probe(): Promise<DriverProbe> {
    const launchOptions = { cwd: os.tmpdir(), extraEnv: this.extraEnv };
    const versionRun = await runCli(COMMAND, ["--version"], launchOptions);
    if (!versionRun.started) {
      return { installed: false, version: null, supported: false, signedIn: false, billing: "unknown", problem: "Claude Code is not installed, or `claude` is not on the PATH." };
    }
    const check = checkVersion(versionRun.stdout);
    if (!check.supported) {
      const problem = check.version
        ? `Claude Code ${check.version} is too old for Smelt: it is not known to accept ${check.missingFlags.join(", ")}. Update Claude Code.`
        : "Claude Code did not report a version Smelt can read.";
      return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem };
    }

    // Signed out, the command exits 1 and still prints its JSON.
    const statusRun = await runCli(COMMAND, ["auth", "status", "--json"], launchOptions);
    let status: unknown;
    try {
      status = JSON.parse(statusRun.stdout);
    } catch {
      status = null;
    }
    if (!isObject(status)) {
      return { installed: true, version: check.version, supported: true, signedIn: false, billing: "unknown", problem: "Claude Code did not report its sign-in status." };
    }
    const signedIn = status.loggedIn === true;
    // A claude.ai login is a subscription. Any other kind of login has not been seen yet, so it is not guessed at.
    const billing: BillingKind = signedIn && status.authMethod === "claude.ai" ? "subscription" : "unknown";
    return { installed: true, version: check.version, supported: true, signedIn, billing, problem: signedIn ? null : "Claude Code is signed out. Run `claude auth login` in a terminal." };
  }

  async startAttempt(options: StartAttemptOptions): Promise<DriverSession> {
    const probe = await this.probe();
    if (probe.problem) throw new DriverUnavailableError(probe);
    if (!fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The working directory does not exist: ${options.cwd}`);

    const { child, pgid } = launch(COMMAND, claudeArgs(options), { cwd: options.cwd, extraEnv: this.extraEnv });
    if (!pgid) {
      child.on("error", () => {});
      throw new Error("Claude Code could not be started.");
    }
    let attemptId: number;
    try {
      const at = now();
      const { lastInsertRowid } = options.db
        .prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?)")
        .run(CLAUDE_CODE, options.model ?? null, options.resumeCursor ?? null, pgid, at, at);
      attemptId = Number(lastInsertRowid);
    } catch (err) {
      // A process nobody has a record of must not be left behind.
      await killProcessGroup(pgid);
      throw err;
    }
    return new ClaudeCodeSession(options.db, attemptId, child, pgid, options.resumeCursor ?? null);
  }
}
