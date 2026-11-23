import type { Evidence, MainUpdate } from "../api/client.ts";
import { counted } from "./format.ts";

/*
 * The words of bringing a task up to date with main (src/engine/branch-update.ts) and of machine checks
 * (src/engine/machine-checks.ts), on the task's screen. The server's own lines (`mainUpdate.line`, a check's output)
 * are shown as it sends them.
 */

const commits = (n: number): string => counted(n, "commit", "commits");

/** The section's heading. */
export const MAIN_HEADING = "Main";

/** How the branch stands against main, for a task that is ready for review; null when it was not read. */
export function behindLine(m: Pick<MainUpdate, "behind" | "branch">): string | null {
  if (m.behind === null || m.branch === null) return null;
  return m.behind === 0 ? `This branch holds everything on ${m.branch}.` : `This branch is ${commits(m.behind)} behind ${m.branch}: ${m.branch} moved on since this task started.`;
}

/** What the button does, read before it is pressed. */
export const updateAbout = (branch: string, builder: string): string =>
  `Bring up to date merges ${branch} into this task's branch in its own copy, as one new commit: nothing already on the branch is rewritten, and nothing is pushed. If they conflict, ${builder} resolves the conflicts in the same session and under the same permissions as its build; if it cannot, the merge is undone. Then the checks run again, and the task is ready for review again.`;

/** The button, while idle and while the request is on its way. */
export const updateButton = (branch: string, busy: boolean): string => (busy ? "Bringing up to date" : `Bring up to date with ${branch}`);

/** What the run chose to do when a task's branch is behind main as it is handed to you, for the task's screen. */
export function choiceLine(m: Pick<MainUpdate, "choice" | "behind">): string | null {
  if (m.behind === null || m.behind === 0) return null;
  if (m.choice === "ask") return "Bring it up to date before you accept, so that what you accept is checked with what is on main now.";
  if (m.choice === "off") return null;
  return null;
}

/** A request that was refused, in words. */
export const updateRefused = (why: string | null): string => `The task was not brought up to date. ${why ?? "Botbench could not be reached."}`;

/** What a machine check was allowed beyond a check, for its row; null for an ordinary check. */
export function needsLine(row: Pick<Evidence, "needs">): string | null {
  if (row.needs === null) return null;
  const needs = row.needs.split(",");
  if (needs.includes("nested-sandbox")) return "Ran by Botbench outside any sandbox, with your own rights: it starts a sandbox of its own, which macOS allows only there.";
  if (needs.includes("chrome")) return "Ran by Botbench in a check's sandbox, allowed to start Chrome.";
  return null;
}

/** The names of the choices a run offers for a branch behind main, and what each does. */
export const MAIN_CHOICE_WORDS = {
  title: "When main moved on",
  ask: { name: "Ask me", value: "Ask", description: "When a task is ready for review and main moved on since it started, the task offers to bring its branch up to date with main." },
  auto: { name: "Bring it up to date", value: "Bring up to date", description: "Before a task is handed to you, Botbench merges main into its branch, has the builder resolve any conflict, and runs the checks again." },
  off: { name: "Leave it", value: "Off", description: "The task does not offer it. You can still bring it up to date from its screen." },
} as const;
