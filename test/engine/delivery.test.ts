import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { acceptByMode, decideTask, taskDecision } from "../../src/engine/decision.ts";
import { createDeliveries, deliveryOf, deliverySteps, type Deliveries } from "../../src/engine/delivery.ts";
import { approvePlan, createRun, getRun, storePlan, type Delivery } from "../../src/engine/run.ts";
import { createTask, getTask, moveTask, TaskError, type Task } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { commitWork, createWorktree, pushTaskBranch, remoteBranchCommit } from "../../src/worktrees.ts";
import { replayGitHub, type Replay } from "../support/replay-github.ts";
import { git, initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";

// Delivery against a real git and no network. The remote is a real bare repository on disk (`git init --bare`), and
// every push is a real push into it. The repository's remote is written as a GitHub address, as an owner's is, and the
// repository's own git settings send it to the bare repository (`url.<bare>.insteadOf`), as git does for any rewrite
// the owner sets up. GitHub itself cannot be reached from a test: the pull-request step goes through the GitHub seam,
// which the test supplies as a real function replaying output captured once from the real `gh`
// (test/support/replay-github.ts, the owner's approved exception). The live test opens a real one.

type T = { after(fn: () => unknown): void };
const ADDRESS = "https://github.com/jon-lange/botbench-delivery-fixture.git";

interface Store {
  db: DatabaseSync;
  dir: string;
  home: string;
  repo: string;
  bare: string;
  base: string;
}

function store(t: T, o: { remote?: boolean } = {}): Store {
  const dir = tempDir("botbench-delivery-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", bare);
  // Every update of a branch in the remote is in its log, so a second push would show.
  git(bare, "config", "core.logAllRefUpdates", "always");
  git(repo, "config", `url.${bare}.insteadOf`, ADDRESS);
  if (o.remote !== false) git(repo, "remote", "add", "origin", ADDRESS);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, home, repo, bare, base };
}

const configFor = (s: Store, settings: Record<string, unknown> = {}): Config => ({ port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: { [s.repo]: settings } }) as Config;

function deliveries(t: T, s: Store, replay: Replay, settings: Record<string, unknown> = {}): Deliveries {
  const made = createDeliveries({ db: s.db, config: configFor(s, settings), github: replay.github, onTaskChange: () => {} });
  t.after(() => made.close());
  return made;
}

