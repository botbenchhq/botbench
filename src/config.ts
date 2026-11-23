import { DEFAULT_MAX_REFINE_ROUNDS, MAX_REFINE_ROUNDS } from "./engine/refine.ts";
import { DEFAULT_CHECK_FIX_ROUNDS, MAX_CHECK_FIX_ROUNDS } from "./engine/check-fix.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_RULES, type FloorEntry } from "./approvals/floor.ts";
import { entryProblem, realRepo } from "./approvals/grants.ts";
import { HOST_RULE, hostProblem } from "./confinement.ts";
import { executionProblem, HOST_EXECUTION, type Execution } from "./execution.ts";
import { splitPlain } from "./approvals/shell.ts";
import { MODEL_NAME_RULE, modelNameProblem, type DriverCapabilities } from "./drivers/contract.ts";
import { ANTIGRAVITY, ANTIGRAVITY_CAPABILITIES } from "./drivers/antigravity.ts";
import { CODEX, CODEX_CAPABILITIES } from "./drivers/codex.ts";
import { isRunMode, type RunMode } from "./engine/modes.ts";
import { GROK, GROK_CAPABILITIES } from "./drivers/grok.ts";
import { roleProblem } from "./engine/roles.ts";
import { BRANCH_PREFIX, remoteNameProblem } from "./worktrees.ts";
import { DEFAULT_LIMIT_MS, type StationCommand } from "./engine/stations.ts";
import { machineChecksProblem, type MachineCheck, type MachineNeed } from "./engine/machine-checks.ts";
import { workbenchProblem } from "./workbench.ts";
import { labelProblem } from "./github.ts";
import { USAGE_LIMIT_WAIT_MS } from "./engine/usage-limit.ts";
import { peerAddressProblem } from "./peers/address.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_FILE = path.join(ROOT, "botbench.config.json");
/** Optional, git-ignored: the owner's own settings, merged over the defaults. */
export const LOCAL_CONFIG_FILE = path.join(ROOT, "botbench.local.json");
/** The same file under the product's old name (Smelt), read for one release when the new one is absent. */
export const LEGACY_LOCAL_CONFIG_FILE = path.join(ROOT, "smelt.local.json");

/** Writes one line to the log on stdout, for whoever runs the process. */
export type Log = (line: string) => void;

/**
 * A setting from the environment: `BOTBENCH_<name>`, or for one release the old name `SMELT_<name>` when the new one is
 * unset, with a line saying so. An empty value counts as unset.
 */
export function envSetting(env: NodeJS.ProcessEnv, name: "HOME" | "PORT" | "CONFIG", log: Log): string | undefined {
  const current = env[`BOTBENCH_${name}`];
  const old = env[`SMELT_${name}`];
  if (current) {
    if (old) log(`SMELT_${name} is set but not read: BOTBENCH_${name} is set too and is used. Remove SMELT_${name}.`);
    return current;
  }
  if (!old) return undefined;
  log(`SMELT_${name} is the old name of BOTBENCH_${name}. It is read for this release only; rename it to BOTBENCH_${name}.`);
  return old;
}

/**
 * Where Botbench keeps its database and everything else it stores (`home`), and the old default folder an installation
 * from before the rename may have left (`legacy`). There is a legacy folder only when no variable names the data folder:
 * a folder the owner named is used as it is, and an installation is never moved into it.
 */
export function dataHomes(env: NodeJS.ProcessEnv = process.env, log: Log = () => {}, homedir: string = os.homedir()): { home: string; legacy: string | null } {
  const raw = envSetting(env, "HOME", log);
  if (!raw) return { home: path.join(homedir, ".botbench"), legacy: path.join(homedir, ".smelt") };
  // The shell does not expand ~ inside an environment value, and a relative path would move with the working directory.
  if (raw === "~" || raw.startsWith("~/")) return { home: path.join(homedir, raw.slice(1)), legacy: null };
  return { home: path.resolve(raw), legacy: null };
}

