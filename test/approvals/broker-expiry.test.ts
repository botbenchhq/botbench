import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, appendLog, ApprovalError, createBroker, expiredWords, getApproval, listApprovals, permissionResponse, repeatWords, type Answer, type Approval, type Broker } from "../../src/approvals/broker.ts";
import { controlAnswer } from "../../src/drivers/claude-code.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { insertStanding } from "../../src/approvals/grants.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// An approval time limit and the refusal of a request the owner already declined in the same task, with the real store,
// the real broker and its socket. Requests are put to it the way an attempt's CLI puts them: the pre-tool hook first,
// then the CLI's own request. A run's limit is in minutes; these brokers are asked for a short minute (`minuteMs`), as
// the pairing tests ask for a short lifetime: the clock is never changed.

type T = { after(fn: () => unknown): void };

const MINUTE_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Bench {
  db: DatabaseSync;
  dir: string;
  home: string;
  broker: Broker;
  changes: Approval[];
  stored: Approval[];
  /** What parks each admitted attempt, as a stopping Botbench parks one that waits for the owner. */
  parkers: (() => void)[];
  /** Stop this Botbench as a stop with approvals pending does, and start another on the same store. */
  restart(o?: { before?: () => Promise<void> }): Promise<void>;
}

async function bench(t: T): Promise<Bench> {
  const dir = tempDir("botbench-broker-expiry-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const b = { db, dir, home, changes: [] as Approval[], stored: [] as Approval[], parkers: [] as (() => void)[] } as Bench;
  const open = async (): Promise<void> => {
    b.broker = createBroker({ db, home, minuteMs: MINUTE_MS, onChange: (approval) => b.changes.push(approval) });
    b.broker.onStoredAnswer((approval) => b.stored.push(approval));
    await b.broker.listen();
  };
  await open();
  b.restart = async (o = {}) => {
    for (const park of b.parkers.splice(0)) park();
    await b.broker.close();
    await o.before?.();
    await open();
  };
  t.after(async () => {
    await b.broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return b;
}

let n = 0;
interface Agent {
  taskId: number;
  runId: number;
  attemptId: number;
  /** Ask as the CLI asks, and return the answer still to come, without answering anything. */
  ask(command: string, o?: { callId?: string; cwd?: string }): Promise<Answer>;
}

/** A task of a run in `mode` with an approval limit of `limit` minutes (none when null), with an attempt admitted as `role`. */
function agent(b: Bench, o: { mode?: RunMode; limit?: number | null; role?: string; preapproved?: string[]; same?: { taskId: number; runId: number; worktree: string }; resumes?: number } = {}): Agent & { worktree: string; supersede(toolCallId: string): void } {
  const role = o.role ?? "implementer";
  let taskId: number;
  let runId: number;
  let worktree: string;
  if (o.same) {
    ({ taskId, runId, worktree } = o.same);
  } else {
    worktree = path.join(b.dir, `worktree-${++n}`);
    fs.mkdirSync(path.join(worktree, "sub"), { recursive: true });
    const repo = path.join(b.dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const run = createRun(b.db, { repo, prompt: "p", baseCommit: "0".repeat(40), mode: o.mode ?? "manual", ...(o.preapproved ? { preapproved: o.preapproved } : {}), ...(o.limit === undefined || o.limit === null ? {} : { approvalLimitMinutes: o.limit }) });
    const stored = storePlan(b.db, run.id, [{ title: "t", criteria: ["c"] }]);
    runId = run.id;
    taskId = approvePlan(b.db, run.id, stored.planVersion, null, o.mode === "full" ? "mode" : "owner").tasks[0]!.id;
  }
  const attemptId = Number(b.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  // A run's task records its attempt as the engine does, so a resumed one is the attempt its task stands at.
  b.db.prepare("UPDATE tasks SET attempt_id = ? WHERE id = ?").run(attemptId, taskId);
  const admission = b.broker.admit({ taskId, role, worktree, ...(o.resumes === undefined ? {} : { resumes: o.resumes }) });
  admission.bind(attemptId);
  b.parkers.push(() => admission.park());
  const real = fs.realpathSync(worktree);
  let call = 0;
  const ask = async (command: string, a: { callId?: string; cwd?: string } = {}): Promise<Answer> => {
    const toolCallId = a.callId ?? `call-${attemptId}-${++call}`;
    await askBroker(admission.socketPath, admission.secret, { tool_name: "Bash", tool_input: { command }, tool_use_id: toolCallId, cwd: a.cwd === undefined ? real : path.join(real, a.cwd) });
    return b.broker.request({ taskId, attemptId, role, tool: "Bash", command, input: { command }, reason: null, toolCallId });
  };
  return { taskId, runId, attemptId, ask, worktree, supersede: (toolCallId) => admission.supersede(toolCallId) };
}

const rulesOf = (b: Bench, approvalId: number): string[] => b.db.prepare("SELECT rule FROM action_log WHERE approval_id = ? ORDER BY id").all(approvalId).map((row) => String(row.rule));
const onlyPending = (b: Bench): Approval => {
  const pending = listApprovals(b.db, "pending");
  assert.equal(pending.length, 1, "one approval waits");
  return pending[0]!;
};
/** Settle a promise or say it is still waiting, after `ms`. */
const within = <V>(p: Promise<V>, ms: number): Promise<V | "waiting"> => Promise.race([p, sleep(ms).then(() => "waiting" as const)]);

test("in a run with a one-minute limit, a pending approval is declined by Botbench after the minute: one expired_unanswered row, no owner_declined row, and the agent is told nobody answered in time", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  const asked = a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  assert.equal(Date.parse(approval.expiresAt!) - Date.parse(approval.createdAt), MINUTE_MS, "it expires a minute after it was asked");
  // Measured from the stored time, so a slow machine does not make it look early.
  const left = Date.parse(approval.expiresAt!) - Date.now();
  if (left > 20) assert.equal(await within(asked, left / 2), "waiting", "nothing is decided before the minute");
  const answer = await asked;
  assert.equal(answer.decision, "decline");
  assert.equal(answer.approvalId, approval.id);
  assert.equal(answer.expired, true);
  assert.match(answer.refused!, /^Nobody answered this request within the run's approval time limit of 1 minute, so Botbench denied it\. It was not run\.$/);
  const after = getApproval(b.db, approval.id)!;
  assert.deepEqual([after.status, after.note, after.expiredAt !== null, after.resolvedAt !== null], ["declined", null, true, true]);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"]);
  assert.equal(actionLog(b.db, a.taskId).filter((entry) => entry.rule === "expired_unanswered").length, 1);
  assert.match(actionLog(b.db, a.taskId).find((entry) => entry.rule === "expired_unanswered")!.detail!, /Nobody answered/);
  // What the driver is handed: a decline Botbench made, which says so, never one of the owner's.
  assert.deepEqual(permissionResponse(answer), { decision: "decline", note: null, refused: answer.refused, preapproved: false, standing: false, mode: false, files: false, web: false, bookkeeping: false, chat: false, expired: true });
  // The card is told the approval ended.
  assert.equal(b.changes.at(-1)!.status, "declined");
  // The owner's answer after it is refused, and changes nothing.
  assert.throws(() => b.broker.answer(approval.id, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /Nobody answered it in time/.test(err.message));
  await sleep(MINUTE_MS);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"]);
});

test("Claude Code is told an expiry in Botbench's own words: nobody answered in time, not that the owner denied it or was never asked", () => {
  const request = { type: "permission_request" as const, id: "req-1", toolCallId: "toolu_1", name: "Bash", input: { command: "git push" }, reason: null };
  const told = expiredWords(1);
  const answered = controlAnswer(request, { decision: "decline", note: null, refused: told, expired: true });
  assert.deepEqual(answered, { reply: { behavior: "deny", message: `${told} Do not try to get the same thing done another way.` }, decision: "denied", note: told });
  assert.doesNotMatch(String(answered.reply.message), /owner denied|without asking the owner/);
  // A repeat of a denied request is refused without asking: that is what Claude Code is told, with the owner's note.
  const repeat = controlAnswer(request, { decision: "decline", note: "Use a pull request.", refused: repeatWords("Use a pull request.") });
  assert.match(String(repeat.reply.message), /^Botbench's permission check denied this request without asking the owner: You denied this same request earlier in this task.*“Use a pull request\.”/);
});

test("a run with no limit never expires an approval, and an approval the owner answered before the limit is not touched", async (t) => {
  const b = await bench(t);
  const free = agent(b, { limit: null });
  const waiting = free.ask("git push origin main");
  await sleep(20);
  const unlimited = onlyPending(b);
  assert.equal(unlimited.expiresAt, null);
  assert.equal(await within(waiting, MINUTE_MS * 3), "waiting", "it still waits for the owner");
  assert.equal(getApproval(b.db, unlimited.id)!.status, "pending");
  b.broker.answer(unlimited.id, "decline");
  await waiting;

  const limited = agent(b, { limit: 1 });
  const allowed = limited.ask("git push origin main");
  await sleep(20);
  const first = onlyPending(b);
  b.broker.answer(first.id, "allow");
  assert.equal((await allowed).decision, "allow");
  const declined = limited.ask("npm publish");
  await sleep(20);
  const second = onlyPending(b);
  b.broker.answer(second.id, "decline", "Not this week.");
  assert.deepEqual([(await declined).decision, (await declined).note], ["decline", "Not this week."]);
  // Long past their minute: neither is changed, and neither has an expiry on record.
  await sleep(MINUTE_MS * 2);
  assert.deepEqual([getApproval(b.db, first.id)!.status, getApproval(b.db, first.id)!.expiredAt], ["allowed", null]);
  assert.deepEqual([getApproval(b.db, second.id)!.status, getApproval(b.db, second.id)!.note, getApproval(b.db, second.id)!.expiredAt], ["declined", "Not this week.", null]);
  assert.deepEqual(rulesOf(b, first.id), ["asked_owner", "owner_allowed"]);
  assert.deepEqual(rulesOf(b, second.id), ["asked_owner", "owner_declined"]);
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM action_log WHERE rule = 'expired_unanswered'").get()!.n, 0);
});

test("an expiry cannot overwrite the owner's answer: answered at the last moment, the answer stands; the store refuses an expiry of an answered approval", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  const asked = a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  // Just before its time, measured from the stored time.
  await sleep(Math.max(0, Date.parse(approval.expiresAt!) - Date.now() - 60));
  assert.equal(getApproval(b.db, approval.id)!.status, "pending", "still waiting at the last moment");
  b.broker.answer(approval.id, "allow");
  assert.equal((await asked).decision, "allow");
  await sleep(MINUTE_MS);
  assert.equal(getApproval(b.db, approval.id)!.status, "allowed");
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "owner_allowed"]);
  // Even written straight to the store, an answered approval cannot be made expired.
  assert.throws(() => b.db.prepare("UPDATE approvals SET expired_at = ? WHERE id = ?").run(new Date().toISOString(), approval.id), /already answered|expires once/);
});

test("an answer given after the limit, before the timer has run, is refused: the approval is denied by Botbench instead, once", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  const asked = a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  // Past its time without giving the timer a turn: nothing else runs while this waits.
  const due = Date.parse(approval.expiresAt!);
  while (Date.now() <= due) {
    // busy until just past the limit
  }
  assert.throws(() => b.broker.answer(approval.id, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /Nobody answered it in time/.test(err.message));
  assert.throws(() => b.broker.grantStanding(approval.id), ApprovalError);
  const answer = await asked;
  assert.deepEqual([answer.decision, answer.expired], ["decline", true]);
  assert.equal(getApproval(b.db, approval.id)!.status, "declined");
  await sleep(MINUTE_MS);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"]);
});

test("past the limit, an answer is refused even when Botbench's denial cannot be written; its timer then denies it once the write works", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  const asked = a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  // The store refuses the expiry's record, as a full disk would.
  b.db.exec("CREATE TRIGGER refuse_expiry BEFORE INSERT ON action_log WHEN NEW.rule = 'expired_unanswered' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const due = Date.parse(approval.expiresAt!);
  while (Date.now() <= due) {
    // busy until just past the limit, so the timer has had no turn
  }
  for (const decision of ["allow", "decline"] as const) assert.throws(() => b.broker.answer(approval.id, decision), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /Nobody answered it in time/.test(err.message), decision);
  assert.throws(() => b.broker.grantStanding(approval.id), (err: unknown) => err instanceof ApprovalError && err.status === 409);
  assert.deepEqual([getApproval(b.db, approval.id)!.status, getApproval(b.db, approval.id)!.expiredAt], ["pending", null], "nothing was written, and nothing allowed");
  b.db.exec("DROP TRIGGER refuse_expiry");
  const answer = await asked;
  assert.deepEqual([answer.decision, answer.expired], ["decline", true]);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"]);
});

test("the expiry timer survives a restart: an approval past its limit when Botbench starts is declined at that start, once, and a second start adds nothing", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  const asked = a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  // Botbench stops with the approval pending, and stays stopped past its minute.
  await b.restart({ before: () => sleep(MINUTE_MS * 2) });
  assert.equal((await asked).decision, "decline", "the stopping Botbench let its waiter go");
  await sleep(30);
  const at = getApproval(b.db, approval.id)!;
  // Parked, it is declined as an answer stored for the resumed task: Botbench's, never the owner's.
  assert.deepEqual([at.status, at.storedDecision, at.expiredAt !== null], ["pending", "decline", true]);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"]);
  assert.deepEqual(b.stored.map((s) => s.id), [approval.id], "its task is told, to be resumed with the decline");

  await b.restart();
  await sleep(MINUTE_MS);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"], "a second start adds no row");

  // The resumed attempt asks again and is given the decline, which says nobody answered.
  const resumed = agent(b, { same: { taskId: a.taskId, runId: a.runId, worktree: a.worktree }, resumes: a.attemptId });
  const again = await resumed.ask("git push origin main");
  assert.deepEqual([again.decision, again.approvalId, again.expired], ["decline", approval.id, true]);
  assert.match(again.refused!, /Nobody answered this request within the run's approval time limit/);
  assert.equal(getApproval(b.db, approval.id)!.status, "declined");
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered", "stored_answer_applied"]);
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM action_log WHERE rule = 'owner_declined'").get()!.n, 0);
});

test("a restart before the limit has passed neither loses the expiry nor brings it forward", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 2 });
  void a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  await b.restart();
  await sleep(MINUTE_MS);
  assert.deepEqual([getApproval(b.db, approval.id)!.storedDecision, getApproval(b.db, approval.id)!.expiredAt], [null, null], "not before its time");
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner"]);
  await sleep(MINUTE_MS * 2);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "expired_unanswered"]);
  assert.equal(getApproval(b.db, approval.id)!.storedDecision, "decline");
});

