import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOME_SECRETS } from "../../src/confinement.ts";
import { CODEX_BUILD_CAPABILITIES, CodexDriver, DISABLED_FEATURES } from "../../src/drivers/codex.ts";
import { appServerArgs, BUILD_ONLY_DISABLED, BUILD_PROFILE, buildConfig, declineFor, escalationOf, settingsProblem, startAppServerSession, type ReportedSettings } from "../../src/drivers/codex-app-server.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { IMPLEMENTER, PLANNER, REVIEWER, roleProblem } from "../../src/engine/roles.ts";
import { openStore } from "../../src/store/db.ts";
import { loadShape, replayTransport, type ShapeTurn } from "../support/replay-codex.ts";
import { tempDir } from "../support/repo.ts";

// Codex as a builder over `codex app-server` (src/drivers/codex-app-server.ts): the settings it is started with, the check
// of what Codex reports, each approval request as an escalation, and the real session replayed from the shape of a real
// one (test/support/replay-codex.ts). No Codex is started here; test/live/codex-build.live.test.ts starts the real one.

type T = { after(fn: () => unknown): void };
const CWD = "/nonexistent-botbench/worktrees/run-1/task-1";
const DATA = "/nonexistent-botbench";

test("a build is started with every setting it relies on as a session flag: on-request approvals put to Botbench, its own profile with the copy writable, no network, no MCP server, no hooks, plugins or Codex's own reviewer", () => {
  const args = appServerArgs({ cwd: CWD, dataDir: DATA, gitDir: "/nonexistent-botbench/repo/.git" }, [...DISABLED_FEATURES, ...BUILD_ONLY_DISABLED]);
  assert.equal(args[0], "app-server");
  const settings = args.filter((_, i) => args[i - 1] === "-c");
  assert.ok(settings.includes('approval_policy="on-request"'));
  assert.ok(settings.includes('approvals_reviewer="user"'));
  assert.ok(settings.includes(`default_permissions="${BUILD_PROFILE}"`));
  assert.ok(settings.includes(`permissions.${BUILD_PROFILE}.extends=":workspace"`));
  assert.ok(settings.includes(`permissions.${BUILD_PROFILE}.network.enabled=false`));
  assert.ok(settings.includes("mcp_servers={}"));
  assert.ok(settings.includes('web_search="disabled"'));
  assert.ok(settings.includes("notify=[]"));
  const filesystem = settings.find((s) => s.startsWith(`permissions.${BUILD_PROFILE}.filesystem=`))!;
  assert.ok(filesystem.includes(`"${os.homedir()}"="deny"`), "the home folder is denied");
  for (const secret of HOME_SECRETS.slice(0, 5)) assert.ok(filesystem.includes(`"${path.join(os.homedir(), secret)}"="deny"`), secret);
  assert.ok(filesystem.includes(`"${DATA}"="deny"`), "Botbench's data folder is denied");
  assert.ok(filesystem.includes(`"${CWD}"="write"`), "the copy is writable");
  assert.ok(filesystem.includes('"/nonexistent-botbench/repo/.git"="read"'), "the git folder is read-only");
  const disabled = args.filter((_, i) => args[i - 1] === "--disable");
  for (const feature of ["hooks", "plugins", "apps", "multi_agent", "guardian_approval", "goals", "worktrees"]) assert.ok(disabled.includes(feature), feature);
  // Never `--sandbox` or `sandbox_mode`: either sets a permissions profile aside (docs/security/codex-app-server-check.md).
  assert.ok(!args.some((a) => a.includes("sandbox_mode") || a === "--sandbox"));
  assert.throws(() => buildConfig({ cwd: '/tmp/a"b', dataDir: DATA }, []), /quote/);
});

const GOOD: ReportedSettings = { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [CWD], networkAccess: false }, profile: { id: BUILD_PROFILE, extends: ":workspace" } };

