import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, type Broker } from "../../src/approvals/broker.ts";
import { decideTask, taskDecision } from "../../src/engine/decision.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { createRun, createRuns, storePlan, type Runs } from "../../src/engine/run.ts";
import { taskEvidence, type StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, resumeNote, type Tasks } from "../../src/engine/task.ts";
import { reviewAssignment } from "../../src/engine/review.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver, type BuildReplay, type BuildTurn } from "../support/replay-build.ts";
import { loadPlanRecording } from "../support/replay-plan.ts";
import { reviewReplayDriver, type ReviewReplay } from "../support/replay-review.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// A builder's turn that ends without changing any file is not work to review (run 2, task 3 of the self-review, where the
// builder left its work to subagents and ended): with real SQLite, a real temporary repository, a real check command and
// the real permission broker. The builder's turns are replayed from real Claude Code sessions (test/support/replay-build.ts):
// "done" is a real turn that wrote text and made no edit; "refine" is a real turn that edited calc.py.

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 10_000 });
const ONE = [{ title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b)"] }];

interface Line {
  db: DatabaseSync;
  repo: string;
  base: string;
  broker: Broker;
  builder: BuildReplay;
  reviewer: ReviewReplay;
  tasks: Tasks;
  runs: Runs;
}

async function line(t: T, script: readonly BuildTurn[]): Promise<Line> {
  const dir = tempDir("botbench-no-change-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, { "calc.py": "def add(a, b):\n    return a - b\n" });
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const builder = buildReplayDriver(script);
  const reviewer = reviewReplayDriver(["review"]);
  // No setup command: whatever is on the branch, the builder wrote. The check passes on unchanged code, as it did in run 2.
  const repoCommands = () => ({ setup: [], checks: [cmd("test -f calc.py")] });
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", reviewers: { codex: reviewer }, repoCommands, onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home, driver: builder, broker, model: "haiku", implementerModel: "haiku", reviewers: { codex: reviewer }, line: tasks, repoCommands, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, repo, base, broker, builder, reviewer, tasks, runs };
}

async function oneTask(e: Line, mode: RunMode, reviewed = true): Promise<number> {
  const run = createRun(e.db, { repo: e.repo, prompt: "Fix add", baseCommit: e.base, mode, reviewer: reviewed ? { agent: "codex", model: null } : null });
  const stored = storePlan(e.db, run.id, ONE);
  const { tasks } = e.runs.approve(stored.id, stored.planVersion);
  await e.tasks.idle();
  return tasks[0]!.id;
}

/** The builder's last message in the recorded "done" turn. */
const lastText = (): string => {
  const texts = loadPlanRecording().turns[0]!.events.flatMap((event) => (event.type === "text" ? [event.text] : []));
  return texts.at(-1)!;
};

test("a builder that changed no file fails, saying so with its last message; no checks or review ran, and it cannot be accepted, but it can be resumed or discarded", async (t) => {
  const e = await line(t, ["done"]);
  const id = await oneTask(e, "manual");
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "failed");
  assert.ok(task.reason!.startsWith("Claude Code finished without changing any file."), task.reason!);
  assert.ok(task.reason!.includes(lastText().trim().slice(0, 60)), "the builder's last message is the detail");
  assert.equal(task.headCommit, e.base, "nothing was committed on top of the base");
  assert.deepEqual(taskEvidence(e.db, id).filter((row) => row.kind === "check"), [], "the checks did not run on unchanged code");
  assert.equal(e.reviewer.started.length, 0, "the reviewer was not asked to review an empty change");
  assert.ok(reviewAssignment(e.db, id) !== null);
  await assert.rejects(decideTask(e.db, { taskId: id, decision: "accept" }), /not ready for review/);
  assert.match(resumeNote(e.db, task) ?? "", /^Resume starts Claude Code again/);
  assert.ok(fs.existsSync(task.worktreePath!), "its copy stays, for Resume or Discard");
});

test("Resume of a task that changed nothing takes up the same session, says what happened, and goes on to the checks once it changed something", async (t) => {
  const e = await line(t, ["done", "refine"]);
  const id = await oneTask(e, "manual");
  assert.equal(getTask(e.db, id)!.status, "failed");
  const first = e.db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(getTask(e.db, id)!.attemptId!)!.resume_cursor;
  e.tasks.resume(id);
  await e.tasks.idle();
  // The second attempt is the resume; a third is the round of fixes the recorded review asks for.
  assert.ok(e.builder.started.length >= 2);
  assert.equal(e.builder.started[1]!.resumeCursor, first, "the same session");
  assert.match(e.builder.prompts[1]!, /^\[From Botbench, not from the owner\] Your last turn ended without changing any file/);
  assert.deepEqual(taskEvidence(e.db, id).filter((row) => row.kind === "check").map((row) => `${row.round}:${row.outcome}`), ["1:passed"], "checked once it changed something");
  assert.equal(e.reviewer.started.length, 1, "and reviewed");
  assert.equal(getTask(e.db, id)!.status, "awaiting_decision");
});

test("fully autonomous never accepts an empty change, even with its check passing and no reviewer: the task fails and nothing is decided", async (t) => {
  const e = await line(t, ["done"]);
  const id = await oneTask(e, "full", false);
  const task = getTask(e.db, id)!;
  assert.equal(task.status, "failed");
  assert.equal(taskDecision(e.db, id), null);
  assert.ok(!actionLog(e.db, id).some((entry) => entry.rule === "mode_accepted"));
});
