import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, type Broker } from "../../src/approvals/broker.ts";
import type { Driver } from "../../src/drivers/contract.ts";
import { acceptByMode, decideTask, EvidenceError, taskDecision } from "../../src/engine/decision.ts";
import { evidenceState, rerunRounds, taskCheckReruns } from "../../src/engine/evidence.ts";
import { approvePlan, createRun, createRuns, storePlan } from "../../src/engine/run.ts";
import { taskEvidence, type StationCommand } from "../../src/engine/stations.ts";
import { createTask, createTasks, getTask, moveTask, TaskError, type Task, type Tasks } from "../../src/engine/task.ts";
import { migrate, openStore, schemaVersion } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { storeChecks } from "../support/checks.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { buildReplayDriver, type BuildTurn } from "../support/replay-build.ts";
import { git, initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";

// Evidence tied to the commit under review (engine/evidence.ts). Everything here is real: a temporary git repository,
// git itself, SQLite, and, where a check must run, the build line with real check commands in the real sandbox and a
// builder's turn replayed from a real Claude Code session (test/support/replay-build.ts). No model turn is started.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
/** The replayed "done" turn changes no file, so the repository's setup writes the task's work. */
const SETUP = cmd("printf 'hi\\n' > hello.txt");

interface Line {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
  broker: Broker;
  driver: Driver;
  tasks: Tasks;
  /** The checks the repository has set up; a test may change them between runs. */
  checks: StationCommand[];
}

async function line(t: T, script: BuildTurn[], checks: StationCommand[], files: Record<string, string> = { "README.md": "# Sample\n" }): Promise<Line> {
  const dir = tempDir("botbench-evidence-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, files);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver(script);
  const e: Line = { db, home, repo, base, broker, driver, checks, tasks: undefined as unknown as Tasks };
  e.tasks = createTasks({ db, home, driver, broker, model: "haiku", checkFixRounds: 0, repoCommands: () => ({ setup: [SETUP], checks: e.checks }), onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await e.tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return e;
}

/** A task built and checked by the build line, at Ready for review. */
async function built(e: Line): Promise<Task> {
  const started = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  return task;
}

async function refused(what: Promise<unknown>, status: number, message: RegExp): Promise<TaskError> {
  try {
    await what;
  } catch (err) {
    assert.ok(err instanceof TaskError, `a TaskError, not ${String(err)}`);
    assert.equal(err.status, status, err.message);
    assert.match(err.message, message);
    return err;
  }
  assert.fail("it was not refused");
}

const branchHead = (repo: string, branch: string): string => git(repo, "rev-parse", `refs/heads/${branch}`).trim();
const checkRounds = (db: DatabaseSync, id: number) => taskEvidence(db, id).filter((row) => row.kind === "check").map((row) => ({ round: row.round, command: row.command, outcome: row.outcome, commit: row.commit }));

test("evidence is current when the checks ran on the commit the branch holds: every check result names that commit, Accept is allowed, and the decision and the log name the commit checked", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], [cmd("test -f hello.txt")]);
  const task = await built(e);
  assert.deepEqual(checkRounds(e.db, task.id), [{ round: 1, command: "test -f hello.txt", outcome: "passed", commit: task.headCommit }]);

  const state = await evidenceState(e.db, task);
  assert.equal(state.state, "current");
  assert.deepEqual([state.checks, state.checkedCommit, state.headCommit, state.files, state.ignored], ["passed", task.headCommit, task.headCommit, [], []]);
  assert.match(state.words, new RegExp(`^Evidence is current: the checks passed on commit ${task.headCommit!.slice(0, 7)}, the commit Accept keeps\\.`));

  // "Accept without verification" is no way to accept checked work.
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept", withoutVerification: true }), 409, /has checks, so it is not accepted without verification/);
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept", withoutVerification: "yes" }), 400, /withoutVerification/);
  await decideTask(e.db, { taskId: task.id, decision: "accept" });
  const decision = taskDecision(e.db, task.id)!;
  assert.deepEqual([decision.decision, decision.headCommit, decision.checks, decision.checksCommit], ["accept", task.headCommit, "passed", task.headCommit]);
  const logged = actionLog(e.db, task.id).find((entry) => entry.rule === "owner_accepted")!;
  assert.match(logged.detail!, new RegExp(`Its checks passed on commit ${task.headCommit!.slice(0, 7)}, the commit accepted\\.`));
  assert.doesNotMatch(logged.detail!, /without verification/);
});

test("a commit added to the branch after the checks makes the evidence out of date: Accept is refused naming both commits, Run checks again stores a second result on the new commit without changing the first, and Accept is then allowed", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], [cmd("test -f hello.txt")]);
  const task = await built(e);
  const first = checkRounds(e.db, task.id);
  // The owner commits on the task's branch, in its copy, after Botbench checked it.
  write(task.worktreePath!, "mine.txt", "the owner's own work\n");
  const later = ownerCommit(task.worktreePath!, "the owner's commit");

  const stale = await evidenceState(e.db, task);
  assert.deepEqual([stale.state, stale.checkedCommit, stale.headCommit, stale.canRunAgain], ["stale", task.headCommit, later, true]);
  const words = new RegExp(`The checks are out of date: they ran on commit ${task.headCommit!.slice(0, 7)}, and the branch is now at commit ${later.slice(0, 7)}\\. Run checks again`);
  assert.match(stale.words, words);
  const err = await refused(decideTask(e.db, { taskId: task.id, decision: "accept" }), 409, words);
  assert.ok(err instanceof EvidenceError);
  assert.equal(err.evidence.state, "stale");
  // Nor without verification: it is never a way round out-of-date checks.
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept", withoutVerification: true }), 409, /out of date/);
  assert.equal(getTask(e.db, task.id)!.status, "awaiting_decision");
  assert.equal(fs.existsSync(task.worktreePath!), true, "nothing was removed by the refused accept");
  assert.equal(taskDecision(e.db, task.id), null);

  const checking = await e.tasks.runChecksAgain(task.id);
  assert.equal(checking.status, "verifying");
  await e.tasks.idle();
  const again = getTask(e.db, task.id)!;
  assert.deepEqual([again.status, again.checks], ["awaiting_decision", "passed"]);
  assert.equal(again.headCommit, task.headCommit, "the commit Botbench made is still the one it recorded as its own");
  // The first result is as it was; the second names the commit it ran on.
  assert.deepEqual(checkRounds(e.db, task.id), [...first, { round: 2, command: "test -f hello.txt", outcome: "passed", commit: later }]);
  const reruns = taskCheckReruns(e.db, task.id);
  assert.deepEqual(reruns.map(({ requestedBy, fromCommit, headCommit, outcome }) => ({ requestedBy, fromCommit, headCommit, outcome })), [{ requestedBy: "owner", fromCommit: task.headCommit, headCommit: later, outcome: "passed" }]);
  assert.throws(() => e.db.prepare("UPDATE check_reruns SET outcome = 'failed'").run(), /kept as it ended/);
  assert.throws(() => e.db.prepare("DELETE FROM check_reruns").run(), /never deleted/);
  assert.throws(() => e.db.prepare("UPDATE evidence SET head_commit = ?").run(later), /append-only/);
  // Nor replaced: with recursive triggers on, INSERT OR REPLACE fires the delete triggers.
  assert.throws(() => e.db.prepare("INSERT OR REPLACE INTO evidence (id, task_id, kind, round, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms, head_commit) SELECT id, task_id, kind, round, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms, ? FROM evidence WHERE round = 1").run(later), /append-only/);
  assert.throws(() => e.db.prepare("INSERT OR REPLACE INTO check_reruns (id, task_id, requested_by, from_commit, head_commit, outcome, started_at, ended_at) SELECT id, task_id, requested_by, from_commit, head_commit, 'failed', started_at, ended_at FROM check_reruns").run(), /never deleted|ready for review/);
  assert.deepEqual(rerunRounds(e.db, task.id), [2], "the second round is named as the owner's re-run");

  const current = await evidenceState(e.db, again);
  assert.deepEqual([current.state, current.checkedCommit, current.headCommit], ["current", later, later]);
  // Nothing to run again once the evidence is current.
  await refused(e.tasks.runChecksAgain(task.id), 409, /already ran on commit/);
  await decideTask(e.db, { taskId: task.id, decision: "accept" });
  const decision = taskDecision(e.db, task.id)!;
  assert.deepEqual([decision.headCommit, decision.checks, decision.checksCommit], [later, "passed", later]);
  assert.equal(branchHead(e.repo, task.branch!), later);
});

