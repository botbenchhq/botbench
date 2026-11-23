import type { PeersView } from "../api/client.ts";

/*
 * What the composer and the task screen say about other workbenches' work on the same repository (Peers P2). Each
 * line is a warning only: nothing here ever stops a send or a decision. Everything taken from the view (a workbench's
 * name, a title, a path) is outside text, shown by the caller as plain text.
 */

const MAX_NUMBER = 2_147_483_647;

/**
 * The issue numbers a message names, best effort: "#59", "Issue #59", "(#60)". Not a page anchor ("page.html#59"), an
 * entity ("&#59;"), a word with a number in it ("x#59"), a colour ("#fff") or a number no issue can have. Once each, in
 * order. The server spots the issue a run claims by the same rule (src/engine/claim-branch.ts; test/engine/claims.test.ts
 * checks the two agree).
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

/** How old another workbench's claim must be before it may be taken over; the server checks the same (src/engine/claim-branch.ts OLD_CLAIM_MS). */
export const OLD_CLAIM_MS = 60 * 60_000;

/**
 * Other workbenches' claims the owner may take over when starting this run: on the issue the run would claim (the one
 * attached, else the one number the message names), and at least an hour old. Taking one over, after a confirm that
 * names its holder, lets the run go ahead as if the claim were not there; the holder's branch is left as it is.
 */
export function oldClaims(view: PeersView | null, o: { attached: number | null; message: string; now?: number }): Extract<PeersView, { state: "ready" }>["claims"] {
  if (view === null || view.state !== "ready") return [];
  const named = spottedIssues(o.message);
  const issue = o.attached ?? (named.length === 1 ? named[0]! : null);
  const now = o.now ?? Date.now();
  // A claim already taken over, or whose run has its pull request open, is not offered: taking it over would only make a second one.
  return issue === null ? [] : view.claims.filter((c) => c.issue === issue && c.takenOverBy === null && c.pullRequest === null && now - Date.parse(c.startedAt) >= OLD_CLAIM_MS);
}

/**
 * What the composer says, before Send, about a claim the run would push (src/engine/claims.ts): only for a repository
 * whose setting `claimIssues` is on, a run that opens pull requests, and one issue (the one attached, else the one
 * number the message names). Empty otherwise: then nothing about the issue leaves this Mac when the run starts.
 */
export function claimNotice(o: { claimIssues: boolean; delivery: "branch" | "pull_request"; attached: number | null; message: string }): string {
  if (!o.claimIssues || o.delivery !== "pull_request") return "";
  const named = spottedIssues(o.message);
  const issue = o.attached ?? (named.length === 1 ? named[0]! : null);
  return issue === null ? "" : ` When the run starts, Botbench pushes two empty branches to the remote so that other workbenches see you started on issue #${issue}; they are deleted if the run ends without a pull request.`;
}

/** How long ago `startedAt` was, from `now`: "less than a minute ago", "1 minute ago", "12 minutes ago", "3 hours ago", "2 days ago". */
export function agoWords(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 120) return unit(minutes, "minute");
  if (minutes < 48 * 60) return unit(Math.floor(minutes / 60), "hour");
  return unit(Math.floor(minutes / (24 * 60)), "day");
}

/** How long a claim may say nothing of its work before the screens say its workbench may have stopped: a workbench at work on it says so every 10 minutes (src/engine/claim-branch.ts WORKED_EVERY_MS). */
export const QUIET_CLAIM_MS = 25 * 60_000;

/**
 * What a claim says of its issue, after the workbench's name and before the issue: the run's open pull request, a
 * take-over, or when it started and how long its workbench has said nothing of its work.
 */
export function claimWords(c: Extract<PeersView, { state: "ready" }>["claims"][number], now: number): { lead: string; tail: string } {
  if (c.pullRequest !== null) return { lead: `has pull request #${c.pullRequest} open for`, tail: "" };
  const started = "started on";
  const ago = agoWords(c.startedAt, now);
  if (c.takenOverBy !== null) return { lead: started, tail: ` ${ago}; ${c.takenOverBy} took it over` };
  const quiet = now - Date.parse(c.workedAt);
  if (quiet >= QUIET_CLAIM_MS) return { lead: started, tail: ` ${ago} and has shown no work on it since ${agoWords(c.workedAt, now)}: it may have stopped, or be waiting for its owner` };
  // A claim that has said nothing since it was made says only when it started.
  if (Date.parse(c.workedAt) - Date.parse(c.startedAt) < 60_000) return { lead: started, tail: ` ${ago}` };
  return { lead: started, tail: ` ${ago}; it last worked on it ${agoWords(c.workedAt, now)}` };
}

