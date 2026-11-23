import { LOOKS, type Look } from "./looks.ts";
import type { FileChange, ModelList, PullRequestView, TaskDecision, TaskStatus, TaskSummary } from "../api/client.ts";
import { firstLine } from "../../../src/shorten.ts";

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
  waiting_for_limit: "Usage limit",
  drafted: "Drafted a message",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number): string => String(n).padStart(2, "0");

/**
 * A task waiting for a usage limit, in words, with the time it tries again in this device's own time: "at 14:30" the
 * same day, with the day named on another. Without a time, only the wait; once the time has come, that it is trying now.
 */
export function waitingWords(retryAt: string | null, now = new Date()): string {
  const base = "Waiting for a usage limit to reset.";
  const at = retryAt === null ? Number.NaN : Date.parse(retryAt);
  if (!Number.isFinite(at)) return base;
  if (at <= now.getTime()) return `${base} It is trying again now.`;
  const when = new Date(at);
  const clock = `${two(when.getHours())}:${two(when.getMinutes())}`;
  const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  return `${base} It will try again ${sameDay ? `at ${clock}` : `on ${DAYS[when.getDay()]} ${when.getDate()} ${MONTHS[when.getMonth()]} at ${clock}`}.`;
}

/** Whether the task stands still until the owner answers a request of its agent. */
const waiting = (task: Pick<TaskSummary, "status" | "waitingOnApproval">): boolean => task.status === "building" && task.waitingOnApproval;
/** Whether the owner's answer to a request from before a restart is stored and the task is being started again to receive it. */
const resuming = (task: Pick<TaskSummary, "status" | "resuming">): boolean => task.status === "building" && task.resuming;

/** Whether the owner resumed the task, or sent it a note for a round, and its work waits for another task's to end first. */
const behind = (task: Partial<Pick<TaskSummary, "waitingFor">>): boolean => task.waitingFor != null;

/** A task's station in a word or two, for lists. */
export const statusWord = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming"> & Partial<Pick<TaskSummary, "waitingFor">>): string => (waiting(task) ? "Needs input" : resuming(task) ? "Resuming" : behind(task) ? "Waiting" : STATUS_WORD[task.status]);

/** What a task waiting behind another one waits for, for its row: "Waiting for task 12 to finish". */
export const waitingForWords = (task: Partial<Pick<TaskSummary, "waitingFor">>): string | null => (task.waitingFor == null ? null : `Waiting for task ${task.waitingFor.taskId} to finish`);

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
  waiting_for_limit: LOOKS.usageLimit,
  drafted: LOOKS.drafted,
};
export const statusLook = (task: Pick<TaskSummary, "status" | "waitingOnApproval" | "resuming"> & Partial<Pick<TaskSummary, "waitingFor">>): Look => (waiting(task) ? LOOKS.needsInput : resuming(task) ? LOOKS.working : behind(task) ? LOOKS.queued : STATUS_LOOK[task.status]);

/** A task's station as a sentence that says only what is so. */
export function statusSentence(task: Pick<TaskSummary, "status" | "reason" | "baseCommit" | "headCommit" | "attemptId" | "waitingOnApproval" | "parked" | "resuming" | "ofPlan" | "decision"> & Partial<Pick<TaskSummary, "retryAt" | "waitingFor" | "waitingNote" | "onNoteRound" | "noteRoundLine">> & { pullRequest: Pick<PullRequestView, "state" | "number"> }, now = new Date()): string {
  // Why the task needs the owner: a fully autonomous run that did not accept it, or, in any mode, a protected file it changed.
  const why = task.status === "awaiting_decision" && task.reason !== null ? ` ${task.reason}` : "";
  if (waiting(task)) {
    return task.parked
      ? "Needs input. Claude Code asked for permission before Botbench restarted and is stopped. Your answer starts it again where it left off."
      : "Needs input. Claude Code asked for permission and is paused until you allow or deny.";
  }
  if (resuming(task)) return "Resuming. Your answer is saved. Botbench starts Claude Code again where it left off, after any task that is running now, and gives it your answer.";
  if (task.waitingFor != null) {
    const after = task.waitingNote?.forRound === true ? "Claude Code gets your note right after it." : "Botbench takes this task up again right after it.";
    return `Waiting for task ${task.waitingFor.taskId} to finish. ${after}`;
  }
  switch (task.status) {
    case "queued":
      return task.ofPlan === null ? "Queued. It starts when the tasks before it have finished." : `Queued. Run ${task.ofPlan} builds its tasks one at a time, in plan order: this one starts when the tasks before it have finished.`;
    case "building":
      // Before its agent starts, Botbench makes the task's copy and runs the repository's setup commands in it.
      if (task.attemptId === null) return "Working. Botbench is preparing a separate copy of the project for Claude Code.";
      return task.onNoteRound === true ? "Working. Claude Code is working on your note in the task's copy of the project." : "Working. Claude Code is working in a separate copy of the project.";
    case "verifying":
      return "Checking. Botbench committed the work to the task's branch and is running this repository's checks on it.";
    case "reviewing":
      return "In review. Botbench committed the work and ran the checks; the run's reviewer is reading the changes. You can decide once its review is in.";
    case "awaiting_decision":
      // Back after a note that changed nothing: that line says what is so, in place of the sentence about the commit.
      if (task.noteRoundLine != null) return `Ready for review. ${task.noteRoundLine}${why}`;
      return task.headCommit === task.baseCommit
        ? `Ready for review. No file was changed, so nothing was committed.${why}`
        : `Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.${why}`;
    case "accepted": {
      const accepted = task.decision?.decidedBy === "mode" ? "Accepted without you, as its run is fully autonomous." : "Accepted.";
      // Once the pull request is open, that is what became of the work, not only that the branch was kept.
      if (task.pullRequest.state === "opened" && task.pullRequest.number !== null) return `${accepted} Pull request #${task.pullRequest.number} opened.`;
      return `${accepted} Botbench kept the branch and removed the task's copy of the project.`;
    }
    case "rejected":
      return task.decision?.branch === "deleted" ? "Rejected. The branch was deleted, and the task's copy of the project was removed." : "Rejected. Botbench kept the branch and removed the task's copy of the project.";
    case "interrupted":
      return `Stopped. ${task.reason ?? "The task was stopped before it finished."}`;
    case "failed":
      return `Failed. ${task.reason ?? "No reason was recorded."}`;
    case "cancelled":
      return `Cancelled. ${task.reason ?? "Its run was cancelled."}`;
    case "waiting_for_limit":
      return waitingWords(task.retryAt ?? null, now);
    case "drafted":
      return `Drafted a message. ${task.reason ?? "Claude Code changed no file and drafted a message for another workbench."}`;
  }
}