test("Run checks again on a new commit may find otherwise than before: the task's mark follows the new result, and the earlier result stays as stored", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], [cmd("test ! -f breaks.txt")]);
  const task = await built(e);
  assert.equal(task.checks, "passed");
  write(task.worktreePath!, "breaks.txt", "this breaks the check\n");
  const later = ownerCommit(task.worktreePath!, "a commit that breaks the check");
  await e.tasks.runChecksAgain(task.id);
  await e.tasks.idle();
  const again = getTask(e.db, task.id)!;
  assert.deepEqual([again.status, again.checks], ["awaiting_decision", "failed"]);
  assert.deepEqual(checkRounds(e.db, task.id).map(({ round, outcome, commit }) => [round, outcome, commit]), [[1, "passed", task.headCommit], [2, "failed", later]]);
  assert.equal(taskCheckReruns(e.db, task.id)[0]!.outcome, "failed");
  // No builder was started for the failing check, and the task's history says what was done.
  assert.equal(again.attemptId, task.attemptId);
  // Outside a re-run the mark cannot be rewritten for the same version of the work.
  assert.throws(() => moveTask(e.db, task.id, "awaiting_decision", { checks: "passed" }), /what the checks found is recorded once for each version/);

  // A failed check on the commit under review is current, and not a pass: the owner can still accept, and it is recorded as failed.
  const state = await evidenceState(e.db, again);
  assert.deepEqual([state.state, state.checks, state.checkedCommit], ["current", "failed", later]);
  assert.match(state.words, new RegExp(`^The checks failed on commit ${later.slice(0, 7)}, the commit Accept keeps\\. The result is current, and it is not a pass: you can still accept or reject it\\.`));
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept", withoutVerification: true }), 409, /has checks/);
  await decideTask(e.db, { taskId: task.id, decision: "accept" });
  const decision = taskDecision(e.db, task.id)!;
  assert.deepEqual([decision.checks, decision.checksCommit], ["failed", later]);
  assert.match(actionLog(e.db, task.id).find((entry) => entry.rule === "owner_accepted")!.detail!, new RegExp(`Its checks failed on commit ${later.slice(0, 7)}, the commit accepted`));
});

