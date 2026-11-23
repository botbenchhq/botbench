import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { unreadablePaths } from "../confinement.ts";
import { now, transaction } from "../store/db.ts";
import { modelNameProblem, type DriverCapabilities, type DriverSession, type ResumeCursor } from "./contract.ts";
import type { DriverEvent, PermissionResponse, TurnEndReason } from "./events.ts";
import { killProcessGroup, launch, processGroupAlive, type CliChild } from "./launch.ts";

/*
 * Codex as a builder, driven over `codex app-server`: JSON-RPC, one JSON object per line on its input and output, no
 * new dependency. Shapes from `codex app-server generate-ts` on 0.171.0 and docs/security/codex-app-server-check.md:
 *   >> {"id":0,"method":"initialize","params":{"clientInfo":{…},"capabilities":{"experimentalApi":true}}}
 *   << {"id":0,"result":{"userAgent":"…","codexHome":"…","platformFamily":"unix","platformOs":"macos"}}
 *   >> {"method":"initialized","params":{}}
 *   >> {"id":1,"method":"thread/start","params":{"cwd":…,"approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true}}
 *   << {"id":1,"result":{"thread":{"id":…},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite",…},…}}
 *   << {"method":"thread/settings/updated","params":{"threadSettings":{"approvalPolicy":…,"sandboxPolicy":…,"activePermissionProfile":{"id":…}}}}
 *   >> {"id":2,"method":"turn/start","params":{"threadId":…,"input":[{"type":"text","text":…,"text_elements":[]}]}}
 *   << item/started, item/completed ({"type":"commandExecution"|"fileChange"|"agentMessage",…}), thread/tokenUsage/updated,
 *      and finally turn/completed {"turn":{"status":"completed"|"interrupted"|"failed","error":…}}
 *   << {"id":0,"method":"item/commandExecution/requestApproval","params":{"itemId":…,"command":…,"cwd":…,"reason":…}}
 *   >> {"id":0,"result":{"decision":"accept"|"decline"}}
 *
 * The sandbox is Codex's own, under Botbench's permissions profile (`buildConfig`): the task's copy writable, the
 * repository's git folder read-only, every place of src/confinement.ts's shared list, Codex's own folder and Botbench's
 * data folder unreadable, and no network. The approval policy is `on-request`: Codex asks only to leave its sandbox, and
 * on 0.171.0 a request the client accepts runs OUTSIDE it (measured live, docs/security/codex-app-server-check.md). So
 * every request is an escalation: each becomes one permission request marked `escalation`, which Botbench's broker puts
 * to the owner every time (refused in a fully autonomous run). What stays in the sandbox never asks and is reported
 * only by the event stream. A command the sandbox refuses without asking produces no item at all (measured): it is in
 * neither the transcript nor the log.
 *
 * `codex app-server` has no `--ignore-user-config`, so the owner's ~/.codex/config.toml is loaded. Every setting the
 * driver relies on is a session flag, which outranks it, and is passed again on thread/start; then what Codex reports
 * (thread/start's answer and each thread/settings/updated) is checked before every turn (`settingsProblem`, after
 * OpenMausBot's `withResolvedSandbox`): a looser sandbox, network, another approval policy or reviewer, or another
 * permissions profile stops the turn before it starts, or the running turn when Codex reports it mid-turn.
 *
 * Fail closed: an approval answered with anything but the owner's own allow, one left unanswered past
 * `approvalTimeoutMs`, one still waiting when the turn is stopped or the process ends, and any request Botbench does not
 * know are declined; nothing is ever accepted for the session or with an execpolicy amendment.
 */

export const CODEX_DRIVER = "codex";
/** The name of Botbench's permissions profile for a build. */
export const BUILD_PROFILE = "botbench-build";

/**
 * Features of 0.171.0 that are off for a build, beside those off for every Codex turn (`baseFeatures`, from
 * src/drivers/codex.ts): other agents and their threads, Codex's own reviewer of approvals (which would answer an
 * escalation in the owner's place), goals that outlive the turn, Codex's own worktrees, remote control, local
 * automations and realtime voice. Each is a name `codex features list` shows.
 */
export const BUILD_ONLY_DISABLED = ["multi_agent", "guardian_approval", "goals", "worktrees", "remote_control", "in_app_local_automation", "realtime_conversation", "request_permissions_tool"];

