import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { claimBranchName, claimedBefore, OLD_CLAIM_MS, parseClaimBranch, spottedIssues as serverSpotted, takeOverGiven } from "../../src/engine/claim-branch.ts";
import { claimSteps, createClaims, type Claims } from "../../src/engine/claims.ts";
import { decideTask } from "../../src/engine/decision.ts";
import { createDeliveries, deliverySteps } from "../../src/engine/delivery.ts";
import { lookUpIssue } from "../../src/engine/intake.ts";
import { createPeers } from "../../src/engine/peers.ts";
import { approvePlan, cancelRun, createRun, getRun, runTasks, storePlan, type Run } from "../../src/engine/run.ts";
import { moveTask, settleRunIn, type Task } from "../../src/engine/task.ts";
import { now, openStore, transaction } from "../../src/store/db.ts";
import { chooseWorkbench, parseTaskBranch } from "../../src/workbench.ts";
import { commitWork, createWorktree, deleteRemoteBranchAt, makeClaimCommit, pushNewBranch } from "../../src/worktrees.ts";
import { issueWarnings, oldClaims, peerRows, spottedIssues as composerSpotted } from "../../web/src/app/peers.ts";
import { replayGitHub, type Replay } from "../support/replay-github.ts";
import { ISSUE_ADDRESS, ISSUE_NUMBER, replayIssues } from "../support/replay-issue.ts";
import { PEERS_ADDRESS, replayPeers } from "../support/replay-peers.ts";
import { git, initRepo, tempDir, write } from "../support/repo.ts";

// Claiming an issue (Peers P3) with real git, real SQLite and a real bare repository as the shared remote, reached
// through the GitHub address each clone names (`url.<bare>.insteadOf`), as in test/engine/workbench-branches.test.ts.
// gh's answers are output captured once from the real gh, replayed through the GitHub seam (test/support/replay-*.ts):
// the owner's approved exception to "no fakes". No server and no agent: a run is a real row of the real store, and the
// claim listener is called as the engine calls it. Two workbenches are two stores and two clones of one bare remote.

type T = { after(fn: () => unknown): void };
const STARTED = new Date("2026-11-22T21:05:30.000Z");
const STAMP = "20261122T210530000Z";
const FIVE_MINUTES_LATER = Date.parse("2026-11-22T21:10:40.000Z");

interface Bench {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
  config: Config;
}

/** A shared remote: a bare repository with one commit on main. */
function sharedRemote(t: T): { dir: string; bare: string } {
  const dir = tempDir("botbench-claims-test-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seed = path.join(dir, "seed");
  initRepo(seed);
  const bare = path.join(dir, "remote.git");
  git(dir, "clone", "--quiet", "--bare", seed, bare);
  return { dir, bare };
}

/** One installation: its own store under the workbench name `workbench`, and its own clone of the shared remote. */
function bench(t: T, remote: { dir: string; bare: string }, workbench: string, o: { address?: string | null; claimIssues?: boolean } = {}): Bench {
  const home = path.join(remote.dir, `home-${workbench}`);
  const repo = path.join(remote.dir, `repo-${workbench}`);
  git(remote.dir, "clone", "--quiet", remote.bare, repo);
  git(repo, "remote", "remove", "origin");
  const address = o.address === undefined ? PEERS_ADDRESS : o.address;
  if (address !== null) {
    git(repo, "config", `url.${remote.bare}.insteadOf`, address);
    git(repo, "remote", "add", "origin", address);
  }
  const db = openStore(home);
  t.after(() => db.close());
  chooseWorkbench(db, workbench, "owner");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: o.claimIssues === false ? {} : { claimIssues: true } } };
  return { db, home, repo, base: git(repo, "rev-parse", "HEAD").trim(), config };
}

/** The branches of the shared remote, by name, with the commit each points at. */
function remoteBranches(bare: string): Map<string, string> {
  const out = git(bare, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/");
  return new Map(out.trim().split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
}

/** Tell the claim listener about the run as it stands in the store, and wait for what it started. */
async function changed(claims: Claims, db: DatabaseSync, runId: number): Promise<Run> {
  claims.runChanged({ id: runId });
  await claims.idle();
  return getRun(db, runId)!;
}

/** The claims of one bench, with the clock at `at`, stopping a run as the server does (a cancel). */
function claimsOf(b: Bench, github: Replay["github"], at: Date = STARTED): Claims {
  return createClaims({ db: b.db, config: b.config, github, clock: () => at, stopRun: (id) => cancelRun(b.db, id, "stopped: another workbench's claim on its issue is earlier") });
}

/** End a run as the engine would record a run that failed, or one that is done with no task accepted. */
function endRun(db: DatabaseSync, runId: number, status: "failed" | "done"): void {
  db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), runId);
}

const claimRows = (db: DatabaseSync) => actionLog(db).filter((e) => e.rule === "issue_claim");

test("with claims off (the default), a run from an issue writes nothing to the remote or to GitHub", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice", { claimIssues: false });
  const before = remoteBranches(remote.bare);
  const replay = replayGitHub();
  const claims = claimsOf(alice, replay.github);
  const run = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82 on jon-lange/botbench", baseCommit: alice.base });
  await changed(claims, alice.db, run.id);
  cancelRun(alice.db, run.id);
  await changed(claims, alice.db, run.id);
  assert.deepEqual(remoteBranches(remote.bare), before, "no branch was pushed or deleted");
  assert.equal(replay.lookups(), 0, "gh was not asked anything");
  assert.deepEqual(claimSteps(alice.db, run.id), []);
  assert.deepEqual(claimRows(alice.db), []);
});

