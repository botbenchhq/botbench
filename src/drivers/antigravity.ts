import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinementProblem, unreadablePaths } from "../confinement.ts";
import { makeReviewFolder, sandboxed, wholeCliProfile } from "./cli-sandbox.ts";
import { DriverUnavailableError, modelNameProblem, type BillingKind, type Driver, type DriverCapabilities, type DriverModels, type DriverProbe, type DriverSession, type ModelChoice, type StartAttemptOptions } from "./contract.ts";
import type { DriverEvent } from "./events.ts";
import { buildChildEnv, checkVersion, runCli } from "./launch.ts";
import { startOneTurn, type LineResult } from "./one-turn.ts";

/*
 * Antigravity CLI (`agy`, Google's successor to the Gemini CLI), driven for one thing only: a read-only review turn,
 * with no tools. Seen on 1.5.14:
 *   `agy --input-format stream-json --output-format stream-json …` reads one message per input line,
 *   {"event":"user","message":{"content":"…"}}, runs a turn for each, exits when its input is closed, and prints:
 *     {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","agent":"…","tools":[…],…}}
 *     {"event":"step_update","step_update":{"step_index":…,"state":"ACTIVE"|"DONE"|"ERROR","step_type":"agent_response"|"tool"|…,
 *       "text_delta":"…","tool_name":"…","tool_info":{"name":"…","parameters":{…},"output":"…","error":{…}}}}
 *     {"event":"result","result":{"conversation_id":"…","status":"SUCCESS"|"ERROR"|…,"response":"…","error":"…","usage":{…}}}
 *
 * Confinement, measured on this Mac on 2026-11-22:
 * - No tools. Antigravity has no flag that removes its tools: `init` lists all sixty-odd whatever is set. A custom
 *   agent whose definition says `tools: []` is offered none but `manage_task` (which lists, stops or writes to the
 *   conversation's background commands; with no tool that starts one, there are none). Its definition is written into
 *   the new empty review folder the CLI works in (`.agents/agents/`), and `--agent` names it. Should a session start as
 *   another agent, or any tool step appear, Botbench stops the turn at that line.
 * - As a second layer, the session's own settings (`--settings`, never saved) deny every action Antigravity has rules
 *   for: commands in and out of its sandbox, reading and writing files, web pages and MCP tools. Measured: with these
 *   rules alone, a command and a file read were refused, but `schedule` and `define_subagent` still ran, so the rules
 *   are not the control.
 * - It works in that empty folder, never the task's copy: measured, a repository's `.agents/hooks.json` ran its hooks and
 *   its `.agents/mcp_config.json` started its MCP server, in headless mode, with no trust asked, outside any sandbox.
 * - The whole process runs under sandbox-exec (src/drivers/cli-sandbox.ts): it reads none of the shared list of secret
 *   places but its own folders and the Keychain it keeps its sign-in in, nothing of Botbench's data folder but the review
 *   folder, and writes nowhere else.
 * - `@path` in a prompt is not attached in this mode (measured), so the prompt is sent as written.
 * What stays on: the owner's own hooks (~/.gemini/config/hooks.json; none on this Mac) and MCP servers
 * (~/.gemini/config/mcp_config.json), which start, confined by the same profile, and whose tools the agent is not
 * offered; the conversation record in ~/.gemini/antigravity-cli, which Antigravity always keeps; and the network to Google.
 */

const COMMAND = "agy";
export const ANTIGRAVITY = "antigravity";

/** Antigravity here does one read-only turn with no tools: it cannot resume, cannot put a permission request to the owner, and is never let edit. It can be stopped. */
export const ANTIGRAVITY_CAPABILITIES: DriverCapabilities = { resume: false, interrupt: true, permissionRequests: false, edits: false, tools: false };

/** The name of Botbench's reviewer agent, defined in each review folder. */
export const REVIEW_AGENT = "botbench-review";

/** The session's settings: every action Antigravity has a rule for is denied, and nothing outside the folder is reachable. */
export const AGY_SETTINGS = {
  permissions: { deny: ["command(*)", "unsandboxed(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)", "mcp(*)"] },
  toolPermission: "request-review",
  allowNonWorkspaceAccess: false,
  enableTerminalSandbox: true,
  disableSlashCommands: true,
} as const;

export const AGY_EXTRA_ENV: Record<string, string> = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

/** The environment a review runs in: the allowlist of src/drivers/launch.ts, no provider key, no auto-update. */
export const agyEnv = (parent: NodeJS.ProcessEnv = process.env): Record<string, string> => buildChildEnv(parent, AGY_EXTRA_ENV);

