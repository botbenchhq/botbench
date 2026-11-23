import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { askThroughBroker, CHAT_ROLE, logSandboxedCalls, type Broker } from "../approvals/broker.ts";
import { chatWebAccess } from "../approvals/web-access.ts";
import { CLAUDE_CODE } from "../drivers/claude-code.ts";
import { makeReviewFolder } from "../drivers/cli-sandbox.ts";
import { DriverUnavailableError, type Driver, type DriverSession } from "../drivers/contract.ts";
import type { DriverEvent } from "../drivers/events.ts";
import { captureNote, MemoryError, memorySection, rememberedNote } from "../engine/memory.ts";
import { REVIEW_LIMIT_MS } from "../engine/review.ts";
import { agentName, chatPrompt, comparePrompt, type ChatEntry } from "../engine/roles.ts";
import { checkRepository, TaskError } from "../engine/task.ts";
import { now, transaction } from "../store/db.ts";
import { recordChat } from "../engine/chats.ts";
import { sharedGitDir } from "../worktrees.ts";
import { SCRATCH_DIR, TurnError, type Turns } from "./turns.ts";

/*
 * Chat with any agent, or several at once. Claude Code keeps a conversation in its own session and is continued from
 * it (api/turns.ts) while it is the only agent that has answered since its last reply. Codex, Grok and Antigravity keep
 * none here (capability `resume: false`): each message to one of them is one turn, and Botbench sends it the chat so
 * far, as data, before the new message (engine/roles.ts, `chatPrompt`). Claude Code is sent the same when another agent
 * answered since its last reply. Codex and Grok (capability `chatTools`) cannot ask before they act, so their sandbox is
 * the control: each works in the chat's own folder, the one Claude Code uses, where it reads, writes and runs commands;
 * reads a repository the owner attached and never changes it; its commands reach no network; and its own web search,
 * which its provider runs, follows the owner's "Web access in chat" (Allow only: they cannot ask, so Ask is Off for
 * them). Antigravity gets the same folder and places inside Botbench's sandbox, and asks Botbench before it acts
 * (capability `permissionRequests`): each request goes through the broker as a chat's (drivers/antigravity.ts).
 *
 * What a chat is made of is stored: every attempt a chat started (`chat_attempts`), and each message sent to agents
 * given the conversation by Botbench, or each request to compare answers (`chat_rounds`). Only a chat's own attempts
 * are read back as its conversation, so nothing a task or a review wrote is ever passed on. The owner's device keeps
 * which attempts make up the chat on screen, as before. Nothing an agent writes is run: it is shown as text and passed
 * on as data.
 *
 * Memory (engine/memory.ts, ADR 0006): the owner's new message, when it starts "Remember:" or "Remember that", saves
 * the rest of it as a note before it is sent. Nothing else here is ever saved. Every agent asked is given the notes,
 * as data, before the conversation.
 */

/** The most agents one message is sent to. */
export const MAX_ASKED = 4;

export interface ChatTarget {
  agent: string;
  /** A model name, null for the agent's own default, undefined for the configured one. */
  model: string | null | undefined;
}

export interface ChatReply {
  attemptId: number;
  turn: number;
  agent: string;
  model: string | null;
  roundId: number | null;
}

export interface ChatRound {
  id: number;
  kind: "ask" | "compare";
  message: string;
  compares: number | null;
}

/** What a screen needs to show an attempt of a chat: who answered, and the message it answered. */
export interface ChatAttemptInfo {
  agent: string;
  model: string | null;
  /** Null for an attempt no chat started, or a Claude Code session that kept the conversation itself. */
  round: ChatRound | null;
  /** True for an attempt a chat started. */
  chat: boolean;
}

