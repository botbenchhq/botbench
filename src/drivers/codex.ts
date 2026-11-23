import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinementProblem, unreadablePaths } from "../confinement.ts";
import { makeReviewFolder } from "./cli-sandbox.ts";
import { DriverUnavailableError, modelNameProblem, type BillingKind, type Driver, type DriverCapabilities, type DriverModels, type DriverProbe, type DriverSession, type ModelChoice, type StartAttemptOptions } from "./contract.ts";
import type { DriverEvent } from "./events.ts";
import { buildChildEnv, checkVersion, runCli } from "./launch.ts";
import { startOneTurn, type LineResult } from "./one-turn.ts";
import { codexSignIn, type SignInDefinition } from "./sign-in.ts";

/*
 * Codex, driven one turn at a time: a read-only review of a task's copy (U17 in part, for U20), or a chat message
 * (src/api/chat.ts) with Codex's own tools in the chat's folder and an attached repository read-only. Seen on 0.171.0:
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
 * aside): a permissions profile given with `-c` (`codexConfig`) denies reading the home folder, every place of the one
 * shared list in src/confinement.ts, Codex's own folder where the owner moved it, and Botbench's data folder, then
 * opens what the turn may reach (a narrower rule wins, seen on 0.171.0), and gives commands no network. A review
 * extends `:read-only`: commands write nothing, the task's copy included. A chat extends `:workspace`: commands write
 * the chat's folder (and the temporary folder), and an attached repository and its git folder are opened for reading
 * only. Seen with `codex sandbox -P` on 0.171.0: a decoy in a denied folder and `~/.codex` read as "Operation not
 * permitted", a write in the copy failed, and a name did not resolve.
 *
 * Codex's own sandbox is the control here, not Botbench's sandbox-exec around the whole CLI (src/drivers/cli-sandbox.ts)
 * as for Grok: macOS does not let a sandboxed process start another sandbox (seen on 27.2: "sandbox_apply: Operation
 * not permitted"), so Codex inside one would have to run its commands with no sandbox of its own, and they could then
 * read Codex's own sign-in, which its own profile keeps from them. Before each turn, Codex is asked which sandbox it
 * would use (`codexSandboxCheckArgs`), and it is not started when it reports a looser one than Botbench set, or any
 * network for commands.
 *
 * What a turn is started without: the owner's config.toml (`--ignore-user-config`, which also leaves out personal
 * MCP servers and profiles), MCP servers (`mcp_servers={}`), the owner's and the repository's command rules
 * (`--ignore-rules`), hooks, plugins, apps, the browser, computer use and the other features in DISABLED_FEATURES
 * (`--disable`), and any saved session (`--ephemeral`). Web search, which OpenAI runs on its own servers, is on only
 * when the owner's "Web access in chat" is Allow. A repository's own `.codex/` folder is not loaded for a folder Codex
 * was never told to trust, and every setting here is a session flag, which outranks project config. Codex says when it
 * ignores a setting it does not know; Botbench then stops the turn, since a setting it relies on would not be in force.
 */

const COMMAND = "codex";
export const CODEX = "codex";

/**
 * Codex here does one turn: it cannot resume, cannot put a permission request to the owner, and never edits a task's
 * copy. In a chat it has its own tools, kept by its own sandbox to the chat's folder. It can be stopped.
 */
export const CODEX_CAPABILITIES: DriverCapabilities = { resume: false, interrupt: true, permissionRequests: false, edits: false, chatTools: true };

/** The name of Botbench's permissions profile for a review. */
export const REVIEW_PROFILE = "botbench-review";
/** The name of Botbench's permissions profile for a chat with Codex's own tools. */
export const CHAT_PROFILE = "botbench-chat";

/**
 * Features of 0.171.0 Botbench has no use for, or that would reach past the confinement (a browser, the computer,
 * another agent, a background service); each is a name `codex features list` shows as on.
 */
export const DISABLED_FEATURES = ["hooks", "plugins", "apps", "browser_use", "browser_use_external", "computer_use", "image_generation", "in_app_browser", "remote_plugin", "skill_mcp_dependency_install", "daemon_auto_start"];

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