test("a tracked file edited in the task's copy, or an untracked file git does not ignore, makes the copy differ from the commit: Accept is refused listing the files, and so is Run checks again; Reject still works", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done"], [cmd("test -f hello.txt")]);
  const edited = await built(e);
  write(edited.worktreePath!, "hello.txt", "edited after the checks\n");
  const state = await evidenceState(e.db, edited);
  assert.equal(state.state, "differs");
  assert.deepEqual(state.files, [{ path: "hello.txt", change: "changed" }]);
  assert.match(state.words, new RegExp(`^The task's copy has 1 file that differs from commit ${edited.headCommit!.slice(0, 7)}: hello\\.txt \\(changed\\)\\.`));
  assert.match(state.words, /Look at it in the task's copy/);
  const err = await refused(decideTask(e.db, { taskId: edited.id, decision: "accept" }), 409, /differs from commit/);
  assert.ok(err instanceof EvidenceError);
  assert.deepEqual(err.evidence.files, [{ path: "hello.txt", change: "changed" }]);
  // The files the owner once confirmed for removal no longer let an accept through.
  await refused(decideTask(e.db, { taskId: edited.id, decision: "accept", removeLeftovers: ["hello.txt"] }), 409, /differs from commit/);
  await refused(e.tasks.runChecksAgain(edited.id), 409, /differs from commit/);
  assert.equal(fs.readFileSync(path.join(edited.worktreePath!, "hello.txt"), "utf8"), "edited after the checks\n", "nothing was removed");
  // Reject is always allowed; it still names the files it would remove first.
  await refused(decideTask(e.db, { taskId: edited.id, decision: "reject", branch: "keep" }), 409, /hello\.txt/);
  await decideTask(e.db, { taskId: edited.id, decision: "reject", branch: "keep", removeLeftovers: ["hello.txt"] });
  assert.equal(getTask(e.db, edited.id)!.status, "rejected");
  assert.deepEqual([taskDecision(e.db, edited.id)!.checks, taskDecision(e.db, edited.id)!.checksCommit], [null, null]);

  const added = await built(e);
  write(added.worktreePath!, "notes/new.txt", "not on the branch, not ignored\n");
  const other = await evidenceState(e.db, added);
  assert.equal(other.state, "differs");
  assert.deepEqual(other.files, [{ path: "notes/new.txt", change: "untracked" }]);
  await refused(decideTask(e.db, { taskId: added.id, decision: "accept" }), 409, /notes\/new\.txt \(not on the branch\)/);
  // Committed, the file is part of a newer commit: the checks are then out of date, and can be run again.
  const later = ownerCommit(added.worktreePath!, "keep the notes");
  assert.equal((await evidenceState(e.db, added)).state, "stale");
  await e.tasks.runChecksAgain(added.id);
  await e.tasks.idle();
  await decideTask(e.db, { taskId: added.id, decision: "accept" });
  assert.equal(taskDecision(e.db, added.id)!.checksCommit, later);
});

