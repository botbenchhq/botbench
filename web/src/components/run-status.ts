import type { RunDetail, RunStatus, RunSummary } from "../api/client.ts";

const tasksWord = (n: number): string => `${n} ${n === 1 ? "task" : "tasks"}`;

/** A run's state in a word or two, for lists. */
export function runWord(run: Pick<RunSummary, "status" | "waitingOnApproval" | "attemptId">): string {
  if (run.status === "planning") return run.waitingOnApproval ? "Needs input" : run.attemptId === null ? "Queued" : "Planning";
  if (run.status === "running" && run.waitingOnApproval) return "Needs input";
  const words: Record<Exclude<RunStatus, "planning">, string> = { awaiting_plan_approval: "Plan ready for review", running: "Working", awaiting_decision: "Ready for review", done: "Done", cancelled: "Cancelled", failed: "Failed" };
  return words[run.status];
}

/** The badge a state is drawn as. The word says the state; the tone only repeats it. */
export function runLook(run: Pick<RunSummary, "status" | "waitingOnApproval" | "attemptId">): string {
  if (run.status === "planning") return run.waitingOnApproval ? "gw-badge gw-badge--warning" : run.attemptId === null ? "gw-badge" : "gw-badge gw-badge--info";
  if (run.status === "running" && run.waitingOnApproval) return "gw-badge gw-badge--warning";
  const looks: Record<Exclude<RunStatus, "planning">, string> = { awaiting_plan_approval: "gw-badge gw-badge--warning", running: "gw-badge gw-badge--info", awaiting_decision: "gw-badge gw-badge--success", done: "gw-badge gw-badge--success", cancelled: "gw-badge", failed: "gw-badge gw-badge--danger" };
  return looks[run.status];
}

/** How many of a run's tasks are at an end: built, failed, stopped or cancelled. */
const finished = (tasks: readonly { status: string }[]): number => tasks.filter((task) => task.status !== "queued" && task.status !== "building").length;

/** What a list says under a run's title. */
export function runFacts(run: RunSummary): string {
  const count = run.status === "running" ? `${run.finishedCount} of ${tasksWord(run.taskCount)} finished` : run.taskCount > 0 ? `${tasksWord(run.taskCount)} planned` : "No plan yet";
  return `Run ${run.id} · ${count} · ${run.repo}`;
}

/** A run's state as a sentence that says only what is so. */
export function runSentence(run: Pick<RunDetail, "status" | "reason" | "waitingOnApproval" | "tasks" | "attemptId">): string {
  switch (run.status) {
    case "planning":
      // No planner has been started for it yet: one planner works at a time.
      if (run.attemptId === null) return "Queued. Smelt plans one run at a time, and this one starts when the one before it has its plan. Nothing is changed meanwhile.";
      return run.waitingOnApproval
        ? "Needs input. While planning, Claude Code asked for permission to run a command and is paused until you allow or deny."
        : "Planning. Claude Code is reading the repository and writing the task list. It only reads: nothing is changed while it plans.";
    case "awaiting_plan_approval":
      return "Plan ready for review. Edit the tasks if you need to, then approve the plan. Nothing is built before you approve.";
    case "running":
      // A task that waits for an answer holds up the tasks after it.
      if (run.waitingOnApproval) return `Needs input. Claude Code asked for permission while building a task and is paused until you allow or deny; the tasks after it wait. ${finished(run.tasks)} of ${tasksWord(run.tasks.length)} finished.`;
      return `Working. Smelt builds the tasks one at a time, in plan order, each by Claude Code in a separate copy of the project. ${finished(run.tasks)} of ${tasksWord(run.tasks.length)} finished.`;
    case "awaiting_decision":
      return "Ready for review. Every task has been built or has stopped; each says how it went.";
    case "done":
      return "Done.";
    case "cancelled":
      return run.tasks.length === 0 ? "Cancelled. Nothing was built, and no task was made from this run." : "Cancelled. Tasks that had finished keep their branches; the task being built was stopped and what it did is committed; the rest were not built.";
    case "failed":
      return `Failed. ${run.reason ?? "No reason was recorded."}`;
  }
}
