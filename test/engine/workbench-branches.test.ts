import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { decideTask, discardTask } from "../../src/engine/decision.ts";
import { createDeliveries, deliveryOf, deliverySteps } from "../../src/engine/delivery.ts";
import { approvePlan, createRun, createRuns, storePlan } from "../../src/engine/run.ts";
import { createTask, createTasks, getTask, moveTask, TaskError, type Task } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { chooseWorkbench } from "../../src/workbench.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { replayGitHub } from "../support/replay-github.ts";
import { git, initRepo, tempDir, write } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// Named workbenches (Peers P1) with a real git, real SQLite and no network. Two "installations" are two stores, each
// with its own clone of one shared remote: a real bare repository on disk, reached through the GitHub address its
// clones name (`url.<bare>.insteadOf`), as in test/engine/delivery.test.ts. The builder's turn is a recorded real
// Claude Code turn, replayed (test/support/replay-build.ts); gh's answers are output captured once from the real gh,
// replayed through the GitHub seam (test/support/replay-github.ts): the owner's approved exception to "no fakes".

type T = { after(fn: () => unknown): void };
// jon-lange is the owner the replayed gh recording (test/recordings/gh-delivery.json) was captured under, so it stays.
const ADDRESS = "https://github.com/jon-lange/botbench-peers-fixture.git";

interface Bench {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
}

/** A shared remote with one commit on main. */
function remote(t: T): { dir: string; bare: string } {
  const dir = tempDir("botbench-peers-test-");
  const seed = path.join(dir, "seed");
  initRepo(seed);
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", bare);
  git(bare, "config", "core.logAllRefUpdates", "always");
  git(seed, "push", "--quiet", bare, "main");
  return { dir, bare };
}

/** One installation: its own store named `name` (or left unnamed), and its own clone of the shared remote. */
function bench(t: T, shared: { dir: string; bare: string }, name: string | null): Bench {
  const home = path.join(shared.dir, `home-${name ?? "unnamed"}`);
  const db = openStore(home);
  t.after(() => db.close());
  if (name !== null) chooseWorkbench(db, name, "owner");
  const repo = path.join(shared.dir, `repo-${name ?? "unnamed"}`);
  git(shared.dir, "clone", "--quiet", shared.bare, repo);
  git(repo, "config", `url.${shared.bare}.insteadOf`, ADDRESS);
  git(repo, "remote", "set-url", "origin", ADDRESS);
  return { db, home, repo, base: git(repo, "rev-parse", "HEAD").trim() };
}

