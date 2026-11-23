import type { Proposal, WatchStatus } from "../api/client.ts";
import { folderName } from "./composer.ts";

/*
 * The words of the issue watch on Work and in Settings (src/engine/watch.ts), decided without a browser. A proposal's
 * title and author were written outside the project, and what gh said is a program's output: each is returned on its
 * own, for the screen to show as plain text apart from Botbench's words.
 */

/** A time of day on this device, such as 14:30. */
export const clockTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The second line of a proposal: its number, then its author (outside text, apart), then the repository. */
export function proposalLine(p: Pick<Proposal, "number" | "author" | "repository">): { lead: string; author: string | null; rest: string } {
  return p.author === null ? { lead: `#${p.number} by an account GitHub no longer has`, author: null, rest: ` · ${p.repository}` } : { lead: `#${p.number} by `, author: p.author, rest: ` · ${p.repository}` };
}

/** Where Start goes: the composer, as a run, with the From an issue row opened on this proposal's issue. */
export const startAddress = (p: Pick<Proposal, "id">): string => `#/turn?start=run&proposal=${p.id}`;

/** What Work says above the proposals. */
export const PROPOSALS_ABOUT = "Open issues with your watched label. Nothing starts until you choose Start and send the run.";

/** A watched repository's state, in a word or two, for its row in Settings. */
export function watchStateWords(s: Pick<WatchStatus, "state" | "checkedAt">): string {
  if (s.state === "waiting") return "Not checked yet";
  if (s.state === "checking") return "Checking";
  if (s.state === "failed") return "Could not check";
  return s.checkedAt === null ? "Checked" : `Checked at ${clockTime(s.checkedAt)}`;
}

/** What a watched repository's row in Settings says about it, the label's warning included. */
export function watchAbout(s: Pick<WatchStatus, "label" | "intervalMinutes" | "repository">): string {
  const every = s.intervalMinutes === 1 ? "every minute" : `every ${s.intervalMinutes} minutes`;
  return `Botbench looks ${every} for open issues${s.repository === null ? "" : ` of ${s.repository}`} with the label ${s.label}, and shows each new one on Work for you to start or dismiss. It never starts a run by itself. The label is what makes an issue a proposal, so only people who can apply labels to this repository should be able to apply this one.`;
}

/** Why the last look failed and when the next is, around what gh said, for Work and Settings. */
export function watchFailure(s: Pick<WatchStatus, "path" | "problem" | "nextAt">): { lead: string; after: string } {
  return { lead: `Botbench could not check the issues of ${folderName(s.path)}. ${s.problem ?? ""}`.trimEnd(), after: s.nextAt === null ? "" : `It tries again at ${clockTime(s.nextAt)}.` };
}

/** What Settings says when no repository is watched. */
export const NO_WATCH = 'No repository is watched. To have Botbench propose labelled issues on Work, add "watch": { "label": "botbench" } to a repository in your settings file.';