test("what Codex reports is checked before every message: only on-request to Botbench, read-only or workspace-write in the copy with no network, and Botbench's profile in force", () => {
  assert.equal(settingsProblem(GOOD, CWD), null);
  assert.equal(settingsProblem({ ...GOOD, sandbox: { type: "readOnly", networkAccess: false } }, CWD), null, "stricter is not looser");
  assert.equal(settingsProblem({ ...GOOD, sandbox: { type: "workspaceWrite", writableRoots: [path.join(CWD, "sub"), os.tmpdir()], networkAccess: false } }, CWD), null);
  const looser: [string, ReportedSettings, RegExp][] = [
    ["full access", { ...GOOD, sandbox: { type: "dangerFullAccess" } }, /dangerFullAccess, looser than the workspace-write sandbox/],
    ["an outside sandbox", { ...GOOD, sandbox: { type: "externalSandbox", networkAccess: "enabled" } }, /externalSandbox/],
    ["network", { ...GOOD, sandbox: { type: "workspaceWrite", writableRoots: [CWD], networkAccess: true } }, /reach the network/],
    ["a root outside the copy", { ...GOOD, sandbox: { type: "workspaceWrite", writableRoots: [CWD, os.homedir()], networkAccess: false } }, /may write in .*, outside the task's copy/],
    ["no roots", { ...GOOD, sandbox: { type: "workspaceWrite", networkAccess: false } }, /did not say where its commands may write/],
    ["no sandbox", { ...GOOD, sandbox: undefined }, /did not say which sandbox/],
    ["never", { ...GOOD, approvalPolicy: "never" }, /approval policy "never"/],
    ["untrusted", { ...GOOD, approvalPolicy: "untrusted" }, /approval policy "untrusted"/],
    ["Codex's own reviewer", { ...GOOD, approvalsReviewer: "auto_review" }, /go to "auto_review", not to Botbench/],
    ["another profile", { ...GOOD, profile: { id: ":workspace" } }, /did not report Botbench's permissions profile .*: it reported :workspace/],
    ["no profile", { ...GOOD, profile: null }, /did not report Botbench's permissions profile/],
    ["profile not said", { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: GOOD.sandbox }, /did not report Botbench's permissions profile/],
  ];
  for (const [what, reported, words] of looser) assert.match(settingsProblem(reported, CWD) ?? "", words, what);
});

test("each of Codex's approval requests is one escalation for the owner, with what an allow would let out; anything else is not one", () => {
  const command = escalationOf("item/commandExecution/requestApproval", "0", { itemId: "call_1", command: "touch /x", reason: "command failed; retry without sandbox?" }, null)!;
  assert.deepEqual(command, { type: "permission_request", id: "codex-0", toolCallId: "call_1", name: "Bash", input: { command: "touch /x" }, reason: "command failed; retry without sandbox?", escalation: true });
  const network = escalationOf("item/commandExecution/requestApproval", "1", { itemId: "call_2", approvalId: "a1", command: "curl x", networkApprovalContext: { host: "x", protocol: "https" }, additionalPermissions: { network: true } }, null)!;
  assert.deepEqual(network.input, { command: "curl x", network: { host: "x", protocol: "https" }, additionalPermissions: { network: true } });
  assert.equal(network.toolCallId, "call_2:a1");
  const patch = escalationOf("item/fileChange/requestApproval", "2", { itemId: "call_3" }, [{ path: "/x", kind: "add", diff: "y" }])!;
  assert.deepEqual([patch.name, patch.input, patch.escalation], ["apply_patch", { changes: [{ path: "/x", kind: "add", diff: "y" }] }, true]);
  const more = escalationOf("item/permissions/requestApproval", "3", { itemId: "call_4", cwd: CWD, permissions: { network: { enabled: true } } }, null)!;
  assert.deepEqual([more.name, more.input], ["permissions", { permissions: { network: { enabled: true } }, cwd: CWD }]);
  for (const method of ["item/tool/requestUserInput", "mcpServer/elicitation/request", "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "execCommandApproval"]) assert.equal(escalationOf(method, "9", {}, null), null, method);
  // Every refusal is a decline in the shape Codex takes for it; nothing Botbench does not know is ever accepted.
  assert.deepEqual(declineFor("item/commandExecution/requestApproval"), { result: { decision: "decline" } });
  assert.deepEqual(declineFor("item/fileChange/requestApproval"), { result: { decision: "decline" } });
  assert.deepEqual(declineFor("item/permissions/requestApproval"), { result: { permissions: {}, scope: "turn" } });
  assert.deepEqual(declineFor("execCommandApproval"), { result: { decision: "denied" } });
  assert.deepEqual(declineFor("mcpServer/elicitation/request"), { result: { action: "decline" } });
  assert.equal("error" in declineFor("account/chatgptAuthTokens/refresh"), true);
});

test("Codex builds only once its probe found it can, and it never plans: it asks only to leave its sandbox", () => {
  const unchecked = new CodexDriver();
  assert.match(roleProblem(IMPLEMENTER, "codex", unchecked.capabilities) ?? "", /^Codex cannot be the builder: Botbench has not checked yet/);
  assert.equal(roleProblem(IMPLEMENTER, "codex", CODEX_BUILD_CAPABILITIES), null);
  assert.match(roleProblem(PLANNER, "codex", CODEX_BUILD_CAPABILITIES) ?? "", /^Codex cannot be the planner/);
  assert.equal(roleProblem(REVIEWER, "codex", CODEX_BUILD_CAPABILITIES), null);
});

/** The real session over the replayed shape, in a temporary store. */
async function session(t: T, turns: readonly ShapeTurn[], o: { settings?: Record<string, unknown>; noSettings?: boolean; settingsFirst?: boolean; approvalTimeoutMs?: number } = {}) {
  const dir = tempDir("botbench-codex-app-server-");
  const db = openStore(path.join(dir, "home"));
  const cwd = path.join(dir, "copy");
  fs.mkdirSync(cwd);
  const transport = replayTransport({ cwd, outside: path.join(dir, "outside"), turns, ...o });
  const s = await startAppServerSession({ db, transport, cwd, capabilities: CODEX_BUILD_CAPABILITIES, ...(o.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: o.approvalTimeoutMs }) });
  const events: DriverEvent[] = [];
  s.onEvent((e) => void events.push(e));
  t.after(async () => {
    await s.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const requested = (): Extract<DriverEvent, { type: "permission_request" }>[] => events.filter((e): e is Extract<DriverEvent, { type: "permission_request" }> => e.type === "permission_request");
  const answers = (): unknown[] => transport.sent.filter((m) => m.method === undefined && "result" in m || (m.method === undefined && "error" in m));
  const waitFor = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(check(), "the replay got there");
  };
  return { s, db, cwd, transport, events, requested, answers, waitFor };
}

test("the session starts a thread with Botbench's settings passed again, and a command and a change inside the sandbox ask nothing and are reported", async (t) => {
  const r = await session(t, ["inside"]);
  const start = r.transport.sent.find((m) => m.method === "thread/start")!;
  assert.deepEqual(start.params, { cwd: r.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", ephemeral: true });
  assert.equal(r.transport.sent[0]!.method, "initialize");
  assert.deepEqual((r.transport.sent[0]!.params as Record<string, unknown>).capabilities, { experimentalApi: true });
  assert.equal(r.transport.sent[1]!.method, "initialized");
  assert.equal(await r.s.sendTurn("Run test.sh and change README.md."), "completed");
  const turn = r.transport.sent.find((m) => m.method === "turn/start")!;
  assert.deepEqual((turn.params as Record<string, unknown>).approvalPolicy, "on-request");
  assert.deepEqual(r.requested(), []);
  assert.deepEqual(r.events.map((e) => e.type), ["user_prompt", "tool_call", "tool_result", "tool_call", "tool_result", "text", "usage", "turn_ended"]);
  assert.deepEqual(r.events[1], { type: "tool_call", id: "call_in_1", name: "shell", input: { command: "/bin/zsh -lc 'sh test.sh'" } });
  assert.deepEqual(r.events[6], { type: "usage", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0 });
  assert.equal(r.s.resumeCursor(), (loadShape().threadStart.thread as { id: string }).id);
  const stored = r.db.prepare("SELECT driver, status, resume_cursor FROM attempts WHERE id = ?").get(r.s.attemptId);
  assert.deepEqual({ ...stored }, { driver: "codex", status: "running", resume_cursor: "019a0000-0000-7000-8000-000000000001" });
});

test("an escalation waits for the answer: the owner's allow is accept, once; a deny, an allow from a rule and a malformed answer are decline", async (t) => {
  for (const [given, decision, resolved] of [
    [{ decision: "allow" }, "accept", "allowed"],
    [{ decision: "decline", note: "no" }, "decline", "declined"],
    [{ decision: "allow", preapproved: true }, "decline", "denied"],
    [{ decision: "allow", standing: true }, "decline", "denied"],
    [{ decision: "allow", mode: true }, "decline", "denied"],
    [{ decision: "yes" }, "decline", "declined"],
    ["allow", "decline", "declined"],
  ] as const) {
    const r = await session(t, ["escalate"]);
    const ended = r.s.sendTurn("Create landed-T1 outside.");
    await r.waitFor(() => r.requested().length === 1);
    const asked = r.requested()[0]!;
    assert.deepEqual([asked.name, asked.escalation, asked.toolCallId, asked.reason], ["Bash", true, "call_out_1", "command failed; retry without sandbox?"]);
    assert.match(String((asked.input as Record<string, unknown>).command), /touch .*\/outside\/landed-T1/);
    await r.s.respondToRequest(asked.id, given);
    assert.equal(await ended, "completed");
    const answer = r.transport.sent.find((m) => m.id === 0 && m.method === undefined)!;
    assert.deepEqual(answer, { id: 0, result: { decision } }, JSON.stringify(given));
    const done = r.events.find((e) => e.type === "permission_resolved");
    assert.equal(done?.type === "permission_resolved" ? done.decision : null, resolved);
    // Nothing for the session: no acceptForSession, no amendment, ever.
    assert.ok(!JSON.stringify(r.transport.sent).includes("acceptForSession") && !JSON.stringify(r.transport.sent).includes("acceptWithExecpolicyAmendment"));
    // A declined command is reported as not run.
    if (decision === "decline") assert.ok(r.events.some((e) => e.type === "permission_denied" && e.id === "call_out_1"));
    await assert.rejects(r.s.respondToRequest(asked.id, { decision: "allow" }), /No permission request/);
  }
});

test("a file change outside asks with the paths Codex reported for it; more permissions are granted only as asked, for this message only", async (t) => {
  const patch = await session(t, ["patch"]);
  const ended = patch.s.sendTurn("Add patched-T8.txt outside.");
  await patch.waitFor(() => patch.requested().length === 1);
  const asked = patch.requested()[0]!;
  assert.equal(asked.name, "apply_patch");
  assert.match(JSON.stringify(asked.input), /outside\/patched-T8\.txt","kind":"add"/);
  await patch.s.respondToRequest(asked.id, { decision: "decline" });
  assert.equal(await ended, "completed");
  assert.deepEqual(patch.transport.sent.find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { decision: "decline" } });

  const more = await session(t, ["permissions"]);
  const again = more.s.sendTurn("Install packages.");
  await more.waitFor(() => more.requested().length === 1);
  await more.s.respondToRequest(more.requested()[0]!.id, { decision: "allow" });
  assert.equal(await again, "completed");
  assert.deepEqual(more.transport.sent.find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" } });
});

test("a request Botbench does not know is refused at once and never reaches the owner", async (t) => {
  const r = await session(t, ["unknown"]);
  assert.equal(await r.s.sendTurn("Ask me something."), "completed");
  assert.deepEqual(r.requested(), []);
  const answer = r.transport.sent.find((m) => m.id === 0 && m.method === undefined)!;
  assert.ok("error" in answer && !("result" in answer));
  assert.ok(r.events.some((e) => e.type === "error" && /item\/tool\/requestUserInput/.test(e.message)));
});

test("a looser sandbox reported before the message stops it before Codex starts on it; one reported mid-way stops it there", async (t) => {
  const before = await session(t, ["inside"], { settings: loadShape().looserSettings });
  assert.equal(await before.s.sendTurn("Run test.sh."), "error");
  assert.equal(before.transport.sent.some((m) => m.method === "turn/start"), false, "Codex was never asked to start");
  assert.ok(before.transport.stopped());
  const ended = before.events.at(-1)!;
  assert.match(ended.type === "turn_ended" ? (ended.detail ?? "") : "", /dangerFullAccess, looser than the workspace-write sandbox Botbench set, so it was stopped/);

  // Looser settings reported before thread/start's answer are not hidden by that answer.
  const first = await session(t, ["inside"], { settings: { ...loadShape().looserSettings, activePermissionProfile: { id: "botbench-build", extends: ":workspace" } }, settingsFirst: true });
  assert.equal(await first.s.sendTurn("Run test.sh."), "error");
  assert.equal(first.transport.sent.some((m) => m.method === "turn/start"), false);

  // After a looser report has stopped a message, the session takes no further one.
  const sticky = await session(t, ["looser", "inside"]);
  assert.equal(await sticky.s.sendTurn("Read a key."), "error");
  await assert.rejects(sticky.s.sendTurn("Run test.sh."), /has ended/);

  const silent = await session(t, ["inside"], { noSettings: true });
  assert.equal(await silent.s.sendTurn("Run test.sh."), "error");
  assert.ok(silent.events.some((e) => e.type === "error" && /did not report Botbench's permissions profile/.test(e.message)));

  const during = await session(t, ["looser"]);
  assert.equal(await during.s.sendTurn("Read a key."), "error");
  assert.ok(during.transport.stopped());
  assert.equal(during.db.prepare("SELECT status FROM attempts WHERE id = ?").get(during.s.attemptId)?.status, "failed");
});

test("an escalation nobody answers in time is declined, and so is one still waiting when Codex is stopped", async (t) => {
  const late = await session(t, ["wait"], { approvalTimeoutMs: 30 });
  assert.equal(await late.s.sendTurn("Touch W1."), "completed");
  assert.deepEqual(late.transport.sent.find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { decision: "decline" } });
  const timed = late.events.find((e) => e.type === "permission_resolved");
  assert.deepEqual(timed?.type === "permission_resolved" ? [timed.decision, timed.note] : null, ["cancelled", "No answer came within 0 minutes, so it was denied and did not run."]);

  const stopped = await session(t, ["wait"]);
  const ended = stopped.s.sendTurn("Touch W1.");
  await stopped.waitFor(() => stopped.requested().length === 1);
  await stopped.s.interruptTurn();
  assert.equal(await ended, "interrupted");
  assert.deepEqual(stopped.transport.sent.find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { decision: "decline" } });
  assert.ok(stopped.events.some((e) => e.type === "permission_resolved" && e.decision === "cancelled"));
});
