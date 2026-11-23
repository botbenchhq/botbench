import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { taskDecision } from "../../src/engine/decision.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { createRun, createRuns, getRun, RunError, runTasks, storePlan, type Run, type Runs } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type BuildReplay, type BuildTurn } from "../support/replay-build.ts";
import { loadPlanRecording, NO_TASKS, planReplayDriver, THREE_TASKS, type PlanReplay } from "../support/replay-plan.ts";
import { reviewReplayDriver } from "../support/replay-review.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// The three modes through the engine, with real SQLite, a real temporary repository, real setup and check commands and
// the real permission broker. No CLI is started: planners, builders and reviewers are sessions recorded from the real
// CLIs and replayed (test/support/replay-*.ts); each recorded tool call is put to the real gate as its hook put it.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
const ONE = [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }];

interface Line {
  db: DatabaseSync;
  repo: string;
  base: string;
  broker: Broker;
  builder: BuildReplay;
  tasks: Tasks;
  runs: Runs;
  planner: PlanReplay;
}

async function line(t: T, script: readonly BuildTurn[], o: { checks?: StationCommand[]; reviewer?: boolean; hold?: readonly number[]; planner?: readonly number[]; setup?: string; protectedPaths?: string[] } = {}): Promise<Line> {
  const dir = tempDir("botbench-modes-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(script, o.hold === undefined ? {} : { hold: o.hold });
  const reviewers = o.reviewer ? { codex: reviewReplayDriver("review") } : {};
  const checks = o.checks ?? [cmd("test -f hello.txt")];
  const repoCommands = () => ({ setup: [cmd(o.setup ?? "printf 'hi\\n' > hello.txt")], checks });
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", reviewers, repoCommands, ...(o.protectedPaths ? { protectedPaths: () => o.protectedPaths! } : {}), onEvent: () => {}, onTaskChange: () => {} });
  // The planner is a replayed real planner session that gave a plan of three tasks (or the turns the test names).
  const planner = planReplayDriver(loadPlanRecording(), o.planner ?? [THREE_TASKS]);
  const runs = createRuns({ db, home, driver: planner, broker, model: "haiku", implementerModel: "haiku", reviewers, line: tasks, repoCommands, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, repo, base, broker, builder, tasks, runs, planner };
}

/** A run of one task in `mode`, its plan stored without a planner, approved the way its mode approves it. */
async function oneTask(e: Line, mode: RunMode, reviewer = false): Promise<number> {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, mode, reviewer: reviewer ? { agent: "codex", model: null } : null });
  const stored: Run = storePlan(e.db, run.id, ONE);
  const { tasks } = e.runs.approve(stored.id, stored.planVersion);
  await e.tasks.idle();
  return tasks[0]!.id;
}

test("semi-autonomous: a builder's command runs confined without asking, the task reaches Ready for review with no approval, and the command is in the log under the mode's rule", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["ask"]);
  const id = await oneTask(e, "semi");
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(listApprovals(e.db).length, 0, "nothing was put to the owner");
  const log = actionLog(e.db, id);
  const ran = log.filter((entry) => entry.rule === "mode_allowed");
  assert.deepEqual(ran.map(({ tool, command, cwd }) => ({ tool, command, cwd })), [{ tool: "Bash", command: "sh other.sh", cwd: "." }]);
  assert.match(ran[0]!.detail!, /semi-autonomous/);
  assert.ok(!log.some((entry) => entry.rule === "asked_owner"));
  // The owner still decides: no decision was made for them.
  assert.equal(taskDecision(e.db, id), null);
  assert.equal(task.reason, null);
});

test("manual: the same command asks the owner, as it always did", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["ask"]);
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, mode: "manual" });
  const stored = storePlan(e.db, run.id, ONE);
  e.runs.approve(stored.id, stored.planVersion);
  for (let i = 0; i < 200 && listApprovals(e.db, "pending").length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const pending = listApprovals(e.db, "pending");
  assert.deepEqual(pending.map((a) => a.command), ["sh other.sh"]);
  e.broker.answer(pending[0]!.id, "allow");
  await e.tasks.idle();
  assert.ok(!actionLog(e.db).some((entry) => entry.rule === "mode_allowed"));
});

