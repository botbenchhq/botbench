import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinementProblem, unreadablePaths } from "../confinement.ts";
import { makeReviewFolder, neutralizeMentions, sandboxed, wholeCliProfile } from "./cli-sandbox.ts";
import { DriverUnavailableError, modelNameProblem, type BillingKind, type Driver, type DriverCapabilities, type DriverModels, type DriverProbe, type DriverSession, type ModelChoice, type StartAttemptOptions } from "./contract.ts";
import type { DriverEvent } from "./events.ts";
import { buildChildEnv, checkVersion, runCli } from "./launch.ts";
import { startOneTurn, type LineResult } from "./one-turn.ts";

/*
 * Grok, driven for one thing only: a read-only turn with no tools at all, for a review or a chat message (src/api/chat.ts).
 * Seen on 1.0.92:
 *   `grok -p - --output-format streaming-json …` reads the prompt from its input and prints one JSON object per line:
 *     {"type":"available_commands","tools":[…],"commands":[…]}   (more than once; `tools` is what its model is offered)
 *     {"type":"thought","data":"…"}  {"type":"text","data":"…"}  (the reply, in pieces)
 *     {"type":"tool_call","toolCallId":"…","toolName":"…","rawInput":{…}}  {"type":"tool_call_update",…}
 *     {"type":"usage",…}  (one per model response)
 *     {"type":"end","stopReason":"end_turn","sessionId":"…","usage":{"input_tokens":…,"output_tokens":…,…}}
 *     {"type":"error","message":"Not signed in. …"}
 *   and exits once the turn is over.
 *
 * Confinement, measured on this Mac on 2026-11-22 (Grok's own sandbox does not block the network on macOS and leaves
 * its own sign-in readable, ADR 0002, so it is not used):
 * - No tools. `--disallowed-tools` removes every built-in tool 1.0.92 offers, MCP's search_tool and use_tool, and
 *   subagents; `available_commands` then lists `"tools":[]`. `--tools` cannot do this: an empty list keeps them all.
 *   Should a later Grok offer one more, Botbench stops the turn at the line that lists it.
 * - `@path` in a prompt is read by Grok itself, not by a tool, even with --verbatim: `@/tmp/x` was attached and sent to
 *   its model. Every `@` of the prompt is therefore written as `＠`, which was not.
 * - The whole process runs under sandbox-exec (src/drivers/cli-sandbox.ts): it reads none of the shared list of secret
 *   places but its own folder, nothing of Botbench's data folder but the review folder, and writes nowhere else. With it,
 *   `@` to a denied file attached nothing.
 * - It works in a new empty folder, not the task's copy, so nothing of the repository (its hooks, MCP servers, rules,
 *   AGENTS.md) is ever loaded; the diff is in the prompt. Grok's compatibility with Claude's and Cursor's settings,
 *   memory, workflows, subagents and updates are turned off by environment.
 * What stays on: the owner's own Grok hooks and MCP servers in ~/.grok (none on this Mac; MCP tools are not offered to
 * the model), the owner's enabled plugins and skills (listed as commands, which the prompt never invokes), Grok's own
 * session record in ~/.grok/sessions, and the network to xAI.
 */

const COMMAND = "grok";
export const GROK = "grok";

/** Grok here does one read-only turn with no tools: it cannot resume, cannot put a permission request to the owner, and is never let edit. It can be stopped. */
export const GROK_CAPABILITIES: DriverCapabilities = { resume: false, interrupt: true, permissionRequests: false, edits: false, tools: false };

/** Every tool Grok 1.0.92 offered its model in a headless run on this Mac, by the names it shows (update_goal only with Botbench's environment), and subagents ("Agent"). */
export const GROK_TOOLS: readonly string[] = [
  "run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "kill_command_or_subagent", "todo_write",
  "get_command_or_subagent_output", "spawn_subagent", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor",
  "search_tool", "use_tool", "workflow", "enter_plan_mode", "exit_plan_mode", "ask_user_question", "send_feedback",
  "web_search", "web_fetch", "image_gen", "image_edit", "image_to_video", "reference_to_video", "write", "update_goal", "Agent",
];