/** How long an escalation waits for the owner before it is declined. */
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;
/** What a request still waiting when Codex is stopped says. */
const STOPPED_UNANSWERED = "Codex was stopped before you answered, so it was denied and did not run.";
/** How long thread/start waits for Codex to report the permissions profile in force when its answer does not. */
const SETTINGS_WAIT_MS = 3000;
const REQUEST_TIMEOUT_MS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

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

/** Where a build works: the task's copy, Botbench's data folder, and the repository's shared git folder. */
export interface BuildPlace {
  cwd: string;
  dataDir: string;
  gitDir?: string;
  /** Where a moved Codex folder (CODEX_HOME) is read from; Botbench's own environment when left out. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The session flags of a build, every one a setting the driver relies on, so the owner's config.toml cannot loosen it:
 * `on-request` approvals put to the client (`approvals_reviewer="user"`, never Codex's own reviewer), Botbench's
 * permissions profile (home folder, the shared secret list, Codex's folder and Botbench's data folder denied; the
 * task's copy writable; the git folder readable; no network), no MCP server, no web search, no notify program, and the
 * features `disabled` names switched off. A narrower filesystem rule wins (seen on 0.171.0).
 */
export function buildConfig(place: BuildPlace, disabled: readonly string[]): string[] {
  const home = os.homedir();
  const rules = new Map<string, string>();
  for (const denied of [home, ...unreadablePaths({ dataDir: place.dataDir, home, ...(place.env ? { env: place.env } : {}) })]) rules.set(denied, "deny");
  if (place.gitDir !== undefined) rules.set(realOrAsIs(place.gitDir), "read");
  rules.set(realOrAsIs(place.cwd), "write");
  const filesystem = `{${[...rules].map(([at, rule]) => `${tomlPath(at)}="${rule}"`).join(",")}}`;
  return [
    "-c", 'approval_policy="on-request"',
    "-c", 'approvals_reviewer="user"',
    "-c", `default_permissions="${BUILD_PROFILE}"`,
    "-c", `permissions.${BUILD_PROFILE}.extends=":workspace"`,
    "-c", `permissions.${BUILD_PROFILE}.filesystem=${filesystem}`,
    "-c", `permissions.${BUILD_PROFILE}.network.enabled=false`,
    "-c", "mcp_servers={}",
    "-c", 'web_search="disabled"',
    "-c", "notify=[]",
    ...disabled.flatMap((feature) => ["--disable", feature]),
  ];
}

/** The arguments `codex app-server` is started with for a build. */
export const appServerArgs = (place: BuildPlace, disabled: readonly string[]): string[] => ["app-server", ...buildConfig(place, disabled)];

/** What Codex reported about the thread's settings: from thread/start's answer, then each thread/settings/updated. */
export interface ReportedSettings {
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandbox: unknown;
  /** The permissions profile in force (`activePermissionProfile`); undefined while Codex has not said. */
  profile?: unknown;
}

/** The temporary folders `:workspace` makes writable on this Mac: a root among them is not looser than Botbench set. */
const tempRoots = (): string[] => [...new Set(["/tmp", "/private/tmp", os.tmpdir(), realOrAsIs(os.tmpdir())])];

/**
 * Why a turn must not run under what Codex reported, or null when it may: the approval policy is `on-request` and its
 * requests come to Botbench (`user`), the sandbox is read-only or workspace-write with no network and writes only the
 * task's copy (and the temporary folders), and Botbench's profile is the one in force. Pure. Anything Codex did not
 * report, or reported in a shape Botbench does not know, is a reason not to run.
 */
export function settingsProblem(reported: ReportedSettings, cwd: string): string | null {
  const after = "A Codex setting outside Botbench, such as one in its config.toml or a managed configuration, may be overriding Botbench's.";
  if (reported.approvalPolicy !== "on-request") return `Codex reported the approval policy ${JSON.stringify(reported.approvalPolicy ?? null)}, not the "on-request" Botbench set, so it was stopped. ${after}`;
  if (reported.approvalsReviewer !== "user") return `Codex reported that its requests go to ${JSON.stringify(reported.approvalsReviewer ?? null)}, not to Botbench, so it was stopped. ${after}`;
  const sandbox = isObject(reported.sandbox) ? reported.sandbox : null;
  if (sandbox === null || typeof sandbox.type !== "string") return "Codex did not say which sandbox it runs its commands in, so it was stopped. Update Botbench for this Codex.";
  if (sandbox.type !== "readOnly" && sandbox.type !== "workspaceWrite") return `Codex reported the sandbox ${shorten(sandbox.type, 60)}, looser than the workspace-write sandbox Botbench set, so it was stopped. ${after}`;
  if (sandbox.networkAccess !== false) return `Codex reported that its commands can reach the network, which Botbench did not allow, so it was stopped. ${after}`;
  if (sandbox.type === "workspaceWrite") {
    const roots = Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots : null;
    if (roots === null) return "Codex did not say where its commands may write, so it was stopped. Update Botbench for this Codex.";
    const copy = realOrAsIs(cwd);
    const allowed = tempRoots();
    for (const root of roots) {
      const at = typeof root === "string" ? realOrAsIs(root) : null;
      const inside = at !== null && (at === copy || at.startsWith(`${copy}${path.sep}`) || allowed.includes(at));
      if (!inside) return `Codex reported that its commands may write in ${shorten(String(root), 200)}, outside the task's copy, so it was stopped. ${after}`;
    }
  }
  const profile = isObject(reported.profile) ? reported.profile : null;
  if (profile === null || profile.id !== BUILD_PROFILE) return `Codex did not report Botbench's permissions profile (${BUILD_PROFILE}) as the one in force${profile === null ? "" : `: it reported ${shorten(String(profile.id), 100)}`}, so it was stopped. ${after}`;
  return null;
}

/** Codex's words when it ignores a setting it does not know (seen on 0.171.0). */
const IGNORED_SETTING = /unrecognized configuration setting/i;

/** The approval requests Botbench answers, each put to the owner as one escalation. */
const APPROVAL_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);

