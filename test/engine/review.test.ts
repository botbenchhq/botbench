import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, type Broker } from "../../src/approvals/broker.ts";
import { CODEX_CAPABILITIES } from "../../src/drivers/codex.ts";
import { taskReview } from "../../src/engine/review.ts";
import { MAX_REVIEW_DIFF, parseVerdict, PLANNER, IMPLEMENTER, REVIEWER, reviewerPrompt, roleProblem, sameModelProblem, type PlanTask } from "../../src/engine/roles.ts";
import { createRun, createRuns, getRun, storePlan, type Run, type Runs } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type BuildReplay } from "../support/replay-build.ts";
import { reviewReplayDriver, type ReviewReplay, type ReviewSession } from "../support/replay-review.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// The review station (U20, in part): after the checks, a run's reviewer reads the task's diff and its critique is stored
// on the task. No test here starts a CLI: the builder's turn is replayed from a real Claude Code session
// (test/support/replay-build.ts) and the reviewer's from a real `codex exec` session (test/support/replay-review.ts),
// with real SQLite, a real temporary repository and real setup and check commands. A real review is in
// test/live/review.live.test.ts.

type T = { after(fn: () => unknown): void };
const ONE: PlanTask[] = [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }];
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });

interface Line {
  db: DatabaseSync;
  home: string;
  repo: string;
  base: string;
  broker: Broker;
  builder: BuildReplay;
  reviewer: ReviewReplay;
  tasks: Tasks;
  runs: Runs;
  states: string[];
}

async function line(t: T, session: ReviewSession, o: { setup?: StationCommand[]; checks?: StationCommand[]; limitMs?: number; reviewer?: ReviewReplay } = {}): Promise<Line> {
  const dir = tempDir("botbench-review-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(["done", "done"], { hold: [] });
  const reviewer = o.reviewer ?? reviewReplayDriver(session);
  const states: string[] = [];
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", reviewers: { codex: reviewer }, ...(o.limitMs ? { reviewLimitMs: o.limitMs } : {}), repoCommands: () => ({ setup: o.setup ?? [cmd("printf 'hi\\n' > hello.txt")], checks: o.checks ?? [cmd("test -f hello.txt")] }), onEvent: () => {}, onTaskChange: (task) => states.push(task.status) });
  const runs = createRuns({ db, home, driver: builder, broker, model: "haiku", implementerModel: "haiku", reviewers: { codex: reviewer }, line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo, base, broker, builder, reviewer, tasks, runs, states };
}

/** A run waiting for its plan's approval, with Codex as its reviewer. */
function planned(e: Line, reviewer: { agent: string; model: string | null } | null = { agent: "codex", model: "gpt-6-luna" }): Run {
  const run = createRun(e.db, { repo: e.repo, prompt: "Add a file", baseCommit: e.base, reviewer });
  return storePlan(e.db, run.id, ONE);
}

async function builtTask(e: Line, reviewer?: { agent: string; model: string | null } | null): Promise<number> {
  const run = planned(e, reviewer);
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  await e.tasks.idle();
  return tasks[0]!.id;
}

test("R5: after the checks, Codex reads the task's title, criteria and diff, and its critique is stored on the task with its verdict; then the task is Ready for review", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "review");
  const id = await builtTask(e);
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.checks, "passed");
  const at = e.states.indexOf("reviewing");
  assert.ok(at > e.states.indexOf("verifying") && at < e.states.indexOf("awaiting_decision"), e.states.join(" "));

  // The reviewer worked read-only, in the task's copy, with no way to ask for permission and no network.
  assert.equal(e.reviewer.started.length, 1);
  const started = e.reviewer.started[0]!;
  assert.equal(started.readOnly, true);
  assert.equal(started.allowEdits, undefined);
  assert.equal(started.gate, undefined);
  assert.equal(started.cwd, task.worktreePath);
  assert.deepEqual(started.confinement.allowedHosts, []);
  assert.ok(started.confinement.gitDir, "the repository's git folder is named, to be read and never written");
  assert.equal(started.model, "gpt-6-luna");
  // Its own web search, which OpenAI runs, as "Web access in chat" allows it (Allow until the owner changes it).
  assert.equal(started.webSearch, true);

  const prompt = e.reviewer.prompts[0]!;
  assert.match(prompt, /Add a greeting file/);
  assert.match(prompt, /- hello\.txt holds the word hi/);
  assert.match(prompt, /\+\+\+ b\/hello\.txt\n@@ -0,0 \+1 @@\n\+hi/, "the real diff from the base commit to the task's branch");

  const review = taskReview(e.db, id)!;
  assert.equal(review.agent, "codex");
  assert.equal(review.model, "gpt-6-luna");
  assert.equal(review.outcome, "reviewed");
  assert.equal(review.verdict, "concerns");
  assert.match(review.text, /^Verdict: concerns\nFindings:\n- calc\.py:2:/);
  assert.equal(review.problem, null);
  assert.equal(review.diffCut, false);
  assert.ok(review.attemptId !== null);
  assert.equal(e.reviewer.closed(), 1, "the reviewer's session is closed");
});