test("an owner's answer stored for a parked approval before its limit is never overwritten by the expiry", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  void a.ask("git push origin main");
  await sleep(20);
  const approval = onlyPending(b);
  await b.restart();
  b.broker.answer(approval.id, "allow");
  await sleep(MINUTE_MS * 2);
  assert.deepEqual([getApproval(b.db, approval.id)!.storedDecision, getApproval(b.db, approval.id)!.expiredAt], ["allow", null]);
  assert.deepEqual(rulesOf(b, approval.id), ["asked_owner", "owner_allowed"]);
});

test("within one task, the same request as one the owner declined is declined at once, with no approval and no card: the agent is told the owner's note, and one repeat_declined row names the earlier approval", async (t) => {
  const b = await bench(t);
  const a = agent(b);
  const first = a.ask("git push origin main", { cwd: "sub" });
  await sleep(20);
  const declined = onlyPending(b);
  b.broker.answer(declined.id, "decline", "Open a pull request instead.");
  await first;
  const cards = b.changes.length;

  const again = await a.ask("git push origin main", { cwd: "sub" });
  assert.deepEqual([again.decision, again.approvalId, again.note], ["decline", null, "Open a pull request instead."]);
  assert.equal(again.refused, "You denied this same request earlier in this task, so Botbench denied it again without asking you. Your note then: “Open a pull request instead.” Do not try to get the same thing done another way.");
  assert.equal(listApprovals(b.db, "pending").length, 0, "nothing waits");
  assert.equal(listApprovals(b.db).length, 1, "no approval was written");
  assert.equal(b.changes.length, cards, "no card was announced");
  const repeats = actionLog(b.db, a.taskId).filter((entry) => entry.rule === "repeat_declined");
  assert.equal(repeats.length, 1);
  assert.deepEqual([repeats[0]!.approvalId, repeats[0]!.command, repeats[0]!.cwd, repeats[0]!.attemptId], [declined.id, "git push origin main", "sub", a.attemptId]);
  assert.match(repeats[0]!.detail!, /Open a pull request instead/);
  // With no note, the agent is told there was none.
  const quiet = a.ask("npm publish", { cwd: "sub" });
  await sleep(20);
  b.broker.answer(onlyPending(b).id, "decline");
  await quiet;
  assert.match((await a.ask("npm publish", { cwd: "sub" })).refused!, /You left no note\./);
});

