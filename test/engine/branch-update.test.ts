import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import { branchUpdateLine, conflictPrompt, taskBranchUpdates } from "../../src/engine/branch-update.ts";
import { createRun, createRuns, storePlan, type Runs } from "../../src/engine/run.ts";
import { taskEvidence, type StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, TaskError, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { commitsBehind, mainBranchOf } from "../../src/worktrees.ts";
import { buildReplayDriver, type AttemptScript, type BuildReplay } from "../support/replay-build.ts";
import { checkoutState, git, initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// Bringing a task that is ready for review up to date with main (#201): real temporary repositories whose main moves
// after the task started, real git merges in the task's copy, real SQLite, real setup and check commands. No CLI is
// started: the builder's turns are replayed from real Claude Code sessions (test/support/replay-build.ts). The conflict
// is resolved by the recorded "refine" turn, a real Claude Code turn whose Edit wrote calc.py as `return a + b`: played
// after Botbench's conflict prompt, it leaves calc.py with no conflict marker, as a real resolution does.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 20_000 });
const BASE_CALC = "def add(a, b):\n    return a - b\n";
// The task's own change, made by its setup so that the build's work is on its branch: calc.py's one line.
const SETUP = [cmd("printf 'def add(a, b):\\n    return a * b\\n' > calc.py")];
// Passes on the task's work and on a resolved merge; fails on a file that still holds a conflict marker.
const CHECK = "test -f calc.py && ! grep -q '^<<<<<<<' calc.py && echo 'calc.py is whole'";

interface Line {
  db: DatabaseSync;
  home: string;
  repo: string;
  broker: Broker;
  builder: BuildReplay;
  tasks: Tasks;
  runs: Runs;
  engine: () => Tasks;
}

async function line(t: T, script: AttemptScript[], o: { hold?: number[]; holdAt?: "prompt" | "session" } = {}): Promise<Line> {
  const dir = tempDir("botbench-branch-update-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Calculator\n", "calc.py": BASE_CALC });
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(script, { hold: o.hold ?? [], ...(o.holdAt ? { holdAt: o.holdAt } : {}) });
  const engines: Tasks[] = [];
  const engine = (): Tasks => {
    const made = createTasks({ db, home, driver: builder, broker, model: "haiku", checkFixRounds: 0, repoCommands: () => ({ setup: SETUP, checks: [cmd(CHECK)] }), onEvent: () => {}, onTaskChange: () => {} });
    engines.push(made);
    return made;
  };
  const tasks = engine();
  const runs = createRuns({ db, home, driver: builder, broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    for (const made of engines) await made.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo: fs.realpathSync(repo), broker, builder, tasks, runs, engine };
}

/** Build one task to Ready for review; returns its id. */
async function ready(e: Line): Promise<number> {
  const started = await e.tasks.start(e.repo, "Make add multiply");
  await e.tasks.idle();
  const task = getTask(e.db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.checks, "passed");
  return task.id;
}

/** Main moves on in the owner's repository: one commit by the owner, on main. */
function mainMoves(repo: string, file: string, content: string): string {
  write(repo, file, content);
  return ownerCommit(repo, `main: change ${file}`);
}

const checkRounds = (db: DatabaseSync, id: number): string[] => taskEvidence(db, id).filter((row) => row.kind === "check").map((row) => `${row.round}:${row.outcome}`);
const parents = (repo: string, commit: string): string[] => git(repo, "rev-list", "--parents", "-n", "1", commit).trim().split(" ").slice(1);

test("main is read as this Mac last saw it, and how far a branch is behind it is counted", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"]);
  const id = await ready(e);
  const task = getTask(e.db, id)!;
  const main = await mainBranchOf({ repo: e.repo, remote: "origin", baseBranch: null });
  assert.deepEqual(main, { branch: "main", ref: "refs/heads/main", commit: git(e.repo, "rev-parse", "main").trim() });
  assert.equal(await commitsBehind({ repo: e.repo, head: task.headCommit!, commit: main!.commit }), 0);
  assert.deepEqual(await e.tasks.mainStatus(id), { branch: "main", behind: 0 });
  // Nothing to bring in: refused, saying so, and nothing is written.
  await assert.rejects(e.tasks.updateWithMain(id), (err: unknown) => err instanceof TaskError && err.status === 409 && /already holds everything on main/.test(err.message));
  assert.deepEqual(taskBranchUpdates(e.db, id), []);

  mainMoves(e.repo, "README.md", "# Calculator\n\nNow with docs.\n");
  mainMoves(e.repo, "LICENSE", "MIT\n");
  assert.deepEqual(await e.tasks.mainStatus(id), { branch: "main", behind: 2 });
  // A base branch the settings name is the one read; one the repository does not have is none.
  assert.equal(await mainBranchOf({ repo: e.repo, remote: "origin", baseBranch: "release" }), null);
});

test("a clean merge: main is merged into the task's branch as a new merge commit in its copy, the checks run again on it, and no builder is started", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"]);
  const id = await ready(e);
  const before = getTask(e.db, id)!;
  const mainHead = mainMoves(e.repo, "README.md", "# Calculator\n\nNow with docs.\n");
  const owner = checkoutState(e.repo);

  const started = await e.tasks.updateWithMain(id);
  assert.equal(started.status, "building");
  await e.tasks.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  // A new commit on top of the task's work, whose parents are the task's commit and main's: nothing was rewritten.
  assert.notEqual(task.headCommit, before.headCommit);
  assert.deepEqual(parents(e.repo, task.headCommit!), [before.headCommit, mainHead]);
  assert.equal(git(e.repo, "rev-parse", task.branch!).trim(), task.headCommit);
  assert.equal(git(e.repo, "merge-base", "--is-ancestor", before.headCommit!, task.branch!), "");
  assert.match(git(e.repo, "show", `${task.headCommit}:README.md`), /Now with docs/);
  assert.match(git(e.repo, "show", `${task.headCommit}:calc.py`), /return a \* b/);
  // Its work is measured from the main it merged: its changed files are its own, not main's.
  assert.equal(task.baseCommit, mainHead);
  assert.deepEqual(git(e.repo, "diff", "--name-only", task.baseCommit!, task.headCommit!).trim().split("\n"), ["calc.py"]);
  assert.equal(git(e.repo, "log", "-1", "--format=%an <%ae>|%s", task.headCommit!).trim(), `Botbench <botbench@localhost>|Botbench task ${id}: bring up to date with main`);
  // The checks ran again, as a new round, on the merge.
  assert.deepEqual(checkRounds(e.db, id), ["1:passed", "2:passed"]);
  assert.equal(task.checks, "passed");
  assert.equal(e.builder.started.length, 1, "only the build: a clean merge needs no builder");
  const [update] = taskBranchUpdates(e.db, id);
  assert.deepEqual({ ...update!, startedAt: "", endedAt: "" }, { id: update!.id, taskId: id, requestedBy: "owner", baseBranch: "main", baseCommit: mainHead, fromCommit: before.headCommit, behind: 1, mergeCommit: task.headCommit, conflicts: [], attemptId: null, outcome: "merged", problem: null, startedAt: "", endedAt: "" });
  assert.equal(branchUpdateLine(update, "claude-code"), "Brought up to date with main: Botbench merged 1 commit with no conflict, then ran the checks again.");
  assert.deepEqual(await e.tasks.mainStatus(id), { branch: "main", behind: 0 });
  // The owner's checkout is as it was: Botbench merged in the task's copy only.
  assert.deepEqual(checkoutState(e.repo), owner);
});

