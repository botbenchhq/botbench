import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";
import { checkoutState, initRepo, tempDir } from "../support/repo.ts";

// These tests start the real Claude Code on the owner's login, through Smelt's HTTP API, in real temporary
// repositories, and answer its permission requests the way the client does. Every prompt is tiny and asks for the cheapest model.

const TASK_TIMEOUT = 240_000;
const JSON_TYPE = { "content-type": "application/json" };
const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';

interface Live {
  server: SmeltServer;
  base: string;
  headers: Record<string, string>;
  dir: string;
  home: string;
  repo: string;
}

async function start(t: TestContext, files: Record<string, string>): Promise<Live> {
  const dir = tempDir("smelt-live-apr-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, files);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, dir, home, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

interface TaskBody {
  id: number;
  status: string;
  reason: string | null;
  branch: string | null;
  attemptId: number | null;
  waitingOnApproval: boolean;
  files: { path: string; status: string }[] | null;
}
interface ApprovalBody {
  id: number;
  taskId: number;
  taskTitle: string;
  attemptId: number;
  role: string;
  tool: string;
  command: string;
  cwd: string;
  reason: string | null;
  toolCallId: string;
  status: string;
  note: string | null;
}
interface LogBody {
  rule: string;
  taskId: number | null;
  approvalId: number | null;
  tool: string;
  command: string;
  cwd: string;
  detail: string | null;
}

const getJson = async <B>(live: Live, route: string): Promise<B> => (await (await fetch(`${live.base}${route}`, { headers: live.headers })).json()) as B;
const getTask = (live: Live, id: number): Promise<TaskBody> => getJson(live, `/api/tasks/${id}`);
const pendingApprovals = async (live: Live): Promise<ApprovalBody[]> => (await getJson<{ approvals: ApprovalBody[] }>(live, "/api/approvals?status=pending")).approvals;
const allApprovals = async (live: Live): Promise<ApprovalBody[]> => (await getJson<{ approvals: ApprovalBody[] }>(live, "/api/approvals")).approvals;
const actionLog = async (live: Live, taskId: number): Promise<LogBody[]> => (await getJson<{ entries: LogBody[] }>(live, `/api/action-log?taskId=${taskId}`)).entries;
const transcript = async (live: Live, attemptId: number): Promise<DriverEvent[]> => (await getJson<{ events: StoredEvent[] }>(live, `/api/attempts/${attemptId}/events`)).events.map((e) => e.payload);

async function startTask(live: Live, prompt: string): Promise<number> {
  const res = await fetch(`${live.base}/api/tasks`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ repo: live.repo, prompt }) });
  const body = (await res.json()) as { taskId: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.taskId;
}

async function answer(live: Live, id: number, decision: "allow" | "decline", note?: string): Promise<void> {
  const res = await fetch(`${live.base}/api/approvals/${id}`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify(note === undefined ? { decision } : { decision, note }) });
  assert.equal(res.status, 200, await res.text());
}

const ended = (task: TaskBody): boolean => task.status !== "queued" && task.status !== "building";

