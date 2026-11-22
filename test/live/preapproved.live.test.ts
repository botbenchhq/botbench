import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { checkoutState, initRepo, tempDir } from "../support/repo.ts";

// These tests start the real Claude Code on the owner's login, through Botbench's HTTP API, in real temporary
// repositories, with commands pre-approved the way the client sends them. Every prompt is tiny and asks for the cheapest model.

const TASK_TIMEOUT = 240_000;
const JSON_TYPE = { "content-type": "application/json" };
const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';

interface Live {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
}

async function start(t: TestContext): Promise<Live> {
  const dir = tempDir("botbench-live-pre-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

interface TaskBody {
  id: number;
  status: string;
  reason: string | null;
  branch: string | null;
  attemptId: number | null;
  waitingOnApproval: boolean;
  preapproved: string[];
  files: { path: string; status: string }[] | null;
}
interface ApprovalBody {
  id: number;
  tool: string;
  command: string;
  cwd: string;
  status: string;
  toolCallId: string;
}
interface LogBody {
  rule: string;
  approvalId: number | null;
  grantId: number | null;
  tool: string;
  command: string;
  cwd: string;
  detail: string | null;
}

const getJson = async <B>(live: Live, route: string): Promise<B> => (await (await fetch(`${live.base}${route}`, { headers: live.headers })).json()) as B;
const getTask = (live: Live, id: number): Promise<TaskBody> => getJson(live, `/api/tasks/${id}`);
const approvals = async (live: Live, status?: string): Promise<ApprovalBody[]> => (await getJson<{ approvals: ApprovalBody[] }>(live, `/api/approvals${status ? `?status=${status}` : ""}`)).approvals;
const actionLog = async (live: Live, taskId: number): Promise<LogBody[]> => (await getJson<{ entries: LogBody[] }>(live, `/api/action-log?taskId=${taskId}`)).entries;
const transcript = async (live: Live, attemptId: number): Promise<DriverEvent[]> => (await getJson<{ events: StoredEvent[] }>(live, `/api/attempts/${attemptId}/events`)).events.map((e) => e.payload);
const worktreeOf = (live: Live, task: TaskBody): string => path.join(live.home, "worktrees", task.branch!.split("/")[1]!, `task-${task.id}`);
const ended = (task: TaskBody): boolean => task.status !== "queued" && task.status !== "building";

async function startTask(live: Live, prompt: string, preapproved: string[]): Promise<number> {
  const res = await fetch(`${live.base}/api/tasks`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ repo: live.repo, prompt, preapproved }) });
  const body = (await res.json()) as { taskId: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.taskId;
}

/** Wait for the task to end. Each approval that turns up pending on the way is handed to `onPending`, once. */
async function untilEnded(live: Live, taskId: number, onPending: (approval: ApprovalBody, task: TaskBody) => Promise<void>): Promise<TaskBody> {
  const deadline = Date.now() + TASK_TIMEOUT - 40_000;
  const handled = new Set<number>();
  for (;;) {
    const task = await getTask(live, taskId);
    if (ended(task)) return task;
    for (const approval of await approvals(live, "pending")) {
      if (handled.has(approval.id)) continue;
      handled.add(approval.id);
      await onPending(approval, task);
    }
    if (Date.now() > deadline) assert.fail("timed out waiting for the task to end");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function decline(live: Live, id: number): Promise<void> {
  const res = await fetch(`${live.base}/api/approvals/${id}`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ decision: "decline", note: "Not in this task." }) });
  assert.equal(res.status, 200, await res.text());
}

