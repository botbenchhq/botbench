import readline from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "../store/db.ts";
import type { DriverCapabilities, DriverSession } from "./contract.ts";
import type { DriverEvent, PermissionResponse, TurnEndReason } from "./events.ts";
import { killProcessGroup, launch, processGroupAlive, type CliChild } from "./launch.ts";
import type { LineResult } from "./one-turn.ts";

/*
 * One turn of an agent driven through the Agent Client Protocol (ACP: JSON-RPC 2.0, one message per line on stdio),
 * in a process of its own: Antigravity's `agy acp`. Approach from OpenMausBot server/drivers/antigravity-acp.ts and
 * server/drivers/acp/core.ts: initialize, session/new with no MCP servers, the session's settings, one
 * session/prompt, and each session/request_permission answered, never left waiting.
 *
 * Seen on `agy acp` 1.5.14: initialize answers with agentInfo {"name":"Antigravity ACP Server","version":"1.5.14"};
 * session/new answers {"sessionId", "models": {"availableModels", "currentModelId"}, "modes", "configOptions"}, or the
 * error -32000 "Authentication required" when its profile holds no sign-in; session/set_model answers {}; the turn is
 * a stream of session/update notifications (agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update,
 * usage_update, …) and ends with the answer to session/prompt, {"stopReason": "end_turn", "usage": {…}}. A tool call
 * comes as tool_call (status in_progress), then, when it needs an answer, session/request_permission with options
 * "allow" (allow_once) and "deny" (reject_once), then tool_call_update with status completed or failed.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const shorten = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A tool call the agent asked permission for, as the session's `decide` is given it. */
export interface AcpToolRequest {
  /** The JSON-RPC id of the request, as text. */
  id: string;
  toolCallId: string;
  /** The tool's own name (`run_command`, `read_file`, …). */
  name: string;
  /** ACP's kind of the call: read, edit, delete, move, search, execute, fetch, other. */
  kind: string;
  rawInput: unknown;
  /** Every path the request names (`locations`, and the input's own path fields), as the agent gave them. */
  paths: string[];
}

/**
 * What Botbench does with a request: answer it at once (`allow`, `deny` with why), or put it through Botbench's
 * permission check as a `permission_request` with a tool name and input the broker reads (`ask`).
 */
export type AcpDecision = { answer: "allow"; rule: "files" | "web" } | { answer: "deny"; why: string } | { ask: { name: string; input: Record<string, unknown> } };

/** What one line of the agent's output means for the turn. */
export interface AcpLineResult {
  events: DriverEvent[];
  /** Why the turn must stop now, or null. */
  stop: string | null;
}

export interface AcpTurnSpec {
  /** The agent's name as a screen shows it. */
  agent: string;
  command: string;
  args: string[];
  cwd: string;
  extraEnv: Record<string, string>;
  capabilities: DriverCapabilities;
  /** The params of session/new. MCP servers are always none. */
  session: { cwd: string; additionalDirectories?: string[]; _meta?: unknown };
  /** The model to set with session/set_model, when one was chosen. */
  model?: string;
  /** Session settings to set, each confirmed by the agent's answer (session/set_config_option), before the prompt. */
  config?: readonly { id: string; value: string }[];
  /** A reader for the notifications of the turn: what the agent wrote and which tools it called. */
  reader(): (update: Record<string, unknown>) => AcpLineResult;
  /** Botbench's answer to a permission request. */
  decide(request: AcpToolRequest): AcpDecision;
  /**
   * The kinds of tool call (ACP's execute, edit, …) the agent must ask about before they run: one that completes with
   * no permission request first stops the turn. None when left out.
   */
  mustAsk?: readonly string[];
  /** Requests may be put to Botbench's permission check (the attempt was given a gate). Without, every `ask` is denied. */
  gated: boolean;
  /** Each line the agent printed, as printed: for a capture script only. */
  onLine?(line: string): void;
  cleanup?(): void;
}

