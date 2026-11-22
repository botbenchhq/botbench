import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { killProcessGroup, processGroupAlive } from "../../src/drivers/launch.ts";
import { CONTINUE_PROMPT } from "../../src/engine/recover.ts";
import { DB_FILE } from "../../src/store/db.ts";
import { startBotbench } from "../../e2e/botbench.ts";
import { checkoutState, git, initRepo } from "../support/repo.ts";

// A restart in the middle of a real build turn: a real Botbench process (`node src/server.ts`) drives the owner's Claude
// Code on its cheapest model, and is killed with SIGKILL while the agent is at work. Nothing of it closes: the CLI is
// left running in the task's copy. The next start must stop that CLI before anything else runs there, re-drive the task
// once from the session it had reported, and see it finish.

const TASK_TIMEOUT = 360_000;
const JSON_TYPE = { "content-type": "application/json" };
const PROMPT = "Use your Bash tool to run exactly this command: sleep 20\nWhen it has finished, use the Write tool to create a file named done.txt containing exactly: done\nThen reply with the single word: done";

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
  files: { path: string; status: string }[] | null;
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
const transcript = async (c: Client, attemptId: number): Promise<DriverEvent[]> => (await getJson<{ events: StoredEvent[] }>(c, `/api/attempts/${attemptId}/events`)).events.map((e) => e.payload);
const attemptRows = (home: string): { id: number; status: string; pgid: number | null; resume_cursor: string | null }[] => {
  const db = new DatabaseSync(path.join(home, DB_FILE), { readOnly: true });
  try {
    return db.prepare("SELECT id, status, pgid, resume_cursor FROM attempts ORDER BY id").all().map((row) => ({ ...row })) as never;
  } finally {
    db.close();
  }
};
const restartsOf = (home: string, taskId: number): number => {
  const db = new DatabaseSync(path.join(home, DB_FILE), { readOnly: true });
  try {
    return Number(db.prepare("SELECT restarts FROM tasks WHERE id = ?").get(taskId)!.restarts);
  } finally {
    db.close();
  }
};
async function until<V>(what: string, read: () => Promise<V> | V, done: (v: V) => boolean, ms: number): Promise<V> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
/** The processes whose command line names `dir`, as `ps` lists them. */
const processesIn = (dir: string): string[] => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(dir));

test("live: Botbench is killed with SIGKILL during a real build turn; on the next start the Claude Code it left running is stopped, the task is re-driven once from its session and finishes, and no CLI process is left", { timeout: TASK_TIMEOUT }, async (t) => {
  const botbench = await startBotbench();
  const dir = path.dirname(botbench.home);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const before = checkoutState(repo);
  let survivor: number | null = null;
  t.after(async () => {
    const { leftover } = await botbench.stop();
    if (survivor !== null) await killProcessGroup(survivor).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(leftover, [], "no CLI process is left after Botbench stops");
  });

  let client = await signIn(botbench.base, botbench.home);
  const res = await fetch(`${client.base}/api/tasks`, { method: "POST", headers: { ...client.headers, ...JSON_TYPE }, body: JSON.stringify({ repo, prompt: PROMPT, preapproved: ["sleep 20"] }) });
  const taskId = ((await res.json()) as { taskId: number }).taskId;
  assert.equal(res.status, 200);

  // The agent is at work: its session is reported and its `sleep` has started.
  const working = await until("the agent to start its command", () => getTask(client, taskId), (task) => task.attemptId !== null, 120_000);
  await until("the command to run", () => transcript(client, working.attemptId!), (events) => events.some((e) => e.type === "tool_call" && JSON.stringify(e).includes("sleep 20")), 120_000);
  const [first] = attemptRows(botbench.home);
  assert.ok(first && first.pgid !== null && first.resume_cursor !== null, "the CLI's process group and session are recorded");
  survivor = first.pgid;
  const worktree = path.join(botbench.home, "worktrees", working.branch!.split("/")[1]!, `task-${taskId}`);

  await botbench.kill();
  assert.equal(processGroupAlive(survivor), true, "Claude Code outlived the Botbench that started it");

  await botbench.restart();
  // The next attempt is started only once the old CLI is gone, so its row means the survivor was stopped first.
  const rows = await until("the task to be re-driven", () => attemptRows(botbench.home), (all) => all.length >= 2, 60_000);
  assert.equal(processGroupAlive(survivor), false, "the surviving Claude Code was stopped on start");
  assert.deepEqual([rows[0]!.pgid, rows[0]!.status], [null, "interrupted"]);
  assert.equal(rows[1]!.resume_cursor, first.resume_cursor, "the re-drive resumes the session the CLI had reported");
  client = await signIn(botbench.base, botbench.home);

  const task = await until("the task to finish", () => getTask(client, taskId), (task) => task.status !== "queued" && task.status !== "building" && task.status !== "verifying", 240_000);
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  assert.equal(git(repo, "show", `${task.branch}:done.txt`).trim(), "done");
  assert.equal(attemptRows(botbench.home).length, 2, "re-driven once");
  assert.equal(restartsOf(botbench.home, taskId), 1);
  const events = await transcript(client, task.attemptId!);
  const prompt = events.find((e) => e.type === "user_prompt");
  assert.ok(prompt && prompt.type === "user_prompt" && prompt.text === CONTINUE_PROMPT, "the agent was told what happened");
  // Its turn is over, so its CLI is gone; and nothing else runs in its copy.
  assert.deepEqual(attemptRows(botbench.home).map((a) => a.pgid), [null, null]);
  assert.deepEqual(processesIn(worktree), []);
  assert.deepEqual(checkoutState(repo), before);
});