/** What a turn is: a review, read-only in the task's copy, or a chat, in the chat's folder with `readable` read-only. */
export interface CodexTurn {
  place: ReviewPlace;
  /** A chat with Codex's own tools; a review when left out. */
  chat?: { readable: readonly string[] };
  /** Codex's own web search, which OpenAI runs on its servers (`web_search = "live"`). Disabled when left out. */
  webSearch?: boolean;
  /** Where a moved Codex folder (CODEX_HOME) is read from; Botbench's own environment when left out. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The settings of one turn, which `codex exec` and the check before it (`codexArgs`, `codexSandboxCheckArgs`) are
 * both given. The permissions profile denies reading the home folder, every place of the shared list in
 * src/confinement.ts, Codex's own folder where the owner moved it, and Botbench's data folder; a narrower rule wins
 * (seen on 0.171.0), so it then opens what the turn may reach. A review extends `:read-only` and opens the task's copy
 * and the git folder for reading. A chat extends `:workspace` and opens the chat's folder for writing, and an attached
 * repository and its git folder for reading only. Commands reach no network either way; web search is OpenAI's.
 */
export function codexConfig(o: CodexTurn): string[] {
  const home = os.homedir();
  const denied = [home, ...unreadablePaths({ dataDir: o.place.dataDir, home, ...(o.env ? { env: o.env } : {}) })];
  const rules = new Map<string, string>();
  for (const place of denied) rules.set(place, "deny");
  const profile = o.chat === undefined ? REVIEW_PROFILE : CHAT_PROFILE;
  if (o.chat === undefined) {
    for (const place of [o.place.cwd, ...(o.place.gitDir === undefined ? [] : [o.place.gitDir])]) rules.set(realOrAsIs(place), "read");
  } else {
    for (const place of o.chat.readable) rules.set(realOrAsIs(place), "read");
    rules.set(realOrAsIs(o.place.cwd), "write");
  }
  const filesystem = `{${[...rules].map(([place, rule]) => `${tomlPath(place)}="${rule}"`).join(",")}}`;
  return [
    "-c", 'approval_policy="never"',
    "-c", `default_permissions="${profile}"`,
    "-c", `permissions.${profile}.extends="${o.chat === undefined ? ":read-only" : ":workspace"}"`,
    "-c", `permissions.${profile}.filesystem=${filesystem}`,
    "-c", `permissions.${profile}.network.enabled=false`,
    "-c", "mcp_servers={}",
    "-c", `web_search="${o.webSearch === true ? "live" : "disabled"}"`,
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ];
}

/** The arguments of one turn of `codex exec`. */
export function codexArgs(o: CodexTurn & { model?: string }): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "-C", o.place.cwd,
    ...codexConfig(o),
    // A chat works in the chat's folder, which is no git repository, and Codex refuses to start in one without this.
    ...(o.chat !== undefined || o.place.gitDir === undefined ? ["--skip-git-repo-check"] : []),
  ];
  if (o.model !== undefined) {
    const problem = modelNameProblem(o.model);
    if (problem !== null) throw new Error(`The model name cannot be passed to Codex. ${problem}`);
    args.push("-m", o.model);
  }
  args.push("-");
  return args;
}

/**
 * The check before a turn: `codex debug prompt-input`, which starts no turn and prints the text Codex's model would
 * be given, its account of the sandbox included, under the turn's own settings. It takes no `--ignore-user-config`, so
 * it is run with CODEX_HOME set to a new empty folder: it then reads no config of the owner's, as the turn does not,
 * and still every setting from outside (a managed configuration) that could loosen the sandbox.
 */
export const codexSandboxCheckArgs = (o: CodexTurn): string[] => ["debug", "prompt-input", ...codexConfig(o), "Botbench checks the sandbox."];

/** Codex's own sandbox modes, loosest last. */
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof SANDBOX_MODES)[number];

/**
 * The sandbox Codex says it would run commands in, from the text its model is given (on 0.171.0: "`sandbox_mode` is
 * `read-only`: … Network access is restricted."). Null when it says none Botbench knows.
 */
export function parseCodexSandbox(text: string): { mode: CodexSandboxMode; network: "restricted" | "enabled" } | null {
  const mode = /`sandbox_mode` is `([a-z-]+)`/.exec(text)?.[1];
  const network = /Network access is (restricted|enabled)\b/.exec(text)?.[1];
  if (mode === undefined || network === undefined || !(SANDBOX_MODES as readonly string[]).includes(mode)) return null;
  return { mode: mode as CodexSandboxMode, network: network as "restricted" | "enabled" };
}

