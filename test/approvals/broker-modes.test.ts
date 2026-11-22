import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { actionLog, createBroker, listApprovals, type Answer, type Broker } from "../../src/approvals/broker.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { openStore } from "../../src/store/db.ts";
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
function agent(r: Rig, mode: RunMode, confined = true) {
  const worktree = path.join(r.dir, `worktree-${++n}`);
  fs.mkdirSync(worktree, { recursive: true });
  const real = fs.realpathSync(worktree);
  const run = createRun(r.db, { repo: path.join(r.dir, "repo"), prompt: "p", baseCommit: "0".repeat(40), mode });
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
  const web = await a.ask("WebFetch", { url: "https://example.com", prompt: "read" }, "call-2");
  assert.match(web.refused!, /WebFetch was refused/);
  const outside = await a.ask("Write", { file_path: "/tmp/botbench-elsewhere.txt", content: "x" }, "call-3");
  assert.match(outside.refused!, /Write was refused/);
  const escape = await a.ask("Bash", { command: "ls", dangerouslyDisableSandbox: true }, "call-4");
  assert.match(escape.refused!, /could not be shown to run kept away from your sign-ins/);
  assert.equal(listApprovals(r.db).length, 0, "nothing was ever put to the owner");
  assert.deepEqual(rulesOf(r, a.taskId), ["mode_refused", "mode_refused", "mode_refused", "mode_refused"]);
  // And a confined, harmless command still runs.
  assert.equal((await a.ask("Bash", { command: "git status" }, "call-5")).byMode, "full");
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