/** What a session/new error means for the owner. -32000 is ACP's "auth_required", which the agent's words confirm. */
export function acpStartProblem(agent: string, error: unknown): string {
  const e = isObject(error) ? error : {};
  const message = str(e.message) ?? "";
  if (e.code === -32000 && /authenticat|sign.?in|log.?in/i.test(message)) return `${agent} is not signed in in Botbench. Connect it in Settings, Agents.`;
  return `${agent} could not start a session: ${shorten(message === "" ? JSON.stringify(error) : message, 300)}`;
}

/** Every path a permission request names. */
export function requestPaths(toolCall: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  if (Array.isArray(toolCall.locations)) for (const at of toolCall.locations) if (isObject(at) && typeof at.path === "string") paths.add(at.path);
  const raw = isObject(toolCall.rawInput) ? toolCall.rawInput : {};
  for (const [key, value] of Object.entries(raw)) if (/path|file|directory|dir$|^cwd$/i.test(key) && typeof value === "string" && value !== "") paths.add(value);
  return [...paths];
}

/**
 * A reader for the session/update notifications of one turn whose agent may call only `kept`. The reply comes in
 * pieces and is given as one text when the turn ends or a tool is called. A call of any other tool stops the turn.
 */
export function acpReader(agent: string, kept: readonly string[]): () => (update: Record<string, unknown>) => AcpLineResult {
  return () => {
    let reply = "";
    const allowed = new Set(kept);
    const none: AcpLineResult = { events: [], stop: null };
    return (update) => {
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const content = isObject(update.content) ? update.content : {};
          if (content.type === "text") reply += str(content.text) ?? "";
          return none;
        }
        case "tool_call": {
          const name = str(update.name) ?? str(update.title) ?? "unknown";
          const id = str(update.toolCallId) ?? "";
          const said: DriverEvent[] = reply.trim() === "" ? [] : [{ type: "text", text: reply }];
          reply = "";
          const events: DriverEvent[] = [...said, { type: "tool_call", id, name, input: update.rawInput ?? update.args ?? null }];
          return allowed.has(name) ? { events, stop: null } : { events, stop: `Stopped: ${agent} tried to use a tool Botbench did not give it (${shorten(name, 100)}). Update Botbench for this ${agent}.` };
        }
        case "tool_call_update": {
          const status = str(update.status);
          if (status !== "completed" && status !== "failed") return none;
          const raw = isObject(update.rawOutput) ? update.rawOutput : null;
          const output = raw !== null && typeof raw.output === "string" ? raw.output : raw !== null ? JSON.stringify(raw) : "";
          return { events: [{ type: "tool_result", id: str(update.toolCallId) ?? "", output: shorten(output, 20_000), isError: status === "failed" }], stop: null };
        }
        case "botbench_turn_end": {
          // Not the agent's: the reader's own marker for the answer to session/prompt (see AcpTurnSession).
          const result = isObject(update.result) ? update.result : {};
          const u = isObject(result.usage) ? result.usage : {};
          const events: DriverEvent[] = [];
          if (reply.trim() !== "") events.push({ type: "text", text: reply.replace(/\n+$/, "") });
          reply = "";
          // Antigravity's input count leaves out the cached part, which it gives on its own.
          events.push({ type: "usage", inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens), cacheReadTokens: count(u.cachedReadTokens), cacheWriteTokens: count(u.cachedWriteTokens) });
          const stopReason = str(result.stopReason);
          if (stopReason === "end_turn") events.push({ type: "turn_ended", reason: "completed", detail: null });
          else if (stopReason === "cancelled") events.push({ type: "turn_ended", reason: "interrupted", detail: `${agent} was stopped.` });
          else events.push({ type: "turn_ended", reason: "error", detail: `${agent} stopped before it finished its reply (${stopReason ?? "no reason given"}).` });
          return { events, stop: null };
        }
        default:
          return none;
      }
    };
  };
}

/**
 * The same reading over whole lines as the agent printed them, for a session played back from a capture
 * (test/support/replay-chat.ts): a session/new answer starts the session, its error ends the turn as AcpTurnSession
 * ends it, a notification goes to `acpReader`, and an answer with a stopReason is the turn's end. Requests are not
 * answered here: a capture holds what was answered when it was made.
 */