/**
 * A task's title on its own screen: the first line of its prompt, cut at a word boundary to about two lines of the
 * title size on a phone (the whole prompt is the first row of the transcript); its number until the prompt is read.
 */
export function taskTitle(id: number, prompt: string | null): string {
  if (prompt === null || prompt.trim() === "") return `Task ${id}`;
  // The first line, whole up to 40 characters. A longer one is cut at the first word boundary at or after the 40th
  // character that has at least two words before it, so the title is never one word long; with none, it is whole.
  // A first line of one word is joined with the lines after it, so the title is not that word alone.
  const first = firstLine(prompt, Number.POSITIVE_INFINITY);
  const line = /\s/.test(first) ? first : prompt.trim().replace(/\s+/g, " ");
  const firstSpace = line.search(/\s/);
  if (firstSpace < 0) return line;
  for (let at = Math.max(TITLE_LEAST, firstSpace + 1); at < line.length; at++) {
    if (/\s/.test(line[at]!) && !/\s/.test(line[at - 1]!)) return `${line.slice(0, at)}…`;
  }
  return line;
}
/** The fewest characters a task's title is cut to. */
const TITLE_LEAST = 40;

/** Whether an accepted task offers the command that merges its branch on this Mac: not when its run opens pull requests, where the pull request is how the work comes in. */
export const offersMerge = (task: { pullRequest: Pick<PullRequestView, "choice"> }): boolean => task.pullRequest.choice !== "pull_request";

/** A changed file's marks, in words (src/engine/scope.ts): under a protected path, and not expected from the plan. None for a file the plan expected. */
export const fileMarks = (file: Pick<FileChange, "expected" | "protected">): string[] => [...(file.protected ? ["Protected"] : []), ...(file.expected ? [] : ["Not expected from the plan"])];

/** The line over the changed files that says what their marks mean, or null when no file has a mark. */
export function fileMarksLine(files: readonly Pick<FileChange, "expected" | "protected">[]): string | null {
  const count = (n: number): string => (n === 1 ? "1 file" : `${n} files`);
  const guarded = files.filter((f) => f.protected).length;
  const unexpected = files.filter((f) => !f.expected).length;
  const parts = [
    ...(guarded > 0 ? [`${count(guarded)} ${guarded === 1 ? "is" : "are"} under a protected path, which only you can accept`] : []),
    ...(unexpected > 0 ? [`${count(unexpected)} ${unexpected === 1 ? "was" : "were"} not expected from the plan: the task's words, its checks and its tests do not name ${unexpected === 1 ? "it" : "them"}`] : []),
  ];
  return parts.length === 0 ? null : `${parts.join(". ")}.`;
}

/** What has left the machine, in one sentence that is true before a decision, after one, and after a push for a pull request. */
export const notMergedLine = (task: { decision: Pick<TaskDecision, "decision"> | null; pullRequest: Pick<PullRequestView, "pushed"> }): string =>
  task.pullRequest.pushed ? "Nothing has been merged. The branch was pushed for its pull request." : "Nothing has been merged or pushed.";

/**
 * Whether the model a session reports is not the one asked for, by the agent's own list, where an alias and the full
 * name it stands for are the same model. Nothing is claimed while nothing has answered, when Claude Code's own default
 * was asked for, or while the list is not known.
 */
export function answeredOther(list: ModelList | null, answered: string | null, requested: string | null): boolean {
  if (answered === null || requested === null || answered === requested || list === null) return false;
  const entry = list.models.find((model) => model.id === requested || model.resolved === requested);
  return entry === undefined || (answered !== entry.id && answered !== entry.resolved);
}
