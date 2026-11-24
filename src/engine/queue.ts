import type { RunStatus } from "./run.ts";
import type { TaskStatus } from "./task.ts";

/*
 * Where each run, task and chat stands for the owner, decided here and nowhere else: Home (the queue) and Work (the
 * inventory) are both read from it (src/api/work.ts), and no client works any of it out.
 *
 *   needs-you    it waits for the owner, with why (`cause`): an approval holding an agent, a failure the owner can
 *                recover (a task that can be resumed), a plan to approve, a result to decide on
 *   in-progress  an agent or Botbench is at work on it
 *   waiting      it goes on by itself, with what it waits for: a usage limit to reset, or another task to finish
 *   completed    accepted work, and nothing else
 *   failed       it failed and cannot be resumed: an end, shown in Work with its real state
 *   ended        it ended any other way: rejected, cancelled, stopped with nothing to resume, or nothing was decided
 *   chat         a chat nobody is waiting on: listed in Work, in no group of Home
 *
 * The order of what needs the owner is this one stated rule, with no other ranking: an approval holding an agent, then
 * a failure to recover, then plans, then results; within each, the one that has waited longest first.
 */

export type Place = "needs-you" | "in-progress" | "waiting" | "completed" | "failed" | "ended" | "chat";
export type Cause = "approval" | "failure" | "plan" | "result" | "usage-limit" | "dependency";
export interface Placed {
  place: Place;
  cause: Cause | null;
}

/** The causes of Needs you in the order they are shown: `rank` is a cause's place in it. */
export const NEEDS_ORDER: readonly Cause[] = ["approval", "failure", "plan", "result"];
export const rank = (cause: Cause | null): number => (cause === null || !NEEDS_ORDER.includes(cause) ? NEEDS_ORDER.length : NEEDS_ORDER.indexOf(cause));

const at = (place: Place, cause: Cause | null = null): Placed => ({ place, cause });

export interface TaskFacts {
  status: TaskStatus;
  /** A request of its agent waits for the owner's answer. */
  waitingOnApproval: boolean;
  /** It stopped or failed and the owner can resume it (engine/task.ts, `resumeNote`). */
  resumable: boolean;
  /** Its work waits for another task's to end first (engine/task.ts, `waitingBehind`). */
  behindAnother: boolean;
}

/** A task started on its own. */
export function placeTask(task: TaskFacts): Placed {
  if (task.waitingOnApproval) return at("needs-you", "approval");
  if (task.resumable) return at("needs-you", "failure");
  if (task.status === "awaiting_decision") return at("needs-you", "result");
  if (task.status === "waiting_for_limit") return at("waiting", "usage-limit");
  if (task.behindAnother) return at("waiting", "dependency");
  if (task.status === "queued" || task.status === "building" || task.status === "verifying" || task.status === "reviewing") return at("in-progress");
  if (task.status === "accepted") return at("completed");
  if (task.status === "failed") return at("failed");
  return at("ended");
}

export interface RunFacts {
  status: RunStatus;
  /** A request of its planner or of one of its builders waits for the owner's answer. */
  waitingOnApproval: boolean;
  /** How many of its tasks stopped or failed and can be resumed. */
  resumable: number;
  /** How many of its tasks are ready for review. */
  ready: number;
  /** How many of its tasks were accepted. */
  accepted: number;
  /** How many of its tasks are queued, being built, checked or reviewed. */
  atWork: number;
  /** How many of its tasks wait for a usage limit. */
  limited: number;
}

/** A planned run, by what is most urgent in it. */
export function placeRun(run: RunFacts): Placed {
  if (run.waitingOnApproval) return at("needs-you", "approval");
  if (run.resumable > 0) return at("needs-you", "failure");
  if (run.status === "awaiting_plan_approval") return at("needs-you", "plan");
  if (run.ready > 0 || run.status === "awaiting_decision") return at("needs-you", "result");
  // Nothing of it is at work and a task waits for its usage limit: the run goes on by itself when the limit resets.
  if (run.status === "planning" || run.status === "running") return run.atWork === 0 && run.limited > 0 ? at("waiting", "usage-limit") : at("in-progress");
  if (run.status === "failed") return at("failed");
  return run.status === "done" && run.accepted > 0 ? at("completed") : at("ended");
}

/**
 * A chat needs the owner while an agent of it asks for an approval, and is otherwise only listed. Whether an agent is
 * answering in it right now is not stored in a form to read here, so a chat is never called in progress.
 */
export function placeChat(chat: { waitingOnApproval: boolean }): Placed {
  return chat.waitingOnApproval ? at("needs-you", "approval") : at("chat");
}

/** The order of Needs you: by cause in `NEEDS_ORDER`, then the longest wait first. `since` is when the wait began (ISO). */
export function byNeed(a: { cause: Cause | null; since: string; id: number }, b: { cause: Cause | null; since: string; id: number }): number {
  return rank(a.cause) - rank(b.cause) || a.since.localeCompare(b.since) || a.id - b.id;
}