/** Wait for the task's next pending approval. Fails at once, with the transcript, if the task ends without asking. */
async function nextPending(live: Live, taskId: number): Promise<ApprovalBody> {
  const deadline = Date.now() + TASK_TIMEOUT - 60_000;
  for (;;) {
    const [first] = await pendingApprovals(live);
    if (first) return first;
    const task = await getTask(live, taskId);
    if (ended(task)) {
      const events = task.attemptId === null ? [] : await transcript(live, task.attemptId);
      assert.fail(`the task ended (${task.status}) without a pending approval; its transcript: ${events.map((e) => (e.type === "tool_call" ? `tool_call ${JSON.stringify(e.input)}` : e.type)).join(", ")}`);
    }
    if (Date.now() > deadline) assert.fail("timed out waiting for a pending approval");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function untilEnded(live: Live, taskId: number, whilePending?: (approval: ApprovalBody) => Promise<void>): Promise<TaskBody> {
  const deadline = Date.now() + TASK_TIMEOUT - 40_000;
  for (;;) {
    const task = await getTask(live, taskId);
    if (ended(task)) return task;
    if (whilePending) for (const approval of await pendingApprovals(live)) await whilePending(approval);
    if (Date.now() > deadline) assert.fail("timed out waiting for the task to end");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Every file below `dir`, by name, without git's own folder. */
const filesBelow = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => !name.split(path.sep).includes(".git"));
const worktreeOf = (live: Live, task: TaskBody): string => path.join(live.home, "worktrees", task.branch!.split("/")[1]!, `task-${task.id}`);

test("live: a task that must run the repository's marker script waits as a pending approval; allowing it lets the turn finish, and the marker file exists", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  const before = checkoutState(live.repo);
  const taskId = await startTask(live, "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done");

  const approval = await nextPending(live, taskId);
  assert.deepEqual(
    { taskId: approval.taskId, role: approval.role, tool: approval.tool, command: approval.command, cwd: approval.cwd, status: approval.status, title: approval.taskTitle },
    { taskId, role: "implementer", tool: "Bash", command: "sh make-marker.sh", cwd: ".", status: "pending", title: "Run the command `sh make-marker.sh` with your Bash tool, exa…" },
  );
  assert.ok(approval.reason === null || typeof approval.reason === "string");
  // While it waits: the task says so, the turn has not moved on, and the script has not run.
  const waitingTask = await getTask(live, taskId);
  assert.deepEqual([waitingTask.status, waitingTask.waitingOnApproval], ["building", true]);
  const worktree = worktreeOf(live, waitingTask);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.existsSync(path.join(worktree, "marker.txt")), false, "nothing ran before the answer");
  const whileWaiting = await transcript(live, waitingTask.attemptId!);
  const request = whileWaiting.find((e) => e.type === "permission_request");
  assert.ok(request && request.type === "permission_request");
  assert.deepEqual([request.toolCallId, request.name], [approval.toolCallId, "Bash"]);
  assert.equal(whileWaiting.some((e) => e.type === "tool_result" && e.id === approval.toolCallId), false, "the call has no result yet");
  assert.equal(whileWaiting.some((e) => e.type === "turn_ended"), false);

  await answer(live, approval.id, "allow");
  const task = await untilEnded(live, taskId);
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(task.waitingOnApproval, false);
  assert.equal(fs.readFileSync(path.join(worktree, "marker.txt"), "utf8").trim(), "ran");
  assert.deepEqual(task.files!.map((f) => [f.path, f.status]), [["marker.txt", "added"]]);

  const events = await transcript(live, task.attemptId!);
  const order = ["permission_request", "permission_resolved", "tool_result"].map((type) => events.findIndex((e) => e.type === type && (e.type === "tool_result" ? e.id === approval.toolCallId : true)));
  assert.ok(order[0]! >= 0 && order[0]! < order[1]! && order[1]! < order[2]!, `asked, answered, then run: ${order.join(", ")}`);
  const resolved = events[order[1]!]!;
  assert.ok(resolved.type === "permission_resolved" && resolved.decision === "allowed" && resolved.toolCallId === approval.toolCallId);
  const result = events[order[2]!]!;
  assert.ok(result.type === "tool_result" && !result.isError, "the command ran");
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });

  assert.deepEqual((await actionLog(live, taskId)).map((e) => [e.rule, e.approvalId, e.tool, e.command, e.cwd]), [
    ["asked_owner", approval.id, "Bash", "sh make-marker.sh", "."],
    ["owner_allowed", approval.id, "Bash", "sh make-marker.sh", "."],
  ]);
  assert.deepEqual(await pendingApprovals(live), []);
  assert.equal(fs.existsSync(path.join(live.repo, "marker.txt")), false, "the script ran in the worktree, not in the owner's checkout");
  assert.deepEqual(checkoutState(live.repo), before);
});