test("a file git ignores that a check left does not stop Accept: it is disclosed with the evidence, removed with the copy, and named in the log", { skip: NO_SANDBOX }, async (t) => {
  const leaves = "test -f hello.txt && mkdir -p coverage && echo 97 > coverage/summary.txt";
  const e = await line(t, ["done"], [cmd(leaves)], { "README.md": "# Sample\n", ".gitignore": "coverage/\n" });
  const task = await built(e);
  assert.equal(fs.existsSync(path.join(task.worktreePath!, "coverage", "summary.txt")), true, "the check left its file");
  const state = await evidenceState(e.db, task);
  assert.deepEqual([state.state, state.files, state.ignored, state.ignoredMore], ["current", [], ["coverage/"], 0]);
  assert.equal(state.ignoredWords, "Git ignores 1 entry in the task's copy: coverage/. It is not on the branch, does not count against the evidence, and is removed with the copy.");
  await decideTask(e.db, { taskId: task.id, decision: "accept" });
  assert.equal(fs.existsSync(task.worktreePath!), false, "the copy went, and the ignored file with it");
  assert.deepEqual(taskDecision(e.db, task.id)!.leftovers, []);
  assert.match(actionLog(e.db, task.id).find((entry) => entry.rule === "owner_accepted")!.detail!, /The copy held 1 entry git ignores, removed with it: coverage\/\./);
  assert.throws(() => git(e.repo, "show", `${task.branch}:coverage/summary.txt`), "what the check left is not on the branch");
});

test("a check that leaves a file git does not ignore removes the task's readiness to be accepted, by the owner and by a fully autonomous run alike", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], [cmd("test -f hello.txt && echo report > check-report.txt")]);
  const runs = createRuns({ db: e.db, home: e.home, driver: e.driver, broker: e.broker, model: "haiku", implementerModel: "haiku", line: e.tasks, repoCommands: () => ({ setup: [SETUP], checks: e.checks }), onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(() => runs.close());
  const run = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, mode: "full" }).id, [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }]);
  const { tasks } = runs.approve(run.id, run.planVersion);
  await e.tasks.idle();
  const task = getTask(e.db, tasks[0]!.id)!;
  // Its checks passed, and the mode still did not accept it: the same rule as the owner's Accept refused it.
  assert.deepEqual([task.status, task.checks], ["awaiting_decision", "passed"]);
  assert.equal(taskDecision(e.db, task.id), null);
  assert.match(task.reason ?? "", /^It needs your review: Botbench could not accept it without you\. The task's copy has 1 file that differs from commit [0-9a-f]{7}: check-report\.txt \(not on the branch\)\./);
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept" }), 409, /check-report\.txt/);
  assert.equal(fs.existsSync(path.join(task.worktreePath!, "check-report.txt")), true, "nothing was deleted unasked");
});

