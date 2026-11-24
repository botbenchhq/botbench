import type { PullRequestView, RunDetail, RunTask } from "../../api/client.ts";
import { LOOKS, type Look } from "../../components/looks.ts";
import { statusLook, statusWord, waitingForWords, waitingWords } from "../../components/task-status.ts";

/*
 * What the rebuilt run screen works out for itself (ADR 0012), decided without a browser (test/run-screen-model.test.ts).
 * It is little: a run's state in words, its three steps and what a mode allows are the server's or components/run-status.ts's.
 */

/** What a task of the run is doing, in words, for its row. */
export function taskFacts(task: RunTask): string {
  if (task.status === "queued") return "Starts when the tasks before it have finished";
  if (task.status === "verifying") return "Botbench is running this repository's checks";
  if (task.status === "reviewing") return "The reviewer is reading the changes";
  if (task.status === "waiting_for_limit") return waitingWords(task.retryAt);
  if (task.waitingFor !== null) return waitingForWords(task)!;
  if (task.status === "building") return task.waitingOnApproval ? "Claude Code is waiting for your answer" : task.attemptId === null ? "Preparing a separate copy of the project" : "Claude Code is working; open it to watch";
  if (task.decision?.branch === "deleted") return "Branch deleted";
  return task.branch ?? "No branch";
}

/** How a state's mark is drawn on a rebuilt screen. Amber is only for what waits on the owner. */
export type StateTone = "neutral" | "working" | "waits" | "success" | "failed";

/**
 * The tone of a state's mark, from the look every screen gives that state (components/looks.ts). What waits for the
 * owner (a request, a result ready for review) is amber, whatever tone the old screens drew it in; work under way is
 * the accent; an accepted or finished result is green; a failure red; everything else neutral.
 */
export function stateTone(look: Look): StateTone {
  if (look === LOOKS.needsInput || look === LOOKS.readyForReview) return "waits";
  if (look.tone === "info") return "working";
  if (look.tone === "success") return "success";
  if (look.tone === "danger") return "failed";
  return "neutral";
}

/** The run's controls, as its menu offers them: a stricter mode only where the server offers one, and Cancel only while the run can still be cancelled. */
export function runControls(run: Pick<RunDetail, "status" | "modeChoices">): { stricter: boolean; cancel: boolean } {
  return { stricter: run.modeChoices.length > 0, cancel: run.status === "planning" || run.status === "awaiting_plan_approval" || run.status === "running" };
}

/** The pull requests the run's tasks have, in plan order: each with a number and an address, whether the run opened it on accepting or the owner did from the task. */
export function pullRequests(run: Pick<RunDetail, "tasks">): { taskId: number; title: string; view: PullRequestView & { number: number; url: string } }[] {
  return run.tasks.flatMap((task) => (task.pullRequest.number !== null && task.pullRequest.url !== null ? [{ taskId: task.id, title: task.title, view: { ...task.pullRequest, number: task.pullRequest.number, url: task.pullRequest.url } }] : []));
}

/** How many of the run's tasks are decided, as a list's word for the run needs it (components/run-status.ts). */
export const decidedCount = (run: Pick<RunDetail, "tasks">): number => run.tasks.filter((task) => task.status === "accepted" || task.status === "rejected").length;

/**
 * A task's state on its row: the product's own word for it and its look. An accept made with no checks is said as
 * that and is not drawn as a success, as on the task's own review.
 */
export function rowState(task: Pick<RunTask, "status" | "waitingOnApproval" | "waitingFor" | "decision">): { word: string; look: Look } {
  const state = { status: task.status, waitingOnApproval: task.waitingOnApproval, resuming: false, waitingFor: task.waitingFor };
  if (task.status === "accepted" && task.decision?.decision === "accept" && task.decision.checks === "none") return { word: "Accepted without verification", look: LOOKS.acceptedUnverified };
  return { word: statusWord(state), look: statusLook(state) };
}
