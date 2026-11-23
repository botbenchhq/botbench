import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { insertRefinement } from "../../src/engine/refine.ts";
import { createRun, storePlan } from "../../src/engine/run.ts";
import { insertQueuedTask, moveTask } from "../../src/engine/task.ts";
import { startServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { git, initRepo, tempDir, write } from "../support/repo.ts";

// What the API says about the refine loop: the cap on a run, each review and round of fixes on its task, and the
// outcome for the decision point. No driver is started: the task's reviews and rounds of fixes are written as the
// engine writes them (the loop itself is tested in test/engine/refine.test.ts).

const JSON_TYPE = { "content-type": "application/json" };
const REVIEW = "Verdict: concerns\nFindings:\n- calc.py:2: Returns the difference (`a - b`) instead of the sum.";
const REPLY = "I changed it.\n\nAddressed:\n- calc.py:2: now returns a + b\n\nNot addressed, and why:\n- none";

test("a task's reviews, its rounds of fixes, the outcome and its plain line are on the task; the run's cap is on the run and in the settings New run reads", async (t) => {
  const dir = tempDir("botbench-refine-api-");
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, { "README.md": "# Calculator\n" });
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, autonomy: { maxRefineRounds: 3 } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signed = await fetch(`${url}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  const headers = { cookie: signed.headers.getSetCookie()[0]!.split(";")[0]! };
  const get = async (route: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${url}${route}`, { headers });
    assert.equal(res.status, 200, route);
    return (await res.json()) as Record<string, unknown>;
  };

  // A run with Codex reviewing and a cap of 3, and its one task, as approving its plan leaves them.
  const db = server.db;
  const run = createRun(db, { repo, prompt: "Add a function", baseCommit: base, reviewer: { agent: "codex", model: "gpt-6-luna" }, maxRefineRounds: 3 });
  storePlan(db, run.id, [{ title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b), which returns the sum of a and b"] }]);
  const id = insertQueuedTask(db, { runId: run.id, repo, prompt: "Add a function that adds two numbers", requestedModel: null });
  db.prepare("UPDATE plan_tasks SET task_id = ? WHERE run_id = ?").run(id, run.id);
  assert.equal((await get(`/api/runs/${run.id}`)).maxRefineRounds, 3);
  assert.equal((await get("/api/agents")).maxRefineRounds, 3, "New run reads the cap a run started now gets");

  const reviewed = (round: number, verdict: string, text: string, head: string): void =>
    void db.prepare("INSERT INTO reviews (task_id, round, agent, model, attempt_id, outcome, verdict, text, problem, head_commit, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, ?, 'codex', 'gpt-6-luna', NULL, 'reviewed', ?, ?, NULL, ?, 100, 0, ?, ?, 1200)").run(id, round, verdict, text, head, new Date().toISOString(), new Date().toISOString());
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${id}` });
  const attempt = (): number => Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'ended', 'a', 'b')").run().lastInsertRowid);
  moveTask(db, id, "building", { worktree, attemptId: attempt() });
  write(worktree.path, "calc.py", "def add(a, b):\n    return a - b\n");
  const first = ((await commitWork({ path: worktree.path, message: "built" })) as { commit: string }).commit;
  moveTask(db, id, "verifying", { headCommit: first });
  moveTask(db, id, "reviewing", { checks: "failed" });
  reviewed(1, "concerns", REVIEW, first);
  let task = await get(`/api/tasks/${id}`);
  assert.deepEqual([task.reviewOutcome, task.reviewRounds, task.refineRounds], ["unresolved", 1, 0], "while the loop goes on, the outcome so far");

  moveTask(db, id, "building", { note: "round 1 of fixes", attemptId: attempt() });
  write(worktree.path, "calc.py", "def add(a, b):\n    return a + b\n");
  const fixed = ((await commitWork({ path: worktree.path, message: "fixed" })) as { commit: string }).commit;
  insertRefinement(db, { taskId: id, round: 1, attemptId: null, outcome: "finished", changed: true, reply: REPLY, problem: null, fromCommit: first, headCommit: fixed, startedAt: new Date().toISOString() });
  moveTask(db, id, "verifying", { headCommit: fixed });
  moveTask(db, id, "reviewing", { checks: "passed" });
  reviewed(2, "looks_right", "Verdict: looks right\nChecked:\n- calc.py: add returns a + b\n- the criterion: add(a, b) is defined\nNot checked: nothing left out\nFindings:\n- none", fixed);
  moveTask(db, id, "awaiting_decision");

  task = await get(`/api/tasks/${id}`);
  assert.equal(task.reviewOutcome, "satisfied");
  assert.equal(task.reviewRounds, 2);
  assert.equal(task.refineRounds, 1);
  assert.equal(task.maxRefineRounds, 3);
  assert.equal(task.earlierAttempts, 1, "the build's session is kept, and the screen says so above the latest one");
  assert.equal(task.reviewLine, "Codex raised 1 concern. Claude Code addressed 1. Codex is satisfied.");
  assert.equal(task.checks, "passed", "what the checks found for the fixed work");
  const reviews = task.reviews as { round: number; verdict: string; headCommit: string; checked: string[]; accountNote: string | null }[];
  assert.deepEqual(reviews.map((r) => [r.round, r.verdict, r.headCommit]), [[1, "concerns", first], [2, "looks_right", fixed]]);
  // What each review says it checked, for the screen; the first gave no account and carries the plain note.
  assert.deepEqual(reviews.map((r) => [r.checked, r.accountNote]), [[[], "The reviewer gave no account of what it checked."], [["calc.py: add returns a + b", "the criterion: add(a, b) is defined"], null]]);
  assert.equal((task.review as { round: number }).round, 2, "the latest review, as before");
  const refinements = task.refinements as Record<string, unknown>[];
  assert.equal(refinements.length, 1);
  assert.deepEqual(
    { round: refinements[0]!.round, outcome: refinements[0]!.outcome, changed: refinements[0]!.changed, reply: refinements[0]!.reply, fromCommit: refinements[0]!.fromCommit, headCommit: refinements[0]!.headCommit, addressed: refinements[0]!.addressed, notAddressed: refinements[0]!.notAddressed },
    { round: 1, outcome: "finished", changed: true, reply: REPLY, fromCommit: first, headCommit: fixed, addressed: ["calc.py:2: now returns a + b"], notAddressed: [] },
  );
  assert.equal(git(repo, "show", `${fixed}:calc.py`).includes("a + b"), true);

  // The list carries the machine-readable outcome too, for the decision point.
  const listed = ((await get("/api/tasks")).tasks as Record<string, unknown>[]).find((row) => row.id === id)!;
  assert.deepEqual([listed.reviewOutcome, listed.reviewRounds, listed.refineRounds], ["satisfied", 2, 1]);
  // A task of no reviewed run has no outcome.
  const alone = insertQueuedTask(db, { runId: run.id, repo, prompt: "other", requestedModel: null });
  const plain = await get(`/api/tasks/${alone}`);
  assert.deepEqual([plain.reviewOutcome, plain.reviewRounds, plain.refineRounds, plain.reviewLine, plain.reviews, plain.refinements, plain.earlierAttempts], ["none", 0, 0, null, [], [], 0]);
});

