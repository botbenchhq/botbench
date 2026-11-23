import fs from "node:fs";
import path from "node:path";
import { ghFailure, parseIssueView, repoName, type GhResult, type GitHub, type RepoRef } from "../../src/github.ts";

/*
 * Output captured once from the real gh tool by test/live/issue.live.test.ts (BOTBENCH_CAPTURE_GH=1): public issue
 * cli/cli#15019 read with Botbench's own arguments, plus gh's answers for #1 (a pull request) and for a number with no
 * issue. It holds no token. Like replay-github.ts, this is the owner's approved exception to "no fakes": captured real
 * output replayed through the GitHub seam, every answer the real parser applied to what the real gh printed. Only
 * cli/cli is answered; any other repository is answered as gh answered the number with no issue.
 */

export const ISSUE_REPO: RepoRef = { host: "github.com", owner: "cli", name: "cli" };
export const ISSUE_NUMBER = 15019;
export const ISSUE_ADDRESS = "https://github.com/cli/cli.git";

export interface IssueCapture {
  gh: string;
  captured: string;
  repository: string;
  number: number;
  outputs: Record<"issue" | "pullRequest" | "missing", { args: string[]; result: GhResult }>;
}

export const ISSUE_CAPTURE_FILE = path.resolve(import.meta.dirname, "..", "recordings", "gh-issue.json");

export function loadIssueCapture(): IssueCapture {
  return JSON.parse(fs.readFileSync(ISSUE_CAPTURE_FILE, "utf8")) as IssueCapture;
}

/** The issue reads of the replay, added to `base` (a delivery replay, or nothing). `reads` counts them. */
export function replayIssues(base: Partial<GitHub> = {}): { github: GitHub; reads: { repo: RepoRef; number: number }[] } {
  const out = loadIssueCapture().outputs;
  const reads: { repo: RepoRef; number: number }[] = [];
  const unused = (what: string) => async (): Promise<never> => {
    throw new Error(`The issue replay does not answer ${what}.`);
  };
  return {
    reads,
    github: {
      signedIn: base.signedIn ?? unused("who is signed in"),
      defaultBranch: base.defaultBranch ?? unused("the default branch"),
      findPullRequest: base.findPullRequest ?? unused("pull requests"),
      openPullRequest: base.openPullRequest ?? unused("pull requests"),
      pullRequests: base.pullRequests ?? unused("a repository's pull requests"),
      openPullRequests: base.openPullRequests ?? unused("a repository's open pull requests"),
      async issue(repo, number) {
        reads.push({ repo, number });
        const same = repoName(repo).toLowerCase() === repoName(ISSUE_REPO);
        if (same && number === ISSUE_NUMBER) return parseIssueView(out.issue.result.stdout, repo, number);
        if (same && number === 1) return parseIssueView(out.pullRequest.result.stdout, repo, number);
        throw new Error(ghFailure(out.missing.result));
      },
    },
  };
}
