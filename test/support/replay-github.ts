import fs from "node:fs";
import path from "node:path";
import { parseAuthStatus, parsePrCreate, parsePrList, parseRepoView, type GhResult, type GitHub, type PullRequest, type RepoRef } from "../../src/github.ts";

/*
 * Output captured once from the real gh tool by test/live/delivery.live.test.ts (BOTBENCH_CAPTURE_GH=1), against a
 * private scratch repository it created for that and deleted (or archived) after. It holds no token: `gh auth status --json=hosts` prints none.
 *
 * replayGitHub is the owner's approved exception to "no fakes": captured real output replayed through a seam. It is a
 * GitHub (src/github.ts) whose every answer is the real parser applied to what the real `gh` printed. What is real: the
 * text and its parsing. What is not: the answers come back for whatever repository and branch the test names, in the
 * order the test arranges (no pull request until one is opened, then the captured one), and none reaches GitHub. No
 * test may read the replay as what GitHub would answer for its own repository.
 */

export interface GhCapture {
  gh: string;
  captured: string;
  repository: string;
  branch: string;
  outputs: Record<"authStatus" | "authStatusSignedOut" | "repoView" | "prListNone" | "prCreate" | "prListOne", { args: string[]; result: GhResult }>;
}

export const GH_CAPTURE_FILE = path.resolve(import.meta.dirname, "..", "recordings", "gh-delivery.json");

export function loadGhCapture(): GhCapture {
  return JSON.parse(fs.readFileSync(GH_CAPTURE_FILE, "utf8")) as GhCapture;
}

export interface Replay {
  github: GitHub;
  /** Every pull request opened through the replay, with what it was opened with. */
  opened: { repo: RepoRef; base: string; head: string; title: string; body: string }[];
  /** How many times a pull request was looked for. */
  lookups(): number;
  /** The repository and branch of every look for a pull request, in order. */
  looked: { repo: RepoRef; branch: string }[];
}

/**
 * The replay. `existing`: a pull request is already there before any is opened. `signedOut`: the signed-out answer.
 * `hold`: looking for a pull request never answers (a Botbench stopped at that moment). `failOpen`: opening one fails
 * with the given words the first `failOpen.times` times.
 */
export function replayGitHub(o: { existing?: boolean; signedOut?: boolean; hold?: boolean; failOpen?: { times: number; words: string } } = {}): Replay {
  const capture = loadGhCapture();
  const out = capture.outputs;
  const opened: Replay["opened"] = [];
  let lookups = 0;
  const looked: Replay["looked"] = [];
  let failures = 0;
  const existing = (): PullRequest | null => (o.existing === true || opened.length > 0 ? parsePrList(out.prListOne.result.stdout, capture.branch) : parsePrList(out.prListNone.result.stdout, capture.branch));
  return {
    opened,
    lookups: () => lookups,
    looked,
    github: {
      async signedIn(host) {
        const result = o.signedOut === true ? out.authStatusSignedOut.result : out.authStatus.result;
        return parseAuthStatus(result.stdout, host) ?? { problem: `The gh tool is not signed in to ${host}, or its sign-in there does not work. Run gh auth login in a terminal on this Mac, then try again.` };
      },
      defaultBranch: async () => parseRepoView(out.repoView.result.stdout).defaultBranch,
      async findPullRequest(repo, branch) {
        lookups++;
        looked.push({ repo, branch });
        if (o.hold === true) return new Promise<never>(() => {});
        return existing();
      },
      async openPullRequest(repo, args) {
        if (o.failOpen !== undefined && failures < o.failOpen.times) {
          failures++;
          throw new Error(o.failOpen.words);
        }
        opened.push({ repo, base: args.base, head: args.head, title: args.title, body: args.body });
        return parsePrCreate(out.prCreate.result.stdout);
      },
      // Issues are read through test/support/replay-issue.ts, which can be laid over this one.
      issue: async () => {
        throw new Error("The delivery replay does not read issues.");
      },
      // Open pull requests are listed through test/support/replay-peers.ts.
      openPullRequests: async () => {
        throw new Error("The delivery replay does not list open pull requests.");
      },
    },
  };
}
