import fs from "node:fs";
import path from "node:path";
import { parsePullRequestList, repoName, type GhResult, type GitHub, type RepoRef } from "../../src/github.ts";

/*
 * Output captured once from the real gh tool by test/live/peers.live.test.ts (BOTBENCH_CAPTURE_GH=1): the open pull
 * requests of the owner's repository jon-lange/botbench, listed with Botbench's own arguments, and the same list with
 * every state. It holds no token. Like replay-github.ts, this is the owner's approved exception to "no fakes": captured
 * real output replayed through the GitHub seam, every answer the real parser applied to what the real gh printed. Only
 * jon-lange/botbench is answered; for any other repository the answer is an empty list, as gh gives for one with none.
 */

export const PEERS_REPO: RepoRef = { host: "github.com", owner: "jon-lange", name: "botbench" };
export const PEERS_ADDRESS = "https://github.com/jon-lange/botbench.git";

export interface PeersCapture {
  gh: string;
  captured: string;
  repository: string;
  outputs: Record<"open" | "all", { args: string[]; result: GhResult }>;
}

export const PEERS_CAPTURE_FILE = path.resolve(import.meta.dirname, "..", "recordings", "gh-peers.json");

export function loadPeersCapture(): PeersCapture {
  return JSON.parse(fs.readFileSync(PEERS_CAPTURE_FILE, "utf8")) as PeersCapture;
}

/** The open-pull-request list of the replay, added to `base`. `lists` counts the times it was asked. */
export function replayPeers(base: GitHub): { github: GitHub; lists: RepoRef[] } {
  const out = loadPeersCapture().outputs;
  const lists: RepoRef[] = [];
  return {
    lists,
    github: {
      ...base,
      async openPullRequests(repo) {
        lists.push(repo);
        if (repoName(repo).toLowerCase() !== repoName(PEERS_REPO)) return [];
        return parsePullRequestList(out.open.result.stdout, repo).filter((pr) => pr.state === "OPEN");
      },
    },
  };
}
