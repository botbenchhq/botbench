import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, type Broker } from "../../src/approvals/broker.ts";
import { CODEX_CAPABILITIES } from "../../src/drivers/codex.ts";
import { RESTART_STOPPED } from "../../src/engine/recover.ts";
import { setChatWebAccess } from "../../src/approvals/web-access.ts";
import { parseIssueView } from "../../src/github.ts";
import { capIssue, storeIssue } from "../../src/engine/intake.ts";
import { runReview, taskReview, type Review } from "../../src/engine/review.ts";
import { now } from "../../src/store/db.ts";
import { commitsDiff } from "../../src/worktrees.ts";
import { MAX_REVIEW_PARTS, parseVerdict, REVIEW_PART_CHARS, splitDiff, PLANNER, IMPLEMENTER, REVIEWER, reviewerPrompt, roleProblem, sameModelProblem, type PlanTask } from "../../src/engine/roles.ts";
import { createRun, createRuns, getRun, storePlan, type Run, type Runs } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type BuildReplay } from "../support/replay-build.ts";
import { ISSUE_NUMBER, ISSUE_REPO, loadIssueCapture } from "../support/replay-issue.ts";
import { reviewReplayDriver, type ReviewReplay, type ReviewSession } from "../support/replay-review.ts";
import { initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";
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

test("CRITICAL: a reviewer that cannot ask gets no web search in a run started from a GitHub issue, whatever Web access says, and on Off or Ask in any run; only Allow turns it on for a run that read no outside text", { skip: NO_SANDBOX }, async (t) => {
  const e = await line(t, "review");
  const view = parseIssueView(loadIssueCapture().outputs.issue.result.stdout, ISSUE_REPO, ISSUE_NUMBER);
  const issue = storeIssue(e.db, fs.realpathSync(e.repo), capIssue(view, "github.com/cli/cli"));
  const fromIssue = storePlan(e.db, createRun(e.db, { repo: e.repo, baseCommit: e.base, issue: { fetchId: issue.id, allowHosts: false }, mode: "manual", reviewer: { agent: "codex", model: "gpt-6-luna" } }).id, ONE);
  e.runs.approve(fromIssue.id, fromIssue.planVersion);
  await e.tasks.idle();
  assert.equal(e.reviewer.started.length, 1);
  assert.notEqual(e.reviewer.started[0]!.webSearch, true, "a run from an issue always asks, and a reviewer cannot ask: no search");
  assert.doesNotMatch(e.reviewer.prompts[0]!, /your own web search/);
  for (const setting of ["off", "ask"] as const) {
    setChatWebAccess(e.db, setting);
    await builtTask(e);
    assert.notEqual(e.reviewer.started.at(-1)!.webSearch, true, setting);
  }
});

test("CRITICAL: every command a reviewer that cannot ask runs is in the append-only action log under its task, once, as run in its own sandbox without asking", { skip: NO_SANDBOX }, async (t) => {
  // Constructed lines in the form `codex exec --json` 0.171.0 prints, then the recorded review's own lines: no Codex ran.
  const review = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "codex-review.json"), "utf8")).sessions.review.lines as string[];
  const ran = [
    '{"type":"item.started","item":{"id":"item_9","type":"command_execution","command":"/bin/zsh -lc \'git diff --stat\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"/bin/zsh -lc \'git diff --stat\'","aggregated_output":" hello.txt | 1 +","exit_code":0,"status":"completed"}}',
  ];
  const e = await line(t, "review", { reviewer: reviewReplayDriver({ lines: [review[0]!, ...ran, ...review.slice(1)] }) });
  const id = await builtTask(e);
  const task = getTask(e.db, id)!;
  const logged = actionLog(e.db, id).filter((entry) => entry.rule === "sandboxed");
  assert.deepEqual(logged.map((entry) => [entry.tool, entry.command, entry.cwd]), [["shell", "/bin/zsh -lc 'git diff --stat'", task.worktreePath]]);
  assert.match(logged[0]!.detail ?? "", /Codex cannot ask you, so it ran this without asking, kept by its own sandbox to the task's copy, read-only/);
});

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
  assert.match(prompt, /Every file the task's work changed, 1 file, with the lines each added and removed:\n<changed-files>\n- hello\.txt \(1 line added, 0 lines removed\)\n<\/changed-files>/, "the files read from the real branch, with their sizes");

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

/**
 * A task at the review station whose branch adds hello.txt and a long.txt of `lines` lines, committed in a real
 * temporary repository and stored in a real database, reviewed by `runReview` itself with `session` replayed. No
 * builder, broker or check runs, so these need no sandbox of their own.
 */
async function reviewLong(t: T, session: ReviewSession, lines: number, o: { limitMs?: number } = {}): Promise<{ db: DatabaseSync; review: Review; reviewer: ReviewReplay; diff: string }> {
  const dir = tempDir("botbench-review-parts-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  write(repo, "hello.txt", "hi\n");
  write(repo, "long.txt", Array.from({ length: lines }, (_, i) => `line number ${i} of a long file\n`).join(""));
  const head = ownerCommit(repo, "the task's work");
  const at = now();
  const taskId = Number(db.prepare("INSERT INTO tasks (repo_path, prompt, status, worktree_path, base_commit, head_commit, created_at, updated_at) VALUES (?, 'p', 'reviewing', ?, ?, ?, ?, ?)").run(repo, repo, base, head, at, at).lastInsertRowid);
  const reviewer = reviewReplayDriver(session);
  const review = await runReview({ db, driver: reviewer, model: "gpt-6-luna", taskId, task: ONE[0]!, worktree: repo, baseCommit: base, headCommit: head, confinement: { dataDir: path.join(dir, "home"), allowedHosts: ["example.com"] }, ...o });
  return { db, review, reviewer, diff: await commitsDiff({ path: repo, baseCommit: base, headCommit: head }) };
}
/** The parts of a diff as the reviewer's prompt holds them, in order. */
const sentParts = (prompt: string): string[] => [...prompt.matchAll(/<diff part="\d+ of \d+">\n([\s\S]*?)\n<\/diff>/g)].map((m) => m[1]!);

test("a diff longer than the old cut of 60,000 characters is sent whole, in parts in order after the file list with sizes, and stored as not cut with the verdict of the reply", async (t) => {
  const { db, review, reviewer, diff } = await reviewLong(t, "review", 4_000);
  assert.ok(diff.length > 60_000, `a diff of ${diff.length} characters`);
  // The reviewer started read-only and reaches no host, whatever the repository allows.
  assert.equal(reviewer.started[0]!.readOnly, true);
  assert.deepEqual(reviewer.started[0]!.confinement.allowedHosts, []);
  assert.equal(reviewer.prompts.length, 1, "one message, the one a Codex session takes");
  const prompt = reviewer.prompts[0]!;
  const parts = sentParts(prompt);
  assert.deepEqual(parts, splitDiff(diff));
  assert.ok(parts.length > 1 && parts.length <= MAX_REVIEW_PARTS, `${parts.length} parts`);
  assert.equal(parts.join(""), diff, "every part reached the reviewer, in order: together they are the whole diff");
  for (const part of parts) assert.ok(part.length <= REVIEW_PART_CHARS);
  const list = prompt.indexOf("<changed-files>\n- hello.txt (1 line added, 0 lines removed)\n- long.txt (4000 lines added, 0 lines removed)\n</changed-files>");
  assert.ok(list > 0 && list < prompt.indexOf("<diff"), "the file list with sizes comes before any diff text");
  assert.match(prompt, new RegExp(`Below is all of it, in ${parts.length} parts\\.`));
  assert.ok(prompt.endsWith(`That was part ${parts.length} of ${parts.length}, the last: you have the whole diff, ${diff.length} characters. Now reply, once, in the form above.`));
  assert.doesNotMatch(prompt, /saw only part|was left out/);

  assert.deepEqual([review.outcome, review.diffCut, review.diffChars], ["reviewed", false, diff.length]);
  assert.deepEqual(review.diffSent, { parts: parts.length, chars: diff.length });
  assert.equal(review.verdict, "concerns", "read from the reply to the message that held the last part");
  assert.match(review.text, /^Verdict: concerns\nFindings:\n- calc\.py:2:/);
  assert.equal(db.prepare("SELECT diff_cut FROM reviews WHERE id = ?").get(review.id)!.diff_cut, 0);
});

test("only a diff longer than the most parts is cut: the prompt says how much was sent, and the stored review says it was cut", async (t) => {
  // About 33 characters a line: more than MAX_REVIEW_PARTS parts of REVIEW_PART_CHARS.
  const { db, review, reviewer, diff } = await reviewLong(t, "review", Math.ceil((MAX_REVIEW_PARTS * REVIEW_PART_CHARS) / 30));
  const prompt = reviewer.prompts[0]!;
  const parts = sentParts(prompt);
  const sent = parts.join("").length;
  assert.equal(parts.length, MAX_REVIEW_PARTS);
  assert.equal(parts.join(""), diff.slice(0, sent), "the parts sent are the diff's start, in order");
  assert.deepEqual([review.outcome, review.diffCut, review.diffChars], ["reviewed", true, diff.length]);
  assert.equal(db.prepare("SELECT diff_cut FROM reviews WHERE id = ?").get(review.id)!.diff_cut, 1);
  assert.ok(diff.length > sent);
  assert.match(prompt, new RegExp(`It is too long to send whole: below are its first ${MAX_REVIEW_PARTS} parts, ${sent} characters, of the \\d+ parts it makes\\.`));
  assert.ok(prompt.endsWith(`That was part ${MAX_REVIEW_PARTS} of ${MAX_REVIEW_PARTS}, the last one sent: you have the first ${sent} of the diff's ${diff.length} characters, and the rest was left out. Read the rest from the files if you need it, and say in your findings that you saw only part of it. Now reply, once, in the form above.`));
  assert.deepEqual(review.diffSent, { parts: MAX_REVIEW_PARTS, chars: sent });
});

test("a reviewer sent a diff in parts that fails, or runs out of time, leaves the failed or timed-out review with its problem and no text", async (t) => {
  const failed = await reviewLong(t, "signed-out", 4_000);
  assert.ok(sentParts(failed.reviewer.prompts[0]!).length > 1);
  assert.deepEqual([failed.review.outcome, failed.review.verdict, failed.review.text, failed.review.diffCut], ["failed", null, "", false]);
  assert.match(failed.review.problem!, /^Codex could not review this task: .*401 Unauthorized/);

  const late = await reviewLong(t, "hang", 4_000, { limitMs: 300 });
  assert.ok(sentParts(late.reviewer.prompts[0]!).length > 1);
  assert.deepEqual([late.review.outcome, late.review.verdict, late.review.text], ["timed_out", null, ""]);
  assert.match(late.review.problem!, /did not finish within 0\.3 seconds and was stopped/);
  assert.equal(late.reviewer.closed(), 1);
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
  // The reviewer's turn is under way: its attempt is written and its prompt sent. Reviewing is set before the reviewer's
  // CLI starts, so without this wait the next start could find no reviewer attempt yet, or one newer than itself.
  const reviewerTurn = (): number | undefined => {
    const row = e.db.prepare("SELECT a.id FROM attempts a WHERE a.driver = 'codex' AND EXISTS (SELECT 1 FROM events v WHERE v.attempt_id = a.id AND v.type = 'user_prompt') ORDER BY a.id DESC LIMIT 1").get();
    return row === undefined ? undefined : Number(row.id);
  };
  while (reviewerTurn() === undefined) {
    assert.ok(Date.now() < deadline, "the reviewer's turn never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const reviewer = reviewerTurn()!;
  // Recovery takes up only rows from before its own start, compared by the millisecond.
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A new start on the same store, as after Botbench was killed mid-review: its recovery finds the task at the review station.
  const after = createTasks({ db: e.db, home: e.home, driver: e.builder, broker: e.broker, reviewers: { codex: e.reviewer }, onEvent: () => {}, onTaskChange: () => {} });
  await after.idle();
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "awaiting_decision");
  const review = taskReview(e.db, id)!;
  // What the review view shows for it, by the words the transcript uses for the turn.
  assert.deepEqual([review.outcome, review.problem, review.text], ["stopped", `${RESTART_STOPPED}. Codex did not finish its review.`, ""]);
  // The reviewer's own turn, which the restart cut off, ends as stopped once, and its attempt runs no more.
  assert.equal(e.db.prepare("SELECT status FROM attempts WHERE id = ?").get(reviewer)!.status, "interrupted");
  const ends = e.db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'turn_ended'").all(reviewer).map((r) => JSON.parse(String(r.payload)));
  assert.deepEqual(ends, [{ type: "turn_ended", reason: "interrupted", detail: RESTART_STOPPED }]);
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
  const prompt = reviewerPrompt({ task: ONE[0]!, files: [], diff: "" });
  assert.match(prompt, /\(The task changed no file\.\)/);
  assert.match(prompt, /Verdict: looks right\nChecked:\n/);
});