test("live: declining returns a declined result to the agent and the turn ends; a command the repository's own committed CLI settings allow still asks, its SessionStart hook does not run, and its instructions file is still read", { timeout: TASK_TIMEOUT }, async (t) => {
  // The repository itself tries to let the command through and to run one of its own at start, as a hostile or careless one might.
  const live = await start(t, {
    "README.md": "# Sample\n",
    "make-marker.sh": MARKER_SCRIPT,
    "CLAUDE.md": "Project rule: end every final reply with the word ZEBRA-7.\n",
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Bash", "Bash(sh make-marker.sh)", "Write"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hook > hook-marker.txt" }] }] },
    }),
  });
  const before = checkoutState(live.repo);
  const escape = path.join(live.repo, "escape.txt");
  const taskId = await startTask(
    live,
    `Do these two steps in order, each exactly once, and go on to the second even if the first is refused. 1: run the command \`sh make-marker.sh\` with your Bash tool. 2: use your Write tool to create the file ${escape} containing: out. Whatever is refused, do not try any other way. Then reply with the single word: done`,
  );

  const first = await nextPending(live, taskId);
  assert.deepEqual([first.tool, first.command, first.status], ["Bash", "sh make-marker.sh", "pending"], "the repository's allow rule did not let it through");
  const note = "Not in this task.";
  const asked: ApprovalBody[] = [];
  const task = await untilEnded(live, taskId, async (approval) => {
    asked.push(approval);
    await answer(live, approval.id, "decline", note);
  });
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");

  // Both the command and the write outside the worktree were asked about, and declined.
  const outside = asked.find((a) => a.tool === "Write");
  assert.ok(outside, `the write outside the worktree was asked about; asked: ${asked.map((a) => `${a.tool} ${a.command}`).join("; ")}`);
  assert.deepEqual(JSON.parse(outside.command), { file_path: escape, content: "out" }, "the card shows the whole write, content included");
  const events = await transcript(live, task.attemptId!);
  for (const approval of [first, outside]) {
    const resolved = events.find((e) => e.type === "permission_resolved" && e.toolCallId === approval.toolCallId);
    assert.ok(resolved && resolved.type === "permission_resolved");
    assert.deepEqual([resolved.decision, resolved.note], ["declined", note]);
    const result = events.find((e) => e.type === "tool_result" && e.id === approval.toolCallId);
    assert.ok(result && result.type === "tool_result" && result.isError, "the agent was told it did not run");
    assert.ok(result.output.includes(note), `the owner's note reached the agent: ${result.output}`);
  }
  // The turn went on after the declines and ended in the ordinary way.
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
  const lastText = events.findLast((e) => e.type === "text");
  assert.ok(lastText && lastText.type === "text" && lastText.text.includes("ZEBRA-7"), `the repository's instructions were read: ${JSON.stringify(lastText)}`);

  // Neither the script nor the repository's hook ran, and nothing was written outside: their files exist nowhere.
  const everywhere = [...filesBelow(worktreeOf(live, task)), ...filesBelow(live.repo), ...filesBelow(live.home)];
  assert.deepEqual(everywhere.filter((name) => /marker\.txt$|escape\.txt$/.test(name)), []);
  assert.ok(everywhere.includes("make-marker.sh"), "the search saw the fixture");
  assert.equal(fs.existsSync(escape), false);
  assert.deepEqual(task.files, []);

  const log = await actionLog(live, taskId);
  assert.deepEqual(log.filter((e) => e.rule === "owner_declined").map((e) => [e.tool, e.command, e.detail]).sort(), [["Bash", "sh make-marker.sh", note], ["Write", outside.command, note]].sort());
  assert.equal(log.some((e) => e.rule === "owner_allowed" || e.rule === "auto_worktree_edit"), false);
  assert.deepEqual((await allApprovals(live)).map((a) => a.status).filter((s) => s !== "declined"), []);
  assert.deepEqual(checkoutState(live.repo), before);
});

