import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Answer } from "../../src/approvals/broker.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import type { Config } from "../../src/config.ts";
import { createTask, moveTask } from "../../src/engine/task.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// Standing permissions over HTTP: a real server, a real store and a real worktree. No test in this file starts a
// driver: the requests are put to the server's own broker the way an attempt's CLI puts them, and everything the
// owner does goes through the routes.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: SmeltServer;
  dir: string;
  repo: string;
  base: string;
  headers: Record<string, string>;
  taskId: number;
  /** Put one shell command to the gate as the CLI does: the pre-tool hook first, then the CLI's own request. */
  ask(command: string, toolCallId: string): Promise<{ answer: Promise<Answer> }>;
}

async function start(t: T, offerStandingAfter?: number, preapproved?: string[]): Promise<Api> {
  const dir = tempDir("smelt-standing-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, ...(offerStandingAfter === undefined ? {} : { autonomy: { offerStandingAfter } }) };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();

  const repo = path.join(dir, "repo");
  initRepo(repo);
  const task = createTask(server.db, { repo, prompt: "run the marker script", ...(preapproved ? { preapproved } : {}) });
  const worktree = await createWorktree({ repo, home, run: "run-00000001", task: `task-${task.id}` });
  const attemptId = Number(server.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  moveTask(server.db, task.id, "building", { worktree, attemptId });
  const admission = server.broker.admit({ taskId: task.id, role: "implementer", worktree: worktree.path });
  admission.bind(attemptId);
  const real = fs.realpathSync(worktree.path);
  const ask: Api["ask"] = async (command, toolCallId) => {
    await askBroker(admission.socketPath, admission.secret, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: toolCallId, cwd: real });
    return { answer: server.broker.request({ taskId: task.id, attemptId, role: "implementer", tool: "Bash", command, input: { command }, reason: null, toolCallId }) };
  };
  return { server, dir, repo, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! }, taskId: task.id, ask };
}

