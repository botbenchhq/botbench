import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ApprovalError, actionLog, createBroker, listApprovals, waitingOnApproval, type Approval, type Broker } from "../../src/approvals/broker.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { Driver } from "../../src/drivers/contract.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { killProcessGroup, processGroupAlive } from "../../src/drivers/launch.ts";
import { createTask, createTasks, getTask, type Task, type Tasks } from "../../src/engine/task.ts";
import { DB_FILE, openStore, schemaVersion } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { checkoutState, git, initRepo, tempDir } from "../support/repo.ts";
import type { Left } from "../support/leave-pending.ts";
import { loadRecording, replayDriver } from "../support/replay.ts";

// Approvals across a restart. The store, the broker and its socket, git and the processes are the real ones. The Smelt
// that "stopped" is a real process that is killed where it stands (test/support/leave-pending.ts). No test here starts
// a CLI: the one that needs an agent's turn replays a session recorded from the real Claude Code (test/support/replay.ts),
// and the turns themselves are in test/live/recover-approval.live.test.ts.

type T = { after(fn: () => unknown): void };
const SCRIPT = path.resolve(import.meta.dirname, "..", "support", "leave-pending.ts");
const MARKER = "sh make-marker.sh";

interface Stopped extends Left {
  dir: string;
  home: string;
  repo: string;
}

/** A Smelt home in which a task waited for the owner when its Smelt was killed. */
function stoppedWhileWaiting(t: T, options: { cursor?: string; commands?: string[]; survivor?: boolean; attemptMadeEarlier?: boolean } = {}): Stopped {
  const dir = tempDir("smelt-recover-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n' });
  const order = { home, repo, commands: [MARKER], ...("cursor" in options ? {} : { cursor: "0b7b7c9e-4a51-4c0e-9d0c-0d3f8f6f2a11" }), ...options };
  const run = spawnSync(process.execPath, [SCRIPT, JSON.stringify(order)], { encoding: "utf8" });
  assert.equal(run.signal, "SIGKILL", `the Smelt that stops is killed where it stands: ${run.stderr}`);
  const left = JSON.parse(run.stdout) as Left;
  if (left.pgid !== null) t.after(() => killProcessGroup(left.pgid!).catch(() => {}));
  return { ...left, dir, home, repo };
}

interface Started {
  db: DatabaseSync;
  broker: Broker;
  tasks: Tasks;
  changes: Approval[];
  taskChanges: Task[];
  close(): Promise<void>;
}

/** The next start on the same home: the store opened again, a new broker listening, and the engine recovered. */
async function startAgain(t: T, home: string, driver: Driver = new ClaudeCodeDriver()): Promise<Started> {
  const db = openStore(home);
  const changes: Approval[] = [];
  const taskChanges: Task[] = [];
  const broker = createBroker({ db, home, onChange: (approval) => changes.push(approval) });
  await broker.listen();
  const tasks = createTasks({ db, home, driver, broker, onEvent: () => {}, onTaskChange: (task) => taskChanges.push(task) });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tasks.close();
    await broker.close();
    db.close();
  };
  t.after(close);
  await tasks.idle();
  return { db, broker, tasks, changes, taskChanges, close };
}

/** The next start as far as the broker: the store and a listening broker, and no engine, so nothing is resumed. */
async function brokerAgain(t: T, home: string): Promise<{ db: DatabaseSync; broker: Broker; changes: Approval[] }> {
  const db = openStore(home);
  const changes: Approval[] = [];
  const broker = createBroker({ db, home, onChange: (approval) => changes.push(approval) });
  await broker.listen();
  t.after(async () => {
    await broker.close();
    db.close();
  });
  return { db, broker, changes };
}

const rules = (db: DatabaseSync, taskId?: number): string[] => actionLog(db, taskId).map((e) => e.rule);
const attemptRow = (db: DatabaseSync, id: number) => ({ ...db.prepare("SELECT status, pgid, resume_cursor FROM attempts WHERE id = ?").get(id) });
const newAttempt = (db: DatabaseSync): number => Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
const ask = (broker: Broker, s: { taskId: number }, attemptId: number, over: Partial<{ tool: string; command: string; cwd: string; toolCallId: string; taskId: number }> = {}) =>
  broker.request({ taskId: s.taskId, attemptId, role: "implementer", tool: "Bash", command: MARKER, cwd: ".", reason: null, toolCallId: "toolu_after_1", ...over });