/** What an escalation's card shows of a file change: its path, kind and diff, as Codex's own item gave them. */
const changesOf = (item: unknown): unknown => (isObject(item) && Array.isArray(item.changes) ? item.changes.map((c: unknown) => (isObject(c) ? { path: str(c.path), kind: isObject(c.kind) ? c.kind.type : null, diff: typeof c.diff === "string" ? shorten(c.diff, 4000) : null } : null)) : null);

/**
 * A Codex approval request as a permission request for the broker: always an escalation. A command is put as the
 * shell's, so the safety floor reads it and the card shows it; anything it carries beside the command (network, more
 * permissions) is put with it, so the card shows all of what an allow lets out. Null for a method that is not one.
 */
export function escalationOf(method: string, rpcId: string, params: Record<string, unknown>, changes: unknown): Extract<DriverEvent, { type: "permission_request" }> | null {
  if (!APPROVAL_METHODS.has(method)) return null;
  const item = str(params.itemId) ?? "";
  const toolCallId = `${item}${str(params.approvalId) ? `:${str(params.approvalId)}` : ""}` || `request-${rpcId}`;
  const reason = str(params.reason) === null || str(params.reason)!.trim() === "" ? null : shorten(str(params.reason)!.trim());
  const base = { type: "permission_request" as const, id: `codex-${rpcId}`, toolCallId, reason, escalation: true as const };
  if (method === "item/commandExecution/requestApproval") {
    const command = str(params.command) ?? "";
    const extra = { ...(params.networkApprovalContext == null ? {} : { network: params.networkApprovalContext }), ...(params.additionalPermissions == null ? {} : { additionalPermissions: params.additionalPermissions }) };
    return { ...base, name: "Bash", input: { command, ...extra } };
  }
  if (method === "item/fileChange/requestApproval") return { ...base, name: "apply_patch", input: { changes, ...(str(params.grantRoot) ? { grantRoot: str(params.grantRoot) } : {}) } };
  return { ...base, name: "permissions", input: { permissions: params.permissions ?? null, cwd: str(params.cwd) } };
}

/** The answer that declines a request of `method`, in the shape Codex takes for it; an error for one Botbench does not know. */
export function declineFor(method: string): { result: unknown } | { error: { code: number; message: string } } {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { result: { decision: "decline" } };
  if (method === "item/permissions/requestApproval") return { result: { permissions: {}, scope: "turn" } };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { result: { decision: "denied" } };
  if (method === "mcpServer/elicitation/request") return { result: { action: "decline" } };
  return { error: { code: -32601, message: `Botbench refuses this request (${shorten(method, 100)}): it answers only Codex's approval requests.` } };
}

