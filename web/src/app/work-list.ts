import type { BoardGroup, BoardItem } from "../api/client.ts";
import { runWord } from "../components/run-status.ts";
import { statusWord } from "../components/task-status.ts";

/*
 * What the column of chats and work beside a wide screen lists and says, decided without a browser
 * (test/work-list.test.ts). It reads only what /api/board returns. Approach from OpenMausBot
 * src/components/Sidebar.tsx: the sidebar's own query, trimmed and matched case-blind against each row's title.
 */

/** One row of the column: what it links to, its title and its state in words. */
export interface WorkRow {
  key: string;
  kind: "run" | "task" | "chat";
  id: number;
  href: string;
  title: string;
  state: string;
  updatedAt: string;
}

/** What the column holds: its rows newest change first, and how many runs and tasks there are in all. */
export interface WorkRows {
  rows: WorkRow[];
  /** The real count across the board's groups; more than `rows.length` when Finished sent only its newest. */
  total: number;
}

const row = (item: BoardItem): WorkRow =>
  item.kind === "run"
    ? { key: `run ${item.id}`, kind: "run", id: item.id, href: `#/runs/${item.id}`, title: item.title, state: runWord(item), updatedAt: item.updatedAt }
    : item.kind === "chat"
      ? { key: `chat ${item.id}`, kind: "chat", id: item.id, href: `#/chats/${item.id}`, title: item.title, state: "Chat", updatedAt: item.updatedAt }
      : { key: `task ${item.id}`, kind: "task", id: item.id, href: `#/tasks/${item.id}`, title: item.title, state: statusWord(item), updatedAt: item.updatedAt };

/** The board's groups as one list, newest change first: the column has no groups of its own. */
export function workRows(groups: readonly BoardGroup[]): WorkRows {
  const rows = groups.flatMap((group) => group.items.map(row));
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { rows, total: groups.reduce((sum, group) => sum + group.total, 0) };
}

/** The rows whose title holds the typed words, as typed, in any case. An empty search keeps every row. */
export function matching(rows: readonly WorkRow[], query: string): WorkRow[] {
  const words = query.trim().toLowerCase();
  return words === "" ? [...rows] : rows.filter((r) => r.title.toLowerCase().includes(words));
}

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 runs and 3 tasks", "1 task", "1 chat, 1 run and 2 tasks": what the listed rows are, by kind. */
function kinds(rows: readonly WorkRow[]): string {
  const parts = [
    counted(rows.filter((r) => r.kind === "chat").length, "chat", "chats"),
    counted(rows.filter((r) => r.kind === "run").length, "run", "runs"),
    counted(rows.filter((r) => r.kind === "task").length, "task", "tasks"),
  ].filter((part) => !part.startsWith("0 "));
  if (parts.length === 0) return counted(0, "task", "tasks");
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The search field's count line: how many rows are shown, in words, and of how many when a search narrows them. */
export function countLine(list: WorkRows, query: string, shown: number): string {
  const words = query.trim();
  // Only Finished is cut short by the board, so what is left out is always the oldest finished work.
  const left = list.total - list.rows.length;
  if (words === "") return left > 0 ? `${kinds(list.rows)}. The ${left} oldest finished ${left === 1 ? "one is" : "are"} not listed.` : kinds(list.rows);
  if (shown === 0) return `None of ${list.rows.length} match "${words}"`;
  return `${shown} of ${list.rows.length} match "${words}"`;
}