test("a reviewer that fails (here signed out: Codex retried and gave up) is recorded in plain words, and the task still reaches Ready for review", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "signed-out");
  const id = await builtTask(e);
  assert.equal(getTask(e.db, id)!.status, "awaiting_decision");
  const review = taskReview(e.db, id)!;
  assert.equal(review.outcome, "failed");
  assert.equal(review.verdict, null);
  assert.equal(review.text, "");
  assert.match(review.problem!, /^Codex could not review this task: .*401 Unauthorized/);
});

test("a reviewer that cannot start (the agent reports a problem) is recorded with that problem, and the task still reaches Ready for review", { skip: NO_SANDBOX }, async (t) => {
  const blocked = reviewReplayDriver("review", { problem: "Codex is signed out. Run `codex login` in a terminal." });
  const e = await line(t, "review", { reviewer: blocked, checks: [] });
  const made = [{ id: await builtTask(e) }];
  const task = getTask(e.db, made[0]!.id)!;
  assert.deepEqual([task.status, task.checks], ["awaiting_decision", "none"], task.reason ?? "");
  const review = taskReview(e.db, task.id)!;
  assert.equal(review.outcome, "failed");
  assert.equal(review.problem, "Codex could not review this task: Codex is signed out. Run `codex login` in a terminal.");
  assert.equal(review.attemptId, null, "nothing was started");
});

test("a reviewer still working when its time limit passes is stopped and recorded as out of time, and the task still reaches Ready for review", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "hang", { limitMs: 300 });
  const id = await builtTask(e);
  assert.equal(getTask(e.db, id)!.status, "awaiting_decision");
  const review = taskReview(e.db, id)!;
  assert.equal(review.outcome, "timed_out");
  assert.match(review.problem!, /did not finish within 0\.3 seconds and was stopped/);
  assert.equal(e.reviewer.closed(), 1);
});

test("a diff longer than the reviewer is sent is cut, and the prompt and the stored review say so", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "review", { setup: [cmd(`awk 'BEGIN { for (i = 0; i < 4000; i++) print "line number " i " of a long file" }' > long.txt`)], checks: [] });
  const id = await builtTask(e);
  const prompt = e.reviewer.prompts[0]!;
  const review = taskReview(e.db, id)!;
  assert.equal(review.diffCut, true);
  assert.ok(review.diffChars > MAX_REVIEW_DIFF);
  assert.match(prompt, new RegExp(`The diff is ${review.diffChars} characters long and was cut after the first ${MAX_REVIEW_DIFF}\\.`));
  assert.ok(prompt.length < MAX_REVIEW_DIFF + 5_000);
});

test("a run without a reviewer, and a task started on its own, are not reviewed", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "review");
  const id = await builtTask(e, null);
  assert.equal(getTask(e.db, id)!.status, "awaiting_decision");
  const alone = await e.tasks.start(e.repo, "create hello.txt");
  await e.tasks.idle();
  assert.equal(getTask(e.db, alone.id)!.status, "awaiting_decision");
  assert.equal(taskReview(e.db, id), null);
  assert.equal(taskReview(e.db, alone.id), null);
  assert.equal(e.reviewer.started.length, 0);
  assert.equal(e.states.includes("reviewing"), false);
});

test("a review is append-only: it is never changed, removed or replaced, and a run's reviewer is fixed once it starts", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "review");
  const id = await builtTask(e);
  const row = e.db.prepare("SELECT * FROM reviews WHERE task_id = ?").get(id)!;
  assert.throws(() => e.db.prepare("UPDATE reviews SET text = 'x' WHERE task_id = ?").run(id), /append-only/);
  assert.throws(() => e.db.prepare("DELETE FROM reviews WHERE task_id = ?").run(id), /append-only/);
  assert.throws(() => e.db.prepare("INSERT OR REPLACE INTO reviews (id, task_id, agent, model, outcome, text, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, ?, 'codex', 'x', 'reviewed', 'forged', 1, 0, 'a', 'b', 1)").run(Number(row.id), id), /append-only|review station/);
  assert.throws(() => e.db.prepare("UPDATE runs SET reviewer_agent = NULL WHERE id = ?").run(getTask(e.db, id)!.runId!), /reviewer/);
  assert.equal(taskReview(e.db, id)!.text.startsWith("Verdict: concerns"), true);
});