test("the same command in another task, another folder or as another role still asks; one the owner allowed, one superseded and one that expired do not trigger the repeat refusal", async (t) => {
  const b = await bench(t);
  const a = agent(b, { limit: 1 });
  const first = a.ask("git push origin main");
  await sleep(20);
  b.broker.answer(onlyPending(b).id, "decline", "No.");
  await first;
  const asks = async (who: Agent, command: string, cwd?: string): Promise<Approval> => {
    const answer = who.ask(command, cwd === undefined ? {} : { cwd });
    await sleep(20);
    const pending = onlyPending(b);
    b.broker.answer(pending.id, "allow");
    assert.equal((await answer).decision, "allow");
    return pending;
  };
  // Another folder, another role in the same task, another task.
  await asks(a, "git push origin main", "sub");
  const role = agent(b, { role: "check_fixer", same: { taskId: a.taskId, runId: a.runId, worktree: a.worktree } });
  await asks(role, "git push origin main");
  const other = agent(b, { limit: 1 });
  await asks(other, "git push origin main");
  // Allowed before: asked again, as before.
  await asks(a, "npm publish");
  await asks(a, "npm publish");
  // Superseded before: the CLI stopped waiting, so it is asked again.
  const left = a.ask("npm audit fix --force", { callId: "gone" });
  await sleep(20);
  const gone = onlyPending(b);
  a.supersede("gone");
  await left;
  assert.equal(getApproval(b.db, gone.id)!.status, "superseded");
  await asks(a, "npm audit fix --force");
  // Expired before: nobody answered it, so it is asked again.
  const expiring = a.ask("git push --tags");
  await sleep(20);
  const lapsed = onlyPending(b);
  assert.equal((await expiring).expired, true);
  assert.equal(getApproval(b.db, lapsed.id)!.status, "declined");
  await asks(a, "git push --tags");
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM action_log WHERE rule = 'repeat_declined'").get()!.n, 0);
});

