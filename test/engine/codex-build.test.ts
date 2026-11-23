import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, listApprovals, type Broker } from "../../src/approvals/broker.ts";
import { ESCALATION_REFUSED, ESCALATION_WORDS } from "../../src/approvals/gate.ts";
import { CODEX_CAPABILITIES } from "../../src/drivers/codex.ts";
import { setAskEveryCommand, type RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { createTasks, getTask, TaskError, type Task, type Tasks } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { codexBuildReplay, loadShape, type CodexBuildReplay, type ShapeTurn } from "../support/replay-codex.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// Codex as a task's builder, through the engine: real SQLite, a real temporary git repository, the real permission broker
// and Botbench's real Codex session (src/drivers/codex-app-server.ts). The server's side is the shape of a real
// `codex app-server` session, from the messages measured live in docs/security/codex-app-server-check.md, replayed
// (test/support/replay-codex.ts) until a capture exists. Claude Code is the main agent and is never started here.

type T = { after(fn: () => unknown): void };

interface Line {
  db: DatabaseSync;
  dir: string;
  repo: string;
  base: string;
  broker: Broker;
  codex: CodexBuildReplay;
  tasks: Tasks;
}

async function line(t: T, attempts: readonly (readonly ShapeTurn[])[], o: { settings?: Record<string, unknown> } = {}): Promise<Line> {
  const dir = tempDir("botbench-codex-build-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  // The broker is asked in process; Codex never uses its socket, so it is not opened.
  const broker = createBroker({ db, home, onChange: () => {} });
  const codex = codexBuildReplay(attempts, { outside: path.join(dir, "outside"), ...(o.settings ? { settings: o.settings } : {}) });
  const claude = buildReplayDriver(["done"]);
  const tasks = createTasks({ db, home, driver: claude, builders: { codex }, broker, repoCommands: () => ({ setup: [], checks: [] }), onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, repo, base, broker, codex, tasks };
}

/** A task of a run in `mode` built by Codex, its plan approved; the line builds it. */
function codexRun(e: Line, mode: RunMode): Task {
  const run = createRun(e.db, { repo: e.repo, builder: "codex", prompt: "Add hello.txt", baseCommit: e.base, mode });
  const stored = storePlan(e.db, run.id, [{ title: "Add hello.txt", criteria: ["hello.txt holds hi"] }]);
  const task = approvePlan(e.db, run.id, stored.planVersion, null, mode === "full" ? "mode" : "owner").tasks[0]!;
  e.tasks.buildRun(run.id);
  return task;
}

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "the build got there");
};

test("a task built by Codex: a command and a change inside its sandbox ask nothing, are in the action log from the event stream, and Botbench commits the work to the task's branch", async (t) => {
  const e = await line(t, [["inside"]]);
  const task = await e.tasks.start(e.repo, "Run test.sh and add hello.txt.", undefined, [], "codex");
  assert.equal(task.builderAgent, "codex");
  await e.tasks.idle();
  const done = getTask(e.db, task.id)!;
  assert.equal(done.status, "awaiting_decision", done.reason ?? "");
  assert.equal(e.codex.started.length, 1);
  const started = e.codex.started[0]!;
  assert.deepEqual([started.allowEdits, started.gate !== undefined, started.cwd], [true, true, done.worktreePath]);
  assert.deepEqual(listApprovals(e.db), [], "no card");
  const log = actionLog(e.db, task.id);
  assert.deepEqual(log.map((entry) => [entry.rule, entry.tool, entry.command]), [["sandboxed", "shell", "/bin/zsh -lc 'sh test.sh'"], ["sandboxed", "file_change", JSON.stringify({ changes: [{ path: path.join(done.worktreePath!, "hello.txt"), kind: "add", diff: "hi\n" }] })]]);
  assert.match(log[0]!.detail ?? "", /^Codex ran this without asking, kept by its own sandbox to the task's copy, away from your sign-ins and the network\.$/);
  // Botbench's own commit holds the work; the owner's checkout is untouched.
  assert.equal(git(e.repo, "show", `${done.branch}:hello.txt`), "hi\n");
  assert.match(git(e.repo, "log", "-1", "--format=%an", done.branch!), /Botbench/);
  assert.equal(git(e.repo, "rev-parse", "HEAD").trim(), e.base);
  assert.equal(git(e.repo, "status", "--porcelain"), "");
});

test("Manual: Codex's escalation is one card saying it asks to run outside its sandbox; Allow lets it out, Deny keeps it in", async (t) => {
  for (const answer of ["allow", "decline"] as const) {
    const e = await line(t, [["escalate"]]);
    const task = await e.tasks.start(e.repo, "Create landed-T1 outside.", undefined, [], "codex");
    await waitFor(() => listApprovals(e.db, "pending").length === 1);
    const [card] = listApprovals(e.db, "pending");
    assert.equal(card!.asksBecause, ESCALATION_WORDS);
    assert.match(card!.command, /touch .*\/outside\/landed-T1/);
    // Until the owner answers, Codex has been told nothing.
    assert.equal(e.codex.transports[0]!.sent.some((m) => m.id === 0 && m.method === undefined), false);
    e.broker.answer(card!.id, answer);
    await e.tasks.idle();
    assert.deepEqual(e.codex.transports[0]!.sent.find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { decision: answer === "allow" ? "accept" : "decline" } });
    assert.deepEqual(actionLog(e.db, task.id).map((entry) => entry.rule), ["asked_owner", answer === "allow" ? "owner_allowed" : "owner_declined"], "the escalated command is logged by the broker, never as one that ran in the sandbox");
    assert.equal(listApprovals(e.db).length, 1);
  }
});

test("Fully autonomous: every Codex escalation is refused with no card, Codex is told no, and the refusal keeps the task for the owner", async (t) => {
  const e = await line(t, [["escalate"]]);
  const task = codexRun(e, "full");
  await waitFor(() => e.codex.transports[0]?.sent.some((m) => m.id === 0 && m.method === undefined) === true);
  await e.tasks.idle();
  assert.deepEqual(listApprovals(e.db), [], "no card");
  assert.deepEqual(e.codex.transports[0]!.sent.find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { decision: "decline" } });
  const refused = actionLog(e.db, task.id).find((entry) => entry.rule === "mode_refused")!;
  assert.deepEqual([refused.detail, refused.refusal], [ESCALATION_REFUSED, "unconfined"]);
  assert.notEqual(getTask(e.db, task.id)!.status, "accepted");
});

