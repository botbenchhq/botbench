import type { Cause, Home, HomeItem } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { folderName } from "../../app/composer.ts";
import { clock, counted, dayAndClock, duration, number, plural, sameDay, type Where } from "../../app/format.ts";
import { MODE_NAMES } from "../../app/run-words.ts";

/*
 * What Home says, in words, from what the server sent (/api/home). Nothing here decides where a run, a task or a chat
 * stands, what it waits for or in what order: that is the server's (src/engine/queue.ts). This is only the wording,
 * kept apart from the screen so it is tested without a browser (test/home-words.test.ts).
 */

/** Where a row leads: a run's or a task's screen, or Chat with that chat on it. */
export const hrefOf = (item: { kind: "run" | "task" | "chat"; id: number }): string => (item.kind === "run" ? `#/runs/${item.id}` : item.kind === "task" ? `#/tasks/${item.id}` : `#/chats/${item.id}`);

/** The situation in one line: "3 things need you, 2 are in progress". */
export function headline(home: Pick<Home, "needsYou" | "inProgress">): string {
  const needs = home.needsYou.total;
  const going = home.inProgress.total;
  const first = needs === 0 ? "Nothing needs you" : `${number(needs)} ${plural(needs, "thing needs", "things need")} you`;
  return going === 0 ? first : `${first}, ${number(going)} ${plural(going, "is", "are")} in progress`;
}

/** What else is so, under the headline: what waits by itself, what was completed in the last day, and how much there is in all. Null when there is nothing to add. */
export function subline(home: Pick<Home, "waiting" | "completed" | "total">): string | null {
  const waiting = home.waiting.total;
  const parts = [
    ...(waiting === 0 ? [] : [`${number(waiting)} ${plural(waiting, "is waiting and goes on by itself", "are waiting and go on by themselves")}.`]),
    ...(home.completed.lastDay === 0 ? [] : [`${number(home.completed.lastDay)} completed in the last day.`]),
    ...(home.total < 10 ? [] : [`${number(home.total)} in all.`]),
  ];
  return parts.length === 0 ? null : parts.join(" ");
}

/** The rule Needs you is ordered by, said once, quietly, beside its heading (the order itself is the server's). */
export const ORDER_LINE = "In order: an approval holding an agent, a failure to recover, plans, then results. Oldest wait first.";

/** Which run, task or chat a row is, and where: "Task 14 · repo-refine · Manual". */
export function facts(item: Pick<HomeItem, "kind" | "id" | "repo" | "mode">): string {
  if (item.kind === "chat") return "Chat";
  return [`${item.kind === "run" ? "Run" : "Task"} ${item.id}`, ...(item.repo === null ? [] : [folderName(item.repo)]), ...(item.mode === null ? [] : [MODE_NAMES[item.mode]])].join(" · ");
}

/** One thing that needs the owner, in words: what kind of thing, what is so (with the command, when it is one, apart, to be set as code), and the one action that leads to it. */
export interface Need {
  label: string;
  /** What the owner's answer means, for the item at the top. */
  lead: string;
  words: string;
  code: string | null;
  action: string;
}

const agentOf = (item: Pick<HomeItem, "agents">): string => agentName(item.agents[0] ?? "claude-code");

export function need(item: HomeItem): Need {
  const agent = agentOf(item);
  if (item.cause === "approval") {
    const asks = item.approval ?? null;
    const lead = `${agent} is paused until you answer`;
    if (asks === null) return { label: "Approval", lead, words: `${agent} asks for your approval`, code: null, action: "Answer" };
    if (asks.tool === "AskUserQuestion") return { label: "Approval", lead, words: `${agent} asks you a question`, code: null, action: "Answer" };
    return asks.tool === "Bash" ? { label: "Approval", lead, words: `${agent} asks to run`, code: asks.command, action: "Answer" } : { label: "Approval", lead, words: `${agent} asks to use ${asks.tool}`, code: null, action: "Answer" };
  }
  if (item.cause === "failure") {
    const stopped = item.failure === "stopped";
    const why = item.reason ?? (item.kind === "run" ? "A task of this run stopped before it finished." : "It stopped before it finished.");
    return { label: stopped ? "Stopped" : "Failed", lead: "It can be resumed", words: why, code: null, action: stopped ? "See why it stopped" : "See what failed" };
  }
  if (item.cause === "plan") return { label: "Plan", lead: "Nothing is built before you approve", words: `${counted(item.taskCount ?? 0, "task", "tasks")}, nothing is built before you approve`, code: null, action: "Read the plan" };
  const lead = "The work is finished and waits for your decision";
  if (item.kind === "run") return { label: "Result", lead, words: `${counted(item.readyCount ?? 0, "task", "tasks")} of ${number(item.taskCount ?? 0)} ready for review`, code: null, action: "Review" };
  return { label: "Result", lead, words: item.evidence?.words ?? "Botbench cannot read its evidence now, so it cannot be accepted yet.", code: null, action: "Review" };
}

