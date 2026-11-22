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

/** A task's station in a word or two, for lists. */
export const statusWord = (task: Pick<TaskSummary, "status" | "waitingOnApproval">): string => (waiting(task) ? "Waiting on you" : STATUS_WORD[task.status]);

/** A task's station as a sentence that says only what is so. */
export function statusSentence(task: Pick<TaskSummary, "status" | "reason" | "baseCommit" | "headCommit" | "waitingOnApproval">): string {
  if (waiting(task)) return "Waiting for your answer. Claude Code asked for permission and is paused until you allow or decline.";
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
