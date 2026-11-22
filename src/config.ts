import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_RULES, type FloorEntry } from "./approvals/floor.ts";
import { entryProblem, realRepo } from "./approvals/grants.ts";
import { splitPlain } from "./approvals/shell.ts";
import { MODEL_NAME_RULE, modelNameProblem } from "./drivers/contract.ts";
import { DEFAULT_LIMIT_MS, type StationCommand } from "./engine/stations.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_FILE = path.join(ROOT, "smelt.config.json");
/** Optional, git-ignored: the owner's own settings, merged over the defaults. */
export const LOCAL_CONFIG_FILE = path.join(ROOT, "smelt.local.json");

/** Where Smelt keeps its database and everything else it stores. */
export function smeltHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SMELT_HOME;
  if (!raw) return path.join(os.homedir(), ".smelt");
  // The shell does not expand ~ inside an environment value, and a relative path would move with the working directory.
  if (raw === "~" || raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(1));
  return path.resolve(raw);
}

export const DRIVER_NAMES = ["claude-code", "codex", "gemini-cli", "grok"] as const;
export type DriverName = (typeof DRIVER_NAMES)[number];

export interface DriverConfig {
  /** Model to ask the CLI for; the CLI's own default when absent. */
  model?: string;
  /** The models offered to the owner when the CLI itself reports no list. */
  models?: string[];
}
export interface RoleConfig {
  driver: DriverName;
  /** Model for this role; the driver's `model` when absent. Only the implementer role is in use so far. */
  model?: string;
}
/** What the owner has set for one repository. */
export interface RepositoryConfig {
  /** Commands offered on the new-task screen as the ones a task may run without asking. The owner confirms or edits them per task. */
  preapproved?: string[];
  /** Commands Smelt runs in each new worktree before its builder starts, in order; one that fails ends the task. */
  setup?: CommandConfig[];
  /** Commands Smelt runs in the worktree after the work is committed, each with its time limit; their results are evidence on the task. */
  checks?: CommandConfig[];
}
/** A command Smelt runs itself: its text, or its text with its own time limit in seconds (10 minutes when none is given). */
export type CommandConfig = string | { command: string; timeoutSeconds?: number };
const MAX_TIMEOUT_SECONDS = 86_400;
/** One entry the owner adds to the safety floor: a command whose words, found anywhere in a request, make it always ask. */
export interface FloorConfig {
  name: string;
  command: string;
}
export interface Config {
  port: number;
  /** Addresses to listen on. The default is the loopback address only. */
  listen: string[];
  /**
   * HTTPS names a private-network proxy forwards from, such as the name `tailscale serve` gives this Mac.
   * A request whose `Host` is one of these is treated as having arrived over HTTPS. None when absent.
   */
  publicHosts?: string[];
  drivers: Partial<Record<DriverName, DriverConfig>>;
  roles: Record<string, RoleConfig>;
  /** Settings per repository, keyed by the repository's full path. */
  repositories?: Record<string, RepositoryConfig>;
  /** Entries added to the safety floor. The built-in rules cannot be removed or changed from here. */
  floor?: FloorConfig[];
  /** How trust is earned. */
  autonomy?: AutonomyConfig;
}
export interface AutonomyConfig {
  /** After the owner has allowed the same command this many times, its next card offers standing permission. A whole number of at least 1; 3 when absent. */
  offerStandingAfter?: number;
}
const OFFER_STANDING_AFTER = 3;
const AUTONOMY_SETTINGS = ["offerStandingAfter"] as const;

/** How many approvals of the same command earn the offer of standing permission. */
export function offerStandingAfter(config: Config): number {
  return config.autonomy?.offerStandingAfter ?? OFFER_STANDING_AFTER;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(file: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read config file ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!isObject(parsed)) throw new Error(`Config file ${file} must be a JSON object.`);
  return parsed;
}

const isDriverName = (name: string): name is DriverName => (DRIVER_NAMES as readonly string[]).includes(name);
const KNOWN = `Known drivers: ${DRIVER_NAMES.join(", ")}.`;

