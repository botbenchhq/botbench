import type { DatabaseSync } from "node:sqlite";
import { realRepo } from "../approvals/grants.ts";
import { repositoryDelivery, type Config } from "../config.ts";
import { PR_LIST_LIMIT, redact, repoName, type GitHub, type ListedPullRequest } from "../github.ts";
import { ownWorkbenches, parseTaskBranch } from "../workbench.ts";
import { remoteTaskBranches } from "../worktrees.ts";
import { githubOfRepository } from "./intake.ts";
import { words } from "./task.ts";

/*
 * Other workbenches' work on a repository's shared remote (Peers, step P2), read only: the open pull requests whose
 * head branch is another workbench's (`botbench/<other>/…`), through the owner's own gh, and that workbench's pushed
 * branches with no pull request yet, through `git ls-remote`. Nothing is written to GitHub or to the remote.
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
  /** Present when `files` may not be every file it changes (github.ts, `filesCapped`). */
  filesCapped?: true;
}
export interface PeerBranch {
  workbench: string;
  branch: string;
}
export type PeersView =
  | {
      state: "ready";
      repo: string;
      repository: string;
      pullRequests: PeerPullRequest[];
      branches: PeerBranch[];
      checkedAt: string;
      /** True when gh gave as many open pull requests as Botbench asks for at once, so there may be more it did not list. */
      mayBeMore?: boolean;
    }
  | { state: "unavailable"; repo: string; problem: string; checkedAt: string };

/**
 * What of a repository's open pull requests and remote task branches is another workbench's: a head branch in the
 * named form under a name this installation never had. A branch with an open pull request is listed with it, not again.
 */
export function otherWork(prs: readonly ListedPullRequest[], branches: readonly { branch: string; commit?: string }[], own: ReadonlySet<string>): { pullRequests: PeerPullRequest[]; branches: PeerBranch[] } {
  const other = (branch: string): string | null => {
    const parsed = parseTaskBranch(branch);
    return parsed?.prefix === "botbench" && parsed.workbench !== null && !own.has(parsed.workbench) ? parsed.workbench : null;
  };
  const heads = new Map(branches.flatMap(({ branch, commit }) => (commit === undefined ? [] : [[branch, commit] as const])));
  const pullRequests = prs.flatMap((pr) => {
    const workbench = pr.state === "OPEN" ? other(pr.headRefName) : null;
    return workbench === null ? [] : [{ workbench, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, closes: pr.closes, files: pr.files, head: heads.get(pr.headRefName) ?? null, ...(pr.filesCapped === true ? { filesCapped: true as const } : {}) }];
  });
  const withPr = new Set(pullRequests.map((pr) => pr.branch));
  const pushed = branches.flatMap(({ branch }) => {
    const workbench = withPr.has(branch) ? null : other(branch);
    return workbench === null ? [] : [{ workbench, branch }];
  });
  return { pullRequests: pullRequests.sort((a, b) => a.number - b.number), branches: pushed.sort((a, b) => a.branch.localeCompare(b.branch)) };
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
      const [prs, branches] = await Promise.all([
        o.github.openPullRequests(found.repo).catch((err: unknown) => {
          throw new Error(`The open pull requests of ${repoName(found.repo)} could not be read: ${words(err)}`);
        }),
        remoteTaskBranches(repo, remote).catch((err: unknown) => {
          throw new Error(`The branches on the remote ${remote} could not be read: ${words(err)}`);
        }),
      ]);
      return { state: "ready", repo, repository: repoName(found.repo), ...otherWork(prs, branches, ownWorkbenches(o.db)), checkedAt, mayBeMore: prs.capped === true || prs.length >= PR_LIST_LIMIT };
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
