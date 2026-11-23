import type { DatabaseSync } from "node:sqlite";
import { realRepo } from "../approvals/grants.ts";
import { repositoryDelivery, type Config } from "../config.ts";
import { redact, repoName, type GitHub, type ListedPullRequest } from "../github.ts";
import { ownWorkbenches, parseTaskBranch } from "../workbench.ts";
import { remoteTaskBranches } from "../worktrees.ts";
import { parseClaimBranch } from "./claim-branch.ts";
import { githubOfRepository } from "./intake.ts";
import { words } from "./task.ts";

/*
 * Other workbenches' work on a repository's shared remote (Peers, step P2), read only: the open pull requests whose
 * head branch is another workbench's (`botbench/<other>/…`), through the owner's own gh, that workbench's pushed
 * branches with no pull request yet, and its claims on issues (P3, engine/claims.ts), through `git ls-remote`.
 * Nothing is written to GitHub or to the remote here.
 *
 * Everything read here (titles, branch names, file paths, another workbench's name) was written by somebody else: it
 * is outside text, shown as plain text only. A branch name is kept only when it matches the task branch pattern, which
 * also gives the workbench's name; a number only when it is a number. Nothing of it is passed to git or gh, and
 * nothing of it is put in a prompt to an agent.
 *
 * The view is kept for a short time per repository, and every read has a time limit: it never holds up starting work.
 */

export interface PeerPullRequest {
  workbench: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  /** Issues of the same repository it closes, as GitHub reports them. */
  closes: number[];
  files: string[];
  /**
   * The commit its head branch points at on the remote, as `git ls-remote` read it with the rest of the view; null when
   * the remote did not list the branch. What a check together with it is compared with (engine/combined.ts).
   */
  head: string | null;
}
export interface PeerBranch {
  workbench: string;
  branch: string;
}
/** Another workbench's claim on an issue (engine/claims.ts): read from its branch's name alone. */
export interface PeerClaim {
  workbench: string;
  branch: string;
  issue: number;
  /** The UTC minute the claim was made, as its branch's name says. */
  startedAt: string;
}
export type PeersView =
  | {
      state: "ready";
      repo: string;
      repository: string;
      pullRequests: PeerPullRequest[];
      branches: PeerBranch[];
      claims: PeerClaim[];
      checkedAt: string;
      /** True when even gh's list of open pull requests alone was full, so there may be open ones it did not list. */
      mayBeMore?: boolean;
    }
  | { state: "unavailable"; repo: string; problem: string; checkedAt: string };

/**
 * What of a repository's pull requests and remote task branches is another workbench's: a head branch in the named form
 * under a name this installation never had. Its open pull requests are listed; a pushed branch is listed only when it
 * has no pull request at all in the list: one with an open pull request is listed with it, and one whose pull request
 * was merged or closed is left out, since its work is no longer in flight. A claim branch is listed as a claim.
 * The list holds the latest pull requests only (src/github.ts PR_LIST_LIMIT); when it is full, the view asks about the
 * remaining branches one by one (`withoutPullRequest`).
 */
export function otherWork(prs: readonly ListedPullRequest[], branches: readonly { branch: string; commit?: string }[], own: ReadonlySet<string>): { pullRequests: PeerPullRequest[]; branches: PeerBranch[]; claims: PeerClaim[] } {
  const other = (branch: string): string | null => {
    const parsed = parseTaskBranch(branch);
    return parsed?.prefix === "botbench" && parsed.workbench !== null && !own.has(parsed.workbench) ? parsed.workbench : null;
  };
  const heads = new Map(branches.flatMap(({ branch, commit }) => (commit === undefined ? [] : [[branch, commit] as const])));
  const pullRequests = prs.flatMap((pr) => {
    const workbench = pr.state === "OPEN" ? other(pr.headRefName) : null;
    return workbench === null ? [] : [{ workbench, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, closes: pr.closes, files: pr.files, head: heads.get(pr.headRefName) ?? null }];
  });
  const withPr = new Set(prs.map((pr) => pr.headRefName));
  const claims: PeerClaim[] = [];
  const pushed: PeerBranch[] = [];
  for (const { branch } of branches) {
    const workbench = withPr.has(branch) ? null : other(branch);
    if (workbench === null) continue;
    const claim = parseClaimBranch(branch);
    if (claim !== null) claims.push({ workbench, branch, issue: claim.issue, startedAt: claim.startedAt });
    else pushed.push({ workbench, branch });
  }
  return { pullRequests: pullRequests.sort((a, b) => a.number - b.number), branches: pushed.sort((a, b) => a.branch.localeCompare(b.branch)), claims: claims.sort((a, b) => a.branch.localeCompare(b.branch)) };
}

