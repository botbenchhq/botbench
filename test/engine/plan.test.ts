import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { listStanding, runGrants, standingGrants } from "../../src/approvals/grants.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { MAX_CRITERIA, MAX_CRITERION, MAX_PLAN_TASKS, MAX_TITLE, parsePlan, plannerPrompt, validatePlan, type PlanTask } from "../../src/engine/roles.ts";
import { approvePlan, cancelRun, createRun, createRuns, editPlan, getRun, listRuns, MAX_SPEC_BYTES, planTasks, readSpec, RunError, runTasks, storePlan, type Run, type Runs } from "../../src/engine/run.ts";
import { createTask, createTasks, getTask } from "../../src/engine/task.ts";
import { DB_FILE, openStore, schemaVersion } from "../../src/store/db.ts";
import { EMPTY_TASK, loadPlanRecording, NO_TASKS, planReplayDriver, THREE_TASKS, type PlanReplay } from "../support/replay-plan.ts";
import { checkoutState, initRepo, tempDir, worktreeCount } from "../support/repo.ts";
import { V8_SCHEMA } from "../support/schema-v8.ts";

// No test in this file starts a CLI. Where a planner session is needed, turns recorded from a real one are replayed
// (test/support/replay-plan.ts); a planner on the real Claude Code is in test/live/plan.live.test.ts.

type T = { after(fn: () => unknown): void };

function store(t: T): { db: DatabaseSync; dir: string; home: string; repo: string; base: string } {
  const dir = tempDir("smelt-plan-test-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  return { db, dir, home, repo, base };
}

const THREE: PlanTask[] = [
  { title: "Add a greeting file", criteria: ["hello.txt exists", "It holds hi"] },
  { title: "Add a farewell file", criteria: ["bye.txt exists"] },
  { title: "Describe both files", criteria: ["README.md names both"] },
];
const runEvents = (db: DatabaseSync, id: number) => db.prepare("SELECT status, detail FROM run_events WHERE run_id = ? ORDER BY id").all(id).map((r) => ({ ...r }));
const refused = (status: number, words: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof RunError, `a RunError, not ${String(err)}`);
  assert.equal(err.status, status);
  assert.match(err.message, words);
  return true;
};
/** Everything under the Smelt home where a worktree could be. */
const worktreeDirs = (home: string): string[] => (fs.existsSync(path.join(home, "worktrees")) ? fs.readdirSync(path.join(home, "worktrees"), { recursive: true }).map(String) : []);

/** A run waiting for the owner with `tasks` as its plan, made without any planner. */
function planned(db: DatabaseSync, repo: string, base: string, tasks: PlanTask[] = THREE): Run {
  const run = createRun(db, { repo, prompt: "Add two files and describe them", baseCommit: base });
  assert.equal(run.status, "planning");
  return storePlan(db, run.id, tasks);
}

test("a plan is accepted only as 1 to 20 tasks, each with a title and 1 to 10 criteria, within the length limits", () => {
  assert.deepEqual(validatePlan({ tasks: THREE }), { ok: true, tasks: THREE });
  // Surrounding blanks go; what is stored is what was meant.
  assert.deepEqual(validatePlan({ tasks: [{ title: "  One  ", criteria: [" a "] }] }), { ok: true, tasks: [{ title: "One", criteria: ["a"] }] });
  const task = { title: "t", criteria: ["c"] };
  const bad: [unknown, RegExp][] = [
    [null, /object/],
    ["tasks", /object/],
    [{}, /"tasks"/],
    [{ tasks: "x" }, /"tasks"/],
    [{ tasks: [] }, /at least 1 task/],
    [{ tasks: Array.from({ length: MAX_PLAN_TASKS + 1 }, () => task) }, new RegExp(`at most ${MAX_PLAN_TASKS} tasks`)],
    [{ tasks: [{ title: "", criteria: ["c"] }] }, /Task 1.*title/],
    [{ tasks: [task, { title: "   ", criteria: ["c"] }] }, /Task 2.*title/],
    [{ tasks: [{ title: 5, criteria: ["c"] }] }, /Task 1.*title/],
    [{ tasks: [{ title: "two\nlines", criteria: ["c"] }] }, /Task 1.*one line/],
    [{ tasks: [{ title: "x".repeat(MAX_TITLE + 1), criteria: ["c"] }] }, new RegExp(`Task 1.*${MAX_TITLE} characters`)],
    [{ tasks: [{ title: "t", criteria: [] }] }, /Task 1.*at least 1 acceptance criterion/],
    [{ tasks: [{ title: "t" }] }, /Task 1.*criteria/],
    [{ tasks: [{ title: "t", criteria: Array.from({ length: MAX_CRITERIA + 1 }, () => "c") }] }, new RegExp(`Task 1.*at most ${MAX_CRITERIA}`)],
    [{ tasks: [{ title: "t", criteria: ["ok", ""] }] }, /Task 1.*criterion 2/],
    [{ tasks: [{ title: "t", criteria: [7] }] }, /Task 1.*criterion 1/],
    [{ tasks: [{ title: "t", criteria: ["x".repeat(MAX_CRITERION + 1)] }] }, new RegExp(`Task 1.*criterion 1.*${MAX_CRITERION} characters`)],
    [{ tasks: ["just a title"] }, /Task 1/],
  ];
  for (const [value, words] of bad) {
    const result = validatePlan(value);
    assert.equal(result.ok, false, JSON.stringify(value).slice(0, 80));
    if (!result.ok) assert.match(result.errors.join(" "), words, JSON.stringify(value).slice(0, 80));
  }
  // Every problem is named, so one trip back to the planner can fix them all.
  const several = validatePlan({ tasks: [{ title: "", criteria: [] }, { title: "ok", criteria: [""] }] });
  assert.equal(!several.ok && several.errors.length, 3);
});

