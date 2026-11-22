import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { confinementProblem, unreadablePaths } from "../confinement.ts";
import { now, transaction } from "../store/db.ts";
import { DriverUnavailableError, modelNameProblem, type BillingKind, type Driver, type DriverCapabilities, type DriverModels, type DriverProbe, type DriverSession, type ModelChoice, type StartAttemptOptions } from "./contract.ts";
import type { DriverEvent, TurnEndReason } from "./events.ts";
import { buildChildEnv, checkVersion, killProcessGroup, launch, processGroupAlive, runCli, type CliChild } from "./launch.ts";
import { codexSignIn, type SignInDefinition } from "./sign-in.ts";

/*
 * Codex, driven for one thing only: a read-only review turn (U17 in part, for U20). Seen on 0.171.0:
 *   `codex exec --json … -` reads the prompt from its input and prints one JSON object per line:
 *     {"type":"thread.started","thread_id":"…"}  {"type":"turn.started"}
 *     {"type":"item.started"|"item.completed","item":{"id":"item_0","type":"command_execution","command":"…",
 *       "aggregated_output":"…","exit_code":0,"status":"completed"}}
 *     {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *     {"type":"item.completed","item":{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. …"}}
 *     {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…}}
 *     {"type":"turn.failed","error":{"message":"…"}}  and  {"type":"error","message":"…"}
 *   and exits once the turn is over. A command the sandbox refuses and that then exits non-zero is printed as no item at
 *   all (seen on 0.171.0): the transcript shows it only in the model's own words. One that exits 0 is printed, with what
 *   the sandbox said in its output. There is no way to answer a permission request over it, so Botbench never lets
 *   one be asked (`approval_policy = "never"`): what the profile forbids is refused, and the model is told so.
 *
 * Confinement, without `--sandbox` (passing it, or `sandbox_mode` in any config Codex loads, sets permission profiles
 * aside): a permissions profile given with `-c` extends the built-in `:read-only`, so commands write nothing, the
 * task's copy included; it denies reading the home folder, every place of the one shared list in src/confinement.ts,
 * Codex's own folder where the owner moved it, and Botbench's data folder; it opens again for reading only the task's
 * copy and the repository's git folder (a narrower rule wins, seen on 0.171.0); and it gives commands no network.
 * Seen with `codex sandbox -P` on 0.171.0: a decoy in a denied folder and `~/.codex` read as "Operation not permitted",
 * a write in the copy failed, and a name did not resolve.
 *
 * What the review is started without: the owner's config.toml (`--ignore-user-config`, which also leaves out personal
 * MCP servers and profiles), the owner's and the repository's command rules (`--ignore-rules`), hooks, plugins, apps,
 * the browser and computer use (`--disable`), web search, and any saved session (`--ephemeral`). A repository's own
 * `.codex/` folder is not loaded for a folder Codex was never told to trust, and every setting here is a session flag,
 * which outranks project config. Codex says when it ignores a setting it does not know; Botbench then stops the turn,
 * since a setting it relies on would not be in force.
 */

const COMMAND = "codex";
export const CODEX = "codex";

/** Codex here does one read-only turn: it cannot resume, cannot put a permission request to the owner, and is never let edit. It can be stopped. */
export const CODEX_CAPABILITIES: DriverCapabilities = { resume: false, interrupt: true, permissionRequests: false, edits: false };

/** The name of Botbench's permissions profile for a review. */
export const REVIEW_PROFILE = "botbench-review";

/** Features of 0.171.0 a review has no use for; each is a name `codex features list` shows. */
const DISABLED_FEATURES = ["hooks", "plugins", "apps", "browser_use", "computer_use", "image_generation"];

/**
 * Variables Botbench sets for Codex on top of the allowlisted ones. The home folder is unreadable to commands, and git
 * stops at an unreadable ~/.gitconfig, so git in a command reads no global configuration at all.
 */
