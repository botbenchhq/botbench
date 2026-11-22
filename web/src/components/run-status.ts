import type { RunDetail, RunStatus, RunSummary } from "../api/client.ts";

const tasksWord = (n: number): string => `${n} ${n === 1 ? "task" : "tasks"}`;

/** A run's state in a word or two, for lists. A run whose plan is approved is not being built by anything yet, and the word says so. */
export function runWord(run: Pick<RunSummary, "status" | "waitingOnApproval" | "attemptId">): string {
  if (run.status === "planning") return run.waitingOnApproval ? "Needs input" : run.attemptId === null ? "Queued" : "Planning";
  const words: Record<Exclude<RunStatus, "planning">, string> = { awaiting_plan_approval: "Plan ready for review", running: "Approved", awaiting_decision: "Ready for review", done: "Done", cancelled: "Cancelled", failed: "Failed" };
  return words[run.status];
}

/** The badge a state is drawn as. The word says the state; the tone only repeats it. */
export function runLook(run: Pick<RunSummary, "status" | "waitingOnApproval" | "attemptId">): string {
  if (run.status === "planning") return run.waitingOnApproval ? "gw-badge gw-badge--warning" : run.attemptId === null ? "gw-badge" : "gw-badge gw-badge--info";
  const looks: Record<Exclude<RunStatus, "planning">, string> = { awaiting_plan_approval: "gw-badge gw-badge--warning", running: "gw-badge", awaiting_decision: "gw-badge gw-badge--success", done: "gw-badge gw-badge--success", cancelled: "gw-badge", failed: "gw-badge gw-badge--danger" };
  return looks[run.status];
}

/** What a list says under a run's title. */
export function runFacts(run: RunSummary): string {
  const count = run.status === "running" ? `${tasksWord(run.taskCount)} queued` : run.taskCount > 0 ? `${tasksWord(run.taskCount)} planned` : "No plan yet";
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
      return `Approved. The ${tasksWord(run.tasks.length)} ${run.tasks.length === 1 ? "is" : "are"} queued. Building them arrives in the next version of Smelt: nothing is built yet, and nothing on this screen starts a build.`;
    case "awaiting_decision":
      return "Ready for review. The tasks wait for your decision.";
    case "done":
      return "Done.";
    case "cancelled":
      return "Cancelled. Nothing was built, and no task was made from this run.";
    case "failed":
      return `Failed. ${run.reason ?? "No reason was recorded."}`;
  }
}
