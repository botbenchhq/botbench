/*
 * The words of moving a task to another agent (src/engine/handoff.ts), on the task's screen, and of the list of agents
 * a run that says Switch moves to, in Settings (docs/product/voice.md). Plain functions and constants, so they are
 * tested without a browser.
 */

import { agentName as agentLabel } from "./chat.ts";
import { counted, plural } from "./format.ts";

export const MOVE_HEADING = "Move to another agent";

/** What a move does, said before the owner chooses it. */
export const moveAbout = (from: string): string =>
  `${agentLabel(from)} stops now, and what it wrote is committed. The agent you choose takes the task over in a new session, in the same copy and on the same branch, with a note of the task and what was done so far. The run's mode and safety rules stay as they are.`;

/** The button for one agent, and its words while the move is asked for. */
export const moveButton = (to: string, busy: boolean): string => (busy ? `Moving to ${agentLabel(to)}` : `Move to ${agentLabel(to)}`);

/** Why a move was not made, with the server's reason when it gave one. */
export const moveRefused = (why: string | null): string => `The task was not moved. ${why ?? "Botbench could not be reached."}`;

export const FALLBACK_LABEL = "When a builder reaches its usage limit, switch to";
export const FALLBACK_ABOUT = "For a run you set to Switch to the next agent: the agents tried, in this order, after the one that reached its limit. An agent that reviews the run, or cannot build now, is skipped. A run set to Wait for it to reset does not use this list.";

/**
 * Every order the builder's fallback list can take: each order of all the agents first, then the shorter ones, each
 * agent alone last. Each is the list as stored, and is its value in a select.
 */
export function fallbackOrders(agents: readonly string[]): string[][] {
  const orders: string[][] = [];
  const grow = (taken: string[]): void => {
    if (taken.length > 0) orders.push(taken);
    for (const agent of agents) if (!taken.includes(agent)) grow([...taken, agent]);
  };
  grow([]);
  return orders.sort((a, b) => b.length - a.length);
}

/** An order as the select shows it: "Claude Code, then Codex", or one agent alone ("Codex only"). */
export const orderWords = (order: readonly string[]): string => (order.length === 1 ? `${agentLabel(order[0]!)} only` : order.map(agentLabel).join(", then "));

/** What the task screen needs of a task to show its transcript across moves to another agent. */
interface Sessions {
  attemptId: number | null;
  builder: string;
  handoffs: { from: string; fromAttemptId: number | null }[];
}

/** The sessions a task's one transcript shows, in order: the session each move left, then the one the task names now. */
export const shownAttempts = (task: Pick<Sessions, "attemptId" | "handoffs">): number[] => [...new Set([...task.handoffs.flatMap((h) => (h.fromAttemptId === null ? [] : [h.fromAttemptId])), ...(task.attemptId === null ? [] : [task.attemptId])])];

/** The agent of one of those sessions, by name, for its messages: the one a move left, or the one building it now. */
export const sessionAgent = (task: Sessions, attempt: number): string | null => {
  if (attempt === task.attemptId) return agentLabel(task.builder);
  const left = task.handoffs.find((h) => h.fromAttemptId === attempt);
  return left === undefined ? null : agentLabel(left.from);
};

/** The line above the transcript when the screen shows more than one agent's sessions on the task. */
export const sessionsLine = (builder: string, earlier: number, handedOver: boolean): string | null => {
  if (earlier === 0) return null;
  const kept = `Its ${counted(earlier, "earlier session", "earlier sessions")} ${plural(earlier, "is", "are")}`;
  return handedOver ? `These are the sessions before and after each move to another agent. ${kept} kept in Botbench's records, not shown here.` : `This is ${agentLabel(builder)}'s latest session on this task. ${kept} kept in Botbench's records, not shown here.`;
};
