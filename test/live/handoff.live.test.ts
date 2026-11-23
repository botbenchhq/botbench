import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// Moving a real task between real agents mid-build (src/engine/handoff.ts, U21, AE4): Botbench's HTTP API on the
// owner's Mac, Claude Code on Haiku and Codex on its cheapest model, each on the owner's own sign-in, in real temporary
// repositories. The task is started on one agent; once its first file is in the task's copy, it is moved to the other
// from the task flow (the task's `moveTo`, then POST /api/tasks/:id/move), and it must finish Ready for review on one
// branch, with one transcript that shows both agents. The assertions are on structure, not on the models' wording.
// Excluded from npm test (`npm run test:live`).

const TIMEOUT = 600_000;
const CODEX_MODEL = process.env.CODEX_LIVE_MODEL ?? "gpt-6-luna";
const CLAUDE_MODEL = process.env.CLAUDE_LIVE_MODEL ?? "haiku";
const JSON_TYPE = { "content-type": "application/json" };
const PROMPT = "Work in this order. First create the file one.txt containing the word one. Then run the shell command `sleep 45` and wait for it. Then create the file two.txt containing the word two. Change nothing else.";

interface Live {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  repo: string;
}

interface TaskBody {
  id: number;
  status: string;
  reason: string | null;
  attemptId: number | null;
  branch: string | null;
  builder: string;
  moveTo: string[];
  handoffs: { from: string; to: string; reason: string; fromAttemptId: number | null; line: string }[];
  files: { path: string }[] | null;
}

async function start(t: TestContext): Promise<Live> {
  const dir = tempDir("bb-live-hand-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: CLAUDE_MODEL }, codex: { model: CODEX_MODEL } }, roles: { implementer: { driver: "claude-code" } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const headers = { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! };
  const agents = (await (await fetch(`${base}/api/agents?fresh=1`, { headers })).json()) as { agents: { agent: string; roles: string[]; problem: string | null }[] };
  for (const name of ["claude-code", "codex"]) assert.ok(agents.agents.find((a) => a.agent === name)?.roles.includes("builder"), `${name} can build on this Mac: ${JSON.stringify(agents.agents)}`);
  return { server, base, headers, repo };
}

const getJson = async <B>(live: Live, route: string): Promise<B> => (await (await fetch(`${live.base}${route}`, { headers: live.headers })).json()) as B;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until<B>(read: () => Promise<B>, ready: (b: B) => boolean, what: string, ms = TIMEOUT - 60_000): Promise<B> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (ready(got)) return got;
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}: ${JSON.stringify(got)}`);
    await pause(1000);
  }
}

/** Start the task on `from`, move it to `to` once its first file is in the copy, and check how it ends. */
async function moveMidBuild(t: TestContext, from: "claude-code" | "codex", to: "claude-code" | "codex"): Promise<void> {
  const live = await start(t);
  const started = await fetch(`${live.base}/api/tasks`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ repo: live.repo, prompt: PROMPT, agent: from, ...(from === "claude-code" ? { model: CLAUDE_MODEL } : {}) }) });
  assert.equal(started.status, 200, await started.clone().text());
  const { taskId } = (await started.json()) as { taskId: number };
  const read = (): Promise<TaskBody> => getJson<TaskBody>(live, `/api/tasks/${taskId}`);

  // Mid-build: the first file is in the task's copy, and the task offers the other agent.
  const copy = (await until(read, (task) => task.branch !== null, "the task has its copy")).branch!;
  const worktree = git(live.repo, "worktree", "list", "--porcelain").split("\n").find((l) => l.startsWith("worktree ") && l.includes(`task-${taskId}`))!.slice("worktree ".length);
  const midway = await until(read, (task) => fs.existsSync(path.join(worktree, "one.txt")) && task.moveTo.includes(to), `${from} wrote one.txt and the task offers ${to}`);
  assert.equal(midway.status, "building");
  assert.equal(midway.builder, from);
  const fromAttempt = midway.attemptId!;

  const moved = await fetch(`${live.base}/api/tasks/${taskId}/move`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ agent: to, model: to === "codex" ? CODEX_MODEL : CLAUDE_MODEL }) });
  assert.equal(moved.status, 200, await moved.clone().text());

  const done = await until(read, (task) => !["queued", "building", "verifying", "reviewing"].includes(task.status), "the task reaches an end");
  assert.equal(done.status, "awaiting_decision", done.reason ?? "");
  assert.equal(done.builder, to);
  // One branch, the same one, and one copy.
  assert.equal(done.branch, copy);
  assert.deepEqual(git(live.repo, "branch", "--format=%(refname:short)").split("\n").filter((b) => b.startsWith("botbench/")), [copy]);
  assert.ok((done.files ?? []).some((f) => f.path === "one.txt"), JSON.stringify(done.files));
  // One hand-off, one line for it, and a fresh session of the new agent's own.
  assert.equal(done.handoffs.length, 1);
  assert.deepEqual([done.handoffs[0]!.from, done.handoffs[0]!.to, done.handoffs[0]!.reason, done.handoffs[0]!.fromAttemptId], [from, to, "owner", fromAttempt]);
  assert.notEqual(done.attemptId, fromAttempt);
  // One transcript, both agents: the session the move left and the new agent's, the new one opening with the hand-off note.
  const before = await getJson<{ events: { type: string; payload: Record<string, unknown> }[] }>(live, `/api/attempts/${fromAttempt}/events`);
  const after = await getJson<{ events: { type: string; payload: Record<string, unknown> }[] }>(live, `/api/attempts/${done.attemptId}/events`);
  assert.ok(before.events.some((e) => e.type === "tool_call" || e.type === "text"), "the first agent's session is there");
  const firstPrompt = after.events.find((e) => e.type === "user_prompt")?.payload.text;
  assert.match(String(firstPrompt), /^\[From Botbench, not from the owner\] An earlier attempt at this task by (Claude Code|Codex) stopped/);
  const sessionOf = (e: { payload: Record<string, unknown> }) => (e.payload.type === "session_started" ? String(e.payload.resumeCursor) : null);
  const cursors = [...before.events, ...after.events].map(sessionOf).filter((c): c is string => c !== null);
  assert.equal(new Set(cursors).size, cursors.length, `no session is shared across agents: ${JSON.stringify(cursors)}`);
}

test("live: a real task started on Claude Code (Haiku) is moved to Codex mid-build from the task flow, and finishes Ready for review on one branch with one transcript showing both agents", { timeout: TIMEOUT }, (t) => moveMidBuild(t, "claude-code", "codex"));

test("live: the same in the reverse direction, from Codex to Claude Code (Haiku)", { timeout: TIMEOUT }, (t) => moveMidBuild(t, "codex", "claude-code"));
