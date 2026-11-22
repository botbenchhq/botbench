import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { openStore } from "../../src/store/db.ts";
import { checkoutState, git, initRepo, botbenchBranches, tempDir, worktreeCount, write } from "../support/repo.ts";

// These tests start the real Claude Code on the owner's login, through Botbench's
// HTTP API, in real temporary repositories. Every prompt is tiny and asks for the cheapest model.

const TASK_TIMEOUT = 240_000;
const JSON_TYPE = { "content-type": "application/json" };

interface Live {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  dir: string;
  home: string;
  repo: string;
}

/** A real Botbench server, and a real repository with the owner part-way through their own work on `main`. */
async function start(t: TestContext, files: Record<string, string> = { "README.md": "# Sample\n" }): Promise<Live> {
  const dir = tempDir("botbench-live-task-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, files);
  write(repo, "README.md", "# Sample\nthe owner is half-way through this line\n");
  write(repo, "notes.txt", "untracked, the owner's\n");
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
  repo: string;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  attemptId: number | null;
  files: { path: string; status: string; added: number; removed: number; binary: boolean }[] | null;
}

async function startTask(live: Live, prompt: string): Promise<number> {
  const res = await fetch(`${live.base}/api/tasks`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ repo: live.repo, prompt }) });
  const body = (await res.json()) as { taskId: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(Object.keys(body), ["taskId"]);
  assert.ok(Number.isSafeInteger(body.taskId) && body.taskId > 0);
  return body.taskId;
}
const getTask = async (live: Live, id: number): Promise<TaskBody> => (await (await fetch(`${live.base}/api/tasks/${id}`, { headers: live.headers })).json()) as TaskBody;
const transcript = async (live: Live, attemptId: number): Promise<StoredEvent[]> =>
  ((await (await fetch(`${live.base}/api/attempts/${attemptId}/events`, { headers: live.headers })).json()) as { events: StoredEvent[] }).events;

/** Read the real event stream: the task announcements it carries, and the stored events. */
async function openStream(t: TestContext, live: Live): Promise<{ announced: { taskId: number; status: string }[]; events: StoredEvent[] }> {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const res = await fetch(`${live.base}/api/stream`, { headers: live.headers, signal: abort.signal });
  assert.equal(res.status, 200);
  const announced: { taskId: number; status: string }[] = [];
  const events: StoredEvent[] = [];
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const data = lines.find((l) => l.startsWith("data: "));
          if (!data) continue;
          if (lines.includes("event: task")) announced.push(JSON.parse(data.slice(6)) as { taskId: number; status: string });
          else if (!lines.some((l) => l.startsWith("event: "))) events.push(JSON.parse(data.slice(6)) as StoredEvent);
        }
      }
    } catch {
      // Aborted when the test ends.
    }
  })();
  return { announced, events };
}

async function until(what: string, done: () => boolean | Promise<boolean>, ms = TASK_TIMEOUT - 40_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const groupAlive = (pgid: number): boolean => execFileSync("ps", ["-A", "-o", "pgid="], { encoding: "utf8" }).split("\n").some((line) => Number(line.trim()) === pgid);

test("live: a task to create hello.txt ends awaiting a decision with Botbench's commit on a task branch, and the source checkout is unchanged", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t);
  const before = checkoutState(live.repo);
  const stream = await openStream(t, live);

  const taskId = await startTask(live, "Use your Write tool to create a file named hello.txt containing exactly: hi");
  // The answer came at once: the task is still on its way.
  const early = await getTask(live, taskId);
  assert.ok(["queued", "building"].includes(early.status), `just started, got ${early.status}`);
  assert.deepEqual([early.headCommit, early.files], [null, null]);

  await until("the task to await a decision", () => {
    // A task that asks for an approval here would wait for ever: say what it asked for.
    const asked = live.server.broker.pending();
    if (asked.length > 0) throw new Error(`the task asked for an approval this test does not expect: ${asked[0]!.tool} ${asked[0]!.command}`);
    return stream.announced.some((a) => a.taskId === taskId && a.status === "awaiting_decision");
  });
  const task = await getTask(live, taskId);
  assert.equal(task.status, "awaiting_decision");
  assert.equal(task.reason, null);
  assert.equal(task.repo, live.repo);
  assert.match(task.branch ?? "", new RegExp(`^botbench/run-\\d+/task-${taskId}$`));
  assert.equal(task.baseCommit, before.head);
  assert.notEqual(task.headCommit, before.head);

  // The commit is on the task branch, made by Botbench, and holds the file with that content.
  assert.equal(git(live.repo, "rev-parse", task.branch!).trim(), task.headCommit);
  assert.equal(git(live.repo, "rev-parse", `${task.branch}^`).trim(), before.head, "one commit on top of the base");
  assert.equal(git(live.repo, "show", `${task.branch}:hello.txt`).trim(), "hi");
  assert.equal(git(live.repo, "log", "-1", "--format=%an <%ae>|%cn", task.branch!).trim(), "Botbench <botbench@localhost>|Botbench");
  assert.deepEqual(task.files!.map((f) => [f.path, f.status, f.added, f.removed]), [["hello.txt", "added", 1, 0]]);
  const diff = (await (await fetch(`${live.base}/api/tasks/${taskId}/diff?file=hello.txt`, { headers: live.headers })).json()) as { diff: string };
  assert.match(diff.diff, /\n\+hi\n?/);

  // The source checkout: same branch, same commit, same uncommitted and untracked files, byte for byte.
  assert.deepEqual(checkoutState(live.repo), before);
  assert.equal(fs.readFileSync(path.join(live.repo, "README.md"), "utf8"), "# Sample\nthe owner is half-way through this line\n");
  assert.equal(fs.existsSync(path.join(live.repo, "hello.txt")), false);
  assert.deepEqual(botbenchBranches(live.repo), [task.branch]);
  assert.equal(worktreeCount(live.repo), 2);

  // The agent worked in the task's worktree under Botbench's home, and its transcript is the attempt's.
  const worktree = path.join(live.home, "worktrees", task.branch!.split("/")[1]!, `task-${taskId}`);
  assert.equal(fs.readFileSync(path.join(worktree, "hello.txt"), "utf8").trim(), "hi");
  const events = await transcript(live, task.attemptId!);
  assert.deepEqual(events[0]!.payload, { type: "user_prompt", text: "Use your Write tool to create a file named hello.txt containing exactly: hi" });
  // Whichever of its tools the agent used, it was aimed at the file in the worktree, never at the source checkout.
  const calls = events.map((e) => e.payload).filter((p) => p.type === "tool_call");
  assert.ok(calls.some((p) => JSON.stringify(p.input).includes("hello.txt")), `a tool call names the file; got ${JSON.stringify(calls)}`);
  assert.equal(calls.some((p) => JSON.stringify(p.input).includes(live.repo)), false, "no tool call names the source checkout");
  assert.deepEqual(events.at(-1)!.payload, { type: "turn_ended", reason: "completed", detail: null });
  // The stream carried the transcript and each state the task went through, in order.
  assert.deepEqual(stream.events.filter((e) => e.attemptId === task.attemptId), events);
  const states = stream.announced.filter((a) => a.taskId === taskId).map((a) => a.status);
  assert.deepEqual([...new Set(states)], ["queued", "building", "awaiting_decision"]);
  assert.deepEqual(server_states(live, taskId), ["queued", "building", "building", "awaiting_decision"]);

  // The task's turn is over, so its CLI process is gone without waiting for Botbench to stop.
  const attempt = live.server.db.prepare("SELECT status, pgid FROM attempts WHERE id = ?").get(task.attemptId)!;
  assert.deepEqual({ ...attempt }, { status: "ended", pgid: null });
  const list = (await (await fetch(`${live.base}/api/tasks`, { headers: live.headers })).json()) as { tasks: TaskBody[] };
  assert.deepEqual(list.tasks.map((x) => [x.id, x.status]), [[taskId, "awaiting_decision"]]);
});