const configFor = (b: Bench): Config => ({ port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: { [b.repo]: {} } }) as Config;
const remoteRefs = (bare: string): string[] => git(bare, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/botbench/").split("\n").filter(Boolean);

/** Build run 1's one task through the real build line of `b`, to Ready for review. */
async function buildRunOne(t: T, b: Bench): Promise<Task> {
  const broker = createBroker({ db: b.db, home: b.home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(["done"]);
  const tasks = createTasks({ db: b.db, home: b.home, driver, broker, model: "haiku", repoCommands: () => ({ setup: [{ command: "echo built > built.txt", limitMs: 10_000 }], checks: [] }), repoHosts: () => [], onEvent: () => {}, onTaskChange: () => {}, onRunChange: () => {} });
  const runs = createRuns({ db: b.db, home: b.home, driver, broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
  });
  const run = storePlan(b.db, createRun(b.db, { repo: b.repo, prompt: "Add a file", baseCommit: b.base, delivery: "pull_request" }).id, [{ title: "Add a file", criteria: ["built.txt exists"] }]);
  assert.equal(run.id, 1, "every installation numbers its runs from 1");
  const [task] = runs.approve(run.id, run.planVersion).tasks;
  await tasks.idle();
  const built = getTask(b.db, task!.id)!;
  assert.equal(built.status, "awaiting_decision", built.reason ?? "");
  return built;
}

/** A task with work committed on a branch made by `createWorktree` as given: the old form when no workbench is named. */
async function committedTask(b: Bench, o: { workbench?: string; delivery?: boolean; failed?: boolean } = {}): Promise<Task> {
  const task = o.delivery === true ? storePlanTask(b) : createTask(b.db, { repo: b.repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo: b.repo, home: b.home, run: `run-${task.runId ?? "alone"}`, task: `task-${task.id}`, ...(o.workbench === undefined ? {} : { workbench: o.workbench }) });
  moveTask(b.db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  if (o.failed === true) return moveTask(b.db, task.id, "failed", { reason: "it broke", headCommit: committed.commit });
  return moveTask(b.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
}
/** The one task of an approved plan of a run that opens pull requests, as the store records it, without a build line. */
function storePlanTask(b: Bench): Task {
  const run = storePlan(b.db, createRun(b.db, { repo: b.repo, prompt: "Add a greeting", baseCommit: b.base, delivery: "pull_request" }).id, [{ title: "Add a greeting file", criteria: ["hello.txt says hi"] }]);
  return approvePlan(b.db, run.id, run.planVersion).tasks[0]!;
}

async function deliver(t: T, b: Bench, task: Task): Promise<void> {
  const d = createDeliveries({ db: b.db, config: configFor(b), github: replayGitHub().github, onTaskChange: () => {} });
  t.after(() => d.close());
  await decideTask(b.db, { taskId: task.id, decision: "accept", withoutVerification: true });
  await d.idle();
}

async function refused(fn: () => unknown, message: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof TaskError, String(err));
    assert.equal(err.status, 409);
    assert.match(err.message, message);
    return;
  }
  assert.fail("not refused");
}

test("two installations with different names make different branches for run 1 task 1, and both are delivered to one shared remote", { skip: NO_SANDBOX }, async (t) => {
  const shared = remote(t);
  const alice = bench(t, shared, "alice");
  const bob = bench(t, shared, "bob");
  const a = await buildRunOne(t, alice);
  const b = await buildRunOne(t, bob);
  assert.equal(a.id, b.id, "the same task number in each store");
  assert.equal(a.branch, `botbench/alice/run-1/task-${a.id}`);
  assert.equal(b.branch, `botbench/bob/run-1/task-${b.id}`);

  await deliver(t, alice, a);
  await deliver(t, bob, b);
  for (const [who, task] of [[alice, a], [bob, b]] as const) assert.deepEqual(deliverySteps(who.db, task.id).map((s) => s.step), ["requested", "pushed", "opened"], `${task.branch}: ${deliveryOf(who.db, getTask(who.db, task.id)!).problem}`);
  assert.deepEqual(remoteRefs(shared.bare), [`${a.branch} ${getTask(alice.db, a.id)!.headCommit}`, `${b.branch} ${getTask(bob.db, b.id)!.headCommit}`].sort());
});

test("a task whose branch has the old two-level name is still decided, delivered and discarded", async (t) => {
  const shared = remote(t);
  const alice = bench(t, shared, "alice");
  const accepted = await committedTask(alice, { delivery: true });
  assert.match(accepted.branch!, /^botbench\/run-\d+\/task-\d+$/, "made as before workbenches had names");
  await deliver(t, alice, accepted);
  assert.deepEqual(deliverySteps(alice.db, accepted.id).map((s) => s.step), ["requested", "pushed", "opened"], deliveryOf(alice.db, getTask(alice.db, accepted.id)!).problem ?? "");
  assert.ok(remoteRefs(shared.bare).includes(`${accepted.branch} ${accepted.headCommit}`));

  const rejected = await committedTask(alice);
  await decideTask(alice.db, { taskId: rejected.id, decision: "reject", branch: "discard" });
  assert.equal(git(alice.repo, "branch", "--list", rejected.branch!).trim(), "", "deleted by a reject that discards it");

  const failed = await committedTask(alice, { failed: true });
  await discardTask(alice.db, { taskId: failed.id, removeFiles: [] });
  assert.equal(git(alice.repo, "branch", "--list", failed.branch!).trim(), "", "deleted by Discard");
});

test("another workbench's branch on the shared remote does not block a delivery and is never touched", { skip: NO_SANDBOX }, async (t) => {
  const shared = remote(t);
  const bob = bench(t, shared, "bob");
  const alice = bench(t, shared, "alice");
  const bobs = await buildRunOne(t, bob);
  await deliver(t, bob, bobs);
  const before = git(shared.bare, "reflog", "show", "--format=%H", `refs/heads/${bobs.branch}`);

  const alices = await buildRunOne(t, alice);
  await deliver(t, alice, alices);
  assert.deepEqual(deliverySteps(alice.db, alices.id).map((s) => s.step), ["requested", "pushed", "opened"]);
  assert.equal(git(shared.bare, "reflog", "show", "--format=%H", `refs/heads/${bobs.branch}`), before, "bob's branch on the remote was not pushed to");
  assert.equal(remoteRefs(shared.bare).length, 2);
});

test("a branch under another workbench's name is never decided on, delivered or discarded by this one", async (t) => {
  const shared = remote(t);
  const alice = bench(t, shared, "alice");
  // A task row of this store whose branch carries another workbench's name: the refusals hold even then.
  const strange = await committedTask(alice, { workbench: "bob", delivery: true });
  assert.match(strange.branch!, /^botbench\/bob\//);
  await refused(() => decideTask(alice.db, { taskId: strange.id, decision: "reject", branch: "discard" }), /another workbench \(bob\)/);
  await refused(() => decideTask(alice.db, { taskId: strange.id, decision: "accept", withoutVerification: true }), /another workbench \(bob\)/);
  assert.equal(git(alice.repo, "rev-parse", strange.branch!).trim(), strange.headCommit, "the branch is still there, where it was");
  assert.equal(getTask(alice.db, strange.id)!.status, "awaiting_decision");

  const failed = await committedTask(alice, { workbench: "bob", failed: true });
  await refused(() => discardTask(alice.db, { taskId: failed.id, removeFiles: [] }), /another workbench \(bob\)/);
  assert.equal(git(alice.repo, "rev-parse", failed.branch!).trim(), failed.headCommit);
  assert.deepEqual(remoteRefs(shared.bare), [], "nothing was pushed");
});
