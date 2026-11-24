import type { AgentState, ChatRound, ChatTarget, StoredEvent } from "../api/client.ts";
import type { ModelRequest } from "./composer.ts";

/*
 * Chat with any agent, or several at once, as plain functions so they are tested without a browser: which agents a
 * chat offers, who Send asks, and how the transcript of a chat several agents answered reads. The server checks every
 * choice again itself (src/api/chat.ts).
 */

export const CLAUDE = "claude-code";

/** An agent by its product name (docs/product/voice.md). */
export const agentName = (agent: string): string => ({ "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", grok: "Grok", antigravity: "Antigravity" })[agent] ?? agent;

/** Every agent a chat can ask, in the order it offers them: known without asking any of them. */
const ORDER = [CLAUDE, "codex", "grok", "antigravity"];

/** One agent as a chat offers it: usable when `problem` is null; its version and its state in a word or two, as its own check reported. */
export interface Offered {
  agent: string;
  name: string;
  problem: string | null;
  version: string | null;
  state: string;
  /** What it can do in a chat, in the server's words (src/api/chat.ts, chatScopeWords); null for Claude Code, or when an older check kept none. */
  chat: string | null;
  /** Whether it reads a repository attached to a chat, as the server says (src/api/chat.ts, readsChatRepository); left out when not known. */
  readsRepository?: boolean;
  /** True for an agent other than Claude Code that can build a task now, as the server's check found it (Codex); left out otherwise. */
  builds?: true;
}

/** `builds` for an agent other than Claude Code the server says can build now; nothing otherwise. Never read back from the device. */
const buildsOf = (a: AgentState): { builds?: true } => (a.agent !== "claude-code" && Array.isArray(a.roles) && a.roles.includes("builder") ? { builds: true } : {});

/** `readsRepository` when the server or the device said it, else nothing: not known. */
const readsOf = (value: unknown): { readsRepository?: boolean } => (typeof value === "boolean" ? { readsRepository: value } : {});

/** An agent's state in a word or two, from its check: what its own program reported (Settings shows the same words). */
export function agentState(agent: Pick<AgentState, "problem" | "installed" | "supported" | "signedIn">): string {
  if (agent.problem === null) return "Available";
  if (!agent.installed) return "Not installed";
  if (!agent.supported) return "Unsupported version";
  if (!agent.signedIn) return "Signed out";
  return "Unavailable";
}

export function chatOffer(agents: readonly AgentState[]): Offered[] {
  const rank = (agent: string): number => (ORDER.includes(agent) ? ORDER.indexOf(agent) : ORDER.length);
  return [...agents].sort((a, b) => rank(a.agent) - rank(b.agent)).map((a) => ({ agent: a.agent, name: agentName(a.agent), problem: a.problem, version: a.version, state: agentState(a), chat: typeof a.chat === "string" ? a.chat : null, ...readsOf(a.readsRepository), ...buildsOf(a) }));
}

/** The agents last checked, as this device kept them: read part by part; anything else is nothing known. */
export function readKnownAgents(raw: string | null): Offered[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const kept = parsed.flatMap((a: unknown): Offered[] => {
    if (typeof a !== "object" || a === null) return [];
    const { agent, problem, version, state, chat, readsRepository } = a as Record<string, unknown>;
    if (typeof agent !== "string" || agent === "" || !(problem === null || typeof problem === "string")) return [];
    return [{ agent, name: agentName(agent), problem, version: typeof version === "string" ? version : null, state: typeof state === "string" ? state : problem === null ? "Available" : "Unavailable", chat: typeof chat === "string" ? chat : null, ...readsOf(readsRepository) }];
  });
  return kept.length > 0 ? kept : null;
}

/**
 * One agent in the row at the top of the Agent and model view: `label` is the chip's words (the name, and its state when
 * it cannot simply be asked), `problem` the reason from its last check.
 */
export interface AgentRow {
  agent: string;
  name: string;
  label: string;
  state: string | null;
  version: string | null;
  problem: string | null;
  disabled: boolean;
  /** What it can do in a chat, in the server's words; null while nothing is known, and for Claude Code. */
  chat: string | null;
}

export interface AgentList {
  /** The one line about the check itself, when there is something to say. */
  line: string | null;
  rows: AgentRow[];
  /** Ask several, last in the row, and the agents that can be ticked under it. */
  several: { label: string; disabled: boolean; tickable: string[] };
  /** Whether a repository keeps the others out, so the view offers to remove it. */
  repository: boolean;
}

/** Each agent's state while nothing of it is known. */
export const CHECKING = "Checking…";