test("a planner's reply is read as the JSON object in its last fenced block, and as nothing else", () => {
  const json = JSON.stringify({ tasks: THREE });
  assert.deepEqual(parsePlan("```json\n" + json + "\n```"), { ok: true, tasks: THREE });
  assert.deepEqual(parsePlan("I read the repository.\n\n```json\n{\"tasks\":[]}\n```\nBetter:\n```json\n" + json + "\n```\n"), { ok: true, tasks: THREE }, "the last block is the plan");
  assert.deepEqual(parsePlan(json), { ok: true, tasks: THREE }, "a reply that is the object alone");
  for (const reply of ["", "Here is my plan: first do A, then B.", "```json\n{not json}\n```", "```json\n[1,2]\n```"]) {
    const result = parsePlan(reply);
    assert.equal(result.ok, false, reply);
    if (!result.ok) assert.ok(result.errors.length > 0);
  }
  // The prompt states the contract the reply is read by, and holds the owner's words as data.
  const prompt = plannerPrompt({ work: "Add two files" });
  assert.match(prompt, /```json/);
  assert.match(prompt, /"tasks"/);
  assert.match(prompt, /independent/i);
  assert.match(prompt, /Add two files/);
  const again = plannerPrompt({ work: "Add two files", current: THREE, feedback: "Use exactly two tasks" });
  assert.match(again, /Use exactly two tasks/);
  assert.match(again, /Add a farewell file/);
});

test("a new run is stored as planning with its first event; approving its three tasks creates exactly three queued tasks and no worktree", (t) => {
  const { db, home, repo, base } = store(t);
  const before = checkoutState(repo);
  const run = createRun(db, { repo, prompt: "Add two files and describe them", baseCommit: base, requestedModel: "haiku", preapproved: ["npm test"] });
  assert.deepEqual([run.status, run.repo, run.prompt, run.specPath, run.specText, run.requestedModel, run.plannerModel, run.baseCommit, run.reason], ["planning", fs.realpathSync(repo), "Add two files and describe them", null, null, "haiku", null, base, null]);
  assert.deepEqual(runEvents(db, run.id), [{ status: "planning", detail: null }]);
  assert.deepEqual(getRun(db, run.id), run);
  assert.equal(getRun(db, run.id + 1), null);

  const waiting = storePlan(db, run.id, THREE, { plannerModel: "claude-haiku-5-5" });
  assert.deepEqual([waiting.status, waiting.plannerModel], ["awaiting_plan_approval", "claude-haiku-5-5"]);
  assert.deepEqual(planTasks(db, run.id).map(({ position, title, criteria }) => ({ position, title, criteria })), THREE.map((task, i) => ({ position: i + 1, ...task })));
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0, "no task exists before the plan is approved");

  const approved = approvePlan(db, run.id, waiting.planVersion);
  assert.equal(approved.run.status, "running");
  assert.equal(approved.tasks.length, 3);
  assert.deepEqual(approved.tasks.map((task) => [task.status, task.runId, task.repo, task.worktreePath, task.branch, task.dependsOn]), THREE.map(() => ["queued", run.id, fs.realpathSync(repo), null, null, ""]));
  // Each task carries its title and every criterion, in order, as what its agent will be given.
  for (const [i, task] of approved.tasks.entries()) {
    assert.ok(task.prompt.startsWith(THREE[i]!.title), task.prompt);
    let at = 0;
    for (const criterion of THREE[i]!.criteria) {
      const found = task.prompt.indexOf(criterion, at);
      assert.ok(found > at, `${criterion} in order in ${task.prompt}`);
      at = found;
    }
  }
  assert.deepEqual(runTasks(db, run.id).map((task) => task.id), approved.tasks.map((task) => task.id));
  assert.deepEqual(planTasks(db, run.id).map((p) => p.taskId), approved.tasks.map((task) => task.id), "each plan task names the task made from it");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 3);
  assert.deepEqual(runEvents(db, run.id).map((e) => e.status), ["planning", "awaiting_plan_approval", "running"]);
  // The run's pre-approved commands are its tasks' grants, for the role that builds.
  assert.deepEqual(runGrants(db, approved.tasks[0]!.runId!).map((g) => [g.role, g.words, g.repo]), [["implementer", ["npm", "test"], fs.realpathSync(repo)]]);
  // Nothing was made in git: no worktree, no branch, and the owner's checkout is as it was.
  assert.equal(worktreeCount(repo), 1);
  assert.deepEqual(worktreeDirs(home), []);
  assert.deepEqual(checkoutState(repo), before);
});

test("deleting one of three planned tasks and approving creates exactly two tasks; an edited title and added task are what is built", (t) => {
  const { db, repo, base } = store(t);
  const run = planned(db, repo, base);
  const edited = editPlan(db, run.id, [{ title: "Add a greeting file, in Spanish", criteria: ["hola.txt exists"] }, THREE[2]!], run.planVersion);
  assert.equal(edited.status, "awaiting_plan_approval");
  assert.notEqual(edited.planVersion, run.planVersion);
  assert.deepEqual(planTasks(db, run.id).map((p) => [p.position, p.title]), [[1, "Add a greeting file, in Spanish"], [2, "Describe both files"]]);
  const approved = approvePlan(db, run.id, edited.planVersion);
  assert.equal(approved.tasks.length, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE run_id = ?").get(run.id)!.n, 2);
  assert.ok(approved.tasks[0]!.prompt.startsWith("Add a greeting file, in Spanish"));

  const other = planned(db, repo, base);
  const added = editPlan(db, other.id, [...THREE, { title: "Add a fourth", criteria: ["four.txt exists"] }], other.planVersion);
  assert.equal(approvePlan(db, other.id, added.planVersion).tasks.length, 4);
});

test("a plan edit is validated, needs the plan as it stands, and is refused once the plan is approved; approving twice is refused", (t) => {
  const { db, repo, base } = store(t);
  const run = planned(db, repo, base);
  // Not a plan: nothing changes.
  assert.throws(() => editPlan(db, run.id, [], run.planVersion), refused(400, /at least 1 task/));
  assert.throws(() => editPlan(db, run.id, [{ title: "", criteria: ["c"] }], run.planVersion), refused(400, /title/));
  assert.throws(() => editPlan(db, run.id, "tasks", run.planVersion), refused(400, /tasks/));
  assert.equal(planTasks(db, run.id).length, 3);
  // Another window changed the plan in between: this one's edit and its approval are both refused.
  const newer = editPlan(db, run.id, THREE.slice(0, 2), run.planVersion);
  assert.throws(() => editPlan(db, run.id, THREE, run.planVersion), refused(409, /changed/));
  assert.throws(() => approvePlan(db, run.id, run.planVersion), refused(409, /changed/));
  assert.throws(() => approvePlan(db, run.id, undefined), refused(400, /planVersion/));
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0);

  approvePlan(db, run.id, newer.planVersion);
  const after = getRun(db, run.id)!;
  assert.throws(() => editPlan(db, run.id, THREE, after.planVersion), refused(409, /approved/));
  assert.throws(() => approvePlan(db, run.id, after.planVersion), refused(409, /already/));
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 2, "a second approval made no second set of tasks");
  assert.deepEqual(planTasks(db, run.id).map((p) => p.title), THREE.slice(0, 2).map((p) => p.title));
  assert.throws(() => editPlan(db, 999, THREE, 1), refused(404, /No such run/));

  // A run still being planned has no plan to edit or approve.
  const planning = createRun(db, { repo, prompt: "p", baseCommit: base });
  assert.throws(() => editPlan(db, planning.id, THREE, planning.planVersion), refused(409, /planned/));
  assert.throws(() => approvePlan(db, planning.id, planning.planVersion), refused(409, /planned/));
});

test("a run is cancelled from planning and from awaiting plan approval, and from nowhere else", (t) => {
  const { db, repo, base } = store(t);
  const planning = createRun(db, { repo, prompt: "p", baseCommit: base });
  assert.equal(cancelRun(db, planning.id).status, "cancelled");
  assert.deepEqual(runEvents(db, planning.id).map((e) => e.status), ["planning", "cancelled"]);

  const waiting = planned(db, repo, base);
  assert.equal(cancelRun(db, waiting.id).status, "cancelled");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0, "a cancelled plan made no task");
  // Cancelled is an end: nothing further is taken.
  assert.throws(() => cancelRun(db, waiting.id), refused(409, /cancelled/));
  assert.throws(() => approvePlan(db, waiting.id, waiting.planVersion), refused(409, /cancelled/));
  assert.throws(() => editPlan(db, waiting.id, THREE, waiting.planVersion), refused(409, /cancelled/));
  assert.throws(() => storePlan(db, waiting.id, THREE), /cancelled/);

  // An approved run is building's to stop, which this version does not have.
  const approved = planned(db, repo, base);
  approvePlan(db, approved.id, approved.planVersion);
  assert.throws(() => cancelRun(db, approved.id), refused(409, /approved/));
  assert.equal(getRun(db, approved.id)!.status, "running");
  assert.throws(() => cancelRun(db, 999), refused(404, /No such run/));
});

test("a run's state and its event are written together or not at all, and the history of a run cannot be rewritten", (t) => {
  const { db, repo, base } = store(t);
  const run = planned(db, repo, base);
  const before = { run: getRun(db, run.id), events: runEvents(db, run.id), plan: planTasks(db, run.id) };
  db.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON run_events WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'event refused'); END;");
  assert.throws(() => approvePlan(db, run.id, run.planVersion), /event refused/);
  assert.deepEqual({ run: getRun(db, run.id), events: runEvents(db, run.id), plan: planTasks(db, run.id) }, before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0, "no task was left behind by the approval that failed");
  assert.equal(db.isTransaction, false);
  db.exec("DROP TRIGGER refuse_event");
  for (const sql of ["UPDATE run_events SET status = 'done'", "DELETE FROM run_events", "INSERT OR REPLACE INTO run_events (id, run_id, ts, status) VALUES (1, 1, 'x', 'done')", "DELETE FROM runs"]) {
    assert.throws(() => db.exec(sql), /append-only|never/, sql);
  }
  // A task cannot name a run that does not exist.
  assert.throws(() => db.exec("INSERT INTO tasks (run_id, repo_path, prompt, status, created_at, updated_at) VALUES (999, '/r', 'p', 'queued', 'x', 'x')"), /run/);
});

test("run ids continue from the highest in use and are never reused; tasks and grants from before runs keep matching", (t) => {
  const { db, repo, base } = store(t);
  const first = createTask(db, { repo, prompt: "one", preapproved: ["npm test"] });
  const second = createTask(db, { repo, prompt: "two", preapproved: ["sh build.sh"] });
  assert.deepEqual([first.runId, second.runId], [1, 2]);
  const run = createRun(db, { repo, prompt: "three", baseCommit: base, preapproved: ["npm run lint"] });
  assert.equal(run.id, 3);
  const third = createTask(db, { repo, prompt: "four", preapproved: ["make"] });
  assert.equal(third.runId, 4, "a task started on its own takes the next run id after the run's");
  // Each task's grants are still its run's, and no one else's.
  assert.deepEqual(runGrants(db, first.runId!).map((g) => g.words), [["npm", "test"]]);
  assert.deepEqual(runGrants(db, second.runId!).map((g) => g.words), [["sh", "build.sh"]]);
  assert.deepEqual(runGrants(db, run.id).map((g) => g.words), [["npm", "run", "lint"]]);
  assert.deepEqual(runGrants(db, third.runId!).map((g) => g.words), [["make"]]);
  // Only runs that are planned are listed as runs, newest first.
  const later = createRun(db, { repo, prompt: "five", baseCommit: base });
  assert.equal(later.id, 5);
  assert.deepEqual(listRuns(db).map((r) => r.id), [5, 3]);
  // A run that could not be stored used no id that a later one then repeats.
  assert.throws(() => createRun(db, { repo, prompt: "bad", baseCommit: base, preapproved: ["a | b"] }), /cannot be pre-approved/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE prompt = 'bad'").get()!.n, 0);
  assert.ok(createRun(db, { repo, prompt: "six", baseCommit: base }).id > 5);
});

test("a database at the version 8 schema is migrated with every row kept: tasks, their run ids, grants, approvals and the action log", (t) => {
  const dir = tempDir("smelt-plan-v8-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const old = new DatabaseSync(path.join(home, DB_FILE));
  old.exec("PRAGMA foreign_keys = ON;");
  old.exec(V8_SCHEMA);
  old.exec(`
INSERT INTO attempts (id, driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (1, 'claude-code', 'haiku', 'cursor-1', 'ended', NULL, 't0', 't1');
INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (1, 1, 't0', 'text', '{"type":"text","text":"hi"}');
INSERT INTO tasks (id, run_id, repo_path, prompt, status, created_at, updated_at) VALUES (1, NULL, '/repos/old', 'from before run ids', 'failed', 't0', 't1');
INSERT INTO tasks (id, run_id, repo_path, prompt, status, attempt_id, requested_model, created_at, updated_at) VALUES (2, 5, '/repos/a', 'second', 'awaiting_decision', 1, 'haiku', 't2', 't3');
INSERT INTO tasks (id, run_id, repo_path, prompt, status, created_at, updated_at) VALUES (3, 7, '/repos/b', 'third', 'interrupted', 't4', 't5');
INSERT INTO task_events (task_id, ts, status, detail) VALUES (2, 't2', 'queued', NULL), (2, 't3', 'awaiting_decision', 'head commit x');
INSERT INTO grants (id, kind, role, repo_path, cwd, words, run_id, task_id, created_at) VALUES (1, 'preapproved', 'implementer', '/repos/a', '.', '["npm","test"]', 5, 2, 't2');
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (4, 2, 1, 'implementer', 'Bash', 'ls', '.', 'look', 'toolu_a', 'pending', 't2');
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (9, 3, 1, 'implementer', 'Bash', 'sh x.sh', 'sub', NULL, 'toolu_b', 'pending', 't4');
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail) VALUES (3, 't2', 2, 1, 4, 'asked_owner', 'Bash', 'ls', '.', NULL);
UPDATE approvals SET status = 'allowed', resolved_at = 't3' WHERE id = 4;
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail) VALUES (6, 't3', 2, 1, 4, 'owner_allowed', 'Bash', 'ls', '.', NULL);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, grant_id, rule, tool, command, cwd, detail) VALUES (8, 't3', 2, 1, NULL, 1, 'preapproved', 'Bash', 'npm test', '.', 'd');
`);
  const dump = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => ({ ...r }));
  const kept = Object.fromEntries(["attempts", "events", "tasks", "task_events", "grants", "approvals", "action_log"].map((table) => [table, dump(old, table)]));
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), 9);
  for (const [table, rows] of Object.entries(kept)) {
    const now = dump(db, table);
    assert.equal(now.length, rows.length, table);
    // Every column the old row had still holds what it held; a column the migration added is empty.
    for (const [i, row] of rows.entries()) for (const [column, value] of Object.entries(row)) assert.deepEqual(now[i]![column], value, `${table} row ${i} ${column}`);
  }
  assert.deepEqual(dump(db, "approvals").map((a) => a.run_id), [null, null]);
  // The run ids in use are runs now, each a task started on its own, and none of them is listed as a planned run.
  assert.deepEqual(db.prepare("SELECT id, kind, repo_path FROM runs ORDER BY id").all().map((r) => ({ ...r })), [{ id: 5, kind: "single", repo_path: "/repos/a" }, { id: 7, kind: "single", repo_path: "/repos/b" }]);
  assert.deepEqual(listRuns(db), []);
  assert.deepEqual(runGrants(db, getTask(db, 2)!.runId!).map((g) => [g.id, g.words]), [[1, ["npm", "test"]]]);
  assert.equal(getTask(db, 1)!.runId, null);
  // New ids go on from the highest, for a run and for a task started on its own.
  const run = createRun(db, { repo: "/repos/a", prompt: "new", baseCommit: "b".repeat(40) });
  assert.equal(run.id, 8);
  assert.equal(createTask(db, { repo: "/repos/a", prompt: "own" }).runId, 9);
  // The rules the old tables had still hold on the rebuilt ones.
  for (const [sql, words] of [
    ["UPDATE approvals SET status = 'declined' WHERE id = 4", /already answered/],
    ["UPDATE approvals SET command = 'rm -rf /' WHERE id = 9", /cannot be changed/],
    ["DELETE FROM approvals WHERE id = 9", /never deleted/],
    ["INSERT OR REPLACE INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at) VALUES (9, 3, 1, 'r', 't', 'c', '.', 'x', 'pending', 't')", /never deleted/],
    ["INSERT INTO approvals (task_id, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at) VALUES (3, 1, 'r', 't', 'c', '.', 'x', 'allowed', 't')", /first written as pending/],
    ["INSERT INTO approvals (attempt_id, role, tool, command, cwd, tool_call_id, status, created_at) VALUES (1, 'r', 't', 'c', '.', 'x', 'pending', 't')", /constraint/i],
    ["UPDATE action_log SET command = 'x' WHERE id = 3", /append-only/],
    ["DELETE FROM action_log WHERE id = 3", /append-only/],
    ["INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES ('t', 'preapproved', 'Bash', 'x', '.')", /constraint/i],
  ] as [string, RegExp][]) {
    assert.throws(() => db.exec(sql), words, sql);
  }
  // A parked approval still takes the owner's stored answer, as before.
  db.exec("UPDATE approvals SET parked_at = 't6' WHERE id = 9");
  db.exec("UPDATE approvals SET stored_decision = 'allow', stored_at = 't7' WHERE id = 9");
  assert.throws(() => db.exec("UPDATE approvals SET status = 'declined', resolved_at = 't8' WHERE id = 9"), /stored answer or as superseded/);
});

/** A runs engine on replayed planner turns, with a real broker on a real socket. */
async function engine(t: T, order: number[], hold?: () => Promise<void>): Promise<{ db: DatabaseSync; home: string; repo: string; base: string; driver: PlanReplay; runs: Runs; broker: Broker; changes: string[] }> {
  const s = store(t);
  const broker = createBroker({ db: s.db, home: s.home, onChange: () => {} });
  await broker.listen();
  const driver = planReplayDriver(loadPlanRecording(), order, hold);
  const changes: string[] = [];
  const runs = createRuns({ db: s.db, home: s.home, driver, broker, model: "haiku", onEvent: () => {}, onRunChange: (run) => changes.push(`${run.id}:${run.status}`), onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await broker.close();
  });
  return { ...s, driver, runs, broker, changes };
}

test("replayed planner: a valid plan makes the run wait for approval; the planner worked read-only in a detached worktree of the base commit, which is gone afterwards", async (t) => {
  const e = await engine(t, [THREE_TASKS]);
  const before = checkoutState(e.repo);
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files and describe them", preapproved: ["npm test"] });
  assert.equal(run.status, "planning");
  await e.runs.idle();
  const done = getRun(e.db, run.id)!;
  assert.deepEqual([done.status, done.reason, done.requestedModel], ["awaiting_plan_approval", null, "haiku"]);
  assert.equal(done.plannerModel, loadPlanRecording().turns[0]!.events.find((event) => event.type === "session_started")!.model, "the model that answered, from the session");
  assert.equal(planTasks(e.db, run.id).length, 3);
  assert.equal(done.attemptId, 1);
  // How the planner was started: read-only, through the gate, on the run's model, somewhere that is not the owner's checkout.
  assert.equal(e.driver.started.length, 1);
  const started = e.driver.started[0]!;
  assert.equal(started.readOnly, true);
  assert.notEqual(started.allowEdits, true);
  assert.equal(started.model, "haiku");
  assert.ok(started.gate && started.gate.socketPath === e.broker.socketPath && started.gate.secret.length >= 32);
  assert.ok(started.cwd.startsWith(fs.realpathSync(e.home) + path.sep) || started.cwd.startsWith(e.home + path.sep), started.cwd);
  assert.ok(!started.cwd.startsWith(fs.realpathSync(e.repo)) && !started.cwd.startsWith(e.repo), "not in the owner's checkout");
  assert.equal(e.driver.prompts.length, 1);
  assert.match(e.driver.prompts[0]!, /Add two files and describe them/);
  assert.equal(e.driver.closed(), 1, "the planner's session is closed");
  // Nothing of the planning is left: no worktree, no branch, and the owner's checkout is untouched.
  assert.equal(fs.existsSync(started.cwd), false);
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
  assert.deepEqual(checkoutState(e.repo), before);
  // Announced at each step: stored, the planner's attempt named (so a screen can follow its transcript), the plan there.
  assert.deepEqual(e.changes, [`${run.id}:planning`, `${run.id}:planning`, `${run.id}:awaiting_plan_approval`]);
  assert.deepEqual(runEvents(e.db, run.id), [{ status: "planning", detail: null }, { status: "planning", detail: "planner attempt 1" }, { status: "awaiting_plan_approval", detail: "plan of 3 tasks" }]);
});

test("replayed planner: an invalid plan goes back to the planner once with the errors; the second plan is accepted", async (t) => {
  const e = await engine(t, [NO_TASKS, THREE_TASKS]);
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files" });
  await e.runs.idle();
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_plan_approval");
  assert.equal(planTasks(e.db, run.id).length, 3);
  assert.equal(e.driver.started.length, 1, "the correction is a second turn of the same session");
  assert.equal(e.driver.prompts.length, 2);
  assert.match(e.driver.prompts[1]!, /at least 1 task/, "the planner is told what was wrong");
  assert.match(e.driver.prompts[1]!, /```json/);
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
});