async function until(what: string, done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a pending approval row is still pending after the store is closed and reopened and the broker is started again; its task is parked, not interrupted, and nothing is committed or run", async (t) => {
  const s = stoppedWhileWaiting(t);
  const before = checkoutState(s.repo);
  const peek = new DatabaseSync(path.join(s.home, DB_FILE), { readOnly: true });
  assert.deepEqual(peek.prepare("SELECT status FROM approvals").all().map((r) => r.status), ["pending"], "what the killed Smelt left");
  peek.close();

  const again = await startAgain(t, s.home);
  const [approval] = listApprovals(again.db);
  assert.ok(approval);
  assert.deepEqual([approval.id, approval.status, approval.command, approval.cwd, approval.attemptId, approval.storedDecision], [s.approvalIds[0], "pending", MARKER, ".", s.attemptId, null]);
  assert.ok(approval.parkedAt !== null && !Number.isNaN(Date.parse(approval.parkedAt)), "it says it was asked before a restart");
  assert.deepEqual(again.broker.pending().map((a) => a.id), s.approvalIds);
  assert.deepEqual(rules(again.db), ["asked_owner"], "nothing ended it");

  // The task waits on the owner where it stood: still building, same attempt, its files as they were, no commit.
  const task = getTask(again.db, s.taskId)!;
  assert.deepEqual([task.status, task.reason, task.attemptId, task.headCommit], ["building", null, s.attemptId, null]);
  assert.equal(waitingOnApproval(again.db, s.taskId), true);
  assert.equal(git(s.worktree, "status", "--porcelain").trim(), "?? partial.txt", "the worktree is as the agent left it");
  assert.equal(again.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 1, "nothing was started");
  assert.deepEqual(again.db.prepare("SELECT status, detail FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1").all(s.taskId).map((r) => [r.status, String(r.detail).includes("restart")]), [["building", true]], "the task's history says it was parked");
  assert.deepEqual(checkoutState(s.repo), before);

  // A second restart changes nothing about it.
  await again.close();
  const third = await startAgain(t, s.home);
  const [still] = listApprovals(third.db);
  assert.deepEqual([still!.status, still!.parkedAt], ["pending", approval.parkedAt]);
  assert.equal(getTask(third.db, s.taskId)!.status, "building");
});

test("a CLI process that survived from before the restart is stopped on start, before the task is parked; a process group that began after the attempt is not touched", { timeout: 30_000 }, async (t) => {
  const s = stoppedWhileWaiting(t, { survivor: true });
  assert.ok(s.pgid !== null && processGroupAlive(s.pgid), "the survivor is running");
  // Smelt's own time zone must not shift when a process is taken to have begun: far west here, far east below.
  const zone = process.env.TZ;
  t.after(() => (zone === undefined ? delete process.env.TZ : (process.env.TZ = zone)));
  process.env.TZ = "Pacific/Honolulu";
  const again = await startAgain(t, s.home);
  assert.equal(processGroupAlive(s.pgid), false, "the survivor is gone");
  assert.deepEqual(attemptRow(again.db, s.attemptId), { status: "interrupted", pgid: null, resume_cursor: "0b7b7c9e-4a51-4c0e-9d0c-0d3f8f6f2a11" });
  assert.equal(getTask(again.db, s.taskId)!.status, "building");
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["pending"]);

  // The attempt's number now belongs to a process that started an hour after the attempt was made: not Smelt's to stop.
  const other = stoppedWhileWaiting(t, { survivor: true, attemptMadeEarlier: true });
  process.env.TZ = "Pacific/Auckland";
  const otherStart = await startAgain(t, other.home);
  assert.equal(processGroupAlive(other.pgid!), true, "a process that is not the attempt's is left running");
  assert.equal(attemptRow(otherStart.db, other.attemptId).pgid, null, "and the attempt no longer names it");
});