/** How long something has waited or been at work, in whole minutes, short enough for a row's end: "under 1 min", "12 min", "1 h 4 min", "50 h". */
export function lasted(since: string, now: number, where: Where = {}): { words: string; iso: string } {
  const minutes = Math.floor(Math.max(0, now - Date.parse(since)) / 60_000);
  return minutes < 1 ? { words: "under 1 min", iso: "PT0S" } : duration(minutes * 60_000, "units", where);
}

/** What a row in progress is doing: "Working · Claude Code · billing-api"; a run says how far it is. */
export function progressLine(item: HomeItem): string {
  const word = item.kind === "run" ? (item.status === "planning" ? "Planning" : `Working · ${number(item.finishedCount ?? 0)} of ${counted(item.taskCount ?? 0, "task", "tasks")} finished`) : ({ queued: "Queued", verifying: "Checking", reviewing: "In review" }[item.status ?? ""] ?? "Working");
  return [word, agentOf(item), ...(item.repo === null ? [] : [folderName(item.repo)])].join(" · ");
}

/** What something waits for, by name: the Waiting group's causes. */
export const CAUSE_WORDS: Partial<Record<Cause, string>> = { "usage-limit": "Waiting on usage limit", dependency: "Waiting on dependency" };

/** When a usage limit is tried again, in this device's time: "tries again at 14:30", with the day when it is another. Null when no time is stored. */
export function triesAgain(retryAt: string | null | undefined, now: number, where: Where = {}): string | null {
  const at = retryAt == null ? Number.NaN : Date.parse(retryAt);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return "trying again now";
  return `tries again ${sameDay(at, now, where) ? `at ${clock(at, where)}` : `on ${dayAndClock(at, where)}`}`;
}

/** What a waiting row says after its cause: the task that goes first, or the agent whose limit it is and when it is tried again. */
export function waitLine(item: HomeItem, now: number, where: Where = {}): string {
  if (item.cause === "dependency") return item.waitingFor == null ? "another task goes first" : `task ${item.waitingFor.taskId} goes first`;
  return [agentOf(item), triesAgain(item.retryAt, now, where)].filter((part) => part !== null).join(" · ");
}

/** What became of completed work: "Accepted · pull request #48 opened", "Accepted without you". */
export function acceptedLine(item: Pick<HomeItem, "accepted">): string {
  const accepted = item.accepted?.by === "mode" ? "Accepted without you" : "Accepted";
  const opened = item.accepted?.pullRequests ?? [];
  return opened.length === 0 ? accepted : `${accepted} · ${opened.length === 1 ? `pull request #${opened[0]} opened` : `${number(opened.length)} pull requests opened`}`;
}

/** The quiet line for what ended any other way and is in Work: "1 rejected and 2 cancelled are in Work". Null when there is none. */
export function endedLine(ended: Home["ended"]): string | null {
  const parts = [
    ...(ended.rejected === 0 ? [] : [`${number(ended.rejected)} rejected`]),
    ...(ended.cancelled === 0 ? [] : [`${number(ended.cancelled)} cancelled`]),
    ...(ended.stopped === 0 ? [] : [`${number(ended.stopped)} stopped`]),
    ...(ended.other === 0 ? [] : [`${number(ended.other)} with nothing to review`]),
  ];
  if (parts.length === 0) return null;
  const total = ended.rejected + ended.cancelled + ended.stopped + ended.other;
  return `${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`} ${plural(total, "is", "are")} in Work`;
}

/** The same for what failed with nothing to resume: "1 failed is in Work" reads badly, so it names what failed. */
export const failedLine = (failed: number): string | null => (failed === 0 ? null : `${counted(failed, "failure", "failures")} with nothing to resume ${plural(failed, "is", "are")} in Work`);

/** A group is shown row by row while the server sent every one of its rows; past that it is summarized, with its first rows. */
export const summarized = (group: { total: number; items: readonly unknown[] }): boolean => group.total > group.items.length;

/** Counted names for a summary row, the most frequent first: the first `keep`, then how many more are in how many others. */
export function countedNames(counts: readonly { name: string; count: number }[], keep: number, name: (raw: string) => string): { count: number; name: string }[] {
  const shown = counts.slice(0, keep).map((one) => ({ count: one.count, name: name(one.name) }));
  const rest = counts.slice(keep);
  return rest.length === 0 ? shown : [...shown, { count: rest.reduce((sum, one) => sum + one.count, 0), name: `in ${number(rest.length)} more` }];
}
