import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { createBroker } from "../../src/approvals/broker.ts";
import { decideTask } from "../../src/engine/decision.ts";
import { approvePlan, createRun, createRuns, getRun, storePlan } from "../../src/engine/run.ts";
import { createTasks, moveTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { loadPlanRecording, THREE_TASKS, planReplayDriver } from "../support/replay-plan.ts";
import { checkoutState, git, initRepo, tempDir, write } from "../support/repo.ts";

// The north star of the learnings layer (ADR 0005), as one yes/no test: a reason the owner gave for rejecting a task on
// workbench A is committed on A's lesson branch, never in A's checkout, and once the owner merged that branch into the
// shared remote's default branch and both workbenches pulled it, it reaches the next run's planner and builder on A and
// on a second workbench B. Real: two Botbench stores (SQLite) and data folders, a shared bare remote and two clones of
// it, git, the broker on its socket and the engines. No model: the planner's and the builder's turns are replayed from real Claude Code sessions
// (test/support/replay-plan.ts, test/support/replay-build.ts), which keep every prompt they are sent.

type T = { after(fn: () => unknown): void };

const REASON = "Name the file greet.txt: hello.txt is taken by the old installer";

/** One workbench on `repo`: its own data folder and store, a broker, and the run and build engines on replayed turns. */
async function workbench(t: T, root: string, name: string, repo: string) {
  const home = path.join(root, `${name}-home`);
  const db = openStore(home);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const planner = planReplayDriver(loadPlanRecording(), [THREE_TASKS, THREE_TASKS]);
  // One recorded turn per task the replayed plan holds, for each of the runs a test makes here.
  const builder = buildReplayDriver(Array.from({ length: 9 }, () => "done" as const));
  // No setup or check commands: the builder's prompt is what this test reads, not what its turn builds.
  const tasks = createTasks({ db, home, driver: builder, broker, repoCommands: () => ({ setup: [], checks: [] }), onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home, driver: planner, broker, line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
  });
  /** The prompts of a new run's planner and, once the owner approves its plan, of the builder of that run's first task. */
  const prompts = async (): Promise<{ planner: string; builder: string }> => {
    const run = await runs.start({ repo, prompt: "Add a greeting" });
    await runs.idle();
    const planned = getRun(db, run.id)!;
    assert.equal(planned.status, "awaiting_plan_approval", planned.reason ?? "");
    const from = builder.prompts.length;
    const { tasks: queued } = runs.approve(run.id, planned.planVersion);
    assert.ok(queued.length > 0);
    await tasks.idle();
    const first = builder.prompts[from];
    assert.ok(first !== undefined, "the builder of the run's first task was sent a prompt");
    assert.ok(first.startsWith(queued[0]!.prompt), "it is the prompt of the run's first task");
    return { planner: planner.prompts.at(-1)!, builder: first };
  };
  return { db, home, prompts };
}

/** The owner rejects, with `note`, a task of an approved plan titled `title` that Botbench built and committed. */
async function rejectWithNote(db: DatabaseSync, home: string, repo: string, title: string, note: string): Promise<void> {
  const base = git(repo, "rev-parse", "HEAD").trim();
  const run = createRun(db, { repo, prompt: "Add a greeting", baseCommit: base });
  const { tasks } = approvePlan(db, run.id, storePlan(db, run.id, [{ title, criteria: ["the file exists"] }]).planVersion);
  const task = tasks[0]!;
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${task.id}` });
  moveTask(db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  if (!committed.committed) throw new Error("the work was not committed");
  moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
  await decideTask(db, { taskId: task.id, decision: "reject", branch: "discard", note });
}

/** `git` as the owner, whose identity is given here so nothing is needed from this machine's config. */
const asOwner = (repo: string, ...args: string[]): string => git(repo, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false", ...args);

test("north star: a reason given when rejecting a task on workbench A, once the owner merges A's lesson branch into the shared remote's default branch, is in the next planner and builder prompts on A and on workbench B", async (t) => {
  const root = tempDir("botbench-learnings-north-star-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // One shared bare remote, and each workbench's repository folder a clone of it.
  const seed = path.join(root, "seed");
  initRepo(seed);
  const remote = path.join(root, "shared.git");
  execFileSync("git", ["clone", "--quiet", "--bare", seed, remote], { stdio: "ignore" });
  const repoA = path.join(root, "a-repo");
  const repoB = path.join(root, "b-repo");
  for (const repo of [repoA, repoB]) execFileSync("git", ["clone", "--quiet", remote, repo], { stdio: "ignore" });

  const a = await workbench(t, root, "a", repoA);
  const b = await workbench(t, root, "b", repoB);
  const before = checkoutState(repoA);
  await rejectWithNote(a.db, a.home, repoA, "Add a greeting file", REASON);
  // The rejection wrote nothing into A's checkout: the learning is on A's lesson branch, and nothing was pushed.
  assert.deepEqual(checkoutState(repoA), before);
  const lesson = git(repoA, "for-each-ref", "--format=%(refname:short)", "refs/heads/botbench-lesson/").trim();
  assert.match(lesson, /^botbench-lesson\/[a-z0-9-]+\/task-1$/);
  assert.match(git(repoA, "show", `${lesson}:docs/solutions/rejected-add-a-greeting-file.md`), new RegExp(REASON.replace(/\./g, "\\.")));
  assert.equal(git(remote, "for-each-ref", "refs/heads/botbench-lesson/").trim(), "", "nothing was pushed");
  // Until the owner merges it, no run is given it.
  const unmerged = await b.prompts();
  assert.ok(!unmerged.planner.includes(REASON) && !unmerged.builder.includes(REASON));

  // The owner reviews the branch and merges it into the shared remote's default branch like any change; both pull.
  asOwner(repoA, "merge", "--quiet", "--no-ff", "--no-edit", lesson);
  git(repoA, "push", "--quiet", "origin", "main");
  git(repoB, "pull", "--quiet", "--ff-only", "origin", "main");

  for (const [name, at] of [["A", a], ["B", b]] as const) {
    const prompts = await at.prompts();
    assert.ok(prompts.planner.includes(REASON), `${name}'s planner prompt holds the reason:\n${prompts.planner}`);
    assert.ok(prompts.builder.includes(REASON), `${name}'s builder prompt holds the reason:\n${prompts.builder}`);
  }
});