test("fully autonomous: building starts without the owner approving the plan, and each task whose checks pass is accepted without the owner, keeping its branch", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "done", "done"]);
  // Not kept to one task, which a fully autonomous run is unless the owner says otherwise.
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files and describe them", mode: "full", oneTask: false });
  assert.equal(run.mode, "full");
  await e.runs.idle();
  await e.tasks.idle();
  const events = e.db.prepare("SELECT status, detail FROM run_events WHERE run_id = ? ORDER BY id").all(run.id).map((row) => `${String(row.status)}: ${String(row.detail)}`);
  assert.ok(events.some((line) => /^running: plan approved by the run's mode, fully autonomous: 3 tasks queued$/.test(line)), events.join("\n"));
  const tasks = runTasks(e.db, run.id);
  assert.equal(tasks.length, 3);
  for (const task of tasks) {
    assert.equal(task.status, "accepted", task.reason ?? "");
    const decision = taskDecision(e.db, task.id)!;
    assert.equal(decision.decidedBy, "mode");
    assert.equal(decision.branch, "kept");
    assert.equal(decision.reasons, "Accepted without you, as this run is fully autonomous: every check passed, this run has no reviewer, and nothing an agent asked for was refused.");
    assert.equal(git(e.repo, "rev-parse", "--verify", `refs/heads/${task.branch!}`).trim(), task.headCommit, "the branch is kept, on Botbench's commit");
    assert.ok(!fs.existsSync(task.worktreePath!), "the copy is removed, as the owner's Accept removes it");
    const accepted = actionLog(e.db, task.id).filter((entry) => entry.rule === "mode_accepted");
    assert.equal(accepted.length, 1);
    assert.match(accepted[0]!.detail!, /^Accepted without you, .* Kept the branch .* Nothing was merged or pushed\.$/);
  }
  assert.equal(getRun(e.db, run.id)!.status, "done");
  assert.equal(listApprovals(e.db).length, 0);
});

test("fully autonomous: a task whose check failed is not accepted, and says why it needs the owner", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { checks: [cmd("test -f hello.txt"), cmd("false")] });
  const id = await oneTask(e, "full");
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision");
  assert.equal(task.checks, "failed");
  assert.equal(task.reason, "It needs your review: A check failed.");
  assert.equal(taskDecision(e.db, id), null);
});

test("fully autonomous: a task whose reviewer raised concerns is not accepted, and says why", { skip: NO_SANDBOX }, async (t) => {
  // Changed with the refine loop: the builder is given the review once (its replayed round changes nothing), and the
  // loop ends unresolved.
  const e = await line(t, ["done", "done"], { reviewer: true });
  const id = await oneTask(e, "full", true);
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision");
  assert.equal(task.checks, "passed");
  assert.equal(task.reason, "It needs your review: The reviewer raised concerns.");
  assert.equal(taskDecision(e.db, id), null);
});

test("fully autonomous: a dangerous command is refused without asking anyone, the agent is told why, and the task is not accepted", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["refused"]);
  const id = await oneTask(e, "full");
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(listApprovals(e.db).length, 0, "nobody was asked");
  const refused = actionLog(e.db, id).filter((entry) => entry.rule === "mode_refused");
  assert.deepEqual(refused.map((entry) => [entry.command, entry.detail]), [["git push origin HEAD", "This run is fully autonomous, so Botbench refuses what its safety rules would otherwise ask you about (git-push). It was not run."]]);
  // What the agent was told is the refusal, in the driver's answer to its request.
  const told = e.db.prepare("SELECT payload FROM events WHERE type = 'permission_resolved'").all().map((row) => JSON.parse(String(row.payload)));
  assert.deepEqual(told.map((event) => event.decision), ["denied"]);
  assert.equal(task.reason, "It needs your review: Botbench refused something an agent asked to do during this task (git push origin HEAD).");
  assert.equal(taskDecision(e.db, id), null);
  // It is on the safety floor, so it still blocks the accept.
  assert.deepEqual(refused.map((entry) => entry.refusal), ["floor"]);
});

