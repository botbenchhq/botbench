import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBroker, listApprovals, waitingOnApproval } from "../../src/approvals/broker.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { createRun, createRuns, storePlan } from "../../src/engine/run.ts";
import { createTasks, getTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { loadQuestionRecording, NO_QUESTION_RECORDING, questionTurn } from "../support/replay-question.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// A builder that asks the owner a question, through the real engine, broker, store and git, with no model turn: the
// builder's turn is the real Claude Code session recorded by test/support/capture-question.ts, replayed
// (test/support/replay-build.ts). Until the owner has made that recording, this test is skipped and says so.

type T = { after(fn: () => unknown): void };

async function until(what: string, done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("replayed from a real session: a builder's question is a card of its own and its task needs input; the owner's answer reaches Claude Code and the turn goes on to the end", { skip: NO_QUESTION_RECORDING || NO_SANDBOX }, async (t: T) => {
  const recording = loadQuestionRecording();
  assert.equal(recording.finding.tool, "AskUserQuestion", "what the capture found the CLI calls the tool");
  assert.equal(recording.finding.controlRequest, "can_use_tool");
  const dir = tempDir("botbench-question-engine-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const driver = buildReplayDriver([questionTurn()]);
  // The recorded turn changes no file: the repository's setup writes one, so the task has work to hand over.
  const tasks = createTasks({ db, home, driver, broker, model: "haiku", repoCommands: () => ({ setup: [{ command: "echo built > setup-output.txt", limitMs: 10_000 }], checks: [] }), repoHosts: () => [], onEvent: () => {}, onTaskChange: () => {}, onRunChange: () => {} });
  const runs = createRuns({ db, home, driver, broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = storePlan(db, createRun(db, { repo, prompt: "Greet", baseCommit: base }).id, [{ title: "Greet", criteria: ["It greets"] }]);
  const taskId = runs.approve(run.id, run.planVersion).tasks[0]!.id;

  await until("the question waits for the owner", () => broker.pending().length === 1);
  const [card] = broker.pending();
  const asked = recording.events.find((e): e is Extract<DriverEvent, { type: "permission_request" }> => e.type === "permission_request" && e.name === "AskUserQuestion")!;
  const text = (asked.input as { questions: { question: string }[] }).questions[0]!.question;
  assert.deepEqual([card!.taskId, card!.tool, card!.command, card!.question?.text, card!.answer], [taskId, "AskUserQuestion", text, text, null], "a question of its own kind, not a command");
  assert.ok(card!.question!.choices.length >= 2 && card!.question!.choices.length <= 4);
  assert.equal(waitingOnApproval(db, taskId), true, "Needs input, as for a waiting approval");
  assert.equal(getTask(db, taskId)!.status, "building");

  // The answer the recording was given: the replay goes on only after exactly that, keyed by the question (replay-build.ts).
  assert.ok(card!.question!.choices.some((c) => c.label === recording.answer), "the recorded answer is one of the choices");
  broker.answerQuestion(card!.id, recording.answer);
  await tasks.idle();
  assert.equal(getTask(db, taskId)!.status, "awaiting_decision", "the turn went on after the answer and the task was built");
  assert.deepEqual(listApprovals(db).map((a) => [a.status, a.answer]), [["allowed", recording.answer]]);
  const attemptId = getTask(db, taskId)!.attemptId!;
  const events = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);
  const resolved = events.findIndex((e) => e.type === "permission_resolved" && e.decision === "answered");
  assert.ok(resolved > 0, "the answer is in the transcript");
  assert.equal((events[resolved] as { note: string }).note, recording.answer);
  assert.ok(events.slice(resolved + 1).some((e) => e.type === "text"), "the agent went on and wrote after the answer");
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
});