const EXTRA_ENV = { GIT_CONFIG_GLOBAL: "/dev/null" };

/** The environment a review runs in: the allowlist of src/drivers/launch.ts, no provider key, and git kept off the home folder. */
export const codexEnv = (parent: NodeJS.ProcessEnv = process.env): Record<string, string> => buildChildEnv(parent, EXTRA_ENV);

/** Where a review works: the task's copy, Botbench's data folder, and the repository's shared git folder. */
export interface ReviewPlace {
  cwd: string;
  dataDir: string;
  gitDir?: string;
}

const realOrAsIs = (place: string): string => {
  try {
    return fs.realpathSync(place);
  } catch {
    return path.resolve(place);
  }
};

/** A path as a TOML basic string. One that could break out of the string is refused. */
function tomlPath(place: string): string {
  if (/[\0-\x1f"\\\x7f]/.test(place)) throw new Error(`Botbench cannot confine Codex with the path ${JSON.stringify(place)}: it holds a quote, a backslash or a control character.`);
  return `"${place}"`;
}

/**
 * The arguments of one review turn. `env` is where a moved Codex folder (CODEX_HOME) is read from; Botbench's own
 * environment when left out.
 */
export function codexArgs(o: { place: ReviewPlace; model?: string; env?: NodeJS.ProcessEnv }): string[] {
  const home = os.homedir();
  const denied = [home, ...unreadablePaths({ dataDir: o.place.dataDir, home, ...(o.env ? { env: o.env } : {}) })];
  const readable = [realOrAsIs(o.place.cwd), ...(o.place.gitDir === undefined ? [] : [realOrAsIs(o.place.gitDir)])];
  const rules = new Map<string, string>();
  for (const place of denied) rules.set(place, "deny");
  for (const place of readable) rules.set(place, "read");
  const filesystem = `{${[...rules].map(([place, rule]) => `${tomlPath(place)}="${rule}"`).join(",")}}`;
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "-C", o.place.cwd,
    "-c", 'approval_policy="never"',
    "-c", `default_permissions="${REVIEW_PROFILE}"`,
    "-c", `permissions.${REVIEW_PROFILE}.extends=":read-only"`,
    "-c", `permissions.${REVIEW_PROFILE}.filesystem=${filesystem}`,
    "-c", `permissions.${REVIEW_PROFILE}.network.enabled=false`,
    "-c", "mcp_servers={}",
    "-c", 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ];
  if (o.model !== undefined) {
    const problem = modelNameProblem(o.model);
    if (problem !== null) throw new Error(`The model name cannot be passed to Codex. ${problem}`);
    args.push("-m", o.model);
  }
  args.push("-");
  return args;
}

/** What `codex login status` printed, and how it exited, as a sign-in. Its words on 0.171.0: "Logged in using ChatGPT", "Not logged in". */
export function parseLoginStatus(output: string, exitCode: number | null): { signedIn: boolean; billing: BillingKind } {
  if (exitCode !== 0 || !/^Logged in using /m.test(output)) return { signedIn: false, billing: "unknown" };
  if (/^Logged in using ChatGPT/m.test(output)) return { signedIn: true, billing: "subscription" };
  if (/^Logged in using an API key/m.test(output)) return { signedIn: true, billing: "metered" };
  return { signedIn: true, billing: "unknown" };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * The models `codex debug models` lists for people (visibility "list"), in its own order of priority. Pure. Null when
 * the output holds no such list. Only entries whose name could be handed back to the CLI are kept.
 */
export function parseCodexModels(output: string): ModelChoice[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const listed = isObject(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  const models = listed
    .filter((m): m is Record<string, unknown> => isObject(m) && m.visibility === "list" && typeof m.slug === "string" && modelNameProblem(m.slug) === null)
    .sort((a, b) => count(a.priority) - count(b.priority))
    .map((m) => ({ id: m.slug as string, ...(typeof m.display_name === "string" && m.display_name !== "" ? { label: shorten(m.display_name, 80) } : {}) }));
  return models.length > 0 ? models : null;
}

/** Codex's words when it ignores a setting it does not know (seen on 0.171.0). */
const IGNORED_SETTING = /unrecognized configuration setting/i;

/**
 * Turn one line of `codex exec --json` output into normalized events. Pure. A line that is not a JSON object becomes an
 * `error` event; a well-formed line that carries nothing for the transcript becomes no events. A finished command
 * carries its call as well as its result, since Codex may report a command only once it is over.
 */
export function parseCodexLine(line: string): DriverEvent[] {
  if (line.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "error", message: "Codex printed a line Botbench could not read.", raw: shorten(line) }];
  }
  if (!isObject(parsed) || typeof parsed.type !== "string") return [{ type: "error", message: "Codex printed a line that is not an event.", raw: shorten(line) }];
  switch (parsed.type) {
    case "thread.started": {
      const thread = str(parsed.thread_id);
      return thread ? [{ type: "session_started", resumeCursor: thread, model: null, keySource: null }] : [];
    }
    case "item.started":
    case "item.completed": {
      const item = isObject(parsed.item) ? parsed.item : null;
      if (item === null) return [];
      const id = str(item.id) ?? "";
      const done = parsed.type === "item.completed";
      switch (item.type) {
        case "agent_message":
          return done && typeof item.text === "string" && item.text !== "" ? [{ type: "text", text: item.text }] : [];
        case "command_execution": {
          const call: DriverEvent = { type: "tool_call", id, name: "shell", input: { command: str(item.command) ?? "" } };
          if (!done) return [call];
          const output = str(item.aggregated_output) ?? "";
          const confined = /Operation not permitted|Could not resolve host/.test(output) ? { confined: { hosts: [], files: /Operation not permitted/.test(output) } } : {};
          return [call, { type: "tool_result", id, output, isError: item.status !== "completed" || item.exit_code !== 0, ...confined }];
        }
        case "file_change": {
          const call: DriverEvent = { type: "tool_call", id, name: "file_change", input: { changes: item.changes ?? null } };
          return done ? [call, { type: "tool_result", id, output: str(item.status) ?? "", isError: item.status !== "completed" }] : [call];
        }
        case "mcp_tool_call":
        case "web_search":
          return [{ type: "tool_call", id, name: item.type, input: item }];
        case "error": {
          const message = str(item.message) ?? "Codex reported an error without saying what.";
          return done ? [{ type: "error", message: shorten(message), raw: null }] : [];
        }
        default:
          return [];
      }
    }
    case "turn.completed": {
      const u = isObject(parsed.usage) ? parsed.usage : {};
      // Codex's input count includes the cached part, which it also gives on its own.
      return [
        { type: "usage", inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens), cacheReadTokens: count(u.cached_input_tokens), cacheWriteTokens: count(u.cache_write_input_tokens) },
        { type: "turn_ended", reason: "completed", detail: null },
      ];
    }
    case "turn.failed": {
      const error = isObject(parsed.error) ? parsed.error : {};
      const detail = shorten(str(error.message) ?? "Codex reported that it failed without saying why.");
      return [{ type: "error", message: detail, raw: null }, { type: "turn_ended", reason: "error", detail }];
    }
    case "error":
      return [{ type: "error", message: shorten(str(parsed.message) ?? "Codex reported an error without saying what."), raw: null }];
    default:
      return [];
  }
}

