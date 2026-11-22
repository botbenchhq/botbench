import type { TaskStatus, TaskSummary } from "../api/client.ts";

const STATUS_WORD: Record<TaskStatus, string> = {
  queued: "Queued",
  building: "Building",
  awaiting_decision: "Built",
  interrupted: "Interrupted",
  failed: "Failed",
};

/** Whether the task stands still until the owner answers a request of its agent. */
const waiting = (task: Pick<TaskSummary, "status" | "waitingOnApproval">): boolean => task.status === "building" && task.waitingOnApproval;
/** Whether the owner's answer to a request from before a restart is stored and the task is being started again to receive it. */
const resuming = (task: Pick<TaskSummary, "status" | "resuming">): boolean => task.status === "building" && task.resuming;

/** A task's station in a word or two, for lists. */
export const statusWord = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming">): string => (waiting(task) ? "Waiting on you" : resuming(task) ? "Resuming" : STATUS_WORD[task.status]);

/** A task's station as a sentence that says only what is so. */
export function statusSentence(task: Pick<TaskSummary, "status" | "reason" | "baseCommit" | "headCommit" | "waitingOnApproval" | "parked" | "resuming">): string {
  if (waiting(task)) {
    return task.parked
      ? "Waiting for your answer. Claude Code asked for permission before Smelt restarted and is stopped. Your answer starts it again where it stood."
      : "Waiting for your answer. Claude Code asked for permission and is paused until you allow or decline.";
  }
  if (resuming(task)) return "Resuming. Your answer is stored. Smelt starts Claude Code again where it stood, after any task that is running now, and gives it your answer.";
  switch (task.status) {
    case "queued":
      return "Queued. It starts when the tasks before it have finished.";
    case "building":
      return "Building. Claude Code is working in the task's worktree.";
    case "awaiting_decision":
      return task.headCommit === task.baseCommit
        ? "Built. No file was changed, so nothing was committed."
        : "Built. Smelt committed the work to the task's branch. Accepting or rejecting it arrives in a later version.";
    case "interrupted":
      return `Interrupted. ${task.reason ?? "The task was stopped before it finished."}`;
    case "failed":
      return `Failed. ${task.reason ?? "No reason was recorded."}`;
  }
}
