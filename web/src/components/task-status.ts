import { LOOKS, type Look } from "./looks.ts";
import type { TaskStatus, TaskSummary } from "../api/client.ts";

const STATUS_WORD: Record<TaskStatus, string> = {
  queued: "Queued",
  building: "Working",
  verifying: "Checking",
  reviewing: "In review",
  awaiting_decision: "Ready for review",
  accepted: "Accepted",
  rejected: "Rejected",
  interrupted: "Stopped",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Whether the task stands still until the owner answers a request of its agent. */
const waiting = (task: Pick<TaskSummary, "status" | "waitingOnApproval">): boolean => task.status === "building" && task.waitingOnApproval;
/** Whether the owner's answer to a request from before a restart is stored and the task is being started again to receive it. */
const resuming = (task: Pick<TaskSummary, "status" | "resuming">): boolean => task.status === "building" && task.resuming;

/** A task's station in a word or two, for lists. */
export const statusWord = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming">): string => (waiting(task) ? "Needs input" : resuming(task) ? "Resuming" : STATUS_WORD[task.status]);

/** The look of a station, from the status set. The word says the station; the icon and tone only repeat it. */
const STATUS_LOOK: Record<TaskStatus, Look> = {
  queued: LOOKS.queued,
  building: LOOKS.working,
  verifying: LOOKS.checking,
  reviewing: LOOKS.checking,
  awaiting_decision: LOOKS.readyForReview,
  accepted: LOOKS.accepted,
  rejected: LOOKS.rejected,
  interrupted: LOOKS.stopped,
  failed: LOOKS.failed,
  cancelled: LOOKS.cancelled,
};
export const statusLook = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming">): Look => (waiting(task) ? LOOKS.needsInput : resuming(task) ? LOOKS.working : STATUS_LOOK[task.status]);

/** A task's station as a sentence that says only what is so. */
export function statusSentence(task: Pick<TaskSummary, "status" | "reason" | "baseCommit" | "headCommit" | "attemptId" | "waitingOnApproval" | "parked" | "resuming" | "ofPlan" | "decision">): string {
  // A fully autonomous run that did not accept the task says why it needs the owner.
  const why = task.status === "awaiting_decision" && task.reason !== null ? ` ${task.reason}` : "";
  if (waiting(task)) {
    return task.parked
      ? "Needs input. Claude Code asked for permission before Botbench restarted and is stopped. Your answer starts it again where it left off."
      : "Needs input. Claude Code asked for permission and is paused until you allow or deny.";
  }
  if (resuming(task)) return "Resuming. Your answer is saved. Botbench starts Claude Code again where it left off, after any task that is running now, and gives it your answer.";
  switch (task.status) {
    case "queued":
      return task.ofPlan === null ? "Queued. It starts when the tasks before it have finished." : `Queued. Run ${task.ofPlan} builds its tasks one at a time, in plan order: this one starts when the tasks before it have finished.`;
    case "building":
      // Before its agent starts, Botbench makes the task's copy and runs the repository's setup commands in it.
      return task.attemptId === null ? "Working. Botbench is preparing a separate copy of the project for Claude Code." : "Working. Claude Code is working in a separate copy of the project.";
    case "verifying":
      return "Checking. Botbench committed the work to the task's branch and is running this repository's checks on it.";
    case "reviewing":
      return "In review. Botbench committed the work and ran the checks; the run's reviewer is reading the changes. You can decide once its review is in.";
    case "awaiting_decision":
      return task.headCommit === task.baseCommit
        ? `Ready for review. No file was changed, so nothing was committed.${why}`
        : `Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.${why}`;
    case "accepted":
      return task.decision?.decidedBy === "mode" ? "Accepted without you, as its run is fully autonomous. Botbench kept the branch and removed the task's copy of the project." : "Accepted. Botbench kept the branch and removed the task's copy of the project.";
    case "rejected":
      return task.decision?.branch === "deleted" ? "Rejected. The branch was deleted, and the task's copy of the project was removed." : "Rejected. Botbench kept the branch and removed the task's copy of the project.";
    case "interrupted":
      return `Stopped. ${task.reason ?? "The task was stopped before it finished."}`;
    case "failed":
      return `Failed. ${task.reason ?? "No reason was recorded."}`;
    case "cancelled":
      return `Cancelled. ${task.reason ?? "Its run was cancelled."}`;
  }
}