/** A task Botbench built and committed, ready for review: of a run with `delivery`, or on its own. */
async function readyTask(s: Store, o: { delivery?: Delivery; title?: string; mode?: "manual" | "semi" | "full"; checks?: "passed" | "none" } = {}): Promise<Task> {
  let task: Task;
  if (o.delivery !== undefined) {
    const run = createRun(s.db, { repo: s.repo, prompt: "Add a greeting", baseCommit: s.base, delivery: o.delivery, ...(o.mode === undefined ? {} : { mode: o.mode }) });
    const planned = storePlan(s.db, run.id, [{ title: o.title ?? "Add a greeting file", criteria: ["hello.txt says hi", "Fixes #1 and pings @someone"] }]);
    task = approvePlan(s.db, run.id, planned.planVersion).tasks[0]!;
  } else task = createTask(s.db, { repo: s.repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo: s.repo, home: s.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(s.db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  return moveTask(s.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: o.checks ?? "none" });
}

/** The branches and tags in the remote, each with its commit. */
const remoteRefs = (bare: string): string[] => git(bare, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean);
/** How many times the remote's branch was updated. */
const remoteUpdates = (bare: string, branch: string): number => {
  try {
    return git(bare, "reflog", "show", `refs/heads/${branch}`).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const stepsOf = (db: DatabaseSync, id: number): string[] => deliverySteps(db, id).map((s) => s.step);

async function refused(fn: () => unknown, status: number, message: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof TaskError, String(err));
    assert.equal(err.status, status);
    assert.match(err.message, message);
    return;
  }
  assert.fail("not refused");
}

test("a run that chose pull requests: accepting a task pushes only its branch, at the accepted commit, and opens one pull request whose body carries the task as data", async (t) => {
  const s = store(t);
  // The owner's own settings would push tags along; Botbench's push takes none.
  git(s.repo, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "tag", "-a", "owner-tag", "-m", "an annotated tag, which push.followTags sends");
  git(s.repo, "config", "push.followTags", "true");
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  const task = await readyTask(s, { delivery: "pull_request", title: "Add a greeting file" });

  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  await d.idle();

  assert.deepEqual(stepsOf(s.db, task.id), ["requested", "pushed", "opened"]);
  assert.deepEqual(remoteRefs(s.bare), [`refs/heads/${task.branch} ${task.headCommit}`], "only the task's branch, at the accepted commit; no tag, no other branch");
  assert.equal(replay.opened.length, 1);
  assert.deepEqual(replay.looked, [{ repo: { host: "github.com", owner: "jon-lange", name: "botbench-delivery-fixture" }, branch: task.branch }], "the task's own branch, in the remote's repository");
  const pr = replay.opened[0]!;
  assert.deepEqual([pr.repo, pr.base, pr.head, pr.title], [{ host: "github.com", owner: "jon-lange", name: "botbench-delivery-fixture" }, "main", task.branch, "Add a greeting file"]);
  for (const part of ["## What was asked", "## Acceptance criteria", "## Checks", "Built with Botbench", "No checks are set up"]) assert.ok(pr.body.includes(part), part);
  assert.match(pr.body, /```text\n- hello.txt says hi\n- Fixes #1 and pings @someone\n```/, "what the planner wrote is fenced: no mention, reference or closing keyword acts");
  const view = deliveryOf(s.db, getTask(s.db, task.id)!);
  assert.equal(view.state, "opened");
  assert.equal(view.choice, "pull_request");
  assert.match(view.url!, /\/pull\/\d+$/);
  assert.equal(actionLog(s.db, task.id).filter((e) => e.rule === "delivery").length, 3, "each step is in Activity");
  assert.equal(getTask(s.db, task.id)!.status, "accepted");
});

test("a run that keeps the branch, and a task on its own, send nothing when accepted", async (t) => {
  const s = store(t);
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  const kept = await readyTask(s, { delivery: "branch" });
  const alone = await readyTask(s);
  await decideTask(s.db, { taskId: kept.id, decision: "accept" });
  await decideTask(s.db, { taskId: alone.id, decision: "accept" });
  await d.idle();
  assert.deepEqual([stepsOf(s.db, kept.id), stepsOf(s.db, alone.id)], [[], []]);
  assert.deepEqual(remoteRefs(s.bare), []);
  assert.equal(replay.lookups(), 0);
  assert.equal(deliveryOf(s.db, getTask(s.db, kept.id)!).state, "none");
});

test("the owner's own Open a pull request on a kept branch: refused unless it names the remote and branch shown; then delivered", async (t) => {
  const s = store(t);
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  const task = await readyTask(s);
  await refused(() => d.deliver(task.id, { by: "owner" }), 409, /not accepted/);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  const target = await d.target(getTask(s.db, task.id)!);
  assert.deepEqual(target, { remote: "origin", address: ADDRESS, repository: "github.com/jon-lange/botbench-delivery-fixture", branch: task.branch, base: null });
  await refused(() => d.deliver(task.id, { by: "owner", expect: { remote: "upstream", branch: task.branch } }), 409, /not the one you were shown/);
  await refused(() => d.deliver(task.id, { by: "owner", expect: { remote: "origin", branch: "botbench/other" } }), 409, /not the one you were shown/);
  assert.deepEqual(stepsOf(s.db, task.id), [], "nothing was recorded or sent");

  d.deliver(task.id, { by: "owner", expect: { remote: "origin", branch: task.branch } });
  await refused(() => d.deliver(task.id, { by: "owner" }), 409, /being opened already/);
  await d.idle();
  assert.deepEqual(stepsOf(s.db, task.id), ["requested", "pushed", "opened"]);
  assert.equal(deliverySteps(s.db, task.id)[0]!.requestedBy, "owner");
  await refused(() => d.deliver(task.id, { by: "owner" }), 409, /already has its pull request/);
});

test("no remote: refused before anything is sent, in plain words, the task stays accepted; once a remote is added, Try again delivers", async (t) => {
  const s = store(t, { remote: false });
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  const task = await readyTask(s, { delivery: "pull_request" });
  const { task: accepted } = await decideTask(s.db, { taskId: task.id, decision: "accept" });
  assert.equal(accepted.status, "accepted", "the decision stands whatever the delivery does");
  await d.idle();
  const view = deliveryOf(s.db, getTask(s.db, task.id)!);
  assert.equal(view.state, "failed");
  assert.match(view.problem!, /has no remote named origin.*Nothing was sent\./);
  assert.equal(replay.lookups(), 0);
  assert.equal(getTask(s.db, task.id)!.status, "accepted");
  assert.equal(taskDecision(s.db, task.id)!.decision, "accept");

  git(s.repo, "remote", "add", "origin", ADDRESS);
  d.deliver(task.id, { by: "owner" });
  await d.idle();
  assert.deepEqual(stepsOf(s.db, task.id), ["failed", "requested", "pushed", "opened"]);
});

test("refusals before anything is sent: the branch moved since it was accepted, the branch is the base branch, gh is signed out, the remote is not on GitHub", async (t) => {
  const s = store(t);
  const replay = replayGitHub();
  const moved = await readyTask(s, { delivery: "branch" });
  await decideTask(s.db, { taskId: moved.id, decision: "accept" });
  // Somebody adds a commit to the kept branch after the decision.
  const other = path.join(s.dir, "other-copy");
  git(s.repo, "worktree", "add", "--quiet", other, moved.branch!);
  write(other, "later.txt", "later\n");
  ownerCommit(other, "a later commit");
  const d = deliveries(t, s, replay);
  d.deliver(moved.id, { by: "owner" });
  await d.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, moved.id)!).problem!, /has moved since the task was accepted.*Nothing was sent/);

  const asBase = await readyTask(s, { delivery: "branch" });
  await decideTask(s.db, { taskId: asBase.id, decision: "accept" });
  const based = deliveries(t, s, replay, { baseBranch: asBase.branch });
  based.deliver(asBase.id, { by: "owner" });
  await based.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, asBase.id)!).problem!, /is the repository's base branch, which Botbench never pushes to/);

  const signedOut = await readyTask(s, { delivery: "branch" });
  await decideTask(s.db, { taskId: signedOut.id, decision: "accept" });
  const out = deliveries(t, s, replayGitHub({ signedOut: true }));
  out.deliver(signedOut.id, { by: "owner" });
  await out.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, signedOut.id)!).problem!, /not signed in to github.com.*gh auth login/);

  const local = await readyTask(s, { delivery: "branch" });
  await decideTask(s.db, { taskId: local.id, decision: "accept" });
  git(s.repo, "remote", "set-url", "origin", s.bare);
  d.deliver(local.id, { by: "owner" });
  await d.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, local.id)!).problem!, /is not a GitHub repository address/);

  // A remote that pushes somewhere other than where it fetches from: what would be overwritten cannot be checked.
  const split = await readyTask(s, { delivery: "branch" });
  await decideTask(s.db, { taskId: split.id, decision: "accept" });
  git(s.repo, "remote", "set-url", "origin", ADDRESS);
  git(s.repo, "remote", "set-url", "--push", "origin", path.join(s.dir, "elsewhere.git"));
  d.deliver(split.id, { by: "owner" });
  await d.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, split.id)!).problem!, /pushes to a different address .* than it fetches from/);

  assert.deepEqual(remoteRefs(s.bare), [], "nothing reached the remote");
  for (const id of [moved.id, asBase.id, signedOut.id, local.id, split.id]) assert.deepEqual(stepsOf(s.db, id), ["failed"]);
});