test("a run cancelled while its task is being reviewed ends the task as cancelled, with the review recorded as stopped", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "hang", { checks: [] });
  const run = planned(e);
  const { tasks } = e.runs.approve(run.id, run.planVersion);
  const id = tasks[0]!.id;
  const deadline = Date.now() + 10_000;
  while (getTask(e.db, id)!.status !== "reviewing") {
    assert.ok(Date.now() < deadline, `never reviewing: ${getTask(e.db, id)!.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  e.runs.cancel(run.id);
  await e.tasks.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "cancelled");
  assert.match(task.reason!, /while this task was being reviewed/);
  assert.equal(taskReview(e.db, id)!.outcome, "stopped");
  assert.equal(getRun(e.db, run.id)!.status, "cancelled");
});

test("a task left being reviewed when Botbench stopped has its review recorded as unfinished at the next start, and is Ready for review with its work kept", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "hang", { checks: [] });
  const run = planned(e);
  const id = e.runs.approve(run.id, run.planVersion).tasks[0]!.id;
  const deadline = Date.now() + 10_000;
  while (getTask(e.db, id)!.status !== "reviewing") {
    assert.ok(Date.now() < deadline, `never reviewing: ${getTask(e.db, id)!.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // A new start on the same store, as after Botbench was killed mid-review: its recovery finds the task at the review station.
  const after = createTasks({ db: e.db, home: e.home, driver: e.builder, broker: e.broker, reviewers: { codex: e.reviewer }, onEvent: () => {}, onTaskChange: () => {} });
  await after.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision");
  const review = taskReview(e.db, id)!;
  assert.deepEqual([review.outcome, review.problem, review.text], ["stopped", "Botbench stopped before Codex finished its review.", ""]);
  assert.ok(task.headCommit !== null && task.headCommit !== task.baseCommit);
  await after.close();
});

test("a run started with Codex as its reviewer keeps that choice; one whose reviewer cannot be used now is refused in the agent's own words and not stored", async (t) => {
  const e = await line(t, "review");
  const run = await e.runs.start({ repo: e.repo, prompt: "Add a file", reviewer: { agent: "codex", model: "gpt-6-luna" } });
  assert.deepEqual(getRun(e.db, run.id)!.reviewer, { agent: "codex", model: "gpt-6-luna" });
  const blocked = await line(t, "review", { reviewer: reviewReplayDriver("review", { problem: "Codex is signed out. Run `codex login` in a terminal." }) });
  await assert.rejects(blocked.runs.start({ repo: blocked.repo, prompt: "Add a file", reviewer: { agent: "codex", model: null } }), { status: 400, message: "Codex cannot review this run: Codex is signed out. Run `codex login` in a terminal." });
  assert.equal(blocked.db.prepare("SELECT count(*) AS n FROM runs").get()!.n, 0);
});

test("roles: Codex cannot be the builder or the planner, for what it lacks, and can review; a reviewer on the builder's own agent and model is refused", () => {
  assert.match(roleProblem(IMPLEMENTER, "codex", CODEX_CAPABILITIES)!, /^Codex cannot be the builder: in Botbench it cannot ask you for permission or edit files/);
  assert.match(roleProblem(PLANNER, "codex", CODEX_CAPABILITIES)!, /^Codex cannot be the planner/);
  assert.equal(roleProblem(REVIEWER, "codex", CODEX_CAPABILITIES), null);
  assert.equal(roleProblem(IMPLEMENTER, "claude-code", { resume: true, interrupt: true, permissionRequests: true, edits: true }), null);
  assert.match(sameModelProblem({ agent: "claude-code", model: "haiku" }, { agent: "claude-code", model: "haiku" })!, /different model from the builder/);
  assert.match(sameModelProblem({ agent: "claude-code", model: null }, { agent: "claude-code", model: null })!, /its own default model/);
  assert.equal(sameModelProblem({ agent: "claude-code", model: "haiku" }, { agent: "claude-code", model: "sonnet" }), null);
  assert.equal(sameModelProblem({ agent: "claude-code", model: "gpt-6-luna" }, { agent: "codex", model: "gpt-6-luna" }), null);
});

test("the review's verdict is read only from its first line in the asked form", () => {
  assert.equal(parseVerdict("Verdict: looks right\nFindings:\n- none"), "looks_right");
  assert.equal(parseVerdict("**Verdict: concerns**\nFindings:\n- a.ts:3: off by one"), "concerns");
  assert.equal(parseVerdict("I think it looks right.\nVerdict: concerns"), null);
  assert.equal(parseVerdict(""), null);
  const prompt = reviewerPrompt({ task: ONE[0]!, diff: "", cut: null });
  assert.match(prompt, /\(The task changed no file\.\)/);
  assert.match(prompt, /Verdict: looks right\nChecked:\n/);
});

