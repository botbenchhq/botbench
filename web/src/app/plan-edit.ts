/*
 * A task of a run's plan while the owner edits it (screens/run.tsx), decided without a browser (test/plan-edit.test.ts).
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

/**
 * Whether the editor holds words that leaving it would lose: it differs from the task it was opened on, or it is a new
 * task with anything typed. Compared as the task would be saved, so space alone is not a change.
 */
export function editChanged(editing: { at: number | "new"; title: string; criteria: string }, plan: readonly PlanText[]): boolean {
  const before = editing.at === "new" ? { title: "", criteria: [] } : plan[editing.at];
  if (before === undefined) return editing.title.trim() !== "" || fromLines(editing.criteria).length > 0;
  return editing.title.trim() !== before.title || toLines(fromLines(editing.criteria)) !== toLines(before.criteria);
}