export function acpLines(agent: string, kept: readonly string[]): () => (line: string) => LineResult {
  return () => {
    const read = acpReader(agent, kept)();
    return (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return { events: [], stop: null };
      }
      if (!isObject(message)) return { events: [], stop: null };
      if (message.method === "session/update" && isObject(message.params) && isObject(message.params.update)) return read(message.params.update);
      if (message.method !== undefined) return { events: [], stop: null };
      if (message.error !== undefined && message.id === 2) {
        const detail = acpStartProblem(agent, message.error);
        return { events: [{ type: "error", message: detail, raw: null }, { type: "turn_ended", reason: "error", detail }], stop: null };
      }
      const result = isObject(message.result) ? message.result : {};
      if (typeof result.sessionId === "string") return { events: [{ type: "session_started", resumeCursor: result.sessionId, model: null, keySource: "none" }], stop: null };
      if (typeof result.stopReason === "string") return read({ sessionUpdate: "botbench_turn_end", result });
      return { events: [], stop: null };
    };
  };
}

/** How many times one message is continued after a refusal ended the agent's answer. */
export const MAX_CONTINUATIONS = 3;

/** Botbench's message that continues the agent's answer after what it asked for was refused. */
export function continuation(refused: readonly string[]): string {
  return `[From Botbench] What you last asked to do was not run. ${refused.join(" ")} Do not try it another way. Go on with the rest of the owner's message without it, and reply.`;
}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

interface Asking {
  rpcId: string | number;
  toolCallId: string;
  options: { allow: string | null; reject: string | null };
}

export class AcpTurnSession implements DriverSession {
  readonly attemptId: number;
  readonly capabilities: DriverCapabilities;
  private readonly db: DatabaseSync;
  private readonly spec: AcpTurnSpec;
  private readonly listeners = new Set<(event: DriverEvent) => void>();
  private turn = 0;
  private child: CliChild | null = null;
  private pgid = 0;
  private running: { resolve: (reason: TurnEndReason) => void } | null = null;
  private exited: Promise<void> = Promise.resolve();
  private interrupting = false;
  private over = false;
  private cursor: string | null = null;
  private stderrTail = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly asking = new Map<string, Asking>();
  private readonly called = new Set<string>();
  /** What was refused during the agent's current answer: what it asked for, and why, for the message that continues it. */
  private refused: string[] = [];
  /** Tool calls the agent asked permission for, and the kind of each call it reported. */
  private readonly askedFor = new Set<string>();
  private readonly kinds = new Map<string, string>();
  private read: ((update: Record<string, unknown>) => AcpLineResult) | null = null;

  constructor(db: DatabaseSync, attemptId: number, spec: AcpTurnSpec) {
    this.db = db;
    this.attemptId = attemptId;
    this.spec = spec;
    this.capabilities = spec.capabilities;
  }

  resumeCursor(): string | null {
    return this.cursor;
  }