test("the owner's answer to a parked approval is stored with its log entry, and applied exactly once: to the first request of the resuming attempt that matches it; a second identical request asks again", async (t) => {
  const s = stoppedWhileWaiting(t);
  const again = await brokerAgain(t, s.home);
  const id = s.approvalIds[0]!;

  const stored = again.broker.answer(id, "allow");
  assert.deepEqual([stored.status, stored.storedDecision, stored.resolvedAt], ["pending", "allow", null], "stored, not yet applied");
  assert.deepEqual(rules(again.db), ["asked_owner", "owner_allowed"]);
  assert.equal(waitingOnApproval(again.db, s.taskId), false, "the owner has answered");
  assert.throws(() => again.broker.answer(id, "decline"), (err: unknown) => err instanceof ApprovalError && err.status === 409, "one answer");

  // The attempt that resumes it asks for the same thing from the same directory, as its hook reports it.
  const resumed = newAttempt(again.db);
  const admission = again.broker.admit({ taskId: s.taskId, role: "implementer", worktree: s.worktree, resumes: s.attemptId });
  admission.bind(resumed);
  assert.equal((await askBroker(admission.socketPath, admission.secret, { tool_name: "Bash", tool_input: { command: MARKER }, tool_use_id: "toolu_after_1", cwd: fs.realpathSync(s.worktree) })).verdict, "ask");
  const { cwd: _unused, ...asIs } = { taskId: s.taskId, attemptId: resumed, role: "implementer", tool: "Bash", command: MARKER, cwd: "", reason: null, toolCallId: "toolu_after_1" };
  const first = await again.broker.request(asIs);
  assert.deepEqual(first, { decision: "allow", note: null, approvalId: id, refused: null });
  const all = listApprovals(again.db);
  assert.deepEqual(all.map((a) => [a.id, a.status]), [[id, "allowed"]], "no second approval was made");
  assert.ok(all[0]!.resolvedAt);
  const log = actionLog(again.db, s.taskId);
  assert.deepEqual(log.map((e) => [e.rule, e.approvalId, e.attemptId, e.command, e.cwd]), [
    ["asked_owner", id, s.attemptId, MARKER, "."],
    ["owner_allowed", id, s.attemptId, MARKER, "."],
    ["stored_answer_applied", id, resumed, MARKER, "."],
  ]);
  assert.match(log[2]!.detail ?? "", /toolu_after_1/);

  // The same request again, in the same turn: the stored answer is used up, so the owner is asked.
  let settled = false;
  const second = ask(again.broker, s, resumed, { toolCallId: "toolu_after_2" });
  void second.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "the second request waits");
  const pending = again.broker.pending();
  assert.deepEqual(pending.map((a) => [a.command, a.attemptId, a.parkedAt, a.storedDecision]), [[MARKER, resumed, null, null]]);
  again.broker.answer(pending[0]!.id, "decline");
  assert.equal((await second).decision, "decline");
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["allowed", "declined"]);
});

test("a decline is stored and delivered the same way, with the owner's note", async (t) => {
  const s = stoppedWhileWaiting(t);
  const again = await brokerAgain(t, s.home);
  const id = s.approvalIds[0]!;
  const stored = again.broker.answer(id, "decline", "  not in this task  ");
  assert.deepEqual([stored.status, stored.storedDecision, stored.note], ["pending", "decline", "not in this task"]);
  const resumed = newAttempt(again.db);
  again.broker.admit({ taskId: s.taskId, role: "implementer", worktree: s.worktree, resumes: s.attemptId }).bind(resumed);
  assert.deepEqual(await ask(again.broker, s, resumed), { decision: "decline", note: "not in this task", approvalId: id, refused: null });
  assert.deepEqual(listApprovals(again.db).map((a) => [a.status, a.note]), [["declined", "not in this task"]]);
  assert.deepEqual(actionLog(again.db).map((e) => [e.rule, e.detail === null ? null : e.rule === "owner_declined" ? e.detail : "…"]), [["asked_owner", null], ["owner_declined", "not in this task"], ["stored_answer_applied", "…"]]);
});

