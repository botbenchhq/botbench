import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { PROXY_SCRIPT, SECRET_ENV, SOCKET_ENV } from "../approvals/permission-proxy.ts";
import { confinementProblem, hostProblem, unreadablePaths, type Confinement } from "../confinement.ts";
import { now, transaction } from "../store/db.ts";
import { DriverUnavailableError, modelNameProblem, type BillingKind, type Driver, type DriverCapabilities, type DriverModels, type DriverProbe, type DriverSession, type ModelChoice, type ResumeCursor, type StartAttemptOptions } from "./contract.ts";
import type { DriverEvent, PermissionResponse, TurnEndReason } from "./events.ts";
import { checkVersion, killProcessGroup, launch, processGroupAlive, runCli, type CliChild } from "./launch.ts";
import { claudeCodeSignIn, type SignInDefinition } from "./sign-in.ts";

/*
 * Claude Code, driven over its stream-json protocol (seen on 2.1.322):
 *   stdin   one JSON object per line: {"type":"user","message":{"role":"user","content":"..."}}
 *           or {"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}
 *           or, answering a permission prompt:
 *              {"type":"control_response","response":{"subtype":"success","request_id":"...","response":
 *                {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}}}
 *   stdout  one JSON object per line, per turn:
 *           system/init (session_id, model), assistant (message.content blocks),
 *           user (tool results), rate_limit_event, then result (usage, is_error, terminal_reason)
 *           and, with --permission-prompt-tool stdio, whenever the CLI would ask a person:
 *              {"type":"control_request","request_id":"...","request":{"subtype":"can_use_tool",
 *                "tool_name":"Bash","input":{...},"tool_use_id":"toolu_..."}}
 *           The CLI was seen to wait seven minutes for that answer and then carry on; no limit was found.
 * The process stays up between turns and exits when stdin closes.
 *
 * Models (seen on 2.1.322): there is no `claude models` command, and `claude --help` names only the aliases
 * 'fable', 'opus' and 'sonnet' as examples. The CLI does report its list over this protocol, without a turn:
 *   stdin   {"type":"control_request","request_id":"...","request":{"subtype":"initialize"}}
 *   stdout  {"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"models":[
 *             {"value":"default","displayName":"Default (recommended)","description":"Fable 5.2",...},
 *             {"value":"haiku","resolvedModel":"claude-haiku-5-5","displayName":"Haiku 5.5",...}, ...], "account":{...}, ...}}}
 * `--model` takes those values and full model names. A name it does not know is not refused at start: the first turn
 * ends with a result marked is_error (terminal_reason "api_error") whose text says "There's an issue with the
 * selected model (<name>). It may not exist or you may not have access to it."
 */

const COMMAND = "claude";
export const CLAUDE_CODE = "claude-code";

/** Attempt states this driver writes to `attempts.status`. */
export type AttemptStatus = "running" | "interrupted" | "failed" | "ended";

/** The permission rule for the file-editing tools on every path below the working directory. */
const EDITS_BELOW_CWD = "Edit(./**)";

/** The only tools a read-only attempt has: reading and searching files, and the shell, every command of which asks. */
const READ_ONLY_TOOLS = "Read,Glob,Grep,Bash";
/** Named as denied as well, should a CLI version hand a tool out in spite of the list above. */
const WRITING_TOOLS = "Write,Edit,MultiEdit,NotebookEdit";

const CAPABILITIES: DriverCapabilities = { resume: true, interrupt: true, permissionRequests: true, edits: true };

/** How long the CLI lets the pre-tool hook run, in seconds. The hook asks Botbench one question and never waits for a person. */
const HOOK_TIMEOUT_S = 20;
const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The one settings object a gated attempt is given, on the command line. Seen on 2.1.322:
 * - The pre-tool hook runs before every tool call, also for the shell commands the CLI would run unasked
 *   (`ls`, `printf hi > x`) and for edits. When it prints "ask" the CLI asks for permission whatever its own
 *   rules say; when it prints "deny" the call does not run; when it prints nothing the CLI's rules decide.
 * - A hook that fails (it crashes, prints something else, or runs out of time) counts as having said nothing.
 *   So that a shell command still cannot run unasked then, the ask rule makes the CLI ask about every one.
 *   A hook's "allow" does not get past that rule, and Botbench's hook never prints one.
 */
