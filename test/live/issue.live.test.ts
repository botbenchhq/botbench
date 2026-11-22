import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { ghArgs, parseIssueView, runGh, type RepoRef } from "../../src/github.ts";
import { ISSUE_CAPTURE_FILE, ISSUE_NUMBER, ISSUE_REPO, type IssueCapture } from "../support/replay-issue.ts";

// The one live read of a GitHub issue: the owner's own gh reads one public issue of a well-known public repository
// (cli/cli), through the exact arguments Botbench uses, and Botbench's parser reads what it printed. Read-only: nothing
// is written to GitHub. With BOTBENCH_CAPTURE_GH=1 it also writes what gh printed (and its answers for a pull request's
// number and for a number with no issue) to test/recordings/gh-issue.json for the unit and browser tests.

test("live: the owner's gh reads one public issue with Botbench's arguments, and Botbench's parser reads its answer", { timeout: 120_000 }, async (t) => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("gh is not installed here");
  }
  const repo: RepoRef = ISSUE_REPO;
  const args = ghArgs.issueView(repo, ISSUE_NUMBER);
  const result = await runGh(args, { cwd: process.cwd() });
  assert.equal(result.code, 0, result.stderr);
  const issue = parseIssueView(result.stdout, repo, ISSUE_NUMBER);
  assert.equal(issue.number, ISSUE_NUMBER);
  assert.equal(issue.url, `https://github.com/cli/cli/issues/${ISSUE_NUMBER}`);
  assert.equal(issue.state, "CLOSED");
  assert.ok(issue.title.length > 0 && issue.body.length > 0);
  assert.ok(issue.author !== null);
  assert.ok(issue.labels.includes("bug"));
  assert.ok(issue.comments.length >= 1 && issue.comments.every((c) => typeof c.body === "string"));

  if (process.env.BOTBENCH_CAPTURE_GH === "1") {
    const pullArgs = ghArgs.issueView(repo, 1);
    const missingArgs = ghArgs.issueView(repo, 999_999_999);
    const capture: IssueCapture = {
      gh: execFileSync("gh", ["--version"], { encoding: "utf8" }).split("\n")[0]!,
      captured: new Date().toISOString().slice(0, 10),
      repository: "github.com/cli/cli",
      number: ISSUE_NUMBER,
      outputs: { issue: { args, result }, pullRequest: { args: pullArgs, result: await runGh(pullArgs, { cwd: process.cwd() }) }, missing: { args: missingArgs, result: await runGh(missingArgs, { cwd: process.cwd() }) } },
    };
    const text = JSON.stringify(capture, null, 2);
    assert.doesNotMatch(text, /gh[opsu]_[A-Za-z0-9]{10,}/, "no token in the capture");
    fs.writeFileSync(ISSUE_CAPTURE_FILE, `${text}\n`);
  }
});