/** What Grok would otherwise load from Claude's and Cursor's settings, and its memory, workflows, subagents and updates; each name is one Grok's guide lists. */
export const GROK_EXTRA_ENV: Record<string, string> = {
  ...Object.fromEntries(["CLAUDE", "CURSOR"].flatMap((vendor) => ["HOOKS", "MCPS", "SKILLS", "RULES", "AGENTS"].map((surface) => [`GROK_${vendor}_${surface}_ENABLED`, "false"]))),
  GROK_MEMORY: "0",
  GROK_WORKFLOWS: "0",
  GROK_SUBAGENTS: "0",
  GROK_DISABLE_AUTOUPDATER: "1",
};

/** The environment a review runs in: the allowlist of src/drivers/launch.ts, no provider key, and Grok's extras turned off. */
export const grokEnv = (parent: NodeJS.ProcessEnv = process.env): Record<string, string> => buildChildEnv(parent, GROK_EXTRA_ENV);

/** The arguments of one review turn, for `grok` itself (the driver starts it under sandbox-exec). */
export function grokArgs(o: { model?: string }): string[] {
  const args = ["-p", "-", "--output-format", "streaming-json", "--no-memory", "--no-subagents", "--disable-web-search", "--max-turns", "1", "--disallowed-tools", GROK_TOOLS.join(",")];
  if (o.model !== undefined) {
    const problem = modelNameProblem(o.model);
    if (problem !== null) throw new Error(`The model name cannot be passed to Grok. ${problem}`);
    args.push("-m", o.model);
  }
  return args;
}

/** Grok's own folder: GROK_HOME when the owner moved it, else ~/.grok. */
const grokHome = (env: NodeJS.ProcessEnv, home: string): string => (typeof env.GROK_HOME === "string" && path.isAbsolute(env.GROK_HOME) ? env.GROK_HOME : path.join(home, ".grok"));

/** What Grok is sent for `prompt`: every `@` written as `＠` (see above), and a line saying so, so that code is read as written. */
export const grokInput = (prompt: string): string => (prompt.includes("@") ? `${neutralizeMentions(prompt)}\n\nBotbench wrote each at sign above as ＠ before sending it; read each ＠ as an at sign.` : prompt);

/** The sandbox profile for the whole Grok process of one review in `folder`. */
export function grokProfile(o: { dataDir: string; folder: string; env?: NodeJS.ProcessEnv }): string {
  const home = os.homedir();
  const env = o.env ?? process.env;
  const own = grokHome(env, home);
  return wholeCliProfile({ unreadable: unreadablePaths({ dataDir: o.dataDir, home, env }), readable: [own, o.folder], writable: [own, o.folder] });
}

/** What `grok models` printed, and how it exited, as a sign-in. Its words on 1.0.92: "You are logged in with grok.com.", "You are not authenticated." */
export function parseGrokLogin(output: string, exitCode: number | null): { signedIn: boolean; billing: BillingKind } {
  if (exitCode !== 0 || !/^You are logged in with /m.test(output)) return { signedIn: false, billing: "unknown" };
  return { signedIn: true, billing: /^You are logged in with grok\.com\./m.test(output) ? "subscription" : "unknown" };
}