function gateSettings(): Record<string, unknown> {
  return {
    permissions: { ask: ["Bash"] },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(PROXY_SCRIPT)}`, timeout: HOOK_TIMEOUT_S }] }] },
  };
}

/** Where an attempt works and what its commands may reach. */
export interface AttemptPlace extends Confinement {
  /** The folder the CLI works in. */
  cwd: string;
  /** Claude Code's own configuration folder, when the owner moved it. */
  configDir?: string;
}

const realOrAsIs = (place: string): string => {
  try {
    return fs.realpathSync(place);
  } catch {
    return path.resolve(place);
  }
};

/**
 * Claude Code's sandbox for every attempt (U27), checked against the settings reference and seen on 2.1.322:
 * - `enabled` with `failIfUnavailable`: the CLI's shell commands, and what they start, run under macOS Seatbelt, and
 *   the CLI refuses to start rather than run them without it.
 * - `autoAllowBashIfSandboxed` false. CRITICAL: true (the default before 2.1.324) lets a sandboxed command run without
 *   a permission prompt, which skips the bare `Bash` ask rule, so Botbench's permission check would never be heard.
 * - `allowUnsandboxedCommands` false: the model cannot have a command run outside the sandbox; no command is excluded.
 * - `filesystem.denyRead` holds the secret places and Botbench's data folder, and `allowRead` the attempt's own folder,
 *   which lies inside the data folder: Claude Code lets the narrower entry win, so the folder stays readable and the rest
 *   of the data folder does not. Writes stay where the sandbox puts them: the folder and a temporary folder of the CLI's.
 *   `denyWrite` holds the repository's shared git folder, which the sandbox would otherwise open for a linked worktree:
 *   git still reads it, and no command moves one of the owner's branches.
 * - `network.allowedDomains` is the repository's allowed hosts, none by default, and `strictAllowlist` refuses every
 *   other host instead of asking (a prompt Botbench would not know how to put to the owner).
 * - `credentials.envVars` takes the permission check's socket and secret out of every command's environment; the hook,
 *   which runs outside the sandbox, still has them.
 * - `permissions.blockReadsOutsideWorkingDirectories`: the CLI's own file tools, which run outside the sandbox, refuse
 *   reads outside the folder, and the sandbox also closes the rest of the home folder to commands.
 */
export function sandboxSettings(place: AttemptPlace): Record<string, unknown> {
  // Claude Code's settings reference: the read block does not reach sandboxed commands when the folder the CLI starts in has a glob character.
  if (/[*?[]/.test(place.cwd)) throw new Error(`Claude Code cannot be confined in ${place.cwd}: its path holds *, ? or [. Move Botbench's data folder to a path without them.`);
  const bad = place.allowedHosts.find((host) => hostProblem(host) !== null);
  if (bad !== undefined) throw new Error(`The host ${JSON.stringify(bad)} cannot be passed to Claude Code's sandbox. ${hostProblem(bad)}`);
  const filesystem: Record<string, string[]> = {
    denyRead: unreadablePaths({ dataDir: place.dataDir, also: place.configDir === undefined ? [] : [place.configDir] }),
    allowRead: [realOrAsIs(place.cwd)],
  };
  if (place.gitDir !== undefined) filesystem.denyWrite = [realOrAsIs(place.gitDir)];
  return {
    permissions: { blockReadsOutsideWorkingDirectories: true },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem,
      network: { allowedDomains: [...place.allowedHosts], strictAllowlist: true },
      credentials: { envVars: [{ name: SOCKET_ENV, mode: "deny" }, { name: SECRET_ENV, mode: "deny" }] },
    },
  };
}

/** The one settings object of an attempt: the sandbox, and with the gate its hook and ask rule as well. */
function attemptSettings(place: AttemptPlace, gated: boolean): string {
  const sandbox = sandboxSettings(place);
  if (!gated) return JSON.stringify(sandbox);
  const gate = gateSettings();
  return JSON.stringify({ ...gate, ...sandbox, permissions: { ...(gate.permissions as object), ...(sandbox.permissions as object) } });
}

