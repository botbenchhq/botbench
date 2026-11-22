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

// This test starts the real Claude Code on the owner's login, through Botbench's HTTP API, in one real temporary
// repository, and answers its permission requests the way the client does: it earns a standing permission, uses it,
// and takes it back. Four tiny turns on the cheapest model.

const TEST_TIMEOUT = 600_000;
const TASK_LIMIT = 150_000;
const JSON_TYPE = { "content-type": "application/json" };
const COMMAND = "sh make-marker.sh";
const MARKER_SCRIPT = '#!/bin/sh\necho ran >> "$(dirname "$0")/marker.txt"\n';
const ONCE = `Run the command \`${COMMAND}\` with your Bash tool, exactly once. Then reply with the single word: done`;
const TWICE = `Run the command \`${COMMAND}\` with your Bash tool. When it has finished, run the very same command a second time, as a second, separate tool call. Never put both in one command. Then reply with the single word: done`;

interface Live {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  repo: string;
}

async function start(t: TestContext): Promise<Live> {
  const dir = tempDir("botbench-live-standing-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } }, autonomy: { offerStandingAfter: 3 } };
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
}
interface Offer {
  command: string;
  repo: string;
  cwd: string;
  role: string;
  approvals: number;
}
interface ApprovalBody {
  id: number;
  taskId: number;
  tool: string;
  command: string;
  cwd: string;
  status: string;
  toolCallId: string;
  standingOffer?: Offer;
}
interface LogBody {
  id: number;
  rule: string;
  approvalId: number | null;
  grantId: number | null;
  command: string;
  cwd: string;
}
interface GrantBody {
  id: number;
  role: string;
  repo: string;
  cwd: string;
  command: string;
  taskId: number | null;
  timesUsed: number;
  lastUsedAt: string | null;
}

const getJson = async <B>(live: Live, route: string): Promise<B> => (await (await fetch(`${live.base}${route}`, { headers: live.headers })).json()) as B;
const post = async (live: Live, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${live.base}${route}`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const approvals = async (live: Live, status?: string): Promise<ApprovalBody[]> => (await getJson<{ approvals: ApprovalBody[] }>(live, `/api/approvals${status ? `?status=${status}` : ""}`)).approvals;
const actionLog = async (live: Live, taskId: number): Promise<LogBody[]> => (await getJson<{ entries: LogBody[] }>(live, `/api/action-log?taskId=${taskId}`)).entries;
const grants = async (live: Live): Promise<GrantBody[]> => (await getJson<{ grants: GrantBody[] }>(live, "/api/grants")).grants;
const transcript = async (live: Live, attemptId: number): Promise<DriverEvent[]> => (await getJson<{ events: StoredEvent[] }>(live, `/api/attempts/${attemptId}/events`)).events.map((e) => e.payload);
const worktreeOf = (live: Live, task: TaskBody): string => path.join(live.home, "worktrees", task.branch!.split("/")[1]!, `task-${task.id}`);

/**
 * Start a task and answer each card it raises the way `decide` says, one at a time, until the task ends.
 * Returns the task and the cards as they were when the owner looked at them.
 */
async function run(live: Live, prompt: string, decide: (card: ApprovalBody) => { decision: "allow" | "decline"; standing?: true }): Promise<{ task: TaskBody; cards: ApprovalBody[] }> {
  const started = await post(live, "/api/tasks", { repo: live.repo, prompt });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const taskId = started.body.taskId as number;
  const cards: ApprovalBody[] = [];
  const deadline = Date.now() + TASK_LIMIT;
  for (;;) {
    const task = await getJson<TaskBody>(live, `/api/tasks/${taskId}`);
    if (task.status !== "queued" && task.status !== "building") return { task, cards };
    // The oldest card only, read afresh: what it offers depends on what was answered before it.
    const [card] = await approvals(live, "pending");
    if (card) {
      cards.push(card);
      const answered = await post(live, `/api/approvals/${card.id}`, decide(card));
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
    }
    if (Date.now() > deadline) assert.fail(`timed out waiting for task ${taskId} to end`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const shown = (cards: ApprovalBody[]): unknown[] => cards.map((c) => [c.tool, c.command, c.cwd, c.standingOffer?.approvals ?? null]);

test("live: the marker script is approved three times across two tasks; the fourth card offers standing permission and it is granted; a later task runs the script with no approval and the log says `standing`; taken back, the next request is a card again", { timeout: TEST_TIMEOUT }, async (t) => {
  const live = await start(t);
  const before = checkoutState(live.repo);
  const allow = (): { decision: "allow" } => ({ decision: "allow" });
  // Before any turn is spent: nothing is granted, and the number that earns an offer is the configured one.
  assert.deepEqual(await getJson(live, "/api/grants"), { grants: [], offerStandingAfter: 3 });

  // Two approvals in a first task: neither card offers anything.
  const first = await run(live, TWICE, allow);
  assert.equal(first.task.status, "awaiting_decision", first.task.reason ?? "");
  assert.deepEqual(shown(first.cards), [["Bash", COMMAND, ".", null], ["Bash", COMMAND, ".", null]]);
  assert.deepEqual(await grants(live), []);

  // A second task, in its own worktree: the third approval, and then the fourth card offers. The owner grants.
  const second = await run(live, TWICE, (card) => (card.standingOffer ? { decision: "allow", standing: true } : { decision: "allow" }));
  assert.equal(second.task.status, "awaiting_decision", second.task.reason ?? "");
  assert.deepEqual(shown(second.cards), [["Bash", COMMAND, ".", null], ["Bash", COMMAND, ".", 3]]);
  assert.deepEqual(second.cards[1]!.standingOffer, { command: COMMAND, repo: live.repo, cwd: ".", role: "implementer", approvals: 3 });
  assert.notEqual(worktreeOf(live, first.task), worktreeOf(live, second.task));
  const [grant] = await grants(live);
  assert.deepEqual([grant!.role, grant!.repo, grant!.cwd, grant!.command, grant!.taskId, grant!.timesUsed, grant!.lastUsedAt], ["implementer", live.repo, ".", COMMAND, second.task.id, 0, null]);
  assert.deepEqual((await actionLog(live, second.task.id)).map((e) => [e.rule, e.grantId]), [["asked_owner", null], ["owner_allowed", null], ["asked_owner", null], ["owner_allowed", null], ["standing_granted", grant!.id]]);
  assert.equal(fs.readFileSync(path.join(worktreeOf(live, second.task), "marker.txt"), "utf8"), "ran\nran\n", "both runs of the second task ran");

  // A third task runs the script: no card, no approval row, and the log names the rule and the grant.
  const third = await run(live, ONCE, (card) => assert.fail(`a card was raised for a command with standing permission: ${card.tool} ${card.command}`));
  assert.equal(third.task.status, "awaiting_decision", third.task.reason ?? "");
  assert.equal((await approvals(live)).length, 4, "no approval was created");
  assert.deepEqual((await actionLog(live, third.task.id)).map((e) => [e.rule, e.approvalId, e.grantId, e.command, e.cwd]), [["standing", null, grant!.id, COMMAND, "."]]);
  assert.equal(fs.readFileSync(path.join(worktreeOf(live, third.task), "marker.txt"), "utf8"), "ran\n");
  const events = await transcript(live, third.task.attemptId!);
  const resolved = events.findIndex((e) => e.type === "permission_resolved");
  const event = events[resolved]!;
  assert.ok(event.type === "permission_resolved" && event.decision === "standing", JSON.stringify(event));
  const result = events.findIndex((e) => e.type === "tool_result" && e.id === event.toolCallId);
  assert.ok(result > resolved && !(events[result] as { isError: boolean }).isError, "the command ran after it was let through");
  assert.deepEqual((await grants(live)).map((g) => [g.id, g.timesUsed, typeof g.lastUsedAt]), [[grant!.id, 1, "string"]]);

  // Taken back: the list is empty, and the next request of a fourth task waits for the owner, with nothing offered.
  assert.equal((await post(live, `/api/grants/${grant!.id}/revoke`, {})).status, 200);
  assert.deepEqual(await grants(live), []);
  const fourth = await run(live, ONCE, () => ({ decision: "decline" }));
  assert.equal(fourth.task.status, "awaiting_decision", fourth.task.reason ?? "");
  assert.deepEqual(shown(fourth.cards), [["Bash", COMMAND, ".", null]]);
  assert.deepEqual((await actionLog(live, fourth.task.id)).map((e) => e.rule), ["asked_owner", "owner_declined"]);
  assert.equal(fs.existsSync(path.join(worktreeOf(live, fourth.task), "marker.txt")), false, "declined: it did not run");
  assert.deepEqual((await approvals(live)).map((a) => a.status), ["allowed", "allowed", "allowed", "allowed", "declined"]);
  assert.equal(fs.existsSync(path.join(live.repo, "marker.txt")), false, "nothing ran in the owner's checkout");
  assert.deepEqual(checkoutState(live.repo), before);
});