/**
 * A run of one task in `mode` whose builder's replayed turn is held at its start, while the test puts `requests` to the
 * real broker as that attempt's CLI would put them when its hook never reported the call (so the request cannot be
 * tied to a checked call, the one way a confined command is still refused). Then the turn goes on and the task ends.
 */
async function heldTask(e: Line, requests: readonly { command: string; input: Record<string, unknown> }[]): Promise<number> {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, mode: "full" });
  const stored = storePlan(e.db, run.id, ONE);
  const id = e.runs.approve(stored.id, stored.planVersion).tasks[0]!.id;
  await e.builder.held(0);
  const attemptId = Number(e.db.prepare("SELECT MAX(id) AS id FROM attempts").get()!.id);
  for (const [i, r] of requests.entries()) {
    const answer = await e.broker.request({ taskId: id, attemptId, role: "implementer", tool: "Bash", command: r.command, input: r.input, reason: null, toolCallId: `toolu_unreported_${i}` });
    assert.equal(answer.decision, "decline", r.command);
    assert.notEqual(answer.refused, null, r.command);
  }
  e.builder.release(0);
  await e.tasks.idle();
  return id;
}

test("fully autonomous: a harmless refused command no longer blocks the accept; it is still recorded, in words, and named in the accept's reasons", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { hold: [0] });
  const id = await heldTask(e, [{ command: "ls src", input: { command: "ls src", description: "List the sources" } }]);
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "accepted", task.reason ?? "");
  assert.equal(listApprovals(e.db).length, 0, "nobody was asked");
  const refused = actionLog(e.db, id).filter((entry) => entry.rule === "mode_refused");
  assert.deepEqual(refused.map((entry) => [entry.command, entry.refusal]), [["ls src", "read_only"]]);
  // Activity shows the entry with this line under "Refused without asking: fully autonomous".
  assert.match(refused[0]!.detail!, / It only reads files in the task's copy, so it does not stop the task being accepted\.$/);
  const decision = taskDecision(e.db, id)!;
  assert.equal(decision.decidedBy, "mode");
  assert.equal(decision.reasons, "Accepted without you, as this run is fully autonomous: every check passed, this run has no reviewer, and what Botbench refused (ls src) was not on the always-ask list and would not have reached outside the task's copy.");
});

test("fully autonomous: beside a harmless refusal, an unconfined one still blocks the accept and is the one named", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { hold: [0] });
  const id = await heldTask(e, [
    { command: "ls src", input: { command: "ls src" } },
    { command: "npm test", input: { command: "npm test" } },
  ]);
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision");
  assert.deepEqual(actionLog(e.db, id).filter((entry) => entry.rule === "mode_refused").map((entry) => entry.refusal), ["read_only", "unconfined"]);
  assert.equal(task.reason, "It needs your review: Botbench refused something an agent asked to do during this task (npm test).");
  assert.equal(taskDecision(e.db, id), null);
});

test("fully autonomous is refused at the start, with the reason, on a repository with no checks; nothing is stored", async (t) => {
  const e = await line(t, [], { checks: [] });
  await assert.rejects(e.runs.start({ repo: e.repo, prompt: "Add a file", mode: "full" }), (err: unknown) => {
    assert.ok(err instanceof RunError);
    assert.equal(err.status, 400);
    assert.match(err.message, /^This repository has no checks set up, so a run on it cannot be fully autonomous: without checks, "fully autonomous" would mean agents agreeing with each other\./);
    return true;
  });
  assert.equal(e.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
  // Semi-autonomous needs no checks.
  const semi = await e.runs.start({ repo: e.repo, prompt: "Add a file", mode: "semi" });
  assert.equal(semi.mode, "semi");
});

test("a mode that is none of the three is refused, and a run's mode cannot be changed once it exists", async (t) => {
  const e = await line(t, []);
  await assert.rejects(e.runs.start({ repo: e.repo, prompt: "Add a file", mode: "yolo" }), /"mode" must be "manual", "semi" or "full"/);
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, mode: "semi" });
  assert.throws(() => e.db.prepare("UPDATE runs SET mode = 'full' WHERE id = ?").run(run.id), /a run's mode is chosen when it starts and never changed/);
  assert.equal(getRun(e.db, run.id)!.mode, "semi");
  // Left out, a run is manual unless the owner chose another default.
  assert.equal(createRun(e.db, { repo: e.repo, prompt: "Another", baseCommit: e.base }).mode, "manual");
});