/**
 * What the Agent and model view's row holds: every agent Botbench drives, at once, each with what its last check found
 * (`known`, kept on the device), or as being checked while nothing is known. An agent that cannot answer stays in the
 * row and can be chosen, to show why. A repository leaves Claude Code alone choosable: the others are Chat only.
 */
export function agentList(o: { known: readonly Offered[] | null; checking: boolean; failed: string | null; inRepository: boolean }): AgentList {
  const known = o.known ?? [];
  const agents = [...ORDER, ...known.map((k) => k.agent).filter((a) => !ORDER.includes(a))];
  const unknownState = o.failed !== null && !o.checking ? "Not checked" : CHECKING;
  const rows = agents.map((agent): AgentRow => {
    const found = known.find((k) => k.agent === agent);
    const name = agentName(agent);
    const row = (state: string | null, problem: string | null, disabled: boolean): AgentRow => ({ agent, name, label: state === null ? name : `${name}: ${state}`, state, version: found?.version ?? null, problem, disabled, chat: found?.chat ?? null });
    if (o.inRepository && agent !== CLAUDE) return row("Chat only", null, true);
    if (found === undefined) return row(unknownState, null, false);
    return found.problem !== null ? row(found.state, found.problem, false) : row(null, null, false);
  });
  const tickable = agents.filter((agent) => known.find((k) => k.agent === agent)?.problem == null);
  const line =
    o.failed !== null
      ? o.known === null
        ? `The agents could not be checked: ${o.failed} Claude Code can still be asked.`
        : `The agents could not be checked again: ${o.failed} Each shows what its last check found.`
      : o.known === null && o.checking
        ? "Checking the agents."
        : null;
  return { line, rows, several: { label: o.inRepository ? "Ask several: Chat only" : "Ask several", disabled: o.inRepository, tickable }, repository: o.inRepository };
}

/** The line over an agent's models: its version and its sign-in state in words. */
export function agentAbout(row: AgentRow): string {
  const state = row.state === null ? "Signed in" : row.state;
  return row.version === null ? state : `Version ${row.version} · ${state}`;
}

/**
 * The first row of an agent's models, its own default: named by the model the agent says that is, with a default tag,
 * else "Codex's default"; that model is then not listed a second time, unless it is the one chosen.
 */
export function defaultFirst<T extends { id: string; label?: string }>(name: string, cliDefault: string | null, models: readonly T[], chosen: string | null): { label: string; models: T[] } {
  if (cliDefault === null) return { label: `${name}'s default`, models: [...models] };
  return { label: cliDefault, models: models.filter((m) => m.id === chosen || (m.id !== cliDefault && m.label !== cliDefault)) };
}

/**
 * The composer's chip: the model, with the agent as its qualifier. An agent's own default model is named by the agent
 * alone ("Claude Code", not "Claude Code's default Claude Code").
 */
export const chipWords = (value: string, qualifier: string): { value: string; qualifier: string | null } => (value === `${qualifier}'s default` ? { value: qualifier, qualifier: null } : { value, qualifier });

/** The Add context row that opens the agent choice: the agent, or how many are asked. */
export const agentRowValue = (pick: AgentPick): string => (pick.kind === "several" ? `${pick.agents.length} agents` : agentName(pick.agent));

/** How many models a list shows after the agent's own default before More models…. */
const MODELS_SHOWN = 4;

/** An agent's models: the first four after its default, and the rest behind More models…, opened when the choice is among them. */
export function modelsShown<T>(models: readonly T[], chosen: T | null): { first: T[]; rest: T[]; restHoldsChoice: boolean } {
  const first = models.slice(0, MODELS_SHOWN);
  const rest = models.slice(MODELS_SHOWN);
  return { first, rest, restHoldsChoice: chosen !== null && rest.includes(chosen) };
}

/** Who the next chat message goes to: one agent, or each agent ticked under Ask several. */
export type AgentPick = { kind: "one"; agent: string } | { kind: "several"; agents: string[] };

/** What the device remembers of the choice: who, and the model chosen for each agent but Claude Code (whose model has its own place). */
export interface ChatAgents {
  pick: AgentPick;
  /** A model name, or null for the agent's own default. */
  models: Record<string, string | null>;
}

export const CHAT_DEFAULT: ChatAgents = { pick: { kind: "one", agent: CLAUDE }, models: {} };

