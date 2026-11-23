import type { PeersView } from "../api/client.ts";

/*
 * What the composer and the task screen say about other workbenches' work on the same repository (Peers P2). Each
 * line is a warning only: nothing here ever stops a send or a decision. Everything taken from the view (a workbench's
 * name, a title, a path) is outside text, shown by the caller as plain text.
 */

const MAX_NUMBER = 2_147_483_647;

/**
 * The issue numbers a message names, best effort: "#59", "Issue #59", "(#60)". Not a page anchor ("page.html#59"), an
 * entity ("&#59;"), a word with a number in it ("x#59"), a colour ("#fff") or a number no issue can have. Once each, in order.
 */
export function spottedIssues(message: string): number[] {
  const found: number[] = [];
  for (const match of message.matchAll(/(?<![\w&/#.])#([1-9]\d{0,9})(?![\w])/g)) {
    const n = Number(match[1]);
    if (n <= MAX_NUMBER && !found.includes(n)) found.push(n);
  }
  return found;
}

/** The most warnings the composer shows at once. */
const MAX_WARNINGS = 3;

/** The composer's warnings: another workbench's open pull request for the attached issue, or for an issue the message names. */
export function issueWarnings(view: PeersView | null, o: { attached: number | null; message: string }): string[] {
  if (view === null || view.state !== "ready") return [];
  const lines: string[] = [];
  if (o.attached !== null) for (const pr of view.pullRequests.filter((p) => p.closes.includes(o.attached!))) lines.push(`${pr.workbench} already has pull request #${pr.number} open for this issue.`);
  for (const n of spottedIssues(o.message).filter((n) => n !== o.attached)) {
    for (const pr of view.pullRequests.filter((p) => p.closes.includes(n))) lines.push(`A best-effort match on #${n} in your message: ${pr.workbench} already has pull request #${pr.number} open for issue #${n}.`);
  }
  return lines.slice(0, MAX_WARNINGS);
}

/** The most file names one overlap line lists. */
const MAX_FILES = 5;

const list = (items: string[]): string => (items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** At review time: for each open pull request of another workbench that changes files this task changed too, one line naming it and those files. */
export function overlapLines(view: PeersView | null, taskFiles: readonly string[]): string[] {
  if (view === null || view.state !== "ready") return [];
  const ours = new Set(taskFiles);
  return view.pullRequests.flatMap((pr) => {
    const both = pr.files.filter((f) => ours.has(f)).sort();
    if (both.length === 0) return [];
    const named = both.length > MAX_FILES ? [...both.slice(0, MAX_FILES), `${both.length - MAX_FILES} more ${both.length - MAX_FILES === 1 ? "file" : "files"}`] : both;
    return [`${pr.workbench}'s open pull request #${pr.number} also changes ${list(named)}, so the two may conflict when both are merged.`];
  });
}