test("live: a task whose marker script is pre-approved runs it with no approval created; the marker file exists and the action log says it ran pre-approved", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t);
  const before = checkoutState(live.repo);
  const taskId = await startTask(live, "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done", ["sh make-marker.sh"]);

  const task = await untilEnded(live, taskId, async (approval) => {
    // Nobody answers: an approval here would leave the task waiting, so the test ends at once and says what was asked.
    assert.fail(`an approval was created for a pre-approved command: ${approval.tool} ${approval.command}`);
  });
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.deepEqual(task.preapproved, ["sh make-marker.sh"]);
  assert.deepEqual(await approvals(live), [], "no approval exists, pending or answered");
  assert.equal(fs.readFileSync(path.join(worktreeOf(live, task), "marker.txt"), "utf8").trim(), "ran");
  assert.deepEqual(task.files!.map((f) => [f.path, f.status]), [["marker.txt", "added"]]);

  assert.deepEqual((await actionLog(live, taskId)).map((e) => [e.rule, e.approvalId, e.grantId, e.tool, e.command, e.cwd, e.detail]), [
    ["preapproved", null, 1, "Bash", "sh make-marker.sh", ".", "Allowed for this task when it was started: sh make-marker.sh"],
  ]);
  // The transcript says the command ran pre-approved, not that the owner allowed it, and it ran after that.
  const events = await transcript(live, task.attemptId!);
  const resolved = events.findIndex((e) => e.type === "permission_resolved");
  const event = events[resolved]!;
  assert.ok(event.type === "permission_resolved" && event.decision === "preapproved", JSON.stringify(event));
  const result = events.findIndex((e) => e.type === "tool_result" && e.id === event.toolCallId);
  assert.ok(result > resolved, "the command ran after it was let through");
  assert.ok(!(events[result] as { isError: boolean }).isError);
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
  assert.equal(fs.existsSync(path.join(live.repo, "marker.txt")), false, "the script ran in the worktree, not in the owner's checkout");
  assert.deepEqual(checkoutState(live.repo), before);
});

test("live: with the marker script pre-approved, the script chained with another command waits for the owner, and nothing of it runs before the answer", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t);
  const chained = "sh make-marker.sh && echo done > other.txt";
  const taskId = await startTask(live, `Run exactly this one command with your Bash tool, as a single tool call, exactly once: \`${chained}\`. Do not split it into two calls. If it is refused, do not try any other way. Then reply with the single word: done`, ["sh make-marker.sh"]);

  const asked: ApprovalBody[] = [];
  const task = await untilEnded(live, taskId, async (approval, waiting) => {
    asked.push(approval);
    assert.deepEqual([waiting.status, (await getTask(live, taskId)).waitingOnApproval], ["building", true]);
    await new Promise((r) => setTimeout(r, 1000));
    const worktree = worktreeOf(live, await getTask(live, taskId));
    assert.deepEqual([fs.existsSync(path.join(worktree, "marker.txt")), fs.existsSync(path.join(worktree, "other.txt"))], [false, false], "nothing ran while the request waits");
    await decline(live, approval.id);
  });
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.deepEqual(asked.map((a) => [a.tool, a.command, a.cwd]), [["Bash", chained, "."]]);
  const worktree = worktreeOf(live, task);
  assert.deepEqual([fs.existsSync(path.join(worktree, "marker.txt")), fs.existsSync(path.join(worktree, "other.txt"))], [false, false], "declined: neither half ran");
  assert.deepEqual((await actionLog(live, taskId)).map((e) => [e.rule, e.grantId, e.command, e.detail]), [
    ["asked_owner", null, chained, "Always asks: not-a-plain-command."],
    ["owner_declined", null, chained, "Not in this task."],
  ]);
  assert.deepEqual((await approvals(live)).map((a) => a.status), ["declined"]);
});

test("live (AE6 in part): a command on the safety floor asks even though it is pre-approved: `git push` in a repository with no remote", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t);
  const taskId = await startTask(live, "Run the command `git push` with your Bash tool, exactly once. If it is refused or fails, do not try any other way. Then reply with the single word: done", ["git push"]);

  const asked: ApprovalBody[] = [];
  const task = await untilEnded(live, taskId, async (approval) => {
    asked.push(approval);
    await decline(live, approval.id);
  });
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  // The owner did pre-approve it, and it is listed as such; the floor still sent it to the owner.
  assert.deepEqual(task.preapproved, ["git push"]);
  assert.deepEqual(asked.map((a) => [a.tool, a.command, a.cwd]), [["Bash", "git push", "."]]);
  const log = await actionLog(live, taskId);
  assert.deepEqual(log.map((e) => [e.rule, e.grantId, e.command, e.detail]), [
    ["asked_owner", null, "git push", "Always asks: git-push."],
    ["owner_declined", null, "git push", "Not in this task."],
  ]);
  const events = await transcript(live, task.attemptId!);
  assert.equal(events.some((e) => e.type === "permission_resolved" && (e.decision === "preapproved" || e.decision === "allowed")), false);
  const result = events.find((e) => e.type === "tool_result" && e.id === asked[0]!.toolCallId);
  assert.ok(result && result.type === "tool_result" && result.isError, "the agent was told it did not run");
});
