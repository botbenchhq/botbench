import type { RunDetail, RunStatus, RunSummary } from "../api/client.ts";
import { LOOKS, type Look } from "./looks.ts";

const tasksWord = (n: number): string => `${n} ${n === 1 ? "task" : "tasks"}`;

/** A run that is done although no task of it was ever ready for review: each failed, was stopped or was cancelled. */
const nothingReviewed = (run: { status: RunStatus; tasks: readonly { status: string }[] }): boolean => run.status === "done" && !run.tasks.some((task) => task.status === "accepted" || task.status === "rejected");
const summaryNothingReviewed = (run: Pick<RunSummary, "status" | "decidedCount">): boolean => run.status === "done" && run.decidedCount === 0;

/** A run's state in a word or two, for lists. */
export function runWord(run: Pick<RunSummary, "status" | "waitingOnApproval" | "attemptId" | "decidedCount">): string {
  if (summaryNothingReviewed(run)) return "Nothing to review";
  if (run.status === "planning") return run.waitingOnApproval ? "Needs input" : run.attemptId === null ? "Queued" : "Planning";
  if (run.status === "running" && run.waitingOnApproval) return "Needs input";
  const words: Record<Exclude<RunStatus, "planning">, string> = { awaiting_plan_approval: "Plan ready for review", running: "Working", awaiting_decision: "Ready for review", done: "Done", cancelled: "Cancelled", failed: "Failed" };
  return words[run.status];
}

/** The look of a run's state, from the status set. The word says the state; the icon and tone only repeat it. */
export function runLook(run: Pick<RunSummary, "status" | "waitingOnApproval" | "attemptId" | "decidedCount">): Look {
  if (summaryNothingReviewed(run)) return LOOKS.nothingToReview;
  if (run.status === "planning") return run.waitingOnApproval ? LOOKS.needsInput : run.attemptId === null ? LOOKS.queued : LOOKS.working;
  if (run.status === "running" && run.waitingOnApproval) return LOOKS.needsInput;
  const looks: Record<Exclude<RunStatus, "planning">, Look> = { awaiting_plan_approval: LOOKS.needsInput, running: LOOKS.working, awaiting_decision: LOOKS.readyForReview, done: LOOKS.done, cancelled: LOOKS.cancelled, failed: LOOKS.failed };
  return looks[run.status];
}

/** How many of a run's tasks are at an end: built, failed, stopped or cancelled. */
const finished = (tasks: readonly { status: string }[]): number => tasks.filter((task) => task.status !== "queued" && task.status !== "building").length;

/** What a list says under a run's title. */
export function runFacts(run: RunSummary): string {
  const count = run.readyCount > 0 ? `${tasksWord(run.readyCount)} ready for review` : run.status === "running" ? `${run.finishedCount} of ${tasksWord(run.taskCount)} finished` : run.taskCount > 0 ? `${tasksWord(run.taskCount)} planned` : "No plan yet";
  return `Run ${run.id} · ${count} · ${run.repo}`;
}

/** A run's state as a sentence that says only what is so. */
export function runSentence(run: Pick<RunDetail, "status" | "reason" | "waitingOnApproval" | "tasks" | "attemptId">): string {
  switch (run.status) {
    case "planning":
      // No planner has been started for it yet: one planner works at a time.
      if (run.attemptId === null) return "Queued. Botbench plans one run at a time, and this one starts when the one before it has its plan. Nothing is changed meanwhile.";
      return run.waitingOnApproval
        ? "Needs input. While planning, Claude Code asked for permission to run a command and is paused until you allow or deny."
        : "Planning. Claude Code is reading the repository and writing the task list. It only reads: nothing is changed while it plans.";
    case "awaiting_plan_approval":
      return "Plan ready for review. Edit the tasks if you need to, then approve the plan. Nothing is built before you approve.";
    case "running":
      // A task that waits for an answer holds up the tasks after it.
      if (run.waitingOnApproval) return `Needs input. Claude Code asked for permission while building a task and is paused until you allow or deny; the tasks after it wait. ${finished(run.tasks)} of ${tasksWord(run.tasks.length)} finished.`;
      return `Working. Botbench builds the tasks one at a time, in plan order, each by Claude Code in a separate copy of the project. ${finished(run.tasks)} of ${tasksWord(run.tasks.length)} finished.`;
    case "awaiting_decision":
      return `Ready for review. Every task has been built or has stopped; each says how it went.${run.tasks.some((task) => task.status === "awaiting_decision") ? " Accept or reject each task that is ready for review." : ""}`;
    case "done":
      if (nothingReviewed(run)) return "Nothing to review. Every task failed, was stopped or was cancelled before it was ready for review, so there is nothing to decide. Each task's own screen says why. A task Botbench's restarts stopped can be resumed, and what a task left can be discarded.";
      return "Done. Every task that was built has your decision. Nothing has been merged or pushed.";
    case "cancelled":
      return run.tasks.length === 0 ? "Cancelled. Nothing was built, and no task was made from this run." : "Cancelled. Tasks that had finished keep their branches; the task being built was stopped and what it did is committed; the rest were not built.";
    case "failed":
      return `Failed. ${run.reason ?? "No reason was recorded."}`;
  }
}