class CodexSession implements DriverSession {
  readonly attemptId: number;
  readonly capabilities = CODEX_CAPABILITIES;
  private readonly db: DatabaseSync;
  private readonly args: string[];
  private readonly cwd: string;
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

  constructor(db: DatabaseSync, attemptId: number, args: string[], cwd: string) {
    this.db = db;
    this.attemptId = attemptId;
    this.args = args;
    this.cwd = cwd;
  }

  resumeCursor(): string | null {
    return this.cursor;
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One turn per session: Codex here neither keeps a session nor resumes one. */
  sendTurn(prompt: string): Promise<TurnEndReason> {
    if (this.over || this.turn > 0) return Promise.reject(new Error("This session with Codex has ended: Botbench gives Codex one message per session."));
    this.turn = 1;
    const done = new Promise<TurnEndReason>((resolve) => (this.running = { resolve }));
    this.record({ type: "user_prompt", text: prompt });
    const { child, pgid } = launch(COMMAND, this.args, { cwd: this.cwd, extraEnv: EXTRA_ENV });
    this.child = child;
    this.pgid = pgid;
    if (pgid) this.db.prepare("UPDATE attempts SET pgid = ?, updated_at = ? WHERE id = ?").run(pgid, now(), this.attemptId);
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-2000)));
    child.stdin.on("error", () => {});
    let spawnError: Error | null = null;
    child.on("error", (err) => (spawnError = err));
    this.exited = new Promise((resolve) => child.once("close", (code, signal) => void this.onExit(code, signal, spawnError).finally(resolve)));
    // The prompt goes on the input, never on the command line, where any process on the Mac could read it.
    child.stdin.end(prompt);
    return done;
  }

  async interruptTurn(): Promise<void> {
    if (!this.running) return;
    this.interrupting = true;
    if (this.pgid) await killProcessGroup(this.pgid);
    await this.exited;
  }

  respondToRequest(requestId: string): Promise<void> {
    return Promise.reject(new Error(`Codex cannot be answered in Botbench: no request ${requestId} can be waiting, as a review asks for nothing.`));
  }

  async close(): Promise<void> {
    if (this.running) await this.interruptTurn();
    this.over = true;
    if (this.pgid) await killProcessGroup(this.pgid).catch(() => {});
    await this.exited;
    this.db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), this.attemptId);
  }

  private onLine(line: string): void {
    for (const event of parseCodexLine(line)) {
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
      // A setting Codex ignores could be one the review's confinement rests on: nothing more runs.
      if (event.type === "error" && IGNORED_SETTING.test(event.message) && this.running) {
        this.endTurn("error", `Stopped: Codex did not take one of Botbench's settings (${event.message}), so the review could not be kept to read-only. Update Botbench or Codex.`);
        if (this.pgid) void killProcessGroup(this.pgid).catch(() => {});
      }
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
      if (this.interrupting) this.endTurn("interrupted", "Codex was stopped.");
      else {
        const how = spawnError ? spawnError.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
        const message = `Codex ${how} before it finished.`;
        this.record({ type: "error", message, raw: this.stderrTail.trim() === "" ? null : shorten(this.stderrTail.trim()) });
        this.endTurn("error", message);
      }
    }
    if (this.pgid) await killProcessGroup(this.pgid).catch(() => {});
    if (!processGroupAlive(this.pgid)) this.db.prepare("UPDATE attempts SET pgid = NULL, updated_at = ? WHERE id = ?").run(now(), this.attemptId);
    this.db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), this.attemptId);
    this.over = true;
  }

  private record(event: DriverEvent, status: string | null = null): void {
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(this.attemptId, this.turn, now(), event.type, JSON.stringify(event));
      if (status !== null) this.db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), this.attemptId);
    });
    for (const listener of this.listeners) listener(event);
  }
}