type Reply = { status: number; body: Record<string, unknown> };
async function get(api: Api, route: string, headers = api.headers): Promise<Reply> {
  const res = await fetch(`${api.base}${route}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function post(api: Api, route: string, body: unknown, headers = api.headers): Promise<Reply> {
  const res = await fetch(`${api.base}${route}`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Card = Record<string, unknown> & { id: number };
const pendingCards = async (api: Api): Promise<Card[]> => (await get(api, "/api/approvals?status=pending")).body.approvals as Card[];
const cardFor = async (api: Api, toolCallId: string): Promise<Card> => {
  const found = (await pendingCards(api)).find((a) => a.toolCallId === toolCallId);
  assert.ok(found, `${toolCallId} waits for the owner`);
  return found;
};
/** Ask and allow through the route, as the owner does from a card. */
async function allow(api: Api, command: string, toolCallId: string): Promise<Card> {
  const { answer } = await api.ask(command, toolCallId);
  const shown = await cardFor(api, toolCallId);
  assert.equal((await post(api, `/api/approvals/${shown.id}`, { decision: "allow" })).status, 200);
  assert.equal((await answer).decision, "allow");
  return shown;
}
const settled = async (answer: Promise<Answer>): Promise<boolean> => {
  let done = false;
  void answer.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
};
const count = (api: Api, table: string): number => Number(api.server.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
const grantsOf = async (api: Api): Promise<Record<string, unknown>[]> => (await get(api, "/api/grants")).body.grants as Record<string, unknown>[];

test("every standing-permission route needs a session: without one nothing is listed, granted or taken back", async (t) => {
  const api = await start(t, 1);
  await allow(api, "npm test", "toolu_1");
  const second = await api.ask("npm test", "toolu_2");
  const eligible = await cardFor(api, "toolu_2");
  assert.ok(eligible.standingOffer, "the card is eligible");

  for (const without of [{}, { cookie: "smelt_session=not-a-session" }] as Record<string, string>[]) {
    for (const route of ["/api/grants", "/api/action-log?limit=2", "/api/action-log?before=5&limit=2"]) assert.deepEqual(await get(api, route, without), { status: 401, body: { error: "sign in required" } }, route);
    assert.deepEqual(await post(api, `/api/approvals/${eligible.id}`, { decision: "allow", standing: true }, without), { status: 401, body: { error: "sign in required" } });
    assert.deepEqual(await post(api, "/api/grants/1/revoke", {}, without), { status: 401, body: { error: "sign in required" } });
  }
  assert.equal(count(api, "grants"), 0);
  assert.equal(await settled(second.answer), false, "nothing was answered");

  // With the session the grant is made; without it, it cannot be taken back.
  assert.equal((await post(api, `/api/approvals/${eligible.id}`, { decision: "allow", standing: true })).status, 200);
  await second.answer;
  assert.deepEqual(await post(api, "/api/grants/1/revoke", {}, {}), { status: 401, body: { error: "sign in required" } });
  assert.equal(count(api, "grant_revocations"), 0);
  assert.equal((await grantsOf(api)).length, 1);
  // A write that is not JSON is refused before it is read, as every write is.
  const form = await fetch(`${api.base}/api/grants/1/revoke`, { method: "POST", headers: { ...api.headers, "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415);
  await form.arrayBuffer();
  assert.equal(count(api, "grant_revocations"), 0);
});

test("AE5 over HTTP: the fourth card carries the offer with its scope; granting needs the card to be pending and eligible, answers it, lists the grant, and the fifth request runs on it", async (t) => {
  const api = await start(t);
  assert.deepEqual((await get(api, "/api/grants")).body, { grants: [], offerStandingAfter: 3 });

  // The first card offers nothing, and the flag alone grants nothing.
  const first = await api.ask("sh make-marker.sh", "toolu_1");
  const one = await cardFor(api, "toolu_1");
  assert.equal("standingOffer" in one, false);
  const refused = await post(api, `/api/approvals/${one.id}`, { decision: "allow", standing: true });
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /Always allow is not available for this request/);
  assert.equal(count(api, "grants"), 0);
  assert.equal(await settled(first.answer), false, "a refused grant is not an allow either");
  assert.deepEqual((await pendingCards(api)).map((a) => a.id), [one.id]);
  assert.deepEqual(((await get(api, "/api/action-log")).body.entries as Record<string, unknown>[]).map((e) => e.rule), ["asked_owner"]);
  // A flag that is not a yes or no, or that comes with a decline, is malformed.
  for (const bad of [{ decision: "allow", standing: "true" }, { decision: "allow", standing: 1 }, { decision: "allow", standing: null }, { decision: "decline", standing: true }, { decision: "allow", standing: true, note: 7 }, { decision: "allow", standing: true, note: "a note that would be dropped" }]) {
    assert.equal((await post(api, `/api/approvals/${one.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(await settled(first.answer), false);
  // `standing: false` is an ordinary answer.
  assert.equal((await post(api, `/api/approvals/${one.id}`, { decision: "allow", standing: false })).status, 200);
  await first.answer;
  for (const id of ["toolu_2", "toolu_3"]) assert.equal("standingOffer" in (await allow(api, "sh make-marker.sh", id)), false, id);

  // The fourth card: eligible, with the scope the grant will have.
  const fourth = await api.ask("sh make-marker.sh", "toolu_4");
  const four = await cardFor(api, "toolu_4");
  assert.deepEqual(four.standingOffer, { command: "sh make-marker.sh", repo: api.repo, cwd: ".", role: "implementer", approvals: 3 });
  // The offer is on the pending card only.
  assert.equal(((await get(api, "/api/approvals")).body.approvals as Card[]).filter((a) => "standingOffer" in a).length, 1);

  const granted = await post(api, `/api/approvals/${four.id}`, { decision: "allow", standing: true });
  assert.equal(granted.status, 200);
  assert.equal((granted.body.approval as Record<string, unknown>).status, "allowed");
  const grant = granted.body.grant as Record<string, unknown>;
  assert.deepEqual({ ...grant, grantedAt: "" }, { id: 1, role: "implementer", repo: api.repo, cwd: ".", command: "sh make-marker.sh", taskId: api.taskId, grantedAt: "", timesUsed: 0, lastUsedAt: null });
  assert.deepEqual(await fourth.answer, { decision: "allow", note: null, approvalId: four.id, refused: null });
  assert.deepEqual(await grantsOf(api), [grant]);
  // A second answer of any kind to that card: 409, and still one grant.
  for (const body of [{ decision: "allow", standing: true }, { decision: "allow" }, { decision: "decline" }]) assert.equal((await post(api, `/api/approvals/${four.id}`, body)).status, 409);
  assert.equal((await post(api, "/api/approvals/4242", { decision: "allow", standing: true })).status, 404);
  assert.equal(count(api, "grants"), 1);

  // The fifth request creates no approval and is logged with the rule and the grant.
  const approvalsBefore = count(api, "approvals");
  assert.deepEqual(await (await api.ask("sh make-marker.sh", "toolu_5")).answer, { decision: "allow", note: null, approvalId: null, refused: null, standing: { grantId: 1 } });
  assert.equal(count(api, "approvals"), approvalsBefore);
  assert.deepEqual(await pendingCards(api), []);
  const log = (await get(api, `/api/action-log?taskId=${api.taskId}`)).body.entries as Record<string, unknown>[];
  assert.deepEqual(log.slice(-4).map((e) => [e.rule, e.approvalId, e.grantId, e.command]), [
    ["asked_owner", four.id, null, "sh make-marker.sh"],
    ["owner_allowed", four.id, null, "sh make-marker.sh"],
    ["standing_granted", four.id, 1, "sh make-marker.sh"],
    ["standing", null, 1, "sh make-marker.sh"],
  ]);
  const listed = (await grantsOf(api))[0]!;
  assert.deepEqual([listed.timesUsed, listed.lastUsedAt], [1, log.at(-1)!.ts]);
});

test("taking back: an unknown grant is 404, a run's pre-approved grant is 404, a second time is 409, and the next request waits for the owner again", async (t) => {
  const api = await start(t, 1, ["npm run build"]);
  await allow(api, "sh make-marker.sh", "toolu_1");
  const second = await api.ask("sh make-marker.sh", "toolu_2");
  const granted = await post(api, `/api/approvals/${(await cardFor(api, "toolu_2")).id}`, { decision: "allow", standing: true });
  await second.answer;
  const grantId = (granted.body.grant as { id: number }).id;
  const preapproved = Number(api.server.db.prepare("SELECT id FROM grants WHERE kind = 'preapproved'").get()!.id);
  assert.notEqual(grantId, preapproved);

  for (const id of [4242, preapproved]) {
    const res = await post(api, `/api/grants/${id}/revoke`, {});
    assert.equal(res.status, 404, String(id));
    assert.match(String(res.body.error), /no such always-allowed command/);
  }
  for (const address of ["/api/grants/0/revoke", "/api/grants/abc/revoke", "/api/grants/-1/revoke", `/api/grants/${grantId}`, `/api/grants/${grantId}/revoke/again`]) assert.equal((await post(api, address, {})).status, 404, address);
  assert.equal((await get(api, `/api/grants/${grantId}/revoke`)).status, 404, "taking back is a write");
  assert.equal(count(api, "grant_revocations"), 0);
  assert.ok((await (await api.ask("sh make-marker.sh", "toolu_3")).answer).standing, "still granted after every refused request");

  const revoked = await post(api, `/api/grants/${grantId}/revoke`, {});
  assert.deepEqual([revoked.status, (revoked.body.revoked as { id: number }).id], [200, grantId]);
  assert.deepEqual(await grantsOf(api), []);
  const again = await post(api, `/api/grants/${grantId}/revoke`, {});
  assert.equal(again.status, 409);
  assert.match(String(again.body.error), /already/);
  assert.equal(count(api, "grant_revocations"), 1);

  // The very next request is a card.
  const fourth = await api.ask("sh make-marker.sh", "toolu_4");
  assert.equal(await settled(fourth.answer), false);
  const card = await cardFor(api, "toolu_4");
  assert.equal("standingOffer" in card, false, "what was taken back is earned again");
  assert.equal((await post(api, `/api/approvals/${card.id}`, { decision: "allow", standing: true })).status, 409);
  assert.equal((await post(api, `/api/approvals/${card.id}`, { decision: "decline" })).status, 200);
  // The run's own pre-approved command was never touched.
  assert.ok((await (await api.ask("npm run build", "toolu_5")).answer).preapproved);
  const rules = ((await get(api, "/api/action-log")).body.entries as Record<string, unknown>[]).map((e) => e.rule);
  assert.deepEqual(rules.slice(-5), ["standing", "standing_revoked", "asked_owner", "owner_declined", "preapproved"]);
});

test("the action log is read newest first in pages that neither overlap nor shift when entries are added", async (t) => {
  const api = await start(t);
  for (const id of ["toolu_1", "toolu_2", "toolu_3", "toolu_4"]) await allow(api, "sh make-marker.sh", id);
  const all = (await get(api, "/api/action-log")).body.entries as { id: number; rule: string }[];
  assert.deepEqual(all.map((e) => e.id), [1, 2, 3, 4, 5, 6, 7, 8], "without paging: everything, oldest first, as before");

  const first = (await get(api, "/api/action-log?limit=3")).body as { entries: { id: number }[]; older: boolean };
  assert.deepEqual([first.entries.map((e) => e.id), first.older], [[8, 7, 6], true]);
  // More is written between two reads: the page after the first is still the one that follows it.
  await allow(api, "sh make-marker.sh", "toolu_5");
  const second = (await get(api, "/api/action-log?before=6&limit=3")).body as { entries: { id: number }[]; older: boolean };
  assert.deepEqual([second.entries.map((e) => e.id), second.older], [[5, 4, 3], true]);
  const third = (await get(api, "/api/action-log?before=3&limit=3")).body as { entries: { id: number }[]; older: boolean };
  assert.deepEqual([third.entries.map((e) => e.id), third.older], [[2, 1], false]);
  assert.deepEqual((await get(api, "/api/action-log?before=1&limit=3")).body, { entries: [], older: false });
  // A page that ends exactly at the oldest entry says nothing older is left.
  const exact = (await get(api, "/api/action-log?before=4&limit=3")).body as { entries: { id: number }[]; older: boolean };
  assert.deepEqual([exact.entries.map((e) => e.id), exact.older], [[3, 2, 1], false]);
  // `before` alone takes the default page; an entry is what the unpaged route gives for it.
  const whole = (await get(api, "/api/action-log?before=9")).body as { entries: { id: number }[]; older: boolean };
  assert.deepEqual([whole.entries.map((e) => e.id), whole.older], [[8, 7, 6, 5, 4, 3, 2, 1], false]);
  assert.deepEqual(whole.entries.slice().reverse(), all);
  // With a task: that task's entries only.
  const other = createTask(api.server.db, { repo: api.repo, prompt: "another" });
  api.server.db.prepare("INSERT INTO action_log (ts, task_id, rule, tool, command, cwd) VALUES ('t', ?, 'broker_failure_denied', 'Bash', 'x', '.')").run(other.id);
  assert.deepEqual(((await get(api, `/api/action-log?taskId=${other.id}&limit=5`)).body.entries as { id: number }[]).map((e) => e.id), [11]);
  assert.deepEqual(((await get(api, `/api/action-log?taskId=${api.taskId}&limit=2`)).body.entries as { id: number }[]).map((e) => e.id), [10, 9]);

  for (const bad of ["limit=0", "limit=-1", "limit=abc", "limit=1.5", "limit=201", "limit=", "limit=3&limit=4", "before=0", "before=abc", "before=-3", "before=", "before=2&before=3", "before=99999999999999999999"]) {
    const res = await get(api, `/api/action-log?${bad}`);
    assert.equal(res.status, 400, bad);
    assert.match(String(res.body.error), /"limit"|"before"/, bad);
  }
  assert.equal(((await get(api, "/api/action-log?limit=200")).body.entries as unknown[]).length, 11);
});

test("the configured number reaches the running broker and is what the grants route reports", async (t) => {
  const api = await start(t, 2);
  assert.equal((await get(api, "/api/grants")).body.offerStandingAfter, 2);
  assert.equal("standingOffer" in (await allow(api, "sh make-marker.sh", "toolu_1")), false);
  assert.equal("standingOffer" in (await allow(api, "sh make-marker.sh", "toolu_2")), false);
  assert.deepEqual((await allow(api, "sh make-marker.sh", "toolu_3")).standingOffer, { command: "sh make-marker.sh", repo: api.repo, cwd: ".", role: "implementer", approvals: 2 });
});
