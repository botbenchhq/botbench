import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, ApprovalError, createBroker, listApprovals, waitingOnApproval, type Answer, type Approval, type Broker } from "../../src/approvals/broker.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { AUTONOMOUS_ANSWER } from "../../src/approvals/question.ts";
import { autoAccept, modeRefusals, unaskedQuestions, type RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { createPush } from "../../src/push.ts";
import { openStore } from "../../src/store/db.ts";
import { decrypt, newDevice, startPushEndpoint } from "../support/push-service.ts";
import { tempDir } from "../support/repo.ts";

// An agent's question to the owner (src/approvals/question.ts), through the real broker on the real store and socket. A
// question is put to the broker the way the CLI puts it: the pre-tool hook first, then the CLI's own permission prompt,
// whose input is in the shape AskUserQuestion has (Anthropic's Agent SDK guide; the owner's capture records it).

type T = { after(fn: () => unknown): void };
interface Rig {
  db: DatabaseSync;
  broker: Broker;
  dir: string;
  changes: Approval[];
}

async function rig(t: T): Promise<Rig> {
  const dir = tempDir("botbench-question-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const changes: Approval[] = [];
  const broker = createBroker({ db, home, onChange: (approval) => changes.push(approval) });
  await broker.listen();
  t.after(async () => {
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, broker, dir, changes };
}

const QUESTION = "Which greeting should I use?";
const input = (over: Record<string, unknown> = {}) => ({ questions: [{ question: QUESTION, header: "Greeting", options: [{ label: "Hello", description: "The long one" }, { label: "Hi", description: "The short one" }], multiSelect: false, ...over }] });

let n = 0;
/** An agent of a run in `mode`, admitted and standing in its copy: the task's builder, or with `planner` the run's planner (read-only, as the engine admits it). */
function agent(r: Rig, mode: RunMode, o: { planner?: boolean } = {}) {
  const worktree = path.join(r.dir, `worktree-${++n}`);
  fs.mkdirSync(worktree, { recursive: true });
  const repo = path.join(r.dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const run = createRun(r.db, { repo, prompt: "p", baseCommit: "0".repeat(40), mode });
  let taskId: number | null = null;
  if (!o.planner) {
    const stored = storePlan(r.db, run.id, [{ title: "t", criteria: ["c"] }]);
    taskId = approvePlan(r.db, run.id, stored.planVersion, null, mode === "full" ? "mode" : "owner").tasks[0]!.id;
  }
  const attemptId = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const role = o.planner ? "planner" : "implementer";
  const admission = r.broker.admit({ ...(taskId === null ? { runId: run.id, readOnly: true } : { taskId }), role, worktree, confined: true });
  admission.bind(attemptId);
  /** The CLI's question: what its hook hears, then its own request, which waits for an answer. */
  const ask = async (given: unknown, toolCallId = `toolu_${++n}`): Promise<{ hook: string; answer: Promise<Answer> }> => {
    const hook = await askBroker(admission.socketPath, admission.secret, { tool_name: "AskUserQuestion", tool_input: given as Record<string, unknown>, tool_use_id: toolCallId, cwd: fs.realpathSync(worktree) });
    const answer = r.broker.request({ taskId, ...(taskId === null ? { runId: run.id } : {}), attemptId, role, tool: "AskUserQuestion", command: summarize("AskUserQuestion", given), input: given, reason: null, toolCallId });
    return { hook: hook.verdict, answer };
  };
  return { taskId, runId: run.id, attemptId, ask };
}

const settled = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return done;
};

test("a question with one valid question and two choices is a pending approval of its own kind, with no command on its card, and its task needs input until the owner answers", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi");
  const { hook, answer } = await a.ask(input());
  assert.equal(hook, "ask", "the hook lets the CLI ask, so the question reaches Botbench as a permission prompt");
  assert.equal(await settled(answer), false, "it waits for the owner");
  const [card, ...more] = listApprovals(r.db, "pending");
  assert.equal(more.length, 0);
  assert.deepEqual([card!.taskId, card!.tool, card!.command, card!.status, card!.answer, card!.asksBecause, card!.target], [a.taskId, "AskUserQuestion", QUESTION, "pending", null, null, null]);
  assert.deepEqual(card!.question, { text: QUESTION, header: "Greeting", choices: [{ label: "Hello", description: "The long one" }, { label: "Hi", description: "The short one" }] });
  assert.equal(waitingOnApproval(r.db, a.taskId!), true, "the task shows Needs input, as for a waiting approval");
  assert.equal(r.broker.standingOffer(card!.id), null, "a question offers no standing permission");
  assert.deepEqual(r.changes.map((c) => c.id), [card!.id], "announced once, as any new approval is");

  const answered = r.broker.answerQuestion(card!.id, "Hi");
  assert.deepEqual([answered.status, answered.answer, answered.storedDecision], ["allowed", "Hi", null]);
  assert.deepEqual(await answer, { decision: "allow", note: null, approvalId: card!.id, refused: null, answers: { [QUESTION]: "Hi" } });
  assert.equal(waitingOnApproval(r.db, a.taskId!), false);
  assert.deepEqual(actionLog(r.db, a.taskId!).map((e) => [e.rule, e.command, e.detail]), [
    ["asked_owner", QUESTION, null],
    ["owner_answered", QUESTION, "Hi"],
  ]);
});

test("the owner's own words are stored as given and handed back as the answer; an already-answered question cannot be answered twice, and a question is never answered with Allow or Deny", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  const { answer } = await a.ask(input());
  const [card] = listApprovals(r.db, "pending");
  assert.throws(() => r.broker.answer(card!.id, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /a question from Claude Code/.test(err.message));
  assert.throws(() => r.broker.answer(card!.id, "decline"), (err: unknown) => err instanceof ApprovalError && err.status === 409);
  assert.throws(() => r.broker.answerQuestion(card!.id, "   "), (err: unknown) => err instanceof ApprovalError && err.status === 400);
  assert.throws(() => r.broker.answerQuestion(card!.id, "x".repeat(2001)), (err: unknown) => err instanceof ApprovalError && err.status === 400);
  assert.deepEqual(listApprovals(r.db, "pending").map((p) => p.id), [card!.id], "nothing was answered by a refused try");

  const own = "  Neither: use `Good morning` <b>please</b>  ";
  r.broker.answerQuestion(card!.id, own);
  assert.deepEqual((await answer).answers, { [QUESTION]: own });
  assert.equal(listApprovals(r.db)[0]!.answer, own);
  assert.throws(() => r.broker.answerQuestion(card!.id, "Hello"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /already has your answer/.test(err.message));
  assert.throws(() => r.broker.answerQuestion(999, "Hello"), (err: unknown) => err instanceof ApprovalError && err.status === 404);
  // The store refuses a second answer too, whatever asks it.
  assert.throws(() => r.db.prepare("UPDATE approvals SET answer = 'Hello' WHERE id = ?").run(card!.id), /answered once|already answered/);
});

test("a request to run something is not answered as a question", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  // On the always-ask list, so it makes a card in every mode but the fully autonomous one.
  const answer = r.broker.request({ taskId: a.taskId, attemptId: a.attemptId, role: "implementer", tool: "Bash", command: "git push origin HEAD", input: { command: "git push origin HEAD" }, cwd: ".", reason: null, toolCallId: "toolu_push" });
  const [card] = listApprovals(r.db, "pending");
  assert.ok(card);
  assert.throws(() => r.broker.answerQuestion(card.id, "Hi"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /not a question/.test(err.message));
  r.broker.answer(card.id, "decline");
  await answer;
});

test("a malformed question is denied with a plain message to the agent and never makes a card", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi");
  const malformed: unknown[] = [
    input({ question: "" }),
    input({ options: [{ label: "Only one" }] }),
    input({ options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }] }),
    input({ options: [{ label: 1 }, { label: 2 }] }),
    { questions: [input().questions[0], { ...input().questions[0], question: "And another?" }] },
    { questions: "Which?" },
  ];
  for (const given of malformed) {
    const answer = await (await a.ask(given)).answer;
    assert.equal(answer.decision, "decline");
    assert.equal(answer.approvalId, null);
    assert.match(answer.refused ?? "", /^Botbench could not show this question to the owner: /);
  }
  assert.deepEqual(listApprovals(r.db), [], "no card for any of them");
  assert.equal(waitingOnApproval(r.db, a.taskId!), false);
});