test("a conflicting merge goes to the builder in the same copy and session, sent the conflicted files as data; its resolution is committed as the merge and checked again", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "refine"]);
  const id = await ready(e);
  const before = getTask(e.db, id)!;
  // Main changed the same line of calc.py as the task.
  const mainHead = mainMoves(e.repo, "calc.py", "def add(a, b):\n    return b - a\n");
  await e.tasks.updateWithMain(id);
  await e.tasks.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");

  // The builder's second attempt: same copy, confinement, permission check and model, taking up the build's session.
  assert.equal(e.builder.started.length, 2);
  const [build, resolve] = e.builder.started;
  assert.equal(resolve!.cwd, build!.cwd);
  assert.equal(resolve!.allowEdits, true);
  assert.ok(resolve!.gate !== undefined, "its requests go to the same permission check");
  assert.deepEqual(resolve!.confinement, build!.confinement);
  assert.equal(resolve!.model, "haiku");
  const buildAttempt = e.db.prepare("SELECT resume_cursor FROM attempts WHERE id = (SELECT min(id) FROM attempts)").get()!;
  assert.equal(resolve!.resumeCursor, buildAttempt.resume_cursor, "it takes up the builder's session");
  const prompt = e.builder.prompts[1]!;
  assert.equal(prompt, conflictPrompt({ branch: "main", conflicts: ["calc.py"], task: null }));
  assert.match(prompt, /^\[From Botbench, not from the owner\]/);
  assert.ok(prompt.includes("<conflicted-files>\ncalc.py\n</conflicted-files>"), prompt);
  assert.match(prompt, /Do not run git/);

  // Botbench committed the merge with the builder's resolution, and the checks ran again on it.
  assert.deepEqual(parents(e.repo, task.headCommit!), [before.headCommit, mainHead]);
  assert.equal(git(e.repo, "show", `${task.headCommit}:calc.py`), "def add(a, b):\n    return a + b\n");
  assert.deepEqual(checkRounds(e.db, id), ["1:passed", "2:passed"]);
  const [update] = taskBranchUpdates(e.db, id);
  assert.equal(update!.outcome, "resolved");
  assert.deepEqual(update!.conflicts, ["calc.py"]);
  assert.equal(update!.attemptId, task.attemptId);
  assert.equal(update!.mergeCommit, task.headCommit);
  assert.equal(branchUpdateLine(update, "claude-code"), "Brought up to date with main: Botbench merged 1 commit, Claude Code resolved the conflicts in calc.py, then the checks ran again.");
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM approvals").get()!.n, 0, "nothing was asked of the owner");
});