/** The models `grok models` lists, in its order, and the one it marks as its default. Null when it lists none. */
export function parseGrokModels(output: string): { models: ModelChoice[]; cliDefault: string | null } | null {
  const models: ModelChoice[] = [];
  let cliDefault: string | null = null;
  for (const match of output.matchAll(/^\s+[*-] (\S+)( \(default\))?\s*$/gm)) {
    const id = match[1]!;
    if (modelNameProblem(id) !== null) continue;
    models.push({ id });
    if (match[2]) cliDefault = id;
  }
  return models.length > 0 ? { models, cliDefault } : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * A reader for one turn of `grok -p … --output-format streaming-json`. The reply comes in pieces and is given as one
 * text when the turn ends. A tool offered to the model, or a tool call, stops the turn.
 */
/** The tools xAI runs on its own servers, by the variant Grok reports. Nothing else counts, whatever it claims. */
const BACKEND_VARIANTS: ReadonlySet<string> = new Set(["XSearch"]);

/**
 * Whether a tool call is a search run by xAI's servers and not a tool on this Mac: Grok marks it `backend: true` with
 * a known variant, and its name is none of the tools this driver turns off.
 */
function isBackendSearch(name: string, rawInput: unknown): boolean {
  if (!isObject(rawInput) || rawInput.backend !== true) return false;
  if (typeof rawInput.variant !== "string" || !BACKEND_VARIANTS.has(rawInput.variant)) return false;
  return !GROK_TOOLS.includes(name);
}

export function grokReader(): (line: string) => LineResult {
  let reply = "";
  const none: LineResult = { events: [], stop: null };
  return (line) => {
    if (line.trim() === "") return none;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { events: [{ type: "error", message: "Grok printed a line Botbench could not read.", raw: shorten(line) }], stop: null };
    }
    if (!isObject(parsed) || typeof parsed.type !== "string") return { events: [{ type: "error", message: "Grok printed a line that is not an event.", raw: shorten(line) }], stop: null };
    switch (parsed.type) {
      case "available_commands": {
        const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === "string") : [];
        return tools.length === 0 ? none : { events: [], stop: `Stopped: Grok offered its model a tool (${shorten(tools.join(", "), 200)}), and Botbench gives it none here. Update Botbench for this Grok.` };
      }
      case "text":
        reply += str(parsed.data) ?? "";
        return none;
      case "tool_call": {
        const name = str(parsed.toolName) ?? "unknown";
        const event: DriverEvent = { type: "tool_call", id: str(parsed.toolCallId) ?? "", name, input: parsed.rawInput ?? null };
        // A search xAI runs on its own servers touches nothing on this Mac: it is recorded and the turn goes on.
        if (isBackendSearch(name, parsed.rawInput)) return { events: [event], stop: null };
        return { events: [event], stop: `Stopped: Grok tried to use a tool (${name}), and Botbench gives it none here.` };
      }
      case "tool_call_update": {
        const output = parsed.rawOutput ?? parsed.content ?? null;
        return { events: [{ type: "tool_result", id: str(parsed.toolCallId) ?? "", output: typeof output === "string" ? output : JSON.stringify(output), isError: parsed.status === "failed" }], stop: null };
      }
      case "end": {
        const u = isObject(parsed.usage) ? parsed.usage : {};
        const session = str(parsed.sessionId);
        const events: DriverEvent[] = [];
        if (session) events.push({ type: "session_started", resumeCursor: session, model: null, keySource: null });
        if (reply !== "") events.push({ type: "text", text: reply });
        // Grok's input count here leaves out the cached part, which it gives on its own.
        events.push({ type: "usage", inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens), cacheReadTokens: count(u.cache_read_input_tokens), cacheWriteTokens: count(u.cache_creation_input_tokens) });
        const stopped = str(parsed.stopReason);
        const error = str(parsed.error);
        if (stopped === "end_turn" && error === null) events.push({ type: "turn_ended", reason: "completed", detail: null });
        else events.push({ type: "turn_ended", reason: "error", detail: error !== null ? shorten(error) : `Grok stopped before it finished its reply (${stopped ?? "no reason given"}).` });
        return { events, stop: null };
      }
      case "error": {
        const message = shorten(str(parsed.message) ?? "Grok reported an error without saying what.");
        return { events: [{ type: "error", message, raw: null }, { type: "turn_ended", reason: "error", detail: message }], stop: null };
      }
      default:
        return none;
    }
  };
}

export interface GrokDriverOptions {
  /** The owner's configured list of models, offered when the CLI reports none. */
  models?: readonly string[];
  /** The configured model, preselected for the owner. The CLI's own default when absent. */
  defaultModel?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const MODELS_FRESH_MS = 60_000;

export class GrokDriver implements Driver {
  readonly name = GROK;
  readonly capabilities = GROK_CAPABILITIES;
  private readonly configured: { models: readonly string[]; defaultModel: string | null };
  private listing: { at: number; answer: Promise<string | null> } | null = null;