test("a looser sandbox reported by Codex stops the build before Codex starts on it, saying why", async (t) => {
  const e = await line(t, [["inside"]], { settings: loadShape().looserSettings });
  const task = await e.tasks.start(e.repo, "Run test.sh.", undefined, [], "codex");
  await e.tasks.idle();
  assert.equal(e.codex.transports[0]!.sent.some((m) => m.method === "turn/start"), false);
  const stopped = getTask(e.db, task.id)!;
  assert.notEqual(stopped.status, "awaiting_decision");
  const said = e.db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'turn_ended'").get(stopped.attemptId!);
  assert.match(String(said?.payload), /looser than the workspace-write sandbox Botbench set, so it was stopped/);
});

test("with Ask before every command on, Codex is refused as a task's builder, saying why, since it cannot ask about a command inside its sandbox; a semi-autonomous run is not", async (t) => {
  const e = await line(t, [["inside"]]);
  setAskEveryCommand(e.db, true);
  await assert.rejects(e.tasks.start(e.repo, "p", undefined, [], "codex"), (err: unknown) => err instanceof TaskError && err.status === 400 && /^Codex cannot build with Ask before every command on: it asks you only before it runs something outside its sandbox, never before a command inside it\./.test(err.message));
  assert.equal(e.tasks.builderProblem("codex", "semi"), null);
  assert.equal(e.tasks.builderProblem(null), null, "Claude Code asks before every command itself");
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0);
});

test("Codex is refused as a builder while its check has not found that it can build, and nothing is stored", async (t) => {
  const dir = tempDir("botbench-codex-build-refused-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const broker = createBroker({ db, home, onChange: () => {} });
  const unchecked = codexBuildReplay([["inside"]], { outside: dir, capabilities: { ...CODEX_CAPABILITIES, buildProblem: "Botbench has not checked yet that this Codex can ask you before it runs anything outside its sandbox." } });
  const tasks = createTasks({ db, home, driver: buildReplayDriver(["done"]), builders: { codex: unchecked }, broker, onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(tasks.start(dir, "p", undefined, [], "codex"), (err: unknown) => err instanceof TaskError && err.status === 400 && /^Codex cannot be the builder: Botbench has not checked yet/.test(err.message));
  await assert.rejects(tasks.start(dir, "p", undefined, [], "grok"), (err: unknown) => err instanceof TaskError && /Grok cannot build a task in Botbench/.test(err.message));
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0);
});