test("a fully autonomous run's accept uses the same rule: accepted only on current, passed evidence, at the commit Botbench made; out-of-date evidence is the owner's to deal with", async (t) => {
  const dir = tempDir("botbench-evidence-mode-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const ready = async (name: string, checked: (commit: string) => string | null): Promise<Task> => {
    // One task of a fully autonomous run, queued by approving its plan as the run's mode does.
    const run = storePlan(db, createRun(db, { repo, prompt: "Add a file", baseCommit: base, mode: "full" }).id, [{ title: `Add ${name}`, criteria: [`${name}.txt exists`] }]);
    const task = approvePlan(db, run.id, run.planVersion, null, "mode").tasks[0]!;
    const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${task.id}` });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, `${name}.txt`, "hi\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    assert.ok(committed.committed);
    storeChecks(db, task.id, checked(committed.commit));
    return moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed" });
  };

  // Checked on its own commit: accepted, and recorded as checked on that commit.
  const good = await ready("one", (commit) => commit);
  await acceptByMode(db, good.id, "Accepted without you.");
  const decision = taskDecision(db, good.id)!;
  assert.deepEqual([decision.decidedBy, decision.checks, decision.checksCommit, decision.headCommit], ["mode", "passed", good.headCommit, good.headCommit]);

  // A result whose commit is not the branch's: refused with the same words the owner gets.
  const old = await ready("two", () => base);
  const err = await refused(acceptByMode(db, old.id, "Accepted without you."), 409, /The checks are out of date: they ran on commit/);
  assert.ok(err instanceof EvidenceError);
  // A result with no commit recorded is never current.
  const unknown = await ready("three", () => null);
  await refused(acceptByMode(db, unknown.id, "Accepted without you."), 409, /Botbench has no record of the commit these checks ran on/);
  for (const task of [old, unknown]) {
    assert.equal(getTask(db, task.id)!.status, "awaiting_decision");
    assert.equal(fs.existsSync(task.worktreePath!), true);
  }
  // The store itself refuses a mode's accept that is not recorded as checked and passed on its commit.
  assert.throws(
    () => db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, reasons, checks, checks_commit) VALUES (?, 'mode', 'accept', 'kept', 'b', ?, '[]', 'now', 'r', 'none', NULL)").run(old.id, old.headCommit),
    /only on a task whose checks passed on the commit it accepts/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, checks, checks_commit) VALUES (?, 'owner', 'accept', 'kept', 'b', ?, '[]', 'now', 'passed', ?)").run(old.id, old.headCommit, base),
    /names the commit its checks ran on, which is the commit accepted/,
  );
});

test("no checks are set up: Accept is refused without the explicit intent and allowed with it, and the decision and the log say it was accepted without verification", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], []);
  const task = await built(e);
  assert.equal(task.checks, "none");
  const state = await evidenceState(e.db, task);
  assert.deepEqual([state.state, state.checks, state.checkedCommit, state.headCommit, state.canRunAgain], ["none", "none", null, task.headCommit, false]);
  assert.equal(state.words, "No checks are set up for this repository, so nothing verified this work. You can accept it without verification.");

  const err = await refused(decideTask(e.db, { taskId: task.id, decision: "accept" }), 409, /^No checks are set up for this repository, so nothing verified this work\. To accept it all the same, choose Accept without verification\.$/);
  assert.ok(err instanceof EvidenceError);
  assert.equal(getTask(e.db, task.id)!.status, "awaiting_decision");
  await refused(e.tasks.runChecksAgain(task.id), 409, /No checks are set up/);

  await decideTask(e.db, { taskId: task.id, decision: "accept", withoutVerification: true });
  const decision = taskDecision(e.db, task.id)!;
  assert.deepEqual([decision.decision, decision.checks, decision.checksCommit, decision.headCommit], ["accept", "none", null, task.headCommit]);
  const logged = actionLog(e.db, task.id).find((entry) => entry.rule === "owner_accepted")!;
  assert.match(logged.detail!, /Accepted without verification: no checks are set up for this repository, so nothing verified this work\./);
  assert.doesNotMatch(logged.detail!, /checks passed/);
  const event = e.db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND status = 'accepted'").get(task.id)!;
  assert.match(String(event.detail), /without verification/);
});

test("the re-run runs the repository's configured checks and nothing else, in the same sandbox as the first run, and is refused when none is set up any more", { skip: NO_SANDBOX }, async (t) => {
  // The check tries to write beside the copy and to read the owner's ssh folder: the sandbox of a check refuses both.
  const outside = path.join(tempDir("botbench-evidence-outside-"), "written.txt");
  const probe = `test -f hello.txt; touch '${outside}' 2>/dev/null; echo wrote=$?; ls ~/.ssh >/dev/null 2>&1; echo ssh=$?`;
  const e = await line(t, ["done"], [cmd(probe), cmd("echo second")]);
  const task = await built(e);
  const first = taskEvidence(e.db, task.id).filter((row) => row.kind === "check");
  write(task.worktreePath!, "mine.txt", "more\n");
  ownerCommit(task.worktreePath!, "the owner's commit");
  // It takes a task's number and nothing else: there is no argument a command could come in by.
  assert.equal(e.tasks.runChecksAgain.length, 1);
  await e.tasks.runChecksAgain(task.id);
  await e.tasks.idle();
  const second = taskEvidence(e.db, task.id).filter((row) => row.kind === "check" && row.round === 2);
  assert.deepEqual(second.map((row) => row.command), [probe, "echo second"], "exactly the configured checks, in order");
  assert.equal(second[0]!.output, first[0]!.output, "confined exactly as the first run was");
  assert.match(second[0]!.output, /wrote=1\nssh=[12]\n/);
  assert.equal(fs.existsSync(outside), false);

  // With the checks taken out of the settings since, there is nothing to run, and nothing is run.
  write(task.worktreePath!, "more.txt", "more\n");
  ownerCommit(task.worktreePath!, "another commit");
  e.checks = [];
  // The state says so itself once it is told there is nothing to run, so no screen offers a button that cannot work.
  const none = await evidenceState(e.db, getTask(e.db, task.id)!, { checksSetUp: false });
  assert.deepEqual([none.state, none.canRunAgain], ["stale", false]);
  assert.match(none.words, /^The checks are out of date: .* This repository has no checks set up now, so they cannot be run again: add its checks to Botbench's settings file again, or reject the task\.$/);
  await refused(e.tasks.runChecksAgain(task.id), 409, /has no checks set up now, so they cannot be run again/);
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept", withoutVerification: true }), 409, /out of date/);
  assert.equal(getTask(e.db, task.id)!.status, "awaiting_decision");
  assert.equal(taskEvidence(e.db, task.id).filter((row) => row.kind === "check").length, 4);
});

test("a decision and a re-run of the checks sent at once for one task cannot both win, whichever comes first", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done", "done"], [cmd("test -f hello.txt")]);
  for (const order of ["decision first", "re-run first"] as const) {
    const task = await built(e);
    write(task.worktreePath!, "mine.txt", "more\n");
    const later = ownerCommit(task.worktreePath!, "the owner's commit");
    const decide = (): Promise<unknown> => decideTask(e.db, { taskId: task.id, decision: "reject", branch: "keep" });
    const rerun = (): Promise<unknown> => e.tasks.runChecksAgain(task.id);
    const outcomes = await Promise.allSettled(order === "decision first" ? [decide(), rerun()] : [rerun(), decide()]);
    await e.tasks.idle();
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"], order);
    const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof TaskError && lost.reason.status === 409, String(lost.reason));
    const now = getTask(e.db, task.id)!;
    const reran = taskCheckReruns(e.db, task.id).length;
    if (now.status === "rejected") {
      assert.equal(reran, 0, `${order}: the rejected task's checks were not run again`);
      assert.equal(checkRounds(e.db, task.id).length, 1);
    } else {
      assert.equal(now.status, "awaiting_decision", order);
      assert.equal(reran, 1);
      assert.equal(fs.existsSync(task.worktreePath!), true, `${order}: the copy the checks ran in was not removed under them`);
      assert.equal(taskDecision(e.db, task.id), null);
      assert.deepEqual(checkRounds(e.db, task.id).map((row) => row.commit), [task.headCommit, later]);
    }
  }
  // An accept beside a re-run: the evidence is out of date, so the accept loses whatever the order, and the re-run is made.
  const task = await built(e);
  write(task.worktreePath!, "mine.txt", "more\n");
  ownerCommit(task.worktreePath!, "the owner's commit");
  const [accept, rerun] = await Promise.allSettled([decideTask(e.db, { taskId: task.id, decision: "accept" }), e.tasks.runChecksAgain(task.id)]);
  await e.tasks.idle();
  assert.equal(accept.status, "rejected");
  assert.equal(taskDecision(e.db, task.id), null);
  if (rerun.status === "fulfilled") assert.equal(checkRounds(e.db, task.id).length, 2);
  else assert.match(String((rerun.reason as Error).message), /being decided/);
  assert.equal(getTask(e.db, task.id)!.status, "awaiting_decision");
});

