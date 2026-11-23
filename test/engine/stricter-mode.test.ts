import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { parseIssueView } from "../../src/github.ts";
import { capIssue, storeIssue } from "../../src/engine/intake.ts";
import { actionLog, createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { taskDecision } from "../../src/engine/decision.ts";
import { modeChanges, planApprovedByMode, RUN_MODES, setAskEveryCommand, stricterModes, type RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, createRuns, getRun, RunError, storePlan, tightenMode, type RunStatus, type Runs } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type AttemptScript, type BuildReplay } from "../support/replay-build.ts";
import { ISSUE_NUMBER, ISSUE_REPO, loadIssueCapture } from "../support/replay-issue.ts";
import { loadPlanRecording, planReplayDriver, THREE_TASKS } from "../support/replay-plan.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// The owner makes a run's mode stricter while it works, never looser: the store's rule, the engine's change and its
// record in the run's history, and what the next request and the next result then meet. Real SQLite, a real temporary
// repository, real setup and check commands and the real permission broker; planners and builders are sessions recorded
// from the real CLIs and replayed (test/support/replay-*.ts), each recorded tool call put to the real gate.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
const ONE = [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }];
const STATUSES: readonly RunStatus[] = ["planning", "awaiting_plan_approval", "running", "awaiting_decision", "done", "cancelled", "failed"];
const FINISHED: ReadonlySet<RunStatus> = new Set(["done", "cancelled", "failed"]);
/** Each mode and the stricter ones it may become (the modes go from strictest to loosest in RUN_MODES). */
const STRICTER = (from: RunMode, to: RunMode): boolean => RUN_MODES.indexOf(to) < RUN_MODES.indexOf(from);

interface Line {
  db: DatabaseSync;
  repo: string;
  base: string;
  broker: Broker;
  builder: BuildReplay;
  tasks: Tasks;
  runs: Runs;
  /** Lets the held planner turn go on (when `holdPlanner`). */
  releasePlanner: () => void;
}