test("replayed planner: a second invalid plan fails the run with the reason, the planner is not asked a third time, and the worktree is gone", async (t) => {
  const e = await engine(t, [NO_TASKS, EMPTY_TASK, THREE_TASKS]);
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files" });
  await e.runs.idle();
  const failed = getRun(e.db, run.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.reason!, /twice/);
  assert.match(failed.reason!, /Task 1.*title/, "the reason names what was wrong with the last plan");
  assert.equal(e.driver.prompts.length, 2);
  assert.equal(planTasks(e.db, run.id).length, 0);
  assert.equal(db_count(e.db, "tasks"), 0);
  assert.equal(e.driver.closed(), 1);
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
  assert.deepEqual(runEvents(e.db, run.id).map((r) => r.status), ["planning", "planning", "failed"]);
  // Failed is an end.
  assert.throws(() => cancelRun(e.db, run.id), refused(409, /failed/));
});
const db_count = (db: DatabaseSync, table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

test("replayed planner: cancelling while the planner works stops it, the run is cancelled, no plan is stored and the worktree is gone", async (t) => {
  let release!: () => void;
  let reached!: () => void;
  const inTurn = new Promise<void>((resolve) => (reached = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const e = await engine(t, [THREE_TASKS], () => (reached(), held));
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files" });
  await inTurn;
  assert.equal(worktreeCount(e.repo), 2, "the planner's worktree exists while it works");
  assert.equal(e.runs.cancel(run.id).status, "cancelled");
  release();
  await e.runs.idle();
  assert.equal(getRun(e.db, run.id)!.status, "cancelled");
  assert.equal(planTasks(e.db, run.id).length, 0, "a plan that arrives after the cancel is not stored");
  assert.equal(e.driver.closed(), 1);
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
  assert.deepEqual(runEvents(e.db, run.id).map((r) => r.status), ["planning", "planning", "cancelled"]);
});

test("replayed planner: requesting changes sends the plan and the feedback to a new planner turn and returns to awaiting approval; a planner that fails then leaves the plan as it was", async (t) => {
  const e = await engine(t, [THREE_TASKS, THREE_TASKS, NO_TASKS, EMPTY_TASK]);
  const run = await e.runs.start({ repo: e.repo, prompt: "Add two files" });
  await e.runs.idle();
  const waiting = getRun(e.db, run.id)!;
  assert.throws(() => e.runs.requestChanges(run.id, "   ", waiting.planVersion), refused(400, /feedback/));
  assert.throws(() => e.runs.requestChanges(run.id, "x", waiting.planVersion + 1), refused(409, /changed/));
  const edited = e.runs.editPlan(run.id, THREE.slice(0, 2), waiting.planVersion);
  assert.equal(e.runs.requestChanges(run.id, "Describe the files in the README too", edited.planVersion).status, "planning");
  // While the planner works the plan cannot be edited or approved.
  assert.throws(() => e.runs.approve(run.id, edited.planVersion), refused(409, /planned/));
  await e.runs.idle();
  const again = getRun(e.db, run.id)!;
  assert.equal(again.status, "awaiting_plan_approval");
  assert.equal(planTasks(e.db, run.id).length, 3, "the new plan took the old one's place");
  assert.equal(e.driver.started.length, 2, "a new planner attempt, under the same rules");
  assert.equal(e.driver.started[1]!.readOnly, true);
  const sent = e.driver.prompts[1]!;
  assert.match(sent, /Describe the files in the README too/);
  assert.match(sent, /Add a farewell file/, "the plan as the owner left it is sent along");
  assert.doesNotMatch(sent, /Describe both files/, "a task the owner deleted is not");
  assert.equal(db_count(e.db, "tasks"), 0);
  assert.deepEqual(worktreeDirs(e.home), []);

  // The planner cannot produce a changed plan: the owner's plan is kept, and the run says why it is unchanged.
  e.runs.requestChanges(run.id, "Use one task", again.planVersion);
  await e.runs.idle();
  const kept = getRun(e.db, run.id)!;
  assert.equal(kept.status, "awaiting_plan_approval");
  assert.match(kept.reason!, /twice/);
  assert.equal(planTasks(e.db, run.id).length, 3);
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
  assert.equal(e.runs.approve(run.id, kept.planVersion).tasks.length, 3);
});

test("the planner's admission to the gate is read-only: an edit in its worktree is denied, a shell command asks under the planner role, and no grant of the run lets it through", async (t) => {
  const { db, home, repo, base } = store(t);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  t.after(() => broker.close());
  const run = createRun(db, { repo, prompt: "plan", baseCommit: base, preapproved: ["ls"] });
  const worktree = path.join(home, "worktrees", "somewhere");
  fs.mkdirSync(worktree, { recursive: true });
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'x', 'x')").run().lastInsertRowid);
  const admission = broker.admit({ runId: run.id, role: "planner", worktree, readOnly: true });
  admission.bind(attemptId);
  const hook = (tool: string, input: Record<string, unknown>, id: string) => askBroker(admission.socketPath, admission.secret, { tool_name: tool, tool_input: input, tool_use_id: id, cwd: fs.realpathSync(worktree) });

  for (const [tool, input] of [["Write", { file_path: path.join(worktree, "planted.txt"), content: "x" }], ["Edit", { file_path: "README.md", old_string: "a", new_string: "b" }], ["NotebookEdit", { notebook_path: "n.ipynb" }]] as [string, Record<string, unknown>][]) {
    const reply = await hook(tool, input, `toolu_${tool}`);
    assert.equal(reply.verdict, "deny", tool);
    assert.match(reply.reason, /read-only/, tool);
  }
  assert.equal((await hook("Read", { file_path: path.join(worktree, "README.md") }, "toolu_read")).verdict, "pass");
  assert.equal((await hook("Bash", { command: "ls" }, "toolu_ls")).verdict, "ask");
  // The CLI's own request for the command waits for the owner, though `ls` is pre-approved for the run's builders.
  const waiting = broker.request({ taskId: null, runId: run.id, attemptId, role: "planner", tool: "Bash", command: "ls", input: { command: "ls" }, reason: null, toolCallId: "toolu_ls" });
  const [approval] = listApprovals(db, "pending");
  assert.deepEqual([approval!.taskId, approval!.runId, approval!.role, approval!.command, approval!.cwd, approval!.taskTitle], [null, run.id, "planner", "ls", ".", "plan"]);
  assert.equal(broker.standingOffer(approval!.id), null, "a planner's request earns no standing permission");
  broker.answer(approval!.id, "decline", "Not while planning.");
  assert.deepEqual([(await waiting).decision, (await waiting).preapproved], ["decline", undefined]);
  const log = actionLog(db).map((entry) => [entry.rule, entry.tool, entry.runId, entry.taskId]);
  assert.deepEqual(log.filter(([rule]) => rule === "broker_failure_denied").length, 3, "each refused edit is on record");
  assert.ok(log.some(([rule, tool, runId]) => rule === "asked_owner" && tool === "Bash" && runId === run.id));
  assert.ok(!log.some(([rule]) => rule === "auto_worktree_edit" || rule === "preapproved"));
  // Released, the secret no longer works.
  admission.release();
  assert.equal((await hook("Read", { file_path: "README.md" }, "toolu_late")).verdict, "deny");
});

test("after a restart: a run left planning is failed with the reason and its worktree removed; an approved run's queued tasks stay queued", async (t) => {
  const e = await engine(t, []);
  const queuedRun = planned(e.db, e.repo, e.base);
  const tasks = approvePlan(e.db, queuedRun.id, queuedRun.planVersion).tasks;
  // What a Smelt that was killed while planning leaves: the run still planning, and its worktree.
  const left = createRun(e.db, { repo: e.repo, prompt: "left behind", baseCommit: e.base });
  const dir = path.join(e.home, "worktrees", `run-${left.id}`, "planner");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync("git", ["-C", e.repo, "worktree", "add", "--quiet", "--detach", dir, e.base]);
  assert.equal(worktreeCount(e.repo), 2);

  const runs = createRuns({ db: e.db, home: e.home, driver: e.driver, broker: e.broker, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(() => runs.close());
  await runs.idle();
  const failed = getRun(e.db, left.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.reason!, /Smelt stopped/);
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
  assert.equal(e.driver.started.length, 0, "nothing was planned again unasked");

  // The task engine's own recovery leaves the run's queued tasks alone: they are the run's to build.
  const taskEngine = createTasks({ db: e.db, home: e.home, driver: e.driver, broker: e.broker, onEvent: () => {}, onTaskChange: () => {} });
  t.after(() => taskEngine.close());
  await taskEngine.idle();
  assert.deepEqual(tasks.map((task) => getTask(e.db, task.id)!.status), ["queued", "queued", "queued"]);
  await taskEngine.close();
  assert.deepEqual(tasks.map((task) => getTask(e.db, task.id)!.status), ["queued", "queued", "queued"]);
  assert.equal(getRun(e.db, queuedRun.id)!.status, "running");
});

test("a spec file is read only when it is a full path to a regular text file of a readable size, and never hangs", async (t) => {
  const dir = tempDir("smelt-spec-test-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const file = (name: string, content: string | Buffer): string => {
    fs.writeFileSync(path.join(dir, name), content);
    return path.join(dir, name);
  };
  const good = file("spec.md", "# Greeting\n\nAdd hello.txt holding hi.\n");
  assert.deepEqual(await readSpec(good, { home }), { path: fs.realpathSync(good), text: "# Greeting\n\nAdd hello.txt holding hi.\n" });
  assert.equal((await readSpec(file("exact.md", "x".repeat(MAX_SPEC_BYTES)), { home })).text.length, MAX_SPEC_BYTES);

  fs.mkdirSync(path.join(dir, "folder.md"));
  execFileSync("mkfifo", [path.join(dir, "pipe.md")]);
  fs.symlinkSync(path.join(dir, "nowhere.md"), path.join(dir, "dangling.md"));
  file("unreadable.md", "x");
  fs.chmodSync(path.join(dir, "unreadable.md"), 0o000);
  fs.writeFileSync(path.join(home, "inside.md"), "x");
  const bad: [unknown, RegExp][] = [
    [undefined, /full path/],
    [7, /full path/],
    ["spec.md", /full path/],
    ["./spec.md", /full path/],
    [`${good}\0.md`, /full path/],
    [`/${"x".repeat(5000)}.md`, /too long/],
    [path.join(dir, "missing.md"), /does not exist/],
    [path.join(dir, "dangling.md"), /does not exist/],
    [path.join(dir, "folder.md"), /not a regular file/],
    [path.join(dir, "pipe.md"), /not a regular file/],
    ["/dev/zero", /\.md|not a regular file/],
    [path.join(dir, "unreadable.md"), /could not be read/],
    [file("big.md", "x".repeat(MAX_SPEC_BYTES + 1)), /too large/],
    [file("empty.md", ""), /empty/],
    [file("binary.md", Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02])), /not text/],
    [file("latin.md", Buffer.from([0x63, 0x61, 0x66, 0xe9])), /not text/],
    [file("key.pem", "-----BEGIN-----"), /\.md/],
    [file("noextension", "text"), /\.md/],
    [path.join(home, "inside.md"), /Smelt's own/],
  ];
  for (const [input, words] of bad) {
    const started = Date.now();
    await assert.rejects(readSpec(input, { home }), refused(400, words), String(input).slice(0, 60));
    assert.ok(Date.now() - started < 3000, `answered quickly for ${String(input).slice(0, 60)}`);
  }
});

test("starting a run checks the repository and the spec file before any run exists, and takes exactly one of a prompt and a spec file", async (t) => {
  const e = await engine(t, [THREE_TASKS]);
  const spec = path.join(path.dirname(e.repo), "spec.md");
  fs.writeFileSync(spec, "# Spec\n\nAdd two files.\n");
  const bad: [Record<string, unknown>, number, RegExp][] = [
    [{ repo: e.repo }, 400, /prompt.*spec|one of/i],
    [{ repo: e.repo, prompt: "p", specPath: spec }, 400, /one of|not both/i],
    [{ repo: e.repo, prompt: "   " }, 400, /prompt/],
    [{ repo: e.repo, prompt: "x".repeat(20_001) }, 400, /too long/],
    [{ repo: path.join(e.repo, "nope"), prompt: "p" }, 400, /does not exist/],
    [{ repo: "relative", prompt: "p" }, 400, /full path/],
    [{ repo: e.repo, specPath: path.join(path.dirname(e.repo), "missing.md") }, 400, /does not exist/],
    [{ repo: e.repo, prompt: "p", preapproved: ["a && b"] }, 400, /cannot be pre-approved/],
  ];
  for (const [input, status, words] of bad) await assert.rejects(e.runs.start(input as never), refused(status, words), JSON.stringify(input).slice(0, 90));
  assert.equal(db_count(e.db, "runs"), 0);
  assert.equal(e.driver.started.length, 0);
  assert.equal(worktreeCount(e.repo), 1);

  // A spec file is read once, when the run starts: the run holds its text and where it came from.
  const run = await e.runs.start({ repo: e.repo, specPath: spec, model: null });
  fs.writeFileSync(spec, "changed afterwards");
  assert.deepEqual([run.prompt, run.specPath, run.specText, run.requestedModel], [null, fs.realpathSync(spec), "# Spec\n\nAdd two files.\n", null]);
  await e.runs.idle();
  assert.match(e.driver.prompts[0]!, /# Spec\n\nAdd two files\./);
  assert.equal(e.driver.started[0]!.model, undefined, "the CLI's own default when the owner chose it");
  assert.equal(getRun(e.db, run.id)!.status, "awaiting_plan_approval");
});

test("a version 8 database with data in every table keeps it all: standing permissions and one taken back, a parked approval with its stored answer, and every append-only rule", (t) => {
  const dir = tempDir("smelt-plan-v8-full-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const old = new DatabaseSync(path.join(home, DB_FILE));
  old.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
  old.exec(V8_SCHEMA);
  old.exec(`
INSERT INTO attempts (id, driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (1, 'claude-code', 'haiku', 'cursor-1', 'interrupted', NULL, 't0', 't1');
INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (1, 1, 't0', 'text', '{"type":"text","text":"hi"}');
INSERT INTO tasks (id, run_id, repo_path, prompt, status, worktree_path, branch, base_commit, attempt_id, created_at, updated_at) VALUES (1, 3, '/repos/a', 'build it', 'building', '/h/worktrees/r/task-1', 'smelt/r/task-1', 'bbbb', 1, 't0', 't1');
INSERT INTO task_events (task_id, ts, status, detail) VALUES (1, 't0', 'queued', NULL), (1, 't1', 'building', 'attempt 1');
INSERT INTO grants (id, kind, role, repo_path, cwd, words, run_id, task_id, created_at) VALUES (1, 'preapproved', 'implementer', '/repos/a', '.', '["npm","test"]', 3, 1, 't0');
INSERT INTO grants (id, kind, role, repo_path, cwd, words, run_id, task_id, created_at) VALUES (2, 'standing', 'implementer', '/repos/a', '.', '["ls","-la"]', NULL, 1, 't2');
INSERT INTO grants (id, kind, role, repo_path, cwd, words, run_id, task_id, created_at) VALUES (3, 'standing', 'implementer', '/repos/a', 'sub', '["make","check"]', NULL, 1, 't3');
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (1, 1, 1, 'implementer', 'Bash', 'ls -la', '.', NULL, 'toolu_a', 'pending', 't1');
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (2, 1, 1, 'implementer', 'Bash', 'sh deploy.sh', '.', 'ship', 'toolu_b', 'pending', 't4');
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (3, 1, 1, 'implementer', 'Bash', 'sh other.sh', '.', NULL, 'toolu_c', 'pending', 't4');
INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd) VALUES ('t1', 1, 1, 1, 'asked_owner', 'Bash', 'ls -la', '.');
UPDATE approvals SET status = 'allowed', resolved_at = 't2' WHERE id = 1;
INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd) VALUES ('t2', 1, 1, 1, 'owner_allowed', 'Bash', 'ls -la', '.');
INSERT INTO action_log (ts, task_id, attempt_id, approval_id, grant_id, rule, tool, command, cwd, detail) VALUES ('t2', 1, 1, 1, 2, 'standing_granted', 'Bash', 'ls -la', '.', 'given');
INSERT INTO action_log (ts, task_id, attempt_id, grant_id, rule, tool, command, cwd) VALUES ('t3', 1, 1, 2, 'standing', 'Bash', 'ls -la', '.');
INSERT INTO action_log (ts, task_id, attempt_id, grant_id, rule, tool, command, cwd, detail) VALUES ('t3', 1, 1, 3, 'standing_granted', 'Bash', 'make check', 'sub', 'given');
INSERT INTO grant_revocations (grant_id, revoked_at) VALUES (3, 't5');
INSERT INTO action_log (ts, grant_id, rule, tool, command, cwd) VALUES ('t5', 3, 'standing_revoked', 'Bash', 'make check', 'sub');
INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd) VALUES ('t4', 1, 1, 2, 'asked_owner', 'Bash', 'sh deploy.sh', '.');
UPDATE approvals SET parked_at = 't6' WHERE id IN (2, 3);
UPDATE approvals SET stored_decision = 'decline', stored_at = 't7', note = 'not today' WHERE id = 2;
INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail) VALUES ('t7', 1, 1, 2, 'owner_declined', 'Bash', 'sh deploy.sh', '.', 'not today');
`);
  const tables = ["attempts", "events", "tasks", "task_events", "grants", "grant_revocations", "approvals", "action_log"];
  const dump = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => ({ ...r }));
  const kept = Object.fromEntries(tables.map((table) => [table, dump(old, table)]));
  for (const table of tables) assert.ok(kept[table]!.length > 0, `${table} holds data before the migration`);
  const named = (db: DatabaseSync, type: string): string[] => db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type).map((r) => String(r.name));
  const before = { triggers: named(old, "trigger"), indexes: named(old, "index") };
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), 9);
  for (const table of tables) {
    const now = dump(db, table);
    assert.equal(now.length, kept[table]!.length, table);
    for (const [i, row] of kept[table]!.entries()) for (const [column, value] of Object.entries(row)) assert.deepEqual(now[i]![column], value, `${table} row ${i} ${column}`);
  }
  // Every rule and index the old store had is still there, by name; nothing of the rebuild is left over.
  for (const trigger of before.triggers) assert.ok(named(db, "trigger").includes(trigger), `trigger ${trigger}`);
  for (const index of before.indexes) assert.ok(named(db, "index").includes(index), `index ${index}`);
  assert.deepEqual(named(db, "table").filter((name) => name.includes("before")), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // New rows go on after the old ids in the rebuilt tables.
  assert.deepEqual(db.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('approvals', 'action_log') ORDER BY name").all().map((r) => ({ ...r })), [{ name: "action_log", seq: 8 }, { name: "approvals", seq: 3 }]);

  // Read through Smelt's own functions: the standing permission in force with its use, the one taken back gone, the run's grant, the parked approvals.
  assert.deepEqual(listStanding(db).map((g) => [g.id, g.command, g.timesUsed, g.lastUsedAt]), [[2, "ls -la", 1, "t3"]]);
  assert.deepEqual(standingGrants(db, { role: "implementer", repo: "/repos/a" }).map((g) => g.id), [2]);
  assert.deepEqual(runGrants(db, 3).map((g) => g.words), [["npm", "test"]]);
  assert.deepEqual(listApprovals(db, "pending").map((a) => [a.id, a.taskId, a.runId, a.parkedAt, a.storedDecision, a.note, a.taskTitle]), [[2, 1, null, "t6", "decline", "not today", "build it"], [3, 1, null, "t6", null, null, "build it"]]);
  assert.deepEqual(actionLog(db).map((e) => [e.id, e.rule, e.grantId, e.approvalId, e.runId]).at(-1), [8, "owner_declined", null, 2, null]);
  // A parked approval still takes a stored answer once, and ends only as that answer or superseded.
  db.exec("UPDATE approvals SET stored_decision = 'allow', stored_at = 't8' WHERE id = 3");
  for (const [sql, words] of [
    ["UPDATE approvals SET stored_decision = 'decline', stored_at = 't9' WHERE id = 3", /stored once/],
    ["UPDATE approvals SET parked_at = 't9' WHERE id = 2", /parked once/],
    ["UPDATE approvals SET note = 'changed' WHERE id = 2", /note of a stored answer/],
    ["UPDATE approvals SET status = 'allowed', resolved_at = 't9' WHERE id = 2", /stored answer or as superseded/],
    ["UPDATE approvals SET run_id = 3 WHERE id = 2", /cannot be changed/],
    ["DELETE FROM approvals WHERE id = 1", /never deleted/],
    ["INSERT OR REPLACE INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at) VALUES (1, 1, 1, 'r', 't', 'c', '.', 'x', 'pending', 't')", /never deleted/],
    ["UPDATE action_log SET detail = 'x' WHERE id = 1", /append-only/],
    ["DELETE FROM action_log WHERE id = 1", /append-only/],
    ["INSERT OR REPLACE INTO action_log (id, ts, rule, tool, command, cwd) VALUES (1, 't', 'asked_owner', 'Bash', 'x', '.')", /append-only/],
    ["INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES ('t', 'standing', 'Bash', 'x', '.')", /constraint/i],
    ["INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES ('t', 'made_up', 'Bash', 'x', '.')", /constraint/i],
    ["UPDATE grants SET words = '[\"rm\"]' WHERE id = 2", /never changed/],
    ["DELETE FROM grants WHERE id = 2", /never removed/],
    ["INSERT OR REPLACE INTO grants (id, kind, role, repo_path, cwd, words, created_at) VALUES (2, 'standing', 'implementer', '/repos/a', '.', '[\"rm\"]', 't')", /never removed/],
    ["DELETE FROM grant_revocations WHERE grant_id = 3", /never removed/],
    ["UPDATE grant_revocations SET revoked_at = 'x'", /never changed/],
  ] as [string, RegExp][]) {
    assert.throws(() => db.exec(sql), words, sql);
  }
  db.exec("UPDATE approvals SET status = 'declined', resolved_at = 't9' WHERE id = 2");
  db.exec("UPDATE approvals SET status = 'superseded', resolved_at = 't9' WHERE id = 3");
  // The broker works on the migrated store: a standing permission is taken back, on record.
  const broker = createBroker({ db, home, onChange: () => {} });
  assert.equal(broker.revokeStanding(2).id, 2);
  assert.deepEqual(listStanding(db), []);
  assert.equal(actionLog(db).at(-1)!.rule, "standing_revoked");
});

// Found by the critique pass, each first seen failing.

test("critique: a run cancelled while start-up recovery is still at work stays cancelled", { timeout: 15000 }, async (t) => {
  const e = await engine(t, []);
  await e.runs.close();
  // A re-plan was in flight when Smelt died: the run is planning and still holds its plan.
  const left = planned(e.db, e.repo, e.base);
  e.db.prepare("UPDATE runs SET status = 'planning' WHERE id = ?").run(left.id);
  const first = createRun(e.db, { repo: e.repo, prompt: "never planned", baseCommit: e.base });
  const runs = createRuns({ db: e.db, home: e.home, driver: e.driver, broker: e.broker, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(() => runs.close());
  assert.equal(runs.cancel(left.id).status, "cancelled");
  assert.equal(runs.cancel(first.id).status, "cancelled");
  await runs.idle();
  assert.deepEqual([getRun(e.db, left.id)!.status, getRun(e.db, first.id)!.status], ["cancelled", "cancelled"]);
  assert.throws(() => runs.approve(left.id, getRun(e.db, left.id)!.planVersion), refused(409, /cancelled/));
  // The store itself keeps an end an end.
  for (const id of [left.id, first.id]) assert.throws(() => e.db.prepare("UPDATE runs SET status = 'awaiting_plan_approval' WHERE id = ?").run(id), /ended/);
});

test("critique: a planning worktree left by a cancel that Smelt did not live to clean up is removed at the next start", { timeout: 15000 }, async (t) => {
  const e = await engine(t, []);
  await e.runs.close();
  const run = createRun(e.db, { repo: e.repo, prompt: "cancelled, then Smelt was killed", baseCommit: e.base });
  const dir = path.join(e.home, "worktrees", `run-${run.id}`, "planner");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync("git", ["-C", e.repo, "worktree", "add", "--quiet", "--detach", dir, e.base]);
  cancelRun(e.db, run.id);
  assert.equal(worktreeCount(e.repo), 2);
  const runs = createRuns({ db: e.db, home: e.home, driver: e.driver, broker: e.broker, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(() => runs.close());
  await runs.idle();
  assert.equal(worktreeCount(e.repo), 1);
  assert.deepEqual(worktreeDirs(e.home), []);
  assert.equal(getRun(e.db, run.id)!.status, "cancelled");
});

test("critique: a title or criterion that holds a line break, a control character or a direction override is not a plan", () => {
  for (const bad of ["one\n\nAcceptance criteria:\n- anything goes", "a b", "a\u0000b", "a\u001b[2Jb", "a‮b", "a\u000bb", "a⁦b", "a\u0085b"]) {
    for (const plan of [{ tasks: [{ title: "t", criteria: [bad] }] }, { tasks: [{ title: bad, criteria: ["c"] }] }]) {
      const result = validatePlan(plan);
      assert.equal(result.ok, false, JSON.stringify(plan));
      if (!result.ok) assert.match(result.errors.join(" "), /one line|plain text/);
    }
  }
  assert.equal(validatePlan({ tasks: [{ title: "Añadir «hola» 你好 — ok\ttab", criteria: ["It's fine: 100% → done"] }] }).ok, true);
});

test("critique: a read-only attempt's own request for a tool that is not reading or the shell is refused, never put to the owner", { timeout: 15000 }, async (t) => {
  const { db, home, repo, base } = store(t);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  t.after(() => broker.close());
  const run = createRun(db, { repo, prompt: "plan", baseCommit: base });
  const worktree = path.join(home, "worktrees", "somewhere");
  fs.mkdirSync(worktree, { recursive: true });
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'x', 'x')").run().lastInsertRowid);
  const admission = broker.admit({ runId: run.id, role: "planner", worktree, readOnly: true });
  admission.bind(attemptId);
  for (const tool of ["Write", "write", "MultiEdit", "mcp__fs__write_file", "Task", "WebFetch"]) {
    const answer = await broker.request({ taskId: null, runId: run.id, attemptId, role: "planner", tool, command: "{}", input: {}, reason: null, toolCallId: `toolu_${tool}` });
    assert.equal(answer.decision, "decline", tool);
    assert.match(String(answer.refused), /read-only/, tool);
    const hook = await askBroker(admission.socketPath, admission.secret, { tool_name: tool, tool_input: {}, tool_use_id: `toolu_h_${tool}`, cwd: fs.realpathSync(worktree) });
    assert.equal(hook.verdict, "deny", tool);
  }
  assert.deepEqual(listApprovals(db), [], "no card was made for any of them");
});

test("critique: a spec file that is another name for a file elsewhere (a hard link) is not read; a run stopped before its turn says to start it again", { timeout: 15000 }, async (t) => {
  const e = await engine(t, [THREE_TASKS]);
  fs.writeFileSync(path.join(e.home, "secret-no-ending"), "TOKEN");
  const link = path.join(path.dirname(e.repo), "hard.md");
  fs.linkSync(path.join(e.home, "secret-no-ending"), link);
  await assert.rejects(readSpec(link, { home: e.home }), refused(400, /more than one name/));

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const h = await engine(t, [THREE_TASKS], () => held);
  const a = await h.runs.start({ repo: h.repo, prompt: "first" });
  const b = await h.runs.start({ repo: h.repo, prompt: "waits its turn" });
  const closing = h.runs.close();
  release();
  await closing;
  for (const id of [a.id, b.id]) {
    const run = getRun(h.db, id)!;
    assert.equal(run.status, "failed");
    assert.match(run.reason!, /Smelt stopped.*Start the run again/);
  }
  assert.deepEqual(worktreeDirs(h.home), []);
});