test("a database from before commits were recorded is migrated honestly: its check results have no commit, so they are not current, and Accept waits for the checks to be run again", async (t) => {
  const dir = tempDir("botbench-evidence-migrate-");
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const before = MIGRATIONS.findIndex((m) => m.name === "evidence tied to its commit");
  assert.ok(before > 0, "the migration exists");
  const old = new DatabaseSync(path.join(home, "botbench.sqlite"));
  old.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
  migrate(old, MIGRATIONS.slice(0, before));
  assert.equal(schemaVersion(old), before);
  // A task at Ready for review as the version before stored it: its work committed, its checks passed, a decision made on another.
  const task = createTask(old, { repo, prompt: "create hello.txt" });
  const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(old, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  old.prepare("INSERT INTO command_lists (task_id, kind, round, total, started_at) VALUES (?, 'check', 1, 1, 't0')").run(task.id);
  old.prepare("INSERT INTO evidence (task_id, kind, round, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) VALUES (?, 'check', 1, 1, 'npm test', 'passed', 0, NULL, 'ok', 0, 600000, 't1', 't2', 10)").run(task.id);
  moveTask(old, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed" });
  const decided = createTask(old, { repo, prompt: "decided before" });
  moveTask(old, decided.id, "building", {});
  moveTask(old, decided.id, "awaiting_decision", { checks: "passed" });
  old.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at) VALUES (?, 'owner', 'accept', 'kept', 'botbench/x', 'abc', '[]', 't')").run(decided.id);
  const rows = old.prepare("SELECT * FROM evidence").all().map((row) => ({ ...row }));
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  // Every row is kept, and none is given a commit it never recorded.
  assert.deepEqual(db.prepare("SELECT * FROM evidence").all().map((row) => ({ ...row })), rows.map((row) => ({ ...row, head_commit: null })));
  assert.deepEqual({ ...db.prepare("SELECT checks, checks_commit FROM decisions WHERE task_id = ?").get(decided.id) }, { checks: null, checks_commit: null });
  assert.deepEqual([taskDecision(db, decided.id)!.checks, taskDecision(db, decided.id)!.checksCommit], [null, null]);

  const migrated = getTask(db, task.id)!;
  const state = await evidenceState(db, migrated);
  assert.deepEqual([state.state, state.checks, state.checkedCommit, state.headCommit, state.canRunAgain], ["stale", "passed", null, committed.commit, true]);
  assert.match(state.words, new RegExp(`^Botbench has no record of the commit these checks ran on, so they do not count for commit ${committed.commit.slice(0, 7)}, which Accept would keep\\. Run checks again`));
  await refused(decideTask(db, { taskId: task.id, decision: "accept" }), 409, /no record of the commit these checks ran on/);
  await refused(decideTask(db, { taskId: task.id, decision: "accept", withoutVerification: true }), 409, /no record of the commit these checks ran on/);
  assert.equal(getTask(db, task.id)!.status, "awaiting_decision");
  // The mark may change again only while the owner has the checks run again.
  assert.throws(() => moveTask(db, task.id, "awaiting_decision", { checks: "failed" }), /what the checks found is recorded once for each version/);
});

test("the independent review's commit is reported apart: a review of an older commit is said to be out of date, and does not by itself stop Accept", async (t) => {
  const dir = tempDir("botbench-evidence-review-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const run = storePlan(db, createRun(db, { repo, prompt: "Add a file", baseCommit: base, mode: "manual", reviewer: { agent: "codex", model: null } }).id, [{ title: "Add a greeting file", criteria: ["hello.txt exists"] }]);
  const task = approvePlan(db, run.id, run.planVersion).tasks[0]!;
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${task.id}` });
  moveTask(db, task.id, "building", { worktree });
  write(worktree.path, "hello.txt", "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  moveTask(db, task.id, "reviewing", { headCommit: committed.commit, checks: "passed" });
  db.prepare("INSERT INTO reviews (task_id, round, agent, model, attempt_id, outcome, verdict, text, problem, head_commit, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, 1, 'codex', NULL, NULL, 'reviewed', 'looks_right', 'VERDICT: looks right', NULL, ?, 10, 0, 't1', 't2', 5)").run(task.id, committed.commit);
  const ready = moveTask(db, task.id, "awaiting_decision", {});
  storeChecks(db, task.id, committed.commit);
  const fresh = await evidenceState(db, ready);
  assert.deepEqual(fresh.review, { agent: "codex", commit: committed.commit, current: true, words: `Codex's review read commit ${committed.commit.slice(0, 7)}, the commit Accept keeps. A model's opinion, not a check.` });

  // The owner commits, then has the checks run on it: only the review is left behind.
  write(worktree.path, "mine.txt", "more\n");
  const later = ownerCommit(worktree.path, "the owner's commit");
  storeChecks(db, task.id, later);
  const state = await evidenceState(db, ready);
  assert.equal(state.state, "current");
  assert.deepEqual(state.review, { agent: "codex", commit: committed.commit, current: false, words: `Codex's review is out of date: it read commit ${committed.commit.slice(0, 7)}, and the branch is now at commit ${later.slice(0, 7)}. A model's opinion, not a check: it does not stop Accept.` });
  await decideTask(db, { taskId: task.id, decision: "accept" });
  assert.equal(taskDecision(db, task.id)!.checksCommit, later);
});

test("a tracked file the index is told not to compare cannot hide a change: it counts as changed, so the copy differs and Accept is refused", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done"], [cmd("test -f hello.txt")]);
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const task = await built(e);
    git(task.worktreePath!, "update-index", flag, "hello.txt");
    write(task.worktreePath!, "hello.txt", "changed where git status does not look\n");
    assert.equal(git(task.worktreePath!, "status", "--porcelain").trim(), "", `${flag}: git status itself shows nothing`);
    const state = await evidenceState(e.db, task);
    assert.deepEqual([state.state, state.files], ["differs", [{ path: "hello.txt", change: "changed" }]], flag);
    await refused(decideTask(e.db, { taskId: task.id, decision: "accept" }), 409, /hello\.txt \(changed\)/);
    assert.equal(getTask(e.db, task.id)!.status, "awaiting_decision");
  }
});

test("while the checks run again nothing is decided: an accept and a reject are refused, the copy stays, and the decision is made once they have finished", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], [cmd("test -f hello.txt && sleep 1")]);
  const task = await built(e);
  write(task.worktreePath!, "mine.txt", "more\n");
  const later = ownerCommit(task.worktreePath!, "the owner's commit");
  // The re-run has won: the task is at its checks before either decision is asked for.
  assert.equal((await e.tasks.runChecksAgain(task.id)).status, "verifying");
  await refused(decideTask(e.db, { taskId: task.id, decision: "accept" }), 409, /is still being checked/);
  await refused(decideTask(e.db, { taskId: task.id, decision: "reject", branch: "discard" }), 409, /is still being checked/);
  await refused(e.tasks.runChecksAgain(task.id), 409, /only on a task that is ready for review/);
  assert.equal(fs.existsSync(task.worktreePath!), true, "the copy the checks run in was not removed under them");
  assert.equal(taskDecision(e.db, task.id), null);
  await e.tasks.idle();
  assert.deepEqual(checkRounds(e.db, task.id).map((row) => [row.round, row.outcome, row.commit]), [[1, "passed", task.headCommit], [2, "passed", later]]);
  await decideTask(e.db, { taskId: task.id, decision: "accept" });
  assert.equal(taskDecision(e.db, task.id)!.checksCommit, later);
});

test("a re-run that does not finish counts for nothing: its run cancelled while the checks ran again, the task is ready for review as before, the re-run is recorded as stopped, and the checks can be run again", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], [cmd("test -f hello.txt")]);
  const runs = createRuns({ db: e.db, home: e.home, driver: e.driver, broker: e.broker, model: "haiku", implementerModel: "haiku", line: e.tasks, repoCommands: () => ({ setup: [SETUP], checks: e.checks }), onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(() => runs.close());
  const run = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base }).id, [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }]);
  const id = runs.approve(run.id, run.planVersion).tasks[0]!.id;
  await e.tasks.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  write(task.worktreePath!, "mine.txt", "more\n");
  const later = ownerCommit(task.worktreePath!, "the owner's commit");
  e.checks = [cmd("sleep 30")];
  await e.tasks.runChecksAgain(id);
  // Wait until the slow check is running, then stop the run's work, as a cancel of the run does.
  const deadline = Date.now() + 10_000;
  while (e.db.prepare("SELECT 1 FROM command_processes WHERE task_id = ? AND round = 2 AND pgid IS NOT NULL").get(id) === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await e.tasks.stopRun(run.id);
  await e.tasks.idle();
  const after = getTask(e.db, id)!;
  assert.deepEqual([after.status, after.checks], ["awaiting_decision", "passed"], "ready for review as before, its mark as it was");
  assert.deepEqual(taskCheckReruns(e.db, id).map((r) => r.outcome), ["stopped"]);
  assert.deepEqual(checkRounds(e.db, id).map((row) => [row.round, row.outcome]), [[1, "passed"], [2, "stopped"]]);
  const state = await evidenceState(e.db, after);
  assert.deepEqual([state.state, state.checkedCommit, state.headCommit, state.canRunAgain], ["stale", null, later, true]);
  assert.match(state.words, /^The latest checks did not finish, so nothing is verified for commit/);
  await refused(decideTask(e.db, { taskId: id, decision: "accept" }), 409, /did not finish/);
  // The mark is closed again with the re-run, and a new one can be asked for.
  assert.throws(() => moveTask(e.db, id, "awaiting_decision", { checks: "failed" }), /what the checks found is recorded once for each version/);
  e.checks = [cmd("test -f hello.txt")];
  await e.tasks.runChecksAgain(id);
  await e.tasks.idle();
  assert.equal((await evidenceState(e.db, getTask(e.db, id)!)).state, "current");
});