test("only Botbench's own branches are ever pushed or asked about", async (t) => {
  const s = store(t);
  for (const branch of ["main", "smelt/run-1/task-1", "feature/x"]) {
    await assert.rejects(pushTaskBranch({ repo: s.repo, remote: "origin", branch, commit: s.base }), /not a branch Botbench made/);
    await assert.rejects(remoteBranchCommit(s.repo, "origin", branch), /not a branch Botbench made/);
  }
  await assert.rejects(pushTaskBranch({ repo: s.repo, remote: "--mirror", branch: "botbench/x", commit: s.base }), /not a remote name/);
  assert.deepEqual(remoteRefs(s.bare), []);
});

test("never by force: a remote branch of the same name with other commits is refused and left exactly as it was", async (t) => {
  const s = store(t);
  const task = await readyTask(s, { delivery: "pull_request" });
  // The remote already has a branch of that name, on a commit that is not the task's (here: the owner's first commit).
  git(s.repo, "push", "--quiet", s.bare, `${s.base}:refs/heads/${task.branch}`);
  const before = remoteRefs(s.bare);
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  await d.idle();
  const view = deliveryOf(s.db, getTask(s.db, task.id)!);
  assert.equal(view.state, "failed");
  assert.match(view.problem!, /already has a branch named .* with other commits.*never overwrites a branch/);
  assert.deepEqual(remoteRefs(s.bare), before, "nothing was overwritten, not even by a fast-forward");
  assert.equal(replay.opened.length, 0);
  assert.equal(getTask(s.db, task.id)!.status, "accepted");

  // A push the remote itself refuses (here: a branch whose remote ref git would have to replace) is said in its own words.
  const refuse = path.join(s.bare, "hooks", "pre-receive");
  fs.writeFileSync(refuse, "#!/bin/sh\necho 'protected by the remote' >&2\nexit 1\n", { mode: 0o755 });
  const second = await readyTask(s, { delivery: "pull_request" });
  await decideTask(s.db, { taskId: second.id, decision: "accept" });
  await d.idle();
  const refusedView = deliveryOf(s.db, getTask(s.db, second.id)!);
  assert.equal(refusedView.state, "failed");
  assert.match(refusedView.problem!, /protected by the remote/, "the remote's own words");
  assert.deepEqual(remoteRefs(s.bare), before);
});

