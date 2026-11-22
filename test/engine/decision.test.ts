import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker } from "../../src/approvals/broker.ts";
import { decideTask, discardTask, LeftoversError, taskDecision, taskLeftovers, taskRemains } from "../../src/engine/decision.ts";
import type { PlanTask } from "../../src/engine/roles.ts";
import { approvePlan, createRun, createRuns, getRun, storePlan } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTask, createTasks, getTask, moveTask, settleRunIn, TaskError, type Task, type TaskStatus } from "../../src/engine/task.ts";
import { migrate, openStore, schemaVersion, transaction } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { buildReplayDriver, type BuildTurn } from "../support/replay-build.ts";
import { botbenchBranches, checkoutState, git, initRepo, ownerCommit, tempDir, worktreeCount, write } from "../support/repo.ts";

// Decisions (unit 14): the owner closes a task that is ready for review by accepting or rejecting it. Everything here is
// real: a temporary git repository, git itself, and SQLite. Tasks are put at Ready for review either by Botbench's own
// worktree and commit functions (as the task API tests do) or, where the verify station matters, by the build line with
// a builder's turn replayed from a real Claude Code session (test/support/replay-build.ts) and real check commands.

type T = { after(fn: () => unknown): void };

interface Store {
  db: DatabaseSync;
  dir: string;
  home: string;
  repo: string;
  base: string;
}