test("neither the expiry nor the repeat refusal ever allows: not in a fully autonomous run, not with commands allowed for the run or always allowed", async (t) => {
  const b = await bench(t);
  // A fully autonomous run asks nobody, so nothing of it waits to expire; its limit changes nothing.
  const full = agent(b, { mode: "full", limit: 1 });
  const refused = await full.ask("git push origin main");
  assert.deepEqual([refused.decision, refused.approvalId, refused.expired], ["decline", null, undefined]);
  assert.equal(listApprovals(b.db).length, 0);

  // A manual run with commands allowed for it, and one always allowed, with a limit: what they allow is allowed as before.
  const granted = agent(b, { limit: 1, preapproved: ["npm test"] });
  const repo = String(b.db.prepare("SELECT repo_path FROM tasks WHERE id = ?").get(granted.taskId)!.repo_path);
  // Given as the owner gives one: the grant and its entry in the log, without which it does not stand.
  const grantId = insertStanding(b.db, { role: "implementer", repo, cwd: ".", words: ["npm", "run", "lint"], taskId: granted.taskId });
  appendLog(b.db, { taskId: granted.taskId, attemptId: null, grantId, rule: "standing_granted", tool: "Bash", command: "npm run lint", cwd: "." });
  assert.deepEqual([(await granted.ask("npm test")).decision, (await granted.ask("npm test")).preapproved !== undefined], ["allow", true]);
  assert.deepEqual([(await granted.ask("npm run lint")).decision, (await granted.ask("npm run lint")).standing !== undefined], ["allow", true]);
  // What asks expires into a decline, and its repeat is declined: the only decision either path gives.
  const outcomes: Answer[] = [];
  for (const command of ["git push origin main", "npm publish"]) {
    const expiring = granted.ask(command);
    outcomes.push(await expiring);
  }
  // The owner declines a third; asked again, it is refused as a repeat.
  const third = granted.ask("rm -rf node_modules/.cache");
  await sleep(20);
  b.broker.answer(onlyPending(b).id, "decline");
  outcomes.push(await third);
  outcomes.push(await granted.ask("rm -rf node_modules/.cache"));
  assert.deepEqual(outcomes.map((o) => o.decision), ["decline", "decline", "decline", "decline"]);
  assert.deepEqual(outcomes.map((o) => o.expired === true), [true, true, false, false]);
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM action_log WHERE rule = 'repeat_declined'").get()!.n, 1);
  // The grants still allow exactly what they allowed, after it all.
  assert.equal((await granted.ask("npm test")).decision, "allow");
  // Nothing either path wrote is an allow, an allowed approval or a grant.
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'allowed' OR stored_decision = 'allow'").get()!.n, 0);
  assert.equal(b.db.prepare("SELECT count(*) AS n FROM action_log WHERE rule = 'owner_allowed' OR (rule = 'standing_granted' AND grant_id <> ?)").get(grantId)!.n, 0);
});
