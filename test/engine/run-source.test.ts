import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker } from "../../src/approvals/broker.ts";
import { createRun, createRuns, getRun, RunError, type Runs } from "../../src/engine/run.ts";
import { checkSource, MAX_RUN_NOTE, noteProblem, ownerMessages, runsMadeFrom, sourceGiven, sourceOf, sourcePrompt, NOTE_EMPTY, noteTooLong } from "../../src/engine/run-source.ts";
import { createTasks, getTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { loadPlanRecording, planReplayDriver, THREE_TASKS, type PlanReplay } from "../support/replay-plan.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { BUILDER_SAID, finishedTask, recordedChat, REVIEWER_SAID } from "../support/run-source.ts";

// "Make this a run": the owner's feedback on a finished task or a chat becomes a new run. Real SQLite, a real temporary
// git repository, the real broker, and the planner replayed from a real Claude Code session (test/support/replay-plan.ts).
// Only the owner's own words and Botbench's own records (a task's id and branch) reach the new run's planner.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  home: string;
  repo: string;
  other: string;
  base: string;
  planner: PlanReplay;
  runs: Runs;
}

/** A store and two repositories, with no engine: for what is decided in the store and in plain checks. */
function stored(t: T): Pick<Rig, "db" | "home" | "repo" | "other" | "base"> {
  const dir = tempDir("botbench-run-source-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const other = path.join(dir, "other");
  initRepo(other);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo: fs.realpathSync(repo), other: fs.realpathSync(other), base };
}