test("with claims on, a run whose message names the issue pushes a claim branch at once; cancelled, the branch is deleted", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const replay = replayGitHub();
  const claims = claimsOf(alice, replay.github);
  const run = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82 on jon-lange/botbench", baseCommit: alice.base });
  await changed(claims, alice.db, run.id);

  const branch = `botbench/alice/run-${run.id}/issue-82-at-${STAMP}`;
  assert.equal(claimBranchName("alice", run.id, 82, STARTED), branch);
  const pushed = remoteBranches(remote.bare).get(branch);
  assert.ok(pushed !== undefined, "the claim branch is on the remote before any work is done");
  assert.deepEqual(parseTaskBranch(branch), { prefix: "botbench", workbench: "alice", run: `run-${run.id}`, task: `issue-82-at-${STAMP}` }, "the name is in the task branch form");
  assert.deepEqual(parseClaimBranch(branch), { branch, workbench: "alice", run: run.id, issue: 82, startedAt: "2026-11-22T21:05:30.000Z" }, "the name says workbench, run, issue and time");
  // The commit holds no files and has no parent: nothing of the repository left with it.
  assert.equal(git(remote.bare, "rev-parse", `${pushed}^{tree}`).trim(), git(remote.bare, "hash-object", "-t", "tree", "/dev/null").trim());
  assert.equal(git(remote.bare, "rev-list", "--parents", "-n", "1", pushed!).trim(), pushed);
  assert.equal(git(remote.bare, "log", "-1", "--format=%an", pushed!).trim(), "Botbench");
  assert.deepEqual(claimSteps(alice.db, run.id).map((s) => [s.step, s.issue, s.branch, s.commit]), [["claimed", 82, branch, pushed]]);
  assert.equal(getRun(alice.db, run.id)!.status, "planning", "the run goes on");

  cancelRun(alice.db, run.id);
  await changed(claims, alice.db, run.id);
  assert.equal(remoteBranches(remote.bare).has(branch), false, "released: the branch is gone from the remote");
  assert.deepEqual(replay.looked.map((l) => l.branch), [branch], "gh was asked whether the branch has a pull request, read only");
  assert.deepEqual(claimSteps(alice.db, run.id).map((s) => s.step), ["claimed", "released"]);
  assert.match(claimSteps(alice.db, run.id).at(-1)!.detail, /deleted the branch/);
  assert.deepEqual(claimRows(alice.db).map((e) => e.command.split(" ").slice(0, 2).join(" ")), ["git push", "git push"], "the push and the delete are in the action log");

  // A second end changes nothing.
  await changed(claims, alice.db, run.id);
  assert.deepEqual(claimSteps(alice.db, run.id).map((s) => s.step), ["claimed", "released"]);
});

test("a run with the issue attached with From an issue claims it too; failed, or done with no task accepted, the claim is released", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice", { address: ISSUE_ADDRESS });
  const issues = replayIssues(replayGitHub().github);
  const fetched = await lookUpIssue({ db: alice.db, config: alice.config, github: issues.github, repo: alice.repo, issue: String(ISSUE_NUMBER) });
  const claims = claimsOf(alice, issues.github);

  const failed = createRun(alice.db, { repo: alice.repo, issue: { fetchId: fetched.id, allowHosts: false }, baseCommit: alice.base });
  await changed(claims, alice.db, failed.id);
  const failedBranch = `botbench/alice/run-${failed.id}/issue-${ISSUE_NUMBER}-at-${STAMP}`;
  assert.ok(remoteBranches(remote.bare).has(failedBranch), "the attached issue's number is in the branch's name");
  endRun(alice.db, failed.id, "failed");
  await changed(claims, alice.db, failed.id);
  assert.equal(remoteBranches(remote.bare).has(failedBranch), false);

  // The attached issue wins over a number the message names.
  const done = createRun(alice.db, { repo: alice.repo, prompt: "Also see #7", issue: { fetchId: fetched.id, allowHosts: false }, baseCommit: alice.base });
  await changed(claims, alice.db, done.id);
  const doneBranch = `botbench/alice/run-${done.id}/issue-${ISSUE_NUMBER}-at-${STAMP}`;
  assert.ok(remoteBranches(remote.bare).has(doneBranch));
  endRun(alice.db, done.id, "done");
  await changed(claims, alice.db, done.id);
  assert.equal(remoteBranches(remote.bare).has(doneBranch), false);
  assert.deepEqual(claimSteps(alice.db, done.id).map((s) => s.step), ["claimed", "released"]);
});

