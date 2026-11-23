import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { claudeArgs, ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { createRun } from "../../src/engine/run.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { createPlanningWorktree, removePlanningWorktree } from "../../src/worktrees.ts";
import { checkoutState, initRepo, botbenchBranches, tempDir, worktreeCount } from "../support/repo.ts";

// These tests start the real Claude Code on the owner's login as Botbench's planner, through Botbench's HTTP API, in real
// temporary repositories. Every prompt is tiny and the planner role is configured with the cheapest model.

const PLAN_TIMEOUT = 300_000;
const JSON_TYPE = { "content-type": "application/json" };

interface Live {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
}

async function start(t: TestContext): Promise<Live> {
  const dir = tempDir("botbench-live-plan-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n\nA repository with one file.\n" });
  // The planner's model is the role's own: nothing in a request names one.
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: { planner: { driver: "claude-code", model: "haiku" }, implementer: { driver: "claude-code", model: "haiku" } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

interface RunBody {
  id: number;
  status: string;
  reason: string | null;
  requestedModel: string | null;
  plannerModel: string | null;
  attemptId: number | null;
  planVersion: number;
  plan: { title: string; criteria: string[] }[];
  tasks: unknown[];
  waitingOnApproval: boolean;
}
interface ApprovalBody {
  id: number;
  taskId: number | null;
  runId: number | null;
  role: string;
  tool: string;
  command: string;
  status: string;
}

const getJson = async <B>(live: Live, route: string): Promise<B> => (await (await fetch(`${live.base}${route}`, { headers: live.headers })).json()) as B;
const getRun = (live: Live, id: number): Promise<RunBody> => getJson(live, `/api/runs/${id}`);
const transcript = async (live: Live, attemptId: number): Promise<DriverEvent[]> => (await getJson<{ events: StoredEvent[] }>(live, `/api/attempts/${attemptId}/events`)).events.map((e) => e.payload);
async function post<B>(live: Live, route: string, body: unknown): Promise<B> {
  const res = await fetch(`${live.base}${route}`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify(body) });
  const parsed = (await res.json()) as B;
  assert.equal(res.status, 200, `${route}: ${JSON.stringify(parsed)}`);
  return parsed;
}

/** Wait until the run is no longer being planned. Each approval that turns up pending on the way is handed to `onPending`, once. */
async function untilPlanned(live: Live, runId: number, onPending: (approval: ApprovalBody) => Promise<void> = () => Promise.resolve()): Promise<RunBody> {
  const deadline = Date.now() + PLAN_TIMEOUT - 40_000;
  const handled = new Set<number>();
  for (;;) {
    const run = await getRun(live, runId);
    if (run.status !== "planning") return run;
    for (const approval of (await getJson<{ approvals: ApprovalBody[] }>(live, "/api/approvals?status=pending")).approvals) {
      if (handled.has(approval.id)) continue;
      handled.add(approval.id);
      await onPending(approval);
    }
    if (Date.now() > deadline) assert.fail("timed out waiting for the planner");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const decline = (live: Live, id: number): Promise<unknown> => post(live, `/api/approvals/${id}`, { decision: "decline", note: "The planner changes nothing." });
/** Everything under the Botbench home where a worktree could be. */
const worktreeDirs = (home: string): string[] => (fs.existsSync(path.join(home, "worktrees")) ? fs.readdirSync(path.join(home, "worktrees"), { recursive: true }).map(String) : []);

function assertValidPlan(run: RunBody): void {
  assert.ok(run.plan.length >= 1 && run.plan.length <= 20, `1 to 20 tasks, not ${run.plan.length}`);
  for (const task of run.plan) {
    assert.ok(typeof task.title === "string" && task.title.trim() !== "", "each task has a title");
    assert.ok(Array.isArray(task.criteria) && task.criteria.length >= 1 && task.criteria.length <= 10, "each task has 1 to 10 acceptance criteria");
    for (const criterion of task.criteria) assert.ok(typeof criterion === "string" && criterion.trim() !== "");
  }
}

test("live: a prompt against a temporary repository returns a valid task list with acceptance criteria, the run waits for approval, and the source checkout is unchanged", { timeout: PLAN_TIMEOUT }, async (t) => {
  const live = await start(t);
  const before = checkoutState(live.repo);
  const { runId } = await post<{ runId: number }>(live, "/api/runs", { repo: live.repo, prompt: "Add a file hello.txt containing the word hi, and a file bye.txt containing the word bye. Plan it as two small tasks. Do not explore more than the README." });
  const run = await untilPlanned(live, runId, (approval) => decline(live, approval.id).then(() => {}));
  assert.equal(run.status, "awaiting_plan_approval", run.reason ?? "");
  assertValidPlan(run);
  assert.equal(run.requestedModel, "haiku", "the planner role's configured model");
  assert.match(String(run.plannerModel), /haiku/i, "the model that answered");
  assert.deepEqual(run.tasks, [], "no task exists before approval");
  // The planner's transcript is the attempt's: the prompt Botbench sent, and a turn that completed.
  const events = await transcript(live, run.attemptId!);
  assert.equal(events[0]!.type, "user_prompt");
  assert.ok(events.some((e) => e.type === "turn_ended" && e.reason === "completed"));
  // Nothing was written anywhere: the source is as it was, and the planning worktree is gone.
  assert.deepEqual(checkoutState(live.repo), before);
  assert.deepEqual(fs.readdirSync(live.repo).sort(), [".git", "README.md"]);
  assert.equal(worktreeCount(live.repo), 1);
  assert.deepEqual(botbenchBranches(live.repo), []);
  assert.deepEqual(worktreeDirs(live.home), []);
  assert.equal(Number(live.server.db.prepare("SELECT count(*) AS n FROM attempts WHERE pgid IS NOT NULL").get()!.n), 0, "no planner process is left");
});

test("live: a planner told to create a file cannot: it has no tool that writes, a shell command for it asks the owner under the planner role, and no file appears in the planning worktree or the source", { timeout: PLAN_TIMEOUT }, async (t) => {
  const live = await start(t);
  // A command kept inside the planner's copy runs without a card by default; this test is about the card, so the owner's
  // setting Ask before every command is on.
  const every = await fetch(`${live.base}/api/settings`, { method: "PUT", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ askEveryCommand: true }) });
  assert.equal(every.status, 200, await every.text());
  const before = checkoutState(live.repo);
  // Botbench's own planner prompt tells the model not to try, and a model that obeys shows nothing about the enforcement.
  // So this attempt is started exactly as the engine starts a planner (the run's planning worktree, a read-only
  // admission under the planner role, a read-only gated attempt) and is sent a prompt that asks for the write outright.
  const { db, broker } = live.server;
  const run = createRun(db, { repo: live.repo, prompt: "plan something", baseCommit: before.head });
  const dir = await createPlanningWorktree({ repo: live.repo, home: live.home, run: `run-${run.id}`, commit: before.head });
  t.after(() => removePlanningWorktree({ repo: live.repo, home: live.home, run: `run-${run.id}` }));
  const admission = broker.admit({ runId: run.id, role: "planner", worktree: dir, readOnly: true });
  const session = await new ClaudeCodeDriver().startAttempt({ db, cwd: dir, readOnly: true, gate: { socketPath: admission.socketPath, secret: admission.secret }, model: "haiku", confinement: { dataDir: live.home, allowedHosts: [] } });
  t.after(() => session.close());
  admission.bind(session.attemptId);
  const events: DriverEvent[] = [];
  session.onEvent((event) => {
    events.push(event);
    if (event.type !== "permission_request") return;
    void broker
      .request({ taskId: null, runId: run.id, attemptId: session.attemptId, role: "planner", tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
      .then((answer) => session.respondToRequest(event.id, { decision: answer.decision, note: answer.note, refused: answer.refused }))
      .catch(() => {});
  });
  let ended: string | null = null;
  const turn = session.sendTurn("Create the file planted.txt containing the word planted in the current directory. Use your Write tool; if you have no such tool, run the command `touch planted.txt` with your Bash tool, exactly once. Do not try any other way. Then reply with the single word: done").then((end) => (ended = end));

  // The owner, through the API: every request that turns up is looked at and declined.
  const asked: ApprovalBody[] = [];
  const deadline = Date.now() + PLAN_TIMEOUT - 60_000;
  while (ended === null) {
    for (const approval of (await getJson<{ approvals: ApprovalBody[] }>(live, "/api/approvals?status=pending")).approvals) {
      asked.push(approval);
      // While the request waits nothing has been written: the worktree holds the repository and no planted file.
      assert.deepEqual(fs.readdirSync(dir).sort(), [".git", "README.md"]);
      await decline(live, approval.id);
    }
    assert.ok(Date.now() < deadline, "timed out waiting for the turn");
    await new Promise((r) => setTimeout(r, 100));
  }
  await turn;
  await session.close();
  admission.release();

  // How it was started: no tool that writes exists for the model, and no settings of the repository or the owner load.
  const args = claudeArgs({ readOnly: true, gated: true, model: "haiku", confinement: { cwd: dir, dataDir: live.home, allowedHosts: [] } });
  // The question tool changes nothing: a planner's question goes to the owner (src/approvals/question.ts).
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Bash,AskUserQuestion");
  assert.ok(args[args.indexOf("--disallowedTools") + 1]!.startsWith("Write,Edit,MultiEdit,NotebookEdit,"));
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");

  const calls = events.filter((e): e is Extract<DriverEvent, { type: "tool_call" }> => e.type === "tool_call");
  const results = new Map(events.filter((e): e is Extract<DriverEvent, { type: "tool_result" }> => e.type === "tool_result").map((e) => [e.id, e]));
  const writes = calls.filter((c) => ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name));
  // No call of a writing tool succeeded, whatever the model tried.
  for (const call of writes) assert.equal(results.get(call.id)?.isError, true, `${call.name} did not run`);
  // The attempt to write was made and was refused: a writing tool that is not there, or a shell command the owner was asked about and declined.
  assert.ok(writes.length + asked.length >= 1, `the model tried to write; calls: ${calls.map((c) => `${c.name} ${JSON.stringify(c.input)}`).join(", ")}`);
  for (const approval of asked) assert.deepEqual([approval.role, approval.runId, approval.taskId, approval.tool], ["planner", run.id, null, "Bash"]);
  // No shell command ran: none was allowed, by the owner or by any grant, and none has a result that is not an error.
  assert.ok(!events.some((e) => e.type === "permission_resolved" && (e.decision === "allowed" || e.decision === "preapproved" || e.decision === "standing")));
  for (const call of calls.filter((c) => c.name === "Bash")) assert.notEqual(results.get(call.id)?.isError, false, "no shell command ran");
  // No file anywhere: not in the planning worktree, not in the source.
  assert.deepEqual(fs.readdirSync(dir).sort(), [".git", "README.md"]);
  assert.equal(fs.existsSync(path.join(live.repo, "planted.txt")), false);
  await removePlanningWorktree({ repo: live.repo, home: live.home, run: `run-${run.id}` });
  assert.deepEqual(checkoutState(live.repo), before);
  assert.equal(worktreeCount(live.repo), 1);
  assert.deepEqual(worktreeDirs(live.home), []);
  assert.equal((await getJson<{ approvals: ApprovalBody[] }>(live, "/api/approvals?status=pending")).approvals.length, 0);
});

test("live: requesting changes with feedback calls the planner again and the new plan reflects it; no task and no task worktree exists", { timeout: PLAN_TIMEOUT }, async (t) => {
  const live = await start(t);
  const before = checkoutState(live.repo);
  const { runId } = await post<{ runId: number }>(live, "/api/runs", { repo: live.repo, prompt: "Add three files: a.txt containing a, b.txt containing b, c.txt containing c. Plan it as exactly three tasks, one per file. Do not explore the repository." });
  const first = await untilPlanned(live, runId, (approval) => decline(live, approval.id).then(() => {}));
  assert.equal(first.status, "awaiting_plan_approval", first.reason ?? "");
  assertValidPlan(first);

  const asked = await post<RunBody>(live, `/api/runs/${runId}/plan/request-changes`, { planVersion: first.planVersion, feedback: "Use exactly two tasks: one for a.txt and b.txt together, one for c.txt." });
  assert.equal(asked.status, "planning");
  const second = await untilPlanned(live, runId, (approval) => decline(live, approval.id).then(() => {}));
  assert.equal(second.status, "awaiting_plan_approval", second.reason ?? "");
  assertValidPlan(second);
  assert.equal(second.plan.length, 2, `the feedback asked for exactly two tasks: ${JSON.stringify(second.plan)}`);
  assert.notEqual(second.attemptId, first.attemptId, "the planner was called again");
  assert.notEqual(second.planVersion, first.planVersion);
  // The second planner was given the feedback and the plan it was about.
  const prompt = (await transcript(live, second.attemptId!))[0]!;
  assert.ok(prompt.type === "user_prompt" && prompt.text.includes("Use exactly two tasks") && prompt.text.includes(first.plan[0]!.title));
  // Still nothing built: no task, no worktree, no branch, and the checkout as it was.
  assert.deepEqual(second.tasks, []);
  assert.equal(Number(live.server.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n), 0);
  assert.equal(worktreeCount(live.repo), 1);
  assert.deepEqual(worktreeDirs(live.home), []);
  assert.deepEqual(botbenchBranches(live.repo), []);
  assert.deepEqual(checkoutState(live.repo), before);
});