  constructor(options: GrokDriverOptions = {}) {
    this.configured = { models: options.models ?? [], defaultModel: options.defaultModel ?? null };
  }

  /** `grok models`, which starts no turn and says how Grok is signed in; read once a minute at most. Null when it could not be read. */
  private listed(): Promise<string | null> {
    if (this.listing !== null && Date.now() - this.listing.at < MODELS_FRESH_MS) return this.listing.answer;
    const listing = {
      at: Date.now(),
      answer: runCli(COMMAND, ["models"], { cwd: os.tmpdir(), extraEnv: GROK_EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS }).then((run) => (run.started && run.exitCode === 0 ? run.stdout : null)),
    };
    this.listing = listing;
    void listing.answer.then((answer) => {
      if ((answer === null || !/^You are logged in with /m.test(answer)) && this.listing === listing) this.listing = null;
    });
    return listing.answer;
  }

  /** `grok --version` and `grok models`. No credential file is read. */
  async probe(): Promise<DriverProbe> {
    const version = await runCli(COMMAND, ["--version"], { cwd: os.tmpdir(), extraEnv: GROK_EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    if (!version.started) return { installed: false, version: null, supported: false, signedIn: false, billing: "unknown", problem: "Grok is not installed, or `grok` is not on the PATH." };
    const check = checkVersion(version.stdout, "grok");
    if (!check.supported) {
      const problem = check.version ? `Grok ${check.version} is too old for Botbench, which has been run only with 1.0.92 and later. Update Grok.` : "Grok did not report a version Botbench can read.";
      return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem };
    }
    const unconfined = confinementProblem();
    if (unconfined !== null) return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem: unconfined };
    const listed = await this.listed();
    const login = listed === null ? { signedIn: false, billing: "unknown" as const } : parseGrokLogin(listed, 0);
    return { installed: true, version: check.version, supported: true, ...login, problem: login.signedIn ? null : listed === null ? "Grok did not answer when asked how it is signed in. Try again, or run `grok models` in a terminal." : "Grok is signed out. Run `grok login` in a terminal." };
  }

  /** The models `grok models` lists. A CLI that is missing, slow or lists nothing leaves the configured list. */
  async models(): Promise<DriverModels> {
    const listed = await this.listed();
    const parsed = listed === null ? null : parseGrokModels(listed);
    if (parsed !== null) return { source: "cli", models: parsed.models, default: this.configured.defaultModel, cliDefault: parsed.cliDefault };
    return { source: "config", models: this.configured.models.map((id) => ({ id })), default: this.configured.defaultModel, cliDefault: null };
  }

  /**
   * Probe, then make the attempt one review turn runs in, in a new empty folder; the CLI starts with the turn. Only a
   * read-only attempt with no network for commands can be made: Grok is given no tools at all.
   */
  async startAttempt(options: StartAttemptOptions): Promise<DriverSession> {
    if (options.readOnly !== true || options.allowEdits === true || options.gate !== undefined) throw new Error("Grok can only review in Botbench: it cannot ask you for permission or edit files under Botbench's rules.");
    if (options.resumeCursor !== undefined) throw new Error("Grok cannot resume a session in Botbench.");
    if (options.confinement.allowedHosts.length > 0) throw new Error("Grok runs no command in Botbench and reaches no network for one, so it cannot be given hosts to reach.");
    const args = grokArgs(options.model ? { model: options.model } : {});
    const probe = await this.probe();
    if (probe.problem) throw new DriverUnavailableError(probe);
    if (!fs.statSync(options.confinement.dataDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Botbench's data folder does not exist: ${options.confinement.dataDir}`);
    const folder = makeReviewFolder(options.confinement.dataDir);
    const run = sandboxed(grokProfile({ dataDir: options.confinement.dataDir, folder: folder.path }), COMMAND, args);
    return startOneTurn(options.db, GROK, options.model ?? null, {
      agent: "Grok",
      command: run.command,
      args: run.args,
      cwd: folder.path,
      extraEnv: GROK_EXTRA_ENV,
      capabilities: GROK_CAPABILITIES,
      input: grokInput,
      reader: grokReader,
      cleanup: folder.remove,
    });
  }
}
