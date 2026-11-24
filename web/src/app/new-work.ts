import type { Approval } from "../api/client.ts";
import type { AgentPick } from "./chat.ts";
import type { Kind, RepoPick } from "./composer.ts";

/*
 * New chat or task, and the levels of a decision, as plain functions so they are tested without a browser
 * (test/new-work.test.ts): which of the four intents the composer now holds, what choosing one sets, the one sentence
 * that says what Send will start, and how loud a request's decision surface is.
 */

/** What the owner came to do, in the product's own words (docs/product/voice.md). */
export type Intent = "question" | "task" | "run" | "several";

export const INTENTS: readonly { intent: Intent; name: string; about: string }[] = [
  { intent: "question", name: "Ask a question", about: "A chat with one agent, outside your repositories." },
  { intent: "task", name: "Start one task", about: "One task in a repository, on a new branch, for you to review." },
  { intent: "run", name: "Plan a run", about: "Claude Code plans several tasks for you to approve, then builds them." },
  { intent: "several", name: "Ask several agents", about: "The same question to each. Every agent answers alone." },
];

/** The intent the composer holds now: with no repository it is a chat, with one agent or several; in one, a task or a run. */
export function intentOf(o: { repo: RepoPick; kind: Kind; pick: AgentPick }): Intent {
  if (o.repo.kind === "none") return o.pick.kind === "several" ? "several" : "question";
  return o.kind;
}

/**
 * What choosing an intent sets. A chat takes the repository away; a task or a run keeps the one chosen, goes back to the
 * one last worked in on this visit (`lastRepo`), or leaves it to be chosen ("needed": Send says so, and starts nothing).
 * Ask several ticks every agent that can answer (`tickable`), or keeps the ones ticked; with fewer than two it cannot be chosen.
 */
export function chooseIntent(intent: Intent, now: { repo: RepoPick; pick: AgentPick; lastRepo: RepoPick | null; tickable: readonly string[] }): { repo: RepoPick; kind: Kind | null; pick: AgentPick | null } | null {
  if (intent === "task" || intent === "run") return { repo: now.repo.kind === "none" ? (now.lastRepo ?? { kind: "needed" }) : now.repo, kind: intent, pick: null };
  if (intent === "question") return { repo: { kind: "none" }, kind: null, pick: now.pick.kind === "several" ? { kind: "one", agent: now.pick.agents[0] ?? "claude-code" } : null };
  if (now.pick.kind === "several") return { repo: { kind: "none" }, kind: null, pick: null };
  return now.tickable.length < 2 ? null : { repo: { kind: "none" }, kind: null, pick: { kind: "several", agents: [...now.tickable] } };
}

/** Why Ask several agents cannot be chosen, or null when it can. */
export const severalProblem = (tickable: readonly string[]): string | null => (tickable.length < 2 ? "Needs two agents that can answer." : null);

/**
 * The one sentence under the composer: exactly what Send will start, with its lead ("Send starts one task in billing-api.")
 * apart from the rest. Every clause is one the composer always said of that work; nothing is promised that the server does not do.
 */
export function sendSentence(o: {
  intent: Intent;
  /** The repository's name, or null while one is still to be chosen. */
  repo: string | null;
  /** Who is asked or builds, by name; for several, how many. */
  agent: string;
  asked: number;
  /** What an agent other than Claude Code can do in a chat, in the server's words; null when not said. */
  chatScope: string | null;
  /** The repository the chat reads, by name; null for none. */
  reads: string | null;
  run: { oneTask: boolean; codexBuilds: boolean; plansUnasked: boolean; pullRequest: boolean; claim: string };
}): { lead: string; rest: string } {
  if (o.intent === "question") return { lead: `Send asks ${o.agent}.`, rest: [o.chatScope ?? `${o.agent} answers in a folder of its own, outside your projects.`, o.reads === null ? null : `It can read ${o.reads}, and never change it.`].filter((s) => s !== null).join(" ") };
  if (o.intent === "several") return { lead: `Send asks ${o.asked} agents the same question.`, rest: `Each answers alone, without the others' answers to it. Each reply counts toward that agent's usage.${o.reads === null ? "" : ` Those that can read ${o.reads}, and never change it.`}` };
  if (o.repo === null) return { lead: "Send starts nothing yet.", rest: `Choose the repository ${o.intent === "task" ? "the task works in" : "the run works in"} first.` };
  if (o.intent === "task") return { lead: `Send starts one task in ${o.repo}.`, rest: `${o.agent} works on a new branch, in a separate copy of the repository (a git worktree). Your own files and your branch are not touched.` };
  return {
    lead: `Send plans a run in ${o.repo}.`,
    rest: `Claude Code plans ${o.run.oneTask ? "one task" : "tasks"} first, reading a copy it cannot change.${o.run.codexBuilds ? " Codex builds them." : ""} ${o.run.plansUnasked ? "Building starts on the plan without your approval." : "Nothing is built until you approve the plan."}${o.run.pullRequest ? " Each accepted task is then opened as a pull request." : ""}${o.run.claim}`,
  };
}

/** How loud a decision is: the five levels of the approved decision surface, quietest first. */
export type DecisionLevel = "routine" | "approval" | "risk" | "destructive" | "refused";

/** Whether an address names this Mac or the local network: a fetch aimed there stays near, and asks for another reason. */
export function localAddress(address: string): boolean {
  let host: string;
  try {
    host = new URL(address.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "0.0.0.0";
}

/** Whether what a request asks for sends something off this Mac by its nature: a search of the web, or a fetch of an address that is not this Mac's or its network's. */
export const leavesThisMac = (approval: Pick<Approval, "tool" | "command">): boolean => approval.tool === "WebSearch" || (approval.tool === "WebFetch" && !localAddress(approval.command));

/** A waiting request's level: elevated risk when it leaves this Mac, else an approval request. */
export const approvalLevel = (approval: Pick<Approval, "tool" | "command">): DecisionLevel => (leavesThisMac(approval) ? "risk" : "approval");

/** The request's place in the queue, as the surface says it ("1 of 2"); null when it is the only one. */
export const queueWords = (at: number, of: number): string | null => (of < 2 ? null : `${at + 1} of ${of}`);
