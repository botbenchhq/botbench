import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { approvePlan, createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { usageReport, type UsageReport } from "../src/usage.ts";
import { initRepo, tempDir } from "./support/repo.ts";

// The usage report (unit 22) over a real SQLite database, with attempts and events written as the driver writes them
// (src/drivers/claude-code.ts: one `usage` event at the end of each turn) and runs and tasks made by the engine's own functions.

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const WEEK_START = "2026-11-15T12:00:00.000Z";

function setup(t: { after(fn: () => unknown): void }): { db: DatabaseSync; repo: string } {
  const dir = tempDir("botbench-usage-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  initRepo(repo);
  return { db, repo };
}

function attempt(db: DatabaseSync, driver: string, model: string | null): number {
  return Number(db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES (?, ?, 'ended', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')").run(driver, model).lastInsertRowid);
}

/** One finished turn's usage, as the driver stores it. `extra` is anything else a payload might carry, such as a printed cost. */
function turn(db: DatabaseSync, attemptId: number, ts: string, input: number, output: number, extra: Record<string, unknown> = {}): void {
  const payload = { type: "usage", inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra };
  db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, 'usage', ?)").run(attemptId, ts, JSON.stringify(payload));
}

const report = (db: DatabaseSync, drivers: string[] = ["claude-code"], billing: Record<string, "subscription" | "metered" | "unknown"> = {}): UsageReport => usageReport(db, { now: NOW, drivers, billing });

test("input counts cached tokens too; a stray cost in a stored payload is never read or shown", (t) => {
  const { db } = setup(t);
  const a = attempt(db, "claude-code", "claude-haiku-5-5");
  turn(db, a, "2026-11-20T10:00:00.000Z", 2, 4, { cacheReadTokens: 11384, cacheWriteTokens: 7264, costUsd: 0.0015, total_cost_usd: 0.0015 });
  const r = report(db, ["claude-code"], { "claude-code": "subscription" });
  assert.deepEqual(r.week.agents[0]!.models, [{ model: "claude-haiku-5-5", turns: 1, inputTokens: 18650, outputTokens: 4 }]);
  assert.doesNotMatch(JSON.stringify(r), /cost|usd|dollar|\$/i);
});

test("a driver Botbench has and that did no turns this week is listed with zero turns; a driver only seen in the history is listed too", (t) => {
  const { db } = setup(t);
  const old = attempt(db, "codex", "gpt-x");
  turn(db, old, "2026-10-01T00:00:00.000Z", 10, 5);
  const r = report(db, ["claude-code", "grok"]);
  assert.deepEqual(r.week.agents.map((a) => [a.driver, a.turns, a.models]), [["claude-code", 0, []], ["codex", 0, []], ["grok", 0, []]]);
  assert.deepEqual(r.allTime.agents.map((a) => [a.driver, a.turns]), [["claude-code", 0], ["codex", 1], ["grok", 0]]);
  assert.equal(r.week.turns, 0);
  assert.equal(r.allTime.inputTokens, 10);
});

test("the week is the seven days before now, in UTC: a turn exactly seven days old counts, one millisecond older does not", (t) => {
  const { db } = setup(t);
  const a = attempt(db, "claude-code", "m");
  turn(db, a, "2026-11-15T11:59:59.999Z", 100, 1);
  turn(db, a, WEEK_START, 10, 1);
  turn(db, a, "2026-11-22T12:00:00.000Z", 1, 1);
  const r = report(db);
  assert.equal(r.since, WEEK_START);
  assert.deepEqual([r.week.turns, r.week.inputTokens, r.week.outputTokens], [2, 11, 2]);
  assert.deepEqual([r.allTime.turns, r.allTime.inputTokens], [3, 111]);
});

test("models are grouped per agent; an attempt that never named its model is its own group, not a made-up name", (t) => {
  const { db } = setup(t);
  turn(db, attempt(db, "claude-code", "a"), "2026-11-20T00:00:00.000Z", 1, 1);
  turn(db, attempt(db, "claude-code", "a"), "2026-11-20T00:00:00.000Z", 2, 2);
  turn(db, attempt(db, "claude-code", null), "2026-11-20T00:00:00.000Z", 4, 4);
  const [agent] = report(db).week.agents;
  assert.deepEqual(agent!.models, [{ model: "a", turns: 2, inputTokens: 3, outputTokens: 3 }, { model: null, turns: 1, inputTokens: 4, outputTokens: 4 }]);
  assert.deepEqual([agent!.turns, agent!.inputTokens, agent!.outputTokens], [3, 7, 7]);
});

test("the cost kind of an agent is its sign-in's, and unknown when the sign-in is not known", (t) => {
  const { db } = setup(t);
  const r = report(db, ["claude-code", "grok"], { "claude-code": "subscription" });
  assert.deepEqual(r.week.agents.map((a) => [a.driver, a.billing]), [["claude-code", "subscription"], ["grok", "unknown"]]);
});

test("a run's total is its planner's plus the sum of its tasks, a task counts every attempt it had, and runs come most recent first", (t) => {
  const { db, repo } = setup(t);
  const run = createRun(db, { repo, prompt: "Add a thing", baseCommit: "abc" });
  const planner = attempt(db, "claude-code", "m");
  db.prepare("UPDATE runs SET attempt_id = ? WHERE id = ?").run(planner, run.id);
  db.prepare("INSERT INTO run_events (run_id, ts, status, detail) VALUES (?, '2026-11-20T00:00:00.000Z', 'planning', ?)").run(run.id, `planner attempt ${planner}`);
  turn(db, planner, "2026-11-20T00:00:00.000Z", 5, 1);
  // Two tasks of the run, from its approved plan; the first was re-driven, so its first attempt is known only from the task's history.
  const waiting = storePlan(db, run.id, ["First", "Second"].map((title) => ({ title, criteria: [`${title} is done`] })));
  const ids = approvePlan(db, run.id, waiting.planVersion).tasks.map((task) => task.id);
  const first = attempt(db, "claude-code", "m");
  const redriven = attempt(db, "claude-code", "m");
  const second = attempt(db, "claude-code", "m");
  moveTask(db, ids[0]!, "building", { attemptId: first });
  moveTask(db, ids[0]!, "building", { attemptId: redriven });
  moveTask(db, ids[1]!, "building", { attemptId: second });
  turn(db, first, "2026-11-20T00:00:00.000Z", 10, 2);
  turn(db, redriven, "2026-11-20T00:00:00.000Z", 20, 3);
  turn(db, redriven, "2026-11-20T00:00:00.000Z", 30, 4);
  turn(db, second, "2026-11-20T00:00:00.000Z", 40, 5);
  // A chat attempt belongs to no run: it is in the agent totals and in no run.
  turn(db, attempt(db, "claude-code", "m"), "2026-11-20T00:00:00.000Z", 1000, 1000);
  // A later run with no usage is not listed.
  createRun(db, { repo, prompt: "Nothing yet", baseCommit: "abc" });

  const r = report(db);
  assert.equal(r.runs.total, 1);
  const [one] = r.runs.items;
  assert.equal(one!.id, run.id);
  assert.equal(one!.kind, "planned");
  assert.equal(one!.title, "Add a thing");
  assert.deepEqual(one!.tasks.map((x) => x.title), ["First", "Second"]);
  assert.deepEqual(one!.planning, { turns: 1, inputTokens: 5, outputTokens: 1 });
  assert.deepEqual(one!.tasks.map((x) => [x.id, x.turns, x.inputTokens, x.outputTokens]), [[ids[0], 3, 60, 9], [ids[1], 1, 40, 5]]);
  const sum = (f: (x: { turns: number; inputTokens: number; outputTokens: number }) => number): number => f(one!.planning) + one!.tasks.reduce((n, x) => n + f(x), 0);
  assert.deepEqual([one!.turns, one!.inputTokens, one!.outputTokens], [sum((x) => x.turns), sum((x) => x.inputTokens), sum((x) => x.outputTokens)]);
  assert.deepEqual([one!.turns, one!.inputTokens, one!.outputTokens], [5, 105, 15]);
  assert.equal(r.allTime.turns, 6);
});

test("the run list is capped, most recent first, and says how many runs there are in all", (t) => {
  const { db, repo } = setup(t);
  for (let i = 0; i < 53; i++) {
    const task = createTask(db, { repo, prompt: `Task ${i}` });
    const a = attempt(db, "claude-code", "m");
    moveTask(db, task.id, "building", { attemptId: a });
    turn(db, a, "2026-11-20T00:00:00.000Z", 1, 1);
  }
  const r = report(db);
  assert.equal(r.runs.total, 53);
  assert.equal(r.runs.items.length, 50);
  assert.equal(r.runs.items[0]!.title, "Task 52");
  assert.equal(r.runs.items[0]!.kind, "single");
  assert.equal(r.runs.items[49]!.title, "Task 3");
});