/** Checked per file, before merging, so the message can say which file to fix. */
function checkDriverNames(json: Json, file: string): void {
  if (isObject(json.drivers)) {
    for (const name of Object.keys(json.drivers)) {
      if (!isDriverName(name)) throw new Error(`${file}: "drivers" has unknown driver "${name}". ${KNOWN}`);
    }
  }
  if (isObject(json.roles)) {
    for (const [role, value] of Object.entries(json.roles)) {
      if (isObject(value) && typeof value.driver === "string" && !isDriverName(value.driver)) {
        throw new Error(`${file}: role "${role}" names unknown driver "${value.driver}". ${KNOWN}`);
      }
    }
  }
}

/** Check the merged result has the shape of a Config; `where` names the files it came from. */
function validate(c: Json, where: string): Config {
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const { port, listen, publicHosts, drivers, roles, repositories, floor, autonomy } = c;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) fail(`"port" must be a whole number from 0 to 65535.`);
  if (!Array.isArray(listen) || listen.length === 0 || !listen.every((a) => typeof a === "string" && a !== "")) {
    fail(`"listen" must be a non-empty list of addresses.`);
  }
  if (publicHosts !== undefined && !(Array.isArray(publicHosts) && publicHosts.every((h) => typeof h === "string" && /^[^\s/]+$/.test(h)))) {
    fail(`"publicHosts" must be a list of host names such as "mac.tailnet.ts.net", without "https://" or a path.`);
  }
  if (!isObject(drivers)) return fail(`"drivers" must be an object keyed by driver name.`);
  for (const [name, value] of Object.entries(drivers)) {
    if (!isObject(value)) fail(`driver "${name}" must be an object.`);
    else if (value.model !== undefined && modelNameProblem(value.model) !== null) fail(`driver "${name}": "model" must be a model name. ${modelNameProblem(value.model)}`);
    else if (value.models !== undefined && !Array.isArray(value.models)) fail(`driver "${name}": "models" must be a list of model names.`);
    else if (Array.isArray(value.models) && !value.models.every((m) => modelNameProblem(m) === null)) fail(`driver "${name}": "models" must hold only model names. ${MODEL_NAME_RULE}`);
  }
  if (!isObject(roles)) return fail(`"roles" must be an object keyed by role name.`);
  for (const [role, value] of Object.entries(roles)) {
    if (!isObject(value) || typeof value.driver !== "string") fail(`role "${role}" must be an object with a "driver".`);
    else if (!(value.driver in drivers)) fail(`role "${role}" uses driver "${value.driver}", which is not in "drivers".`);
    else if (value.model !== undefined && modelNameProblem(value.model) !== null) fail(`role "${role}": "model" must be a model name. ${modelNameProblem(value.model)}`);
  }
  if (repositories !== undefined) {
    if (!isObject(repositories)) return fail(`"repositories" must be an object keyed by the full path of each repository.`);
    for (const [repo, value] of Object.entries(repositories)) {
      if (!path.isAbsolute(repo)) fail(`"repositories" has the key "${repo}", which is not a full path starting with /.`);
      if (!isObject(value)) return fail(`repository "${repo}" must be an object.`);
      for (const [setting, list] of Object.entries(value)) {
        if (!(REPOSITORY_SETTINGS as readonly string[]).includes(setting)) fail(`repository "${repo}" has unknown setting "${setting}". Known settings: ${REPOSITORY_SETTINGS.join(", ")}.`);
        if (setting === "preapproved") {
          if (!Array.isArray(list) || !list.every((command) => typeof command === "string")) return fail(`repository "${repo}": "${setting}" must be a list of commands.`);
          const problem = list.map(entryProblem).find((p) => p !== null);
          if (problem) fail(`repository "${repo}": "${setting}" holds a command that cannot be used. ${problem}`);
          continue;
        }
        // Setup and check commands are run by Smelt itself, through a shell, so they are not held to one plain command.
        if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string" || isObject(entry))) return fail(`repository "${repo}": "${setting}" must be a list of commands.`);
        for (const entry of list as unknown[]) {
          const problem = commandProblem(entry);
          if (problem) fail(`repository "${repo}": "${setting}" holds a command that cannot be used. ${problem}`);
        }
      }
    }
  }
  if (floor !== undefined) {
    if (!Array.isArray(floor)) return fail(`"floor" must be a list of entries, each with a "name" and a "command".`);
    for (const entry of floor) {
      if (!isObject(entry) || typeof entry.name !== "string" || entry.name.trim() === "" || typeof entry.command !== "string") return fail(`"floor" must be a list of entries, each with a "name" and a "command".`);
      if (FLOOR_RULES.some((rule) => rule.name === entry.name)) fail(`"floor" has an entry named "${entry.name}", which is the name of a built-in rule. Built-in rules cannot be replaced; give the entry its own name.`);
      if (splitPlain(entry.command) === null) fail(`"floor" entry "${entry.name}": its command must be one plain command, such as "npm publish".`);
    }
  }
  if (autonomy !== undefined) {
    if (!isObject(autonomy)) return fail(`"autonomy" must be an object, such as { "offerStandingAfter": 3 }.`);
    for (const setting of Object.keys(autonomy)) {
      if (!(AUTONOMY_SETTINGS as readonly string[]).includes(setting)) fail(`"autonomy" has unknown setting "${setting}". Known settings: ${AUTONOMY_SETTINGS.join(", ")}.`);
    }
    const after = autonomy.offerStandingAfter;
    if (after !== undefined && !(typeof after === "number" && Number.isSafeInteger(after) && after >= 1)) fail(`"autonomy.offerStandingAfter" must be a whole number of at least 1: how many times you allow the same command before its card offers standing permission.`);
  }
  return c as unknown as Config;
}