/** The store with the real broker, build line and run engine, its planner replayed. */
async function rig(t: T): Promise<Rig> {
  const dir = tempDir("botbench-run-source-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  const other = path.join(dir, "other");
  initRepo(other);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const planner = planReplayDriver(loadPlanRecording(), [THREE_TASKS, THREE_TASKS, THREE_TASKS]);
  const builder = buildReplayDriver(["done", "done", "done"]);
  const checks = [{ command: "true", limitMs: 10_000 }];
  const tasks = createTasks({ db, home, driver: builder, broker, model: "haiku", repoCommands: () => ({ setup: [], checks }), onEvent: () => {}, onTaskChange: () => {}, onRunChange: () => {} });
  const runs = createRuns({ db, home, driver: planner, broker, model: "haiku", implementerModel: "haiku", line: tasks, repoCommands: () => ({ checks }), onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, repo: fs.realpathSync(repo), other: fs.realpathSync(other), base, planner, runs };
}

const refused = (status: number, words: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof RunError, String(err));
  assert.equal(err.status, status);
  assert.match(err.message, words);
  return true;
};
const count = (db: DatabaseSync, table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

test("a run's source is a task or a chat, set when the run is stored and never changed; a run started any other way has none", (t) => {
  const r = stored(t);
  const task = finishedTask(r);
  const chat = recordedChat(r.db);
  const plain = createRun(r.db, { repo: r.repo, prompt: "Add a file", baseCommit: r.base });
  assert.equal(sourceOf(r.db, plain.id), null);
  const fromTask = createRun(r.db, { repo: r.repo, prompt: "Now add a farewell too", baseCommit: r.base, source: { kind: "task", id: task.id } });
  const fromChat = createRun(r.db, { repo: r.repo, prompt: "Do what I said about the header", baseCommit: r.base, source: { kind: "chat", id: chat.id } });
  assert.deepEqual(sourceOf(r.db, fromTask.id), { kind: "task", id: task.id });
  assert.deepEqual(sourceOf(r.db, fromChat.id), { kind: "chat", id: chat.id });
  assert.deepEqual(runsMadeFrom(r.db, task.id), [fromTask.id]);
  assert.deepEqual(runsMadeFrom(r.db, finishedTask(r).id), []);

  // The store itself refuses a source changed later, added later, or two sources at once.
  assert.throws(() => r.db.prepare("UPDATE runs SET source_task_id = NULL WHERE id = ?").run(fromTask.id), /source.*never changed/);
  assert.throws(() => r.db.prepare("UPDATE runs SET source_task_id = ? WHERE id = ?").run(task.id, plain.id), /source.*never changed/);
  assert.throws(() => r.db.prepare("UPDATE runs SET source_chat_id = ? WHERE id = ?").run(chat.id, fromTask.id), /source.*never changed/);
  assert.throws(() => r.db.prepare("INSERT INTO runs (kind, repo_path, prompt, status, base_commit, source_task_id, source_chat_id, created_at, updated_at) VALUES ('planned', ?, 'x', 'planning', ?, ?, ?, '', '')").run(r.repo, r.base, task.id, chat.id), /one source/);
  // A run made from the owner's words never reads outside text: the store refuses the two together.
  assert.throws(() => r.db.prepare("UPDATE runs SET outside_text = 1 WHERE id = ?").run(fromTask.id), /outside/);
  assert.throws(() => r.db.prepare("INSERT INTO runs (kind, repo_path, prompt, status, base_commit, source_task_id, outside_text, created_at, updated_at) VALUES ('planned', ?, 'x', 'planning', ?, ?, 1, '', '')").run(r.repo, r.base, task.id), /only the owner's words, never outside text/);
  // The source must be a real task or chat.
  assert.throws(() => r.db.prepare("INSERT INTO runs (kind, repo_path, prompt, status, base_commit, source_task_id, created_at, updated_at) VALUES ('planned', ?, 'x', 'planning', ?, 99999, '', '')").run(r.repo, r.base), /FOREIGN KEY/);
  assert.deepEqual(sourceOf(r.db, fromTask.id), { kind: "task", id: task.id });
});

test("the note is the owner's own words: an empty note, or one of only whitespace, is refused, and so is one over the stated limit, naming it", () => {
  assert.equal(noteProblem("Add a farewell file too."), null);
  assert.equal(noteProblem(""), NOTE_EMPTY);
  assert.equal(noteProblem(" \n\t "), NOTE_EMPTY);
  assert.equal(noteProblem(undefined), NOTE_EMPTY);
  assert.match(NOTE_EMPTY, /^The note is empty\./);
  assert.equal(noteProblem("x".repeat(MAX_RUN_NOTE)), null);
  assert.equal(noteProblem("x".repeat(MAX_RUN_NOTE + 1)), noteTooLong(MAX_RUN_NOTE + 1));
  assert.match(noteTooLong(MAX_RUN_NOTE + 1), new RegExp(`${MAX_RUN_NOTE.toLocaleString("en-US")} characters at most`));
});

test("a source is named as { task } or { chat } by id; any other shape is refused before anything is looked at", () => {
  assert.equal(sourceGiven(undefined), null);
  assert.equal(sourceGiven(null), null);
  assert.deepEqual(sourceGiven({ task: 12 }), { kind: "task", id: 12 });
  assert.deepEqual(sourceGiven({ chat: 5 }), { kind: "chat", id: 5 });
  for (const bad of [12, "task-12", { task: "12" }, { task: 0 }, { task: 1.5 }, { task: 1, chat: 2 }, { run: 3 }, [], { task: 12, extra: true }]) {
    assert.throws(() => sourceGiven(bad), refused(400, /"source"/), JSON.stringify(bad));
  }
});

test("a run is made only from a task that is ready for review, accepted or rejected, in the same repository, or from a chat Botbench has; anything else is refused with a plain reason", (t) => {
  const r = stored(t);
  for (const done of ["awaiting_decision", "accepted", "rejected"] as const) {
    const task = finishedTask(r, done);
    assert.deepEqual(checkSource(r.db, { kind: "task", id: task.id }, r.repo), { kind: "task", id: task.id, repo: r.repo, branch: task.branch, label: `From task ${task.id}` });
    // Whatever the decision (a rejected one deleted its branch here), the planner is told the task's id and branch name only.
    assert.equal(sourcePrompt(r.db, { kind: "task", id: task.id }), `Botbench's record: the owner made this run from task ${task.id} in this repository, whose work is on the branch \`${task.branch}\`. The work above is the owner's own note; nothing an agent wrote is included.`);
  }
  const building = finishedTask(r, "building");
  assert.throws(() => checkSource(r.db, { kind: "task", id: building.id }, r.repo), refused(409, new RegExp(`^Task ${building.id} is still being built, so no run can be made from it yet\\. .*ready for review, accepted or rejected\\.$`)));
  const reviewing = finishedTask(r, "reviewing");
  assert.throws(() => checkSource(r.db, { kind: "task", id: reviewing.id }, r.repo), refused(409, /is still being reviewed, so no run can be made from it yet/));
  const queued = finishedTask(r, "queued");
  assert.throws(() => checkSource(r.db, { kind: "task", id: queued.id }, r.repo), refused(409, /is queued, so no run can be made from it yet/));
  const failed = finishedTask(r, "failed");
  assert.throws(() => checkSource(r.db, { kind: "task", id: failed.id }, r.repo), refused(409, /failed, so no run can be made from it\./));
  assert.throws(() => checkSource(r.db, { kind: "task", id: 99999 }, r.repo), refused(404, /^There is no task 99999, so no run can be made from it\.$/));

  // A task's run works in the task's own repository: another repository's path cannot be paired with it.
  const ready = finishedTask(r);
  assert.throws(() => checkSource(r.db, { kind: "task", id: ready.id }, r.other), refused(400, new RegExp(`^Task ${ready.id} was built in .*repo, not .*other\\. A run made from it works in the same repository\\.$`)));

  const chat = recordedChat(r.db);
  assert.deepEqual(checkSource(r.db, { kind: "chat", id: chat.id }, r.repo), { kind: "chat", id: chat.id, repo: null, branch: null, label: "From a chat" });
  // Any attempt of the chat names the chat itself.
  const later = Number(r.db.prepare("SELECT attempt_id FROM chat_members WHERE chat_id = ? ORDER BY attempt_id DESC LIMIT 1").get(chat.id)!.attempt_id);
  assert.equal(checkSource(r.db, { kind: "chat", id: later }, null).id, chat.id);
  assert.throws(() => checkSource(r.db, { kind: "chat", id: 99999 }, r.repo), refused(404, /^That chat is not in Botbench's records, so no run can be made from it\.$/));
});

test("reading a task or a chat for the composer changes nothing in the store: the runs, tasks and chats tables are as they were", (t) => {
  const r = stored(t);
  const tasks = (["awaiting_decision", "accepted", "rejected"] as const).map((done) => finishedTask(r, done));
  const chat = recordedChat(r.db);
  const tables = ["runs", "run_events", "plan_tasks", "tasks", "task_events", "decisions", "attempts", "events", "chat_rounds", "chat_attempts", "chat_members", "chat_titles"];
  const contents = (): Record<string, unknown[]> => Object.fromEntries(tables.map((table) => [table, r.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = contents();
  // What GET /api/run-sources reads (src/api/runs.ts): the source checked, and for a chat the owner's messages.
  for (const task of tasks) assert.equal(checkSource(r.db, { kind: "task", id: task.id }, null).id, task.id);
  assert.equal(checkSource(r.db, { kind: "chat", id: chat.id }, null).id, chat.id);
  assert.equal(ownerMessages(r.db, chat.id).length, chat.owner.length);
  assert.deepEqual(contents(), before);
  assert.equal(count(r.db, "runs"), tasks.length, "only the runs the tasks were built in");
});

test("the messages a chat offers as a note are the owner's own, oldest first: never an agent's reply, a comparison, or what Botbench framed for an agent", (t) => {
  const r = stored(t);
  const chat = recordedChat(r.db);
  const messages = ownerMessages(r.db, chat.id);
  assert.deepEqual(messages.map((m) => m.text), chat.owner);
  for (const said of chat.agents) assert.ok(!messages.some((m) => m.text.includes(said)), said);
});

test("the planner of a run made from an accepted task is given the owner's note, and the task's id and branch from Botbench's records; nothing an agent wrote, and the run is not marked as outside text", async (t) => {
  const r = await rig(t);
  const task = finishedTask(r, "accepted");
  const before = count(r.db, "runs");
  const run = await r.runs.start({ repo: r.repo, prompt: "Now add a farewell file next to it.", source: { task: task.id }, mode: "manual" });
  assert.equal(count(r.db, "runs"), before + 1);
  assert.equal(run.outsideText, false);
  assert.equal(r.db.prepare("SELECT outside_text FROM runs WHERE id = ?").get(run.id)!.outside_text, 0);
  assert.deepEqual(sourceOf(r.db, run.id), { kind: "task", id: task.id });
  assert.equal(getRun(r.db, run.id)!.prompt, "Now add a farewell file next to it.");
  await r.runs.idle();
  const prompt = r.planner.prompts.at(-1)!;
  assert.ok(prompt.includes("<work>\nNow add a farewell file next to it.\n</work>"));
  // After the owner's work, one line Botbench writes from its own records, holding the task's id and branch name and nothing else.
  const line = `Botbench's record: the owner made this run from task ${task.id} in this repository, whose work is on the branch \`${task.branch}\`. The work above is the owner's own note; nothing an agent wrote is included.`;
  assert.equal(sourcePrompt(r.db, { kind: "task", id: task.id }), line);
  assert.ok(prompt.includes(`</work>\n\n${line}`), "the line follows the owner's work");
  for (const said of [BUILDER_SAID, REVIEWER_SAID, getTask(r.db, task.id)!.prompt]) assert.ok(!prompt.includes(said), `not carried: ${said}`);
  assert.ok(!prompt.includes("<outside-text>"), "not wrapped as outside text");
  assert.equal(getRun(r.db, run.id)!.status, "awaiting_plan_approval");
});

test("the planner of a run made from a chat is given the owner's note and that it came from a chat, and nothing an agent wrote there", async (t) => {
  const r = await rig(t);
  const chat = recordedChat(r.db);
  const run = await r.runs.start({ repo: r.repo, prompt: "Make the header stay at the top", source: { chat: chat.id }, mode: "semi" });
  assert.equal(run.outsideText, false);
  assert.equal(r.db.prepare("SELECT outside_text FROM runs WHERE id = ?").get(run.id)!.outside_text, 0);
  assert.deepEqual(sourceOf(r.db, run.id), { kind: "chat", id: chat.id });
  assert.equal(getRun(r.db, run.id)!.prompt, "Make the header stay at the top");
  await r.runs.idle();
  const prompt = r.planner.prompts.at(-1)!;
  assert.ok(prompt.includes("<work>\nMake the header stay at the top\n</work>"));
  assert.match(prompt, /from a chat/);
  for (const said of chat.agents) assert.ok(!prompt.includes(said), said);
  assert.ok(!prompt.includes("<outside-text>"));
  // Semi-autonomous: a run made from the owner's words does not wait at the plan gate, as one from a GitHub issue would.
  assert.equal(getRun(r.db, run.id)!.status, "running");
  await r.runs.cancel(run.id);
});

test("a run made from a source may be fully autonomous, as it carries only the owner's words", (t) => {
  const r = stored(t);
  const task = finishedTask(r);
  // In the store: fully autonomous and a source together, not marked.
  const made = createRun(r.db, { repo: r.repo, prompt: "Next step", baseCommit: r.base, mode: "full", source: { kind: "task", id: task.id } });
  assert.equal(made.mode, "full");
  assert.equal(made.outsideText, false);
  assert.equal(r.db.prepare("SELECT outside_text FROM runs WHERE id = ?").get(made.id)!.outside_text, 0);
});

test("starting a fully autonomous run from a finished task is not refused for its source", { skip: NO_SANDBOX }, async (t) => {
  const r = await rig(t);
  const task = finishedTask(r);
  const run = await r.runs.start({ repo: r.repo, prompt: "Next step", source: { task: task.id }, mode: "full", oneTask: true });
  assert.equal(run.mode, "full");
  assert.equal(run.outsideText, false);
  r.runs.cancel(run.id);
});

test("a run from a source is refused, and nothing is stored, for an empty or too long note, a spec file or an issue, an unfinished or missing source, or another repository", async (t) => {
  const r = await rig(t);
  const ready = finishedTask(r);
  const building = finishedTask(r, "building");
  const before = count(r.db, "runs");
  const spec = path.join(r.repo, "..", "spec.md");
  fs.writeFileSync(spec, "# Spec\n");
  await assert.rejects(r.runs.start({ repo: r.repo, prompt: "   ", source: { task: ready.id }, mode: "manual" }), refused(400, /^The note is empty\./));
  await assert.rejects(r.runs.start({ repo: r.repo, source: { task: ready.id }, mode: "manual" }), refused(400, /^The note is empty\./));
  await assert.rejects(r.runs.start({ repo: r.repo, prompt: "x".repeat(MAX_RUN_NOTE + 1), source: { task: ready.id }, mode: "manual" }), refused(400, /characters at most/));
  await assert.rejects(r.runs.start({ repo: r.repo, specPath: spec, source: { task: ready.id }, mode: "manual" }), refused(400, /not a spec file or an issue/));
  await assert.rejects(r.runs.start({ repo: r.repo, prompt: "Go", issue: { fetchId: 1, allowHosts: false }, source: { task: ready.id }, mode: "manual" }), refused(400, /not a spec file or an issue/));
  await assert.rejects(r.runs.start({ repo: r.repo, prompt: "Go", source: { task: building.id }, mode: "manual" }), refused(409, /still being built/));
  await assert.rejects(r.runs.start({ repo: r.repo, prompt: "Go", source: { task: 99999 }, mode: "manual" }), refused(404, /no task 99999/));
  await assert.rejects(r.runs.start({ repo: r.repo, prompt: "Go", source: { chat: 99999 }, mode: "manual" }), refused(404, /not in Botbench's records/));
  await assert.rejects(r.runs.start({ repo: r.other, prompt: "Go", source: { task: ready.id }, mode: "manual" }), refused(400, /A run made from it works in the same repository/));
  assert.equal(count(r.db, "runs"), before);
});