test("a builder that leaves a conflict marker has the merge undone: the branch and the copy are as they were, and the task says why", { skip: NO_SANDBOX }, async (t) => {
  // The second attempt replays a turn that changes no file, so calc.py keeps git's markers.
  const e = await line(t, ["done", "done"]);
  const id = await ready(e);
  const before = getTask(e.db, id)!;
  mainMoves(e.repo, "calc.py", "def add(a, b):\n    return b - a\n");
  await e.tasks.updateWithMain(id);
  await e.tasks.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.headCommit, before.headCommit);
  assert.equal(git(e.repo, "rev-parse", task.branch!).trim(), before.headCommit);
  assert.equal(task.checks, "passed", "what the checks found is the build's, unchanged");
  assert.deepEqual(checkRounds(e.db, id), ["1:passed"], "nothing new was checked");
  assert.equal(fs.readFileSync(path.join(task.worktreePath!, "calc.py"), "utf8"), "def add(a, b):\n    return a * b\n", "the copy's files are back at the task's commit");
  assert.equal(git(task.worktreePath!, "status", "--porcelain"), "", "no merge is left under way");
  const [update] = taskBranchUpdates(e.db, id);
  assert.equal(update!.outcome, "unresolved");
  assert.equal(update!.mergeCommit, null);
  assert.equal(branchUpdateLine(update, "claude-code"), "Not brought up to date with main: Claude Code left conflicts unresolved in calc.py, so Botbench undid the merge. The branch is as it was.");
  // It can be tried again.
  assert.deepEqual(await e.tasks.mainStatus(id), { branch: "main", behind: 1 });
});

test("only a task that is ready for review is brought up to date", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { hold: [0] });
  const started = await e.tasks.start(e.repo, "Make add multiply");
  await e.builder.held(0);
  await assert.rejects(e.tasks.updateWithMain(started.id), (err: unknown) => err instanceof TaskError && err.status === 409 && /Only a task that is ready for review/.test(err.message));
  await assert.rejects(e.tasks.updateWithMain(99_999), (err: unknown) => err instanceof TaskError && err.status === 404);
  e.builder.release(0);
  await e.tasks.idle();
});

test("Botbench stopping while the builder resolves the conflicts: the next start undoes the merge and hands the task back, ready for review", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done", "refine"], { hold: [1] });
  const id = await ready(e);
  const before = getTask(e.db, id)!;
  mainMoves(e.repo, "calc.py", "def add(a, b):\n    return b - a\n");
  await e.tasks.updateWithMain(id);
  await e.builder.held(1);
  await e.tasks.close();
  assert.equal(getTask(e.db, id)!.status, "building", "left for the next start");
  assert.equal(git(before.worktreePath!, "rev-parse", "--verify", "--quiet", "MERGE_HEAD").trim().length > 0, true, "the merge was under way");

  const again = e.engine();
  await again.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.headCommit, before.headCommit);
  assert.equal(git(task.worktreePath!, "status", "--porcelain"), "");
  const [update] = taskBranchUpdates(e.db, id);
  assert.equal(update!.outcome, "stopped");
  assert.match(update!.problem!, /Botbench stopped while it was bringing the branch up to date, so it undid the merge/);
});

test("a run that chose to bring its tasks up to date does it before handing a task over, when main moved during the build", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, ["done"], { hold: [0] });
  const base = git(e.repo, "rev-parse", "HEAD").trim();
  const run = storePlan(e.db, createRun(e.db, { repo: e.repo, prompt: "Make add multiply", baseCommit: base, updateWithMain: "auto" }).id, [{ title: "Make add multiply", criteria: ["calc.py multiplies"] }]);
  assert.equal(run.updateWithMain, "auto");
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await e.builder.held(0);
  const mainHead = mainMoves(e.repo, "README.md", "# Calculator\n\nNow with docs.\n");
  e.builder.release(0);
  await e.tasks.idle();
  const task = getTask(e.db, tasks[0]!.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(parents(e.repo, task.headCommit!)[1], mainHead);
  assert.deepEqual(checkRounds(e.db, task.id), ["1:passed", "2:passed"]);
  const [update] = taskBranchUpdates(e.db, task.id);
  assert.equal(update!.requestedBy, "run");
  assert.equal(update!.outcome, "merged");

  // A run that says nothing asks: its task is handed over behind main, and offers it.
  const asked = createRun(e.db, { repo: e.repo, prompt: "x", baseCommit: base });
  assert.equal(asked.updateWithMain, "ask");
});