/** Where Botbench keeps its database and everything else it stores. */
export function botbenchHome(env: NodeJS.ProcessEnv = process.env): string {
  return dataHomes(env).home;
}

/**
 * The owner's settings file: the one `BOTBENCH_CONFIG` (or the old `SMELT_CONFIG`) names for one start, else
 * botbench.local.json, else for one release the old smelt.local.json beside it, with a line saying so. Botbench never
 * writes either file.
 */
export function localConfigFile(env: NodeJS.ProcessEnv, log: Log, files = { current: LOCAL_CONFIG_FILE, legacy: LEGACY_LOCAL_CONFIG_FILE }): string {
  const named = envSetting(env, "CONFIG", log);
  if (named) return path.resolve(named);
  if (fs.existsSync(files.current) || !fs.existsSync(files.legacy)) return files.current;
  log(`Read the settings from ${files.legacy}, the file's old name. Rename it to ${path.basename(files.current)}; the old name is read for this release only.`);
  return files.legacy;
}

export const DRIVER_NAMES = ["claude-code", "codex", "gemini-cli", "grok", "antigravity"] as const;

/** The agents that review only, with what they lack for any other role. */
const REVIEW_ONLY: Record<string, DriverCapabilities> = { [CODEX]: CODEX_CAPABILITIES, [GROK]: GROK_CAPABILITIES, [ANTIGRAVITY]: ANTIGRAVITY_CAPABILITIES };
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
  /** Commands Botbench runs in each new worktree before its builder starts, in order; one that fails ends the task. */
  setup?: CommandConfig[];
  /** Commands Botbench runs in the worktree after the work is committed, each with its time limit; their results are evidence on the task. */
  checks?: CommandConfig[];
  /**
   * Checks that need what a check's sandbox does not give (engine/machine-checks.ts, #201): Botbench runs them itself
   * after the checks, before the review, outside the builder's turn, each allowed only what its "needs" names:
   * "chrome" (start headless Chrome, still in a check's sandbox) or "nested-sandbox" (start sandbox-exec, which macOS
   * allows only outside any sandbox: such a check runs with your own rights). With "files", `{files}` in the command
   * becomes the files this change touches that match those patterns, quoted, and the check is skipped when there are none.
   * A failure goes back to the builder as a round of fixes for a failing check. None when absent.
   */
  machineChecks?: MachineCheckConfig[];
  /**
   * The host names this repository's commands may reach: the builder's commands, through Claude Code's sandbox, and the
   * setup and check commands, through Botbench's proxy. Plain names only. None, and no network at all, when absent.
   * The planner's commands reach no network whatever is set here.
   */
  allowedHosts?: string[];
  /** The remote an accepted task's branch is pushed to for a pull request; "origin" when absent. */
  remote?: string;
  /** The branch a pull request asks to be merged into, and the one "Bring up to date with main" merges into a task (engine/branch-update.ts); the repository's default branch on GitHub, as `gh` reports it (for a merge, the remote's HEAD as last fetched, else main or master), when absent. */
  baseBranch?: string;
  /** Paths in this repository, added to the top-level "protectedPaths", that only the owner may accept a change to. */
  protectedPaths?: string[];
  /**
   * Whether a run started from an issue of this repository, and set to open pull requests, claims the issue on the
   * remote as it starts (Peers P3, engine/claims.ts): two empty branches other workbenches see, deleted again when the
   * run ends without a pull request. A run that keeps its work on this Mac pushes nothing either way. Off when absent.
   */
  claimIssues?: boolean;
  /**
   * Watch this repository's open issues for a label (engine/watch.ts, ADR 0008): every `intervalMinutes` (10 when
   * absent), Botbench lists with the owner's gh the open issues carrying `label` and proposes each new one on Work, for
   * the owner to start or dismiss. It never starts a run by itself. Only people who can apply labels to the repository
   * should be able to apply this one: the label is what makes an issue a proposal. Not watched when absent.
   */
  watch?: WatchConfig;
  /**
   * Where this repository's commands run (src/execution.ts, ADR 0009): `{ "kind": "host" }`, on this Mac, kept away
   * from the owner's sign-ins and the network, or `{ "kind": "container", "image": "node:24" }`, in one Docker container
   * per task of an image already on this Mac, with the task's copy as its one mount and no network. "host" when absent.
   * A container is refused with "allowedHosts", and nothing ever falls back to the host.
   */
  execution?: Execution;
}
/** What a repository's watch is set to. */
export interface WatchConfig {
  label: string;
  intervalMinutes?: number;
}
/** How often a watched repository is read when its settings say nothing, in minutes. */
export const WATCH_INTERVAL_MINUTES = 10;
const MAX_WATCH_INTERVAL_MINUTES = 1440;
const WATCH_SETTINGS = ["label", "intervalMinutes"] as const;
/** A command Botbench runs itself: its text, or its text with its own time limit in seconds (10 minutes when none is given). */
export type CommandConfig = string | { command: string; timeoutSeconds?: number };
/** A machine check as the settings file gives it. */
export interface MachineCheckConfig {
  command: string;
  needs: MachineNeed[];
  files?: string[];
  timeoutSeconds?: number;
}
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
  /**
   * This installation's workbench name, which its new task branches carry (`botbench/<workbench>/run-N/task-M`). When
   * absent, the name kept in the data folder: made once from the host name, changed in Settings (src/workbench.ts).
   */
  workbench?: string;
  /**
   * Paths, relative to a repository's top folder, that only the owner may accept a change to, in every repository
   * Botbench works on: a folder ("test/recordings/") or one file. A task that changed a file under one is held for the
   * owner in every mode, saying which files (engine/scope.ts). None when absent.
   */
  protectedPaths?: string[];
  /** Talking to a paired workbench directly (Peers P5, ADR 0004). Off when absent. */
  peers?: PeersConfig;
}
export interface PeersConfig {
  /**
   * Where the peer listener listens: one loopback, private or 100.64.0.0/10 address and a port (src/peers/address.ts).
   * No peer listener, and so no pairing, when absent. Keep the port fixed: a paired workbench reaches this one there.
   */
  listen?: { address: string; port: number };
  /** The most messages an agent may draft to paired workbenches in one run, a chat counting as one (ADR 0004 decision 12): 0 to 50; 5 when absent. */
  messagesPerRun?: number;
  /** The most round trips in one thread with a paired workbench (decision 6): 1 to 10; 3 when absent. */
  roundTripsPerThread?: number;
}
export interface AutonomyConfig {
  /** After the owner has allowed the same command this many times, its next card offers standing permission. A whole number of at least 1; 3 when absent. */
  offerStandingAfter?: number;
  /** The mode a new run is given when none is chosen, until the owner picks one in Settings: "manual" (when absent), "semi" or "full". */
  mode?: RunMode;
  /** After a review with concerns, how many rounds of fixes the builder may be asked for before the task is Ready for review. 0 to 5; 2 when absent. */
  maxRefineRounds?: number;
  /** When a check fails on the committed work, how many rounds of fixes for it the builder gets on each version of the work before the task goes on with the check failed. 0 to 5; 2 when absent. */
  maxCheckFixRounds?: number;
  /**
   * How long, in whole seconds, a builder or a planner may send nothing while it works before Botbench stops it and
   * everything it started. Time spent waiting on the owner's answer to a request does not count. 0 turns the limit
   * off; 600 (10 minutes) when absent; at most 86,400 (a day).
   */
  silenceLimitSeconds?: number;
  /**
   * When a builder's turn ends because its agent's usage limit was reached, Botbench waits and then resumes the same
   * session once, at the reset time the agent gives (engine/usage-limit.ts). When it gives none, or one that has
   * passed, Botbench waits this many whole seconds instead. 1800 (30 minutes) when absent; from 1 to 86,400 (a day).
   */
  usageLimitWaitSeconds?: number;
}
const OFFER_STANDING_AFTER = 3;
const SILENCE_LIMIT_SECONDS = 600;
const MAX_SILENCE_LIMIT_SECONDS = 86_400;
const MAX_USAGE_LIMIT_WAIT_SECONDS = 86_400;
const AUTONOMY_SETTINGS = ["offerStandingAfter", "mode", "maxRefineRounds", "maxCheckFixRounds", "silenceLimitSeconds", "usageLimitWaitSeconds"] as const;