export type StationState = "done" | "running" | "waiting" | "failed" | "not-started";
export interface Station {
  name: string;
  state: StationState;
  words: string;
}

/**
 * A run's three stations, Plan, Build and Decide, each with its state in words, from the run's state and its tasks'
 * and nothing else. No station has a time: the run stores none for its stations. Null for a cancelled run, since the
 * timeline has no state for a station that was cancelled; the run's state in words says what happened.
 */
export function stations(run: Pick<RunDetail, "status" | "attemptId" | "waitingOnApproval" | "tasks">): { stations: Station[]; current: number | null } | null {
  const notStarted = (name: string): Station => ({ name, state: "not-started", words: "Not started" });
  const finished = run.tasks.filter((task) => task.status !== "queued" && task.status !== "building" && task.status !== "verifying" && task.status !== "reviewing").length;
  const ready = run.tasks.filter((task) => task.status === "awaiting_decision").length;
  const decided = run.tasks.filter((task) => task.status === "accepted" || task.status === "rejected").length;
  switch (run.status) {
    case "planning":
      if (run.attemptId === null) return { stations: [{ name: "Plan", state: "not-started", words: "Queued" }, notStarted("Build"), notStarted("Decide")], current: null };
      return { stations: [run.waitingOnApproval ? { name: "Plan", state: "waiting", words: "Needs input" } : { name: "Plan", state: "running", words: "Working" }, notStarted("Build"), notStarted("Decide")], current: 0 };
    case "awaiting_plan_approval":
      return { stations: [{ name: "Plan", state: "waiting", words: "Waiting for your approval" }, notStarted("Build"), notStarted("Decide")], current: 0 };
    case "failed":
      // A run fails only while it plans: once it has a plan, a task fails, not the run.
      return { stations: [{ name: "Plan", state: "failed", words: "Failed" }, notStarted("Build"), notStarted("Decide")], current: 0 };
    case "running":
      return {
        stations: [
          { name: "Plan", state: "done", words: "Done" },
          run.waitingOnApproval ? { name: "Build", state: "waiting", words: `Needs input · ${finished} of ${tasksWord(run.tasks.length)} finished` } : { name: "Build", state: "running", words: `Working · ${finished} of ${tasksWord(run.tasks.length)} finished` },
          ready > 0 ? { name: "Decide", state: "waiting", words: `${tasksWord(ready)} ready for review` } : notStarted("Decide"),
        ],
        current: 1,
      };
    case "awaiting_decision": {
      // Every task has ended. Build is done when at least one was built; when none was, it failed, and there is nothing to decide.
      const built = run.tasks.filter((task) => task.status === "awaiting_decision" || task.status === "accepted" || task.status === "rejected").length;
      if (built === 0) return { stations: [{ name: "Plan", state: "done", words: "Done" }, { name: "Build", state: "failed", words: "No task was built" }, notStarted("Decide")], current: 1 };
      return {
        stations: [
          { name: "Plan", state: "done", words: "Done" },
          { name: "Build", state: "done", words: built === run.tasks.length ? "Done" : `Done · ${built} of ${tasksWord(run.tasks.length)} built` },
          ready > 0 ? { name: "Decide", state: "waiting", words: `${tasksWord(ready)} ready for review` } : { name: "Decide", state: "done", words: `Done · ${decided} of ${tasksWord(built)} decided` },
        ],
        current: ready > 0 ? 2 : null,
      };
    }
    case "done": {
      if (decided === 0) return { stations: [{ name: "Plan", state: "done", words: "Done" }, { name: "Build", state: "failed", words: "No task was ready for review" }, notStarted("Decide")], current: null };
      return { stations: [{ name: "Plan", state: "done", words: "Done" }, { name: "Build", state: "done", words: "Done" }, { name: "Decide", state: "done", words: `Done · ${decided} of ${tasksWord(run.tasks.length)} decided` }], current: null };
    }
    case "cancelled":
      return null;
  }
}
