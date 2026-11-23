import type { CommandList, Evidence } from "../api/client.ts";

/*
 * What an earlier time a task's list of commands ran is called, from the rows alone. A list cut short (a command
 * stopped, or not all of it run) was stopped by Botbench stopping or by a cancel, and was run again from the start. A
 * list of checks that ran whole checked one version of the work: the first build's, then each round of fixes' that
 * changed it, in order. Setup commands run again only after a restart cut them short, or before any agent started.
 */

const finished = (rows: readonly Evidence[], round: number, total: number | undefined): boolean => {
  const of = rows.filter((row) => row.round === round);
  return of.every((row) => row.outcome !== "stopped") && of.length >= (total ?? of.length);
};

export function roundLabel(rows: readonly Evidence[], lists: readonly CommandList[], round: number, kind: Evidence["kind"]): string {
  const totalOf = (r: number): number | undefined => lists.find((list) => list.kind === kind && list.round === r)?.total;
  const what = kind === "check" ? "Checks" : "Setup commands";
  if (!finished(rows, round, totalOf(round))) return `${what} stopped before they finished`;
  if (kind === "setup") return "Setup commands before Botbench restarted";
  const before = [...new Set(rows.filter((row) => row.round < round).map((row) => row.round))].filter((r) => finished(rows, r, totalOf(r))).length;
  return before === 0 ? "Checks of the first build" : `Checks after round ${before} of fixes`;
}
