/*
 * A task of a run's plan while the owner edits it (screens2/run/), decided without a browser (test/plan-edit.test.ts).
 */

/** A task as the plan holds it. */
export interface PlanText {
  title: string;
  criteria: readonly string[];
}

/** The criteria in the editor's box: one on each line. */
export const toLines = (criteria: readonly string[]): string => criteria.join("\n");

/** The criteria the box holds: each line that has words, without the space around them. */
export const fromLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A task being edited: where it sits in the plan, what the boxes hold, and the task as it was when the editor opened (null for a new one). */
export interface PlanEdit {
  at: number | "new";
  title: string;
  criteria: string;
  from: PlanText | null;
}

/** The editor for the task at `at`, as it opens. */
export const openEdit = (at: number, task: PlanText): PlanEdit => ({ at, title: task.title, criteria: toLines(task.criteria), from: { title: task.title, criteria: [...task.criteria] } });

/** The editor for a new task. */
export const NEW_EDIT: PlanEdit = { at: "new", title: "", criteria: "", from: null };

/**
 * Whether the editor holds words that leaving it would lose: it differs from the task as it was opened, or it is a new
 * task with anything typed. Compared as the task would be saved, so space alone is not a change. The plan as it is now
 * is not asked: another window changing it does not make an untouched editor a changed one.
 */
export function editChanged(editing: PlanEdit): boolean {
  const before = editing.from ?? { title: "", criteria: [] };
  return editing.title.trim() !== before.title || toLines(fromLines(editing.criteria)) !== toLines(before.criteria);
}

/** Whether the plan still has the place the editor was opened on: the run still waits for its plan, and the task is still there. */
export const editStands = (editing: PlanEdit, plan: readonly PlanText[], waiting: boolean): boolean => waiting && (editing.at === "new" || editing.at < plan.length);
