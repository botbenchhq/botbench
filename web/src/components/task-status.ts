import type { TaskStatus, TaskSummary } from "../api/client.ts";

const STATUS_WORD: Record<TaskStatus, string> = {
  queued: "Queued",
  building: "Working",
  awaiting_decision: "Ready for review",
  interrupted: "Stopped",
  failed: "Failed",
};

/** Whether the task stands still until the owner answers a request of its agent. */
const waiting = (task: Pick<TaskSummary, "status" | "waitingOnApproval">): boolean => task.status === "building" && task.waitingOnApproval;
/** Whether the owner's answer to a request from before a restart is stored and the task is being started again to receive it. */
const resuming = (task: Pick<TaskSummary, "status" | "resuming">): boolean => task.status === "building" && task.resuming;

/** A task's station in a word or two, for lists. */
export const statusWord = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming">): string => (waiting(task) ? "Needs input" : resuming(task) ? "Resuming" : STATUS_WORD[task.status]);

/** The badge a station is drawn as. The word says the station; the tone only repeats it. */
const STATUS_LOOK: Record<TaskStatus, string> = {
  queued: "gw-badge",
  building: "gw-badge gw-badge--info",
  awaiting_decision: "gw-badge gw-badge--success",
  interrupted: "gw-badge gw-badge--danger",
  failed: "gw-badge gw-badge--danger",
};
export const statusLook = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming">): string => (waiting(task) ? "gw-badge gw-badge--warning" : STATUS_LOOK[task.status]);

/** A task's station as a sentence that says only what is so. */
export function statusSentence(task: Pick<TaskSummary, "status" | "reason" | "baseCommit" | "headCommit" | "waitingOnApproval" | "parked" | "resuming" | "ofPlan">): string {
  if (waiting(task)) {
    return task.parked
      ? "Needs input. Claude Code asked for permission before Smelt restarted and is stopped. Your answer starts it again where it left off."
      : "Needs input. Claude Code asked for permission and is paused until you allow or deny.";
  }
  if (resuming(task)) return "Resuming. Your answer is saved. Smelt starts Claude Code again where it left off, after any task that is running now, and gives it your answer.";
  switch (task.status) {
    case "queued":
      // A task of an approved plan is queued with nothing to build it yet: say so, and promise no start.
      return task.ofPlan === null ? "Queued. It starts when the tasks before it have finished." : `Queued by run ${task.ofPlan}, whose plan you approved. Building a run's tasks arrives in the next version of Smelt: nothing builds this task yet.`;
    case "building":
      return "Working. Claude Code is working in a separate copy of the project.";
    case "awaiting_decision":
      return task.headCommit === task.baseCommit
        ? "Ready for review. No file was changed, so nothing was committed."
        : "Ready for review. Smelt committed the work to the task's branch. Accepting or rejecting it arrives in a later version.";
    case "interrupted":
      return `Stopped. ${task.reason ?? "The task was stopped before it finished."}`;
    case "failed":
      return `Failed. ${task.reason ?? "No reason was recorded."}`;
  }
}