/** The most pushed branches asked about one by one when the repository's list of pull requests came back full. */
export const MAX_BRANCH_LOOKUPS = 20;

/**
 * The pushed branches that truly have no pull request, when the list of the latest ones was full and so may have left
 * theirs out: each is asked about on its own (`gh pr list --head=<branch> --state=all`, src/github.ts). One with a pull
 * request in any state, one that could not be asked about, and any past the first `MAX_BRANCH_LOOKUPS` are left out:
 * the view never says "no pull request yet" without knowing it.
 */
export async function withoutPullRequest(branches: readonly PeerBranch[], find: (branch: string) => Promise<unknown>): Promise<PeerBranch[]> {
  const asked = await Promise.all(branches.slice(0, MAX_BRANCH_LOOKUPS).map((b) => find(b.branch).then((pr) => (pr === null ? b : null), () => null)));
  return asked.filter((b): b is PeerBranch => b !== null);
}

export interface Peers {
  /**
   * Other workbenches' work on the repository's remote: from the short-lived cache, or read now. `fresh` reads it now
   * whatever is kept, for a decision that stands on it (engine/combined.ts). Never rejects.
   */
  view(repo: string, o?: { fresh?: boolean }): Promise<PeersView>;
}

/** How long a view is kept before it is read again. */
export const PEERS_FRESH_MS = 60_000;

export function createPeers(o: { db: DatabaseSync; config: Config; github: GitHub; freshMs?: number; now?: () => number }): Peers {
  const fresh = o.freshMs ?? PEERS_FRESH_MS;
  const clock = o.now ?? Date.now;
  const kept = new Map<string, { at: number; view: Promise<PeersView> }>();

  const read = async (repo: string): Promise<PeersView> => {
    const checkedAt = new Date(clock()).toISOString();
    const unavailable = (problem: string): PeersView => ({ state: "unavailable", repo, problem: redact(problem), checkedAt });
    try {
      const found = await githubOfRepository(o.config, repo);
      if ("problem" in found) return unavailable(found.problem);
      const { remote } = repositoryDelivery(o.config, repo);
      const [page, branches] = await Promise.all([
        o.github.pullRequests(found.repo).catch((err: unknown) => {
          throw new Error(`The pull requests of ${repoName(found.repo)} could not be read: ${words(err)}`);
        }),
        remoteTaskBranches(repo, remote).catch((err: unknown) => {
          throw new Error(`The branches on the remote ${remote} could not be read: ${words(err)}`);
        }),
      ]);
      // The page holds the latest pull requests of every state. When it is full, an older open one may be missing from
      // it, so the open ones are read on their own too; only when that list is full as well may an open one be unlisted.
      let listed = page.pullRequests;
      let mayBeMore = false;
      if (page.full) {
        const open = await o.github.openPullRequests(found.repo).catch((err: unknown) => {
          throw new Error(`The open pull requests of ${repoName(found.repo)} could not be read: ${words(err)}`);
        });
        const numbers = new Set(open.pullRequests.map((pr) => pr.number));
        listed = [...open.pullRequests, ...page.pullRequests.filter((pr) => !numbers.has(pr.number) && pr.state !== "OPEN")];
        mayBeMore = open.full;
      }
      const work = otherWork(listed, branches, ownWorkbenches(o.db));
      // A full list may have left out an older pull request of a pushed branch: those branches are asked about one by one.
      // Full is what gh gave, not what was kept: a fork's pull request on the page still fills it.
      if (page.full) work.branches = await withoutPullRequest(work.branches, (branch) => o.github.findPullRequest(found.repo, branch));
      return { state: "ready", repo, repository: repoName(found.repo), ...work, checkedAt, mayBeMore };
    } catch (err) {
      return unavailable(words(err));
    }
  };

  return {
    view(repoPath, given = {}) {
      const repo = realRepo(repoPath);
      const at = clock();
      const have = kept.get(repo);
      if (given.fresh !== true && have !== undefined && at - have.at < fresh) return have.view;
      const view = read(repo);
      kept.set(repo, { at, view });
      return view;
    },
  };
}