test("in a fully autonomous run a question never waits: the agent is told to use its best judgement, and the question and that note are one log entry on the task", async (t) => {
  const r = await rig(t);
  const a = agent(r, "full");
  const { answer } = await a.ask(input());
  assert.deepEqual(await answer, { decision: "decline", note: null, approvalId: null, refused: AUTONOMOUS_ANSWER });
  assert.deepEqual(listApprovals(r.db), [], "nobody is asked");
  const log = actionLog(r.db, a.taskId!);
  assert.deepEqual(log.map((e) => [e.rule, e.tool, e.command, e.detail]), [["question_unasked", "AskUserQuestion", QUESTION, AUTONOMOUS_ANSWER]]);
  assert.deepEqual(r.changes, [], "nothing is announced, so nothing is pushed");
  // The store keeps the two together: an entry of the kind with no note for the agent is refused.
  assert.throws(() => r.db.prepare("INSERT INTO action_log (ts, task_id, rule, tool, command, cwd) VALUES ('now', ?, 'question_unasked', 'AskUserQuestion', 'Q', '')").run(a.taskId));
});

test("a task that asked a question in a fully autonomous run is not accepted by the mode: it needs the owner's review, and the reason names the question", async (t) => {
  const r = await rig(t);
  const a = agent(r, "full");
  await (await a.ask(input())).answer;
  const questions = unaskedQuestions(r.db, a.taskId!);
  assert.deepEqual(questions, [QUESTION]);
  assert.deepEqual(modeRefusals(r.db, a.taskId!), [], "a question is not a refused request");
  const verdict = autoAccept({ checks: "passed", review: "none", refusals: [], questions });
  assert.equal(verdict.accept, false);
  assert.match((verdict as { why: string }).why, /^It needs your review: Claude Code had a question for you and chose the answer itself, as a fully autonomous run puts no questions to you \("Which greeting should I use\?"\)\.$/);
  // Without it, the same facts are accepted: the question is what holds it back.
  assert.equal(autoAccept({ checks: "passed", review: "none", refusals: [], questions: unaskedQuestions(r.db, agent(r, "full").taskId!) }).accept, true);
});