/** Write Botbench's reviewer agent into `folder`, where Antigravity finds a workspace's agents. */
export function writeReviewAgent(folder: string): void {
  const dir = path.join(folder, ".agents", "agents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const definition = [
    "---",
    `name: ${REVIEW_AGENT}`,
    "description: Reviews a code change given in full in the message, and replies in text. Uses no tools.",
    "tools: []",
    "mainAgent: true",
    "subagent: false",
    "commandExecutionPolicy: off",
    "mcpServers: []",
    "skills: []",
    "---",
    "You review a code change that is given to you in full in the message, and reply in text only.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, `${REVIEW_AGENT}.md`), definition, { mode: 0o600 });
}

/** The arguments of one review turn, for `agy` itself (the driver starts it under sandbox-exec, in the review folder). */
export function agyArgs(o: { model?: string }): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--agent", REVIEW_AGENT, "--disable-slash-commands", "--sandbox", "--settings", JSON.stringify(AGY_SETTINGS)];
  if (o.model !== undefined) {
    const problem = modelNameProblem(o.model);
    if (problem !== null) throw new Error(`The model name cannot be passed to Antigravity. ${problem}`);
    args.push("--model", o.model);
  }
  return args;
}

/** What Antigravity is sent for `prompt`: one user message of its input protocol. */
export const agyInput = (prompt: string): string => `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;

/** Antigravity's own folders under the home folder: what it reads and writes there to work. */
const ownFolders = (home: string): string[] => [path.join(home, ".gemini", "antigravity-cli"), path.join(home, ".gemini", "config")];

/** The sandbox profile for the whole Antigravity process of one review in `folder`. The Keychain is read for its sign-in, never written by it. */
export function agyProfile(o: { dataDir: string; folder: string; home?: string }): string {
  const home = o.home ?? os.homedir();
  const own = ownFolders(home);
  return wholeCliProfile({ unreadable: unreadablePaths({ dataDir: o.dataDir, home }), readable: [...own, path.join(home, "Library", "Keychains"), o.folder], writable: [...own, o.folder] });
}

/** What `agy -p /usage` printed, and how it exited, as a sign-in. Plan quotas ("… Limit Remaining …") are a Google subscription. */
export function parseAgyUsage(output: string, exitCode: number | null): { signedIn: boolean; billing: BillingKind } {
  if (exitCode !== 0 || /authentication required/i.test(output) || !/\bLimit Remaining\b/.test(output)) return { signedIn: false, billing: "unknown" };
  return { signedIn: true, billing: "subscription" };
}

/** The models `agy models` lists, one "slug<TAB>label" a line, in its order. Null when it lists none. */
export function parseAgyModels(output: string): ModelChoice[] | null {
  const models: ModelChoice[] = [];
  for (const match of output.matchAll(/^(\S+)\t(.+)$/gm)) {
    if (modelNameProblem(match[1]) !== null) continue;
    models.push({ id: match[1]!, label: match[2]!.trim().slice(0, 80) });
  }
  return models.length > 0 ? models : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A reader for one turn of `agy … --output-format stream-json`. The reply is taken whole from the result. */
export function agyReader(): (line: string) => LineResult {
  const none: LineResult = { events: [], stop: null };
  return (line) => {
    if (line.trim() === "") return none;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { events: [{ type: "error", message: "Antigravity printed a line Botbench could not read.", raw: shorten(line) }], stop: null };
    }
    if (!isObject(parsed) || typeof parsed.event !== "string") return { events: [{ type: "error", message: "Antigravity printed a line that is not an event.", raw: shorten(line) }], stop: null };
    switch (parsed.event) {
      case "init": {
        const init = isObject(parsed.init) ? parsed.init : {};
        const conversation = str(parsed.conversation_id);
        const events: DriverEvent[] = conversation ? [{ type: "session_started", resumeCursor: conversation, model: str(init.model), keySource: null }] : [];
        return init.agent === REVIEW_AGENT ? { events, stop: null } : { events, stop: `Stopped: Antigravity did not start as Botbench's reviewer agent, which has no tools (it reported ${JSON.stringify(init.agent ?? null)}). Update Botbench for this Antigravity.` };
      }
      case "step_update": {
        const step = isObject(parsed.step_update) ? parsed.step_update : {};
        if (step.step_type !== "tool") return none;
        const info = isObject(step.tool_info) ? step.tool_info : {};
        const id = `step-${count(step.step_index)}`;
        const name = str(step.tool_name) ?? str(info.name) ?? "unknown";
        const events: DriverEvent[] = [{ type: "tool_call", id, name, input: info.parameters ?? null }];
        if (step.state === "DONE" || step.state === "ERROR") {
          const error = isObject(info.error) ? str(info.error.message) : null;
          events.push({ type: "tool_result", id, output: error ?? str(info.output) ?? "", isError: step.state === "ERROR" || error !== null });
        }
        return { events, stop: `Stopped: Antigravity tried to use a tool (${name}), and a reviewer gets none in Botbench.` };
      }
      case "result": {
        const result = isObject(parsed.result) ? parsed.result : {};
        const u = isObject(result.usage) ? result.usage : {};
        const events: DriverEvent[] = [];
        const response = str(result.response) ?? "";
        if (result.status === "SUCCESS" && response.trim() !== "") events.push({ type: "text", text: response.replace(/\n+$/, "") });
        // Antigravity's input count includes the cached part, which it also gives on its own.
        events.push({ type: "usage", inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens), cacheReadTokens: count(u.cache_read_tokens), cacheWriteTokens: 0 });
        if (result.status === "SUCCESS") events.push({ type: "turn_ended", reason: "completed", detail: null });
        else {
          const detail = shorten(str(result.error) ?? `Antigravity stopped with the status ${String(result.status ?? "unknown")} without saying why.`);
          events.push({ type: "error", message: detail, raw: null }, { type: "turn_ended", reason: "error", detail });
        }
        return { events, stop: null };
      }
      default:
        return none;
    }
  };
}