/** The answer that accepts an approval request once, never for the session and never with an amendment. */
function acceptFor(method: string, params: Record<string, unknown>): unknown {
  if (method === "item/permissions/requestApproval") return { permissions: isObject(params.permissions) ? params.permissions : {}, scope: "turn" };
  return { decision: "accept" };
}

/**
 * Turn one item notification into normalized events. Pure. A finished command carries its call as well as its result,
 * since Codex may report a command only once it is over; a declined one ran nowhere and has no result.
 */
export function itemEvents(method: "item/started" | "item/completed", item: Record<string, unknown>): DriverEvent[] {
  const id = str(item.id) ?? "";
  const done = method === "item/completed";
  switch (item.type) {
    case "agentMessage":
      return done && typeof item.text === "string" && item.text !== "" ? [{ type: "text", text: item.text }] : [];
    case "commandExecution": {
      const call: DriverEvent = { type: "tool_call", id, name: "shell", input: { command: str(item.command) ?? "" } };
      if (!done) return [call];
      if (item.status === "declined") return [call, { type: "permission_denied", id, name: "shell", reason: "Denied, so it did not run.", code: "declined" }];
      const output = str(item.aggregatedOutput) ?? "";
      const confined = /Operation not permitted|Could not resolve host/.test(output) ? { confined: { hosts: [], files: /Operation not permitted/.test(output) } } : {};
      return [call, { type: "tool_result", id, output, isError: item.status !== "completed" || item.exitCode !== 0, ...confined }];
    }
    case "fileChange": {
      const call: DriverEvent = { type: "tool_call", id, name: "file_change", input: { changes: changesOf(item) } };
      if (!done) return [call];
      if (item.status === "declined") return [call, { type: "permission_denied", id, name: "file_change", reason: "Denied, so the change was not made.", code: "declined" }];
      return [call, { type: "tool_result", id, output: str(item.status) ?? "", isError: item.status !== "completed" }];
    }
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "webSearch":
      return done ? [{ type: "error", message: `Codex used ${String(item.type)}, which Botbench switched off for a build.`, raw: shorten(JSON.stringify(item)) }] : [];
    default:
      return [];
  }
}

/** The way to the app-server process: a real `codex app-server`, or a session replayed from one (tests). */
export interface AppServerTransport {
  /** Write one message, as one line. */
  send(message: Record<string, unknown>): void;
  /** Each line the server prints. */
  onLine(listener: (line: string) => void): void;
  /** Called once when the server is gone, with what it said on its error output when it said anything. */
  onExit(listener: (how: string, stderr: string | null) => void): void;
  /** End the server and whatever it started. Resolves once nothing of it is left. */
  stop(): Promise<void>;
  /** The server's process group, when it is a process; 0 when it is not. */
  readonly pgid: number;
}

/** `codex app-server` as a process of its own group, as every CLI Botbench starts. */
export function processTransport(child: CliChild, pgid: number): AppServerTransport {
  let stderrTail = "";
  const exitListeners: ((how: string, stderr: string | null) => void)[] = [];
  let exited = false;
  let spawnError: Error | null = null;
  const gone = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      const how = spawnError ? spawnError.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
      for (const listener of exitListeners) listener(how, stderrTail.trim() === "" ? null : shorten(stderrTail.trim()));
      resolve();
    });
  });
  child.on("error", (err) => (spawnError = err));
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderrTail = (stderrTail + chunk).slice(-2000)));
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  return {
    pgid,
    send: (message) => {
      if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onLine: (listener) => void lines.on("line", listener),
    onExit: (listener) => void exitListeners.push(listener),
    stop: async () => {
      child.stdin.end();
      await killProcessGroup(pgid).catch(() => {});
      await gone;
    },
  };
}

/** Start `codex app-server` for a build in the task's copy. */
export function launchAppServer(command: string, args: readonly string[], o: { cwd: string; extraEnv: Record<string, string> }): AppServerTransport {
  const { child, pgid } = launch(command, args, { cwd: o.cwd, extraEnv: o.extraEnv });
  if (!pgid) {
    child.on("error", () => {});
    throw new Error("Codex could not be started.");
  }
  return processTransport(child, pgid);
}

type Pending = { method: string; params: Record<string, unknown>; rpcId: string | number; request: Extract<DriverEvent, { type: "permission_request" }>; timer: NodeJS.Timeout };

