import { MAX_ISSUE_NUMBER } from "../github.ts";
import { parseTaskBranch } from "../workbench.ts";

/*
 * The names of issue claims (Peers P3, engine/claims.ts), and the rules that need only a name: which claim on an issue
 * is the earliest, and which claim of another workbench the owner may take over. Pure: nothing here reads git, gh or
 * the store, so the run engine can check a take-over before a run is stored.
 *
 * A claim branch says in its name who claimed which issue, for which run and when, in the task branch form
 * `parseTaskBranch` accepts: `botbench/<workbench>/run-<N>/issue-<number>-at-<YYYYMMDD>T<HHMMSSmmm>Z`. Another
 * workbench reads all of it from `git ls-remote` alone. The time is the claiming workbench's own clock, to the
 * millisecond, so two claims made in the same minute still have an order.
 *
 * Which claim is the earliest is not decided from those names: it is decided by the remote. With its named branch, a
 * claim creates the issue's one lock branch `botbench/claims/issue-<number>` at the same commit, in one atomic push
 * that never forces (engine/claims.ts). A ref that already exists refuses such a push, so of two workbenches that push
 * at once exactly one gets the lock. Who holds it is read from which named claim branch points at the lock's commit.
 */

/** The issue's lock branch, `botbench/claims/issue-<number>`: whichever claim created it first holds the issue. */
export const lockBranch = (issue: number): string => `botbench/claims/issue-${issue}`;

/**
 * The message of a claim's commit. It names the claim branch, whose name holds the time to the millisecond, so no two
 * claims share a commit; and release deletes a branch only at a commit whose message names it (engine/claims.ts).
 */
export const claimMessage = (workbench: string, runId: number, issue: number, branch: string): string =>
  `Botbench: ${workbench} started on issue #${issue}\n\nClaim ${branch}. This branch tells other workbenches that ${workbench} started on issue #${issue} (Botbench run ${runId}). It holds no files, and Botbench deletes it if the run ends without a pull request.`;

/** The issue number of a lock branch's name; null for any other branch. */
export function parseLockBranch(branch: string): number | null {
  const m = /^botbench\/claims\/issue-([1-9]\d{0,9})$/.exec(branch);
  return m === null || Number(m[1]) > MAX_ISSUE_NUMBER ? null : Number(m[1]);
}

/** A claim branch's last part: the issue number and the UTC time the claim was made, such as `issue-82-at-20261122T210530123Z`. */
const CLAIM_PART = /^issue-([1-9]\d{0,9})-at-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/** A claim, as its branch's name gives it. */
export interface ClaimName {
  branch: string;
  workbench: string;
  run: number;
  issue: number;
  /** When the claim was made, as an ISO time in UTC. */
  startedAt: string;
}

/** A claim branch's name: `botbench/<workbench>/run-<run>/issue-<issue>-at-<YYYYMMDD>T<HHMMSSmmm>Z`. */
export function claimBranchName(workbench: string, runId: number, issue: number, at: Date): string {
  const stamp = at.toISOString().replace(/[-:.]/g, "");
  return `botbench/${workbench}/run-${runId}/issue-${issue}-at-${stamp}`;
}

/** The parts of a claim branch's name, or null for any other branch. The time must be a real UTC time, or the name is not a claim's. */
export function parseClaimBranch(branch: string): ClaimName | null {
  const parsed = parseTaskBranch(branch);
  if (parsed === null || parsed.prefix !== "botbench" || parsed.workbench === null) return null;
  const run = /^run-([1-9]\d{0,9})$/.exec(parsed.run);
  const m = CLAIM_PART.exec(parsed.task);
  if (run === null || m === null) return null;
  const issue = Number(m[1]);
  if (issue > MAX_ISSUE_NUMBER) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(2).map(Number) as [number, number, number, number, number, number, number];
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d || at.getUTCHours() !== h || at.getUTCMinutes() !== mi || at.getUTCSeconds() !== s) return null;
  return { branch, workbench: parsed.workbench, run: Number(run[1]), issue, startedAt: at.toISOString() };
}

/**
 * The issue numbers a message names, best effort: "#59", "Issue #59", "(#60)"; not a page anchor, an entity, a word with
 * a number in it, a colour or a number no issue can have. Once each, in order. The composer spots numbers by the same
 * rule (web/src/app/peers.ts `spottedIssues`; test/engine/claims.test.ts checks the two agree).
 */
export function spottedIssues(message: string): number[] {
  const found: number[] = [];
  for (const match of message.matchAll(/(?<![\w&/#.])#([1-9]\d{0,9})(?![\w])/g)) {
    const n = Number(match[1]);
    if (n <= MAX_ISSUE_NUMBER && !found.includes(n)) found.push(n);
  }
  return found;
}

/** The one issue number a message names; null when it names none, or more than one. */
export function messageIssue(message: string | null): number | null {
  const named = spottedIssues(message ?? "");
  return named.length === 1 ? named[0]! : null;
}

/** How old another workbench's claim must be before its owner may take it over: an hour (the composer offers it from then on). */
export const OLD_CLAIM_MS = 60 * 60_000;
/** The most claims one run may take over. */
const MAX_TAKE_OVER = 10;

/**
 * The claims a new run takes over, from what the client sent (`takeOver`, a list of branch names): each one another
 * workbench's claim on this run's issue, at least `OLD_CLAIM_MS` old by its name. Throws, with what to do, for anything
 * else; nothing is stored then. Taking a claim over never touches its branch: the run only goes ahead as if it were not
 * there (engine/claims.ts).
 */
export function takeOverGiven(given: unknown, o: { issue: number | null; own: ReadonlySet<string>; now: number }): ClaimName[] {
  if (given === undefined || given === null) return [];
  if (!Array.isArray(given) || given.length > MAX_TAKE_OVER || !given.every((b) => typeof b === "string")) throw new Error(`"takeOver" must be a list of at most ${MAX_TAKE_OVER} branch names of other workbenches' claims.`);
  if (given.length > 0 && o.issue === null) throw new Error("Only a run started from one issue can take over another workbench's claim on it.");
  const taken: ClaimName[] = [];
  for (const branch of given as string[]) {
    const claim = parseClaimBranch(branch);
    if (claim === null) throw new Error(`${branch.slice(0, 200)} is not a workbench's claim on an issue.`);
    if (o.own.has(claim.workbench)) throw new Error(`${branch} is this workbench's own claim, so there is nothing to take over.`);
    if (claim.issue !== o.issue) throw new Error(`${claim.workbench}'s claim is on issue #${claim.issue}, not on this run's issue #${o.issue}.`);
    if (o.now - Date.parse(claim.startedAt) < OLD_CLAIM_MS) throw new Error(`${claim.workbench} started on issue #${claim.issue} less than an hour ago. Only a claim at least an hour old can be taken over.`);
    if (!taken.some((c) => c.branch === branch)) taken.push(claim);
  }
  return taken;
}

/** "21:05:30 UTC on 2026-11-22": a claim's time, in the words the server shows. */
export const claimTimeWords = (iso: string): string => `${iso.slice(11, 19)} UTC on ${iso.slice(0, 10)}`;
