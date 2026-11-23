import type { BoardGroup, BoardItem } from "../api/client.ts";
import { runWord } from "../components/run-status.ts";
import { statusWord } from "../components/task-status.ts";

/*
 * What the column of runs and tasks beside a wide screen lists and says, decided without a browser
 * (test/work-list.test.ts). It reads only what /api/board returns. Approach from OpenMausBot
 * src/components/Sidebar.tsx: the sidebar's own query, trimmed and matched case-blind against each row's title.
 */

/** One row of the column: what it links to, its title and its state in words. */
export interface WorkRow {
  key: string;
  kind: "run" | "task";
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

/** "2 runs and 3 tasks", "1 task": what the listed rows are, by kind. */
function kinds(rows: readonly WorkRow[]): string {
  const runs = rows.filter((r) => r.kind === "run").length;
  const tasks = rows.length - runs;
  if (runs === 0) return counted(tasks, "task", "tasks");
  if (tasks === 0) return counted(runs, "run", "runs");
  return `${counted(runs, "run", "runs")} and ${counted(tasks, "task", "tasks")}`;
}

/** The search field's count line: how many rows are shown, in words, and of how many when a search narrows them. */
export function countLine(list: WorkRows, query: string, shown: number): string {
  const words = query.trim();
  if (words === "") return list.total > list.rows.length ? `The newest ${list.rows.length} of ${list.total} runs and tasks` : kinds(list.rows);
  if (shown === 0) return `None of ${list.rows.length} match "${words}"`;
  return `${shown} of ${list.rows.length} match "${words}"`;
}