function store(t: T, files: Record<string, string> = { "README.md": "# Sample\n" }): Store {
  const dir = tempDir("botbench-decision-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, files);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, home, repo, base };
}

/** A task Botbench built and committed, at Ready for review: its worktree, one committed file, and what its checks found. */
async function readyTask(s: Store, o: { name?: string; checks?: "passed" | "failed" | "none" } = {}): Promise<Task> {
  const task = createTask(s.db, { repo: s.repo, prompt: `create ${o.name ?? "hello"}.txt` });
  const worktree = await createWorktree({ repo: s.repo, home: s.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(s.db, task.id, "building", { worktree });
  write(worktree.path, `${o.name ?? "hello"}.txt`, "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  return moveTask(s.db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: o.checks ?? "none" });
}

const branchHead = (repo: string, branch: string): string => git(repo, "rev-parse", `refs/heads/${branch}`).trim();
const statusOf = (db: DatabaseSync, id: number): string => getTask(db, id)!.status;

async function refused(what: Promise<unknown>, status: number, message: RegExp): Promise<TaskError> {
  try {
    await what;
  } catch (err) {
    assert.ok(err instanceof TaskError, `a TaskError, not ${String(err)}`);
    assert.equal(err.status, status, err.message);
    assert.match(err.message, message);
    return err;
  }
  assert.fail("the decision was not refused");
}

test("Accept keeps the branch at Botbench's commit, removes the clean worktree, and records the decision, its task event and its log entry; the owner's checkout is untouched", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  const before = checkoutState(s.repo);

  const { task: decided } = await decideTask(s.db, { taskId: task.id, decision: "accept" });
  assert.equal(decided.status, "accepted");
  assert.equal(getTask(s.db, task.id)!.status, "accepted");
  assert.deepEqual(botbenchBranches(s.repo), [task.branch]);
  assert.equal(branchHead(s.repo, task.branch!), task.headCommit, "the branch is where Botbench committed the work");
  assert.equal(fs.existsSync(task.worktreePath!), false, "the task's copy is gone");
  assert.equal(worktreeCount(s.repo), 1, "git has no record of it either");
  assert.deepEqual(checkoutState(s.repo), before, "nothing was merged into or changed in the owner's checkout");

  const decision = taskDecision(s.db, task.id)!;
  assert.deepEqual({ ...decision, id: 0, decidedAt: "" }, { id: 0, taskId: task.id, decision: "accept", branch: "kept", branchName: task.branch, headCommit: task.headCommit, leftovers: [], note: null, decidedBy: "owner", reasons: null, decidedAt: "" });
  assert.ok(Date.parse(decision.decidedAt) > 0);
  const events = s.db.prepare("SELECT status FROM task_events WHERE task_id = ? ORDER BY id").all(task.id).map((row) => String(row.status));
  assert.equal(events.at(-1), "accepted");
  const logged = actionLog(s.db, task.id).filter((entry) => entry.rule === "owner_accepted");
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.runId, task.runId);
  assert.equal(logged[0]!.command, task.branch);
  assert.equal(logged[0]!.cwd, s.repo);
});

test("Reject with discard removes the branch and the worktree; Reject with keep leaves the branch and removes the worktree; both are recorded", async (t) => {
  const s = store(t);
  const before = checkoutState(s.repo);
  const discarded = await readyTask(s, { name: "one" });
  const kept = await readyTask(s, { name: "two" });

  await decideTask(s.db, { taskId: discarded.id, decision: "reject", branch: "discard" });
  assert.equal(statusOf(s.db, discarded.id), "rejected");
  assert.equal(fs.existsSync(discarded.worktreePath!), false);
  assert.deepEqual(botbenchBranches(s.repo), [kept.branch], "the discarded task's branch is gone");
  assert.equal(taskDecision(s.db, discarded.id)!.branch, "deleted");

  await decideTask(s.db, { taskId: kept.id, decision: "reject", branch: "keep" });
  assert.equal(statusOf(s.db, kept.id), "rejected");
  assert.equal(fs.existsSync(kept.worktreePath!), false);
  assert.deepEqual(botbenchBranches(s.repo), [kept.branch]);
  assert.equal(branchHead(s.repo, kept.branch!), kept.headCommit);
  assert.equal(taskDecision(s.db, kept.id)!.branch, "kept");
  assert.equal(worktreeCount(s.repo), 1);
  assert.deepEqual(actionLog(s.db).filter((e) => e.rule === "owner_rejected").map((e) => e.taskId), [discarded.id, kept.id]);
  assert.deepEqual(checkoutState(s.repo), before, "the owner's checkout is as it was");
});

test("Discard never deletes a branch that holds commits Botbench did not make: the reject is refused and nothing is removed", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  // The owner committed on the task's branch, in its copy, after Botbench did.
  write(task.worktreePath!, "mine.txt", "the owner's own work\n");
  ownerCommit(task.worktreePath!, "the owner's commit");
  await refused(decideTask(s.db, { taskId: task.id, decision: "reject", branch: "discard" }), 409, /commit/);
  assert.equal(statusOf(s.db, task.id), "awaiting_decision");
  assert.deepEqual(botbenchBranches(s.repo), [task.branch]);
  assert.equal(fs.existsSync(task.worktreePath!), true);
  assert.equal(taskDecision(s.db, task.id), null);
});

test("deciding a task that is not ready for review is refused with a plain reason, and changes nothing", async (t) => {
  const s = store(t);
  const queued = createTask(s.db, { repo: s.repo, prompt: "never started" });
  await refused(decideTask(s.db, { taskId: queued.id, decision: "accept" }), 409, /not ready for review/i);
  const failed = moveTask(s.db, createTask(s.db, { repo: s.repo, prompt: "fails" }).id, "failed", { reason: "it broke" });
  await refused(decideTask(s.db, { taskId: failed.id, decision: "reject", branch: "discard" }), 409, /not ready for review/i);
  await refused(decideTask(s.db, { taskId: 999, decision: "accept" }), 404, /no such task/i);

  const task = await readyTask(s);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  // Decided once: a second decision of either kind is refused, and the first stands.
  await refused(decideTask(s.db, { taskId: task.id, decision: "accept" }), 409, /already accepted/i);
  await refused(decideTask(s.db, { taskId: task.id, decision: "reject", branch: "discard" }), 409, /already accepted/i);
  assert.equal(taskDecision(s.db, task.id)!.decision, "accept");
  assert.deepEqual(botbenchBranches(s.repo), [task.branch]);
  assert.equal(Number(s.db.prepare("SELECT count(*) AS n FROM decisions").get()!.n), 1);
  assert.equal(statusOf(s.db, queued.id), "queued");
});

test("a decision that does not say what it is is refused before anything is touched", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  await refused(decideTask(s.db, { taskId: task.id, decision: "merge" }), 400, /accept or reject/i);
  await refused(decideTask(s.db, { taskId: task.id, decision: "reject" }), 400, /keep or discard/i);
  await refused(decideTask(s.db, { taskId: task.id, decision: "reject", branch: "maybe" }), 400, /keep or discard/i);
  await refused(decideTask(s.db, { taskId: task.id, decision: "accept", branch: "discard" }), 400, /keeps its branch/i);
  await refused(decideTask(s.db, { taskId: task.id, decision: "accept", removeLeftovers: "yes" }), 400, /removeLeftovers/);
  assert.equal(statusOf(s.db, task.id), "awaiting_decision");
  assert.equal(fs.existsSync(task.worktreePath!), true);
});