test("credentials written into a remote's address never reach the ledger, Activity, a failure or the confirmation", async (t) => {
  const s = store(t);
  const secret = "s3cret-token-value";
  const task = await readyTask(s, { delivery: "pull_request" });
  git(s.repo, "remote", "set-url", "origin", `https://jon:${secret}@example.invalid/not-a-repository.git`);
  const d = deliveries(t, s, replayGitHub());
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  await d.idle();
  const view = deliveryOf(s.db, getTask(s.db, task.id)!);
  assert.match(view.problem!, /https:\/\/\*\*\*@example\.invalid/);
  // The confirmation shows a GitHub address with a token in it without the token.
  git(s.repo, "remote", "set-url", "origin", `https://jon:${secret}@github.com/jon-lange/botbench-delivery-fixture.git`);
  assert.equal((await d.target(getTask(s.db, task.id)!))!.address, "https://***@github.com/jon-lange/botbench-delivery-fixture.git");

  // A GitHub address with a token, which git sends to a remote that is not there: the failure is redacted too.
  const second = await readyTask(s, { delivery: "pull_request" });
  const missing = `https://jon:${secret}@github.com/jon-lange/gone.git`;
  git(s.repo, "remote", "set-url", "origin", missing);
  git(s.repo, "config", `url.${path.join(s.dir, "not-there.git")}.insteadOf`, missing);
  await decideTask(s.db, { taskId: second.id, decision: "accept" });
  await d.idle();
  assert.equal(deliveryOf(s.db, getTask(s.db, second.id)!).state, "failed");

  const stored = JSON.stringify([...s.db.prepare("SELECT * FROM deliveries").all(), ...s.db.prepare("SELECT * FROM action_log").all()]);
  assert.equal(stored.includes(secret), false, "no credential is stored");
});