test("a run done with an accepted task keeps its claim while a pull request is on its way, and releases it when its accepted work stays a branch", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const claims = claimsOf(alice, replayGitHub().github);
  /** A run whose one task is accepted, its run settled to done, as the engine records it. */
  const acceptedRun = async (delivery: "branch" | "pull_request", issue: number): Promise<{ run: Run; branch: string }> => {
    const run = createRun(alice.db, { repo: alice.repo, prompt: `Issue #${issue}`, baseCommit: alice.base, delivery });
    await changed(claims, alice.db, run.id);
    const stored = storePlan(alice.db, run.id, [{ title: "Fix it", criteria: ["It is fixed"] }]);
    const [task] = approvePlan(alice.db, run.id, stored.planVersion).tasks;
    moveTask(alice.db, task!.id, "building");
    moveTask(alice.db, task!.id, "awaiting_decision", { headCommit: alice.base, checks: "none" });
    // The decision row first, as decideTask writes it (a task is accepted only with its decision).
    alice.db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, reasons, note) VALUES (?, 'owner', 'accept', 'kept', ?, ?, '[]', ?, NULL, NULL)").run(task!.id, `botbench/alice/run-${run.id}/task-${task!.id}`, alice.base, now());
    moveTask(alice.db, task!.id, "accepted");
    transaction(alice.db, () => settleRunIn(alice.db, run.id));
    assert.equal(getRun(alice.db, run.id)!.status, "done");
    return { run: await changed(claims, alice.db, run.id), branch: claimSteps(alice.db, run.id)[0]!.branch! };
  };
  const toPr = await acceptedRun("pull_request", 85);
  assert.ok(remoteBranches(remote.bare).has(toPr.branch), "a pull request is on its way: the claim stays");
  assert.deepEqual(claimSteps(alice.db, toPr.run.id).map((s) => s.step), ["claimed"]);
  const kept = await acceptedRun("branch", 86);
  assert.equal(remoteBranches(remote.bare).has(kept.branch), false, "the accepted work stays a branch, with no pull request: released");

  // The delivery of the first run failed, as engine/delivery.ts records it: no pull request is on its way any more.
  const [task] = runTasks(alice.db, toPr.run.id);
  for (const step of ["requested", "failed"]) {
    alice.db.prepare("INSERT INTO deliveries (task_id, step, requested_by, failed_step, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(task!.id, step, step === "requested" ? "run" : null, step === "failed" ? "push" : null, step === "failed" ? "The remote refused the branch." : null, now());
  }
  await changed(claims, alice.db, toPr.run.id);
  assert.equal(remoteBranches(remote.bare).has(toPr.branch), false, "after the failed delivery the claim is released");
});

test("a remote whose push destination is not the GitHub repository it is written as is not claimed on, and the run goes on", async (t) => {
  const remote = sharedRemote(t);
  const github = replayGitHub().github;
  const cases: [string, (repo: string) => void, RegExp][] = [
    ["pushes elsewhere than it fetches", (repo) => git(repo, "remote", "set-url", "--push", "origin", path.join(remote.dir, "elsewhere.git")), /pushes to another address than it fetches from/],
    ["another GitHub repository", (repo) => git(repo, "config", "url.https://github.com/someone/else.git.insteadOf", PEERS_ADDRESS), /but git sends it to github\.com\/someone\/else/],
    ["another host", (repo) => git(repo, "config", "url.https://gitlab.example/jon-lange/botbench.git.insteadOf", PEERS_ADDRESS), /but git sends it to gitlab\.example\/jon-lange\/botbench/],
    ["an address that reads as no repository", (repo) => git(repo, "config", "url.ext::not-a-repository.insteadOf", PEERS_ADDRESS), /but git sends it to ext::not-a-repository, which Botbench cannot read as that repository/],
  ];
  for (const [i, [name, setUp, words]] of cases.entries()) {
    const b = bench(t, remote, `w${i}`, { address: name === "pushes elsewhere than it fetches" ? undefined : null });
    if (name !== "pushes elsewhere than it fetches") git(b.repo, "remote", "add", "origin", PEERS_ADDRESS);
    setUp(b.repo);
    const before = remoteBranches(remote.bare);
    const run = createRun(b.db, { repo: b.repo, prompt: "Issue #82", baseCommit: b.base });
    const announced: number[] = [];
    const claims = createClaims({ db: b.db, config: b.config, github, clock: () => STARTED, onRunChange: (id) => announced.push(id) });
    await changed(claims, b.db, run.id);
    assert.deepEqual(claimSteps(b.db, run.id).map((s) => s.step), ["not_claimed"], name);
    assert.match(claimSteps(b.db, run.id)[0]!.detail, words, name);
    assert.match(claimSteps(b.db, run.id)[0]!.detail, /^Botbench could not tell other workbenches that you started on issue #82: .* The run goes on as usual\.$/, name);
    assert.equal(getRun(b.db, run.id)!.status, "planning", `${name}: the run goes on`);
    assert.deepEqual(remoteBranches(remote.bare), before, `${name}: nothing was pushed`);
    assert.deepEqual(announced, [run.id], `${name}: the step is announced to the run's screen`);
  }
});

test("a message that names no issue, or more than one, claims nothing", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const claims = claimsOf(alice, replayGitHub().github);
  const before = remoteBranches(remote.bare);
  for (const prompt of ["Make the build faster", "Fix #82 and #83 together", "see page.html#82"]) {
    const run = createRun(alice.db, { repo: alice.repo, prompt, baseCommit: alice.base });
    await changed(claims, alice.db, run.id);
    assert.deepEqual(claimSteps(alice.db, run.id), [], prompt);
  }
  assert.deepEqual(remoteBranches(remote.bare), before);
});