// The replayed builder writes no file, so the setup command writes the work, as above: what it writes is committed as
// the task's work, from the task's start commit to its head commit, and marked from there (src/engine/scope.ts).
const PROTECTED_WORK = "printf 'hi\\n' > hello.txt && mkdir -p test/recordings && printf '{}\\n' > test/recordings/played.json";

for (const mode of ["manual", "semi", "full"] as const) {
  test(`${mode}: a build that changed a file under a protected path is handed to the owner, naming the file, and never accepted by the mode`, { skip: NO_SANDBOX }, async (t) => {
    const e = await line(t, ["done"], { setup: PROTECTED_WORK, protectedPaths: ["test/recordings/"] });
    const id = await oneTask(e, mode);
    const task = getTask(e.db, id)!;
    assert.equal(task.status, "awaiting_decision", task.reason ?? "");
    assert.equal(task.checks, "passed", "everything else would have let a fully autonomous run accept it");
    assert.equal(task.reason, "It needs your review: It changed 1 file under a protected path, which only you can accept: test/recordings/played.json.");
    assert.equal(taskDecision(e.db, id), null, "nothing was decided for the owner");
    assert.ok(!actionLog(e.db, id).some((entry) => entry.rule === "mode_accepted"));
    assert.ok(fs.existsSync(task.worktreePath!), "the task's copy is kept for the owner's decision");
  });
}

test("fully autonomous: a task that changed a file the plan did not lead one to expect is handed to the owner, naming the file", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { setup: "printf 'hi\\n' > hello.txt && printf 'x\\n' > notes.txt" });
  const id = await oneTask(e, "full");
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.checks, "passed");
  assert.equal(task.reason, "It needs your review: It changed 1 file not expected from the plan: notes.txt.");
  assert.equal(taskDecision(e.db, id), null);
  assert.ok(!actionLog(e.db, id).some((entry) => entry.rule === "mode_accepted"));
});

test("fully autonomous: a build that changed only expected files, none of them protected, is still accepted without the owner", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { protectedPaths: ["test/recordings/"] });
  const id = await oneTask(e, "full");
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "accepted", task.reason ?? "");
  assert.equal(taskDecision(e.db, id)!.decidedBy, "mode");
});

test("only a fully autonomous run's task, whose checks passed, can be decided by the mode: the store refuses any other", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"]);
  const id = await oneTask(e, "semi");
  assert.equal(getTask(e.db, id)!.status, "awaiting_decision");
  assert.throws(
    () => e.db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, reasons) VALUES (?, 'mode', 'accept', 'kept', 'b', NULL, '[]', 'now', 'r')").run(id),
    /only a fully autonomous run decides without the owner/,
  );
});

// Keep it to one task. The planner is the replayed real planner session; its turn of three tasks stands for a planner
// that planned several when asked for one.
const MERGED = {
  title: "Add a greeting file; Add a farewell file; Describe both files in the README",
  criteria: ["hello.txt exists at the top of the repository", "hello.txt holds the single line hi", "bye.txt exists at the top of the repository", "README.md names hello.txt", "README.md names bye.txt"],
};