export interface CodexDriverOptions {
  /** The owner's configured list of models, offered when the CLI reports none. */
  models?: readonly string[];
  /** The configured model, preselected for the owner. The CLI's own default when absent. */
  defaultModel?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const MODELS_FRESH_MS = 60_000;

export class CodexDriver implements Driver {
  readonly name = CODEX;
  readonly capabilities = CODEX_CAPABILITIES;
  /** Codex's own device-code sign-in, for Connect in Settings (U26). A moved CODEX_HOME reaches it through the allowlist. */
  readonly signIn: SignInDefinition = codexSignIn();
  private readonly configured: { models: readonly string[]; defaultModel: string | null };
  private listing: { at: number; answer: Promise<DriverModels> } | null = null;

  constructor(options: CodexDriverOptions = {}) {
    this.configured = { models: options.models ?? [], defaultModel: options.defaultModel ?? null };
  }

  /** `codex --version` and `codex login status`, which prints to its error output. No credential file is read. */
  async probe(): Promise<DriverProbe> {
    const run = (args: string[]) => runCli(COMMAND, args, { cwd: os.tmpdir(), extraEnv: EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    const version = await run(["--version"]);
    if (!version.started) return { installed: false, version: null, supported: false, signedIn: false, billing: "unknown", problem: "Codex is not installed, or `codex` is not on the PATH." };
    const check = checkVersion(version.stdout, "codex");
    if (!check.supported) {
      const problem = check.version ? `Codex ${check.version} is too old for Botbench, which has been run only with 0.171.0 and later. Update Codex.` : "Codex did not report a version Botbench can read.";
      return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem };
    }
    const unconfined = confinementProblem();
    if (unconfined !== null) return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem: unconfined };
    const status = await run(["login", "status"]);
    const login = parseLoginStatus(`${status.stdout}\n${status.stderr}`, status.exitCode);
    return { installed: true, version: check.version, supported: true, ...login, problem: login.signedIn ? null : "Codex is signed out. Run `codex login` in a terminal." };
  }