export interface AppServerSessionOptions {
  db: DatabaseSync;
  transport: AppServerTransport;
  cwd: string;
  model?: string;
  capabilities: DriverCapabilities;
  /** How long an escalation waits for the owner before it is declined. */
  approvalTimeoutMs?: number;
}

/**
 * One `codex app-server` process working on one attempt of a build: one thread, one turn per message. Make it with
 * `startAppServerSession`, which also writes its attempt row and starts its thread.
 */
export class CodexAppServerSession implements DriverSession {
  readonly attemptId: number;
  readonly capabilities: DriverCapabilities;
  private readonly db: DatabaseSync;
  private readonly transport: AppServerTransport;
  private readonly cwd: string;
  private readonly model: string | undefined;
  private readonly approvalTimeoutMs: number;
  private readonly listeners = new Set<(event: DriverEvent) => void>();
  private readonly calls = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private readonly pending = new Map<string, Pending>();
  /** What each file change item holds, by item id, for the card of its approval request (which carries no paths). */
  private readonly changes = new Map<string, unknown>();
  private readonly called = new Set<string>();
  private nextId = 0;
  private turn = 0;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private reported: ReportedSettings | null = null;
  private usage: Extract<DriverEvent, { type: "usage" }> | null = null;
  private running: { resolve: (reason: TurnEndReason) => void; done: Promise<TurnEndReason> } | null = null;
  private interrupting = false;
  private over = false;
  private status: "running" | "interrupted" | "failed" | "ended" = "running";
  private settingsListener: (() => void) | null = null;
  private readonly exited: Promise<void>;

  constructor(attemptId: number, o: AppServerSessionOptions) {
    this.attemptId = attemptId;
    this.db = o.db;
    this.transport = o.transport;
    this.cwd = o.cwd;
    this.model = o.model;
    this.capabilities = o.capabilities;
    this.approvalTimeoutMs = o.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.transport.onLine((line) => this.onLine(line));
    this.exited = new Promise((resolve) => this.transport.onExit((how, stderr) => {
      this.onExit(how, stderr);
      resolve();
    }));
  }