export interface Chat {
  /**
   * Send one message, or a request to compare a round's answers, to each agent asked. Resolves once each has started or
   * is recorded as failed. `repository`: a repository the owner attached, which the agents asked read and never change;
   * only an agent with its own tools in a chat (Codex, Grok) can be asked then.
   */
  send(o: { message: string; conversation: readonly number[]; agents: readonly ChatTarget[]; compare?: number; repository?: string }): Promise<ChatReply[]>;
  /** Stop a running chat turn of an agent with no conversation of its own. False when no such turn runs in this attempt. */
  interrupt(attemptId: number): Promise<boolean>;
  turnRunning(attemptId: number): boolean;
  info(attemptId: number): ChatAttemptInfo | null;
  close(): Promise<void>;
}

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const minutes = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`);

function roundOf(db: DatabaseSync, id: number | null): ChatRound | null {
  if (id === null) return null;
  const row = db.prepare("SELECT id, kind, message, compares FROM chat_rounds WHERE id = ?").get(id);
  return row ? { id: Number(row.id), kind: String(row.kind) as ChatRound["kind"], message: String(row.message), compares: row.compares === null ? null : Number(row.compares) } : null;
}

export function chatAttemptInfo(db: DatabaseSync, attemptId: number): ChatAttemptInfo | null {
  const row = db.prepare("SELECT a.driver, a.model, c.attempt_id AS chat, c.round_id FROM attempts a LEFT JOIN chat_attempts c ON c.attempt_id = a.id WHERE a.id = ?").get(attemptId);
  if (!row) return null;
  return { agent: String(row.driver), model: row.model === null ? null : String(row.model), round: roundOf(db, row.round_id === null ? null : Number(row.round_id)), chat: row.chat !== null };
}

/** The model an attempt answered with, as its session named it, else as it was asked for. */
function answeredModel(events: readonly DriverEvent[], asked: string | null): string {
  const started = events.find((e): e is Extract<DriverEvent, { type: "session_started" }> => e.type === "session_started" && typeof e.model === "string");
  return started?.model ?? asked ?? "its default model";
}

/** An agent's reply as another agent is told who wrote it: "Codex (gpt-6-luna)". */
const replyFrom = (agent: string, model: string): string => `${agentName(agent)} (${model})`;

/** An attempt's events by turn, oldest first. */
function turnsOf(db: DatabaseSync, attemptId: number): DriverEvent[][] {
  const turns = new Map<number, DriverEvent[]>();
  for (const row of db.prepare("SELECT turn, payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId)) {
    const turn = Number(row.turn);
    if (!turns.has(turn)) turns.set(turn, []);
    turns.get(turn)!.push(JSON.parse(String(row.payload)) as DriverEvent);
  }
  return [...turns.entries()].sort(([a], [b]) => a - b).map(([, events]) => events);
}

const replyText = (events: readonly DriverEvent[]): string =>
  events
    .filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("\n\n");

/** What the owner said for a round, as the conversation passed on says it. */
const roundWords = (round: ChatRound): string => (round.kind === "compare" ? "The owner asked for a comparison of the answers above." : round.message);

/**
 * A chat's conversation so far, oldest first: the owner's messages and the agents' replies, text only (no tool output,
 * no prompt Botbench framed). Refuses an attempt no chat started.
 */
export function chatHistory(db: DatabaseSync, conversation: readonly number[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const said = new Set<number>();
  for (const attemptId of conversation) {
    const info = chatAttemptInfo(db, attemptId);
    if (info === null || !info.chat) throw new TurnError(409, "This chat began before Botbench could pass a chat on to another agent. Start a new chat to ask another agent.");
    for (const [at, events] of turnsOf(db, attemptId).entries()) {
      const framed = info.round !== null && at === 0;
      if (framed && !said.has(info.round!.id)) {
        said.add(info.round!.id);
        entries.push({ from: "owner", text: roundWords(info.round!) });
      } else if (!framed) {
        const prompt = events.find((e): e is Extract<DriverEvent, { type: "user_prompt" }> => e.type === "user_prompt");
        if (prompt !== undefined) entries.push({ from: "owner", text: prompt.text });
      }
      const text = replyText(events);
      if (text.trim() !== "") entries.push({ from: replyFrom(info.agent, answeredModel(events, info.model)), text });
    }
  }
  return entries;
}

/**
 * The Claude Code attempt a message to Claude Code alone continues, keeping its own session: the chat's newest attempt,
 * when it is Claude Code's and no other agent answered beside it. Null when Claude Code must be given the conversation.
 * Undefined for a chat with nothing in it yet.
 */
export function claudeContinues(db: DatabaseSync, conversation: readonly number[]): number | null | undefined {
  const last = conversation.at(-1);
  if (last === undefined) return undefined;
  const info = chatAttemptInfo(db, last);
  if (info === null || info.agent !== CLAUDE_CODE) return null;
  if (info.round === null) return last;
  const members = Number(db.prepare("SELECT count(*) AS n FROM chat_attempts WHERE round_id = ?").get(info.round.id)!.n);
  return members === 1 && info.round.kind === "ask" ? last : null;
}

export interface ChatOptions {
  db: DatabaseSync;
  /** Botbench's data folder: each chat turn of an agent with no conversation of its own works in a new empty folder in it. */
  home: string;
  turns: Turns;
  claude: Driver;
  /** The agents with no conversation of their own here, by name. */
  agents: Partial<Record<string, Driver>>;
  /**
   * Where the requests of an agent that asks before it acts (Antigravity) go, as a chat's. Without it, everything such
   * an agent would ask is refused.
   */
  broker?: Pick<Broker, "admit" | "request">;
  onEvent: () => void;
  /** The time a chat turn of such an agent gets: a review's. */
  limitMs?: number;
}

/**
 * What an agent other than Claude Code can do in a chat, in one plain sentence for the screen (docs/product/voice.md).
 * For one with its own tools, the sandbox is the control, since it cannot ask before it acts, and the sentence says so.
 * Null for Claude Code, which asks you itself.
 */
export function chatScopeWords(driver: Pick<Driver, "name" | "capabilities">): string | null {
  if (driver.name === CLAUDE_CODE) return null;
  const name = agentName(driver.name);
  if (driver.capabilities.chatTools !== true) return `${name} answers from the conversation alone: it cannot read your files or change anything here. Botbench gives it the chat so far.`;
  if (driver.capabilities.permissionRequests) return `${name} works only in the chat's own folder, inside Botbench's sandbox: there it reads, changes and runs commands without asking, and anything outside it asks you first. Its commands reach nothing on the network but its own provider, and it searches the web only when Web access is Allow. Botbench gives it the chat so far.`;
  return `${name} cannot ask you before it acts, so Botbench's sandbox is what keeps it in bounds: in a chat it can read, change and run things only in the chat's own folder, its commands reach nothing on the network but its own provider, and it searches the web only when Web access is Allow. Botbench gives it the chat so far.`;
}

/**
 * Whether an agent reads a repository attached to a chat: one with its own tools, read-only there. Claude Code is never
 * given one in a chat (it works on a repository as a task, in a separate copy); one without tools answers from the
 * conversation alone. The one rule for both the request's check and what /api/agents tells the screen.
 */
export const readsChatRepository = (driver: Pick<Driver, "name" | "capabilities">): boolean => driver.name !== CLAUDE_CODE && driver.capabilities.chatTools === true;

/**
 * The repository a chat was given, checked and resolved once (docs/lessons.md, unit 10): its real path and its shared
 * git folder, which the agents read and never change. Botbench's data folder may be neither inside it nor around it:
 * reading the repository would then read Botbench's own files.
 */
export async function chatRepository(input: unknown, home: string): Promise<{ path: string; gitDir: string }> {
  let repo: string;
  let gitDir: string;
  try {
    repo = fs.realpathSync(await checkRepository(input));
    gitDir = await sharedGitDir(repo);
  } catch (err) {
    throw new TurnError(400, err instanceof TaskError ? err.message : `Botbench could not attach that repository: ${words(err)}`);
  }
  const data = fs.realpathSync(home);
  const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}${path.sep}`);
  if (within(repo, data) || within(data, repo) || within(gitDir, data) || within(data, gitDir)) throw new TurnError(400, "That folder holds Botbench's own data, or lies inside it, so it cannot be attached to a chat.");
  return { path: repo, gitDir };
}

