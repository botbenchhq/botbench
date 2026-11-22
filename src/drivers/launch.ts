import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * The only variables a CLI child may inherit. Everything else in Botbench's own
 * environment stays behind, so a key exported in the owner's shell cannot turn
 * a subscription session into metered API use.
 */
const ALLOWED_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
  // Where a CLI keeps its own login and settings when the owner moved them.
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  // Reaching the provider from behind a proxy.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);
const ALLOWED_ENV_PREFIXES = ["LC_"];

/** Provider credentials by name. They are never passed on, wherever they come from. */
const KEY_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);
const KEY_ENV_PATTERN = /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_ACCESS_TOKEN|_SECRET_KEY)$/i;

const isKeyVariable = (name: string): boolean => KEY_ENV.has(name.toUpperCase()) || KEY_ENV_PATTERN.test(name);
const isAllowed = (name: string): boolean => ALLOWED_ENV.has(name) || ALLOWED_ENV_PREFIXES.some((p) => name.startsWith(p));

/**
 * The environment for a CLI child: the allowlisted variables of `parent`, plus
 * `extra` (settings Botbench chooses itself), minus anything that names a provider
 * credential. `extra` cannot bring a credential back in.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && isAllowed(name) && !isKeyVariable(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!isKeyVariable(name)) env[name] = value;
  }
  return env;
}

export type CliChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface LaunchOptions {
  /** The child's working directory. */
  cwd: string;
  /** Variables Botbench sets for the child on top of the allowlisted ones. */
  extraEnv?: Record<string, string>;
}

export interface Launched {
  child: CliChild;
  /** The child's process group. The child leads it, so the id is the child's pid. 0 if the child could not be started. */
  pgid: number;
}

/**
 * Start a CLI child in its own process group, with piped stdio and the
 * environment from `buildChildEnv`. There is deliberately no way to hand in a
 * whole environment. A command that cannot be started reports through the
 * child's `error` event.
 */
export function launch(command: string, args: readonly string[], options: LaunchOptions): Launched {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: buildChildEnv(process.env, options.extraEnv),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, pgid: child.pid ?? 0 };
}

/** Whether any process is left in the group. */
export function processGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM: the group exists but belongs to someone else. Only ESRCH means gone.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

async function waitUntilGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (processGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/**
 * Stop every process in the group: ask first, then force after `graceMs`.
 * Resolves once the group is empty and throws if it is still there after the
 * forced kill. A group that is already gone is fine.
 */
export async function killProcessGroup(pgid: number, options: { graceMs?: number } = {}): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`Refusing to signal process group ${pgid}.`);
  if (!processGroupAlive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  if (await waitUntilGone(pgid, options.graceMs ?? 2000)) return;
  signalGroup(pgid, "SIGKILL");
  if (!(await waitUntilGone(pgid, 5000))) throw new Error(`Process group ${pgid} is still running after SIGKILL.`);
}

export interface CliRun {
  /** False when the command could not be started at all, for example because it is not installed. */
  started: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a short CLI command (a version or status query) to its end through
 * `launch` and collect what it printed. The group is killed if it takes longer
 * than `timeoutMs`. `stdin` is written to the command before its input is closed.
 */
export function runCli(command: string, args: readonly string[], options: LaunchOptions & { timeoutMs?: number; stdin?: string }): Promise<CliRun> {
  return new Promise((resolve) => {
    const { child, pgid } = launch(command, args, options);
    let stdout = "";
    let stderr = "";
    let started = true;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin);
    const timer = setTimeout(() => {
      if (pgid) void killProcessGroup(pgid, { graceMs: 500 }).catch(() => {});
    }, options.timeoutMs ?? 15000);
    child.on("error", () => (started = false));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ started, exitCode, stdout, stderr });
    });
  });
}

/** A flag Botbench passes to a CLI, and the oldest version of that CLI known to accept it. */
export interface RequiredFlag {
  flag: string;
  since: string;
}

/**
 * Which flags each CLI needs from Botbench, per CLI. `since` is the oldest version
 * Botbench has been run against and seen accept the flag, not the vendor's release
 * note: lower it only after driving that older version for real.
 */
export const VERSION_TABLE = {
  "claude-code": [
    { flag: "--input-format", since: "2.1.322" },
    { flag: "--output-format", since: "2.1.322" },
    { flag: "--setting-sources", since: "2.1.322" },
    { flag: "--strict-mcp-config", since: "2.1.322" },
    { flag: "--mcp-config", since: "2.1.322" },
    { flag: "--permission-prompts", since: "2.1.322" },
    { flag: "--allowedTools", since: "2.1.322" },
    { flag: "--tools", since: "2.1.322" },
    { flag: "--disallowedTools", since: "2.1.322" },
    { flag: "--settings", since: "2.1.322" },
    { flag: "--permission-prompt-tool", since: "2.1.322" },
    { flag: "--append-system-prompt-file", since: "2.1.322" },
    { flag: "--resume", since: "2.1.322" },
    { flag: "--model", since: "2.1.322" },
  ],
  // Checked against `codex exec --help` and real runs of 0.171.0 (src/drivers/codex.ts says what each is for).
  codex: [
    { flag: "exec --json", since: "0.171.0" },
    { flag: "--ephemeral", since: "0.171.0" },
    { flag: "--ignore-user-config", since: "0.171.0" },
    { flag: "--ignore-rules", since: "0.171.0" },
    { flag: "--disable", since: "0.171.0" },
    { flag: "-c default_permissions", since: "0.171.0" },
    { flag: "--model", since: "0.171.0" },
  ],
} as const satisfies Record<string, readonly RequiredFlag[]>;

export type CliName = keyof typeof VERSION_TABLE;

export interface VersionCheck {
  supported: boolean;
  /** The dotted version found in the string, or null when there is none. */
  version: string | null;
  /** Required flags this version is not known to accept. */
  missingFlags: string[];
}

function parseVersion(text: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function olderThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/** Decide from what `<cli> --version` printed whether Botbench can drive that version. Pure: starts nothing. */
export function checkVersion(versionString: string, cli: CliName = "claude-code"): VersionCheck {
  const version = parseVersion(versionString);
  if (!version) return { supported: false, version: null, missingFlags: [] };
  const missingFlags = VERSION_TABLE[cli].filter((f) => olderThan(version, parseVersion(f.since)!)).map((f) => f.flag);
  return { supported: missingFlags.length === 0, version: version.join("."), missingFlags };
}
