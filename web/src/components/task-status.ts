import type { TaskStatus, TaskSummary } from "../api/client.ts";

/** A task's station as one word, for lists. */
export const STATUS_WORD: Record<TaskStatus, string> = {
  queued: "Queued",
  building: "Building",
  awaiting_decision: "Built",
  interrupted: "Interrupted",
  failed: "Failed",
};

/** A task's station as a sentence that says only what is so. */
export function statusSentence(task: Pick<TaskSummary, "status" | "reason" | "baseCommit" | "headCommit">): string {
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