/**
 * The arguments every Claude Code attempt is started with. Only the project's
 * own settings load, and the only MCP servers are the ones named here, which is
 * none: the owner's personal settings, allow rules, hooks, plugins and MCP
 * servers stay out. Without the permission gate nothing can answer a permission
 * prompt, so anything that would ask is denied.
 *
 * With `allowEdits` the one rule added allows the file-editing tools on paths
 * below the working directory. Seen on 2.1.322 with that rule: a file written
 * there lands; `sh script.sh`, `touch x`, a write outside the directory and a
 * write to `.claude/settings.json` need permission. The accept-edits permission
 * mode is not used because it lets more through (`touch`, `mkdir`, `rm`).
 * Such an attempt works on a repository's content, and 2.1.322 runs a
 * repository's own hooks without asking, so no settings file is loaded at all.
 *
 * With `gated` as well, the attempt goes through the permission gate: Botbench's
 * own settings object carries the pre-tool hook and the ask rule, and the CLI's
 * permission prompts come to the driver on stdout to be answered on stdin.
 * `instructionsFile` is the repository's instructions as text, which the CLI
 * no longer reads itself once settings files are off.
 *
 * Every attempt is given Botbench's settings object on the command line with Claude Code's sandbox in it
 * (`sandboxSettings`), for `confinement`.
 *
 * With `readOnly` the attempt changes nothing. Seen on 2.1.322: `--tools` leaves the CLI
 * with the listed tools and no other, so the model has no tool that writes a file, starts
 * an agent or fetches a page; the writing tools are also named as denied. It works on a
 * repository's content like an attempt that may edit, so no settings file is loaded, and
 * with `gated` every shell command asks through the gate. `readOnly` wins over `allowEdits`.
 */
export function claudeArgs(options: { confinement: AttemptPlace; model?: string; resumeCursor?: ResumeCursor; allowEdits?: boolean; readOnly?: boolean; gated?: boolean; instructionsFile?: string }): string[] {
  const readOnly = options.readOnly === true;
  const allowEdits = options.allowEdits === true && !readOnly;
  const inWorktree = allowEdits || readOnly;
  const gated = options.gated === true && inWorktree;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", inWorktree ? "" : "project",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
  ];
  args.push("--settings", attemptSettings(options.confinement, gated));
  if (gated) args.push("--permission-prompt-tool", "stdio");
  else args.push("--permission-prompts", "none");
  if (allowEdits) args.push("--allowedTools", EDITS_BELOW_CWD);
  if (readOnly) args.push("--tools", READ_ONLY_TOOLS, "--disallowedTools", WRITING_TOOLS);
  if (gated && options.instructionsFile) args.push("--append-system-prompt-file", options.instructionsFile);
  if (options.model !== undefined) {
    // The name is an argument of its own, and one that could be read as a flag never gets this far.
    const problem = modelNameProblem(options.model);
    if (problem !== null) throw new Error(`The model name cannot be passed to Claude Code. ${problem}`);
    args.push("--model", options.model);
  }
  if (options.resumeCursor) args.push("--resume", options.resumeCursor);
  return args;
}

const MODELS_REQUEST_ID = "botbench-models";
/** Asking the CLI what it offers starts no turn. No settings file, hook or MCP server is loaded for it. */
const MODELS_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--permission-prompts", "none"];
const MODELS_TIMEOUT_MS = 10_000;
const MODELS_FRESH_MS = 60_000;

/**
 * Read the CLI's answer to an `initialize` request: the models it offers and what it calls its own default.
 * Pure. Null when the output holds no such list. What the CLI prints is data: only entries whose name could be
 * handed back to it as an argument are kept, and nothing else of the answer (it also describes the account) is read.
 */