  resumeCursor(): ResumeCursor | null {
    return this.threadId;
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * initialize, initialized and thread/start, with every setting the build relies on passed again. Rejects when Codex
   * did not start a thread. What it reports is checked before each turn, not here, so the reason is on the turn.
   */
  async start(): Promise<void> {
    await this.call("initialize", { clientInfo: { name: "botbench", title: "Botbench", version: "1" }, capabilities: { experimentalApi: true } });
    this.transport.send({ method: "initialized", params: {} });
    if (this.model !== undefined && modelNameProblem(this.model) !== null) throw new Error(`The model name cannot be passed to Codex. ${modelNameProblem(this.model)}`);
    const started = await this.call("thread/start", { cwd: this.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", ephemeral: true, ...(this.model === undefined ? {} : { model: this.model }) });
    const result = isObject(started) ? started : {};
    const thread = isObject(result.thread) ? str(result.thread.id) : null;
    if (thread === null) throw new Error("Codex did not start a thread for the build.");
    this.threadId = thread;
    this.reported = { approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandbox: result.sandbox, ...(result.activePermissionProfile === undefined ? {} : { profile: result.activePermissionProfile }), ...(this.reported?.profile === undefined ? {} : { profile: this.reported.profile }) };
    // The answer to thread/start does not name the permissions profile; Codex reports it with the thread's settings.
    if (this.reported.profile === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SETTINGS_WAIT_MS);
        this.settingsListener = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.settingsListener = null;
    }
    this.record({ type: "session_started", resumeCursor: thread, model: str(result.model), keySource: null }, { resumeCursor: thread, ...(str(result.model) ? { model: str(result.model)! } : {}) });
  }

  sendTurn(prompt: string): Promise<TurnEndReason> {
    if (this.over || this.status !== "running" || this.threadId === null) return Promise.reject(new Error("This session with Codex has ended; start a new one to continue."));
    if (this.running) return Promise.reject(new Error("Codex is still working on the last message. Wait for it to finish, or stop it."));
    this.turn += 1;
    let resolve!: (reason: TurnEndReason) => void;
    const done = new Promise<TurnEndReason>((r) => (resolve = r));
    this.running = { resolve, done };
    this.usage = null;
    this.interrupting = false;
    this.record({ type: "user_prompt", text: prompt });
    // Before every turn: what Codex reports must be what Botbench set, or the turn does not start.
    const problem = this.reported === null ? "Codex did not report its settings, so it was stopped." : settingsProblem(this.reported, this.cwd);
    if (problem !== null) {
      // Ended once the caller's step is over: it may have sent this message inside a transaction of its own.
      queueMicrotask(() => {
        this.record({ type: "error", message: problem, raw: this.reported === null ? null : shorten(JSON.stringify(this.reported)) });
        this.endTurn("error", problem, "failed");
        void this.transport.stop();
      });
      return done;
    }
    this.call("turn/start", { threadId: this.threadId, input: [{ type: "text", text: prompt, text_elements: [] }], cwd: this.cwd, approvalPolicy: "on-request", approvalsReviewer: "user" })
      .then((answer) => {
        const turn = isObject(answer) && isObject(answer.turn) ? str(answer.turn.id) : null;
        if (turn !== null && this.turnId === null) this.turnId = turn;
      })
      .catch((err: Error) => {
        if (!this.running) return;
        const detail = `Codex did not start work on the message: ${shorten(err.message, 300)}`;
        this.record({ type: "error", message: detail, raw: null });
        this.endTurn("error", detail, "failed");
      });
    return done;
  }

  async interruptTurn(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.interrupting = true;
    // Nothing waiting on the owner runs once the turn is stopped.
    this.declineAll("cancelled", STOPPED_UNANSWERED);
    if (this.threadId !== null && this.turnId !== null) this.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running.done, new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    if (this.running) this.endTurn("interrupted", "Codex did not confirm in time that it had stopped.");
    await this.stopProcess();
  }

  respondToRequest(requestId: string, response: unknown): Promise<void> {
    const waiting = this.pending.get(requestId);
    if (!waiting) return Promise.reject(new Error(`No permission request ${requestId} is waiting in this session: it was answered already, or Codex stopped waiting for it.`));
    if (this.over) return Promise.reject(new Error(`The answer to permission request ${requestId} could not be delivered: Codex is no longer running. Nothing was run.`));
    const given: Partial<PermissionResponse> = isObject(response) ? response : {};
    // Only the owner's own allow lets an escalation out. An allow that came from a grant, a mode, the copy's rule or a
    // setting is no answer to one (the broker never gives such an allow to an escalation), so it declines.
    const byRule = given.preapproved === true || given.standing === true || given.mode === true || given.files === true || given.web === true || given.bookkeeping === true || given.chat === true;
    if (given.decision === "allow" && !byRule) return Promise.resolve(this.answer(waiting, true, "allowed", null));
    const note = typeof given.refused === "string" && given.refused.trim() !== "" ? given.refused.trim() : typeof given.note === "string" && given.note.trim() !== "" ? given.note.trim() : null;
    const decision = byRule ? "denied" : typeof given.refused === "string" && given.refused.trim() !== "" ? "denied" : "declined";
    return Promise.resolve(this.answer(waiting, false, decision, byRule ? "An escalation can be allowed only by you, never by a rule." : note));
  }

  async close(): Promise<void> {
    if (this.running) await this.interruptTurn();
    this.over = true;
    await this.stopProcess();
  }

  private async stopProcess(): Promise<void> {
    this.over = true;
    await this.transport.stop();
    await this.exited;
  }

  /** Send a request and wait for its answer. */
  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Codex did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`));
      }, REQUEST_TIMEOUT_MS);
      this.calls.set(id, { resolve, reject, timer });
      this.transport.send({ id, method, params });
    });
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.record({ type: "error", message: "Codex printed a line Botbench could not read.", raw: shorten(line) });
    }
    if (!isObject(message)) return this.record({ type: "error", message: "Codex printed a line that is not a message.", raw: shorten(line) });
    const method = str(message.method);
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (method !== null && hasId) return this.onServerRequest(method, message.id as string | number, isObject(message.params) ? message.params : {});
    if (method !== null) return this.onNotification(method, isObject(message.params) ? message.params : {});
    if (typeof message.id === "number") {
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id);
      clearTimeout(call.timer);
      if (isObject(message.error)) call.reject(new Error(str(message.error.message) ?? "Codex answered with an error."));
      else call.resolve(message.result);
    }
  }

  /** A request of Codex's: an approval request becomes one escalation for the owner; anything else is declined at once. */
  private onServerRequest(method: string, rpcId: string | number, params: Record<string, unknown>): void {
    const itemId = str(params.itemId) ?? "";
    const request = this.running ? escalationOf(method, String(rpcId), params, this.changes.get(itemId) ?? null) : null;
    if (request === null || this.pending.has(request.id)) {
      this.transport.send({ id: rpcId, ...declineFor(method) });
      const why = this.running ? "Botbench answers only Codex's approval requests" : "Codex was not working on a message";
      return this.record({ type: "error", message: `Codex asked for something Botbench does not answer (${shorten(method, 100)}), and it was refused: ${why}.`, raw: shorten(JSON.stringify(params)) });
    }
    const timer = setTimeout(() => {
      const waiting = this.pending.get(request.id);
      if (waiting) this.answer(waiting, false, "cancelled", `No answer came within ${Math.round(this.approvalTimeoutMs / 60_000)} minutes, so it was denied and did not run.`);
    }, this.approvalTimeoutMs);
    timer.unref?.();
    this.pending.set(request.id, { method, params, rpcId, request, timer });
    this.record(request);
  }

  /** Answer one waiting request and record how it ended. */
  private answer(waiting: Pending, allow: boolean, decision: "allowed" | "declined" | "denied" | "cancelled", note: string | null): void {
    if (!this.pending.delete(waiting.request.id)) return;
    clearTimeout(waiting.timer);
    this.transport.send({ id: waiting.rpcId, ...(allow ? { result: acceptFor(waiting.method, waiting.params) } : declineFor(waiting.method)) });
    this.record({ type: "permission_resolved", id: waiting.request.id, toolCallId: waiting.request.toolCallId, decision, note });
  }

  private declineAll(decision: "cancelled", note: string): void {
    for (const waiting of [...this.pending.values()]) this.answer(waiting, false, decision, note);
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/settings/updated": {
        const settings = isObject(params.threadSettings) ? params.threadSettings : {};
        this.reported = { approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandbox: settings.sandboxPolicy, profile: settings.activePermissionProfile ?? null };
        this.settingsListener?.();
        const problem = settingsProblem(this.reported, this.cwd);
        if (problem !== null && this.running) this.stopFor(problem);
        return;
      }
      case "turn/started": {
        const turn = isObject(params.turn) ? str(params.turn.id) : null;
        if (turn !== null) this.turnId = turn;
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = isObject(params.item) ? params.item : null;
        if (item === null) return;
        if (item.type === "fileChange" && typeof item.id === "string") this.changes.set(item.id, changesOf(item));
        for (const event of itemEvents(method, item)) {
          // A finished item repeats its call; the transcript has it once.
          if (event.type === "tool_call") {
            if (this.called.has(event.id)) continue;
            this.called.add(event.id);
          }
          this.record(event);
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = isObject(params.tokenUsage) && isObject(params.tokenUsage.last) ? params.tokenUsage.last : null;
        if (usage !== null) this.usage = { type: "usage", inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), cacheReadTokens: count(usage.cachedInputTokens), cacheWriteTokens: count(usage.cacheWriteInputTokens) };
        return;
      }
      case "serverRequest/resolved": {
        // Codex stopped waiting for a request: it is answered with a decline, so nothing waits on a card no one can use.
        const id = params.requestId;
        const waiting = [...this.pending.values()].find((p) => p.rpcId === id);
        if (waiting) this.answer(waiting, false, "cancelled", "Codex stopped waiting for an answer.");
        return;
      }
      case "error": {
        const error = isObject(params.error) ? params.error : {};
        if (params.willRetry === true) return;
        return this.record({ type: "error", message: shorten(str(error.message) ?? "Codex reported an error without saying what."), raw: null });
      }
      case "configWarning":
      case "warning": {
        const words = `${str(params.summary) ?? str(params.message) ?? ""} ${str(params.details) ?? ""}`.trim();
        if (IGNORED_SETTING.test(words)) return this.stopFor(`Stopped: Codex did not take one of Botbench's settings (${shorten(words, 300)}), so it could not be kept in the sandbox Botbench set. Update Botbench or Codex.`);
        if (words !== "") this.record({ type: "error", message: shorten(words), raw: null });
        return;
      }
      case "turn/completed": {
        const turn = isObject(params.turn) ? params.turn : {};
        if (!this.running) return;
        if (this.usage !== null) this.record(this.usage);
        const status = str(turn.status);
        const error = isObject(turn.error) ? turn.error : null;
        // A message Botbench stopped ended stopped, whatever Codex says of it, as with Claude Code.
        if (status === "interrupted" || this.interrupting) return this.endTurn("interrupted", "Codex was stopped.");
        if (status === "completed") return this.endTurn("completed", null);
        const detail = shorten(str(error?.message) ?? "Codex reported that it failed without saying why.");
        this.record({ type: "error", message: detail, raw: null });
        return this.endTurn("error", detail);
      }
      default:
        return;
    }
  }

  /** The running turn must not go on: it ends in error, waiting requests are declined, and the process is ended. */
  private stopFor(detail: string): void {
    this.declineAll("cancelled", STOPPED_UNANSWERED);
    this.record({ type: "error", message: detail, raw: null });
    if (this.running) this.endTurn("error", detail, "failed");
    void this.transport.stop();
  }

  private endTurn(reason: TurnEndReason, detail: string | null, status?: "failed"): void {
    const running = this.running;
    if (!running) return;
    // A turn that is over waits for no answer: what still waits is declined.
    this.declineAll("cancelled", "Codex finished before you answered, so it was denied and did not run.");
    this.running = null;
    this.turnId = null;
    const next = reason === "interrupted" ? "interrupted" : status;
    if (next !== undefined) this.status = next;
    this.record({ type: "turn_ended", reason, detail }, next === undefined ? undefined : { status: next });
    running.resolve(reason);
  }

  private onExit(how: string, stderr: string | null): void {
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`Codex ${how}.`));
    }
    this.calls.clear();
    // Nothing can be answered once Codex is gone; what waited is ended, declined.
    for (const waiting of [...this.pending.values()]) {
      clearTimeout(waiting.timer);
      this.pending.delete(waiting.request.id);
      this.record({ type: "permission_resolved", id: waiting.request.id, toolCallId: waiting.request.toolCallId, decision: "cancelled", note: "Codex stopped before you answered." });
    }
    if (this.running) {
      if (this.interrupting || this.over) this.endTurn("interrupted", "Codex exited.");
      else {
        const message = `Codex ${how} while it was working.`;
        this.record({ type: "error", message, raw: stderr });
        this.endTurn("error", message, "failed");
      }
    }
    this.over = true;
    const change: { status?: "ended" | "failed"; clearPgid: boolean } = { clearPgid: this.transport.pgid === 0 || !processGroupAlive(this.transport.pgid) };
    if (this.status === "running") change.status = "ended";
    this.updateAttempt(change);
  }

  private record(event: DriverEvent, change?: { status?: string; resumeCursor?: string; model?: string; clearPgid?: boolean }): void {
    // A turn's first event may be recorded inside a caller's transaction (engine/task.ts sendNote): only a change of
    // the attempt as well opens one of its own.
    const insert = (): void => void this.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(this.attemptId, this.turn, now(), event.type, JSON.stringify(event));
    if (change)
      transaction(this.db, () => {
        insert();
        this.updateAttempt(change);
      });
    else insert();
    for (const listener of this.listeners) listener(event);
  }

  private updateAttempt(change: { status?: string; resumeCursor?: string; model?: string; clearPgid?: boolean }): void {
    const sets = ["updated_at = ?"];
    const values: (string | number | null)[] = [now()];
    if (change.status) (sets.push("status = ?"), values.push(change.status));
    if (change.resumeCursor) (sets.push("resume_cursor = ?"), values.push(change.resumeCursor));
    if (change.model) (sets.push("model = ?"), values.push(change.model));
    if (change.clearPgid) sets.push("pgid = NULL");
    this.db.prepare(`UPDATE attempts SET ${sets.join(", ")} WHERE id = ?`).run(...values, this.attemptId);
  }
}

/** Write the attempt row, start the session's thread, and hand the session over; the process is ended if that fails. */
export async function startAppServerSession(o: AppServerSessionOptions): Promise<CodexAppServerSession> {
  const at = now();
  let attemptId: number;
  try {
    attemptId = Number(o.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'running', ?, ?, ?)").run(CODEX_DRIVER, o.model ?? null, o.transport.pgid || null, at, at).lastInsertRowid);
  } catch (err) {
    await o.transport.stop();
    throw err;
  }
  const session = new CodexAppServerSession(attemptId, o);
  try {
    await session.start();
  } catch (err) {
    await session.close().catch(() => {});
    o.db.prepare("UPDATE attempts SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('running', 'ended')").run(now(), attemptId);
    throw err;
  }
  return session;
}
