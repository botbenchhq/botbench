import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_NAME_RULE, modelNameProblem } from "./drivers/contract.ts";

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
  const { port, listen, publicHosts, drivers, roles } = c;
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
  return c as unknown as Config;
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
