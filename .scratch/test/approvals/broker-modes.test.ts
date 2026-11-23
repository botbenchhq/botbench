import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { actionLog, createBroker, listApprovals, type Answer, type Broker } from "../../src/approvals/broker.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { setChatWebAccess } from "../../src/approvals/web-access.ts";
import { capIssue, storeIssue } from "../../src/engine/intake.ts";
import { modeRefusals, setAskEveryCommand, type RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { parseIssueView } from "../../src/github.ts";
import { openStore } from "../../src/store/db.ts";
import { ISSUE_NUMBER, ISSUE_REPO, loadIssueCapture } from "../support/replay-issue.ts";
import { tempDir } from "../support/repo.ts";
import type { DatabaseSync } from "node:sqlite";

// What the broker does with the gate's verdict under each mode, with the real store, the real broker and its socket.
// Requests are put to it the way an attempt's CLI puts them: the pre-tool hook first, then the CLI's own request.
// The gate's matrix itself is in test/approvals/modes.test.ts.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  broker: Broker;
  dir: string;
}

async function rig(t: T): Promise<Rig> {
  const dir = tempDir("botbench-broker-modes-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  t.after(async () => {
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, broker, dir };
}

let n = 0;
/** A task of a run in `mode`, with an attempt admitted, standing in its copy. `confined` is what its driver says of its commands. */
function agent(r: Rig, mode: RunMode, confined = true, outside = false) {
  const worktree = path.join(r.dir, `worktree-${++n}`);
  fs.mkdirSync(worktree, { recursive: true });
  const real = fs.realpathSync(worktree);
  const repo = path.join(r.dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const issue = outside ? storeIssue(r.db, fs.realpathSync(repo), capIssue(parseIssueView(loadIssueCapture().outputs.issue.result.stdout, ISSUE_REPO, ISSUE_NUMBER), "github.com/cli/cli")) : null;
  const run = createRun(r.db, { repo, prompt: "p", baseCommit: "0".repeat(40), mode, ...(issue === null ? {} : { issue: { fetchId: issue.id, allowHosts: false } }) });
  const stored = storePlan(r.db, run.id, [{ title: "t", criteria: ["c"] }]);
  const taskId = approvePlan(r.db, run.id, stored.planVersion, null, mode === "full" ? "mode" : "owner").tasks[0]!.id;
  const attemptId = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const admission = r.broker.admit({ taskId, role: "implementer", worktree, confined });
  admission.bind(attemptId);
  const ask = async (tool: string, input: Record<string, unknown>, toolCallId: string, o: { viaHook?: boolean } = {}): Promise<Answer> => {
    if (o.viaHook !== false) await askBroker(admission.socketPath, admission.secret, { tool_name: tool, tool_input: input, tool_use_id: toolCallId, cwd: real });
    const command = tool === "Bash" && typeof input.command === "string" && Object.keys(input).every((k) => k === "command" || k === "description") ? input.command : JSON.stringify(input);
    const answer = r.broker.request({ taskId, attemptId, role: "implementer", tool, command, input, reason: null, toolCallId });
    // Whatever waits for the owner here is answered no, so no test is left hanging on it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const pending of listApprovals(r.db, "pending")) r.broker.answer(pending.id, "decline");
    return answer;
  };
  return { taskId, ask, admission };
}

const rulesOf = (r: Rig, taskId: number): string[] => actionLog(r.db, taskId).map((entry) => entry.rule);

test("semi-autonomous: a confined command runs without an approval and is logged; one whose agent is not confined asks the owner", async (t) => {
  const r = await rig(t);
  const confined = agent(r, "semi");
  const ran = await confined.ask("Bash", { command: "ls -la src", description: "List" }, "call-1");
  assert.deepEqual([ran.decision, ran.byMode, ran.approvalId], ["allow", "semi", null]);
  assert.deepEqual(rulesOf(r, confined.taskId), ["mode_allowed"]);

  const loose = agent(r, "semi", false);
  const asked = await loose.ask("Bash", { command: "ls -la src" }, "call-2");
  assert.equal(asked.decision, "decline", "it was put to the owner, who said no");
  assert.ok(asked.approvalId !== null);
  assert.deepEqual(rulesOf(r, loose.taskId), ["asked_owner", "owner_declined"]);
});

test("semi-autonomous: a request whose directory the hook never reported is not known to be the call that was checked, so it asks", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi");
  const asked = await a.ask("Bash", { command: "ls" }, "call-1", { viaHook: false });
  assert.ok(asked.approvalId !== null);
  assert.equal(asked.byMode, undefined);
});