/** How long a builder or planner may send nothing before it is stopped, in milliseconds; 0 when the limit is off. */
export function silenceLimitMs(config: Config): number {
  return (config.autonomy?.silenceLimitSeconds ?? SILENCE_LIMIT_SECONDS) * 1000;
}

/** How long Botbench waits after a usage limit when the agent gives no reset time, in milliseconds. */
export function usageLimitWaitMs(config: Config): number {
  const seconds = config.autonomy?.usageLimitWaitSeconds;
  return seconds === undefined ? USAGE_LIMIT_WAIT_MS : seconds * 1000;
}

/** How many rounds of fixes a run started now allows after a review with concerns. */
export function maxRefineRounds(config: Config): number {
  return config.autonomy?.maxRefineRounds ?? DEFAULT_MAX_REFINE_ROUNDS;
}

/** How many rounds of fixes for a failing check the builder gets on each version of a task's work. */
export function maxCheckFixRounds(config: Config): number {
  return config.autonomy?.maxCheckFixRounds ?? DEFAULT_CHECK_FIX_ROUNDS;
}

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
function checkFile(json: Json, file: string): void {
  const peering = peersProblem(json.peers, true);
  if (peering !== null) throw new Error(`${file}: ${peering}`);
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

/**
 * Why "peers" in a settings file cannot be used, as a sentence naming the setting, or null. Checked per file, so the
 * message names the file that set it, and again on the merged result.
 */
export function peersProblem(peers: unknown, inFile = false): string | null {
  if (peers === undefined) return null;
  if (!isObject(peers)) return `"peers" must be an object, such as { "listen": { "address": "127.0.0.1", "port": 4790 } }.`;
  const unknown = Object.keys(peers).find((key) => key !== "listen" && key !== "messagesPerRun" && key !== "roundTripsPerThread");
  if (unknown !== undefined) return `"peers" has unknown setting "${unknown}". Known settings: listen, messagesPerRun, roundTripsPerThread.`;
  const cap = peers.messagesPerRun;
  if (cap !== undefined && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > 50)) return `"peers.messagesPerRun" must be a whole number from 0 to 50: the most messages an agent may draft to other workbenches in one run. 5 when left out.`;
  const trips = peers.roundTripsPerThread;
  if (trips !== undefined && (typeof trips !== "number" || !Number.isInteger(trips) || trips < 1 || trips > 10)) return `"peers.roundTripsPerThread" must be a whole number from 1 to 10: the most round trips in one thread with another workbench. 3 when left out.`;
  const listen = peers.listen;
  if (listen === undefined) return null;
  if (!isObject(listen) || Object.keys(listen).some((key) => key !== "address" && key !== "port")) return `"peers.listen" must be { "address": "127.0.0.1", "port": 4790 }: where the listener for paired workbenches listens. Leave "peers" out to keep it off.`;
  const address = peerAddressProblem(listen.address);
  if (address !== null) return `"peers.listen.address" cannot be used, so Botbench did not start. ${address} Or leave "peers" out to keep the listener off.`;
  const port = listen.port;
  // In a settings file the port is fixed: a paired workbench reaches this one there, so one picked anew at each start
  // would break every pairing. Only a config handed over in code (a test) may ask for any free port with 0.
  if (typeof port !== "number" || !Number.isInteger(port) || port < (inFile ? 1 : 0) || port > 65535) return `"peers.listen.port" must be a whole number from 1 to 65535, such as 4790: the port a paired workbench reaches this one on.`;
  return null;
}

