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

/** The order a chat offers its agents in. */
const ORDER = [CLAUDE, "codex", "grok", "antigravity"];

/** One agent as a chat offers it: usable when `problem` is null. */
export interface Offered {
  agent: string;
  name: string;
  problem: string | null;
}

export function chatOffer(agents: readonly AgentState[]): Offered[] {
  const rank = (agent: string): number => (ORDER.includes(agent) ? ORDER.indexOf(agent) : ORDER.length);
  return [...agents].sort((a, b) => rank(a.agent) - rank(b.agent)).map((a) => ({ agent: a.agent, name: agentName(a.agent), problem: a.problem }));
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