async function line(t: T, script: readonly AttemptScript[], o: { hold?: readonly number[]; holdPlanner?: boolean } = {}): Promise<Line> {
  const dir = tempDir("botbench-stricter-mode-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(script, o.hold === undefined ? {} : { hold: o.hold });
  const repoCommands = () => ({ setup: [cmd("printf 'hi\\n' > hello.txt")], checks: [cmd("test -f hello.txt")] });
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", checkFixRounds: 0, repoCommands, onEvent: () => {}, onTaskChange: () => {} });
  let releasePlanner = (): void => {};
  const held = new Promise<void>((resolve) => (releasePlanner = resolve));
  const planner = planReplayDriver(loadPlanRecording(), [THREE_TASKS], o.holdPlanner === true ? () => held : undefined);
  const runs = createRuns({ db, home, driver: planner, broker, model: "haiku", implementerModel: "haiku", line: tasks, repoCommands, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    releasePlanner();
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, repo, base, broker, builder, tasks, runs, releasePlanner };
}

/** A run in `mode` at `status`, put in the store as the engine stores one, with no planner or builder started. */
function runAt(db: DatabaseSync, repo: string, base: string, mode: RunMode, status: RunStatus): number {
  const run = createRun(db, { repo, prompt: "Add a file", baseCommit: base, mode });
  if (status !== "planning") db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, run.id);
  return run.id;
}

const events = (db: DatabaseSync, runId: number) => db.prepare("SELECT status, detail, actor, mode_from, mode_to FROM run_events WHERE run_id = ? ORDER BY id").all(runId).map((row) => ({ ...row }));

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the store lets a run's mode change only to a stricter one, full to semi or manual and semi to manual, and only while the run has not finished", (t) => {
  const dir = tempDir("botbench-stricter-mode-store-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  for (const from of RUN_MODES)
    for (const to of RUN_MODES)
      for (const status of STATUSES) {
        const id = runAt(db, repo, base, from, status);
        const change = () => db.prepare("UPDATE runs SET mode = ? WHERE id = ?").run(to, id);
        const what = `${from} to ${to}, ${status}`;
        if (STRICTER(from, to) && !FINISHED.has(status)) {
          change();
          assert.equal(getRun(db, id)!.mode, to, what);
        } else {
          // The same mode, any looser one (manual to semi or full, semi to full), and any change of a finished run.
          assert.throws(change, /a run's mode can only be made stricter, and only while the run has not finished/, what);
          assert.equal(getRun(db, id)!.mode, from, what);
        }
      }
  // The run of one that a task started on its own has no state of its own and stays manual.
  const single = Number(db.prepare("INSERT INTO runs (kind, repo_path, prompt, created_at, updated_at) VALUES ('single', ?, 'x', 'now', 'now')").run(repo).lastInsertRowid);
  for (const to of RUN_MODES) assert.throws(() => db.prepare("UPDATE runs SET mode = ? WHERE id = ?").run(to, single), /only be made stricter/);
  // A change of mode in the history is the owner's, and names the mode the run has now.
  const id = runAt(db, repo, base, "full", "running");
  const record = db.prepare("INSERT INTO run_events (run_id, ts, status, detail, actor, mode_from, mode_to) VALUES (?, 'now', 'running', 'x', ?, ?, ?)");
  assert.throws(() => record.run(id, null, "full", "manual"), /a change of mode is recorded as the owner's/);
  assert.throws(() => record.run(id, "owner", "full", "manual"), /a change of mode is recorded as the owner's/, "the run is still fully autonomous");
  assert.throws(() => record.run(id, "owner", "full", null), /a change of mode is recorded as the owner's/);
  assert.throws(() => record.run(id, "someone", null, null), /CHECK constraint failed/);
});

test("the owner makes a run stricter: its mode changes, and its history gains the owner's change naming both modes in words; nothing else is touched", (t) => {
  const dir = tempDir("botbench-stricter-mode-engine-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const id = runAt(db, repo, base, "full", "running");
  const before = getRun(db, id)!;
  const semi = tightenMode(db, id, "semi");
  assert.equal(semi.mode, "semi");
  const manual = tightenMode(db, id, "manual");
  assert.equal(manual.mode, "manual");
  assert.deepEqual({ ...manual, mode: before.mode, updatedAt: before.updatedAt }, before, "only the mode and when the run changed are different");
  assert.deepEqual(events(db, id).slice(-2), [
    { status: "running", detail: "mode changed by the owner from fully autonomous to semi-autonomous", actor: "owner", mode_from: "full", mode_to: "semi" },
    { status: "running", detail: "mode changed by the owner from semi-autonomous to manual", actor: "owner", mode_from: "semi", mode_to: "manual" },
  ]);
  // What the run screen shows of it: each change, oldest first, in the owner's words.
  assert.deepEqual(modeChanges(db, id).map(({ from, to, words }) => ({ from, to, words })), [
    { from: "full", to: "semi", words: "You changed the mode from fully autonomous to semi-autonomous." },
    { from: "semi", to: "manual", words: "You changed the mode from semi-autonomous to manual." },
  ]);
  assert.ok(modeChanges(db, id).every((change) => typeof change.at === "string" && change.at !== ""));
});

test("a looser or the same mode, a mode that is none of the three, a finished run and a run that does not exist are each refused in words, and nothing is written", (t) => {
  const dir = tempDir("botbench-stricter-mode-refused-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const written = () => Number(db.prepare("SELECT count(*) AS n FROM run_events").get()!.n);
  /** `change` is refused with `status` and `words`, and writes nothing. */
  const refused = (change: () => unknown, status: number, words: string): void => {
    const before = written();
    assert.throws(change, (err: unknown): boolean => {
      assert.ok(err instanceof RunError, String(err));
      assert.deepEqual([err.status, err.message], [status, words]);
      return true;
    });
    assert.equal(written(), before, words);
  };
  const semi = runAt(db, repo, base, "semi", "running");
  const manual = runAt(db, repo, base, "manual", "awaiting_plan_approval");
  refused(() => tightenMode(db, semi, "full"), 409, `Run ${semi} is semi-autonomous. A run's mode can be made stricter while it works, never looser, so it cannot become fully autonomous.`);
  refused(() => tightenMode(db, semi, "semi"), 409, `Run ${semi} is already semi-autonomous.`);
  refused(() => tightenMode(db, manual, "semi"), 409, `Run ${manual} is manual. A run's mode can be made stricter while it works, never looser, so it cannot become semi-autonomous.`);
  refused(() => tightenMode(db, manual, "manual"), 409, `Run ${manual} is already manual.`);
  for (const bad of ["yolo", null, undefined, 3, "Manual"]) refused(() => tightenMode(db, semi, bad), 400, '"mode" must be "manual", "semi" or "full".');
  for (const status of ["done", "cancelled", "failed"] as const) {
    const ended = runAt(db, repo, base, "full", status);
    refused(() => tightenMode(db, ended, "manual"), 409, `Run ${ended} has finished, so its mode can no longer be changed.`);
  }
  refused(() => tightenMode(db, 9999, "manual"), 404, "No such run.");
  assert.equal(getRun(db, semi)!.mode, "semi");
  assert.equal(getRun(db, manual)!.mode, "manual");
});

test("the run screen is offered only the stricter modes: semi and manual for fully autonomous, manual for semi-autonomous, none for manual or a finished run", () => {
  assert.deepEqual(stricterModes("full", "running"), ["semi", "manual"]);
  assert.deepEqual(stricterModes("semi", "planning"), ["manual"]);
  assert.deepEqual(stricterModes("semi", "awaiting_decision"), ["manual"]);
  assert.deepEqual(stricterModes("manual", "running"), []);
  for (const status of ["done", "cancelled", "failed"] as const) for (const mode of RUN_MODES) assert.deepEqual(stricterModes(mode, status), [], `${mode} ${status}`);
});

test("made manual while it plans, a semi-autonomous run's plan waits for the owner's approval", async (t) => {
  const e = await line(t, [], { holdPlanner: true });
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files and describe them", mode: "semi" });
  assert.equal(e.runs.tightenMode(run.id, "manual").mode, "manual");
  e.releasePlanner();
  await e.runs.idle();
  const after = getRun(e.db, run.id)!;
  assert.equal(after.status, "awaiting_plan_approval", "the plan waits for the owner, as a manual run's does");
  assert.ok(!events(e.db, run.id).some((row) => /approved by the run's mode/.test(String(row.detail))));
  assert.deepEqual(modeChanges(e.db, run.id).map((change) => change.words), ["You changed the mode from semi-autonomous to manual."]);
});

test("a run started from a GitHub issue keeps its rules when made stricter: it stays marked as having read outside text, its plan waits for the owner, and it never becomes fully autonomous", (t) => {
  const dir = tempDir("botbench-stricter-mode-issue-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const view = parseIssueView(loadIssueCapture().outputs.issue.result.stdout, ISSUE_REPO, ISSUE_NUMBER);
  const issue = storeIssue(db, fs.realpathSync(repo), capIssue(view, "github.com/cli/cli"));
  const run = createRun(db, { repo, baseCommit: base, issue: { fetchId: issue.id, allowHosts: false }, mode: "semi" });
  const stored = storePlan(db, run.id, ONE);
  const manual = tightenMode(db, run.id, "manual");
  assert.equal(manual.outsideText, true);
  assert.equal(planApprovedByMode(manual), false);
  assert.throws(() => approvePlan(db, run.id, stored.planVersion, null, "mode"), /so its plan waits for your approval/);
  assert.throws(() => tightenMode(db, run.id, "full"), /never looser/);
  assert.throws(() => db.prepare("UPDATE runs SET mode = 'full' WHERE id = ?").run(run.id), /only be made stricter/);
  assert.equal(getRun(db, run.id)!.status, "awaiting_plan_approval");
});

/** A fully autonomous run of one task, approved by its mode, whose builder's turn is held at its start. */
async function heldFullTask(e: Line): Promise<{ runId: number; taskId: number }> {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, mode: "full" });
  const stored = storePlan(e.db, run.id, ONE);
  const taskId = e.runs.approve(stored.id, stored.planVersion).tasks[0]!.id;
  await e.builder.held(0);
  return { runId: run.id, taskId };
}

test("fully autonomous, unchanged: the confined command runs without asking, even with Ask before every command on, and the task whose check passed is accepted without the owner", { skip: NO_SANDBOX }, async (t) => {
  // The control for the next test: the same run, the same recorded turn, the same settings, and no change of mode.
  const e = await line(t, ["ask"], { hold: [0] });
  setAskEveryCommand(e.db, true);
  const { taskId } = await heldFullTask(e);
  e.builder.release(0);
  await e.tasks.idle();
  assert.equal(listApprovals(e.db).length, 0, "nobody was asked");
  assert.deepEqual(actionLog(e.db, taskId).filter((entry) => entry.rule === "mode_allowed").map((entry) => entry.command), ["sh other.sh"]);
  assert.equal(getTask(e.db, taskId)!.status, "accepted", getTask(e.db, taskId)!.reason ?? "");
  assert.equal(taskDecision(e.db, taskId)!.decidedBy, "mode");
});

test("made manual while its builder works, a fully autonomous run's next confined command waits for the owner, the turn under way finishes, and the task the mode would have accepted is handed to the owner", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["ask"], { hold: [0] });
  setAskEveryCommand(e.db, true);
  const { runId, taskId } = await heldFullTask(e);
  // The builder's turn is under way (its prompt sent) when the owner makes the run manual.
  assert.equal(getTask(e.db, taskId)!.status, "building");
  assert.equal(e.runs.tightenMode(runId, "manual").mode, "manual");
  e.builder.release(0);
  await until("the builder's command waits for the owner", () => listApprovals(e.db, "pending").length > 0);
  const pending = listApprovals(e.db, "pending");
  assert.deepEqual(pending.map((a) => [a.taskId, a.command, a.asksBecause]), [[taskId, "sh other.sh", "Ask before every command is on in Settings."]]);
  assert.ok(!actionLog(e.db, taskId).some((entry) => entry.rule === "mode_allowed"), "it did not run on the old mode");
  e.broker.answer(pending[0]!.id, "allow");
  await e.tasks.idle();
  // The turn that was under way was not stopped: it ran to its end.
  const task = getTask(e.db, taskId)!;
  assert.equal(e.builder.started.length, 1, "one attempt: the turn was neither stopped nor started again");
  assert.equal(e.db.prepare("SELECT status FROM attempts WHERE id = ?").get(task.attemptId)?.status, "ended");
  const ends = e.db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'turn_ended'").all(task.attemptId).map((row) => (JSON.parse(String(row.payload)) as { reason: string }).reason);
  assert.deepEqual(ends, ["completed"]);
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.checks, "passed", "everything else would have let the fully autonomous run accept it");
  assert.equal(taskDecision(e.db, taskId), null, "the owner decides");
  assert.ok(!actionLog(e.db, taskId).some((entry) => entry.rule === "mode_accepted"));
  assert.equal(getRun(e.db, runId)!.status, "awaiting_decision");
});

test("a request already waiting for the owner stays for them when the run is made stricter, and the safety rules still ask about it", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["refused"]);
  const run = createRun(e.db, { repo: e.repo, prompt: "Push it", baseCommit: e.base, mode: "semi" });
  const stored = storePlan(e.db, run.id, ONE);
  const taskId = e.runs.approve(stored.id, stored.planVersion).tasks[0]!.id;
  await until("the push asks the owner", () => listApprovals(e.db, "pending").length > 0);
  const [asked] = listApprovals(e.db, "pending");
  assert.deepEqual([asked!.taskId, asked!.command, asked!.asksBecause], [taskId, "git push origin HEAD", "On the always-ask list: it sends commits to another computer."]);
  e.runs.tightenMode(run.id, "manual");
  assert.deepEqual(listApprovals(e.db, "pending").map((a) => [a.id, a.status]), [[asked!.id, "pending"]], "the same card, still waiting");
  assert.equal(getTask(e.db, taskId)!.status, "building");
  e.broker.answer(asked!.id, "decline");
  await e.tasks.idle();
  assert.equal(getTask(e.db, taskId)!.status, "awaiting_decision", getTask(e.db, taskId)!.reason ?? "");
  assert.deepEqual(listApprovals(e.db).map((a) => a.status), ["declined"]);
});
