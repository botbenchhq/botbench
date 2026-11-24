import type { WorkItem, WorkKind, WorkPage, WorkState } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { folderName } from "../../app/composer.ts";
import { ago, counted, dayAndClock, number, type Where } from "../../app/format.ts";
import { runWord } from "../../components/run-status.ts";
import { statusWord } from "../../components/task-status.ts";

/*
 * What Work says, in words, from what the server sent (/api/work). Which rows match, how many there are and where each
 * stands is the server's; a row's state is said in the words every other screen uses for it (components/task-status.ts,
 * components/run-status.ts). Kept apart from the screen so it is tested without a browser (test/home-words.test.ts).
 */

export const KINDS: readonly { value: WorkKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "run", label: "Runs" },
  { value: "chat", label: "Chats" },
];

export const STATES: readonly { value: WorkState; label: string }[] = [
  { value: "any", label: "Any state" },
  { value: "needs-you", label: "Needs you" },
  { value: "in-progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "ended", label: "Ended otherwise" },
];

/** A row's state, in the product's own words. What waits by itself says what for, as Home does. */
export function stateWord(item: WorkItem): string {
  if (item.kind === "chat") return item.cause === "approval" ? "Needs input" : "Chat";
  if (item.cause === "usage-limit") return "Waiting on usage limit";
  if (item.cause === "dependency") return "Waiting on dependency";
  if (item.kind === "task") return statusWord(item);
  // A run stands where the most urgent thing in it does, and says that: a task of it to decide on, or one to resume.
  if (item.cause === "result") return "Ready for review";
  if (item.cause === "failure") return item.failure === "stopped" ? "Stopped" : "Failed";
  return runWord(item);
}

/** Which run, task or chat a row is: "Task 22", "Run 9", "Chat". */
export const kindWord = (item: Pick<WorkItem, "kind" | "id">): string => (item.kind === "chat" ? "Chat" : `${item.kind === "run" ? "Run" : "Task"} ${item.id}`);

/** Who works on it: the agent by its product name, or how many agents a chat asked. */
export const agentWord = (item: Pick<WorkItem, "agents">): string => (item.agents.length === 0 ? "None" : item.agents.length === 1 ? agentName(item.agents[0]!) : counted(item.agents.length, "agent", "agents"));

/** The repository by its folder's name; a chat has none. */
export const repoWord = (item: WorkItem): string => (item.kind === "chat" ? "None" : folderName(item.repo));

/** When a row last changed: "Now", "12 minutes ago", and from a day back the day and the clock. */
export function changed(updatedAt: string, now: number, where: Where = {}): string {
  const since = now - Date.parse(updatedAt);
  if (since < 60_000) return "Now";
  return since < 24 * 60 * 60 * 1000 ? ago(updatedAt, now, where) : dayAndClock(updatedAt, where);
}

/** The line under the heading: what Work is, and how much of it there is. */
export const aboutLine = (all: number, hiddenView: boolean): string =>
  hiddenView ? `Rows hidden from the list: ${number(all)}. Hiding deletes nothing: each row's More menu can show it in the list again.` : `Every task, run and chat on this workbench. ${number(all)} in all, newest change first.`;

/** How many of the matches are on the screen: "14 of 63 shown". */
export const shownLine = (shown: number, total: number): string => `${number(shown)} of ${number(total)} shown`;

/** What is older than the rows shown: "49 more, back to 3 November at 08:05". */
export const olderLine = (older: NonNullable<WorkPage["older"]>, where: Where = {}): string => `${number(older.count)} more, back to ${dayAndClock(older.oldest, where)}`;

/** What an empty list says: nothing at all yet, nothing hidden, or nothing that matches. */
export function noneLine(page: Pick<WorkPage, "all">, filtered: boolean, hiddenView: boolean): string {
  if (filtered) return "Nothing matches. Clear the search or choose All and Any state to see everything.";
  if (hiddenView) return "Nothing is hidden.";
  return page.all === 0 ? "No work yet. Each chat, run and task you start is listed here." : "Nothing matches.";
}