/** Why Codex must not be started, given the sandbox it reported and the one Botbench set it, or null when it may. */
export function codexSandboxProblem(reported: ReturnType<typeof parseCodexSandbox>, expected: CodexSandboxMode): string | null {
  if (reported === null) return "Codex did not say which sandbox it would run its commands in, so Botbench did not start it. Update Botbench for this Codex.";
  if (SANDBOX_MODES.indexOf(reported.mode) > SANDBOX_MODES.indexOf(expected)) return `Codex said it would run its commands with ${reported.mode} access, looser than the ${expected} Botbench set, so Botbench did not start it. A Codex setting outside Botbench, such as a managed configuration, may be overriding it.`;
  if (reported.network !== "restricted") return "Codex said its commands would reach the network, which Botbench does not allow, so Botbench did not start it. A Codex setting outside Botbench, such as a managed configuration, may be overriding it.";
  return null;
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
        case "web_search": {
          // A search OpenAI runs on its own servers: a step of the transcript, with what was searched for.
          const query = str(item.query) ?? (isObject(item.action) ? str(item.action.query) : null) ?? "";
          const call: DriverEvent = { type: "tool_call", id, name: "web_search", input: { query } };
          return done ? [call, { type: "tool_result", id, output: query, isError: false }] : [call];
        }
        case "mcp_tool_call":
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

/** What one line of `codex exec --json` gave, and a stop when Codex says it ignored a setting the review's confinement may rest on. */
export function readCodexLine(line: string): LineResult {
  const events = parseCodexLine(line);
  const ignored = events.find((e): e is Extract<DriverEvent, { type: "error" }> => e.type === "error" && IGNORED_SETTING.test(e.message));
  return { events, stop: ignored ? `Stopped: Codex did not take one of Botbench's settings (${ignored.message}), so it could not be kept in the sandbox Botbench set. Update Botbench or Codex.` : null };
}

export interface CodexDriverOptions {
  /** The owner's configured list of models, offered when the CLI reports none. */
  models?: readonly string[];
  /** The configured model, preselected for the owner. The CLI's own default when absent. */
  defaultModel?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 30_000;
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
   * Ask Codex which sandbox it would run the turn's commands in (`codexSandboxCheckArgs`). Null when it is the one
   * Botbench set, else why Codex must not be started.
   */
  private async sandboxProblem(turn: CodexTurn, expected: CodexSandboxMode): Promise<string | null> {
    const empty = makeReviewFolder(turn.place.dataDir);
    try {
      const run = await runCli(COMMAND, codexSandboxCheckArgs(turn), { cwd: turn.place.cwd, extraEnv: { ...EXTRA_ENV, CODEX_HOME: empty.path }, timeoutMs: CHECK_TIMEOUT_MS });
      if (!run.started || run.exitCode !== 0) return `Codex did not say which sandbox it would run its commands in (${run.started ? `it exited with code ${run.exitCode}` : "it did not start"}), so Botbench did not start it.${run.stderr.trim() === "" ? "" : ` It said: ${shorten(run.stderr.trim(), 300)}`}`;
      return codexSandboxProblem(parseCodexSandbox(run.stdout), expected);
    } finally {
      empty.remove();
    }
  }

  /**
   * Probe, check the sandbox Codex reports, then make the attempt one turn runs in; the CLI starts with the turn. A
   * review is read-only in the task's copy. A chat (`chatTools`) works in the chat's folder, with an attached
   * repository read-only. Commands reach no network either way.
   */
  async startAttempt(options: StartAttemptOptions): Promise<DriverSession> {
    const chat = options.chatTools;
    if (chat !== undefined && (options.readOnly === true || options.allowEdits === true || options.gate !== undefined)) throw new Error("A chat with Codex's own tools is kept by its sandbox alone: it cannot also be read-only, edit under Botbench's rules or ask you.");
    if (chat === undefined && (options.readOnly !== true || options.allowEdits === true || options.gate !== undefined)) throw new Error("Codex can only review or chat in Botbench: it cannot ask you for permission or edit a task's files under Botbench's rules.");
    if (options.resumeCursor !== undefined) throw new Error("Codex cannot resume a session in Botbench.");
    if (options.confinement.allowedHosts.length > 0) throw new Error("Codex's commands reach no network in Botbench, so it cannot be given hosts to reach.");
    const probe = await this.probe();
    if (probe.problem) throw new DriverUnavailableError(probe);
    if (!fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The working directory does not exist: ${options.cwd}`);
    const turn: CodexTurn = {
      place: { cwd: options.cwd, dataDir: options.confinement.dataDir, ...(options.confinement.gitDir === undefined ? {} : { gitDir: options.confinement.gitDir }) },
      ...(chat === undefined ? {} : { chat }),
      webSearch: options.webSearch === true,
    };
    const args = codexArgs({ ...turn, ...(options.model ? { model: options.model } : {}) });
    const unsafe = await this.sandboxProblem(turn, chat === undefined ? "read-only" : "workspace-write");
    if (unsafe !== null) throw new Error(unsafe);
    return startOneTurn(options.db, CODEX, options.model ?? null, { agent: "Codex", command: COMMAND, args, cwd: options.cwd, extraEnv: EXTRA_ENV, capabilities: CODEX_CAPABILITIES, input: (prompt) => prompt, reader: () => readCodexLine });
  }
}