test("a restart between the push and the pull request: the next start takes it up from the ledger, pushes nothing again and opens one pull request", async (t) => {
  const s = store(t);
  const task = await readyTask(s, { delivery: "pull_request" });
  // The first Botbench pushes, then stops while it asks GitHub for the branch's pull request.
  const first = replayGitHub({ hold: true });
  createDeliveries({ db: s.db, config: configFor(s), github: first.github, onTaskChange: () => {} });
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  for (let i = 0; i < 200 && first.lookups() === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(stepsOf(s.db, task.id), ["requested", "pushed"]);
  assert.equal(remoteUpdates(s.bare, task.branch!), 1);

  const second = replayGitHub();
  const d = deliveries(t, s, second);
  await d.idle();
  assert.deepEqual(stepsOf(s.db, task.id), ["requested", "pushed", "requested", "pushed", "opened"]);
  assert.equal(deliverySteps(s.db, task.id)[3]!.detail, "already on the remote");
  assert.equal(remoteUpdates(s.bare, task.branch!), 1, "the branch was not pushed again");
  assert.equal(second.opened.length, 1);
  assert.equal(first.opened.length, 0);

  // A third start finds nothing left to do.
  const third = replayGitHub();
  await deliveries(t, s, third).idle();
  assert.equal(third.lookups(), 0);
});

test("a pull request already there for the branch is taken as the task's, and none is opened", async (t) => {
  const s = store(t);
  const replay = replayGitHub({ existing: true });
  const d = deliveries(t, s, replay);
  const task = await readyTask(s, { delivery: "pull_request" });
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  await d.idle();
  assert.equal(replay.opened.length, 0);
  const view = deliveryOf(s.db, getTask(s.db, task.id)!);
  assert.deepEqual([view.state, view.adopted], ["opened", true]);
});

test("the pull request fails (GitHub refuses, no network): recorded in words with the branch already pushed; Try again opens it without pushing again", async (t) => {
  const s = store(t);
  const replay = replayGitHub({ failOpen: { times: 1, words: "The gh tool said: error connecting to api.github.com" } });
  const d = deliveries(t, s, replay);
  const task = await readyTask(s, { delivery: "pull_request" });
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  await d.idle();
  const view = deliveryOf(s.db, getTask(s.db, task.id)!);
  assert.equal(view.state, "failed");
  assert.match(view.problem!, /is on origin, but the pull request could not be opened: The gh tool said: error connecting/);
  assert.equal(getTask(s.db, task.id)!.status, "accepted");
  assert.equal(getRun(s.db, task.runId!)!.status, "done", "the run ended with the decision, delivery or not");

  d.deliver(task.id, { by: "owner" });
  await d.idle();
  assert.equal(deliveryOf(s.db, getTask(s.db, task.id)!).state, "opened");
  assert.equal(remoteUpdates(s.bare, task.branch!), 1, "pushed once");
  assert.equal(replay.opened.length, 1);
});

test("the ledger is append-only, only for accepted tasks, holds one pull request per task, and a run's delivery never changes", async (t) => {
  const s = store(t);
  const task = await readyTask(s, { delivery: "pull_request" });
  const insert = (step: string): void => {
    s.db.prepare("INSERT INTO deliveries (task_id, step, url, number, adopted, created_at) VALUES (?, ?, 'https://github.com/o/r/pull/1', 1, 0, 't')").run(task.id, step);
  };
  assert.throws(() => insert("opened"), /only an accepted task is delivered/);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  insert("opened");
  assert.throws(() => insert("opened"), /at most one pull request/);
  assert.throws(() => s.db.prepare("UPDATE deliveries SET url = 'x'").run(), /append-only/);
  assert.throws(() => s.db.prepare("DELETE FROM deliveries").run(), /append-only/);
  s.db.prepare("INSERT INTO deliveries (task_id, step, requested_by, created_at) VALUES (?, 'requested', 'owner', 't')").run(task.id);
  const requested = deliverySteps(s.db, task.id).find((row) => row.step === "requested")!.id;
  // Replaced by a row the other triggers would allow: only the append-only rule can refuse it.
  assert.throws(() => s.db.prepare("INSERT OR REPLACE INTO deliveries (id, task_id, step, failed_step, detail, created_at) VALUES (?, ?, 'failed', 'push', 'x', 't')").run(requested, task.id), /append-only/);
  assert.throws(() => s.db.prepare("UPDATE runs SET delivery = 'branch' WHERE id = ?").run(task.runId), /never changed/);
});

test("a fully autonomous run that chose pull requests: the mode's accept delivers the task exactly once, and the body names the mode", async (t) => {
  const s = store(t);
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  const task = await readyTask(s, { delivery: "pull_request", mode: "full", checks: "passed" });
  const { task: accepted } = await acceptByMode(s.db, task.id, "Every check passed and there is no review.");
  assert.equal(taskDecision(s.db, accepted.id)!.decidedBy, "mode");
  await d.idle();
  assert.deepEqual(stepsOf(s.db, task.id), ["requested", "pushed", "opened"]);
  assert.equal(deliverySteps(s.db, task.id)[0]!.requestedBy, "run");
  assert.equal(replay.opened.length, 1);
  assert.match(replay.opened[0]!.body, /## Mode\n\n```text\nfully autonomous\n```/);
  assert.equal(remoteUpdates(s.bare, task.branch!), 1);
  // Nothing more on a second look, and a second instance finds nothing left to do.
  await deliveries(t, s, replay).idle();
  assert.equal(replay.opened.length, 1);
});

test("a restart after the acceptance was recorded and before the delivery began: the next start delivers the run's task", async (t) => {
  const s = store(t);
  const task = await readyTask(s, { delivery: "pull_request" });
  // No Botbench is listening: the decision is recorded and nothing else happens, as if it stopped right then.
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  assert.deepEqual(stepsOf(s.db, task.id), []);
  const replay = replayGitHub();
  await deliveries(t, s, replay).idle();
  assert.deepEqual(stepsOf(s.db, task.id), ["requested", "pushed", "opened"]);
  // A run that keeps its branches is never taken up this way.
  const kept = await readyTask(s, { delivery: "branch" });
  await decideTask(s.db, { taskId: kept.id, decision: "accept" });
  await deliveries(t, s, replayGitHub()).idle();
  assert.deepEqual(stepsOf(s.db, kept.id), []);
});

test("the owner's confirmation names the address it showed: a remote whose address changed since is refused; more than one push address is refused", async (t) => {
  const s = store(t);
  const replay = replayGitHub();
  const d = deliveries(t, s, replay);
  const task = await readyTask(s);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  d.deliver(task.id, { by: "owner", expect: { remote: "origin", branch: task.branch, address: "https://github.com/jon-lange/other.git" } });
  await d.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, task.id)!).problem!, /not the one you were shown/);

  git(s.repo, "remote", "set-url", "--add", "--push", "origin", ADDRESS);
  git(s.repo, "remote", "set-url", "--add", "--push", "origin", path.join(s.dir, "second.git"));
  assert.equal(await d.target(getTask(s.db, task.id)!), null, "nothing to confirm");
  d.deliver(task.id, { by: "owner" });
  await d.idle();
  assert.match(deliveryOf(s.db, getTask(s.db, task.id)!).problem!, /pushes to a different address/);
  assert.deepEqual(remoteRefs(s.bare), []);
});