export function readChatAgents(raw: string | null): ChatAgents {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return CHAT_DEFAULT;
  }
  if (typeof parsed !== "object" || parsed === null) return CHAT_DEFAULT;
  const { pick, models } = parsed as Record<string, unknown>;
  const p = (typeof pick === "object" && pick !== null ? pick : {}) as Record<string, unknown>;
  const read: AgentPick =
    p.kind === "one" && typeof p.agent === "string" && p.agent !== ""
      ? { kind: "one", agent: p.agent }
      : p.kind === "several" && Array.isArray(p.agents)
        ? { kind: "several", agents: p.agents.filter((a): a is string => typeof a === "string" && a !== "") }
        : CHAT_DEFAULT.pick;
  const kept: Record<string, string | null> = {};
  if (typeof models === "object" && models !== null) for (const [agent, model] of Object.entries(models)) if (model === null || typeof model === "string") kept[agent] = model;
  return { pick: read, models: kept };
}

export type Targets = { ok: true; targets: ChatTarget[] } | { ok: false; why: string };

/**
 * The agents Send asks, each with its model. `offer` is null until the agents have been checked: the remembered choice
 * is then asked as it is, and the server refuses an agent that cannot answer.
 */
export function chatTargets(choice: ChatAgents, claudeModel: ModelRequest, offer: readonly Offered[] | null): Targets {
  const target = (agent: string): ChatTarget => (agent === CLAUDE ? { agent, ...(claudeModel.ok && claudeModel.model !== undefined ? { model: claudeModel.model } : {}) } : { agent, model: choice.models[agent] ?? null });
  const asked = choice.pick.kind === "one" ? [choice.pick.agent] : ORDER.filter((agent) => (choice.pick as { agents: string[] }).agents.includes(agent));
  const usable = asked.filter((agent) => offer === null || offer.some((o) => o.agent === agent && o.problem === null));
  if (choice.pick.kind === "one") {
    const down = offer?.find((o) => o.agent === asked[0]);
    if (offer !== null && (down === undefined || down.problem !== null)) return { ok: false, why: `${agentName(asked[0]!)} cannot answer now: ${down?.problem ?? "Botbench does not offer it."} Choose another agent.` };
  } else if (usable.length < 2) return { ok: false, why: "Tick at least two agents that can answer now, or choose one agent." };
  if (usable.includes(CLAUDE) && !claudeModel.ok) return { ok: false, why: `Model: ${claudeModel.why}` };
  return { ok: true, targets: usable.map(target) };
}

/** The Send button's name and the line under it: how many agents a message goes to. */
export const sendWords = (n: number): { label: string; line: string | null } => (n <= 1 ? { label: "Send", line: null } : { label: `Send to ${n} agents`, line: `Asks ${n} agents: each reply counts toward that agent's usage.` });

/** What the screen knows of one attempt of the chat. */
export interface AttemptInfo {
  agent: string;
  model: string | null;
  round: ChatRound | null;
}

export interface ChatView {
  /** The events as the transcript shows them: a round's message once, in place of what Botbench sent each agent. */
  events: StoredEvent[];
  /** Who wrote an attempt's replies, with the model; null for the transcript's own label, while Claude Code alone has answered. */
  who(attemptId: number): string | null;
  /** The newest round, when it asked several agents, each has finished and two or more answered: it can be compared. */
  compare: { roundId: number; answers: number } | null;
}

export const COMPARE_WORDS = "compare the answers above: where they agree, where they differ, and which you would act on.";

export function chatView(events: readonly StoredEvent[], infos: ReadonlyMap<number, AttemptInfo>, conversation: readonly number[]): ChatView {
  const shown: StoredEvent[] = [];
  const said = new Set<number>();
  const models = new Map<number, string>();
  for (const event of events) {
    const info = infos.get(event.attemptId);
    const round = info?.round ?? null;
    if (event.payload.type === "session_started" && typeof event.payload.model === "string") models.set(event.attemptId, event.payload.model);
    if (round === null || info === undefined) {
      shown.push(event);
      continue;
    }
    if (!said.has(round.id)) {
      said.add(round.id);
      const text = round.kind === "compare" ? `${agentName(info.agent)}, ${COMPARE_WORDS}` : round.message;
      // A row of its own, with an id no stored event has.
      shown.push({ ...event, id: -round.id, turn: 1, type: "user_prompt", payload: { type: "user_prompt", text } });
    }
    // What Botbench sent the agent is in its record; on screen, the round's message stands for it. The model is in the label.
    if ((event.payload.type === "user_prompt" && event.turn === 1) || event.payload.type === "session_started") continue;
    shown.push(event);
  }
  const answered = new Set([...infos.entries()].filter(([id]) => conversation.includes(id) && events.some((e) => e.attemptId === id)).map(([, info]) => info.agent));
  const several = answered.size > 1;
  const who = (attemptId: number): string | null => {
    const info = infos.get(attemptId);
    if (info === undefined || (!several && info.agent === CLAUDE)) return null;
    return `${agentName(info.agent)} · ${models.get(attemptId) ?? info.model ?? "default model"}`;
  };
  // The newest round of the chat, and the attempts in it.
  const last = conversation.at(-1);
  const round = last === undefined ? null : (infos.get(last)?.round ?? null);
  let compare: ChatView["compare"] = null;
  if (round !== null && round.kind === "ask") {
    const members = conversation.filter((id) => infos.get(id)?.round?.id === round.id);
    const ended = members.every((id) => events.some((e) => e.attemptId === id && e.payload.type === "turn_ended"));
    const answers = members.filter((id) => events.some((e) => e.attemptId === id && e.payload.type === "text")).length;
    if (members.length > 1 && ended && answers >= 2) compare = { roundId: round.id, answers };
  }
  return { events: shown, who, compare };
}

