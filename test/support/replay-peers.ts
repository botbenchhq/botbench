import fs from "node:fs";
import path from "node:path";
import { parsePullRequestPage, repoName, type GhResult, type GitHub, type RepoRef } from "../../src/github.ts";

/*
 * Output captured once from the real gh tool by test/live/peers.live.test.ts (BOTBENCH_CAPTURE_GH=1): the pull
 * requests of the owner's repository botbenchhq/botbench, listed with Botbench's own arguments, open only and in every
 * state. It holds no token. Like replay-github.ts, this is the owner's approved exception to "no fakes": captured real
 * output replayed through the GitHub seam, every answer the real parser applied to what the real gh printed. Only
 * botbenchhq/botbench is answered; for any other repository the answer is an empty list, as gh gives for one with none.
 * Since P3 the view lists pull requests in every state, so the replay answers with the capture's list in every state.
 */

export const PEERS_REPO: RepoRef = { host: "github.com", owner: "jon-lange", name: "botbench" };
export const PEERS_ADDRESS = "https://github.com/botbenchhq/botbench.git";

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

/*
 * A second capture, added for checking together (Peers P4), never re-recorded: the open pull requests of the same
 * repository, listed by the real gh with Botbench's own arguments while pull requests from named workbenches' task
 * branches were open (test/live/peers.live.test.ts, BOTBENCH_CAPTURE_GH_OPEN=1). The first capture has no open one.
 */
export interface PeersOpenCapture {
  about: string;
  gh: string;
  captured: string;
  repository: string;
  outputs: Record<"open", { args: string[]; result: GhResult }>;
}

export const PEERS_OPEN_CAPTURE_FILE = path.resolve(import.meta.dirname, "..", "recordings", "gh-peers-open.json");

export function loadPeersOpenCapture(): PeersOpenCapture {
  return JSON.parse(fs.readFileSync(PEERS_OPEN_CAPTURE_FILE, "utf8")) as PeersOpenCapture;
}

/**
 * The pull request list of the replay, added to `base`: what gh printed for the list in every state, read by the real
 * parser. `stdout` replaces what gh printed, for a test of the parser's own rules on an answer of the same shape.
 * `lists` counts the times it was asked.
 */
export function replayPeers(base: GitHub, o: { stdout?: string; openStdout?: string } = {}): { github: GitHub; lists: RepoRef[] } {
  const stdout = o.stdout ?? loadPeersCapture().outputs.all.result.stdout;
  const open = o.openStdout ?? loadPeersCapture().outputs.open.result.stdout;
  const lists: RepoRef[] = [];
  return {
    lists,
    github: {
      ...base,
      async pullRequests(repo) {
        lists.push(repo);
        if (repoName(repo).toLowerCase() !== repoName(PEERS_REPO)) return { pullRequests: [], full: false };
        return parsePullRequestPage(stdout, repo);
      },
      // The open list alone, asked for when the page of every state is full: what gh printed for it in the same capture.
      async openPullRequests(repo) {
        lists.push(repo);
        if (repoName(repo).toLowerCase() !== repoName(PEERS_REPO)) return { pullRequests: [], full: false };
        return parsePullRequestPage(open, repo);
      },
    },
  };
}

/**
 * The replay of the open pull requests captured in gh-peers-open.json, as the view reads them: the page of every state
 * is that same open list, so every open pull request in it is read by the real parser from what the real gh printed.
 */
export function replayOpenPeers(base: GitHub): { github: GitHub; lists: RepoRef[] } {
  const stdout = loadPeersOpenCapture().outputs.open.result.stdout;
  return replayPeers(base, { stdout, openStdout: stdout });
}