test("semi-autonomous: the floor still asks, and the record says which rule", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi");
  const asked = await a.ask("Bash", { command: "git push origin main" }, "call-1");
  assert.ok(asked.approvalId !== null);
  assert.equal(actionLog(r.db, a.taskId)[0]!.detail, "Always asks: git-push.");
});

test("fully autonomous: the floor, a tool that is not a command, an edit outside the copy and an unconfined command are refused without an approval, each logged with its reason", async (t) => {
  const r = await rig(t);
  const a = agent(r, "full");
  const push = await a.ask("Bash", { command: "git push origin main" }, "call-1");
  assert.deepEqual([push.decision, push.approvalId], ["decline", null]);
  assert.match(push.refused!, /\(git-push\)/);
  // With Web access at Ask, a fetch would ask, so it is refused.
  setChatWebAccess(r.db, "ask");
  const web = await a.ask("WebFetch", { url: "https://example.com", prompt: "read" }, "call-2");
  assert.match(web.refused!, /WebFetch was refused/);
  const outside = await a.ask("Write", { file_path: "/tmp/botbench-elsewhere.txt", content: "x" }, "call-3");
  assert.match(outside.refused!, /Write was refused/);
  const escape = await a.ask("Bash", { command: "ls", dangerouslyDisableSandbox: true }, "call-4");
  assert.match(escape.refused!, /could not be shown to run kept away from your sign-ins/);
  assert.equal(listApprovals(r.db).length, 0, "nothing was ever put to the owner");
  assert.deepEqual(rulesOf(r, a.taskId), ["mode_refused", "mode_refused", "mode_refused", "mode_refused"]);
  // Each refusal is recorded with its kind, which decides whether it blocks the accept (src/approvals/refusals.ts).
  assert.deepEqual(actionLog(r.db, a.taskId).map((entry) => entry.refusal), ["floor", "network", "outside_copy", "unconfined"]);
  // And a confined, harmless command still runs.
  assert.equal((await a.ask("Bash", { command: "git status" }, "call-5")).byMode, "full");
  // At Allow, the default, a fetch of a public page runs and is logged; one of this Mac is refused, as it would ask.
  setChatWebAccess(r.db, "allow");
  assert.equal((await a.ask("WebFetch", { url: "https://example.com", prompt: "read" }, "call-6")).web, true);
  assert.match((await a.ask("WebFetch", { url: "http://localhost:4780/", prompt: "read" }, "call-7")).refused!, /WebFetch was refused/);
  // At Off it is refused, and the refusal counts against an accept without the owner as the mode's own refusals do.
  setChatWebAccess(r.db, "off");
  assert.match((await a.ask("WebSearch", { query: "x" }, "call-8")).refused!, /Web access is off/);
  assert.deepEqual(rulesOf(r, a.taskId).slice(4), ["mode_allowed", "web_allowed", "mode_refused", "web_refused"]);
  assert.equal(modeRefusals(r.db, a.taskId).length, 6);
  assert.equal(listApprovals(r.db).length, 0);
});

test("fully autonomous: a web fetch at Allow and the CLI's to-do list run without a card and each is in the action log; at Ask and Off the fetch does not run", async (t) => {
  const r = await rig(t);
  const a = agent(r, "full");
  const FETCH = { url: "https://example.com", prompt: "read" };
  const fetched = await a.ask("WebFetch", FETCH, "call-1");
  assert.deepEqual([fetched.decision, fetched.web, fetched.approvalId], ["allow", true, null]);
  const todo = await a.ask("TodoWrite", { todos: [{ content: "x", status: "pending", activeForm: "x" }] }, "call-2", { viaHook: false });
  assert.deepEqual([todo.decision, todo.bookkeeping, todo.approvalId], ["allow", true, null]);
  // The hook lets the to-do list pass, and that pass is logged too.
  const heard = await askBroker(a.admission.socketPath, a.admission.secret, { tool_name: "TodoWrite", tool_input: { todos: [] }, tool_use_id: "call-3", cwd: fs.realpathSync(path.join(r.dir, `worktree-${n}`)) });
  assert.equal(heard.verdict, "pass");
  setChatWebAccess(r.db, "ask");
  const asked = await a.ask("WebFetch", FETCH, "call-4");
  assert.deepEqual([asked.decision, asked.approvalId], ["decline", null]);
  setChatWebAccess(r.db, "off");
  const off = await a.ask("WebFetch", FETCH, "call-5");
  assert.deepEqual([off.decision, off.approvalId], ["decline", null]);
  assert.deepEqual(actionLog(r.db, a.taskId).map((e) => [e.rule, e.tool]), [["web_allowed", "WebFetch"], ["bookkeeping", "TodoWrite"], ["bookkeeping", "TodoWrite"], ["mode_refused", "WebFetch"], ["web_refused", "WebFetch"]]);
  assert.equal(listApprovals(r.db).length, 0);
});