test("a run's planner, which only reads, may ask the owner a question: it is the run's pending approval, and the answer reaches it", async (t) => {
  const r = await rig(t);
  const p = agent(r, "semi", { planner: true });
  const { hook, answer } = await p.ask(input());
  assert.equal(hook, "ask", "the read-only planner's question is not refused at the hook");
  const [card] = listApprovals(r.db, "pending");
  assert.deepEqual([card!.taskId, card!.runId, card!.role, card!.question?.text], [null, p.runId, "planner", QUESTION]);
  r.broker.answerQuestion(card!.id, "Hello");
  assert.deepEqual((await answer).answers, { [QUESTION]: "Hello" });
});

test("a fully autonomous run's planner is told to decide itself too, recorded on its run", async (t) => {
  const r = await rig(t);
  const p = agent(r, "full", { planner: true });
  assert.equal((await (await p.ask(input())).answer).refused, AUTONOMOUS_ANSWER);
  assert.deepEqual(actionLog(r.db).map((e) => [e.rule, e.runId, e.taskId, e.command]), [["question_unasked", p.runId, null, QUESTION]]);
});

test("a pending question survives a restart like a parked approval: still shown, sends no notification, the owner's answer is stored once, and the re-driven attempt's repeated question receives it", async (t) => {
  const dir = tempDir("botbench-question-restart-");
  const home = path.join(dir, "home");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A real push endpoint and device, subscribed before the stop, so a notification for the parked question would be seen.
  const endpoint = await startPushEndpoint();
  t.after(() => endpoint.close());
  const phone = newDevice();
  const db = openStore(home);
  t.after(() => db.close());
  const push = createPush({ db, home, allowHttpEndpoints: true });
  push.subscribe(phone.subscription(endpoint.url("phone")));
  const titles = (): string[] => endpoint.received.map((r) => (JSON.parse(decrypt(r.body, phone.privateKey, phone.auth).toString("utf8")) as { title: string }).title);

  // The first Botbench: the builder asks, and Botbench stops while the question waits (as the engine parks it on a stop).
  const first = createBroker({ db, home, onChange: (approval) => push.approvalChanged(approval) });
  await first.listen();
  const r: Rig = { db, broker: first, dir, changes: [] };
  const a = agent(r, "semi");
  const admission = first.admit({ taskId: a.taskId!, role: "implementer", worktree: path.join(dir, "worktree-q"), confined: true });
  admission.bind(a.attemptId);
  const before = first.request({ taskId: a.taskId, attemptId: a.attemptId, role: "implementer", tool: "AskUserQuestion", command: summarize("AskUserQuestion", input()), input: input(), cwd: ".", reason: null, toolCallId: "toolu_before" });
  await push.idle();
  assert.deepEqual(titles(), ["A task has a question"], "asked in this run: one notification");
  admission.park();
  assert.equal((await before).decision, "decline", "the stopping process lets its waiter go; the question stays for the owner");
  await first.close();

  // The next start: a new broker over the same store finds it, shown as before, and says nothing new.
  const pushAgain = createPush({ db, home, allowHttpEndpoints: true });
  const again = createBroker({ db, home, onChange: (approval) => pushAgain.approvalChanged(approval) });
  await again.listen();
  t.after(() => again.close());
  const [parked, ...rest] = again.pending();
  assert.equal(rest.length, 0);
  assert.deepEqual([parked!.question?.text, parked!.attemptId, parked!.storedDecision], [QUESTION, a.attemptId, null]);
  assert.ok(parked!.parkedAt !== null);
  assert.equal(waitingOnApproval(db, a.taskId!), true, "its task still needs input");
  const stored = again.answerQuestion(parked!.id, "Hi");
  assert.deepEqual([stored.status, stored.storedDecision, stored.answer], ["pending", "allow", "Hi"], "stored, not yet applied");
  assert.throws(() => again.answerQuestion(parked!.id, "Hello"), (err: unknown) => err instanceof ApprovalError && err.status === 409, "answered once");
  await pushAgain.idle();
  assert.deepEqual(titles(), ["A task has a question"], "nothing for the parked question or its stored answer, and no 'An approval is waiting' at all");

  // The re-driven attempt asks the same question again: it gets the stored answer, keyed by the question, without a card.
  const resumed = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const again2 = again.admit({ taskId: a.taskId!, role: "implementer", worktree: path.join(dir, "worktree-q"), resumes: a.attemptId, confined: true });
  again2.bind(resumed);
  const answer = await again.request({ taskId: a.taskId, attemptId: resumed, role: "implementer", tool: "AskUserQuestion", command: summarize("AskUserQuestion", input()), input: input(), cwd: "", reason: null, toolCallId: "toolu_after" });
  assert.deepEqual(answer, { decision: "allow", note: null, approvalId: parked!.id, refused: null, answers: { [QUESTION]: "Hi" } });
  assert.deepEqual(listApprovals(db).map((x) => [x.id, x.status, x.answer]), [[parked!.id, "allowed", "Hi"]], "no second card");
  assert.deepEqual(actionLog(db, a.taskId!).map((e) => e.rule), ["asked_owner", "owner_answered", "stored_answer_applied"]);
  // The same question again is asked afresh: the stored answer is used up.
  void again.request({ taskId: a.taskId, attemptId: resumed, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input(), cwd: "", reason: null, toolCallId: "toolu_after_2" });
  assert.deepEqual(again.pending().map((x) => [x.question?.text, x.attemptId, x.parkedAt]), [[QUESTION, resumed, null]]);
  again2.release();
});