  onEvent(listener: (event: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One turn per session: the agent here keeps no session and resumes none. */
  sendTurn(prompt: string): Promise<TurnEndReason> {
    if (this.over || this.turn > 0) return Promise.reject(new Error(`This session with ${this.spec.agent} has ended: Botbench gives ${this.spec.agent} one message per session.`));
    this.turn = 1;
    const done = new Promise<TurnEndReason>((resolve) => (this.running = { resolve }));
    this.record({ type: "user_prompt", text: prompt });
    const { child, pgid } = launch(this.spec.command, this.spec.args, { cwd: this.spec.cwd, extraEnv: this.spec.extraEnv });
    this.child = child;
    this.pgid = pgid;
    if (pgid) this.db.prepare("UPDATE attempts SET pgid = ?, updated_at = ? WHERE id = ?").run(pgid, now(), this.attemptId);
    this.read = this.spec.reader();
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    // Never shown whole: a sign-in link the agent prints when its sign-in is refused carries a state.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-2000)));
    child.stdin.on("error", () => {});
    let spawnError: Error | null = null;
    child.on("error", (err) => (spawnError = err));
    this.exited = new Promise((resolve) => child.once("close", (code, signal) => void this.onExit(code, signal, spawnError).finally(resolve)));
    void this.drive(prompt);
    return done;
  }

  async interruptTurn(): Promise<void> {
    if (!this.running) return;
    this.interrupting = true;
    this.cancelAsking();
    if (this.pgid) await killProcessGroup(this.pgid);
    await this.exited;
  }

  respondToRequest(requestId: string, response: unknown): Promise<void> {
    const request = this.asking.get(requestId);
    if (!request) return Promise.reject(new Error(`No permission request ${requestId} is waiting in this session: it was answered already, or ${this.spec.agent} stopped waiting for it.`));
    if (this.child === null || !this.child.stdin.writable) return Promise.reject(new Error(`The answer to permission request ${requestId} could not be delivered: ${this.spec.agent} is no longer running. Nothing was run.`));
    this.asking.delete(requestId);
    const given: Partial<PermissionResponse> = isObject(response) ? response : {};
    const words = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    // Only the exact word allows. Anything else, a malformed answer included, declines.
    if (given.decision === "allow" && request.options.allow !== null) {
      this.answerPermission(request, "allow");
      this.record({ type: "permission_resolved", id: requestId, toolCallId: request.toolCallId, decision: given.preapproved === true ? "preapproved" : given.standing === true ? "standing" : given.mode === true ? "mode" : given.files === true ? "files" : given.web === true ? "web" : given.chat === true ? "chat" : given.bookkeeping === true ? "bookkeeping" : "allowed", note: null });
    } else if (words(given.refused) !== null) {
      this.answerPermission(request, "reject");
      this.record({ type: "permission_resolved", id: requestId, toolCallId: request.toolCallId, decision: "denied", note: words(given.refused) });
      this.refused.push(`Botbench refused it without asking the owner: ${words(given.refused)}`);
    } else {
      this.answerPermission(request, "reject");
      this.record({ type: "permission_resolved", id: requestId, toolCallId: request.toolCallId, decision: "declined", note: words(given.note) });
      this.refused.push(words(given.note) === null ? "The owner said no to it." : `The owner said no to it, and wrote: ${words(given.note)}`);
    }
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.running) await this.interruptTurn();
    this.over = true;
    if (this.pgid) await killProcessGroup(this.pgid).catch(() => {});
    await this.exited;
    if (this.turn === 0) this.spec.cleanup?.();
    this.db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), this.attemptId);
  }

  /** initialize, session/new, the model and settings, then the prompt. Any failure ends the turn with what failed. */
  private async drive(prompt: string): Promise<void> {
    try {
      await this.request("initialize", { protocolVersion: 1, clientInfo: { name: "botbench", version: "0.1.0" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      let session: unknown;
      try {
        session = await this.request("session/new", { ...this.spec.session, mcpServers: [] });
      } catch (err) {
        return this.fail(acpStartProblem(this.spec.agent, err));
      }
      const sessionId = isObject(session) ? str(session.sessionId) : null;
      if (sessionId === null) return this.fail(`${this.spec.agent} started no session: its answer named none.`);
      this.cursor = sessionId;
      const models = isObject(session) && isObject(session.models) ? session.models : {};
      if (this.spec.model !== undefined) await this.request("session/set_model", { sessionId, modelId: this.spec.model });
      this.record({ type: "session_started", resumeCursor: sessionId, model: this.spec.model ?? str(models.currentModelId), keySource: "none" });
      for (const { id, value } of this.spec.config ?? []) {
        const answer = await this.request("session/set_config_option", { sessionId, configId: id, value });
        const options = isObject(answer) && Array.isArray(answer.configOptions) ? answer.configOptions : [];
        const current = options.find((o): o is Record<string, unknown> => isObject(o) && o.id === id);
        // Not confirmed is not set: the turn does not run on a setting the agent did not take.
        if (current?.currentValue !== value) return this.fail(`${this.spec.agent} did not take the setting ${id} = ${value}, so Botbench did not send it the message.`);
      }
      if (!this.running) return;
      let text = prompt;
      for (let round = 0; ; round++) {
        this.refused = [];
        const result = await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        // Seen on 1.5.14: a refused tool call ends the agent's turn at once, with no reply. Botbench tells it what was
        // refused and why, in the same session, so it can go on without it (as Claude Code is told in a denial), a few times at most.
        const refused = this.refused;
        if (refused.length === 0 || round >= MAX_CONTINUATIONS || !this.running || !(isObject(result) && result.stopReason === "end_turn")) {
          this.onUpdate({ sessionUpdate: "botbench_turn_end", result });
          return;
        }
        text = continuation(refused);
      }
    } catch (err) {
      if (this.running && !this.interrupting) this.fail(`${this.spec.agent} failed: ${shorten(err instanceof Error ? err.message : isObject(err) ? (str(err.message) ?? JSON.stringify(err)) : String(err), 300)}`);
    }
  }

  private fail(detail: string): void {
    if (!this.running) return;
    this.record({ type: "error", message: detail, raw: null });
    this.endTurn("error", detail);
    if (this.pgid) void killProcessGroup(this.pgid).catch(() => {});
  }

  private write(message: unknown): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onLine(line: string): void {
    this.spec.onLine?.(line);
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.record({ type: "error", message: `${this.spec.agent} printed a line Botbench could not read.`, raw: shorten(line) });
    }
    if (!isObject(message)) return;
    if (typeof message.method === "string" && message.id !== undefined) return this.onRequest(message);
    if (typeof message.method === "string") {
      if (message.method === "session/update" && isObject(message.params) && isObject(message.params.update)) this.onUpdate(message.params.update);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(message.error);
      else pending.resolve(message.result);
    }
  }

  private onUpdate(update: Record<string, unknown>): void {
    if (this.read === null) return;
    const callId = str(update.toolCallId);
    if (callId !== null && typeof update.kind === "string") this.kinds.set(callId, update.kind);
    if (update.sessionUpdate === "tool_call_update" && callId !== null && update.status === "completed" && !this.askedFor.has(callId) && (this.spec.mustAsk ?? []).includes(this.kinds.get(callId) ?? "")) {
      const why = `Stopped: ${this.spec.agent} ran a tool call (${this.kinds.get(callId)}) without asking Botbench first. Update Botbench for this ${this.spec.agent}.`;
      this.record({ type: "error", message: why, raw: null });
      if (this.running) this.endTurn("error", why);
      return;
    }
    const { events, stop } = this.read(update);
    for (const event of events) {
      if (event.type === "turn_ended") {
        if (this.running) this.endTurn(event.reason, event.detail);
        continue;
      }
      if (event.type === "tool_call") {
        if (this.called.has(event.id)) continue;
        this.called.add(event.id);
      }
      this.record(event);
    }
    if (stop !== null && this.running) {
      this.record({ type: "error", message: stop, raw: null });
      this.endTurn("error", stop);
      if (this.pgid) void killProcessGroup(this.pgid).catch(() => {});
    }
  }

  /** The agent asks its host. A permission request is decided or put to Botbench; anything else is refused at once. */
  private onRequest(message: Record<string, unknown>): void {
    const rpcId = message.id as string | number;
    if (message.method !== "session/request_permission" || !isObject(message.params) || !isObject(message.params.toolCall)) {
      this.write({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Botbench does not answer this request." } });
      return;
    }
    const toolCall = message.params.toolCall;
    const choices = Array.isArray(message.params.options) ? message.params.options.filter(isObject) : [];
    const pick = (kind: "allow" | "reject"): string | null => str(choices.find((o) => o.kind === `${kind}_once`)?.optionId) ?? str(choices.find((o) => String(o.kind ?? "").startsWith(kind))?.optionId);
    const asking: Asking = { rpcId, toolCallId: str(toolCall.toolCallId) ?? "", options: { allow: pick("allow"), reject: pick("reject") } };
    this.askedFor.add(asking.toolCallId);
    const id = String(rpcId);
    const request: AcpToolRequest = { id, toolCallId: asking.toolCallId, name: str(toolCall.name) ?? str(toolCall.title) ?? "unknown", kind: str(toolCall.kind) ?? "other", rawInput: toolCall.rawInput ?? null, paths: requestPaths(toolCall) };
    let decision: AcpDecision;
    try {
      decision = this.running ? this.spec.decide(request) : { answer: "deny", why: "Nothing is being answered now." };
    } catch (err) {
      // What cannot be decided is denied.
      decision = { answer: "deny", why: `Botbench could not check this request (${err instanceof Error ? err.message : String(err)}).` };
    }
    if ("ask" in decision && this.spec.gated) {
      this.asking.set(id, asking);
      this.record({ type: "permission_request", id, toolCallId: asking.toolCallId, name: decision.ask.name, input: decision.ask.input, reason: null });
      return;
    }
    if ("answer" in decision && decision.answer === "allow" && asking.options.allow !== null) {
      this.answerPermission(asking, "allow");
      this.record({ type: "permission_resolved", id, toolCallId: asking.toolCallId, decision: decision.rule, note: null });
      return;
    }
    const why = "why" in decision ? decision.why : "Botbench cannot put this request to you here, so it was refused.";
    this.answerPermission(asking, "reject");
    this.record({ type: "permission_resolved", id, toolCallId: asking.toolCallId, decision: "denied", note: why });
    this.refused.push(`Botbench refused it without asking the owner: ${why}`);
  }

  private answerPermission(request: Asking, answer: "allow" | "reject"): void {
    const optionId = answer === "allow" ? request.options.allow : request.options.reject;
    // With no option of the kind the agent offered, the request is cancelled: never an allow by guessing.
    this.write({ jsonrpc: "2.0", id: request.rpcId, result: { outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } } });
  }

  /** The agent no longer waits for its requests: say so in the transcript. */
  private cancelAsking(): void {
    for (const [id, request] of [...this.asking]) {
      this.asking.delete(id);
      this.write({ jsonrpc: "2.0", id: request.rpcId, result: { outcome: { outcome: "cancelled" } } });
      this.record({ type: "permission_resolved", id, toolCallId: request.toolCallId, decision: "cancelled", note: null });
    }
  }

  private endTurn(reason: TurnEndReason, detail: string | null): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    this.cancelAsking();
    const status = reason === "completed" ? null : reason === "interrupted" ? "interrupted" : "failed";
    this.record({ type: "turn_ended", reason, detail }, status);
    running.resolve(reason);
    // The turn is over: the process goes, whatever it may still be doing.
    if (this.pgid) void killProcessGroup(this.pgid, { graceMs: 1000 }).catch(() => {});
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): Promise<void> {
    for (const pending of this.pending.values()) pending.reject(new Error(`${this.spec.agent} is no longer running.`));
    this.pending.clear();
    if (this.running) {
      if (this.interrupting) this.endTurn("interrupted", `${this.spec.agent} was stopped.`);
      else {
        const how = spawnError ? spawnError.message : signal ? `was killed by ${signal}` : `exited with code ${code}`;
        const message = `${this.spec.agent} ${how} before it finished.`;
        // Its last words, with any link taken out: a sign-in link carries a state.
        const tail = this.stderrTail.replace(/https:\/\/\S+/g, "<link>").trim();
        this.record({ type: "error", message, raw: tail === "" ? null : shorten(tail) });
        this.endTurn("error", message);
      }
    }
    this.asking.clear();
    if (this.pgid) await killProcessGroup(this.pgid).catch(() => {});
    if (!processGroupAlive(this.pgid)) this.db.prepare("UPDATE attempts SET pgid = NULL, updated_at = ? WHERE id = ?").run(now(), this.attemptId);
    this.db.prepare("UPDATE attempts SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'running'").run(now(), this.attemptId);
    this.over = true;
    this.spec.cleanup?.();
  }

  private record(event: DriverEvent, status: string | null = null): void {
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(this.attemptId, this.turn, now(), event.type, JSON.stringify(event));
      if (status !== null) this.db.prepare("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), this.attemptId);
    });
    for (const listener of this.listeners) listener(event);
  }
}

/** Make the attempt one ACP turn runs in, and its session. */
export function startAcpTurn(db: DatabaseSync, driver: string, model: string | null, spec: AcpTurnSpec): AcpTurnSession {
  const at = now();
  const { lastInsertRowid } = db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'running', NULL, ?, ?)").run(driver, model, at, at);
  return new AcpTurnSession(db, Number(lastInsertRowid), spec);
}
