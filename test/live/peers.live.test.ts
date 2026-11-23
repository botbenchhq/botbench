import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ghArgs, parsePullRequestList, runGh, type RepoRef } from "../../src/github.ts";
import { remoteTaskBranches } from "../../src/worktrees.ts";
import { initRepo, git, tempDir } from "../support/repo.ts";
import { PEERS_CAPTURE_FILE, PEERS_REPO, type PeersCapture } from "../support/replay-peers.ts";

// The one live read of what other workbenches have in flight (Peers P2), against the owner's own repository
// jon-lange/botbench, read only: the owner's gh lists the open pull requests with Botbench's exact arguments, and the
// real git lists the remote's task branches with `git ls-remote`. Nothing is written to GitHub. With
// BOTBENCH_CAPTURE_GH=1 it also writes what gh printed to test/recordings/gh-peers.json for the replayed tests: the
// open list Botbench asks for, and the same list with every state, so the parser is tested on real closing references
// and files too.

test("live: the owner's gh lists a repository's open pull requests with Botbench's arguments and fields, and git lists its task branches", { timeout: 120_000 }, async (t) => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("gh is not installed here");
  }
  const repo: RepoRef = PEERS_REPO;
  const args = ghArgs.prListOpen(repo);
  const result = await runGh(args, { cwd: process.cwd() });
  assert.equal(result.code, 0, result.stderr);
  const open = parsePullRequestList(result.stdout, repo);
  assert.ok(open.every((pr) => pr.state === "OPEN"), "the open list holds only open pull requests");

  // Every field Botbench asks for is in GitHub's answer, read from a list that has merged ones with closing references.
  const allArgs = ghArgs.prListOpen(repo, "all");
  const all = await runGh(allArgs, { cwd: process.cwd() });
  assert.equal(all.code, 0, all.stderr);
  const raw = JSON.parse(all.stdout) as Record<string, unknown>[];
  assert.ok(raw.length > 0);
  for (const field of ["number", "title", "url", "state", "headRefName", "isCrossRepository", "closingIssuesReferences", "files"]) assert.ok(field in raw[0]!, field);
  const listed = parsePullRequestList(all.stdout, repo);
  assert.ok(listed.some((pr) => pr.closes.length > 0), "some pull request closes an issue");
  assert.ok(listed.some((pr) => pr.files.length > 0), "some pull request lists its files");

  const dir = tempDir("botbench-peers-live-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clone = path.join(dir, "repo");
  initRepo(clone);
  git(clone, "remote", "add", "origin", `https://github.com/${repo.owner}/${repo.name}.git`);
  const branches = await remoteTaskBranches(clone, "origin");
  assert.ok(branches.length > 0, "the repository has task branches from today's two-installation test");
  assert.ok(branches.every((b) => b.branch.startsWith("botbench/") && /^[0-9a-f]{40}$/.test(b.commit)));

  if (process.env.BOTBENCH_CAPTURE_GH === "1") {
    const capture: PeersCapture = {
      gh: execFileSync("gh", ["--version"], { encoding: "utf8" }).split("\n")[0]!,
      captured: new Date().toISOString().slice(0, 10),
      repository: `github.com/${repo.owner}/${repo.name}`,
      outputs: { open: { args, result }, all: { args: allArgs, result: all } },
    };
    const text = JSON.stringify(capture, null, 2);
    assert.doesNotMatch(text, /gh[opsu]_[A-Za-z0-9]{10,}/, "no token in the capture");
    fs.writeFileSync(PEERS_CAPTURE_FILE, `${text}\n`);
  }
});