test("two decisions sent at once for one task: one is made, the other is refused", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  const outcomes = await Promise.allSettled([decideTask(s.db, { taskId: task.id, decision: "accept" }), decideTask(s.db, { taskId: task.id, decision: "reject", branch: "discard" })]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
  assert.ok(lost.reason instanceof TaskError && lost.reason.status === 409, String(lost.reason));
  assert.equal(statusOf(s.db, task.id), "accepted");
  assert.deepEqual(botbenchBranches(s.repo), [task.branch], "the losing discard deleted nothing");
});

test("decisions are append-only, a decision needs a task that is ready for review, and a task is decided only with its decision", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  assert.throws(() => s.db.prepare("UPDATE decisions SET decision = 'reject'").run(), /append-only/);
  assert.throws(() => s.db.prepare("DELETE FROM decisions").run(), /append-only/);
  const other = createTask(s.db, { repo: s.repo, prompt: "queued" });
  assert.throws(() => s.db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at) VALUES (?, 'owner', 'accept', 'kept', 'b', NULL, '[]', 't')").run(other.id), /ready for review/);
  assert.throws(() => s.db.prepare("UPDATE tasks SET status = 'rejected' WHERE id = ?").run(other.id), /decision/);
});

test("the database before decisions is migrated forward and keeps its action log", (t) => {
  const dir = tempDir("botbench-decision-migrate-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "old.sqlite"));
  t.after(() => db.close());
  const before = MIGRATIONS.findIndex((m) => m.name === "decisions");
  assert.ok(before > 0, "a migration named decisions exists");
  migrate(db, MIGRATIONS.slice(0, before));
  db.exec("INSERT INTO action_log (id, ts, task_id, rule, tool, command, cwd, detail) VALUES (41, 't', NULL, 'asked_owner', 'Bash', 'ls', '.', 'kept')");
  migrate(db);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.deepEqual({ ...db.prepare("SELECT id, rule, command, detail FROM action_log").get() }, { id: 41, rule: "asked_owner", command: "ls", detail: "kept" });
  assert.throws(() => db.prepare("DELETE FROM action_log").run(), /append-only/);
});

// The build line, with real check commands, for what only the verify station and a run produce.

const TWO: PlanTask[] = [
  { title: "Add a greeting file", criteria: ["hello.txt exists"] },
  { title: "Add a farewell file", criteria: ["bye.txt exists"] },
];

async function line(t: T, script: BuildTurn[], checks: StationCommand[], files?: Record<string, string>, setup: StationCommand[] = []) {
  const s = store(t, files);
  const broker = createBroker({ db: s.db, home: s.home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(script);
  const tasks = createTasks({ db: s.db, home: s.home, driver, broker, model: "haiku", repoCommands: () => ({ setup, checks }), onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db: s.db, home: s.home, driver, broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
  });
  return { ...s, tasks, runs };
}

test("AE3, and a run is done only when every task is decided: tasks whose checks failed can still be accepted or rejected, and the run waits until the last is decided", async (t) => {
  const e = await line(t, ["done", "done"], [{ command: "echo the suite failed; exit 1", limitMs: 10_000 }]);
  const planned = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Add two files", baseCommit: e.base }).id, TWO);
  const { run, tasks } = e.runs.approve(planned.id, planned.planVersion);
  await e.tasks.idle();
  assert.deepEqual(tasks.map((made) => [getTask(e.db, made.id)!.status, getTask(e.db, made.id)!.checks]), [["awaiting_decision", "failed"], ["awaiting_decision", "failed"]]);
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_decision");

  const first = await decideTask(e.db, { taskId: tasks[0]!.id, decision: "accept" });
  assert.equal(first.task.status, "accepted");
  assert.equal(first.run, null, "the run did not change");
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_decision", "one task is still to be decided");

  const last = await decideTask(e.db, { taskId: tasks[1]!.id, decision: "reject", branch: "keep" });
  assert.deepEqual(last.run, { id: run.id, status: "done" });
  assert.equal(getRun(e.db, run.id)!.status, "done");
  const runEvents = e.db.prepare("SELECT status FROM run_events WHERE run_id = ? ORDER BY id").all(run.id).map((row) => String(row.status));
  assert.equal(runEvents.at(-1), "done");
  assert.equal(worktreeCount(e.repo), 1);
});

test("files a check left in the worktree after Botbench committed are listed and never deleted unasked; ignored files do not count; once confirmed, they go with the worktree and the decision names them", async (t) => {
  const leaves = "echo report > check-report.txt; echo changed >> README.md; mkdir -p node_modules && echo cached > node_modules/cache.txt";
  const e = await line(t, ["done"], [{ command: leaves, limitMs: 10_000 }], { "README.md": "# Sample\n", ".gitignore": "node_modules/\n" });
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(fs.readFileSync(path.join(task.worktreePath!, "check-report.txt"), "utf8"), "report\n", "the check left its file");
  assert.equal(fs.existsSync(path.join(task.worktreePath!, "node_modules", "cache.txt")), true);

  // Listed before deciding: the untracked file and the changed tracked file, not the ignored one.
  assert.deepEqual(await taskLeftovers(task), ["README.md", "check-report.txt"]);

  // Refused with no confirmation, and with a confirmation of only some of them.
  for (const attempt of [{ decision: "accept" }, { decision: "accept", removeLeftovers: ["check-report.txt"] }, { decision: "reject", branch: "keep" }]) {
    const err = await refused(decideTask(e.db, { taskId: task.id, ...attempt }), 409, /left by the checks/);
    assert.ok(err instanceof LeftoversError);
    assert.deepEqual(err.leftovers, ["README.md", "check-report.txt"]);
  }
  assert.equal(statusOf(e.db, task.id), "awaiting_decision");
  assert.equal(fs.existsSync(path.join(task.worktreePath!, "check-report.txt")), true, "nothing was deleted unasked");

  await decideTask(e.db, { taskId: task.id, decision: "accept", removeLeftovers: ["README.md", "check-report.txt"] });
  assert.equal(statusOf(e.db, task.id), "accepted");
  assert.equal(fs.existsSync(task.worktreePath!), false);
  assert.deepEqual(taskDecision(e.db, task.id)!.leftovers, ["README.md", "check-report.txt"]);
  assert.match(actionLog(e.db, task.id).find((entry) => entry.rule === "owner_accepted")!.detail!, /check-report\.txt/);
  // What the checks left is not on the branch.
  assert.throws(() => git(e.repo, "show", `${task.branch}:check-report.txt`));
  assert.equal(git(e.repo, "show", `${task.branch}:README.md`), "# Sample\n");
});

test("a worktree holding only ignored files is clean: Accept removes it without asking", async (t) => {
  const s = store(t, { "README.md": "# Sample\n", ".gitignore": "node_modules/\n" });
  const task = await readyTask(s);
  write(task.worktreePath!, "node_modules/pkg/index.js", "module.exports = 1;\n");
  assert.deepEqual(await taskLeftovers(task), []);
  await decideTask(s.db, { taskId: task.id, decision: "accept" });
  assert.equal(fs.existsSync(task.worktreePath!), false);
  assert.deepEqual(taskDecision(s.db, task.id)!.leftovers, []);
});

test("a file that appears after the owner confirmed the list is not deleted: the decision is refused and lists the files again", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  write(task.worktreePath!, "seen.txt", "the owner saw this one\n");
  assert.deepEqual(await taskLeftovers(task), ["seen.txt"]);
  write(task.worktreePath!, "new.txt", "written after the dialog was opened\n");
  const err = await refused(decideTask(s.db, { taskId: task.id, decision: "accept", removeLeftovers: ["seen.txt"] }), 409, /left by the checks/);
  assert.deepEqual((err as LeftoversError).leftovers, ["new.txt", "seen.txt"]);
  assert.equal(fs.existsSync(path.join(task.worktreePath!, "new.txt")), true);
  assert.equal(statusOf(s.db, task.id), "awaiting_decision");
});

test("a branch that is gone cannot be kept, and one checked out in the owner's own worktree is not deleted: both are refused with nothing changed", async (t) => {
  const s = store(t);
  const gone = await readyTask(s, { name: "one" });
  const out = await readyTask(s, { name: "two" });
  // The owner removed the first task's copy and deleted its branch by hand.
  fs.rmSync(gone.worktreePath!, { recursive: true, force: true });
  git(s.repo, "worktree", "prune");
  git(s.repo, "branch", "-D", gone.branch!);
  await refused(decideTask(s.db, { taskId: gone.id, decision: "accept" }), 409, /not in the repository any more/);
  await refused(decideTask(s.db, { taskId: gone.id, decision: "reject", branch: "keep" }), 409, /not in the repository any more/);
  assert.equal(statusOf(s.db, gone.id), "awaiting_decision");
  // Rejecting it with discard is still possible: there is nothing left to delete.
  await decideTask(s.db, { taskId: gone.id, decision: "reject", branch: "discard" });
  assert.equal(taskDecision(s.db, gone.id)!.branch, "deleted");

  // The owner checked the second task's branch out in a worktree of their own.
  const mine = path.join(s.dir, "owner-copy");
  git(s.repo, "worktree", "add", "--quiet", "--force", mine, out.branch!);
  await refused(decideTask(s.db, { taskId: out.id, decision: "reject", branch: "discard" }), 409, /checked out at/);
  assert.equal(fs.existsSync(out.worktreePath!), true, "nothing was removed");
  assert.equal(statusOf(s.db, out.id), "awaiting_decision");
  assert.deepEqual(botbenchBranches(s.repo), [out.branch]);
});

test("a copy already removed by hand: the decision forgets only that copy, leaves git's record of any other missing folder, and is made", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  // The owner's own linked worktree, on a drive that is not there right now.
  const elsewhere = path.join(s.dir, "owner-worktree");
  git(s.repo, "worktree", "add", "--quiet", "-b", "owner-branch", elsewhere);
  fs.rmSync(elsewhere, { recursive: true, force: true });
  fs.rmSync(task.worktreePath!, { recursive: true, force: true });
  await decideTask(s.db, { taskId: task.id, decision: "reject", branch: "discard" });
  assert.equal(statusOf(s.db, task.id), "rejected");
  assert.deepEqual(botbenchBranches(s.repo), []);
  assert.match(git(s.repo, "worktree", "list", "--porcelain"), /owner-worktree/, "the owner's record is kept");
  assert.doesNotMatch(git(s.repo, "worktree", "list", "--porcelain"), new RegExp(`task-${task.id}`));
  assert.match(actionLog(s.db, task.id).find((e) => e.rule === "owner_rejected")!.detail!, /already gone/);
});

// Unit 16: a run with nothing left to decide ends, and a task that failed or was stopped can be cleaned up by the owner.

test("a run whose every task failed or was stopped does not wait for a decision: it is done, with nothing to review, and its history says why", async (t) => {
  const failing: StationCommand = { command: "echo preparing the copy; exit 1", limitMs: 10_000 };
  const e = await line(t, [], [], undefined, [failing]);
  const planned = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Add two files", baseCommit: e.base }).id, TWO);
  const { run, tasks } = e.runs.approve(planned.id, planned.planVersion);
  await e.tasks.idle();
  assert.deepEqual(tasks.map((made) => statusOf(e.db, made.id)), ["failed", "failed"]);
  assert.equal(getRun(e.db, run.id)!.status, "done", "nothing is ready for review, so the run does not sit at Ready for review");
  const last = e.db.prepare("SELECT status, detail FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(run.id)!;
  assert.deepEqual([last.status, last.detail], ["done", "every task ended and none was ready for review"]);
  assert.equal(Number(e.db.prepare("SELECT count(*) AS n FROM decisions").get()!.n), 0, "no decision is recorded for work that was never ready for review");
});

test("a run with one task decided and the other failed is done once the decided one is decided; one with a task still ready for review waits", async (t) => {
  const s = store(t);
  const planned = storePlan(s.db, createRun(s.db, { repo: s.repo, prompt: "Add two files", baseCommit: s.base }).id, TWO);
  const { tasks } = approvePlan(s.db, planned.id, planned.planVersion);
  // The first task is built and committed by Botbench's own functions; the second fails before it is built.
  const worktree = await createWorktree({ repo: s.repo, home: s.home, run: `run-${planned.id}`, task: `task-${tasks[0]!.id}` });
  moveTask(s.db, tasks[0]!.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: "Botbench task" });
  assert.ok(committed.committed);
  moveTask(s.db, tasks[0]!.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
  moveTask(s.db, tasks[1]!.id, "failed", { reason: "it broke" });
  assert.deepEqual(transaction(s.db, () => settleRunIn(s.db, planned.id)), { id: planned.id, status: "awaiting_decision" }, "one task is ready for review");
  const decided = await decideTask(s.db, { taskId: tasks[0]!.id, decision: "accept" });
  assert.deepEqual(decided.run, { id: planned.id, status: "done" });
});

test("a run an older Botbench left at Ready for review with nothing to decide is ended when Botbench starts", async (t) => {
  const s = store(t);
  const planned = storePlan(s.db, createRun(s.db, { repo: s.repo, prompt: "Add two files", baseCommit: s.base }).id, TWO);
  const { tasks } = approvePlan(s.db, planned.id, planned.planVersion);
  for (const task of tasks) moveTask(s.db, task.id, "interrupted", { reason: "Botbench stopped before this task started." });
  // What a Botbench from before unit 16 wrote for such a run. Written here directly: no Botbench since can write it.
  s.db.prepare("UPDATE runs SET status = 'awaiting_decision' WHERE id = ?").run(planned.id);
  const broker = createBroker({ db: s.db, home: s.home, onChange: () => {} });
  await broker.listen();
  const changes: string[] = [];
  const engine = createTasks({ db: s.db, home: s.home, driver: buildReplayDriver([]), broker, onEvent: () => {}, onTaskChange: () => {}, onRunChange: (run) => changes.push(`${run.id}:${run.status}`) });
  t.after(async () => {
    await engine.close();
    await broker.close();
  });
  await engine.idle();
  assert.equal(getRun(s.db, planned.id)!.status, "done");
  assert.deepEqual(changes, [`${planned.id}:done`]);
});

/** A task Botbench started in its own copy that then ended as `status` before it was ready for review: its copy, its branch, and a file it wrote that is not committed. */
async function endedTask(s: Store, status: Extract<TaskStatus, "failed" | "interrupted" | "cancelled">, o: { commit?: boolean } = {}): Promise<Task> {
  const task = createTask(s.db, { repo: s.repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo: s.repo, home: s.home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(s.db, task.id, "building", { worktree });
  if (o.commit === true) {
    write(worktree.path, "committed.txt", "committed by Botbench\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    assert.ok(committed.committed);
    return moveTask(s.db, task.id, status, { reason: "Botbench stopped while this task was on its way. The work done up to then is committed.", headCommit: committed.commit });
  }
  write(worktree.path, "setup-output.txt", "written by a setup command\n");
  return moveTask(s.db, task.id, status, { reason: "The setup command failed." });
}

test("Discard removes a failed task's copy and Botbench's branch once the owner confirmed the files that are not on the branch; it is logged, no decision is recorded, and the task stays failed", async (t) => {
  const s = store(t);
  const before = checkoutState(s.repo);
  const task = await endedTask(s, "failed");
  assert.deepEqual(await taskRemains(s.db, task), { copy: true, branch: true, files: ["setup-output.txt"], discardedAt: null });

  // Unconfirmed, or confirmed with another list: refused, the files listed, nothing removed.
  for (const removeFiles of [undefined, [], ["other.txt"]]) {
    const err = await refused(discardTask(s.db, { taskId: task.id, removeFiles }), 409, /not on the branch/);
    assert.ok(err instanceof LeftoversError);
    assert.deepEqual(err.leftovers, ["setup-output.txt"]);
  }
  assert.equal(fs.existsSync(path.join(task.worktreePath!, "setup-output.txt")), true, "nothing was deleted unasked");

  const discarded = await discardTask(s.db, { taskId: task.id, removeFiles: ["setup-output.txt"] });
  assert.equal(discarded.status, "failed", "the task keeps its state and its reason");
  assert.equal(discarded.reason, "The setup command failed.");
  assert.equal(fs.existsSync(task.worktreePath!), false, "the copy is gone");
  assert.equal(worktreeCount(s.repo), 1);
  assert.deepEqual(botbenchBranches(s.repo), [], "Botbench's branch is gone");
  assert.deepEqual(checkoutState(s.repo), before, "the owner's checkout is as it was");
  assert.equal(taskDecision(s.db, task.id), null, "it was never ready for review, so it has no decision");
  const logged = actionLog(s.db, task.id).filter((entry) => String(entry.rule) === "owner_discarded");
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.command, task.branch);
  assert.equal(logged[0]!.cwd, s.repo);
  assert.match(logged[0]!.detail!, /setup-output\.txt/);
  const remains = (await taskRemains(s.db, getTask(s.db, task.id)!))!;
  assert.deepEqual({ ...remains, discardedAt: remains.discardedAt === null ? null : "set" }, { copy: false, branch: false, files: [], discardedAt: "set" });

  // Once discarded there is nothing left to discard.
  await refused(discardTask(s.db, { taskId: task.id, removeFiles: [] }), 409, /nothing left to discard/i);
});

test("Discard of a stopped task deletes the branch Botbench committed to, and of a cancelled one too; a copy already removed by hand is forgotten", async (t) => {
  const s = store(t);
  const stopped = await endedTask(s, "interrupted", { commit: true });
  assert.deepEqual((await taskRemains(s.db, stopped))!.files, [], "everything it did is committed");
  await discardTask(s.db, { taskId: stopped.id });
  assert.equal(fs.existsSync(stopped.worktreePath!), false);
  assert.equal(statusOf(s.db, stopped.id), "interrupted");

  const cancelled = await endedTask(s, "cancelled", { commit: true });
  fs.rmSync(cancelled.worktreePath!, { recursive: true, force: true });
  assert.deepEqual(await taskRemains(s.db, cancelled), { copy: false, branch: true, files: [], discardedAt: null });
  await discardTask(s.db, { taskId: cancelled.id });
  assert.deepEqual(botbenchBranches(s.repo), []);
  assert.doesNotMatch(git(s.repo, "worktree", "list", "--porcelain"), new RegExp(`task-${cancelled.id}`));
  assert.match(actionLog(s.db, cancelled.id).find((entry) => String(entry.rule) === "owner_discarded")!.detail!, /already gone/);
});

test("Discard is refused, with nothing removed, for a task that can still be decided or is at work, for a branch with commits Botbench did not make, and for a branch checked out elsewhere", async (t) => {
  const s = store(t);
  const ready = await readyTask(s);
  await refused(discardTask(s.db, { taskId: ready.id }), 409, /ready for review/i);
  assert.equal(fs.existsSync(ready.worktreePath!), true);
  const queued = createTask(s.db, { repo: s.repo, prompt: "never started" });
  await refused(discardTask(s.db, { taskId: queued.id }), 409, /only a task that failed, was stopped or was cancelled/i);
  await refused(discardTask(s.db, { taskId: 999 }), 404, /no such task/i);
  const decided = await readyTask(s, { name: "two" });
  await decideTask(s.db, { taskId: decided.id, decision: "accept" });
  await refused(discardTask(s.db, { taskId: decided.id }), 409, /accepted/i);
  // Never started: no copy and no branch were ever made.
  const never = moveTask(s.db, createTask(s.db, { repo: s.repo, prompt: "fails early" }).id, "failed", { reason: "it broke" });
  await refused(discardTask(s.db, { taskId: never.id }), 409, /nothing left to discard/i);

  const owned = await endedTask(s, "interrupted", { commit: true });
  write(owned.worktreePath!, "mine.txt", "the owner's own work\n");
  ownerCommit(owned.worktreePath!, "the owner's commit");
  await refused(discardTask(s.db, { taskId: owned.id }), 409, /commits Botbench did not make/);
  assert.equal(fs.existsSync(owned.worktreePath!), true, "the copy was not removed");
  assert.ok(botbenchBranches(s.repo).includes(owned.branch!));

  const out = await endedTask(s, "failed", { commit: true });
  const mine = path.join(s.dir, "owner-copy");
  git(s.repo, "worktree", "add", "--quiet", "--force", mine, out.branch!);
  await refused(discardTask(s.db, { taskId: out.id }), 409, /checked out at/);
  assert.equal(fs.existsSync(out.worktreePath!), true);
  assert.equal(actionLog(s.db).filter((entry) => String(entry.rule) === "owner_discarded").length, 0, "nothing refused was logged as discarded");
});

test("the action log before discards is migrated forward: its rows are kept, a discard needs a task, and the log stays append-only", (t) => {
  const dir = tempDir("botbench-discard-migrate-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "old.sqlite"));
  t.after(() => db.close());
  const before = MIGRATIONS.findIndex((m) => m.name === "discards");
  assert.ok(before > 0, "a migration named discards exists");
  migrate(db, MIGRATIONS.slice(0, before));
  db.exec("INSERT INTO action_log (id, ts, task_id, rule, tool, command, cwd, detail) VALUES (41, 't', NULL, 'asked_owner', 'Bash', 'ls', '.', 'kept')");
  assert.throws(() => db.exec("INSERT INTO action_log (ts, task_id, rule, tool, command, cwd) VALUES ('t', NULL, 'owner_discarded', 'Branch', 'b', '/r')"), /CHECK/);
  migrate(db);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.deepEqual({ ...db.prepare("SELECT id, rule, command, detail FROM action_log").get() }, { id: 41, rule: "asked_owner", command: "ls", detail: "kept" });
  assert.throws(() => db.exec("INSERT INTO action_log (ts, task_id, rule, tool, command, cwd) VALUES ('t', NULL, 'owner_discarded', 'Branch', 'b', '/r')"), /CHECK/, "a discard names its task");
  assert.throws(() => db.prepare("DELETE FROM action_log").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE action_log SET detail = 'x'").run(), /append-only/);
});

test("a discard whose branch cannot be deleted after the copy went still logs what it removed, says so, and a second discard deletes the branch", async (t) => {
  const s = store(t);
  const task = await endedTask(s, "failed");
  // git holds a lock on the branch, as a git command running at the same moment would.
  const lock = path.join(s.repo, ".git", "refs", "heads", `${task.branch!}.lock`);
  fs.writeFileSync(lock, "");
  await refused(discardTask(s.db, { taskId: task.id, removeFiles: ["setup-output.txt"] }), 409, /could not be deleted/);
  assert.equal(fs.existsSync(task.worktreePath!), false, "the copy went");
  assert.deepEqual(botbenchBranches(s.repo), [task.branch]);
  const first = actionLog(s.db, task.id).filter((entry) => String(entry.rule) === "owner_discarded");
  assert.equal(first.length, 1, "what was removed is in the log");
  assert.match(first[0]!.detail!, /setup-output\.txt/);
  assert.match(first[0]!.detail!, /could not be deleted/);
  assert.deepEqual({ ...(await taskRemains(s.db, getTask(s.db, task.id)!))!, discardedAt: null }, { copy: false, branch: true, files: [], discardedAt: null }, "the branch is still offered for discarding");

  fs.rmSync(lock);
  await discardTask(s.db, { taskId: task.id });
  assert.deepEqual(botbenchBranches(s.repo), []);
  assert.equal(actionLog(s.db, task.id).filter((entry) => String(entry.rule) === "owner_discarded").length, 2);
});

test("two discards sent at once for one task: one is made, the other is refused", async (t) => {
  const s = store(t);
  const task = await endedTask(s, "interrupted", { commit: true });
  const outcomes = await Promise.allSettled([discardTask(s.db, { taskId: task.id }), discardTask(s.db, { taskId: task.id })]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
  assert.ok(lost.reason instanceof TaskError && lost.reason.status === 409, String(lost.reason));
  assert.equal(actionLog(s.db, task.id).filter((entry) => String(entry.rule) === "owner_discarded").length, 1);
});

test("a decision's note is stored once with it, in its log entry too, and cannot be changed afterwards", async (t) => {
  const s = store(t);
  const task = await readyTask(s);
  await refused(decideTask(s.db, { taskId: task.id, decision: "reject", branch: "keep", note: "a\u0007bell" }), 400, /note/i);
  assert.equal(statusOf(s.db, task.id), "awaiting_decision");
  await decideTask(s.db, { taskId: task.id, decision: "reject", branch: "keep", note: "Wrong file name" });
  assert.equal(taskDecision(s.db, task.id)!.note, "Wrong file name");
  assert.match(actionLog(s.db, task.id).find((e) => e.rule === "owner_rejected")!.detail ?? "", /Your note: Wrong file name$/);
  assert.throws(() => s.db.prepare("UPDATE decisions SET note = 'changed' WHERE task_id = ?").run(task.id), /append-only/);
});