export function createChat(o: ChatOptions): Chat {
  const { db } = o;
  const limitMs = o.limitMs ?? REVIEW_LIMIT_MS;
  // The chat's own folder, which Claude Code works in too (api/turns.ts): an agent with its own tools reads, writes and runs commands there.
  fs.mkdirSync(path.join(o.home, SCRATCH_DIR), { recursive: true, mode: 0o700 });
  const chatFolder = fs.realpathSync(path.join(o.home, SCRATCH_DIR));
  const running = new Map<number, { session: DriverSession; done: Promise<void> }>();
  let closed = false;

  const driverOf = (agent: string): Driver | undefined => (agent === CLAUDE_CODE ? o.claude : Object.hasOwn(o.agents, agent) ? o.agents[agent] : undefined);
  const join = (attemptId: number, roundId: number | null): void => {
    db.prepare("INSERT OR IGNORE INTO chat_attempts (attempt_id, round_id, created_at) VALUES (?, ?, ?)").run(attemptId, roundId, now());
  };

  /** Record that an agent could not start on a round: an attempt that ended at once, with the reason. */
  const failed = (agent: string, model: string | null, roundId: number, problem: string): ChatReply => {
    const id = transaction(db, () => {
      const at = now();
      const attemptId = Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, NULL, 'failed', NULL, ?, ?)").run(agent, model, at, at).lastInsertRowid);
      join(attemptId, roundId);
      const event: DriverEvent = { type: "turn_ended", reason: "error", detail: problem };
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attemptId, at, event.type, JSON.stringify(event));
      return attemptId;
    });
    o.onEvent();
    return { attemptId: id, turn: 1, agent, model, roundId };
  };

  /**
   * One turn of an agent with no conversation of its own, with a time limit. One with its own tools in a chat works in
   * the chat's folder, reads `repository` without changing it, and searches the web as the owner's setting allows; any
   * other answers in a new empty folder, removed afterwards, read-only.
   */
  const askOne = async (driver: Driver, model: string | null, roundId: number, prompt: string, repository: { path: string; gitDir: string } | null): Promise<ChatReply> => {
    const name = agentName(driver.name);
    const tools = driver.capabilities.chatTools === true;
    const folder = tools ? { path: chatFolder, remove: () => {} } : makeReviewFolder(o.home);
    let session: DriverSession;
    let admission: ReturnType<Broker["admit"]> | null = null;
    try {
      const how = tools
        ? { chatTools: { readable: repository === null ? [] : [repository.path, repository.gitDir] }, webSearch: chatWebAccess(db) === "allow" }
        : // Exactly what the review station asks for, in a folder with nothing in it: read-only, no host, no way to ask.
          { readOnly: true };
      // An agent that asks is admitted as a chat's, its commands confined (its whole process is in Botbench's sandbox).
      admission = tools && driver.capabilities.permissionRequests && o.broker !== undefined ? o.broker.admit({ chat: true, role: CHAT_ROLE, worktree: folder.path, confined: driver.capabilities.confinedCommands === true }) : null;
      session = await driver.startAttempt({ db, cwd: folder.path, ...how, ...(admission === null ? {} : { gate: { socketPath: admission.socketPath, secret: admission.secret } }), confinement: { dataDir: o.home, allowedHosts: [] }, ...(model === null ? {} : { model }) });
    } catch (err) {
      admission?.release();
      folder.remove();
      return failed(driver.name, model, roundId, `${name} could not answer: ${err instanceof DriverUnavailableError ? (err.probe.problem ?? err.message) : words(err)}`);
    }
    admission?.bind(session.attemptId);
    join(session.attemptId, roundId);
    session.onEvent(o.onEvent);
    const where = repository === null ? "the chat's folder" : "the chat's folder, the attached repository read-only";
    if (tools && driver.capabilities.permissionRequests) askThroughBroker(db, o.broker ?? { request: async () => ({ decision: "decline", note: null, approvalId: null, refused: "Botbench's permission check is not set up for this chat." }) }, session, { who: { taskId: null, chat: true }, role: CHAT_ROLE, agent: name, cwd: folder.path, where });
    else if (tools) logSandboxedCalls(db, session, { agent: name, taskId: null, cwd: folder.path, where });
    const timer = setTimeout(() => {
      const event: DriverEvent = { type: "error", message: `${name} did not finish within ${minutes(limitMs)} and was stopped.`, raw: null };
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(session.attemptId, now(), event.type, JSON.stringify(event));
      o.onEvent();
      void session.interruptTurn().catch(() => {});
    }, limitMs);
    const turn = session.sendTurn(prompt);
    const done = turn
      .catch(() => "error" as const)
      .finally(() => clearTimeout(timer))
      .then(() => session.close().catch(() => {}))
      .finally(() => {
        running.delete(session.attemptId);
        admission?.release();
        folder.remove();
      });
    running.set(session.attemptId, { session, done });
    return { attemptId: session.attemptId, turn: 1, agent: driver.name, model, roundId };
  };

  /** Claude Code given the conversation by Botbench, in a new session of its own. */
  const askClaude = async (model: string | null | undefined, roundId: number, prompt: string): Promise<ChatReply> => {
    try {
      const started = await o.turns.start(prompt, undefined, model, (attemptId) => join(attemptId, roundId));
      return { ...started, agent: CLAUDE_CODE, model: model ?? null, roundId };
    } catch (err) {
      return failed(CLAUDE_CODE, model ?? null, roundId, `Claude Code could not answer: ${err instanceof DriverUnavailableError ? (err.probe.problem ?? err.message) : words(err)}`);
    }
  };

  const sendOnce: Chat["send"] = async ({ message, conversation, agents, compare, repository: attached }) => {
    if (closed) throw new TurnError(503, "Botbench is shutting down.");
    if (agents.length < 1 || agents.length > MAX_ASKED) throw new TurnError(400, `Ask between 1 and ${MAX_ASKED} agents.`);
    if (new Set(agents.map((a) => a.agent)).size !== agents.length) throw new TurnError(400, "Each agent can be asked once per message.");
    for (const { agent } of agents) if (driverOf(agent) === undefined) throw new TurnError(400, `Botbench has no agent called ${JSON.stringify(agent)} to ask.`);
    if (compare !== undefined && agents.length !== 1) throw new TurnError(400, "Ask one agent to compare the answers.");
    let repository: { path: string; gitDir: string } | null = null;
    if (attached !== undefined) {
      // Only Claude Code changes a repository, as a task in a separate copy; in a chat the others read it.
      if (agents.some(({ agent }) => agent === CLAUDE_CODE)) throw new TurnError(400, "Claude Code works on a repository as a task, in a separate copy. Send it without other agents to start one, or remove the repository to chat with it.");
      const cannot = agents.find(({ agent }) => !readsChatRepository(driverOf(agent)!));
      if (cannot !== undefined) throw new TurnError(400, `${agentName(cannot.agent)} cannot read a repository in Botbench: it answers from the conversation alone. Remove the repository to ask it.`);
      repository = await chatRepository(attached, o.home);
    }

    // The owner's own message, and only it, may save a note to memory (engine/memory.ts): never a request to compare,
    // never an agent's reply in the conversation, which is not read here.
    const remembered = compare === undefined ? rememberedNote(message) : null;
    const remember = (): void => {
      if (remembered === null) return;
      try {
        captureNote(db, o.home, remembered);
      } catch (err) {
        if (err instanceof MemoryError) throw new TurnError(err.status, `${err.message} Nothing was sent.`);
        throw err;
      }
    };

    // A message to Claude Code alone, while it is the only agent that has answered since its last reply, continues its
    // own session. A new chat when there are notes in memory, or one being saved now, is given them as any agent is:
    // through the conversation Botbench sends, below.
    if (compare === undefined && agents.length === 1 && agents[0]!.agent === CLAUDE_CODE) {
      const continues = claudeContinues(db, conversation);
      if (continues !== null && !(continues === undefined && (remembered !== null || memorySection(o.home) !== undefined))) {
        remember();
        const started = await o.turns.start(message, continues, agents[0]!.model, (attemptId) => join(attemptId, null));
        join(started.attemptId, null);
        return [{ ...started, agent: CLAUDE_CODE, model: agents[0]!.model ?? null, roundId: null }];
      }
    }

    /** What each agent is sent: Claude Code, Codex and Grok keep their tools in a chat, Antigravity answers from the conversation alone. */
    let prompt: (agent: string) => string;
    let round: { kind: "ask" | "compare"; message: string; compares: number | null };
    if (compare !== undefined) {
      const compared = roundOf(db, compare);
      if (compared === null || compared.kind !== "ask") throw new TurnError(404, "Botbench has no record of those answers.");
      const answers = db
        .prepare("SELECT attempt_id FROM chat_attempts WHERE round_id = ? ORDER BY attempt_id")
        .all(compare)
        .flatMap((row) => {
          const info = chatAttemptInfo(db, Number(row.attempt_id))!;
          const events = turnsOf(db, Number(row.attempt_id))[0] ?? [];
          const text = replyText(events);
          return text.trim() === "" ? [] : [{ from: replyFrom(info.agent, answeredModel(events, info.model)), text }];
        });
      if (answers.length < 2) throw new TurnError(409, "There are fewer than two answers to compare.");
      const comparison = comparePrompt({ question: compared.message, answers });
      prompt = () => comparison;
      round = { kind: "compare", message: compared.message, compares: compare };
    } else {
      const history = chatHistory(db, conversation);
      // Read once the note this message saves is in memory (below), so the agents are given it too.
      let memory: string | undefined | null = null;
      prompt = (agent) => {
        const tools = agent === CLAUDE_CODE || driverOf(agent)!.capabilities.chatTools === true;
        if (memory === null) memory = memorySection(o.home);
        return chatPrompt({ history, message, tools, memory, ...(repository === null ? {} : { repository: repository.path }) }).prompt;
      };
      round = { kind: "ask", message, compares: null };
    }

    // Each agent asked must be usable now; otherwise nothing is sent to any of them.
    const probes = await Promise.all(agents.map(({ agent }) => driverOf(agent)!.probe().catch((err: unknown) => ({ problem: words(err) }))));
    const down = probes.findIndex((p) => p.problem !== null);
    if (down !== -1) throw new TurnError(409, `${agentName(agents[down]!.agent)} cannot answer now: ${probes[down]!.problem} Nothing was sent.`);
    if (closed) throw new TurnError(503, "Botbench is shutting down.");
    remember();

    const roundId = Number(db.prepare("INSERT INTO chat_rounds (kind, message, compares, created_at) VALUES (?, ?, ?, ?)").run(round.kind, round.message, round.compares, now()).lastInsertRowid);
    return Promise.all(agents.map(({ agent, model }) => (agent === CLAUDE_CODE ? askClaude(model, roundId, prompt(agent)) : askOne(driverOf(agent)!, model ?? null, roundId, prompt(agent), repository))));
  };

  /** Send, then record which chat the replies belong to, so the chat is a row of the Work list (engine/chats.ts). */
  const send: Chat["send"] = async (o) => {
    const replies = await sendOnce(o);
    recordChat(db, o.conversation, replies.map((reply) => reply.attemptId));
    return replies;
  };

  const interrupt = async (attemptId: number): Promise<boolean> => {
    const entry = running.get(attemptId);
    if (entry === undefined) return false;
    await entry.session.interruptTurn();
    return true;
  };

  const close = async (): Promise<void> => {
    closed = true;
    await Promise.allSettled([...running.values()].map(async ({ session, done }) => {
      await session.interruptTurn().catch(() => {});
      await done;
    }));
  };

  return { send, interrupt, turnRunning: (id) => running.has(id), info: (id) => chatAttemptInfo(db, id), close };
}