/** Check the merged result has the shape of a Config; `where` names the files it came from. */
function validate(c: Json, where: string): Config {
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  const { port, listen, publicHosts, drivers, roles, repositories, floor, autonomy, workbench, protectedPaths, peers } = c;
  const peering = peersProblem(peers);
  if (peering !== null) fail(peering);
  const guarded = protectedPaths === undefined ? null : protectedPathsProblem(protectedPaths);
  if (guarded !== null) fail(`"protectedPaths" ${guarded}`);
  if (workbench !== undefined && workbenchProblem(workbench) !== null) fail(`"workbench" must be a workbench name. ${workbenchProblem(workbench)}`);
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
    else if (Object.hasOwn(REVIEW_ONLY, value.driver) && roleProblem(role, value.driver, REVIEW_ONLY[value.driver]!) !== null) fail(`role "${role}": ${roleProblem(role, value.driver, REVIEW_ONLY[value.driver]!)}`);
  }
  if (repositories !== undefined) {
    if (!isObject(repositories)) return fail(`"repositories" must be an object keyed by the full path of each repository.`);
    for (const [repo, value] of Object.entries(repositories)) {
      if (!path.isAbsolute(repo)) fail(`"repositories" has the key "${repo}", which is not a full path starting with /.`);
      if (!isObject(value)) return fail(`repository "${repo}" must be an object.`);
      for (const [setting, list] of Object.entries(value)) {
        if (!(REPOSITORY_SETTINGS as readonly string[]).includes(setting)) fail(`repository "${repo}" has unknown setting "${setting}". Known settings: ${REPOSITORY_SETTINGS.join(", ")}.`);
        if (setting === "allowedHosts") {
          if (!Array.isArray(list)) return fail(`repository "${repo}": "${setting}" must be a list of host names, such as ["registry.npmjs.org"].`);
          const bad = (list as unknown[]).find((host) => hostProblem(host) !== null);
          if (bad !== undefined) fail(`repository "${repo}": "${setting}" holds ${JSON.stringify(bad)}, which cannot be used. ${HOST_RULE}`);
          continue;
        }
        if (setting === "protectedPaths") {
          const problem = protectedPathsProblem(list);
          if (problem !== null) fail(`repository "${repo}": "protectedPaths" ${problem}`);
          continue;
        }
        if (setting === "remote") {
          const problem = remoteNameProblem(list);
          if (problem !== null) fail(`repository "${repo}": "remote" must be the name of one of the repository's remotes. ${problem}`);
          continue;
        }
        if (setting === "baseBranch") {
          if (typeof list !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(list) || list.includes("..") || list.endsWith("/") || list.startsWith(BRANCH_PREFIX)) fail(`repository "${repo}": "baseBranch" must be a branch name such as "main", and not one of Botbench's own (${BRANCH_PREFIX}…).`);
          continue;
        }
        if (setting === "claimIssues") {
          if (typeof list !== "boolean") fail(`repository "${repo}": "claimIssues" must be true or false: whether a run started from an issue, set to open pull requests, first pushes a claim that tells other workbenches you started on it.`);
          continue;
        }
        if (setting === "execution") {
          const problem = executionProblem(list, value.allowedHosts);
          if (problem !== null) fail(`repository "${repo}": ${problem}`);
          continue;
        }
        if (setting === "watch") {
          const problem = watchProblem(list);
          if (problem !== null) fail(`repository "${repo}": ${problem}`);
          continue;
        }
        if (setting === "machineChecks") {
          const problem = machineChecksProblem(list);
          if (problem !== null) fail(`repository "${repo}": "machineChecks" ${problem}`);
          continue;
        }
        if (setting === "preapproved") {
          if (!Array.isArray(list) || !list.every((command) => typeof command === "string")) return fail(`repository "${repo}": "${setting}" must be a list of commands.`);
          const problem = list.map(entryProblem).find((p) => p !== null);
          if (problem) fail(`repository "${repo}": "${setting}" holds a command that cannot be used. ${problem}`);
          continue;
        }
        // Setup and check commands are run by Botbench itself, through a shell, so they are not held to one plain command.
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
    if (autonomy.mode !== undefined && !isRunMode(autonomy.mode)) fail(`"autonomy.mode" must be "manual", "semi" or "full": the mode a new run is given when none is chosen.`);
    const rounds = autonomy.maxRefineRounds;
    if (rounds !== undefined && !(typeof rounds === "number" && Number.isSafeInteger(rounds) && rounds >= 0 && rounds <= MAX_REFINE_ROUNDS)) fail(`"autonomy.maxRefineRounds" must be a whole number from 0 to ${MAX_REFINE_ROUNDS}: how many rounds of fixes the builder may be asked for after a review with concerns.`);
    const fixes = autonomy.maxCheckFixRounds;
    if (fixes !== undefined && !(typeof fixes === "number" && Number.isSafeInteger(fixes) && fixes >= 0 && fixes <= MAX_CHECK_FIX_ROUNDS)) fail(`"autonomy.maxCheckFixRounds" must be a whole number from 0 to ${MAX_CHECK_FIX_ROUNDS}: how many rounds of fixes the builder gets when a check fails on its work.`);
    const silence = autonomy.silenceLimitSeconds;
    if (silence !== undefined && !(typeof silence === "number" && Number.isSafeInteger(silence) && silence >= 0 && silence <= MAX_SILENCE_LIMIT_SECONDS)) fail(`"autonomy.silenceLimitSeconds" must be a whole number of seconds from 0 to ${MAX_SILENCE_LIMIT_SECONDS}: how long a builder or planner may send nothing while it works before Botbench stops it. 0 turns the limit off.`);
    const wait = autonomy.usageLimitWaitSeconds;
    if (wait !== undefined && !(typeof wait === "number" && Number.isSafeInteger(wait) && wait >= 1 && wait <= MAX_USAGE_LIMIT_WAIT_SECONDS)) fail(`"autonomy.usageLimitWaitSeconds" must be a whole number of seconds from 1 to ${MAX_USAGE_LIMIT_WAIT_SECONDS}: how long Botbench waits before it tries a builder again once its usage limit was reached, when the agent gives no time it resets.`);
  }
  return c as unknown as Config;
}

const REPOSITORY_SETTINGS = ["preapproved", "setup", "checks", "machineChecks", "allowedHosts", "execution", "remote", "baseBranch", "protectedPaths", "claimIssues", "watch"] as const;

/** What is wrong with a repository's "watch", as a sentence that names the setting, or null. */
function watchProblem(watch: unknown): string | null {
  if (!isObject(watch)) return `"watch" must be an object with a "label", such as { "label": "botbench", "intervalMinutes": ${WATCH_INTERVAL_MINUTES} }: the label that makes an open issue a proposed run on Work, and how many minutes apart Botbench looks.`;
  const unknown = Object.keys(watch).find((key) => !(WATCH_SETTINGS as readonly string[]).includes(key));
  if (unknown !== undefined) return `"watch" has unknown setting "${unknown}". Known settings: ${WATCH_SETTINGS.join(", ")}.`;
  if (typeof watch.label !== "string" || watch.label === "") return `"watch" needs a "label": the name of the label that makes an open issue a proposed run on Work. ${labelProblem(undefined)}`;
  const label = labelProblem(watch.label);
  if (label !== null) return `"watch.label" ${label}`;
  const minutes = watch.intervalMinutes;
  if (minutes !== undefined && !(typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= MAX_WATCH_INTERVAL_MINUTES)) return `"watch.intervalMinutes" must be a whole number of minutes from 1 to ${MAX_WATCH_INTERVAL_MINUTES}: how long Botbench waits between two looks at the repository's labelled issues. ${WATCH_INTERVAL_MINUTES} when left out.`;
  return null;
}

/** A repository's watch with its interval filled in, or null when it is not watched. */
export function repositoryWatch(config: Config, repo: string): Required<WatchConfig> | null {
  const watch = repositorySettings(config, repo).watch;
  return watch === undefined ? null : { label: watch.label, intervalMinutes: watch.intervalMinutes ?? WATCH_INTERVAL_MINUTES };
}

/** Every watched repository, by the path its settings are keyed by, in the settings file's order. */
export function watchedRepositories(config: Config): ({ path: string } & Required<WatchConfig>)[] {
  return Object.entries(config.repositories ?? {}).flatMap(([repo, settings]) => (settings.watch === undefined ? [] : [{ path: repo, label: settings.watch.label, intervalMinutes: settings.watch.intervalMinutes ?? WATCH_INTERVAL_MINUTES }]));
}

const PROTECTED_RULE = 'must be a list of paths inside the repository, such as ["test/recordings/", "package-lock.json"]: relative to its top folder, without "..", "*" or a leading "/".';

/** What is wrong with a list of protected paths, as the end of a sentence about the setting, or null. */
function protectedPathsProblem(list: unknown): string | null {
  if (!Array.isArray(list)) return PROTECTED_RULE;
  for (const entry of list as unknown[]) {
    if (typeof entry !== "string") return `holds ${JSON.stringify(entry)}, which is not text. It ${PROTECTED_RULE}`;
    const parts = entry.replace(/\/+$/, "").split("/");
    // Globs are not matched: a path with "*" would protect nothing while reading as if it did.
    const bad = entry.length > 1000 || entry.startsWith("/") || entry.includes("\\") || /[\0-\x1f\x7f*?[\]]/.test(entry) || parts.some((part) => part === "" || part === "." || part === "..");
    if (bad) return `holds ${JSON.stringify(entry)}, which cannot be used. It ${PROTECTED_RULE}`;
  }
  return null;
}

/** The paths only the owner may accept a change to in a repository: the top-level list and the repository's own. */
export function repositoryProtectedPaths(config: Config, repo: string): string[] {
  return [...new Set([...(config.protectedPaths ?? []), ...(repositorySettings(config, repo).protectedPaths ?? [])])];
}

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

/** The commands Botbench runs itself in a repository's worktrees, each with its time limit. */
export function repositoryCommands(config: Config, repo: string): { setup: StationCommand[]; checks: StationCommand[]; machineChecks: MachineCheck[] } {
  const settings = repositorySettings(config, repo);
  return {
    setup: (settings.setup ?? []).map(asCommand),
    checks: (settings.checks ?? []).map(asCommand),
    machineChecks: (settings.machineChecks ?? []).map((entry) => ({ ...asCommand(entry), machine: { needs: [...entry.needs], files: [...(entry.files ?? [])] } })),
  };
}

/** The host names a repository's commands may reach; none when its settings name none. */
export function repositoryHosts(config: Config, repo: string): string[] {
  return [...(repositorySettings(config, repo).allowedHosts ?? [])];
}

/** Where a repository's commands run: its settings' "execution", or on this Mac when they name none. */
export function repositoryExecution(config: Config, repo: string): Execution {
  return repositorySettings(config, repo).execution ?? HOST_EXECUTION;
}

/** Where an accepted task of a repository is pushed for a pull request: the remote, and the base branch when the settings name one. */
export function repositoryDelivery(config: Config, repo: string): { remote: string; baseBranch: string | null } {
  const settings = repositorySettings(config, repo);
  return { remote: settings.remote ?? "origin", baseBranch: settings.baseBranch ?? null };
}

/** Whether a run started from an issue of a repository, set to open pull requests, claims it on its remote. Off unless its settings say true. */
export function repositoryClaims(config: Config, repo: string): boolean {
  return repositorySettings(config, repo).claimIssues === true;
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
  checkFile(merged, files.defaults);
  let where = files.defaults;
  if (files.local && fs.existsSync(files.local)) {
    const local = readJson(files.local);
    checkFile(local, files.local);
    merged = merge(merged, local);
    where = `${files.defaults} with ${files.local}`;
  }
  return validate(merged, where);
}