export interface AntigravityDriverOptions {
  /** The owner's configured list of models, offered when the CLI reports none. */
  models?: readonly string[];
  /** The configured model, preselected for the owner. The CLI's own default when absent. */
  defaultModel?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const MODELS_FRESH_MS = 60_000;

export class AntigravityDriver implements Driver {
  readonly name = ANTIGRAVITY;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  private readonly configured: { models: readonly string[]; defaultModel: string | null };
  private listing: { at: number; answer: Promise<DriverModels> } | null = null;

  constructor(options: AntigravityDriverOptions = {}) {
    this.configured = { models: options.models ?? [], defaultModel: options.defaultModel ?? null };
  }

  /**
   * `agy --version`, and `agy -p /usage`, which the CLI answers itself with the plan's quotas and starts no turn. No
   * credential is read. Signed out, the CLI prints a sign-in link, which is not kept.
   */
  async probe(): Promise<DriverProbe> {
    const run = (args: string[]) => runCli(COMMAND, args, { cwd: os.tmpdir(), extraEnv: AGY_EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    const version = await run(["--version"]);
    if (!version.started) return { installed: false, version: null, supported: false, signedIn: false, billing: "unknown", problem: "Antigravity is not installed, or `agy` is not on the PATH." };
    const check = checkVersion(version.stdout, "antigravity");
    if (!check.supported) {
      const problem = check.version ? `Antigravity ${check.version} is too old for Botbench, which has been run only with 1.5.14 and later. Update Antigravity.` : "Antigravity did not report a version Botbench can read.";
      return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem };
    }
    const unconfined = confinementProblem();
    if (unconfined !== null) return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem: unconfined };
    const usage = await run(["-p", "/usage"]);
    const login = parseAgyUsage(`${usage.stdout}\n${usage.stderr}`, usage.exitCode);
    return { installed: true, version: check.version, supported: true, ...login, problem: login.signedIn ? null : "Antigravity is signed out. Run `agy` in a terminal and sign in." };
  }

  /** `agy models`, which lists the models and starts no turn. A CLI that is missing, slow or lists nothing leaves the configured list. */
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
    const run = await runCli(COMMAND, ["models"], { cwd: os.tmpdir(), extraEnv: AGY_EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    const listed = run.started && run.exitCode === 0 ? parseAgyModels(run.stdout) : null;
    if (listed !== null) return { source: "cli", models: listed, default: this.configured.defaultModel, cliDefault: null };
    return { source: "config", models: this.configured.models.map((id) => ({ id })), default: this.configured.defaultModel, cliDefault: null };
  }

  /**
   * Probe, then make the attempt one review turn runs in, in a new folder that holds only Botbench's reviewer agent; the
   * CLI starts with the turn. Only a read-only attempt with no network for commands can be made.
   */
  async startAttempt(options: StartAttemptOptions): Promise<DriverSession> {
    if (options.readOnly !== true || options.allowEdits === true || options.gate !== undefined) throw new Error("Antigravity can only review in Botbench: it cannot ask you for permission or edit files under Botbench's rules.");
    if (options.resumeCursor !== undefined) throw new Error("Antigravity cannot resume a session in Botbench.");
    if (options.confinement.allowedHosts.length > 0) throw new Error("Antigravity runs no command in Botbench and reaches no network for one, so it cannot be given hosts to reach.");
    const args = agyArgs(options.model ? { model: options.model } : {});
    const probe = await this.probe();
    if (probe.problem) throw new DriverUnavailableError(probe);
    if (!fs.statSync(options.confinement.dataDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Botbench's data folder does not exist: ${options.confinement.dataDir}`);
    const folder = makeReviewFolder(options.confinement.dataDir);
    try {
      writeReviewAgent(folder.path);
    } catch (err) {
      folder.remove();
      throw err;
    }
    const run = sandboxed(agyProfile({ dataDir: options.confinement.dataDir, folder: folder.path }), COMMAND, args);
    return startOneTurn(options.db, ANTIGRAVITY, options.model ?? null, {
      agent: "Antigravity",
      command: run.command,
      args: run.args,
      cwd: folder.path,
      extraEnv: AGY_EXTRA_ENV,
      capabilities: ANTIGRAVITY_CAPABILITIES,
      input: agyInput,
      reader: agyReader,
      cleanup: folder.remove,
    });
  }
}
