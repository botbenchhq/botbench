import type { DriverEvent, StoredEvent } from "../api/client.ts";
import type { CallState } from "./tool-summary.ts";

/*
 * What a transcript knows about its events as a whole, as plain functions: read once from the stored events, so that
 * a row can say what became of the call it is about. Used by the transcript's rows (transcript.tsx) and by the task
 * screen's narrative (screens2/task/task-model.ts).
 */

type Of<T extends DriverEvent["type"]> = Extract<DriverEvent, { type: T }>;

/** What the transcript knows about its events as a whole, so that a row can say what became of the call it is about. */
export interface Story {
  /** Whether something is still running. When nothing is, a call with no result is not going to get one. */
  live: boolean;
  calls: Map<string, Of<"tool_call">>;
  results: Map<string, Of<"tool_result">>;
  /** When each call and each result was stored, by the call's id: the only times a call's duration is taken from. */
  calledAt: Map<string, string>;
  returnedAt: Map<string, string>;
  /** When the owner's answer let a call run, by the call's id. */
  allowedAt: Map<string, string>;
  /** The calls a request to the owner was made for. */
  asked: Set<string>;
  /** How each request ended, by its call. */
  answers: Map<string, Of<"permission_resolved">["decision"]>;
  /** Why Botbench refused a request without asking, by its call. */
  refusals: Map<string, string>;
  /** The calls refused with nobody to ask. */
  refused: Set<string>;
  /** The calls Claude Code's rule on reads refused, outside the folder the agent works in (U27). */
  outside: Set<string>;
  /** The exchanges that have ended, as "attempt:exchange". */
  ended: Set<string>;
  /** The exchanges in which the agent called a tool. */
  calledIn: Set<string>;
  /** When each exchange that completed ended. */
  completedAt: Map<string, string>;
  /** When each exchange began, and the tokens the agent reported for it. */
  exchanges: Map<string, { from: string; tokensIn: number; tokensOut: number; counted: boolean }>;
}

export const exchangeOf = (event: StoredEvent): string => `${event.attemptId}:${event.turn}`;

export function readStory(events: readonly StoredEvent[], live: boolean): Story {
  const story: Story = { live, calls: new Map(), results: new Map(), calledAt: new Map(), returnedAt: new Map(), allowedAt: new Map(), asked: new Set(), answers: new Map(), refusals: new Map(), refused: new Set(), outside: new Set(), ended: new Set(), calledIn: new Set(), completedAt: new Map(), exchanges: new Map() };
  for (const event of events) {
    const e = event.payload;
    const key = exchangeOf(event);
    if (!story.exchanges.has(key)) story.exchanges.set(key, { from: event.ts, tokensIn: 0, tokensOut: 0, counted: false });
    if (e.type === "tool_call") (story.calls.set(e.id, e), story.calledAt.set(e.id, event.ts), story.calledIn.add(key));
    else if (e.type === "tool_result") (story.results.set(e.id, e), story.returnedAt.set(e.id, event.ts));
    else if (e.type === "permission_request") story.asked.add(e.toolCallId);
    else if (e.type === "permission_resolved") {
      story.answers.set(e.toolCallId, e.decision);
      if (e.decision === "denied" && e.note !== null) story.refusals.set(e.toolCallId, e.note);
      if (e.decision === "allowed" || e.decision === "preapproved" || e.decision === "standing" || e.decision === "web" || e.decision === "chat" || e.decision === "mode" || e.decision === "bookkeeping" || e.decision === "answered") story.allowedAt.set(e.toolCallId, event.ts);
    }
    else if (e.type === "permission_denied") {
      story.refused.add(e.id);
      if (e.code === "outside_reads_blocked") story.outside.add(e.id);
    }
    else if (e.type === "turn_ended") {
      story.ended.add(key);
      if (e.reason === "completed") story.completedAt.set(key, event.ts);
    }
    else if (e.type === "usage") {
      const exchange = story.exchanges.get(key)!;
      exchange.tokensIn += e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      exchange.tokensOut += e.outputTokens;
      exchange.counted = true;
    }
  }
  return story;
}

/** What became of a call, from the events stored about it and nothing else. */
export function stateOf(story: Story, id: string, exchange: string): CallState {
  const answer = story.answers.get(id);
  if (story.refused.has(id) || answer === "declined" || answer === "denied" || answer === "cancelled") return "refused";
  const result = story.results.get(id);
  if (result !== undefined) return result.isError ? "failed" : "done";
  if (story.ended.has(exchange) || !story.live) return "unfinished";
  return story.asked.has(id) && answer === undefined ? "waiting" : "running";
}

export const OUTSIDE = "It was not run. The agent may read only the folder it works in.";

/** How the design system's tool call draws each state of a call, the state in words, and why it did not run or end well. */
export interface Shown {
  state: "awaiting-approval" | "running" | "succeeded" | "failed" | "declined" | "cancelled";
  word: string;
  note: string | null;
}

/** What the row of a call shows of its state, from the events stored about it. The words follow the status set and the voice guide. */
export function shownOf(story: Story, id: string, state: CallState): Shown {
  switch (state) {
    case "waiting":
      return { state: "awaiting-approval", word: "Needs input", note: null };
    case "running":
      return { state: "running", word: "Working", note: null };
    case "done":
      return { state: "succeeded", word: "Done", note: null };
    case "failed":
      return { state: "failed", word: "Failed", note: "It returned an error." };
    case "unfinished":
      // It may have run: nothing says it did not. It ended without a result, which is drawn as a failure, open.
      return { state: "failed", word: "Did not finish", note: "No result was recorded for it." };
    case "refused": {
      const answer = story.answers.get(id);
      if (answer === "cancelled") return { state: "cancelled", word: "Not answered", note: "The request ended without an answer. It was not run." };
      if (answer === "declined") return { state: "declined", word: "Denied", note: "You denied this." };
      // Botbench's own reason, one plain sentence (the safety rules in a fully autonomous run, web access in chat turned off).
      if (answer === "denied") return { state: "declined", word: "Denied", note: story.refusals.get(id) ?? "Botbench refused this without asking you." };
      if (story.outside.has(id)) return { state: "declined", word: "Denied", note: OUTSIDE };
      return { state: "declined", word: "Denied", note: "It needed your approval, and there was no way to ask you here." };
    }
  }
}

