import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker, getApproval, listApprovals, type Answer, type Broker } from "../src/approvals/broker.ts";
import { askBroker } from "../src/approvals/permission-proxy.ts";
import { approvePlan, createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { approvalReminderMessage, createPush, readyReminderMessage, type Push } from "../src/push.ts";
import { now, openStore } from "../src/store/db.ts";
import { decrypt, newDevice, startPushEndpoint, type PushEndpoint } from "./support/push-service.ts";
import { tempDir } from "./support/repo.ts";

// What was sent to the owner's devices, kept in the store: each approval and each task is announced once, across a
// restart too, and one still waiting for the owner past the reminder wait is reminded of once, and never again. The
// real store, the real broker wired to the notifications as the server wires them, and a real HTTP endpoint in the
// place of the push service. The wait is asked short; the clock is never changed.

type T = { after(fn: () => unknown): void };

const WAIT_MS = 200;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Bench {
  db: DatabaseSync;
  dir: string;
  home: string;
  endpoint: PushEndpoint;
  push: Push;
  broker: Broker;
  /** The titles the phone received, in order. */
  titles(): string[];
  /** Stop this Botbench, with what waits for the owner parked, and start another over the same store. */
  restart(o?: { before?: () => Promise<void> }): Promise<void>;
  /** What parks each admitted attempt, as a stopping Botbench parks one that waits for the owner. */
  parkers: (() => void)[];
}

async function bench(t: T): Promise<Bench> {
  const dir = tempDir("botbench-push-reminders-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const endpoint = await startPushEndpoint();
  const phone = newDevice();
  const b = { db, dir, home, endpoint, parkers: [] as (() => void)[] } as Bench;
  const open = async (): Promise<void> => {
    b.push = createPush({ db, home, allowHttpEndpoints: true, reminderAfterMs: WAIT_MS });
    const push = b.push;
    // A short minute for a run's approval time limit; the clock is never changed.
    b.broker = createBroker({ db, home, minuteMs: WAIT_MS / 2, onChange: (approval) => push.approvalChanged(approval) });
    await b.broker.listen();
  };
  await open();
  b.push.subscribe(phone.subscription(endpoint.url("phone")));
  b.titles = () => endpoint.received.map((r) => (JSON.parse(decrypt(r.body, phone.privateKey, phone.auth).toString()) as { title: string }).title);
  b.restart = async (o = {}) => {
    for (const park of b.parkers.splice(0)) park();
    await b.broker.close();
    await b.push.idle();
    b.push.close();
    await o.before?.();
    await open();
  };
  t.after(async () => {
    await b.broker.close();
    await b.push.idle();
    b.push.close();
    await endpoint.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return b;
}

/** A task of its own, building in a folder, with an attempt admitted: `ask` puts a command to the broker as its CLI would. */
function building(b: Bench, o: { limit?: number } = {}): { taskId: number; ask(command: string): Promise<Answer> } {
  const worktree = path.join(b.dir, `worktree-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(worktree, { recursive: true });
  const repo = path.join(b.dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  let task: { id: number };
  if (o.limit === undefined) {
    task = createTask(b.db, { repo, prompt: "p" });
  } else {
    // A task of a run with an approval time limit, as an approved plan makes one.
    const run = createRun(b.db, { repo, prompt: "p", baseCommit: "0".repeat(40), approvalLimitMinutes: o.limit });
    task = approvePlan(b.db, run.id, storePlan(b.db, run.id, [{ title: "t", criteria: ["c"] }]).planVersion, null, "owner").tasks[0]!;
  }
  moveTask(b.db, task.id, "building");
  const attemptId = Number(b.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', ?, ?)").run(now(), now()).lastInsertRowid);
  const admission = b.broker.admit({ taskId: task.id, role: "implementer", worktree });
  admission.bind(attemptId);
  b.parkers.push(() => admission.park());
  let call = 0;
  return {
    taskId: task.id,
    ask: async (command) => {
      const toolCallId = `call-${++call}`;
      await askBroker(admission.socketPath, admission.secret, { tool_name: "Bash", tool_input: { command }, tool_use_id: toolCallId, cwd: fs.realpathSync(worktree) });
      return b.broker.request({ taskId: task.id, attemptId, role: "implementer", tool: "Bash", command, input: { command }, reason: null, toolCallId });
    },
  };
}

/** A task that reached Ready for review, announced as the engine announces it. */
function ready(b: Bench): number {
  const task = createTask(b.db, { repo: path.join(b.dir, "repo"), prompt: "p" });
  for (const status of ["building", "verifying", "awaiting_decision"] as const) moveTask(b.db, task.id, status);
  b.push.taskChanged({ id: task.id, status: "awaiting_decision" });
  return task.id;
}

/** Until `n` approvals wait, once their requests have crossed the socket and been written: up to two seconds on a busy machine. */
async function waiting(b: Bench, n: number): Promise<void> {
  for (const until = Date.now() + 2000; listApprovals(b.db, "pending").length < n && Date.now() < until; ) await sleep(5);
  assert.equal(listApprovals(b.db, "pending").length, n, `${n} approvals wait`);
}

const sentRows = (b: Bench): unknown[] => b.db.prepare("SELECT subject, subject_id, title FROM push_sent ORDER BY rowid").all().map((row) => ({ ...row }));

test("an approval is announced once and the announcement is kept in the store: one announced before a restart is not announced again after it", async (t) => {
  const b = await bench(t);
  const task = building(b);
  void task.ask("git push origin main");
  await waiting(b, 1);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting"]);
  const approval = listApprovals(b.db, "pending")[0]!;
  assert.deepEqual(sentRows(b), [{ subject: "approval", subject_id: approval.id, title: "An approval is waiting" }]);
  // The same approval announced again, here or by the next Botbench, as it was when it was first asked: nothing more is sent.
  b.push.approvalChanged(approval);
  await b.restart();
  b.push.approvalChanged(approval);
  b.push.approvalChanged(getApproval(b.db, approval.id)!);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting"]);
});

test("an approval still waiting past the reminder wait is reminded of once, and a restart after that sends nothing more for it", async (t) => {
  const b = await bench(t);
  const task = building(b);
  void task.ask("git push origin main");
  await waiting(b, 1);
  const approval = listApprovals(b.db, "pending")[0]!;
  await sleep(WAIT_MS / 2);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting"], "not before the wait");
  await sleep(WAIT_MS);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting", "An approval is still waiting"]);
  assert.deepEqual(approvalReminderMessage(approval), { title: "An approval is still waiting", path: `/#/tasks/${task.taskId}` });
  await sleep(WAIT_MS * 2);
  await b.restart();
  await sleep(WAIT_MS * 2);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting", "An approval is still waiting"], "exactly one reminder, across a restart too");
  assert.equal(getApproval(b.db, approval.id)!.status, "pending", "it still waits for the owner");
});

test("after a restart, an approval still pending sends nothing more, not even the reminder it had not had yet; one answered before the wait gets none", async (t) => {
  const b = await bench(t);
  const kept = building(b);
  void kept.ask("git push origin main");
  const answered = building(b);
  const answering = answered.ask("npm publish");
  await waiting(b, 2);
  const [left, toAnswer] = listApprovals(b.db, "pending");
  b.broker.answer(toAnswer!.id, "decline");
  await answering;
  await b.restart();
  // Well past the reminder wait of both.
  await sleep(WAIT_MS * 2);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting", "An approval is waiting"], "no further push after the restart");
  assert.equal(getApproval(b.db, left!.id)!.status, "pending", "it still waits for the owner");
  assert.notEqual(getApproval(b.db, left!.id)!.parkedAt, null, "parked by the restart");
  assert.deepEqual(sentRows(b).filter((row) => (row as { title: string }).title === "An approval is still waiting"), []);
});

test("an approval past its run's approval time limit when Botbench starts is denied, and gets no reminder, even though its reminder wait passed too", async (t) => {
  const b = await bench(t);
  const task = building(b, { limit: 1 });
  void task.ask("git push origin main");
  await waiting(b, 1);
  const approval = listApprovals(b.db, "pending")[0]!;
  // Stopped past both its time limit and the reminder wait.
  await b.restart({ before: () => sleep(WAIT_MS * 2) });
  await sleep(WAIT_MS);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["An approval is waiting"], "no reminder for what Botbench denied");
  assert.equal(getApproval(b.db, approval.id)!.storedDecision, "decline");
  assert.notEqual(getApproval(b.db, approval.id)!.expiredAt, null);
});

test("a task still Ready for review past the wait is reminded of once, across a restart too; one the owner decided before the wait gets none", async (t) => {
  const b = await bench(t);
  const waiting = ready(b);
  const decided = ready(b);
  // The owner rejects one before the wait, as engine/decision.ts writes it.
  b.db.prepare("INSERT INTO decisions (task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at) VALUES (?, 'owner', 'reject', 'deleted', 'b', NULL, '[]', ?)").run(decided, now());
  moveTask(b.db, decided, "rejected");
  await b.push.idle();
  assert.deepEqual(b.titles(), ["A task is ready for review", "A task is ready for review"]);
  // Stopped and started again before the wait: the reminder comes at its time, from the stored time of the first notice.
  await b.restart();
  await sleep(WAIT_MS / 3);
  await b.push.idle();
  assert.equal(b.titles().length, 2, "not early");
  await sleep(WAIT_MS);
  await b.push.idle();
  assert.deepEqual(b.titles(), ["A task is ready for review", "A task is ready for review", "A task is still ready for review"]);
  assert.deepEqual(readyReminderMessage({ id: waiting }), { title: "A task is still ready for review", path: `/#/tasks/${waiting}` });
  // Seen again, and after another restart: nothing more.
  b.push.taskChanged({ id: waiting, status: "awaiting_decision" });
  await b.restart();
  await sleep(WAIT_MS * 2);
  await b.push.idle();
  assert.equal(b.titles().length, 3);
  assert.deepEqual(sentRows(b).filter((row) => (row as { subject_id: number }).subject_id === decided), [{ subject: "task", subject_id: decided, title: "A task is ready for review" }]);
});
