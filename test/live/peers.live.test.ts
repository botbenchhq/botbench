import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createGitHub, ghArgs, parsePullRequestList, parsePullRequestPage, PR_LIST_LIMIT, runGh, type RepoRef } from "../../src/github.ts";
import { otherWork } from "../../src/engine/peers.ts";
import { parseTaskBranch } from "../../src/workbench.ts";
import { remoteTaskBranches } from "../../src/worktrees.ts";
import { checkRecording } from "../support/recording-check.ts";
import { initRepo, git, tempDir } from "../support/repo.ts";
import { PEERS_CAPTURE_FILE, PEERS_OPEN_CAPTURE_FILE, type PeersCapture, type PeersOpenCapture } from "../support/replay-peers.ts";

// The one live read of what other workbenches have in flight (Peers P2), against the owner's own repository
// botbenchhq/botbench, read only: the owner's gh lists the open pull requests with Botbench's exact arguments, and the
// real git lists the remote's task branches with `git ls-remote`. Nothing is written to GitHub. With
// BOTBENCH_CAPTURE_GH=1 it also writes what gh printed to test/recordings/gh-peers.json for the replayed tests: the
// open list Botbench asks for, and the same list with every state, so the parser is tested on real closing references
// and files too.

// The repository as it is on GitHub today. The replayed tests keep the one their recordings were captured from
// (PEERS_REPO, jon-lange/botbench); read live, that old name would be answered through GitHub's redirect, and the parser
// leaves out every entry whose address is not on the repository it asked for. A capture taken from here is a new
// recording: the replay's repository and address move to it in the same change.
const LIVE_REPO: RepoRef = { host: "github.com", owner: "botbenchhq", name: "botbench" };

test("live: the owner's gh lists a repository's open pull requests with Botbench's arguments and fields, and git lists its task branches", { timeout: 120_000 }, async (t) => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("gh is not installed here");
  }
  const repo: RepoRef = LIVE_REPO;
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

// Peers P3: when gh's page of pull requests is full, the view asks about each remaining pushed branch on its own. Full
// is what gh gave, not what the parser kept: a page of 100 that holds forks' pull requests (which the parser drops) is
// still full. Read live, with Botbench's exact arguments, from a public repository whose pull requests come from forks
// (cli/cli, gh's own); nothing is written.
test("live: a full page of pull requests that holds forks' is full though the forks' are dropped", { timeout: 120_000 }, async (t) => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("gh is not installed here");
  }
  const repo: RepoRef = { host: "github.com", owner: "cli", name: "cli" };
  const result = await runGh(ghArgs.prListOpen(repo, "all"), { cwd: process.cwd() });
  assert.equal(result.code, 0, result.stderr);
  const raw = JSON.parse(result.stdout) as { isCrossRepository: boolean }[];
  assert.equal(raw.length, PR_LIST_LIMIT, "gh gave a full page");
  const forks = raw.filter((pr) => pr.isCrossRepository).length;
  assert.ok(forks > 0, "the page holds forks' pull requests");
  const page = parsePullRequestPage(result.stdout, repo);
  assert.ok(page.pullRequests.length <= PR_LIST_LIMIT - forks, "the forks' were dropped");
  assert.equal(page.full, true, "and the page is still full");
});

// Peers P4: the open pull requests Botbench checks a task together with. Read live with Botbench's exact arguments,
// passed through the parser and `otherWork` as the view does; nothing is written. What is open changes from day to
// day, so the assertions on an open pull request of another workbench are made only when one is open, and otherwise
// skipped with the reason. With BOTBENCH_CAPTURE_GH_OPEN=1 it writes what gh printed to a new capture,
// test/recordings/gh-peers-open.json, which the check-together tests replay (test/support/replay-peers.ts); it is
// written only when the list holds an open pull request from a Botbench task branch, and never over an existing file.
test("live: the open pull requests parse, and those from another workbench's task branch pass through otherWork with their files", { timeout: 120_000 }, async (t) => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("gh is not installed here");
  }
  const repo: RepoRef = LIVE_REPO;
  const args = ghArgs.prListOpen(repo, "open");
  const result = await runGh(args, { cwd: process.cwd() });
  assert.equal(result.code, 0, result.stderr);
  const page = parsePullRequestPage(result.stdout, repo);
  const viaSeam = await createGitHub().openPullRequests(repo);
  assert.deepEqual(viaSeam.pullRequests.map((pr) => pr.number).sort(), page.pullRequests.map((pr) => pr.number).sort(), "the GitHub seam asks with the same arguments");
  assert.ok(page.pullRequests.every((pr) => pr.state === "OPEN" && pr.url === `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`));
  const fromTasks = page.pullRequests.filter((pr) => parseTaskBranch(pr.headRefName)?.workbench != null);
  if (fromTasks.length === 0) return t.skip("no pull request from a named workbench's task branch is open on botbenchhq/botbench right now");
  // As another workbench sees them: none of these names is its own.
  const work = otherWork(page.pullRequests, fromTasks.map((pr) => ({ branch: pr.headRefName, commit: "0".repeat(40) })), new Set(["a-workbench-that-opened-none"]));
  assert.deepEqual(work.pullRequests.map((pr) => pr.number), fromTasks.map((pr) => pr.number).sort((a, b) => a - b));
  for (const pr of work.pullRequests) {
    assert.equal(pr.head, "0".repeat(40), "its head is the remote's, by branch");
    assert.ok(pr.files.length > 0, `pull request #${pr.number} lists its files`);
  }
  if (process.env.BOTBENCH_CAPTURE_GH_OPEN === "1" && !fs.existsSync(PEERS_OPEN_CAPTURE_FILE)) {
    const capture: PeersOpenCapture = {
      about: "Captured once from the real gh by test/live/peers.live.test.ts (BOTBENCH_CAPTURE_GH_OPEN=1): the open pull requests of botbenchhq/botbench, listed with Botbench's own arguments, while pull requests from named workbenches' task branches were open. Replayed by test/support/replay-peers.ts; never re-recorded.",
      gh: execFileSync("gh", ["--version"], { encoding: "utf8" }).split("\n")[0]!,
      captured: new Date().toISOString(),
      repository: `github.com/${repo.owner}/${repo.name}`,
      outputs: { open: { args, result } },
    };
    const text = JSON.stringify(capture, null, 2);
    checkRecording(text.split("\n"));
    fs.writeFileSync(PEERS_OPEN_CAPTURE_FILE, `${text}\n`);
  }
});