test("after a restart, a re-driven attempt that repeats the question's words with other choices does not get the stored answer: it is discarded and the new question gets its own card", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  const worktree = path.join(r.dir, "worktree-choices");
  const first = r.broker.admit({ taskId: a.taskId!, role: "implementer", worktree, confined: true });
  first.bind(a.attemptId);
  void r.broker.request({ taskId: a.taskId, attemptId: a.attemptId, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input(), cwd: ".", reason: null, toolCallId: "toolu_1" });
  first.park();
  const [parked] = r.broker.pending();
  r.broker.answerQuestion(parked!.id, "Hi");
  const resumed = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const next = r.broker.admit({ taskId: a.taskId!, role: "implementer", worktree, resumes: a.attemptId, confined: true });
  next.bind(resumed);
  void r.broker.request({ taskId: a.taskId, attemptId: resumed, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input({ options: [{ label: "Hi" }, { label: "Good morning" }] }), cwd: "", reason: null, toolCallId: "toolu_2" });
  assert.deepEqual(listApprovals(r.db).map((x) => [x.question?.choices.map((c) => c.label), x.status]), [[["Hello", "Hi"], "superseded"], [["Hi", "Good morning"], "pending"]]);
  next.release();
});

test("after a restart, a re-driven attempt that repeats the question and its labels but says other things about the choices does not get the stored answer: the owner answered the choices as they were put", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  const worktree = path.join(r.dir, "worktree-descriptions");
  const first = r.broker.admit({ taskId: a.taskId!, role: "implementer", worktree, confined: true });
  first.bind(a.attemptId);
  void r.broker.request({ taskId: a.taskId, attemptId: a.attemptId, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input(), cwd: ".", reason: null, toolCallId: "toolu_1" });
  first.park();
  const [parked] = r.broker.pending();
  r.broker.answerQuestion(parked!.id, "Hi");
  const resumed = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const next = r.broker.admit({ taskId: a.taskId!, role: "implementer", worktree, resumes: a.attemptId, confined: true });
  next.bind(resumed);
  void r.broker.request({ taskId: a.taskId, attemptId: resumed, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input({ options: [{ label: "Hello", description: "Delete the greeting" }, { label: "Hi", description: "Delete everything" }] }), cwd: "", reason: null, toolCallId: "toolu_2" });
  assert.deepEqual(listApprovals(r.db).map((x) => [x.question?.choices.map((c) => c.description), x.status]), [[["The long one", "The short one"], "superseded"], [["Delete the greeting", "Delete everything"], "pending"]]);
  next.release();
});