test("manual: a confined command the floor does not name runs without a card and is logged; with Ask before every command on it asks again, saying why; unconfined and floor-listed ones ask either way", async (t) => {
  const r = await rig(t);
  const a = agent(r, "manual");
  const ran = await a.ask("Bash", { command: "ls -la src | head -3", description: "List" }, "call-1");
  assert.deepEqual([ran.decision, ran.byMode, ran.approvalId], ["allow", "manual", null]);
  assert.deepEqual(rulesOf(r, a.taskId), ["mode_allowed"]);
  assert.ok((await a.ask("Bash", { command: "git push origin main" }, "call-2")).approvalId !== null, "the floor still asks");
  assert.ok((await agent(r, "manual", false).ask("Bash", { command: "ls" }, "call-3")).approvalId !== null, "an unconfined agent's command still asks");
  setAskEveryCommand(r.db, true);
  const asked = await a.ask("Bash", { command: "ls -la src" }, "call-4");
  assert.ok(asked.approvalId !== null);
  assert.equal(listApprovals(r.db).find((x) => x.id === asked.approvalId)!.asksBecause, "Ask before every command is on in Settings.");
  // The setting is for manual runs and tasks started on their own; a semi-autonomous run is unchanged by it.
  assert.equal((await agent(r, "semi").ask("Bash", { command: "ls" }, "call-5")).byMode, "semi");
});

test("a run that read outside text: its web tools ask whatever Web access says, and a confined command still runs", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi", true, true);
  const fetch = await a.ask("WebFetch", { url: "https://example.com", prompt: "read" }, "call-1");
  assert.ok(fetch.approvalId !== null, "put to the owner, who said no");
  assert.equal((await a.ask("Bash", { command: "ls" }, "call-2")).byMode, "semi");
});

test("fully autonomous: a harmless read-only command that could not be tied to the call that was checked is refused, recorded as read-only, and its record says it does not stop the accept", async (t) => {
  const r = await rig(t);
  const a = agent(r, "full");
  const answer = await a.ask("Bash", { command: "ls src" }, "call-1", { viaHook: false });
  assert.deepEqual([answer.decision, answer.approvalId], ["decline", null]);
  // The agent is told the refusal only; the record adds why it does not hand the task back.
  assert.equal(answer.refused, "This run is fully autonomous, so a command runs without you only inside the protected copy, and this one could not be shown to run kept away from your sign-ins and the network. It was not run.");
  const [entry] = actionLog(r.db, a.taskId);
  assert.deepEqual([entry!.rule, entry!.refusal], ["mode_refused", "read_only"]);
  assert.equal(entry!.detail, `${answer.refused} It only reads files in the task's copy, so it does not stop the task being accepted.`);
  // The store takes a kind only on a refusal's entry.
  assert.throws(() => r.db.prepare("INSERT INTO action_log (ts, task_id, attempt_id, rule, tool, command, cwd, refusal) VALUES ('now', ?, NULL, 'mode_allowed', 'Bash', 'ls', '.', 'read_only')").run(a.taskId), /CHECK constraint failed/);
});

test("broker failure denies in every mode: a broker that has shut down, and a socket that cannot be reached", async (t) => {
  for (const mode of ["manual", "semi", "full"] as const) {
    const r = await rig(t);
    const a = agent(r, mode);
    // The hook cannot reach a socket that is not there: it denies, whatever the mode.
    const unreachable = await askBroker(path.join(r.dir, "no-such.sock"), a.admission.secret, { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "x", cwd: r.dir });
    assert.equal(unreachable.verdict, "deny", mode);
    await r.broker.close();
    const after = await a.ask("Bash", { command: "ls" }, "call-1", { viaHook: false });
    assert.equal(after.decision, "decline", mode);
    assert.match(after.refused!, /shutting down/, mode);
  }
});