  /** `codex debug models`, which lists the catalog and starts no turn. A CLI that is missing, slow or lists nothing leaves the configured list. */
  models(): Promise<DriverModels> {
    if (this.listing !== null && Date.now() - this.listing.at < MODELS_FRESH_MS) return this.listing.answer;
    const listing = { at: Date.now(), answer: this.readModels() };
    this.listing = listing;
    void listing.answer.then((answer) => {
      if (answer.source !== "cli" && this.listing === listing) this.listing = null;
    });
    return listing.answer;
  }

  private async readModels(): Promise<DriverModels> {
    const run = await runCli(COMMAND, ["debug", "models"], { cwd: os.tmpdir(), extraEnv: EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    const listed = run.started && run.exitCode === 0 ? parseCodexModels(run.stdout) : null;
    if (listed !== null) return { source: "cli", models: listed, default: this.configured.defaultModel, cliDefault: null };
    return { source: "config", models: this.configured.models.map((id) => ({ id })), default: this.configured.defaultModel, cliDefault: null };
  }

  /**
   * Probe, then make the attempt that one review turn runs in; the CLI starts with the turn. Only a read-only attempt
   * with no network can be made: anything else would need what Codex lacks here.
   */
  async startAttempt(options: StartAttemptOptions): Promise<DriverSession> {
    if (options.readOnly !== true || options.allowEdits === true || options.gate !== undefined) throw new Error("Codex can only review in Botbench: it cannot ask you for permission or edit files under Botbench's rules.");
    if (options.resumeCursor !== undefined) throw new Error("Codex cannot resume a session in Botbench.");
    if (options.confinement.allowedHosts.length > 0) throw new Error("Codex's commands reach no network in Botbench, so it cannot be given hosts to reach.");
    const probe = await this.probe();
    if (probe.problem) throw new DriverUnavailableError(probe);
    if (!fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The working directory does not exist: ${options.cwd}`);
    const args = codexArgs({ place: { cwd: options.cwd, dataDir: options.confinement.dataDir, ...(options.confinement.gitDir === undefined ? {} : { gitDir: options.confinement.gitDir }) }, ...(options.model ? { model: options.model } : {}) });
    const at = now();
    const { lastInsertRowid } = options.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'running', NULL, ?, ?)").run(CODEX, options.model ?? null, at, at);
    return new CodexSession(options.db, Number(lastInsertRowid), args, options.cwd);
  }
}
