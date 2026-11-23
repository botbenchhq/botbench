import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import { ghArgs, parseApiHead, parseIssueView, parseWatchedIssues, runGh, WATCH_LIMIT } from "../../src/github.ts";
import { captureArgs, WATCH_CAPTURE_FILE, WATCH_REPO, type WatchCapture } from "../support/replay-watch.ts";

// The one live read of a watched repository (issue #73), against the owner's own repository jon-lange/botbench, read
// only: the owner's gh lists the open issues carrying the label with Botbench's exact arguments, the first of them is
// read as the composer reads an issue, and one `gh api -i` answer shows the head the watch reads after GitHub's limits.
// Nothing is written to GitHub. The label is "botbench" unless BOTBENCH_WATCH_LABEL names another; at least one open
// issue must carry it. With BOTBENCH_CAPTURE_GH=1 it writes what gh printed to test/recordings/gh-watch.json, which the
// replayed tests read, with the exact command it was taken with.

test("live: the owner's gh lists the open issues carrying a label with Botbench's arguments and fields, read only", { timeout: 120_000 }, async (t) => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("gh is not installed here");
  }
  const label = process.env.BOTBENCH_WATCH_LABEL ?? "botbench";
  const listArgs = ghArgs.watchIssues(WATCH_REPO, label);
  const labelled = await runGh(listArgs, { cwd: process.cwd() });
  assert.equal(labelled.code, 0, labelled.stderr);
  const raw = JSON.parse(labelled.stdout) as Record<string, unknown>[];
  assert.ok(raw.length > 0, `no open issue of jon-lange/botbench carries the label ${label}: apply it to one, or name another with BOTBENCH_WATCH_LABEL`);
  assert.ok(raw.length <= WATCH_LIMIT);
  for (const field of ["number", "title", "author", "url", "labels"]) assert.ok(field in raw[0]!, field);
  const issues = parseWatchedIssues(labelled.stdout, WATCH_REPO, label);
  assert.equal(issues.length, raw.length, "every entry gh lists is an open issue of this repository with the label");

  const number = issues[0]!.number;
  const args = captureArgs(label, number);
  const issue = await runGh(args.issue, { cwd: process.cwd() });
  assert.equal(issue.code, 0, issue.stderr);
  assert.equal(parseIssueView(issue.stdout, WATCH_REPO, number).state, "OPEN");
  const issueApi = await runGh(args.issueApi, { cwd: process.cwd() });
  assert.equal(issueApi.code, 0, issueApi.stderr);
  const head = await runGh(args.head, { cwd: process.cwd() });
  assert.equal(head.code, 0, head.stderr);
  const parsed = parseApiHead(head.stdout);
  assert.equal(parsed?.status, 200);
  assert.match(parsed.headers["x-ratelimit-remaining"] ?? "", /^\d+$/);

  if (process.env.BOTBENCH_CAPTURE_GH === "1") {
    const capture: WatchCapture = {
      command: `gh ${listArgs.join(" ")}`,
      gh: execFileSync("gh", ["--version"], { encoding: "utf8" }).split("\n")[0]!,
      captured: new Date().toISOString().slice(0, 10),
      repository: "github.com/jon-lange/botbench",
      label,
      outputs: { labelled: { args: listArgs, result: labelled }, issue: { args: args.issue, result: issue }, issueApi: { args: args.issueApi, result: issueApi }, head: { args: args.head, result: head } },
    };
    const text = JSON.stringify(capture, null, 2);
    assert.doesNotMatch(text, /gh[opsu]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/, "no token in the capture");
    assert.ok(!text.includes(os.homedir()), "no path in the owner's home folder in the capture");
    fs.writeFileSync(WATCH_CAPTURE_FILE, `${text}\n`);
  }
});