/** One agent's answer in a round several agents were asked, as its card shows it. */
export interface CompareCard {
  attemptId: number;
  agent: string;
  /** The model that answered, as its session named it; else the one asked for; null when neither is known. */
  model: string | null;
  /** Each piece of its reply, in order. */
  texts: string[];
  /** What went wrong, in the agent's or Botbench's own words, in order. */
  errors: string[];
  /** The calls it made, in order: the tool's name, what it was given, and whether it failed or was not run (refused, declined or denied). */
  calls: { id: string; name: string; input: unknown; failed: boolean; refused: boolean }[];
  /** `working` until its reply ended; `answered` when it completed; `stopped` when it was stopped; `failed` when it ended with an error. */
  state: "working" | "answered" | "stopped" | "failed";
  /** What its end said of an error, in the agent's or Botbench's words; null when it said nothing or did not fail. */
  detail: string | null;
  /** Its reply stopped because the agent's usage limit was reached. */
  limited: boolean;
  /** When its first event and its end were stored; null while it works. */
  from: string | null;
  to: string | null;
}

/**
 * The newest round of the chat, when it asked several agents the same question: the question and one card an agent, in
 * the order they were asked. Null when the newest round asked one agent, or asked one to compare. The cards are equal:
 * nothing here ranks the answers or says where they agree.
 */
export function compareRound(events: readonly StoredEvent[], infos: ReadonlyMap<number, AttemptInfo>, conversation: readonly number[]): { roundId: number; message: string; cards: CompareCard[] } | null {
  const last = conversation.at(-1);
  const round = last === undefined ? null : (infos.get(last)?.round ?? null);
  if (round === null || round.kind !== "ask") return null;
  const members = conversation.filter((id) => infos.get(id)?.round?.id === round.id);
  if (members.length < 2) return null;
  const cards = members.map((attemptId): CompareCard => {
    const info = infos.get(attemptId)!;
    const own = events.filter((e) => e.attemptId === attemptId);
    const results = new Map(own.flatMap((e) => (e.payload.type === "tool_result" ? [[e.payload.id, e.payload.isError] as const] : [])));
    const end = own.flatMap((e) => (e.payload.type === "turn_ended" ? [{ ts: e.ts, ...e.payload }] : []))[0];
    const refused = new Set(own.flatMap((e) => (e.payload.type === "permission_denied" ? [e.payload.id] : e.payload.type === "permission_resolved" && ["declined", "denied", "cancelled"].includes(e.payload.decision) ? [e.payload.toolCallId] : [])));
    const started = own.flatMap((e) => (e.payload.type === "session_started" && typeof e.payload.model === "string" ? [e.payload.model] : []))[0];
    return {
      attemptId,
      agent: info.agent,
      model: started ?? info.model,
      texts: own.flatMap((e) => (e.payload.type === "text" ? [e.payload.text] : [])),
      errors: own.flatMap((e) => (e.payload.type === "error" ? [e.payload.message] : [])),
      calls: own.flatMap((e) => (e.payload.type === "tool_call" ? [{ id: e.payload.id, name: e.payload.name, input: e.payload.input, failed: results.get(e.payload.id) === true, refused: refused.has(e.payload.id) }] : [])),
      state: end === undefined ? "working" : end.reason === "completed" ? "answered" : end.reason === "interrupted" ? "stopped" : "failed",
      detail: end !== undefined && end.reason === "error" ? end.detail : null,
      limited: end?.usageLimit !== undefined,
      from: own[0]?.ts ?? null,
      to: end?.ts ?? null,
    };
  });
  return { roundId: round.id, message: round.message, cards };
}
