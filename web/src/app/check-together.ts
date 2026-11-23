import type { CheckTogetherView, CombinedCheck } from "../api/client.ts";

/*
 * What the task screen says about checking a task together with another workbench's open pull request (Peers P4), as
 * plain functions, so the words are tested without a browser. A workbench's name and a pull request's title and files
 * are outside text: shown as they are, never as an instruction.
 */

/** A commit as people read it: its first seven characters. */
export const shortCommit = (commit: string | null): string => (commit === null ? "an unknown commit" : commit.slice(0, 7));

const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** What the result came to, in one sentence. */
export function outcomeLine(check: Pick<CombinedCheck, "outcome" | "conflicts" | "problem" | "commands">): string {
  if (check.outcome === "conflict") return `The two did not merge: ${check.conflicts.length === 1 ? "1 file is" : `${check.conflicts.length} files are`} in conflict, ${listed(check.conflicts)}. No check was run.`;
  if (check.outcome === "not_run") return check.problem ?? "The check together did not run.";
  const notPassed = check.commands.filter((c) => c.outcome !== "passed").length;
  return check.outcome === "passed" ? "Merged cleanly, and every check passed on the merge." : `Merged cleanly, and ${notPassed === 1 ? "1 command" : `${notPassed} commands`} did not pass on the merge.`;
}

/** Which two commits it ran on. */
export const commitsLine = (check: Pick<CombinedCheck, "pullRequest" | "peerCommit" | "taskCommit">): string => `Ran on pull request #${check.pullRequest} at ${shortCommit(check.peerCommit)} and this task at ${shortCommit(check.taskCommit)}.`;

/** Whether it still stands, when it does not: naming the commit it ran on and the new one. Null when it is current. */
export function staleLine(check: Pick<CombinedCheck, "pullRequest" | "peerCommit" | "taskCommit" | "freshness">): string | null {
  const f = check.freshness;
  if (f.state === "current") return null;
  if (f.state === "closed") return `Pull request #${check.pullRequest} is no longer open from another workbench, so this result no longer counts.`;
  if (f.state === "unknown") return `Botbench could not tell whether this result is still current, so it does not count: ${f.problem}`;
  const moved: string[] = [];
  if (f.pullRequestMoved) moved.push(`pull request #${check.pullRequest} is now at ${shortCommit(f.pullRequestNow)}, and this ran on ${shortCommit(check.peerCommit)}`);
  if (f.taskMoved) moved.push(f.taskNow === null ? `this task's branch is no longer there, and this ran on ${shortCommit(check.taskCommit)}` : `this task's branch is now at ${shortCommit(f.taskNow)}, and this ran on ${shortCommit(check.taskCommit)}`);
  return `Out of date: ${moved.join("; ")}. It no longer counts. Check together again.`;
}

/** The sentence that says the result ran someone else's code. */
export const othersCodeLine = (check: Pick<CombinedCheck, "workbench" | "pullRequest">): string =>
  `Includes another workbench's code: ${check.workbench}'s pull request #${check.pullRequest}, which nobody here reviewed. It ran in the same sandbox as this task's checks.`;

/** What the setting means, and what is still needed under it. */
export function requirementLine(view: Pick<CheckTogetherView, "required" | "waitingOn" | "offers"> & { undetermined?: string | null }): string {
  if (!view.required) return "Not required on this repository. When it is, a fully autonomous run accepts a task only after a passing check together with each open pull request from another workbench that changes the same files.";
  const base = "Required on this repository: a fully autonomous run accepts this task only after a passing check together, at the current commits, with each open pull request from another workbench that changes the same files.";
  if (view.waitingOn.length === 0 && view.undetermined != null) return `${base} A fully autonomous run waits for you now: ${view.undetermined}`;
  if (view.waitingOn.length === 0) return `${base} Nothing is waiting on it now.`;
  const named = view.waitingOn.map((n) => {
    const offer = view.offers.find((o) => o.number === n);
    return offer === undefined ? `pull request #${n}` : `${offer.workbench}'s pull request #${n}`;
  });
  return `${base} Still needed: ${listed(named)}.`;
}

/** The button for one open pull request. */
export const checkButton = (number: number): string => `Check together with pull request #${number}`;