export function parseModelList(output: string): { models: ModelChoice[]; cliDefault: string | null } | null {
  for (const line of output.split("\n")) {
    if (!line.includes('"control_response"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const response = isObject(parsed) && parsed.type === "control_response" && isObject(parsed.response) ? parsed.response : null;
    const listed = response !== null && response.subtype === "success" && response.request_id === MODELS_REQUEST_ID && isObject(response.response) ? response.response.models : null;
    if (!Array.isArray(listed)) continue;
    const models: ModelChoice[] = [];
    let cliDefault: string | null = null;
    for (const entry of listed) {
      if (!isObject(entry) || typeof entry.value !== "string") continue;
      // The CLI lists its own default as an entry named "default"; its description says which model that is.
      if (entry.value === "default") cliDefault = str(entry.description) ?? str(entry.resolvedModel);
      else if (modelNameProblem(entry.value) === null && !models.some((m) => m.id === entry.value)) models.push({ id: entry.value, ...(typeof entry.displayName === "string" && entry.displayName !== "" ? { label: shorten(entry.displayName, 80) } : {}), ...(typeof entry.resolvedModel === "string" && entry.resolvedModel !== entry.value && modelNameProblem(entry.resolvedModel) === null ? { resolved: entry.resolvedModel } : {}) });
    }
    if (models.length > 0) return { models, cliDefault: cliDefault === null ? null : shorten(cliDefault, 80) };
  }
  return null;
}

const INSTRUCTIONS_FILE = "CLAUDE.md";
const MAX_INSTRUCTIONS = 64 * 1024;

/**
 * The repository's own instructions for an agent, as text to hand the CLI. With
 * settings files off the CLI does not read `CLAUDE.md` itself. Only an ordinary
 * file at the top of the worktree counts: a link is not followed, so a
 * repository cannot have a file from elsewhere on the machine sent along.
 * Files it refers to are not pulled in. Null when there is nothing to hand over.
 */
export function repositoryInstructions(worktree: string): string | null {
  const file = path.join(worktree, INSTRUCTIONS_FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INSTRUCTIONS) return null;
    return `This repository's ${INSTRUCTIONS_FILE} file says:\n\n${fs.readFileSync(fd, "utf8")}`;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
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

/** What Claude Code's sandbox, or its rule on reads, kept a tool call from, as the call's result reports it. */
export type Confined = { hosts: string[]; files: boolean };

/** The block the CLI adds to a sandboxed command's result when the sandbox refused something (seen on 2.1.322). */
const VIOLATIONS = /<sandbox_violations>\n([\s\S]*?)\n?<\/sandbox_violations>\s*$/;

/**
 * What a result says the call was kept from, or null when it says nothing of the kind. Read from the text, which the
 * command itself also writes, so it is a report to show, never a fact Botbench decides anything on.
 * - A host comes from the CLI's violations block: "deny network-outbound example.com:443 (...)".
 * - A file: macOS's "Operation not permitted", a file line of the block, or the CLI's own read rule refusing a file.
 */
export function confinedBy(output: string): Confined | null {
  const hosts: string[] = [];
  let files = false;
  const block = VIOLATIONS.exec(output);
  for (const line of block?.[1]?.split("\n") ?? []) {
    const host = /^deny network-outbound (\S+)/.exec(line.trim());
    if (host) hosts.push(host[1]!);
    else if (/^deny file-/.test(line.trim())) files = true;
  }
  if (/: Operation not permitted\b/.test(output) || output.includes("blockReadsOutsideWorkingDirectories")) files = true;
  return hosts.length > 0 || files ? { hosts, files } : null;
}

/**
 * Managed settings outrank Botbench's own: one could set `autoAllowBashIfSandboxed`, exclude commands from the sandbox or
 * allow hosts, and the owner would not be asked. Where a managed settings file of Claude Code's is on this Mac, Botbench
 * starts no agent. Only files are looked for (the paths in Claude Code's managed-settings guide for macOS, and the
 * preferences file a device-management profile leaves); server-managed settings of a Team or Enterprise login are not.
 */
export function managedSettingsProblem(places: readonly string[] = MANAGED_SETTINGS): string | null {
  const found = places.find((place) => fs.existsSync(place));
  return found === undefined ? null : `Claude Code has managed settings on this Mac (${found}), which come before Botbench's and could let commands run unconfined or without asking you. Botbench starts no agent while they are there.`;
}

const MANAGED_SETTINGS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.d",
  "/Library/Application Support/ClaudeCode/managed-mcp.json",
  "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  path.join("/Library/Managed Preferences", os.userInfo().username, "com.anthropic.claudecode.plist"),
];

/** What the CLI wrote to its error output when it would not start without its sandbox, in words for the owner; null when it wrote nothing of the kind. */
export function sandboxRefusal(stderr: string): string | null {
  // Claude Code 2.1.322's own words, from its code: "Error: sandbox required but unavailable: <reason>" and then
  // "sandbox.failIfUnavailable is set — refusing to start without a working sandbox."
  const reason = /sandbox required but unavailable: ([^\n]*)/.exec(stderr)?.[1]?.trim();
  if (reason === undefined) return null;
  return `Claude Code did not start: its sandbox cannot run on this computer (${shorten(reason, 300)}), and Botbench does not let an agent run commands without it. Nothing was run.`;
}

/**
 * Read a permission prompt the CLI printed. Null when it is not one, or is not whole: no id to answer,
 * no tool, no tool call, or an input that is not an object.
 */
export function parsePermissionRequest(parsed: Record<string, unknown>): Extract<DriverEvent, { type: "permission_request" }> | null {
  const request = parsed.request;
  if (parsed.type !== "control_request" || typeof parsed.request_id !== "string" || parsed.request_id === "" || !isObject(request) || request.subtype !== "can_use_tool") return null;
  const { tool_name: name, tool_use_id: toolCallId, input } = request;
  if (typeof name !== "string" || name === "" || typeof toolCallId !== "string" || toolCallId === "" || !isObject(input)) return null;
  // For a shell command the agent says in its own words what the command is for. Other tools carry no such account.
  const reason = name === "Bash" && typeof input.description === "string" && input.description.trim() !== "" ? shorten(input.description.trim()) : null;
  return { type: "permission_request", id: parsed.request_id, toolCallId, name, input, reason };
}

/**
 * Watches one gated attempt's events for a shell command that ran with no allow from the owner. The returned
 * function is given each event in order and answers true for a result that shows such a command ran. That cannot
 * happen while the CLI honours Botbench's settings (the ask rule alone makes every shell command ask); it would
 * if a CLI version silently dropped them, and then the attempt must not go on.
 */
export function shellWatch(): (event: DriverEvent) => boolean {
  const shellCalls = new Set<string>();
  const allowed = new Set<string>();
  return (event) => {
    if (event.type === "tool_call" && event.name === "Bash") shellCalls.add(event.id);
    else if (event.type === "permission_resolved" && (event.decision === "allowed" || event.decision === "preapproved" || event.decision === "standing")) allowed.add(event.toolCallId);
    else if (event.type === "tool_result" && !event.isError) return shellCalls.has(event.id) && !allowed.has(event.id);
    return false;
  };
}

/** The event with every occurrence of `secret` blanked, so it reaches neither the store nor a client. */
export function blank<E extends DriverEvent>(event: E, secret: string): E {
  const text = JSON.stringify(event);
  return text.includes(secret) ? (JSON.parse(text.replaceAll(secret, "[the attempt's gate secret, removed by Botbench]")) as E) : event;
}

/** What the agent is told when the owner declines. */
function declineMessage(note: string | null): string {
  const base = "The owner denied this request, so it was not run. Do not try to get the same thing done another way.";
  return note === null ? base : `${base} The owner's note: ${note}`;
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
    return [{ type: "error", message: "Claude Code printed a line Botbench could not read.", raw: shorten(line) }];
  }
  if (!isObject(parsed) || typeof parsed.type !== "string") {
    return [{ type: "error", message: "Claude Code printed a line that is not a message.", raw: shorten(line) }];
  }

  switch (parsed.type) {
    case "system": {
      if (parsed.subtype === "permission_denied") {
        return [{ type: "permission_denied", id: str(parsed.tool_use_id) ?? "", name: str(parsed.tool_name) ?? "", reason: str(parsed.decision_reason), code: str(parsed.decision_reason_code) }];
      }
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
          const output = toolOutput(block.content);
          const confined = confinedBy(output);
          events.push({ type: "tool_result", id: str(block.tool_use_id) ?? "", output, isError: block.is_error === true, ...(confined === null ? {} : { confined }) });
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
        // A failed turn can still carry the subtype "success" (seen for a model the CLI does not know); that word is left out.
        const subtype = parsed.subtype === "success" ? null : str(parsed.subtype);
        const detail = shorten([subtype, terminal, str(parsed.result)].filter(Boolean).join(": ") || "Claude Code reported a failure without saying why.");
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
  /** Permission prompts the CLI is waiting on, by request id. */
  private readonly asking = new Map<string, Extract<DriverEvent, { type: "permission_request" }>>();
  private readonly gated: boolean;
  private readonly ranUnasked: ((event: DriverEvent) => boolean) | null;
  private readonly cleanUp: () => void;
  /** The attempt's gate secret. A command the owner allowed can print its environment; the secret is blanked before anything is stored. */
  private readonly secret: string | null;

  constructor(db: DatabaseSync, attemptId: number, child: CliChild, pgid: number, cursor: ResumeCursor | null, gateSecret: string | null = null, cleanUp: () => void = () => {}) {
    const gated = gateSecret !== null;
    this.secret = gateSecret;
    this.db = db;
    this.attemptId = attemptId;
    this.child = child;
    this.pgid = pgid;
    this.cursor = cursor;
    this.gated = gated;
    this.ranUnasked = gated ? shellWatch() : null;
    this.cleanUp = cleanUp;

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
    if (this.hasExited || this.closing || this.status !== "running") return Promise.reject(new Error("This session with Claude Code has ended; start a new one to continue."));
    if (this.running) return Promise.reject(new Error("Claude Code is still working on the last message. Wait for it to finish, or stop it."));
    this.turn += 1;
    let resolve!: (reason: TurnEndReason) => void;
    const done = new Promise<TurnEndReason>((r) => (resolve = r));
    this.running = { done, resolve };
    // The CLI does not echo the prompt back, so the transcript gets it here.
    this.record({ type: "user_prompt", text: prompt });
    this.write({ type: "user", message: { role: "user", content: prompt } });
    return done;
  }

  async interruptTurn(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.interrupting = true;
    this.write({ type: "control_request", request_id: `botbench-interrupt-${this.turn}`, request: { subtype: "interrupt" } });
    // The CLI normally ends the turn within milliseconds. If it does not, the turn is ended here.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running.done, new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    if (this.running) this.endTurn("interrupted", "Claude Code did not confirm in time that it had stopped.");
    await this.stopProcess();
  }

  respondToRequest(requestId: string, response: unknown): Promise<void> {
    const request = this.asking.get(requestId);
    if (!request) return Promise.reject(new Error(`No permission request ${requestId} is waiting in this session: it was answered already, or Claude Code stopped waiting for it.`));
    // An answer that cannot reach the CLI is not recorded as given.
    if (this.hasExited || !this.child.stdin.writable) return Promise.reject(new Error(`The answer to permission request ${requestId} could not be delivered: Claude Code is no longer running. Nothing was run.`));
    this.asking.delete(requestId);
    const given: Partial<PermissionResponse> = isObject(response) ? response : {};
    const words = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    // Only the exact word allows. Anything else, a malformed answer included, declines.
    if (given.decision === "allow") {
      // An allow runs the input the owner was shown, unchanged.
      this.answerControl(requestId, { behavior: "allow", updatedInput: request.input });
      this.record({ type: "permission_resolved", id: requestId, toolCallId: request.toolCallId, decision: given.preapproved === true ? "preapproved" : given.standing === true ? "standing" : "allowed", note: null });
    } else if (words(given.refused) !== null) {
      const why = words(given.refused)!;
      this.answerControl(requestId, { behavior: "deny", message: `Botbench's permission check denied this request without asking the owner: ${why} Nothing was run.` });
      this.record({ type: "permission_resolved", id: requestId, toolCallId: request.toolCallId, decision: "denied", note: why });
    } else {
      const note = words(given.note);
      this.answerControl(requestId, { behavior: "deny", message: declineMessage(note) });
      this.record({ type: "permission_resolved", id: requestId, toolCallId: request.toolCallId, decision: "declined", note });
    }
    return Promise.resolve();
  }

  private answerControl(requestId: string, response: Record<string, unknown>): void {
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  /**
   * The CLI asked its host for something. The one thing Botbench answers is a permission prompt of a gated attempt
   * with a turn running; it becomes a `permission_request` event. Everything else is refused on the spot.
   */
  private onControlRequest(parsed: Record<string, unknown>): void {
    const request = parsePermissionRequest(parsed);
    if (request && this.gated && this.running && !this.asking.has(request.id)) {
      this.asking.set(request.id, request);
      return this.record(request);
    }
    const subtype = isObject(parsed.request) ? str(parsed.request.subtype) : null;
    this.record({ type: "error", message: `Claude Code asked for something Botbench does not answer (${subtype ?? "unreadable"}); it was refused.`, raw: shorten(JSON.stringify(parsed)) });
    if (typeof parsed.request_id !== "string") return;
    if (subtype === "can_use_tool") this.answerControl(parsed.request_id, { behavior: "deny", message: "Botbench could not read this permission request, so it was denied. Nothing was run." });
    else this.write({ type: "control_response", response: { subtype: "error", request_id: parsed.request_id, error: "Botbench does not answer this request." } });
  }

  /** The CLI no longer waits for these requests (all of them when none is named): say so in the transcript. */
  private cancelAsking(requestId?: string): void {
    for (const [id, request] of [...this.asking]) {
      if (requestId !== undefined && id !== requestId) continue;
      this.asking.delete(id);
      this.record({ type: "permission_resolved", id, toolCallId: request.toolCallId, decision: "cancelled", note: null });
    }
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
    // Requests from the CLI to its host are not transcript lines; they are answered here.
    if (line.includes('"control_request"') || line.includes('"control_cancel_request"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (isObject(parsed) && parsed.type === "control_request") return this.onControlRequest(parsed);
      if (isObject(parsed) && parsed.type === "control_cancel_request") return this.cancelAsking(str(parsed.request_id) ?? "");
    }
    for (const event of parseClaudeLine(line)) {
      if (event.type === "session_started") {
        // A repository's own settings can hand the CLI an API key, which would bill a subscription
        // session as metered use. Stop the turn the moment the CLI says a key is in play.
        if (event.keySource !== null && event.keySource !== "none") {
          const detail = `Stopped: Claude Code would pay for this with an API key (source: ${event.keySource}), not the signed-in login.`;
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
    // A turn that is over waits for no answer. Its end stays the last event of the turn.
    this.cancelAsking();
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
        this.endTurn("interrupted", "Claude Code exited.");
      } else {
        const how = spawnError ? spawnError.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
        const message = sandboxRefusal(this.stderrTail) ?? `Claude Code ${how} while it was working.`;
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
    this.cleanUp();
  }

  /** Append the event, apply the attempt change it causes in the same transaction, then tell listeners. */
  private record(given: DriverEvent, change?: AttemptChange): void {
    const event = this.secret === null ? given : blank(given, this.secret);
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
    if (this.ranUnasked?.(event)) this.stopUngated();
  }

  /** The CLI ran a shell command the owner never allowed, so it is not keeping to the gate: nothing more runs in this attempt. */
  private stopUngated(): void {
    const detail = "Stopped: Claude Code ran a shell command without asking, so it is not keeping to Botbench's permission settings. Nothing more is run in this session.";
    this.record({ type: "error", message: detail, raw: null });
    if (this.running) this.endTurn("error", detail, "failed");
    void killProcessGroup(this.pgid).catch(() => {});
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
  /** The owner's configured list of models, offered when the CLI reports none. */
  models?: readonly string[];
  /** The configured model, preselected for the owner. The CLI's own default when absent. */
  defaultModel?: string;
}

export class ClaudeCodeDriver implements Driver {
  readonly name = CLAUDE_CODE;
  readonly capabilities = CAPABILITIES;
  readonly signIn: SignInDefinition;
  private readonly extraEnv: Record<string, string>;
  private readonly configDir: string | undefined;
  private readonly configured: { models: readonly string[]; defaultModel: string | null };
  /** The list being read, or read less than `MODELS_FRESH_MS` ago: screens that open together share one CLI process. */
  private listing: { at: number; answer: Promise<DriverModels> } | null = null;

  constructor(options: ClaudeCodeDriverOptions = {}) {
    this.extraEnv = options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {};
    this.configDir = options.configDir || undefined;
    this.signIn = claudeCodeSignIn(this.configDir);
    this.configured = { models: options.models ?? [], defaultModel: options.defaultModel ?? null };
  }

  /**
   * Ask the CLI itself which models it offers, with one `initialize` request and no turn. The process has a time
   * limit and is gone when this returns. A CLI that is missing, too slow, or prints no list leaves the configured list.
   */
  models(): Promise<DriverModels> {
    if (this.listing !== null && Date.now() - this.listing.at < MODELS_FRESH_MS) return this.listing.answer;
    const listing = { at: Date.now(), answer: this.readModels() };
    this.listing = listing;
    // Only a list the CLI gave is kept for a while; a CLI that gave none is asked again next time.
    void listing.answer.then((answer) => {
      if (answer.source !== "cli" && this.listing === listing) this.listing = null;
    });
    return listing.answer;
  }

  private async readModels(): Promise<DriverModels> {
    const run = await runCli(COMMAND, MODELS_ARGS, {
      cwd: os.tmpdir(),
      extraEnv: this.extraEnv,
      timeoutMs: MODELS_TIMEOUT_MS,
      stdin: `${JSON.stringify({ type: "control_request", request_id: MODELS_REQUEST_ID, request: { subtype: "initialize" } })}\n`,
    });
    const reported = run.started ? parseModelList(run.stdout) : null;
    if (reported !== null) return { source: "cli", models: reported.models, default: this.configured.defaultModel, cliDefault: reported.cliDefault };
    return { source: "config", models: this.configured.models.map((id) => ({ id })), default: this.configured.defaultModel, cliDefault: null };
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
        ? `Claude Code ${check.version} is too old for Botbench: it is not known to accept ${check.missingFlags.join(", ")}. Update Claude Code.`
        : "Claude Code did not report a version Botbench can read.";
      return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem };
    }

    // An agent's commands run in Claude Code's sandbox or not at all, and with nothing above Botbench's settings that could loosen it.
    const unconfined = confinementProblem() ?? managedSettingsProblem();
    if (unconfined !== null) return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem: unconfined };

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

    // The gate is for an attempt in a worktree. Its secret travels in the child's environment, never on the command line.
    const gate = options.allowEdits || options.readOnly ? options.gate : undefined;
    // A read-only attempt is handed no instructions from the repository: what it needs of them it reads as a file.
    const instructions = gate && !options.readOnly ? repositoryInstructions(options.cwd) : null;
    let instructionsDir: string | null = null;
    if (instructions !== null) {
      // An owner-only directory for the one file; it goes when the CLI process does.
      instructionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-instructions-"));
      fs.writeFileSync(path.join(instructionsDir, "instructions.md"), instructions, { mode: 0o600 });
    }
    const cleanUp = (): void => {
      if (instructionsDir !== null) fs.rmSync(instructionsDir, { recursive: true, force: true });
    };
    const args = claudeArgs({
      confinement: { ...options.confinement, cwd: options.cwd, ...(this.configDir === undefined ? {} : { configDir: this.configDir }) },
      gated: gate !== undefined,
      ...(options.model ? { model: options.model } : {}),
      ...(options.resumeCursor ? { resumeCursor: options.resumeCursor } : {}),
      ...(options.allowEdits ? { allowEdits: true } : {}),
      ...(options.readOnly ? { readOnly: true } : {}),
      ...(instructionsDir === null ? {} : { instructionsFile: path.join(instructionsDir, "instructions.md") }),
    });
    const extraEnv = gate ? { ...this.extraEnv, [SOCKET_ENV]: gate.socketPath, [SECRET_ENV]: gate.secret } : this.extraEnv;
    const { child, pgid } = launch(COMMAND, args, { cwd: options.cwd, extraEnv });
    if (!pgid) {
      child.on("error", () => {});
      cleanUp();
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
      cleanUp();
      throw err;
    }
    return new ClaudeCodeSession(options.db, attemptId, child, pgid, options.resumeCursor ?? null, gate?.secret ?? null, cleanUp);
  }
}