test("kept to one task, fully autonomous by default: the planner is told one task, a plan of three is sent back once, still three is merged by Botbench, and that one task is built and accepted", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { planner: [THREE_TASKS, THREE_TASKS] });
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files and describe them", mode: "full" });
  assert.equal(run.oneTask, true, "on by default in fully autonomous");
  await e.runs.idle();
  await e.tasks.idle();
  // Told one task, then sent back once with the plan's count, and nothing more.
  assert.equal(e.planner.prompts.length, 2);
  assert.match(e.planner.prompts[0]!, /- Exactly 1 task: the owner chose to keep this run to one task/);
  assert.doesNotMatch(e.planner.prompts[0]!, /Between 1 and 20 tasks/);
  assert.match(e.planner.prompts[1]!, /^Botbench could not accept that plan: the owner chose to keep this run to one task, and the plan holds 3 tasks\./);
  // Merged: the titles joined in order, the criteria one after another; one task built from it.
  const tasks = runTasks(e.db, run.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.prompt, `${MERGED.title}\n\nAcceptance criteria:\n${MERGED.criteria.map((c) => `- ${c}`).join("\n")}`);
  assert.equal(e.builder.prompts.length, 1, "one build");
  assert.equal(tasks[0]!.status, "accepted", tasks[0]!.reason ?? "");
  const events = e.db.prepare("SELECT detail FROM run_events WHERE run_id = ? ORDER BY id").all(run.id).map((row) => String(row.detail));
  assert.ok(events.includes("plan of 1 task; This run is kept to one task. Claude Code planned 3 tasks even when asked again for one, so Botbench joined them into one task: their titles in order, and all of their criteria."), events.join("\n"));
});

test("kept to one task in a manual run: a send-back answered with no plan merges the plan of three, which waits for the owner as one task with the reason", async (t) => {
  const e = await line(t, [], { planner: [THREE_TASKS, NO_TASKS] });
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files and describe them", mode: "manual", oneTask: true });
  await e.runs.idle();
  assert.equal(e.planner.prompts.length, 2, "sent back once");
  const waiting = getRun(e.db, run.id)!;
  assert.equal(waiting.status, "awaiting_plan_approval");
  assert.match(waiting.reason ?? "", /^This run is kept to one task\. Claude Code planned 3 tasks even when asked again for one, so Botbench joined them/);
  const plan = e.db.prepare("SELECT title, criteria FROM plan_tasks WHERE run_id = ?").all(run.id).map((row) => ({ title: String(row.title), criteria: JSON.parse(String(row.criteria)) }));
  assert.deepEqual(plan, [MERGED]);
  // The owner cannot make it several again: the edit is refused and the plan is as it was.
  assert.throws(() => e.runs.editPlan(run.id, [MERGED, { title: "Another", criteria: ["It exists"] }], waiting.planVersion), (err: unknown) => err instanceof RunError && err.status === 400 && err.message === "This run is kept to one task, so its plan holds exactly 1 task; this one holds 2 tasks. Put the work in one task.");
  assert.equal(Number(e.db.prepare("SELECT COUNT(*) AS n FROM plan_tasks WHERE run_id = ?").get(run.id)!.n), 1);
});

test("not kept to one task: a manual run takes the plan of three as it is, and its planner was told it may plan up to 20", async (t) => {
  const e = await line(t, [], { planner: [THREE_TASKS] });
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files and describe them", mode: "manual" });
  assert.equal(run.oneTask, false, "off by default outside fully autonomous");
  await e.runs.idle();
  assert.equal(e.planner.prompts.length, 1);
  assert.match(e.planner.prompts[0]!, /Between 1 and 20 tasks/);
  assert.equal(Number(e.db.prepare("SELECT COUNT(*) AS n FROM plan_tasks WHERE run_id = ?").get(run.id)!.n), 3);
  // Chosen when the run starts and never changed.
  assert.throws(() => e.db.prepare("UPDATE runs SET one_task = 1 WHERE id = ?").run(run.id), /chosen when it starts and never changed/);
  await assert.rejects(e.runs.start({ repo: e.repo, prompt: "Add a file", oneTask: "yes" }), /"oneTask" must be true \(keep the run to one task\) or false\./);
});
