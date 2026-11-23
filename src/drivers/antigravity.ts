import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bothPaths, confinementProblem, SANDBOX_EXEC, unreadablePaths } from "../confinement.ts";
import { startAcpTurn, type AcpDecision, type AcpToolRequest } from "./acp-turn.ts";
import { acpReader } from "./acp-turn.ts";
import { KEYCHAIN_DENIED, makeReviewFolder, proxyEnv, sandboxed, startProviderProxy, toolsProfile, wholeCliProfile } from "./cli-sandbox.ts";
import { DriverUnavailableError, modelNameProblem, type Driver, type DriverCapabilities, type DriverModels, type DriverProbe, type DriverSession, type ModelChoice, type StartAttemptOptions } from "./contract.ts";
import { checkVersion, runCli } from "./launch.ts";
import { NO_BROWSER, parseAntigravitySignIn, pastedAntigravityCode, type SignInDefinition } from "./sign-in.ts";

/*
 * Antigravity (`agy`, Google's successor to the Gemini CLI), driven through its own ACP server (`agy acp`) one turn at
 * a time, with its own tools, for a chat message (src/api/chat.ts) and a review (src/engine/review.ts). Approach from
 * OpenMausBot server/drivers/antigravity-acp.ts: a Google profile of Botbench's own with its own sign-in, no MCP
 * servers, and each session/request_permission answered by Botbench. What it gets, measured on this Mac on 2026-11-23
 * with Antigravity 1.5.14 (threat model, B21):
 * - The whole process runs under Botbench's sandbox for an agent with tools (agyToolsProfile): it reads and changes
 *   only its working folder (the chat's folder; in a review the task's copy, read-only), reads an attached repository
 *   without changing it, reaches Google only through Botbench's proxy, and uses no Keychain.
 * - Its profile, the sign-in in it among the rest, is open to Antigravity's own program alone (ownProgramOnly in
 *   src/drivers/cli-sandbox.ts): a command it runs cannot read it, list it, reach a socket there or start Antigravity
 *   again to read it. Antigravity's own file tool refuses its sign-in folder by itself, and Botbench refuses any
 *   request into its data folder.
 * - Its tools are those of Botbench's agent definition, written to the profile before each turn (`--agent`): files,
 *   commands and its command list, and Google's web search when the owner's Web access is Allow; the tools that
 *   outlive a turn (schedule) and its subagents are not given. A call of any other tool stops the turn.
 * - Each permission request is answered by Botbench's rules (agyDecide): a request into Botbench's data folder is
 *   refused, a read of an attached repository is allowed, and the rest goes through Botbench's permission check as a
 *   request of a chat or a review, where a confined command the floor does not name and a file inside the folder never
 *   ask, and an action outside asks you (refused in a fully autonomous run). Without the check, it is refused.
 * - No MCP server: session/new names none, and no file that would start one or a hook can be read (AGY_CONFIG_DENIED).
 */

const COMMAND = "agy";
const SANDBOX_EXEC_COMMAND = SANDBOX_EXEC;
export const ANTIGRAVITY = "antigravity";

/**
 * Antigravity here does one turn with its own tools, inside Botbench's sandbox for the whole process, and asks
 * Botbench before what its rules leave to the owner. It cannot resume and never edits a task's copy. It can be stopped.
 */
export const ANTIGRAVITY_CAPABILITIES: DriverCapabilities = { resume: false, interrupt: true, permissionRequests: true, edits: false, confinedCommands: true, chatTools: true };

