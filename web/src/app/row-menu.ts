import type { BoardItem, RunStatus } from "../api/client.ts";
import { counted } from "./format.ts";

/*
 * What each row's More menu on Work offers, decided here without a browser (test/row-menu.test.ts). A run or a task
 * offers only what is real for it now: Open always; Copy branch name while git still has the branch; Open pull request
 * while one is open; Cancel run while the run is still going; Discard for a failed, stopped or cancelled task with its
 * copy or its branch left. A chat offers Rename and Hide only. Every row offers Hide from the list, or, among the
 * hidden rows, Show in the list. The item that takes something away is last, below a divider, and names the row.
 * The approach is from OpenMausBot's src/components/ChatMoreMenu.tsx (one list of items per row, built from the row's
 * state, tested by its keys), written again in Botbench's terms.
 */

export type RowAction = "open" | "copy-branch" | "open-pull-request" | "rename" | "hide" | "show" | "cancel" | "discard";

export interface RowMenuItem {
  action: RowAction;
  label: string;
  /** The design system's icon before the label, if any. */
  icon: "external-link" | "copy" | null;
  /** The item takes something away: last, below a divider, drawn as danger. */
  danger: boolean;
}

/** What the row is called where the menu names it: "run 4", "task 12", "chat". */
export const rowName = (item: BoardItem): string => (item.kind === "chat" ? `chat ${item.title}` : `${item.kind} ${item.id}`);

/** The More button's name, which tells the rows apart: "More actions for run 4". */
export const moreName = (item: BoardItem): string => `More actions for ${rowName(item)}`;

/** The items of a row's More menu, in order. `hiddenView`: the list shows the rows hidden from it. */
export function rowMenu(item: BoardItem, hiddenView: boolean): RowMenuItem[] {
  const hide: RowMenuItem = hiddenView ? { action: "show", label: "Show in the list", icon: null, danger: false } : { action: "hide", label: "Hide from the list", icon: null, danger: false };
  if (item.kind === "chat") return [{ action: "rename", label: "Rename chat", icon: null, danger: false }, hide];
  const items: RowMenuItem[] = [{ action: "open", label: item.kind === "run" ? `Open run ${item.id}` : `Open task ${item.id}`, icon: null, danger: false }];
  if (item.branch !== null) items.push({ action: "copy-branch", label: "Copy branch name", icon: "copy", danger: false });
  if (item.pullRequest !== null) items.push({ action: "open-pull-request", label: `Open pull request #${item.pullRequest.number}`, icon: "external-link", danger: false });
  items.push(hide);
  if (item.kind === "run" && item.cancellable) items.push({ action: "cancel", label: `Cancel run ${item.id}`, icon: null, danger: true });
  if (item.kind === "task" && item.discardable) items.push({ action: "discard", label: `Discard task ${item.id}`, icon: null, danger: true });
  return items;
}

/** What cancelling a run does, as its confirmation says it, on the run's screen and from its More menu alike. */
export function cancelStatement(status: RunStatus, planned: number): string {
  if (status === "planning") return "The planner is stopped and no plan is kept. Nothing was built.";
  if (status === "awaiting_plan_approval") return `The plan of ${counted(planned, "task", "tasks")} is dropped and nothing is built. A cancelled run cannot be started again; start a new one instead.`;
  return "Tasks that have finished keep their branches. The task being built is stopped, and what it did so far is committed to its branch. Tasks that have not started are not built. A cancelled run cannot be started again.";
}
