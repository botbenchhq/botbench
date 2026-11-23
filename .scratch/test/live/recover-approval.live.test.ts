import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { killProcessGroup, processGroupAlive } from "../../src/drivers/launch.ts";
import { startServer } from "../../src/server.ts";
import { DB_FILE } from "../../src/store/db.ts";
import { startBotbench } from "../../e2e/botbench.ts";
import type { Left } from "../support/leave-pending.ts";
import { checkoutState, initRepo, tempDir } from "../support/repo.ts";

// Approvals across a restart, with the real Claude Code on the owner's login, cheapest model, tiny prompts.
// Botbench is stopped for real: killed as a process in the first test, shut down in the second.

const TASK_TIMEOUT = 300_000;
const JSON_TYPE = { "content-type": "application/json" };
const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';
const PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";
const CONFIG: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } } };

interface Client {
  base: string;
  headers: Record<string, string>;
}
interface TaskBody {
  id: number;
  status: string;
  reason: string | null;
  branch: string | null;
  attemptId: number | null;
  waitingOnApproval: boolean;
  parked: boolean;
  files: { path: string; status: string }[] | null;
}
interface ApprovalBody {
  id: number;
  taskId: number;
  attemptId: number;
  tool: string;
  command: string;
  cwd: string;
  toolCallId: string;
  status: string;
  note: string | null;
  parkedAt: string | null;
  storedDecision: string | null;
}
interface LogBody {
  rule: string;
  approvalId: number | null;
  attemptId: number | null;
  command: string;
  detail: string | null;
}

