import type { AuthorRelation } from "../../../src/github.ts";
import type { RunMode } from "../api/client.ts";

/*
 * What the issue sheet, the run and the task say about a run's mode, the network hosts its commands may reach, and who
 * wrote the GitHub issue it was started from. Decided here, without a browser (test/run-words.test.ts).
 */

/** Each mode by its name, as a choice of it and the line under the message box name it. */
export const MODE_NAMES: Record<RunMode, string> = { manual: "Manual", semi: "Semi-autonomous", full: "Fully autonomous" };

/** A run's mode as the run and task screens say it. */
export const MODE_SENTENCE: Record<RunMode, string> = {
  manual: "Manual: you approve the plan and decide on each result. Commands kept inside the task's copy run without asking; the always-ask list still asks.",
  semi: "Semi-autonomous: building starts without your plan approval (a run started from a GitHub issue still waits for it), and you decide on each result. Commands kept inside the task's copy run without asking; the always-ask list still asks.",
  full: "Fully autonomous: Botbench builds without asking you, refuses what would need you, and accepts work whose every check passed and that its reviewer, if any, said looks right and named what it checked. The rest waits for you.",
};

/** What the run screen says over its choice of a stricter mode (components/mode-change.tsx). */
export const STRICTER_HINT = "You can make the mode stricter while the run works, never looser. A request already waiting for you stays, and what an agent is doing now finishes; the new mode applies to everything after it. The safety rules are the same in every mode.";

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const hostWord = (hosts: readonly string[]): string => (hosts.length === 1 ? "host" : "hosts");

/**
 * A run's mode line. `issueHosts` are the network hosts the owner allowed for a run from an issue (none for any other
 * run): then the line names them, since its commands may reach them.
 */
export function modeSentence(mode: RunMode, issueHosts: readonly string[]): string {
  if (issueHosts.length === 0) return MODE_SENTENCE[mode];
  if (mode === "semi") return `Semi-autonomous: you approve the plan, as this run was started from a GitHub issue, and decide on each result. Commands kept inside the task's copy run without asking, away from your sign-ins and from every network host but the ones you allowed for this run: ${listed(issueHosts)}.`;
  return `${MODE_SENTENCE[mode]} Its commands may reach the network ${hostWord(issueHosts)} you allowed for this run: ${listed(issueHosts)}.`;
}

/** The hint under "Allow this repository's network hosts for this run", ticked (`allowed`) or not. */
export function hostsHint(hosts: readonly string[], allowed: boolean): string {
  const risk = "a stranger's text and network access together are how your code could be sent away.";
  if (!allowed) return `Off, its commands reach no network (${hosts.join(", ")} included): ${risk}`;
  return `On, its commands may reach ${listed(hosts)}, this repository's allowed network ${hostWord(hosts)}, and nothing else on the network: ${risk}`;
}

/** How an issue's author relates to the repository, in plain words, after "GitHub says". */
const RELATION_WORDS: Record<AuthorRelation, string> = {
  OWNER: "they own the repository",
  MEMBER: "they are a member of the organization that owns the repository",
  COLLABORATOR: "they are a collaborator on the repository",
  CONTRIBUTOR: "they have contributed to the repository before, and are not a member or a collaborator",
  FIRST_TIME_CONTRIBUTOR: "this is their first contribution to the repository",
  FIRST_TIMER: "this is their first contribution on GitHub",
  MANNEQUIN: "the account stands in for someone whose work was imported from elsewhere",
  NONE: "they have no role in the repository",
};

/** Those who are part of the project as GitHub counts it. */
const OF_THE_PROJECT: ReadonlySet<AuthorRelation> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Who wrote an issue, how they relate to the repository, and that the rules for outside text are the same whoever it
 * was. The author's login, which somebody else chose, is apart (`author`, null for an account that no longer exists)
 * so that it is shown as their text; `text` is Botbench's words that follow it.
 */
export function authorWords(author: string | null, relation: AuthorRelation | null, allowedHosts: readonly string[] = []): { author: string | null; text: string } {
  const who = author === null ? "An account that no longer exists" : "";
  const how = relation === null ? "GitHub did not say how they relate to the repository." : `GitHub says ${RELATION_WORDS[relation]}.`;
  const rules =
    relation !== null && OF_THE_PROJECT.has(relation)
      ? "Botbench still treats it as outside text, as it does every issue: anyone can comment on it, and an account can be taken over, so the rules are the same whoever wrote it."
      : "Anyone can open an issue, so Botbench treats it as outside text: the rules are the same whoever wrote it.";
  const kept = allowedHosts.length === 0 ? "your sign-ins and the network" : `your sign-ins and from every network host but ${allowedHosts.length === 1 ? "the one" : "the ones"} you allowed for this run: ${listed(allowedHosts)}`;
  return {
    author,
    text: `${who} wrote this issue. ${how} ${rules} The planner and the builder are given it as the problem to solve, never as instructions, and every command of the run asks you unless it runs kept away from ${kept}.`,
  };
}