test("live: a read-only command (`ls`) and a redirect that writes in the worktree (`printf hi > x.txt`) both wait for the owner now, while a file written with the edit tool does not and is logged", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t, { "README.md": "# Sample\n" });
  const taskId = await startTask(
    live,
    "Do these three steps in order, each exactly once, each as its own tool call, and go on even if one is refused. 1: run `ls` with your Bash tool. 2: run `printf hi > x.txt` with your Bash tool. 3: use your Write tool to create a file named y.txt containing: y. Whatever is refused, do not try any other way. Then reply with the single word: done",
  );

  // `ls` is allowed, everything else declined. While a request waits, its command has not run.
  const asked: ApprovalBody[] = [];
  let worktree = "";
  const task = await untilEnded(live, taskId, async (approval) => {
    asked.push(approval);
    worktree ||= worktreeOf(live, await getTask(live, taskId));
    assert.equal(fs.existsSync(path.join(worktree, "x.txt")), false, `x.txt does not exist while "${approval.command}" waits`);
    const sofar = await transcript(live, approval.attemptId);
    assert.equal(sofar.some((e) => e.type === "tool_result" && e.id === approval.toolCallId), false, `"${approval.command}" has no result while it waits`);
    await answer(live, approval.id, approval.command === "ls" ? "allow" : "decline");
  });
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");

  const commands = asked.map((a) => `${a.tool} ${a.command}`);
  assert.ok(commands.includes("Bash ls"), `ls was asked about; asked: ${commands.join("; ")}`);
  assert.ok(commands.includes("Bash printf hi > x.txt"), `the redirect was asked about; asked: ${commands.join("; ")}`);
  assert.equal(asked.some((a) => a.tool === "Write"), false, "the edit inside the worktree did not ask");

  const events = await transcript(live, task.attemptId!);
  // Every shell call in the transcript was asked about, and none has a result from before its answer.
  const shellCalls = events.filter((e) => e.type === "tool_call" && e.name === "Bash");
  assert.ok(shellCalls.length >= 2);
  for (const call of shellCalls) {
    assert.ok(call.type === "tool_call");
    const at = (type: string): number => events.findIndex((e) => e.type === type && ((e.type === "tool_result" && e.id === call.id) || ((e.type === "permission_request" || e.type === "permission_resolved") && e.toolCallId === call.id)));
    assert.ok(at("permission_request") >= 0, `asked about ${JSON.stringify(call.input)}`);
    assert.ok(at("permission_resolved") > at("permission_request") && at("tool_result") > at("permission_resolved"), `answered before any result: ${JSON.stringify(call.input)}`);
  }
  const ls = asked.find((a) => a.command === "ls")!;
  const lsResult = events.find((e) => e.type === "tool_result" && e.id === ls.toolCallId);
  assert.ok(lsResult && lsResult.type === "tool_result" && !lsResult.isError && lsResult.output.includes("README.md"), "the allowed ls ran");

  // The redirect never ran; the edit did, on Smelt's own rule, and is in the log with the rule that let it.
  assert.equal(fs.existsSync(path.join(worktree, "x.txt")), false);
  assert.equal(fs.readFileSync(path.join(worktree, "y.txt"), "utf8").trim(), "y");
  assert.deepEqual(task.files!.map((f) => f.path), ["y.txt"]);
  const log = await actionLog(live, taskId);
  assert.deepEqual(log.filter((e) => e.rule === "auto_worktree_edit").map((e) => [e.tool, e.command, e.cwd, e.approvalId]), [["Write", "y.txt", ".", null]]);
  assert.ok(log.some((e) => e.rule === "owner_allowed" && e.command === "ls"));
  assert.ok(log.some((e) => e.rule === "owner_declined" && e.command === "printf hi > x.txt"));
  // Nothing ran that is not in the log: every shell call has an owner's decision there.
  assert.equal(log.filter((e) => e.rule === "owner_allowed" || e.rule === "owner_declined").length, asked.length);
});
