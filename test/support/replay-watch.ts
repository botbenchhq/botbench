import fs from "node:fs";
import path from "node:path";
import { ghArgs, parseIssueRelation, parseIssueView, parseWatchedIssues, repoName, type GhResult, type GitHub, type RepoRef, type RunGh } from "../../src/github.ts";

/*
 * Output captured once from the real gh tool by test/live/watch.live.test.ts (BOTBENCH_CAPTURE_GH=1), against the
 * owner's repository botbenchhq/botbench, read only: the open issues carrying the watched label, listed with Botbench's
 * exact arguments (`gh issue list --label=... --json=...`, the command is written in the file), the first of them read
 * as the composer reads an issue (`gh issue view` and `gh api`), and the head of one `gh api -i` answer. It holds no
 * token. Like replay-github.ts, this is the owner's approved exception to "no fakes": captured real output replayed
 * through the one seam the watch uses (RunGh), each answer given only to the exact arguments it was captured for.
 */

export const WATCH_REPO: RepoRef = { host: "github.com", owner: "jon-lange", name: "botbench" };
export const WATCH_ADDRESS = "https://github.com/botbenchhq/botbench.git";

export interface WatchCapture {
  /** The exact command the list was taken with, as one line. */
  command: string;
  gh: string;
  captured: string;
  repository: string;
  label: string;
  outputs: Record<"labelled" | "issue" | "issueApi" | "head", { args: string[]; result: GhResult }>;
}

export const WATCH_CAPTURE_FILE = path.resolve(import.meta.dirname, "..", "recordings", "gh-watch.json");
export const CAPTURE_COMMAND = "BOTBENCH_CAPTURE_GH=1 BOTBENCH_LIVE_TESTS=1 node --test test/live/watch.live.test.ts";

/** The capture, or an error saying how to take it: it is taken from the owner's own gh, never made up. */
export function loadWatchCapture(): WatchCapture {
  if (!fs.existsSync(WATCH_CAPTURE_FILE)) {
    throw new Error(`${path.relative(process.cwd(), WATCH_CAPTURE_FILE)} has not been captured yet. With gh signed in and an open issue of botbenchhq/botbench carrying the label, run once: ${CAPTURE_COMMAND}`);
  }
  return JSON.parse(fs.readFileSync(WATCH_CAPTURE_FILE, "utf8")) as WatchCapture;
}

/** The first issue the captured list holds, as the parser keeps it. */
export function capturedIssue(capture = loadWatchCapture()): ReturnType<typeof parseWatchedIssues>[number] {
  const first = parseWatchedIssues(capture.outputs.labelled.result.stdout, WATCH_REPO, capture.label)[0];
  if (first === undefined) throw new Error("The capture lists no open issue with the label.");
  return first;
}

/**
 * The owner's gh, replayed: the captured list for exactly its arguments. `answer` replaces the result for one call by
 * its arguments (a real failure taken elsewhere, for instance). Anything else is answered as gh answers a command it
 * cannot run. `calls` records every call, so a test can see what was asked and that nothing else was.
 */
export function replayWatchGh(o: { answer?: (args: readonly string[]) => GhResult | undefined } = {}): { run: RunGh; calls: string[][] } {
  const capture = loadWatchCapture();
  const calls: string[][] = [];
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      const given = o.answer?.(args);
      if (given !== undefined) return given;
      for (const out of Object.values(capture.outputs)) if (same(out.args, args)) return out.result;
      return { started: true, code: 1, stdout: "", stderr: `unknown command for this replay: gh ${args.join(" ")}` };
    },
  };
}

/** The issue reads of the replay, added to `base`: the captured issue of botbenchhq/botbench, read as the composer reads it. */
export function replayWatchIssue(base: GitHub): GitHub {
  const capture = loadWatchCapture();
  const { number } = capturedIssue(capture);
  return {
    ...base,
    async issue(repo, n) {
      if (repoName(repo).toLowerCase() !== repoName(WATCH_REPO) || n !== number) return base.issue(repo, n);
      const view = parseIssueView(capture.outputs.issue.result.stdout, repo, n);
      return { ...view, authorRelation: parseIssueRelation(capture.outputs.issueApi.result.stdout, repo, n) };
    },
  };
}

/** The exact arguments of the capture's reads, for the live test that takes it. */
export function captureArgs(label: string, number: number): Record<keyof WatchCapture["outputs"], string[]> {
  return { labelled: ghArgs.watchIssues(WATCH_REPO, label), issue: ghArgs.issueView(WATCH_REPO, number), issueApi: ghArgs.issueApi(WATCH_REPO, number), head: ghArgs.watchHead(WATCH_REPO) };
}