/**
 * The composer's warnings: another workbench's open pull request for the attached issue or for an issue the message
 * names, and another workbench's claim on it (it started a run on that issue, Peers P3).
 */
export function issueWarnings(view: PeersView | null, o: { attached: number | null; message: string; now?: number }): string[] {
  if (view === null || view.state !== "ready") return [];
  const now = o.now ?? Date.now();
  const { claims } = view;
  const lines: string[] = [];
  // A claim whose pull request is already said by its own line is not said twice.
  const shown = (c: (typeof claims)[number]): boolean => c.pullRequest !== null && view.pullRequests.some((p) => p.number === c.pullRequest && p.closes.includes(c.issue));
  const claimLine = (c: (typeof claims)[number]): string => {
    const w = claimWords(c, now);
    return `${c.workbench} ${w.lead} this issue${w.tail}`;
  };
  if (o.attached !== null) {
    for (const pr of view.pullRequests.filter((p) => p.closes.includes(o.attached!))) lines.push(`${pr.workbench} already has pull request #${pr.number} open for this issue.`);
    for (const c of claims.filter((c) => c.issue === o.attached && !shown(c))) lines.push(`${claimLine(c)}.`);
  }
  for (const n of spottedIssues(o.message).filter((n) => n !== o.attached)) {
    for (const pr of view.pullRequests.filter((p) => p.closes.includes(n))) lines.push(`A best-effort match on #${n} in your message: ${pr.workbench} already has pull request #${pr.number} open for issue #${n}.`);
    for (const c of claims.filter((c) => c.issue === n && !shown(c))) lines.push(`A best-effort match on #${n} in your message: ${claimLine(c)}.`);
  }
  return lines.slice(0, MAX_WARNINGS);
}

/** One row of Work's "Other workbenches": what it is, and the workbench, what it is doing and the shared repository under it. */
export interface PeerRow {
  key: string;
  kind: "pull-request" | "branch" | "claim";
  /** For a pull request, its address (opens GitHub in a new tab); null for a branch. */
  url: string | null;
  /** "Pull request #12: " before the title, or the branch's name alone. Outside text is in `title` and `branch`. */
  lead: string;
  title: string | null;
  branch: string | null;
  workbench: string;
  /** What follows the workbench's name on the second line, starting with " · ", up to the repository. */
  rest: string;
  /** The repository as its remote names it (host/owner/name): outside text, so it is drawn apart from Botbench's words. */
  repository: string;
  /** What follows the repository, if anything. */
  after: string;
}

/**
 * The rows of one repository's "Other workbenches". Each names the other workbench and the repository both share as
 * its remote names it (`view.repository`, host/owner/name), never this Mac's folder name for it: the folder is the
 * viewer's own, and another workbench may keep the same repository in a folder of any name.
 */
export function peerRows(view: Extract<PeersView, { state: "ready" }>, now: number = Date.now()): PeerRow[] {
  const repository = view.repository;
  return [
    ...view.pullRequests.map((pr): PeerRow => ({ key: `pr ${pr.number}`, kind: "pull-request", url: pr.url, lead: `Pull request #${pr.number}: `, title: pr.title, branch: null, workbench: pr.workbench, rest: `${pr.closes.length === 0 ? "" : ` · Closes ${pr.closes.map((n) => `#${n}`).join(", ")}`} · `, repository, after: " (opens GitHub in a new tab)" })),
    ...view.claims.map((c): PeerRow => ({ key: `claim ${c.branch}`, kind: "claim", url: null, lead: "", title: null, branch: c.branch, workbench: c.workbench, rest: ` · ${claimRest(c, now)} · `, repository, after: "" })),
    ...view.branches.map((b): PeerRow => ({ key: `branch ${b.branch}`, kind: "branch", url: null, lead: "", title: null, branch: b.branch, workbench: b.workbench, rest: " · Pushed, no pull request yet · ", repository, after: "" })),
  ];
}

/** A claim's row on Work, after the workbench: "Pull request #31 open for issue #4", or its start, take-over or quiet. */
function claimRest(c: Extract<PeersView, { state: "ready" }>["claims"][number], now: number): string {
  if (c.pullRequest !== null) return `Pull request #${c.pullRequest} open for issue #${c.issue}`;
  const w = claimWords(c, now);
  return `Started on issue #${c.issue}${w.tail}`;
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