const server_states = (live: Live, taskId: number): unknown[] => live.server.db.prepare("SELECT status FROM task_events WHERE task_id = ? ORDER BY id").all(taskId).map((r) => r.status);

// What a task may run, and how the owner is asked, is in approval.live.test.ts.

test("live: stopping Botbench while a task builds interrupts it, and Botbench still commits the work done so far", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t);
  const before = checkoutState(live.repo);
  const stream = await openStream(t, live);
  const taskId = await startTask(live, "First use the Write tool to create a file named part.txt containing exactly: part. After that, write a 1500 word essay about rivers as your reply.");
  await until("the file to be written", () => stream.events.some((e) => e.payload.type === "tool_result" && !e.payload.isError));
  const building = await getTask(live, taskId);
  assert.equal(building.status, "building");
  const pgid = Number(live.server.db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(building.attemptId)!.pgid);
  assert.equal(groupAlive(pgid), true);

  await live.server.close();
  assert.equal(groupAlive(pgid), false, "no CLI process is left");

  const db = openStore(live.home);
  t.after(() => db.close());
  const task = { ...db.prepare("SELECT status, reason, branch, head_commit FROM tasks WHERE id = ?").get(taskId)! };
  assert.equal(task.status, "interrupted");
  assert.match(String(task.reason), /stopped before it finished/);
  assert.equal(git(live.repo, "rev-parse", String(task.branch)).trim(), task.head_commit);
  assert.equal(git(live.repo, "show", `${String(task.branch)}:part.txt`).trim(), "part");
  assert.deepEqual(db.prepare("SELECT status FROM task_events WHERE task_id = ? ORDER BY id").all(taskId).map((r) => r.status), ["queued", "building", "building", "interrupted"]);
  assert.deepEqual(checkoutState(live.repo), before);
});

test("live: with Claude Code signed out, a task fails with the reason in words and leaves no worktree or branch behind", { timeout: 60_000 }, async (t) => {
  // The real CLI, pointed at an empty configuration directory, reports itself signed out. No model is reached.
  const emptyConfig = tempDir("botbench-live-claude-config-");
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = emptyConfig;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(emptyConfig, { recursive: true, force: true });
  });
  const live = await start(t);
  const before = checkoutState(live.repo);
  const stream = await openStream(t, live);

  const taskId = await startTask(live, "Create a file named hello.txt containing exactly: hi");
  await until("the task to fail", () => stream.announced.some((a) => a.taskId === taskId && a.status === "failed"), 40_000);
  const task = await getTask(live, taskId);
  assert.equal(task.status, "failed");
  assert.match(task.reason ?? "", /Claude Code is signed out\. Run `claude auth login` in a terminal\./);
  assert.deepEqual([task.attemptId, task.headCommit, task.files], [null, null, null]);
  assert.equal(live.server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0);
  assert.equal(worktreeCount(live.repo), 1, "the worktree nothing happened in is removed");
  assert.deepEqual(botbenchBranches(live.repo), []);
  assert.deepEqual(fs.readdirSync(path.join(live.home, "worktrees")), []);
  assert.deepEqual(checkoutState(live.repo), before);
});