async function signIn(base: string, home: string): Promise<Client> {
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

const getJson = async <B>(c: Client, route: string): Promise<B> => (await (await fetch(`${c.base}${route}`, { headers: c.headers })).json()) as B;
const getTask = (c: Client, id: number): Promise<TaskBody> => getJson(c, `/api/tasks/${id}`);
const approvals = async (c: Client, status?: string): Promise<ApprovalBody[]> => (await getJson<{ approvals: ApprovalBody[] }>(c, `/api/approvals${status ? `?status=${status}` : ""}`)).approvals;
const actionLog = async (c: Client, taskId: number): Promise<LogBody[]> => (await getJson<{ entries: LogBody[] }>(c, `/api/action-log?taskId=${taskId}`)).entries;
const transcript = async (c: Client, attemptId: number): Promise<DriverEvent[]> => (await getJson<{ events: StoredEvent[] }>(c, `/api/attempts/${attemptId}/events`)).events.map((e) => e.payload);

/** Turns on the owner's setting Ask before every command, as Settings saves it; it is kept in the store across a restart. */
async function everyCommand(c: Client): Promise<void> {
  const res = await fetch(`${c.base}/api/settings`, { method: "PUT", headers: { ...c.headers, ...JSON_TYPE }, body: JSON.stringify({ askEveryCommand: true }) });
  assert.equal(res.status, 200, await res.text());
}

async function startTask(c: Client, repo: string): Promise<number> {
  const res = await fetch(`${c.base}/api/tasks`, { method: "POST", headers: { ...c.headers, ...JSON_TYPE }, body: JSON.stringify({ repo, prompt: PROMPT }) });
  const body = (await res.json()) as { taskId: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.taskId;
}

async function answer(c: Client, id: number, decision: "allow" | "decline", note?: string): Promise<ApprovalBody> {
  const res = await fetch(`${c.base}/api/approvals/${id}`, { method: "POST", headers: { ...c.headers, ...JSON_TYPE }, body: JSON.stringify(note === undefined ? { decision } : { decision, note }) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return (JSON.parse(text) as { approval: ApprovalBody }).approval;
}

const ended = (task: TaskBody): boolean => task.status !== "queued" && task.status !== "building";

async function firstPending(c: Client, taskId: number): Promise<ApprovalBody> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const [first] = await approvals(c, "pending");
    if (first) return first;
    const task = await getTask(c, taskId);
    if (ended(task)) assert.fail(`the task ended (${task.status}: ${task.reason}) without a pending approval`);
    if (Date.now() > deadline) assert.fail("timed out waiting for a pending approval");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function untilEnded(c: Client, taskId: number): Promise<TaskBody> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    const task = await getTask(c, taskId);
    if (ended(task)) return task;
    if (Date.now() > deadline) assert.fail(`timed out waiting for the task to end; it is ${task.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Every file below `dir`, by name, without git's own folder. */
const filesBelow = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => !name.split(path.sep).includes(".git"));
const worktreeOf = (home: string, task: TaskBody): string => path.join(home, "worktrees", task.branch!.split("/").at(-2)!, `task-${task.id}`);
const attemptRows = (home: string): { id: number; status: string; pgid: number | null; resume_cursor: string | null }[] => {
  const db = new DatabaseSync(path.join(home, DB_FILE), { readOnly: true });
  try {
    return db.prepare("SELECT id, status, pgid, resume_cursor FROM attempts ORDER BY id").all().map((row) => ({ ...row })) as never;
  } finally {
    db.close();
  }
};

test("live: Botbench is killed while a task waits on an approval and its Claude Code is left running; on the next start that process is stopped, the approval is still listed, and allowing it re-drives the task, which finishes with the marker file and no second approval", { timeout: TASK_TIMEOUT }, async (t) => {
  const botbench = await startBotbench();
  const dir = path.dirname(botbench.home);
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  const before = checkoutState(repo);
  let survivor: number | null = null;
  t.after(async () => {
    const { leftover } = await botbench.stop();
    if (survivor !== null) await killProcessGroup(survivor).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(leftover, [], "no CLI process is left after Botbench stops");
  });

  let client = await signIn(botbench.base, botbench.home);
  // A command kept inside the task's copy runs without a card by default; the card to park needs Ask before every command.
  await everyCommand(client);
  const taskId = await startTask(client, repo);
  const asked = await firstPending(client, taskId);
  assert.deepEqual([asked.command, asked.cwd, asked.parkedAt, asked.storedDecision], ["sh make-marker.sh", ".", null, null]);
  const waiting = await getTask(client, taskId);
  assert.deepEqual([waiting.status, waiting.waitingOnApproval, waiting.parked], ["building", true, false]);
  const worktree = worktreeOf(botbench.home, waiting);
  const [first] = attemptRows(botbench.home);
  assert.ok(first && first.pgid !== null && first.resume_cursor !== null);
  survivor = first.pgid;

  // The CLI hangs (it is frozen, so it cannot notice anything), and Botbench is killed outright: nothing of it closes.
  process.kill(-survivor, "SIGSTOP");
  await botbench.kill();
  assert.equal(processGroupAlive(survivor), true, "Claude Code outlived the Botbench that started it");
  assert.equal(fs.existsSync(path.join(worktree, "marker.txt")), false);

  // Recovery goes on behind the listening server. A frozen process ignores the polite signal, so it is killed after the grace period.
  await botbench.restart();
  // The attempt forgets its process group only once the group is gone.
  for (const deadline = Date.now() + 15_000; attemptRows(botbench.home)[0]!.pgid !== null && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 100));
  assert.equal(processGroupAlive(survivor), false, "the surviving Claude Code was stopped on start");
  assert.deepEqual(attemptRows(botbench.home).map((a) => [a.id, a.pgid]), [[first.id, null]]);
  assert.equal((await getTask(client, taskId)).id, taskId, "the device stays signed in across the restart (sessions are kept in the database)");
  client = await signIn(botbench.base, botbench.home);

  // The approval is still there, as it was asked, and its task waits on the owner; nothing was run, re-driven or committed.
  const listed = await approvals(client, "pending");
  assert.deepEqual(listed.map((a) => [a.id, a.command, a.cwd, a.toolCallId, a.status, a.storedDecision]), [[asked.id, "sh make-marker.sh", ".", asked.toolCallId, "pending", null]]);
  assert.ok(listed[0]!.parkedAt !== null, "it says it was asked before the restart");
  const parked = await getTask(client, taskId);
  assert.deepEqual([parked.status, parked.waitingOnApproval, parked.parked, parked.attemptId, parked.reason], ["building", true, true, first.id, null]);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(attemptRows(botbench.home).length, 1, "nothing is re-driven until the owner answers");
  assert.equal(fs.existsSync(path.join(worktree, "marker.txt")), false);

  const stored = await answer(client, asked.id, "allow");
  assert.equal(stored.storedDecision, "allow");
  const task = await untilEnded(client, taskId);
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(fs.readFileSync(path.join(worktree, "marker.txt"), "utf8").trim(), "ran");
  assert.deepEqual(task.files!.map((f) => [f.path, f.status]), [["marker.txt", "added"]]);
  assert.notEqual(task.attemptId, first.id, "a new attempt resumed the session");
  const attempts = attemptRows(botbench.home);
  assert.deepEqual(attempts.map((a) => [a.pgid, a.resume_cursor]), [[null, first.resume_cursor], [null, first.resume_cursor]], "same session, in the same worktree, and no process left");

  // Exactly one approval ever existed, and the log says how its answer was used.
  assert.deepEqual((await approvals(client)).map((a) => [a.id, a.status]), [[asked.id, "allowed"]], "no second approval was created");
  const log = await actionLog(client, taskId);
  assert.deepEqual(log.map((e) => [e.rule, e.approvalId, e.attemptId, e.command]), [
    ["asked_owner", asked.id, first.id, "sh make-marker.sh"],
    ["owner_allowed", asked.id, first.id, "sh make-marker.sh"],
    ["stored_answer_applied", asked.id, task.attemptId, "sh make-marker.sh"],
  ]);
  const events = await transcript(client, task.attemptId!);
  const requests = events.filter((e) => e.type === "permission_request");
  assert.equal(requests.length, 1, "the resumed turn asked once");
  const resolved = events.find((e) => e.type === "permission_resolved");
  assert.ok(resolved && resolved.type === "permission_resolved" && resolved.decision === "allowed");
  const result = events.find((e) => e.type === "tool_result" && e.id === resolved.toolCallId);
  assert.ok(result && result.type === "tool_result" && !result.isError, "the command ran once it was allowed");
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
  assert.deepEqual(checkoutState(repo), before);
});

test("live: Botbench is shut down while a task waits on an approval and started again on the same home; the approval is still listed, and declining it re-drives the task: the agent receives the declined result and the marker file exists nowhere", { timeout: TASK_TIMEOUT }, async (t) => {
  const dir = tempDir("botbench-live-recover-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });

  const firstServer = await startServer({ config: CONFIG, home, signInDelayMs: 1 });
  t.after(() => firstServer.close());
  let client = await signIn(`http://127.0.0.1:${firstServer.port}`, home);
  // A command kept inside the task's copy runs without a card by default; the card to park needs Ask before every command.
  await everyCommand(client);
  const taskId = await startTask(client, repo);
  const asked = await firstPending(client, taskId);
  const firstAttempt = (await getTask(client, taskId)).attemptId!;
  await firstServer.close();
  assert.deepEqual(attemptRows(home).map((a) => a.pgid), [null], "shutting down stopped Claude Code");

  const server = await startServer({ config: CONFIG, home, signInDelayMs: 1 });
  t.after(() => server.close());
  client = await signIn(`http://127.0.0.1:${server.port}`, home);
  const listed = await approvals(client, "pending");
  assert.deepEqual(listed.map((a) => [a.id, a.command, a.status]), [[asked.id, "sh make-marker.sh", "pending"]], "the approval is still listed after the restart");
  assert.ok(listed[0]!.parkedAt !== null);
  const parked = await getTask(client, taskId);
  assert.deepEqual([parked.status, parked.waitingOnApproval, parked.parked, parked.attemptId], ["building", true, true, firstAttempt]);

  const note = "Not in this task.";
  await answer(client, asked.id, "decline", note);
  const task = await untilEnded(client, taskId);
  assert.equal(task.status, "failed", task.reason ?? "");
  assert.ok(task.reason?.startsWith("Claude Code finished without changing any file"), task.reason ?? "");
  assert.notEqual(task.attemptId, firstAttempt);

  // The agent was told, in the resumed session, that the owner declined, with the note.
  const events = await transcript(client, task.attemptId!);
  const resolved = events.find((e) => e.type === "permission_resolved");
  assert.ok(resolved && resolved.type === "permission_resolved");
  assert.deepEqual([resolved.decision, resolved.note], ["declined", note]);
  const result = events.find((e) => e.type === "tool_result" && e.id === resolved.toolCallId);
  assert.ok(result && result.type === "tool_result" && result.isError && result.output.includes(note), `the agent received the declined result: ${JSON.stringify(result)}`);
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });

  const everywhere = [...filesBelow(worktreeOf(home, task)), ...filesBelow(repo), ...filesBelow(home)];
  assert.deepEqual(everywhere.filter((name) => /marker\.txt$/.test(name)), [], "the script ran nowhere");
  assert.ok(everywhere.includes("make-marker.sh"), "the search saw the fixture");
  assert.deepEqual(task.files, []);
  // Every approval there is was declined: the one from before the restart, and any the agent asked for afterwards.
  const all = await approvals(client);
  assert.deepEqual([all[0]!.id, all[0]!.status, all[0]!.note], [asked.id, "declined", note]);
  const log = await actionLog(client, taskId);
  assert.deepEqual(log.slice(0, 3).map((e) => [e.rule, e.approvalId]), [["asked_owner", asked.id], ["owner_declined", asked.id], ["stored_answer_applied", asked.id]]);
  assert.equal(log.some((e) => e.rule === "owner_allowed"), false);
  assert.equal(all.length, 1, "no second approval was created");
});

test("live: when Claude Code cannot resume the session a parked approval belongs to, allowing it runs nothing: the task is marked interrupted with the reason and the approval is closed as superseded", { timeout: 120_000 }, async (t) => {
  const dir = tempDir("botbench-live-recover-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  // A Botbench that was killed while a task waited, whose attempt names a session Claude Code does not have.
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "..", "support", "leave-pending.ts"), JSON.stringify({ home, repo, cursor: "3f0e0c4e-9a57-4f0e-8a5d-1c2b3a4d5e6f", commands: ["sh make-marker.sh"] })], { encoding: "utf8" });
  const left = JSON.parse(run.stdout) as Left;

  const server = await startServer({ config: CONFIG, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const client = await signIn(`http://127.0.0.1:${server.port}`, home);
  assert.deepEqual((await approvals(client, "pending")).map((a) => a.id), left.approvalIds);
  await answer(client, left.approvalIds[0]!, "allow");
  const task = await untilEnded(client, left.taskId);
  assert.equal(task.status, "interrupted");
  assert.match(task.reason ?? "", /could not resume.*your answer was not applied/is);
  assert.deepEqual((await approvals(client)).map((a) => [a.status, a.storedDecision]), [["superseded", "allow"]]);
  assert.deepEqual((await actionLog(client, left.taskId)).map((e) => e.rule), ["asked_owner", "owner_allowed", "stored_answer_discarded"]);
  assert.deepEqual(filesBelow(left.worktree).filter((name) => /marker\.txt$/.test(name)), [], "nothing ran");
  assert.deepEqual(attemptRows(home).map((a) => a.pgid), [null, null], "and no process is left");
});