const REPOSITORY_SETTINGS = ["preapproved", "setup", "checks"] as const;

/** Why a setup or check entry cannot be used, or null. */
function commandProblem(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() === "" ? "A command is empty." : null;
  if (!isObject(entry)) return 'Each entry is a command, or { "command": "...", "timeoutSeconds": 600 }.';
  const unknown = Object.keys(entry).find((key) => key !== "command" && key !== "timeoutSeconds");
  if (unknown !== undefined) return `An entry has the unknown setting "${unknown}"; an entry holds "command" and, if you like, "timeoutSeconds".`;
  if (typeof entry.command !== "string") return 'An entry needs a "command": the command as text.';
  if (entry.command.trim() === "") return "A command is empty.";
  const limit = entry.timeoutSeconds;
  if (limit !== undefined && !(typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= MAX_TIMEOUT_SECONDS)) return `"timeoutSeconds" must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}.`;
  return null;
}

const asCommand = (entry: CommandConfig): StationCommand =>
  typeof entry === "string" ? { command: entry, limitMs: DEFAULT_LIMIT_MS } : { command: entry.command, limitMs: entry.timeoutSeconds === undefined ? DEFAULT_LIMIT_MS : entry.timeoutSeconds * 1000 };

/** The commands Smelt runs itself in a repository's worktrees, each with its time limit. */
export function repositoryCommands(config: Config, repo: string): { setup: StationCommand[]; checks: StationCommand[] } {
  const settings = repositorySettings(config, repo);
  return { setup: (settings.setup ?? []).map(asCommand), checks: (settings.checks ?? []).map(asCommand) };
}

/** A repository's settings, found by its real path. The config's keys are compared as written and with their links followed. */
export function repositorySettings(config: Config, repo: string): RepositoryConfig {
  const real = realRepo(repo);
  for (const [key, value] of Object.entries(config.repositories ?? {})) {
    if (path.resolve(key) === real || realRepo(key) === real) return value;
  }
  return {};
}

/** The owner's added floor entries as the words the floor compares. */
export function floorEntries(config: Config): FloorEntry[] {
  return (config.floor ?? []).map((entry) => ({ name: entry.name, words: splitPlain(entry.command) ?? [] }));
}

/** Objects merge key by key; anything else, arrays included, is replaced. */
function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObject(v) && isObject(b) ? merge(b, v) : v;
  }
  return out;
}

export interface ConfigFiles {
  defaults: string;
  /** Skipped when absent or when the file does not exist. */
  local?: string;
}

export function loadConfig(files: ConfigFiles = { defaults: DEFAULT_CONFIG_FILE, local: LOCAL_CONFIG_FILE }): Config {
  let merged = readJson(files.defaults);
  checkDriverNames(merged, files.defaults);
  let where = files.defaults;
  if (files.local && fs.existsSync(files.local)) {
    const local = readJson(files.local);
    checkDriverNames(local, files.local);
    merged = merge(merged, local);
    where = `${files.defaults} with ${files.local}`;
  }
  return validate(merged, where);
}