export const AGY_EXTRA_ENV: Record<string, string> = {
  AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  // The home folder is unreadable to its commands, and git stops at an unreadable ~/.gitconfig, as for Codex and Grok.
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** The tools Antigravity keeps in a chat: its file tools, commands and its own command list. */
export const AGY_CHAT_TOOLS: readonly string[] = ["read_file", "write_file", "edit_file", "run_command", "manage_task"];
/** The tools it keeps in a review: the same less the two that write files, which the sandbox would refuse anyway. */
export const AGY_REVIEW_TOOLS: readonly string[] = AGY_CHAT_TOOLS.filter((tool) => tool !== "write_file" && tool !== "edit_file");
/** Google's web search, which Google runs on its own servers, and which Antigravity runs without asking. */
export const AGY_WEB_TOOLS: readonly string[] = ["search_web"];

/** The tools of one turn. */
export const agyTools = (o: { mode: "chat" | "review"; webSearch?: boolean }): string[] => [...(o.mode === "chat" ? AGY_CHAT_TOOLS : AGY_REVIEW_TOOLS), ...(o.webSearch === true ? AGY_WEB_TOOLS : [])];

/** Botbench's agent for a turn, by its tools: the name `--agent` is given. */
export const agentName = (tools: readonly string[]): string => `botbench-${tools.includes("write_file") ? "chat" : "review"}${tools.includes("search_web") ? "-web" : ""}`;

/** Botbench's agent definition with exactly `tools` (Antigravity's agent format, as its `tools: []` measured in #127). */
export function agentDefinition(tools: readonly string[]): string {
  return [
    "---",
    `name: ${agentName(tools)}`,
    "description: Botbench's agent for one chat message or one review, with only the tools Botbench gives it.",
    `tools: [${tools.join(", ")}]`,
    "mainAgent: true",
    "subagent: false",
    "mcpServers: []",
    "skills: []",
    "---",
    "Do what the message asks, with your tools where they help, and reply in text.",
    "",
  ].join("\n");
}

/** Write the agent definition for `tools` into the profile, where Antigravity finds its own agents, and return its name. */
export function writeAgent(profile: string, tools: readonly string[]): string {
  const dir = path.join(profileGeminiDir(profile), "config", "agents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = agentName(tools);
  const file = path.join(dir, `${name}.md`);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, agentDefinition(tools), { mode: 0o600 });
  fs.renameSync(temp, file);
  return name;
}

/*
 * Botbench's own Antigravity profile (approach from OpenMausBot server/drivers/antigravity-acp.ts: one isolated Google
 * profile, its sign-in a file in that profile and never the Keychain). `agy` 1.5.14 does not read OpenMausBot's
 * GEMINI_HOME or AGY_ACP_FORCE_FILE_STORAGE (neither name is in its program), so the same is done another way, measured
 * on this Mac on 2026-11-23:
 * - `agy acp --gemini-dir <folder>` keeps everything it would keep in ~/.gemini in that folder instead; a sign-in there
 *   touched nothing in the owner's ~/.gemini.
 * - The Keychain is refused to the whole process (KEYCHAIN_DENIED in src/drivers/cli-sandbox.ts, and its files are on
 *   the shared list): `agy` then reads none of the owner's sign-in from it, and writes the new one to a file of its
 *   own in the profile (its "secrets file", used when the Keychain cannot be written). The owner's Antigravity in a
 *   terminal or the app, signed in through the Keychain, is not changed.
 * - The profile lies in Botbench's data folder, which no agent's command can read (src/confinement.ts).
 */

/** Botbench's Antigravity profile in `dataDir`. */
export const antigravityProfile = (dataDir: string): string => path.join(dataDir, "antigravity");
/** Where `agy` keeps, for that profile, what it would otherwise keep in ~/.gemini. */
export const profileGeminiDir = (profile: string): string => path.join(profile, ".gemini");

/** The sign-in file `agy` writes in the profile, relative to it: its existence is the sign-in. Botbench never reads it. */
export const SIGN_IN_FILES: readonly string[] = [".gemini/antigravity-cli/antigravity-oauth-token"];

/** Make the profile, owner-only, and return its real path. A profile that is a link, or not a folder, is refused. */
export function prepareProfile(dataDir: string): string {
  const profile = antigravityProfile(dataDir);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(profile);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Botbench's Antigravity profile is not a folder: ${profile}. Remove it and connect Antigravity again.`);
  fs.chmodSync(profile, 0o700);
  return fs.realpathSync(profile);
}

/** Whether the profile holds a sign-in: its file exists and is not empty. Only its size is looked at, never its content. */
export function profileSignedIn(profile: string): boolean {
  return SIGN_IN_FILES.some((name) => {
    const info = fs.lstatSync(path.join(profile, name), { throwIfNoEntry: false });
    return info !== undefined && info.isFile() && info.size > 0;
  });
}

/** Sign out: the profile's sign-in file is removed, unread. */
export function removeProfileSignIn(profile: string): void {
  for (const name of SIGN_IN_FILES) fs.rmSync(path.join(profile, name), { force: true });
}

/**
 * The sandbox profile of a sign-in: no Keychain, nothing of the shared list or of Botbench's data folder readable but
 * the profile, nothing written but the profile and the temporary folder.
 */
export function signInSandbox(o: { dataDir: string; profile: string; home?: string }): string {
  const home = o.home ?? os.homedir();
  return wholeCliProfile({ unreadable: unreadablePaths({ dataDir: o.dataDir, home }), readable: [o.profile], writable: [o.profile], noKeychain: true });
}

/**
 * Antigravity's own Google sign-in for Botbench's profile: `agy acp --login`, which prints Google's page and waits for
 * the code, or the address of the page Google lands on, pasted back. Seen on 1.5.14 with an empty profile, stdin and
 * stdout pipes: "Open this link in a browser to log in with Google:", an accounts.google.com link whose redirect is
 * https://antigravity.google/oauth-callback, then "Then paste the authorization code, or the full URL of the page you
 * land on, and press Enter:"; a wrong code ends it with exit 1 and "couldn't log in: token exchange failed: …". It opens
 * no browser with BROWSER set to a command that does nothing. Output with the secret parts replaced:
 * test/recordings/sign-in/antigravity-1.5.14.json.
 */
export function antigravitySignIn(dataDir: string, home?: string): SignInDefinition {
  const profile = path.join(dataDir, "antigravity");
  return {
    driver: ANTIGRAVITY,
    product: "Antigravity",
    kind: "link",
    command: SANDBOX_EXEC_COMMAND,
    get args(): readonly string[] {
      // Made when the sign-in starts, so the profile exists with its modes before the CLI runs.
      const real = prepareProfile(dataDir);
      return ["-p", signInSandbox({ dataDir, profile: real, ...(home ? { home } : {}) }), COMMAND, "acp", "--login", "--gemini-dir", profileGeminiDir(real)];
    },
    terminalCommand: "agy acp --login",
    signOutArgs: [],
    signOutCommand: "",
    env: { BROWSER: NO_BROWSER, ...AGY_EXTRA_ENV },
    keptByBotbench: true,
    removeSignIn: () => removeProfileSignIn(profile),
    takesCode: true,
    limitMs: 15 * 60_000,
    parse: parseAntigravitySignIn,
    pasted: pastedAntigravityCode,
  };
}

/**
 * The program `agy` runs: Homebrew installs `agy` as a script that starts it (`exec "<path>/antigravity" "$@"`). A rule
 * of the turn's sandbox names it (ownProgramOnly in src/drivers/cli-sandbox.ts), so it is found by what the file is:
 * a Mach-O program, or a script whose one `exec` line names one. Null when there is none.
 */
export function agyProgram(env: NodeJS.ProcessEnv = process.env): string | null {
  const machO = (file: string): boolean => {
    try {
      const fd = fs.openSync(file, "r");
      try {
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        return ["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(head.toString("hex"));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  };
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    let file: string;
    try {
      file = fs.realpathSync(path.join(dir, COMMAND));
    } catch {
      continue;
    }
    if (machO(file)) return file;
    let script: string;
    try {
      script = fs.readFileSync(file, "utf8").slice(0, 4096);
    } catch {
      continue;
    }
    const named = [...script.matchAll(/^\s*(?:[A-Z_]+=\S+\s+)*exec\s+"([^"]+)"/gm)].map((m) => m[1]!);
    if (named.length === 1 && path.isAbsolute(named[0]!)) {
      const real = fs.realpathSync(named[0]!);
      if (machO(real)) return real;
    }
    return null;
  }
  return null;
}

/**
 * Files that would start MCP servers or hooks, from a repository (`.agents/`, and the other spellings Antigravity
 * reads) or from the profile: none can be read by the turn, so none is loaded. Measured on 1.5.14: `agy acp` started
 * the MCP server of `.agents/mcp_config.json` in its working folder and in an added folder, with no trust asked.
 */
export const AGY_CONFIG_DENIED = (() => {
  // Any case: on a volume that ignores case, `.AGENTS/MCP_CONFIG.JSON` is the same file.
  const anyCase = (word: string): string => [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c === "." ? "\\." : c)).join("");
  const file = `(${anyCase("mcp_config")}|${anyCase("hooks")})${anyCase(".json")}$`;
  return `(deny file-read* (regex #"/[._]${anyCase("agent")}[sS]?/${file}") (regex #"/\\.${anyCase("gemini")}/(${anyCase("config")}|${anyCase("antigravity-cli")})/${file}"))`;
})();

/** The spellings of the folder in which Antigravity looks for a workspace's agents, MCP servers and hooks. */
const AGENT_FOLDERS = [".agents", "_agents", ".agent", "_agent"];

/**
 * Why a turn must not start in these folders: a link where Antigravity reads its MCP servers or hooks. The sandbox
 * decides by the path a file really has, so a link (`.agents -> elsewhere`, or `.agents/mcp_config.json -> x.json`)
 * would let one be read under another name and start a program nobody was asked about. Null when there is none.
 */
export function plantedConfigProblem(folders: readonly string[]): string | null {
  for (const folder of folders) {
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => AGENT_FOLDERS.includes(n.toLowerCase()))) {
      const at = path.join(folder, name);
      const info = fs.lstatSync(at);
      if (info.isSymbolicLink()) return `${at} is a link, which could make Antigravity start a program of its own choosing. Remove it, then ask again.`;
      if (!info.isDirectory()) continue;
      for (const inner of fs.readdirSync(at)) {
        if (!["mcp_config.json", "hooks.json"].includes(inner.toLowerCase())) continue;
        if (fs.lstatSync(path.join(at, inner)).isSymbolicLink()) return `${path.join(at, inner)} is a link, which could make Antigravity start a program of its own choosing. Remove it, then ask again.`;
      }
    }
  }
  return null;
}

/**
 * Antigravity starts its own language server and talks to it over this Mac's loopback address (seen on 1.5.14:
 * "listen tcp 127.0.0.1:0: bind: operation not permitted" without these rules). Only Antigravity's own program may
 * listen there or connect there; a command it runs still reaches nothing but Botbench's proxy.
 */
export const agyLoopback = (program: string): string[] => {
  const own = `(process-path ${quotedPath(program)})`;
  return [`(allow network-bind network-inbound (require-all (local ip "localhost:*") ${own}))`, `(allow network-outbound (require-all (remote ip "localhost:*") ${own}))`];
};

/** A path as a string of the sandbox profile language; one that could break out of the string is refused. */
const quotedPath = (place: string): string => {
  if (/[\0-\x1f"\\]/.test(place)) throw new Error(`Botbench cannot confine Antigravity with the path ${JSON.stringify(place)}: it holds a quote, a backslash or a control character.`);
  return `"${place}"`;
};

/**
 * Antigravity runs each command in a terminal of its own (seen on 1.5.14: "failed to create PTY: operation not
 * permitted" without this). Only its own program may open a terminal device: a command uses the one it was given, and
 * can open none of the owner's other terminals.
 */
export const agyTerminal = (program: string): string => `(allow file-read* file-write* file-ioctl (require-all (require-any (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$")) (process-path ${quotedPath(program)})))`;

/** Where Antigravity reaches Google: its sign-in, its model and its search, as its program names them. */
export const AGY_PROVIDER: readonly string[] = ["googleapis.com", "google.com"];

/**
 * The sandbox profile for the whole Antigravity process of one turn with its tools (toolsProfile): it works in
 * `folder`, reads `readOnly` and never changes it, reaches Google only through Botbench's proxy on `proxyPort`, and
 * uses the Keychain not at all. Its profile is its own: only `program`, Antigravity itself, may read or write it, so
 * a command it runs cannot read the sign-in there (ownProgramOnly).
 */
export function agyToolsProfile(o: { dataDir: string; profile: string; folder: string; readOnly: readonly string[]; temp: string; proxyPort: number; program: string; home?: string; env?: NodeJS.ProcessEnv }): string {
  const home = o.home ?? os.homedir();
  const unreadable = unreadablePaths({ dataDir: o.dataDir, home, ...(o.env ? { env: o.env } : {}) });
  const data = new Set(bothPaths(o.dataDir));
  return toolsProfile({ home, unreadable, secrets: unreadable.filter((place) => !data.has(place)), own: [o.profile], folder: o.folder, readOnly: o.readOnly, temp: o.temp, proxyPort: o.proxyPort, ownProgram: o.program, extra: [KEYCHAIN_DENIED, AGY_CONFIG_DENIED, agyTerminal(o.program), ...agyLoopback(o.program)] });
}

/** The models session/new lists in `availableModels`, in its order. Null when it lists none. */
export function parseAcpModels(session: unknown): ModelChoice[] | null {
  const models = isObject(session) && isObject(session.models) && Array.isArray(session.models.availableModels) ? session.models.availableModels : [];
  const list: ModelChoice[] = [];
  for (const m of models) {
    if (!isObject(m) || typeof m.modelId !== "string" || modelNameProblem(m.modelId) !== null) continue;
    list.push({ id: m.modelId, ...(typeof m.name === "string" ? { label: m.name.slice(0, 80) } : {}) });
  }
  return list.length > 0 ? list : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const inside = (place: string, folders: readonly string[]): boolean => folders.some((folder) => place === folder || place.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`));

/**
 * `place`, every link resolved, a link whose target does not exist yet among them (a write through it would make the
 * target); for a path that does not exist yet, its nearest existing folder's real path and the rest.
 */
export function resolvedPath(place: string, cwd: string, depth = 0): string {
  const at = path.resolve(cwd, place);
  if (depth > 40) return at;
  try {
    return fs.realpathSync(at);
  } catch {
    const info = fs.lstatSync(at, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) return resolvedPath(fs.readlinkSync(at), path.dirname(resolvedPath(path.dirname(at), "/", depth + 1)), depth + 1);
    const parent = path.dirname(at);
    return parent === at ? at : path.join(resolvedPath(parent, "/", depth + 1), path.basename(at));
  }
}

/** The input of a request as the broker reads a tool's: one path, or one command. */
const commandOf = (raw: unknown): string => (isObject(raw) && typeof raw.CommandLine === "string" ? raw.CommandLine : isObject(raw) && typeof raw.command === "string" ? raw.command : JSON.stringify(raw ?? null));

/**
 * Botbench's answer to one of Antigravity's permission requests (see the comment at the top). `folder` is where it
 * works, changed only when `writable`; `readable` what it may read and never change; `dataDir` Botbench's data folder;
 * all real paths. Reading in those places, and changing a file in a writable folder, never asks. A command goes to
 * Botbench's permission check, which lets a confined command run that the floor does not name; so does anything
 * outside, which asks the owner there.
 */
export function agyDecide(request: AcpToolRequest, o: { folder: string; writable: boolean; readable: readonly string[]; dataDir: string; profile?: string; kept: readonly string[] }): AcpDecision {
  if (!o.kept.includes(request.name)) return { answer: "deny", why: `Botbench did not give Antigravity the tool ${request.name}.` };
  const paths = request.paths.map((place) => resolvedPath(place, o.folder));
  const open = [o.folder, ...o.readable];
  // Botbench's data folder holds the sign-in Antigravity uses and every other agent's work: only the working folder and the read-only places in it may be named.
  if (paths.some((place) => (inside(place, [o.dataDir]) && !inside(place, open)) || (o.profile !== undefined && inside(place, [o.profile])))) return { answer: "deny", why: "It names a place in Botbench's own data folder, which no agent may use." };
  if (request.kind === "execute") return { ask: { name: "Bash", input: { command: commandOf(request.rawInput) } } };
  if (paths.length === 0) return { ask: { name: request.name, input: isObject(request.rawInput) ? request.rawInput : {} } };
  if (request.kind === "read" || request.kind === "search") {
    const outside = paths.find((place) => !inside(place, open));
    if (outside === undefined) return { answer: "allow", rule: "files" };
    // The place outside is the one put to the check, so the check does not judge the request by a place inside.
    return { ask: { name: "Read", input: { file_path: outside } } };
  }
  const readOnly = o.writable ? o.readable : open;
  if (paths.some((place) => inside(place, readOnly))) return { answer: "deny", why: "It would change a place Antigravity may only read here." };
  const outside = o.writable ? paths.find((place) => !inside(place, [o.folder])) : paths[0];
  if (outside === undefined) return { answer: "allow", rule: "files" };
  return { ask: { name: request.kind === "edit" ? "Edit" : request.name, input: { file_path: outside } } };
}

export interface AntigravityDriverOptions {
  /** Botbench's data folder, where its Antigravity profile is kept. */
  dataDir: string;
  /** The owner's configured list of models, offered when Antigravity reports none. */
  models?: readonly string[];
  /** The configured model, preselected for the owner. Antigravity's own default when absent. */
  defaultModel?: string;
  /** The home folder whose secret places the sandbox keeps from Antigravity; the owner's when left out (tests use a fake one). */
  home?: string;
  /** Each line Antigravity prints, as printed: for test/support/capture-antigravity.ts only. */
  onLine?(line: string): void;
}

const PROBE_TIMEOUT_MS = 15_000;
const MODELS_FRESH_MS = 60_000;

export class AntigravityDriver implements Driver {
  readonly name = ANTIGRAVITY;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  readonly signIn: SignInDefinition;
  private readonly dataDir: string;
  private readonly home: string | undefined;
  private readonly onLine: ((line: string) => void) | undefined;
  private readonly configured: { models: readonly string[]; defaultModel: string | null };
  private listing: { at: number; answer: Promise<DriverModels> } | null = null;

  constructor(options: AntigravityDriverOptions) {
    this.dataDir = options.dataDir;
    this.home = options.home;
    this.onLine = options.onLine;
    this.configured = { models: options.models ?? [], defaultModel: options.defaultModel ?? null };
    this.signIn = antigravitySignIn(options.dataDir, options.home);
  }

  /** `agy --version`, and whether Botbench's profile holds a sign-in: its file exists. Nothing of it is read. */
  async probe(): Promise<DriverProbe> {
    const version = await runCli(COMMAND, ["--version"], { cwd: os.tmpdir(), extraEnv: AGY_EXTRA_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    if (!version.started) return { installed: false, version: null, supported: false, signedIn: false, billing: "unknown", problem: "Antigravity is not installed, or `agy` is not on the PATH." };
    const check = checkVersion(version.stdout, "antigravity");
    if (!check.supported) {
      const problem = check.version ? `Antigravity ${check.version} is too old for Botbench, which has been run only with 1.5.14 and later. Update Antigravity.` : "Antigravity did not report a version Botbench can read.";
      return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem };
    }
    const unconfined = confinementProblem();
    if (unconfined !== null) return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem: unconfined };
    if (agyProgram() === null) return { installed: true, version: check.version, supported: false, signedIn: false, billing: "unknown", problem: "Botbench could not find the program `agy` starts, which its sandbox must name. Reinstall Antigravity." };
    const signedIn = profileSignedIn(antigravityProfile(this.dataDir));
    // A personal Google sign-in, as `agy acp --login` makes it: the account's own plan.
    return { installed: true, version: check.version, supported: true, signedIn, billing: signedIn ? "subscription" : "unknown", problem: signedIn ? null : "Antigravity is not connected in Botbench. Connect it in Settings, Agents: it signs in with Google once more, for Botbench alone." };
  }

  /** The models Antigravity lists for Botbench's profile, from session/new; starts no turn. Else the configured list. */
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
    const fallback: DriverModels = { source: "config", models: this.configured.models.map((id) => ({ id })), default: this.configured.defaultModel, cliDefault: null };
    const profile = antigravityProfile(this.dataDir);
    if (!profileSignedIn(profile)) return fallback;
    let listed: ModelChoice[] | null = null;
    try {
      listed = await listAcpModels({ dataDir: this.dataDir, ...(this.home ? { home: this.home } : {}) });
    } catch {
      listed = null;
    }
    return listed === null ? fallback : { source: "cli", models: listed, default: this.configured.defaultModel, cliDefault: null };
  }

  /**
   * Probe, then make the attempt of one turn; Antigravity starts with the turn, under sandbox-exec, its network only
   * through a proxy to Google started for it. A review (`readOnly`) works in the task's copy and reads it without
   * changing it; a chat (`chatTools`) works in the chat's folder and reads an attached repository without changing it.
   * What Botbench's rules leave to the owner goes through `gate`'s check as `permission_request` events; without a
   * gate, it is refused.
   */
  async startAttempt(options: StartAttemptOptions): Promise<DriverSession> {
    const chat = options.chatTools;
    if (chat !== undefined && (options.readOnly === true || options.allowEdits === true)) throw new Error("A chat with Antigravity's own tools cannot also be read-only or edit under a task's rules.");
    if (chat === undefined && (options.readOnly !== true || options.allowEdits === true)) throw new Error("Antigravity can only review or chat in Botbench: it never edits a task's files.");
    if (options.resumeCursor !== undefined) throw new Error("Antigravity cannot resume a session in Botbench.");
    // Antigravity runs its own commands, in its own process: none could be put in a task's container (src/execution.ts).
    // A review reads the copy and runs its commands confined on this Mac, as ADR 0009 says of every reviewer.
    if (options.container !== undefined) throw new Error("Antigravity cannot have its commands run in a task's container. Nothing ran on this Mac instead.");
    if (options.confinement.allowedHosts.length > 0) throw new Error("Antigravity's commands reach no network in Botbench, so it cannot be given hosts to reach.");
    const mode = chat === undefined ? "review" : "chat";
    const kept = agyTools({ mode, webSearch: options.webSearch === true });
    if (options.model !== undefined) {
      const problem = modelNameProblem(options.model);
      if (problem !== null) throw new Error(`The model name cannot be passed to Antigravity. ${problem}`);
    }
    const probe = await this.probe();
    if (probe.problem) throw new DriverUnavailableError(probe);
    const program = agyProgram()!;
    const { dataDir: givenDataDir } = options.confinement;
    if (!fs.statSync(givenDataDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Botbench's data folder does not exist: ${givenDataDir}`);
    if (!fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The working directory does not exist: ${options.cwd}`);
    const dataDir = fs.realpathSync(givenDataDir);
    const profile = prepareProfile(this.dataDir);
    // A review works in a new empty folder and reads the task's copy from there: in the copy itself, Antigravity would
    // take the repository's AGENTS.md as its own instructions (measured on 1.5.14).
    const readable = (chat === undefined ? [options.cwd, ...(options.confinement.gitDir === undefined ? [] : [options.confinement.gitDir])] : [...chat.readable]).map((place) => fs.realpathSync(place));
    const planted = plantedConfigProblem([options.cwd, ...readable]);
    if (planted !== null) throw new Error(planted);
    const review = chat === undefined ? makeReviewFolder(dataDir) : null;
    const folder = review?.path ?? fs.realpathSync(options.cwd);
    const agent = writeAgent(profile, kept);
    let proxy: { port: number; close(): Promise<void> };
    try {
      proxy = await startProviderProxy(AGY_PROVIDER);
    } catch (err) {
      review?.remove();
      throw new Error(`Botbench could not start the proxy Antigravity reaches Google through: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Its own temporary folder: the shared one, where other programs keep files and sockets, is closed to it (toolsProfile).
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-agy-")));
    const cleanup = (): void => {
      review?.remove();
      fs.rmSync(temp, { recursive: true, force: true });
      void proxy.close();
    };
    let run: { command: string; args: string[] };
    try {
      run = sandboxed(agyToolsProfile({ dataDir, profile, folder, readOnly: readable, temp, proxyPort: proxy.port, program, ...(this.home ? { home: this.home } : {}) }), program, ["acp", "--gemini-dir", profileGeminiDir(profile), "--agent", agent]);
    } catch (err) {
      cleanup();
      throw err;
    }
    const others = readable.filter((place) => place !== folder);
    return startAcpTurn(options.db, ANTIGRAVITY, options.model ?? null, {
      agent: "Antigravity",
      command: run.command,
      args: run.args,
      cwd: folder,
      extraEnv: { ...AGY_EXTRA_ENV, BROWSER: NO_BROWSER, ...proxyEnv(proxy.port), TMPDIR: temp, TMP: temp, TEMP: temp },
      capabilities: ANTIGRAVITY_CAPABILITIES,
      // The read-only places are not added to its workspace: Antigravity takes a workspace folder's AGENTS.md as its own
      // instructions (measured on 1.5.14). Its reads there ask, and Botbench allows them without asking the owner.
      session: { cwd: folder },
      ...(options.model !== undefined ? { model: options.model } : {}),
      // Every edit and command is put to Botbench: Antigravity's own default mode.
      config: [{ id: "mode", value: "default" }],
      reader: acpReader("Antigravity", kept),
      decide: (request) => agyDecide(request, { folder, writable: chat !== undefined, readable: others, dataDir, profile, kept }),
      // Every command and every change must have been put to Botbench first: one that ran without asking stops the turn.
      mustAsk: ["execute", "edit", "delete", "move"],
      gated: options.gate !== undefined,
      ...(this.onLine ? { onLine: this.onLine } : {}),
      cleanup,
    });
  }
}

/**
 * The models Antigravity offers Botbench's profile: `agy acp` under the sign-in's sandbox, initialize and session/new
 * in an empty folder, no prompt. Null when it lists none or does not answer in time.
 */
export async function listAcpModels(o: { dataDir: string; home?: string; timeoutMs?: number }): Promise<ModelChoice[] | null> {
  const { launch, killProcessGroup } = await import("./launch.ts");
  const readline = await import("node:readline");
  const profile = prepareProfile(o.dataDir);
  const folder = makeReviewFolder(o.dataDir);
  const { child, pgid } = launch(SANDBOX_EXEC, ["-p", signInSandbox({ dataDir: o.dataDir, profile, ...(o.home ? { home: o.home } : {}) }), COMMAND, "acp", "--gemini-dir", profileGeminiDir(profile)], { cwd: folder.path, extraEnv: { ...AGY_EXTRA_ENV, BROWSER: NO_BROWSER } });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const write = (id: number, method: string, params: unknown): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  try {
    return await new Promise<ModelChoice[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), o.timeoutMs ?? 30_000);
      child.once("close", () => (clearTimeout(timer), resolve(null)));
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let m: unknown;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (!isObject(m)) return;
        if (m.id === 1) write(2, "session/new", { cwd: folder.path, mcpServers: [] });
        if (m.id === 2) {
          clearTimeout(timer);
          resolve(m.error === undefined ? parseAcpModels(m.result) : null);
        }
      });
      write(1, "initialize", { protocolVersion: 1, clientInfo: { name: "botbench", version: "0.1.0" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    });
  } finally {
    child.stdin.end();
    if (pgid) await killProcessGroup(pgid, { graceMs: 1000 }).catch(() => {});
    folder.remove();
  }
}