test("a claim branch that moved, that has a pull request, or that is another workbench's is never deleted", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");

  // Moved: somebody pushed a commit onto it after Botbench did.
  const moved = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82", baseCommit: alice.base });
  const plain = claimsOf(alice, replayGitHub().github);
  await changed(plain, alice.db, moved.id);
  const movedBranch = claimSteps(alice.db, moved.id)[0]!.branch!;
  git(alice.repo, "push", "--quiet", "--force", remote.bare, `${alice.base}:refs/heads/${movedBranch}`);
  cancelRun(alice.db, moved.id);
  await changed(plain, alice.db, moved.id);
  assert.equal(remoteBranches(remote.bare).get(movedBranch), alice.base, "the moved branch is still there, at the commit somebody put on it");
  assert.match(claimSteps(alice.db, moved.id).at(-1)!.detail, /^The run ended without a pull request, but Botbench left the branch \S+ on the remote origin: somebody added to it/);
  assert.equal(claimSteps(alice.db, moved.id).at(-1)!.step, "kept");

  // A pull request: gh's captured answer for a branch with one (any state counts).
  const withPr = createRun(alice.db, { repo: alice.repo, prompt: "Issue #83", baseCommit: alice.base });
  const prClaims = claimsOf(alice, replayGitHub({ existing: true }).github);
  await changed(prClaims, alice.db, withPr.id);
  const prBranch = claimSteps(alice.db, withPr.id)[0]!.branch!;
  const prCommit = remoteBranches(remote.bare).get(prBranch);
  cancelRun(alice.db, withPr.id);
  await changed(prClaims, alice.db, withPr.id);
  assert.equal(remoteBranches(remote.bare).get(prBranch), prCommit, "a branch with a pull request stays");
  assert.match(claimSteps(alice.db, withPr.id).at(-1)!.detail, /it has pull request #\d+/);

  // Another workbench's: bob's claim branch on the same remote, under a name this installation never had. A record
  // naming it (as a store written by hand might) still never deletes it.
  const bob = bench(t, remote, "bob");
  const bobRun = createRun(bob.db, { repo: bob.repo, prompt: "Issue #84", baseCommit: bob.base });
  await changed(claimsOf(bob, replayGitHub().github), bob.db, bobRun.id);
  const bobBranch = claimSteps(bob.db, bobRun.id)[0]!.branch!;
  const bobCommit = remoteBranches(remote.bare).get(bobBranch)!;
  const foreign = createRun(alice.db, { repo: alice.repo, prompt: "Issue #84", baseCommit: alice.base });
  alice.db.prepare("INSERT INTO issue_claims (run_id, step, issue, remote, branch, commit_id, detail, created_at) VALUES (?, 'claimed', 84, 'origin', ?, ?, 'recorded', ?)").run(foreign.id, bobBranch, bobCommit, now());
  cancelRun(alice.db, foreign.id);
  await changed(plain, alice.db, foreign.id);
  assert.equal(remoteBranches(remote.bare).get(bobBranch), bobCommit, "bob's branch is untouched");
  assert.match(claimSteps(alice.db, foreign.id).at(-1)!.detail, /not this workbench's own/);
});

test("the delete is git's compare-and-delete: at any other commit than the one given, the remote branch stays", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const branch = `botbench/alice/run-9/issue-1-at-${STAMP}`;
  await pushNewBranch({ repo: alice.repo, remote: "origin", branch, commit: alice.base });
  const other = git(alice.repo, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "commit-tree", "-m", "other", `${alice.base}^{tree}`).trim();
  await assert.rejects(deleteRemoteBranchAt({ repo: alice.repo, remote: "origin", branch, commit: other }), /refused|stale/);
  assert.equal(remoteBranches(remote.bare).get(branch), alice.base);
  await deleteRemoteBranchAt({ repo: alice.repo, remote: "origin", branch, commit: alice.base });
  assert.equal(remoteBranches(remote.bare).has(branch), false);
  await assert.rejects(deleteRemoteBranchAt({ repo: alice.repo, remote: "origin", branch: "main", commit: alice.base }), /never pushed/, "only a branch in Botbench's form");
});