test("after a restart, a re-driven attempt whose first question is another one does not get the stored answer: it is discarded and the new question gets its own card", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  const worktree = path.join(r.dir, "worktree-other");
  const first = r.broker.admit({ taskId: a.taskId!, role: "implementer", worktree, confined: true });
  first.bind(a.attemptId);
  void r.broker.request({ taskId: a.taskId, attemptId: a.attemptId, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input(), cwd: ".", reason: null, toolCallId: "toolu_1" });
  first.park();
  const [parked] = r.broker.pending();
  r.broker.answerQuestion(parked!.id, "Hi");
  const resumed = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const next = r.broker.admit({ taskId: a.taskId!, role: "implementer", worktree, resumes: a.attemptId, confined: true });
  next.bind(resumed);
  void r.broker.request({ taskId: a.taskId, attemptId: resumed, role: "implementer", tool: "AskUserQuestion", command: "{}", input: input({ question: "Which colour?" }), cwd: "", reason: null, toolCallId: "toolu_2" });
  assert.deepEqual(listApprovals(r.db).map((x) => [x.question?.text, x.status]), [[QUESTION, "superseded"], ["Which colour?", "pending"]]);
  next.release();
});

test("the store keeps a question as it was asked: never for a chat, never declined, and answered only with its text", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  void (await a.ask(input())).answer;
  const [card] = listApprovals(r.db, "pending");
  assert.throws(() => r.db.prepare("UPDATE approvals SET question = '{}' WHERE id = ?").run(card!.id), /cannot be changed/);
  assert.throws(() => r.db.prepare("UPDATE approvals SET status = 'declined' WHERE id = ?").run(card!.id), /answered or superseded/);
  assert.throws(() => r.db.prepare("UPDATE approvals SET status = 'allowed' WHERE id = ?").run(card!.id), /answered or superseded/);
  assert.throws(() => r.db.prepare("INSERT INTO approvals (chat, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at, question) VALUES (1, ?, 'chat', 'AskUserQuestion', 'Q', '', 't', 'pending', 'now', '{}')").run(a.attemptId), /never for a chat/);
  r.broker.answerQuestion(card!.id, "Hi");
});