test("a stored answer is never applied to another task, another attempt's lineage, another tool, command or directory, or to a directory nobody reported", async (t) => {
  // Requests that are not from the attempt resuming it leave the stored answer where it is and ask the owner themselves.
  {
    const s = stoppedWhileWaiting(t);
    const again = await brokerAgain(t, s.home);
    again.broker.answer(s.approvalIds[0]!, "allow");
    const stranger = newAttempt(again.db);
    again.broker.admit({ taskId: s.taskId, role: "implementer", worktree: s.worktree }).bind(stranger);
    void ask(again.broker, s, stranger, { toolCallId: "toolu_stranger" });
    const otherTask = createTask(again.db, { repo: s.repo, prompt: "another task" }).id;
    const otherAttempt = newAttempt(again.db);
    again.broker.admit({ taskId: otherTask, role: "implementer", worktree: s.worktree, resumes: s.attemptId }).bind(otherAttempt);
    void ask(again.broker, s, otherAttempt, { taskId: otherTask, toolCallId: "toolu_other_task" });
    // An attempt nobody admitted, naming the first task.
    void ask(again.broker, s, newAttempt(again.db), { toolCallId: "toolu_unadmitted" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const all = listApprovals(again.db);
    assert.deepEqual(all.map((a) => [a.status, a.storedDecision]), [["pending", "allow"], ["pending", null], ["pending", null], ["pending", null]], "three new requests wait; the stored answer was given to none");
    assert.equal(rules(again.db).includes("stored_answer_applied"), false);
  }

  // The resuming attempt's first request is something else: the stored answer is discarded, the old approval closed, and the new request waits.
  for (const [what, over] of [["command", { command: "sh make-marker.sh && rm -rf ." }], ["tool", { tool: "WebFetch" }], ["directory", { cwd: "sub" }], ["directory nobody reported", { cwd: "" }]] as const) {
    const s = stoppedWhileWaiting(t);
    const again = await brokerAgain(t, s.home);
    const id = s.approvalIds[0]!;
    again.broker.answer(id, "allow");
    const resumed = newAttempt(again.db);
    again.broker.admit({ taskId: s.taskId, role: "implementer", worktree: s.worktree, resumes: s.attemptId }).bind(resumed);
    let settled = false;
    void ask(again.broker, s, resumed, over).then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, `another ${what}: the request waits for the owner`);
    const all = listApprovals(again.db);
    assert.deepEqual(all.map((a) => [a.status, a.storedDecision, a.attemptId]), [["superseded", "allow", s.attemptId], ["pending", null, resumed]], `another ${what}`);
    const log = actionLog(again.db);
    assert.deepEqual(log.map((e) => [e.rule, e.approvalId]), [["asked_owner", id], ["owner_allowed", id], ["stored_answer_discarded", id], ["asked_owner", all[1]!.id]], `another ${what}`);
    assert.match(log[2]!.detail ?? "", /asked for something else/);
    assert.deepEqual(again.changes.filter((a) => a.id === id).map((a) => a.status).at(-1), "superseded", "and the change is announced");
    // And the exact request afterwards finds nothing left to apply.
    void ask(again.broker, s, resumed, { toolCallId: "toolu_after_3" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["superseded", "pending", "pending"]);
  }
});

test("what a crafted row could try is refused by the store: an answer stored twice or for an approval that is not parked, and a parked approval ending as anything but its stored answer or superseded", async (t) => {
  const s = stoppedWhileWaiting(t, { commands: [MARKER, "ls", "pwd"] });
  const again = await brokerAgain(t, s.home);
  const [declined, unanswered, third] = s.approvalIds as [number, number, number];
  const db = again.db;
  again.broker.answer(declined, "decline");
  assert.throws(() => db.prepare("UPDATE approvals SET stored_decision = 'allow' WHERE id = ?").run(declined), /stored once/);
  assert.throws(() => db.prepare("UPDATE approvals SET status = 'allowed', resolved_at = 'now' WHERE id = ?").run(declined), /stored answer or as superseded/, "a stored decline cannot become an allow");
  assert.throws(() => db.prepare("UPDATE approvals SET status = 'allowed', resolved_at = 'now' WHERE id = ?").run(unanswered), /stored answer or as superseded/, "a parked approval nobody answered cannot become an allow");
  assert.throws(() => db.prepare("UPDATE approvals SET stored_decision = 'maybe', stored_at = 'now' WHERE id = ?").run(unanswered), /constraint/i);
  assert.throws(() => db.prepare("UPDATE approvals SET parked_at = 'later' WHERE id = ?").run(third), /parked once/);
  // An approval asked in this process is not parked, and takes no stored answer.
  const live = newAttempt(db);
  void ask(again.broker, s, live, { toolCallId: "toolu_live" });
  const liveId = again.broker.pending().at(-1)!.id;
  assert.throws(() => db.prepare("UPDATE approvals SET stored_decision = 'allow', stored_at = 'now' WHERE id = ?").run(liveId), /only for an approval asked before a restart/);
  assert.deepEqual(listApprovals(db).map((a) => [a.status, a.storedDecision]), [["pending", "decline"], ["pending", null], ["pending", null], ["pending", null]]);
  // A stored answer's note is fixed with it, and no approval can be written into the store already parked or answered.
  assert.throws(() => db.prepare("UPDATE approvals SET note = 'changed' WHERE id = ?").run(declined), /note of a stored answer/);
  const forged = "INSERT INTO approvals (task_id, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at, parked_at, stored_decision, stored_at) VALUES (?, ?, 'implementer', 'Bash', 'rm -rf ~', '.', 'toolu_forged', ?, 'now', ?, ?, ?)";
  assert.throws(() => db.prepare(forged).run(s.taskId, s.attemptId, "pending", "now", "allow", "now"), /first written as pending/);
  assert.throws(() => db.prepare(forged).run(s.taskId, s.attemptId, "pending", "now", null, null), /first written as pending/);
  assert.throws(() => db.prepare(forged).run(s.taskId, s.attemptId, "allowed", null, null, null), /first written as pending/);
  // The log's new entries are as fixed as the old ones.
  assert.throws(() => db.prepare("UPDATE action_log SET rule = 'stored_answer_applied'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM action_log").run(), /append-only/);
  assert.throws(() => db.prepare("INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES ('now', 'owner_said_so', 'Bash', 'ls', '.')").run(), /constraint/i);
});

test("a first request that Smelt itself refuses still uses up the resuming attempt's turn at the stored answer: it is discarded, not kept for a later request", async (t) => {
  const s = stoppedWhileWaiting(t);
  const again = await brokerAgain(t, s.home);
  const id = s.approvalIds[0]!;
  again.broker.answer(id, "allow");
  const resumed = newAttempt(again.db);
  again.broker.admit({ taskId: s.taskId, role: "implementer", worktree: s.worktree, resumes: s.attemptId }).bind(resumed);
  const refused = await ask(again.broker, s, resumed, { command: `echo ${"a".repeat(30_000)}` });
  assert.equal(refused.decision, "decline");
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["superseded"]);
  assert.deepEqual(rules(again.db), ["asked_owner", "owner_allowed", "broker_failure_denied", "stored_answer_discarded"]);
  void ask(again.broker, s, resumed, { toolCallId: "toolu_after_2" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["superseded", "pending"], "the exact request afterwards asks the owner");
});

test("an answer given while Smelt is still recovering is not mistaken for one the last run left behind: its task is resumed in its turn", async (t) => {
  const s = stoppedWhileWaiting(t);
  const db = openStore(s.home);
  const broker = createBroker({ db, home: s.home, onChange: () => {} });
  await broker.listen();
  // The recording holds another session than this attempt's, so the resume is refused; that it was tried is the point.
  const tasks = createTasks({ db, home: s.home, driver: replayDriver(loadRecording("redrive-other-request.json")), broker, onEvent: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await tasks.close();
    await broker.close();
    db.close();
  });
  // The owner is quicker than recovery.
  broker.answer(s.approvalIds[0]!, "allow");
  await tasks.idle();
  const task = getTask(db, s.taskId)!;
  assert.equal(task.status, "interrupted");
  assert.match(task.reason ?? "", /could not be started again/);
  assert.doesNotMatch(task.reason ?? "", /Smelt stopped/);
});

test("a task with several parked approvals is resumed only when each has an answer", async (t) => {
  const s = stoppedWhileWaiting(t, { commands: [MARKER, "ls"] });
  // The recording holds another session than this attempt's, so the resume it is asked for in the end is refused; that it is asked only then is the point.
  const again = await startAgain(t, s.home, replayDriver(loadRecording("redrive-other-request.json")));
  again.broker.answer(s.approvalIds[0]!, "allow");
  await again.tasks.idle();
  assert.deepEqual([getTask(again.db, s.taskId)!.status, waitingOnApproval(again.db, s.taskId)], ["building", true], "one answer of two: nothing is resumed");
  assert.deepEqual(listApprovals(again.db).map((a) => [a.status, a.storedDecision]), [["pending", "allow"], ["pending", null]]);
  again.broker.answer(s.approvalIds[1]!, "decline");
  await again.tasks.idle();
  const task = getTask(again.db, s.taskId)!;
  assert.equal(task.status, "interrupted", "both answered: the resume was tried");
  assert.match(task.reason ?? "", /could not be started again.*not applied/is);
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["superseded", "superseded"]);
  assert.deepEqual(rules(again.db).slice(-2), ["stored_answer_discarded", "stored_answer_discarded"]);
});

test("a task that cannot be resumed is not parked: with no session to resume it is marked interrupted with the reason, its approval is closed as superseded, and its work is committed", async (t) => {
  const s = stoppedWhileWaiting(t, { cursor: undefined });
  const again = await startAgain(t, s.home);
  const task = getTask(again.db, s.taskId)!;
  assert.equal(task.status, "interrupted");
  assert.match(task.reason ?? "", /waited for your answer.*cannot be resumed.*no session.*nothing was run/is);
  assert.deepEqual(listApprovals(again.db).map((a) => [a.status, a.storedDecision]), [["superseded", null]]);
  assert.deepEqual(actionLog(again.db).map((e) => e.rule), ["asked_owner", "ended_unanswered"]);
  assert.match(actionLog(again.db)[1]!.detail ?? "", /no session/);
  assert.throws(() => again.broker.answer(s.approvalIds[0]!, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409);
  assert.equal(git(s.repo, "show", `${s.branch}:partial.txt`), "written before the stop\n");
  assert.equal(again.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 1, "nothing was started");
});

test("an answer that was stored but not yet applied when Smelt stopped again is not carried over: the approval is closed, the task interrupted with the reason, and nothing is allowed", async (t) => {
  const s = stoppedWhileWaiting(t);
  // The answer is stored by a start whose engine never gets to resume the task.
  const db = openStore(s.home);
  const broker = createBroker({ db, home: s.home, onChange: () => {} });
  await broker.listen();
  assert.equal(broker.answer(s.approvalIds[0]!, "allow").storedDecision, "allow");
  await broker.close();
  db.close();

  const again = await startAgain(t, s.home);
  const task = getTask(again.db, s.taskId)!;
  assert.equal(task.status, "interrupted");
  assert.match(task.reason ?? "", /your answer was not applied/i);
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["superseded"]);
  assert.deepEqual(rules(again.db), ["asked_owner", "owner_allowed", "stored_answer_discarded"]);
});

test("replayed from a real session: a re-driven turn whose first request does not match the stored one raises a new card and closes the old approval as superseded", async (t) => {
  const recording = loadRecording("redrive-other-request.json");
  assert.match(recording.cli, /^\d+\.\d+\.\d+ \(Claude Code\)$/);
  assert.ok(!Number.isNaN(Date.parse(recording.recordedAt)));
  const s = stoppedWhileWaiting(t, { cursor: recording.resumeCursor });
  const again = await startAgain(t, s.home, replayDriver(recording));
  const id = s.approvalIds[0]!;
  assert.deepEqual(again.broker.pending().map((a) => [a.id, a.command]), [[id, MARKER]]);

  // The owner allows what was asked before the restart. The resumed session asks for something else.
  again.broker.answer(id, "allow");
  await until("the new card", () => again.broker.pending().some((a) => a.id !== id));
  const all = listApprovals(again.db);
  assert.deepEqual(all.map((a) => [a.command, a.status, a.storedDecision, a.parkedAt === null]), [[MARKER, "superseded", "allow", false], ["sh other.sh", "pending", null, true]]);
  const card = all[1]!;
  const task = getTask(again.db, s.taskId)!;
  assert.notEqual(card.attemptId, s.attemptId);
  assert.deepEqual([task.status, task.attemptId, waitingOnApproval(again.db, s.taskId)], ["building", card.attemptId, true]);
  assert.deepEqual(actionLog(again.db).map((e) => [e.rule, e.approvalId]), [["asked_owner", id], ["owner_allowed", id], ["stored_answer_discarded", id], ["asked_owner", card.id]]);
  const events = (): DriverEvent[] => again.db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(card.attemptId).map((r) => JSON.parse(String(r.payload)) as DriverEvent);
  assert.equal(events().some((e) => e.type === "permission_resolved" || e.type === "tool_result"), false, "nothing was answered or run on the old allow");
  const prompt = events()[0]!;
  assert.ok(prompt.type === "user_prompt" && /Smelt/.test(prompt.text) && /restart/.test(prompt.text), "the resumed turn opens with Smelt's own words");
  // Which is where the replay departs from the recorded run: the CLI produced these events under the capture's own prompt.
  assert.equal(recording.prompts.includes(prompt.text), false);

  // The new card is an ordinary one: the owner answers it and the turn goes on.
  again.broker.answer(card.id, "allow");
  await again.tasks.idle();
  const done = getTask(again.db, s.taskId)!;
  assert.equal(done.status, "awaiting_decision", done.reason ?? "");
  assert.deepEqual(listApprovals(again.db).map((a) => a.status), ["superseded", "allowed"]);
  assert.deepEqual(events().at(-1), { type: "turn_ended", reason: "completed", detail: null });
  assert.equal(git(s.repo, "show", `${s.branch}:partial.txt`), "written before the stop\n");
});

test("a database from before this unit gains the parked-approval columns and the new log rules, and keeps its approvals and its log", (t) => {
  const dir = tempDir("smelt-recover-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const old = new DatabaseSync(path.join(home, DB_FILE));
  old.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (4);");
  for (const migration of MIGRATIONS.slice(0, 4)) old.exec(migration.sql);
  old.exec(`
    INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'ended', 't0', 't0');
    INSERT INTO tasks (repo_path, prompt, status, created_at, updated_at) VALUES ('/r', 'p', 'awaiting_decision', 't0', 't0');
    INSERT INTO approvals (task_id, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at, resolved_at) VALUES (1, 1, 'implementer', 'Bash', 'ls', '.', 'toolu_1', 'allowed', 't1', 't2');
    INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd) VALUES ('t1', 1, 1, 1, 'asked_owner', 'Bash', 'ls', '.');
    INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail) VALUES ('t2', 1, 1, 1, 'owner_allowed', 'Bash', 'ls', '.', 'kept');
  `);
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), 5);
  assert.deepEqual(listApprovals(db).map((a) => [a.id, a.status, a.command, a.parkedAt, a.storedDecision]), [[1, "allowed", "ls", null, null]]);
  assert.deepEqual(actionLog(db).map((e) => [e.id, e.ts, e.rule, e.approvalId, e.detail]), [[1, "t1", "asked_owner", 1, null], [2, "t2", "owner_allowed", 1, "kept"]]);
  db.prepare("INSERT INTO action_log (ts, task_id, approval_id, rule, tool, command, cwd) VALUES ('t3', 1, 1, 'stored_answer_applied', 'Bash', 'ls', '.')").run();
  assert.deepEqual(actionLog(db).map((e) => e.id), [1, 2, 3], "new entries follow the kept ones");
  assert.throws(() => db.prepare("DELETE FROM action_log").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE action_log SET detail = 'x'").run(), /append-only/);
});