test("a claim that cannot be made (no remote, no network, a refused push) is said in plain words and never stops the run", async (t) => {
  const remote = sharedRemote(t);
  const github = replayGitHub().github;

  const noRemote = bench(t, remote, "alice", { address: null });
  const a = createRun(noRemote.db, { repo: noRemote.repo, prompt: "Issue #82", baseCommit: noRemote.base });
  await changed(claimsOf(noRemote, github), noRemote.db, a.id);
  assert.deepEqual(claimSteps(noRemote.db, a.id).map((s) => s.step), ["not_claimed"]);
  assert.match(claimSteps(noRemote.db, a.id)[0]!.detail, /^Botbench could not tell other workbenches that you started on issue #82: The repository has no remote named origin.* The run goes on as usual\.$/);
  assert.equal(getRun(noRemote.db, a.id)!.status, "planning");

  // No network: the remote's address leads to a folder on this Mac where no repository answers.
  const offline = bench(t, remote, "carol", { address: null });
  git(offline.repo, "config", `url.${path.join(remote.dir, "nowhere.git")}.insteadOf`, PEERS_ADDRESS);
  git(offline.repo, "remote", "add", "origin", PEERS_ADDRESS);
  const b = createRun(offline.db, { repo: offline.repo, prompt: "Issue #82", baseCommit: offline.base });
  await changed(claimsOf(offline, github), offline.db, b.id);
  assert.match(claimSteps(offline.db, b.id)[0]!.detail, /could not be pushed to the remote origin/);
  assert.equal(getRun(offline.db, b.id)!.status, "planning");

  // Refused: a branch of that very name is already on the remote, with another commit. It is not forced over.
  const dave = bench(t, remote, "dave");
  const c = createRun(dave.db, { repo: dave.repo, prompt: "Issue #82", baseCommit: dave.base });
  const taken = claimBranchName("dave", c.id, 82, STARTED);
  git(dave.repo, "push", "--quiet", remote.bare, `${dave.base}:refs/heads/${taken}`);
  await changed(claimsOf(dave, github), dave.db, c.id);
  assert.match(claimSteps(dave.db, c.id)[0]!.detail, /The remote refused the branch/);
  assert.equal(remoteBranches(remote.bare).get(taken), dave.base, "the branch already there was not forced over");
  // Nothing was claimed, so the run's end deletes nothing.
  cancelRun(dave.db, c.id);
  await changed(claimsOf(dave, github), dave.db, c.id);
  assert.equal(remoteBranches(remote.bare).get(taken), dave.base);
});

test("the earliest claim wins at the start: the later workbench withdraws its claim, stops, and names the winner and its time", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const bob = bench(t, remote, "bob");
  const aliceRun = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82 on jon-lange/botbench", baseCommit: alice.base });
  await changed(claimsOf(alice, replayGitHub().github, STARTED), alice.db, aliceRun.id);
  const aliceBranch = claimSteps(alice.db, aliceRun.id)[0]!.branch!;

  const bobRun = createRun(bob.db, { repo: bob.repo, prompt: "Fix #82", baseCommit: bob.base });
  const bobAt = new Date(STARTED.getTime() + 40_000);
  const ended = await changed(claimsOf(bob, replayGitHub().github, bobAt), bob.db, bobRun.id);
  assert.deepEqual(claimSteps(bob.db, bobRun.id).map((s) => s.step), ["claimed", "withdrawn"]);
  const said = claimSteps(bob.db, bobRun.id).at(-1)!.detail;
  assert.match(said, /^alice started on issue #82 at 21:05:30 UTC on 2026-11-22, before this workbench did \(21:06:10 UTC on 2026-11-22\), so this run stopped: when two workbenches start on one issue, the earliest claim goes ahead\. Botbench deleted the branch botbench\/bob\/run-\d+\/issue-82-at-20261122T210610000Z from the remote origin\.$/);
  assert.equal(ended.status, "cancelled", "the later run stopped");
  const branches = remoteBranches(remote.bare);
  assert.ok(branches.has(aliceBranch), "the winner's claim is untouched");
  assert.equal([...branches.keys()].some((b) => b.startsWith("botbench/bob/")), false, "the loser's own claim is gone");
  assert.equal(claimRows(bob.db).length, 2, "the push and the withdrawal are in bob's action log");

  // The winner, reading again before it sends anything, still goes ahead.
  assert.equal(await claimsOf(alice, replayGitHub().github).beforeSend(aliceRun.id, "push", "botbench/alice/run-1/task-1"), null);
  // A second run of alice's own on the issue is the owner's own choice: it does not give way to alice's first claim.
  const again = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82 again", baseCommit: alice.base });
  await changed(claimsOf(alice, replayGitHub().github, new Date(STARTED.getTime() + 60_000)), alice.db, again.id);
  assert.deepEqual(claimSteps(alice.db, again.id).map((s) => s.step), ["claimed"]);
  // Bob's stopped run releases nothing more when it ends.
  await changed(claimsOf(bob, replayGitHub().github), bob.db, bobRun.id);
  assert.deepEqual(claimSteps(bob.db, bobRun.id).map((s) => s.step), ["claimed", "withdrawn"]);
});

test("claims made at the very same millisecond still have one order, the same on both workbenches", () => {
  const at = "20261122T210530000Z";
  const a = parseClaimBranch(`botbench/alice/run-3/issue-82-at-${at}`)!;
  const b = parseClaimBranch(`botbench/bob/run-1/issue-82-at-${at}`)!;
  assert.equal(claimedBefore(a, b), true);
  assert.equal(claimedBefore(b, a), false);
  const earlier = parseClaimBranch("botbench/zed/run-9/issue-82-at-20261122T210529999Z")!;
  assert.equal(claimedBefore(earlier, a), true, "an earlier time wins whatever the name");
  assert.equal(parseClaimBranch("botbench/bob/run-1/issue-82-at-20261322T210530000Z"), null, "month 13 is not a time");
  assert.equal(parseClaimBranch("botbench/bob/run-1/issue-0-at-20261122T210530000Z"), null);
  assert.equal(parseClaimBranch("botbench/bob/run-1/issue-82-at-20261122T2105Z"), null, "a claim's time has seconds and milliseconds");
});

/** A run of `b` from issue `issue` that opens pull requests, its one task built on its own named branch and ready for review. */
async function readyRun(b: Bench, claims: Claims, workbench: string, prompt: string): Promise<{ run: Run; task: Task }> {
  const run = createRun(b.db, { repo: b.repo, prompt, baseCommit: b.base, delivery: "pull_request" });
  // Claimed as it starts, while it is planning.
  await changed(claims, b.db, run.id);
  const stored = storePlan(b.db, run.id, [{ title: "Fix the issue", criteria: ["It is fixed"] }]);
  const task = approvePlan(b.db, run.id, stored.planVersion).tasks[0]!;
  const worktree = await createWorktree({ repo: b.repo, home: b.home, run: `run-${run.id}`, task: `task-${task.id}`, workbench });
  moveTask(b.db, task.id, "building", { worktree });
  write(worktree.path, `${workbench}.txt`, `${workbench}'s fix\n`);
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  return { run, task: moveTask(b.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" }) };
}

test("two workbenches on one issue and one real remote: the later claim pushes nothing and opens no pull request, so at most one is opened", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const bob = bench(t, remote, "bob");
  const aliceGh = replayGitHub();
  const bobGh = replayGitHub();
  const aliceClaims = claimsOf(alice, aliceGh.github, STARTED);
  const bobClaims = claimsOf(bob, bobGh.github, new Date(STARTED.getTime() + 1));
  const aliceDeliveries = createDeliveries({ db: alice.db, config: alice.config, github: aliceGh.github, onTaskChange: () => {}, claims: aliceClaims });
  const bobDeliveries = createDeliveries({ db: bob.db, config: bob.config, github: bobGh.github, onTaskChange: () => {}, claims: bobClaims });
  t.after(() => Promise.all([aliceDeliveries.close(), bobDeliveries.close()]));

  // The gap: bob claims and reads the claims again before alice's claim is on the remote, so bob goes on; alice's claim,
  // made a millisecond earlier by its own clock, lands after that. Both build.
  const bobWork = await readyRun(bob, bobClaims, "bob", "Issue #82 on jon-lange/botbench");
  const aliceWork = await readyRun(alice, aliceClaims, "alice", "Issue #82 on jon-lange/botbench");
  assert.deepEqual(claimSteps(bob.db, bobWork.run.id).map((s) => s.step), ["claimed"], "bob saw no earlier claim when it read");
  assert.deepEqual(claimSteps(alice.db, aliceWork.run.id).map((s) => s.step), ["claimed"], "alice's claim is the earlier one");

  // Both accept. Bob reads the claims again before its push and gives way; alice opens the one pull request.
  await decideTask(bob.db, { taskId: bobWork.task.id, decision: "accept" });
  await decideTask(alice.db, { taskId: aliceWork.task.id, decision: "accept" });
  await Promise.all([bobDeliveries.idle(), aliceDeliveries.idle()]);
  await Promise.all([bobClaims.idle(), aliceClaims.idle()]);
  assert.equal(aliceGh.opened.length + bobGh.opened.length, 1, "at most one pull request for the issue");
  assert.equal(aliceGh.opened.length, 1, "the earliest claim's workbench opened it");
  assert.deepEqual(deliverySteps(bob.db, bobWork.task.id).map((s) => [s.step, s.failedStep]), [["failed", "check"]]);
  assert.match(deliverySteps(bob.db, bobWork.task.id)[0]!.detail!, /^alice started on issue #82 at 21:05:30 UTC on 2026-11-22, before this workbench did \(21:05:30 UTC on 2026-11-22\), so Botbench did not push the branch botbench\/bob\/run-\d+\/task-\d+ or open a pull request/);
  assert.equal(remoteBranches(remote.bare).has(bobWork.task.branch!), false, "bob's work was not pushed");
  assert.deepEqual(claimSteps(bob.db, bobWork.run.id).map((s) => s.step), ["claimed", "withdrawn"]);
  assert.equal([...remoteBranches(remote.bare).keys()].some((b) => b.startsWith("botbench/bob/")), false, "bob's claim is gone too");

  // Try again on bob's side refuses the same way, without reading or sending anything.
  bobDeliveries.deliver(bobWork.task.id, { by: "owner" });
  await bobDeliveries.idle();
  assert.match(deliverySteps(bob.db, bobWork.task.id).at(-1)!.detail!, /^This run gave way to an earlier claim on issue #82/);
  assert.equal(bobGh.opened.length, 0);
});

test("a claim that lands after the later workbench pushed still stops its pull request: the branch stays, withdrawn", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const bob = bench(t, remote, "bob");
  const bobClaims = claimsOf(bob, replayGitHub().github, new Date(STARTED.getTime() + 5000));
  const bobRun = createRun(bob.db, { repo: bob.repo, prompt: "Issue #82", baseCommit: bob.base, delivery: "pull_request" });
  await changed(bobClaims, bob.db, bobRun.id);
  assert.equal(await bobClaims.beforeSend(bobRun.id, "push", "botbench/bob/run-1/task-1"), null, "no earlier claim yet: bob pushes");
  const aliceRun = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82", baseCommit: alice.base });
  await changed(claimsOf(alice, replayGitHub().github, STARTED), alice.db, aliceRun.id);
  const why = await bobClaims.beforeSend(bobRun.id, "pull_request", "botbench/bob/run-1/task-1");
  assert.match(why ?? "", /^alice started on issue #82 at 21:05:30 UTC on 2026-11-22, before this workbench did \(21:05:35 UTC on 2026-11-22\), so Botbench opened no pull request: the branch botbench\/bob\/run-1\/task-1 it pushed stays on the remote, withdrawn, and no pull request is opened from it/);
  assert.deepEqual(claimSteps(bob.db, bobRun.id).map((s) => s.step), ["claimed", "withdrawn"]);
});

test("taking over another workbench's old claim: the run goes ahead, the holder's branch is untouched, and only an old claim of another workbench on this issue can be taken", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const bob = bench(t, remote, "bob");
  // Bob's claim from three hours ago, pushed with Botbench's own claim commit; bob's Botbench is gone.
  const old = new Date(STARTED.getTime() - 3 * 60 * 60_000);
  const bobBranch = claimBranchName("bob", 4, 82, old);
  await pushNewBranch({ repo: bob.repo, remote: "origin", branch: bobBranch, commit: await makeClaimCommit(bob.repo, "Botbench: bob started on issue #82") });
  const bobCommit = remoteBranches(remote.bare).get(bobBranch);

  const own = new Set(["alice"]);
  const taken = takeOverGiven([bobBranch], { issue: 82, own, now: STARTED.getTime() });
  assert.deepEqual(taken.map((c) => [c.workbench, c.issue]), [["bob", 82]]);
  assert.deepEqual(takeOverGiven(undefined, { issue: 82, own, now: STARTED.getTime() }), []);
  const young = claimBranchName("bob", 5, 82, new Date(STARTED.getTime() - OLD_CLAIM_MS + 60_000));
  for (const [given, words] of [[[young], /less than an hour ago/], [[claimBranchName("alice", 1, 82, old)], /this workbench's own claim/], [[claimBranchName("bob", 4, 83, old)], /on issue #83, not on this run's issue #82/], [["main"], /is not a workbench's claim/], ["x", /must be a list/]] as const) {
    assert.throws(() => takeOverGiven(given, { issue: 82, own, now: STARTED.getTime() }), words);
  }
  assert.throws(() => takeOverGiven([bobBranch], { issue: null, own, now: STARTED.getTime() }), /Only a run started from one issue/);

  // Without taking it over, alice gives way to bob's older claim.
  const gaveWay = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82", baseCommit: alice.base });
  await changed(claimsOf(alice, replayGitHub().github), alice.db, gaveWay.id);
  assert.match(claimSteps(alice.db, gaveWay.id).at(-1)!.detail, /^bob started on issue #82 at 18:05:30 UTC on 2026-11-22, before this workbench did/);
  // Taken over after the owner's confirm: the run goes ahead, and says so.
  const run = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82", baseCommit: alice.base, takeOver: taken });
  const went = await changed(claimsOf(alice, replayGitHub().github), alice.db, run.id);
  assert.equal(went.status, "planning");
  assert.deepEqual(claimSteps(alice.db, run.id).map((s) => s.step), ["claimed"]);
  assert.match(claimSteps(alice.db, run.id)[0]!.detail, /You took over bob's claim from 18:05:30 UTC on 2026-11-22; its branch stays on the remote\.$/);
  assert.equal(remoteBranches(remote.bare).get(bobBranch), bobCommit, "bob's branch is never touched");
});

test("startup recovery releases the claims of runs that ended while no Botbench was there, with one action-log row each", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  const first = claimsOf(alice, replayGitHub().github);
  const cancelled = createRun(alice.db, { repo: alice.repo, prompt: "Issue #82", baseCommit: alice.base });
  const done = createRun(alice.db, { repo: alice.repo, prompt: "Issue #83", baseCommit: alice.base });
  const going = createRun(alice.db, { repo: alice.repo, prompt: "Issue #84", baseCommit: alice.base });
  for (const run of [cancelled, done, going]) await changed(first, alice.db, run.id);
  const branchOf = (id: number) => claimSteps(alice.db, id)[0]!.branch!;
  // The workbench stopped; meanwhile one run was cancelled and one ended with its only task discarded, nothing announced.
  cancelRun(alice.db, cancelled.id);
  endRun(alice.db, done.id, "done");
  const rowsBefore = claimRows(alice.db).length;

  const restarted = claimsOf(alice, replayGitHub().github);
  restarted.recover();
  await restarted.idle();
  const branches = remoteBranches(remote.bare);
  assert.equal(branches.has(branchOf(cancelled.id)), false);
  assert.equal(branches.has(branchOf(done.id)), false);
  assert.ok(branches.has(branchOf(going.id)), "a run still going keeps its claim");
  const rows = claimRows(alice.db).slice(rowsBefore);
  assert.deepEqual(rows.map((r) => r.detail!.startsWith("The run ended without a pull request")), [true, true], "one row for each release");
  assert.deepEqual(claimSteps(alice.db, cancelled.id).map((s) => s.step), ["claimed", "released"]);
  // A second start finds nothing more to release.
  const again = claimsOf(alice, replayGitHub().github);
  again.recover();
  await again.idle();
  assert.equal(claimRows(alice.db).length, rowsBefore + 2);
});

test("another workbench's composer sees the claim, for an attached issue and for one its message names; Work names the shared repository, never the viewer's folder", async (t) => {
  const remote = sharedRemote(t);
  const bob = bench(t, remote, "bob");
  const bobRun = createRun(bob.db, { repo: bob.repo, prompt: "Issue #82 on jon-lange/botbench", baseCommit: bob.base });
  await changed(claimsOf(bob, replayGitHub().github), bob.db, bobRun.id);
  const bobBranch = `botbench/bob/run-${bobRun.id}/issue-82-at-${STAMP}`;

  // Alice's own folder for the repository has a name of her own; it must never stand for bob's repository.
  const alice = bench(t, remote, "alice");
  const replay = replayPeers(replayIssues().github);
  const view = await createPeers({ db: alice.db, config: alice.config, github: replay.github }).view(alice.repo);
  assert.equal(view.state, "ready", view.state === "unavailable" ? view.problem : "");
  if (view.state !== "ready") return;
  assert.deepEqual(view.claims, [{ workbench: "bob", branch: bobBranch, issue: 82, startedAt: "2026-11-22T21:05:30.000Z" }], "read from the real remote with git ls-remote");
  assert.deepEqual(view.branches, [], "a claim is not listed again as a pushed branch");

  assert.deepEqual(issueWarnings(view, { attached: 82, message: "", now: FIVE_MINUTES_LATER }), ["bob started on this issue 5 minutes ago."]);
  assert.deepEqual(issueWarnings(view, { attached: null, message: "Issue #82 on jon-lange/botbench", now: FIVE_MINUTES_LATER }), ["A best-effort match on #82 in your message: bob started on this issue 5 minutes ago."]);
  assert.deepEqual(issueWarnings(view, { attached: 81, message: "Fix #80", now: FIVE_MINUTES_LATER }), []);
  assert.deepEqual(oldClaims(view, { attached: null, message: "Issue #82", now: FIVE_MINUTES_LATER }), [], "a claim five minutes old is not offered to take over");
  const later = STARTED.getTime() + OLD_CLAIM_MS + 60_000;
  assert.deepEqual(oldClaims(view, { attached: null, message: "Issue #82", now: later }).map((c) => c.branch), [bobBranch], "after an hour it is");
  assert.deepEqual(oldClaims(view, { attached: null, message: "Fix #82 and #83", now: later }), [], "only for the one issue a run would claim");

  const rows = peerRows(view, FIVE_MINUTES_LATER);
  assert.deepEqual(rows.map((r) => [r.kind, r.workbench, r.branch, r.rest]), [["claim", "bob", bobBranch, " · Started on issue #82 5 minutes ago · github.com/jon-lange/botbench"]]);
  const folder = path.basename(alice.repo);
  for (const row of rows) assert.ok(!row.rest.includes(folder), `the viewer's folder name ${folder} is not shown in place of the repository`);
});

test("Work never shows a branch whose pull request was merged or closed as pushed with no pull request, also when the page of 100 holds a fork's pull request", async (t) => {
  const remote = sharedRemote(t);
  const alice = bench(t, remote, "alice");
  // Bob's branches on the real remote: one whose pull request was merged and is on the page, one whose pull request is
  // older than the page, and one with none.
  for (const branch of ["botbench/bob/run-1/task-1", "botbench/bob/run-2/task-1", "botbench/bob/run-3/task-1"]) git(alice.repo, "push", "--quiet", remote.bare, `${alice.base}:refs/heads/${branch}`);
  // gh's answer, in the shape the real one has (test/recordings/gh-peers.json): 98 of the repository's own pull
  // requests, bob's run-1 among them as merged, and one fork's, so 99 are kept from a full page of 100.
  const pr = (number: number, o: Record<string, unknown> = {}) => ({ number, title: `t${number}`, url: `https://github.com/jon-lange/botbench/pull/${number}`, state: "MERGED", headRefName: `feature/${number}`, isCrossRepository: false, closingIssuesReferences: [], files: [], ...o });
  const list = [pr(1, { headRefName: "botbench/bob/run-1/task-1" }), ...Array.from({ length: 98 }, (_, i) => pr(i + 2)), pr(200, { isCrossRepository: true, headRefName: "botbench/bob/run-3/task-1" })];
  assert.equal(list.length, 100);
  // Each branch asked about on its own gets gh's real captured answer: one pull request for run-2's, none for run-3's.
  const one = replayGitHub({ existing: true }).github;
  const none = replayGitHub();
  const asked: string[] = [];
  const github = { ...replayPeers(replayIssues().github, { stdout: JSON.stringify(list) }).github, findPullRequest: (repo: Parameters<typeof one.findPullRequest>[0], branch: string) => (asked.push(branch), branch.includes("run-2") ? one.findPullRequest(repo, branch) : none.github.findPullRequest(repo, branch)) };
  const view = await createPeers({ db: alice.db, config: alice.config, github }).view(alice.repo);
  assert.equal(view.state, "ready");
  if (view.state !== "ready") return;
  assert.deepEqual(asked.sort(), ["botbench/bob/run-2/task-1", "botbench/bob/run-3/task-1"], "the page was full though a fork's entry was dropped, so the branches not on it were asked about");
  assert.deepEqual(view.branches.map((b) => b.branch), ["botbench/bob/run-3/task-1"], "merged (on the page) and with an older pull request (asked about) are left out; only the one with none is shown");
  assert.deepEqual(peerRows(view).map((r) => r.rest), [" · Pushed, no pull request yet · github.com/jon-lange/botbench"]);
});

test("the server and the composer spot an issue number in a message by the same rule", () => {
  for (const message of ["Issue #82 on jon-lange/botbench", "Fix #59 please", "Issue #59: the gate. Also (#60).", "#59 and #59 again", "see page.html#59, a&#59;b, x#59, colour #fff, #0, #12345678901", "#2147483647 #2147483648", "no number here"]) {
    assert.deepEqual(serverSpotted(message), composerSpotted(message), message);
  }
});
