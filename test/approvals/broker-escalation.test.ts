import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, ApprovalError, createBroker, listApprovals, type Answer, type Broker } from "../../src/approvals/broker.ts";
import { ESCALATION_REFUSED, ESCALATION_WORDS } from "../../src/approvals/gate.ts";
import { insertStanding } from "../../src/approvals/grants.ts";
import { capIssue, storeIssue } from "../../src/engine/intake.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { parseIssueView } from "../../src/github.ts";
import { openStore } from "../../src/store/db.ts";
import { ISSUE_NUMBER, ISSUE_REPO, loadIssueCapture } from "../support/replay-issue.ts";
import { tempDir } from "../support/repo.ts";

// What the broker does with a Codex escalation (src/drivers/codex-app-server.ts): a request of Codex's to run something
// outside its own sandbox. The real store and the real broker; the request is put as the engine puts it (engine/task.ts),
// with `escalation`. No hook is asked first: Codex's requests come back on its own output, never through the socket.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  broker: Broker;
  dir: string;
}

function rig(t: T, offerStandingAfter = 3): Rig {
  const dir = tempDir("botbench-broker-escalation-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const broker = createBroker({ db, home, onChange: () => {}, offerStandingAfter });
  t.after(async () => {
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, broker, dir };
}

let n = 0;
/** Codex building a task of a run in `mode`: its attempt admitted as Codex's is (not confined: it asks only to leave its sandbox). */
function codex(r: Rig, mode: RunMode, o: { preapproved?: string[]; outside?: boolean } = {}) {
  const worktree = path.join(r.dir, `worktree-${++n}`);
  fs.mkdirSync(worktree, { recursive: true });
  const repo = path.join(r.dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const issue = o.outside === true ? storeIssue(r.db, fs.realpathSync(repo), capIssue(parseIssueView(loadIssueCapture().outputs.issue.result.stdout, ISSUE_REPO, ISSUE_NUMBER), "github.com/cli/cli")) : null;
  const run = createRun(r.db, { repo, builder: "codex", prompt: "p", baseCommit: "0".repeat(40), mode, preapproved: o.preapproved ?? [], ...(issue === null ? {} : { issue: { fetchId: issue.id, allowHosts: false } }) });
  const stored = storePlan(r.db, run.id, [{ title: "t", criteria: ["c"] }]);
  const task = approvePlan(r.db, run.id, stored.planVersion, null, mode === "full" ? "mode" : "owner").tasks[0]!;
  const attemptId = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('codex', 'running', 'now', 'now')").run().lastInsertRowid);
  const admission = r.broker.admit({ taskId: task.id, role: "implementer", worktree, confined: false });
  admission.bind(attemptId);
  const escalate = (tool: string, input: Record<string, unknown>, toolCallId: string): Promise<Answer> => {
    const command = tool === "Bash" && typeof input.command === "string" && Object.keys(input).length === 1 ? input.command : JSON.stringify(input);
    return r.broker.request({ taskId: task.id, attemptId, role: "implementer", tool, command, input, reason: "needs to write outside", toolCallId, escalation: true });
  };
  return { task, repo: fs.realpathSync(repo), escalate, attemptId };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
const rulesOf = (r: Rig, taskId: number): string[] => actionLog(r.db, taskId).map((entry) => entry.rule);

test("Manual: a Codex escalation is one card that says Codex asks to run it outside its sandbox, and it runs only after Allow", async (t) => {
  const r = rig(t);
  const c = codex(r, "manual");
  assert.equal(c.task.builderAgent, "codex");
  const answer = c.escalate("Bash", { command: "touch ../outside.txt" }, "item-1");
  await settle();
  const pending = listApprovals(r.db, "pending");
  assert.equal(pending.length, 1, "exactly one card");
  assert.equal(pending[0]!.asksBecause, ESCALATION_WORDS);
  assert.equal(pending[0]!.command, "touch ../outside.txt");
  assert.equal(r.db.prepare("SELECT escalation FROM approvals WHERE id = ?").get(pending[0]!.id)?.escalation, 1);
  r.broker.answer(pending[0]!.id, "allow");
  const given = await answer;
  assert.deepEqual([given.decision, given.approvalId, given.refused, given.preapproved, given.standing, given.byMode], ["allow", pending[0]!.id, null, undefined, undefined, undefined]);
  assert.deepEqual(rulesOf(r, c.task.id), ["asked_owner", "owner_allowed"]);
  assert.match(actionLog(r.db, c.task.id)[0]!.detail ?? "", /^Codex asked to run this outside its sandbox\.$/);
});

test("Manual: a Codex escalation the owner denies is answered no, with the owner's note", async (t) => {
  const r = rig(t);
  const c = codex(r, "manual");
  const answer = c.escalate("apply_patch", { changes: [{ path: "/elsewhere/a.txt", kind: "add", diff: "x" }] }, "item-2");
  await settle();
  const [card] = listApprovals(r.db, "pending");
  assert.equal(card!.asksBecause, ESCALATION_WORDS);
  r.broker.answer(card!.id, "decline", "Keep it inside the copy.");
  const given = await answer;
  assert.deepEqual([given.decision, given.note], ["decline", "Keep it inside the copy."]);
  assert.deepEqual(rulesOf(r, c.task.id), ["asked_owner", "owner_declined"]);
});

test("Pre-approved and Always-allow never answer a Codex escalation: the same command still asks, and the card offers no Always allow", async (t) => {
  const r = rig(t, 1);
  const c = codex(r, "manual", { preapproved: ["npm test"] });
  insertStanding(r.db, { role: "implementer", repo: c.repo, cwd: ".", words: ["npm", "test"], taskId: c.task.id });
  const first = c.escalate("Bash", { command: "npm test" }, "item-3");
  await settle();
  const [card] = listApprovals(r.db, "pending");
  assert.ok(card, "the escalation asks although npm test is allowed for this run and always allowed");
  // Allowed once already, it would earn an offer for an ordinary request (offerStandingAfter 1); an escalation earns none.
  r.broker.answer(card.id, "allow");
  assert.equal((await first).decision, "allow");
  const second = c.escalate("Bash", { command: "npm test" }, "item-4");
  await settle();
  const [again] = listApprovals(r.db, "pending");
  assert.ok(again, "asked again");
  assert.equal(r.broker.standingOffer(again.id), null);
  assert.throws(() => r.broker.grantStanding(again.id), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /Codex asks to run it outside its sandbox/.test(err.message));
  r.broker.answer(again.id, "decline");
  assert.equal((await second).decision, "decline");
  assert.deepEqual(rulesOf(r, c.task.id).filter((rule) => rule === "preapproved" || rule === "standing"), []);
});

test("Semi-autonomous: a Codex escalation the floor names asks, and its card names the rule", async (t) => {
  const r = rig(t);
  const c = codex(r, "semi");
  const answer = c.escalate("Bash", { command: "git push origin main" }, "item-5");
  await settle();
  const [card] = listApprovals(r.db, "pending");
  assert.equal(card!.asksBecause, `${ESCALATION_WORDS} On the always-ask list: it sends commits to another computer.`);
  assert.match(actionLog(r.db, c.task.id)[0]!.detail ?? "", /Always asks: git-push\./);
  r.broker.answer(card!.id, "decline");
  assert.equal((await answer).decision, "decline");
});

test("the floor reads an escalation's shell command, also when the request carries network or more permissions beside it", async (t) => {
  const r = rig(t);
  const c = codex(r, "semi");
  const answer = c.escalate("Bash", { command: "git push origin main", network: { host: "github.com", protocol: "https" } }, "item-5b");
  await settle();
  const [card] = listApprovals(r.db, "pending");
  assert.equal(card!.asksBecause, `${ESCALATION_WORDS} On the always-ask list: it sends commits to another computer.`);
  assert.match(card!.command, /"network"/, "the card shows all of what an allow lets out");
  r.broker.answer(card!.id, "decline");
  assert.equal((await answer).decision, "decline");
});

test("a run started from an issue: a Codex escalation still asks, and no grant applies", async (t) => {
  const r = rig(t);
  const c = codex(r, "semi", { outside: true, preapproved: ["npm test"] });
  const answer = c.escalate("Bash", { command: "npm test" }, "item-6");
  await settle();
  const [card] = listApprovals(r.db, "pending");
  assert.ok(card);
  assert.equal(card.outsideText, true);
  r.broker.answer(card.id, "decline");
  assert.equal((await answer).decision, "decline");
});

test("Fully autonomous: every Codex escalation is refused with no card, logged as one that blocks the accept", async (t) => {
  const r = rig(t);
  const c = codex(r, "full", { preapproved: ["npm test"] });
  for (const [tool, input, id] of [["Bash", { command: "npm test" }, "item-7"], ["Bash", { command: "ls src" }, "item-8"], ["apply_patch", { changes: [] }, "item-9"], ["permissions", { permissions: { network: { enabled: true } } }, "item-10"]] as const) {
    const given = await c.escalate(tool, input, id);
    assert.deepEqual([given.decision, given.approvalId, given.refused], ["decline", null, ESCALATION_REFUSED], tool);
  }
  const floor = await c.escalate("Bash", { command: "git push origin main" }, "item-11");
  assert.equal(floor.refused, ESCALATION_REFUSED);
  assert.equal(listApprovals(r.db).length, 0, "no card at all");
  const entries = actionLog(r.db, c.task.id);
  assert.deepEqual(entries.map((e) => [e.rule, e.refusal]), [["mode_refused", "unconfined"], ["mode_refused", "unconfined"], ["mode_refused", "unconfined"], ["mode_refused", "unconfined"], ["mode_refused", "floor"]]);
});

test("a broker that is shutting down answers a Codex escalation no", async (t) => {
  const r = rig(t);
  const c = codex(r, "manual");
  await r.broker.close();
  const given = await c.escalate("Bash", { command: "npm test" }, "item-12");
  assert.equal(given.decision, "decline");
  assert.equal(listApprovals(r.db).length, 0);
});

test("a Codex escalation left waiting when Botbench stops is answered no", async (t) => {
  const r = rig(t);
  const c = codex(r, "manual");
  const answer = c.escalate("Bash", { command: "npm test" }, "item-13");
  await settle();
  await r.broker.close();
  assert.equal((await answer).decision, "decline");
});
