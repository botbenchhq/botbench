import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, ApprovalError, CHAT_ROLE, createBroker, type Answer, type Approval, type ApprovalRequest, type Broker } from "../../src/approvals/broker.ts";
import { chatWebAccess, setChatWebAccess, type WebAccess } from "../../src/approvals/web-access.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { createTask } from "../../src/engine/task.ts";
import { approvalMessage } from "../../src/push.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// A chat's Claude Code goes through the same broker as a task's builder. No driver is started here: the broker, its
// socket, the store and the gate are the real ones, and each request is what the driver hands the broker for a
// permission prompt of the CLI. The replayed chat turn is in test/api/chat-approvals.test.ts.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  dir: string;
  home: string;
  scratch: string;
  broker: Broker;
  attemptId: number;
  secret: string;
  changes: Approval[];
}

async function rig(t: T): Promise<Rig> {
  const dir = tempDir("botbench-broker-chat-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const db = openStore(home);
  const scratch = path.join(home, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  db.prepare("INSERT INTO chat_attempts (attempt_id, round_id, created_at) VALUES (?, NULL, 'now')").run(attemptId);
  const changes: Approval[] = [];
  const broker = createBroker({ db, home, onChange: (approval) => changes.push(approval) });
  await broker.listen();
  t.after(async () => {
    await broker.close();
    db.close();
  });
  const admission = broker.admit({ chat: true, role: CHAT_ROLE, worktree: scratch, confined: true });
  admission.bind(attemptId);
  return { db, dir, home, scratch, broker, attemptId, secret: admission.secret, changes };
}

let calls = 0;
const ask = (r: Rig, tool: string, input: Record<string, unknown>, command: string, cwd = "."): Promise<Answer> =>
  r.broker.request({ taskId: null, chat: true, attemptId: r.attemptId, role: CHAT_ROLE, tool, command, input, cwd, reason: null, toolCallId: `toolu_chat_${++calls}` } as ApprovalRequest);

/** Whether a request is still waiting for the owner a moment after it was made. */
async function waits(answer: Promise<Answer>): Promise<boolean> {
  let settled = false;
  void answer.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return !settled;
}

const rules = (db: DatabaseSync): string[] => actionLog(db).map((e) => e.rule);
const FETCH = { url: "https://example.com", prompt: "What is the title?" };
const SEARCH = { query: "example domain" };

test("web access in chat is Allow unless the owner chose otherwise, and only the three values are kept", async (t) => {
  const r = await rig(t);
  assert.equal(chatWebAccess(r.db), "allow");
  for (const value of ["ask", "off", "allow"] as const) {
    setChatWebAccess(r.db, value);
    assert.equal(chatWebAccess(r.db), value);
  }
  assert.throws(() => setChatWebAccess(r.db, "always" as WebAccess));
  assert.throws(() => r.db.prepare("INSERT INTO owner_settings (name, value, updated_at) VALUES ('chat_web_access', 'yes', 'now') ON CONFLICT (name) DO UPDATE SET value = excluded.value").run());
});

test("chat gate, web access Allow: a fetch and a search run without a card and are logged under the setting", async (t) => {
  const r = await rig(t);
  const fetched = await ask(r, "WebFetch", FETCH, JSON.stringify(FETCH));
  const searched = await ask(r, "WebSearch", SEARCH, JSON.stringify(SEARCH));
  for (const answer of [fetched, searched]) assert.deepEqual(answer, { decision: "allow", note: null, approvalId: null, refused: null, web: true });
  assert.deepEqual(r.broker.pending(), []);
  const log = actionLog(r.db);
  assert.deepEqual(log.map((e) => [e.rule, e.tool, e.taskId, e.runId, e.attemptId]), [
    ["chat_web_access", "WebFetch", null, null, r.attemptId],
    ["chat_web_access", "WebSearch", null, null, r.attemptId],
  ]);
  assert.match(log[0]!.detail ?? "", /Web access is set to Allow/);
});

test("chat gate, web access Allow: a fetch of this Mac, the local network or anything but a public web address still asks", async (t) => {
  const r = await rig(t);
  const local = ["http://127.0.0.1:4780/api/approvals", "http://localhost:8080/", "http://[::1]/", "http://192.168.1.1/", "http://10.0.0.5/", "http://172.16.3.4/", "http://169.254.169.254/latest/meta-data", "http://printer.local/", "http://intranet/", "file:///etc/passwd", "ftp://example.com/x", "not a url", "http://0.0.0.0/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/"];
  for (const url of local) {
    const input = { url, prompt: "read it" };
    const answer = ask(r, "WebFetch", input, JSON.stringify(input));
    assert.equal(await waits(answer), true, url);
    const card = r.broker.pending().at(-1)!;
    assert.equal(card.asksBecause, "It reaches this Mac, your local network, or something that is not a public web page.", url);
    r.broker.answer(card.id, "decline");
    await answer;
  }
  // A public address runs.
  assert.equal((await ask(r, "WebFetch", FETCH, JSON.stringify(FETCH))).web, true);
});

test("chat gate, web access Ask: a fetch waits as a card for the chat, and the owner's allow lets it run", async (t) => {
  const r = await rig(t);
  setChatWebAccess(r.db, "ask");
  const answer = ask(r, "WebFetch", FETCH, JSON.stringify(FETCH));
  assert.equal(await waits(answer), true);
  const [card] = r.broker.pending();
  assert.ok(card);
  assert.deepEqual([card.chat, card.taskId, card.runId, card.attemptId, card.tool, card.outsideText, card.parkedAt], [true, null, null, r.attemptId, "WebFetch", false, null]);
  // The header's tray and the notification are told once, and the notification opens the chat.
  assert.deepEqual(r.changes.map((a) => [a.id, a.status]), [[card.id, "pending"]]);
  assert.deepEqual(approvalMessage(card), { title: "An approval is waiting", path: "/#/turn" });
  // A chat's request never offers standing permission: there is no chat-scoped grant in this unit.
  assert.equal(r.broker.standingOffer(card.id), null);
  assert.throws(() => r.broker.grantStanding(card.id), (err: unknown) => err instanceof ApprovalError && err.status === 409);
  r.broker.answer(card.id, "allow");
  assert.deepEqual(await answer, { decision: "allow", note: null, approvalId: card.id, refused: null });
  assert.deepEqual(rules(r.db), ["asked_owner", "owner_allowed"]);
});

test("chat gate, web access Ask: Deny, and Deny with what to do instead, reach Claude Code", async (t) => {
  const r = await rig(t);
  setChatWebAccess(r.db, "ask");
  const plain = ask(r, "WebSearch", SEARCH, JSON.stringify(SEARCH));
  r.broker.answer(r.broker.pending()[0]!.id, "decline");
  assert.deepEqual((await plain).decision, "decline");
  const noted = ask(r, "WebFetch", FETCH, JSON.stringify(FETCH));
  const id = r.broker.pending()[0]!.id;
  r.broker.answer(id, "decline", "answer from what you know");
  assert.deepEqual(await noted, { decision: "decline", note: "answer from what you know", approvalId: id, refused: null });
});

test("chat gate, web access Off: a fetch is refused without a card, saying where to turn it on", async (t) => {
  const r = await rig(t);
  setChatWebAccess(r.db, "off");
  const answer = await ask(r, "WebFetch", FETCH, JSON.stringify(FETCH));
  assert.equal(answer.decision, "decline");
  assert.match(answer.refused ?? "", /Web access is off.*Settings/);
  assert.deepEqual(r.broker.pending(), []);
  assert.deepEqual(rules(r.db), ["chat_web_access"]);
});

test("chat gate: unconfined or floor-listed commands, reads outside the chat's folder and other tools ask; reads and writes in the folder run", async (t) => {
  const r = await rig(t);
  const asked: [string, string | null, string | null][] = [];
  const expectAsk = async (tool: string, input: Record<string, unknown>, command: string): Promise<void> => {
    const answer = ask(r, tool, input, command);
    assert.equal(await waits(answer), true, `${tool} ${command} asks`);
    const card = r.broker.pending().at(-1)!;
    assert.equal(card.chat, true);
    asked.push([tool, card.asksBecause, card.target]);
    r.broker.answer(card.id, "decline");
    await answer;
  };
  await expectAsk("Bash", { command: "ls && git push origin HEAD" }, "ls && git push origin HEAD");
  await expectAsk("Bash", { command: "ls", dangerouslyDisableSandbox: true }, JSON.stringify({ command: "ls", dangerouslyDisableSandbox: true }));
  await expectAsk("Read", { file_path: "/etc/hosts" }, "/etc/hosts");
  await expectAsk("Write", { file_path: "/tmp/elsewhere.txt", content: "x" }, JSON.stringify({ file_path: "/tmp/elsewhere.txt", content: "x" }));
  await expectAsk("NotebookRead", { notebook_path: "x.ipynb" }, JSON.stringify({ notebook_path: "x.ipynb" }));
  assert.deepEqual(asked, [
    ["Bash", "On the always-ask list: it sends commits to another computer.", null],
    ["Bash", "It could not be shown to run kept away from your sign-ins and the network.", null],
    ["Read", "Outside the chat's folder.", "/etc/hosts"],
    ["Write", "Outside the chat's folder.", "/tmp/elsewhere.txt"],
    ["NotebookRead", "Botbench asks you each time NotebookRead is used.", null],
  ]);
  // Inside the chat's own folder a read and a write run, as they do in a task's copy.
  const inside = path.join(r.scratch, "notes.txt");
  assert.deepEqual(await ask(r, "Read", { file_path: inside }, inside), { decision: "allow", note: null, approvalId: null, refused: null, files: true });
  const write = { file_path: inside, content: "hi" };
  assert.deepEqual(await ask(r, "Write", write, JSON.stringify(write)), { decision: "allow", note: null, approvalId: null, refused: null, files: true });
  assert.match(actionLog(r.db).at(-1)!.detail ?? "", /chat's own folder/);
});

test("chat gate: a confined command runs without a card, as Claude Code's own would, chained or not, and is logged as a chat's", async (t) => {
  const r = await rig(t);
  const run = (input: Record<string, unknown>) => {
    const command = Object.keys(input).every((k) => k === "command" || k === "description") ? String(input.command) : JSON.stringify(input);
    return ask(r, "Bash", input, command);
  };
  for (const input of [{ command: "ls" }, { command: "ls -la && wc -l notes.txt", description: "List the folder" }, { command: "python3 -c 'print(1)'", timeout: 30000 }, { command: "sleep 1", run_in_background: true }]) {
    assert.deepEqual(await run(input), { decision: "allow", note: null, approvalId: null, refused: null, chat: true }, JSON.stringify(input));
  }
  assert.deepEqual(r.broker.pending(), []);
  const log = actionLog(r.db);
  assert.deepEqual(new Set(log.map((e) => [e.rule, e.taskId, e.runId].join())), new Set(["chat_confined,,"]));
  assert.match(log[0]!.detail ?? "", /chat/);
});

test("chat gate, the hook: a web tool and a command hear ask, never allow; a read in the chat's folder passes", async (t) => {
  const r = await rig(t);
  const hook = (tool: string, input: Record<string, unknown>) => askBroker(r.broker.socketPath, r.secret, { tool_name: tool, tool_input: input, tool_use_id: `toolu_hook_${++calls}`, cwd: r.scratch });
  assert.equal((await hook("WebFetch", FETCH)).verdict, "ask");
  assert.equal((await hook("Bash", { command: "ls" })).verdict, "ask");
  assert.equal((await hook("Read", { file_path: path.join(r.scratch, "a.txt") })).verdict, "pass");
  // Claude Code's own bookkeeping (loading a tool's description, its to-do list) is left to the CLI, as when it is used directly.
  assert.equal((await hook("ToolSearch", { query: "select:WebFetch", max_results: 1 })).verdict, "pass");
  assert.equal((await hook("TodoWrite", { todos: [] })).verdict, "pass");
});

test("a task's web tools follow the same setting Web access: Allow runs them logged under the task, Ask puts them to the owner, Off refuses them; its bookkeeping tools pass and run", async (t) => {
  const r = await rig(t);
  const taskId = createTask(r.db, { repo: path.join(r.dir, "repo"), prompt: "fetch it" }).id;
  const worktree = path.join(r.dir, "worktree");
  fs.mkdirSync(worktree);
  const admission = r.broker.admit({ taskId, role: "implementer", worktree, confined: true });
  const attemptId = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  admission.bind(attemptId);
  let n = 0;
  const taskAsk = (tool: string, input: Record<string, unknown>): Promise<Answer> => r.broker.request({ taskId, attemptId, role: "implementer", tool, command: JSON.stringify(input), input, cwd: ".", reason: null, toolCallId: `toolu_task_${++n}` });
  // Allow, the default.
  const allowed = await taskAsk("WebFetch", FETCH);
  assert.deepEqual([allowed.decision, allowed.web, allowed.approvalId], ["allow", true, null]);
  assert.equal((await taskAsk("WebSearch", SEARCH)).web, true);
  // A fetch of this Mac still asks.
  const local = taskAsk("WebFetch", { url: "http://127.0.0.1:4780/api/settings", prompt: "x" });
  assert.equal(await waits(local), true);
  assert.equal(r.broker.pending()[0]!.asksBecause, "It reaches this Mac, your local network, or something that is not a public web page.");
  r.broker.answer(r.broker.pending()[0]!.id, "decline");
  await local;
  // Ask.
  setChatWebAccess(r.db, "ask");
  const asked = taskAsk("WebFetch", FETCH);
  assert.equal(await waits(asked), true);
  assert.equal(r.broker.pending()[0]!.chat, false);
  r.broker.answer(r.broker.pending()[0]!.id, "decline");
  await asked;
  // Off.
  setChatWebAccess(r.db, "off");
  const off = await taskAsk("WebSearch", SEARCH);
  assert.deepEqual([off.decision, off.approvalId], ["decline", null]);
  assert.match(off.refused ?? "", /Web access is off.*Settings/);
  assert.deepEqual(actionLog(r.db, taskId).map((e) => e.rule), ["web_allowed", "web_allowed", "asked_owner", "owner_declined", "asked_owner", "owner_declined", "web_refused"]);
  // The CLI's own to-do list and tool loading: the hook lets them pass, and should the CLI ask, they run.
  const hook = (tool: string, input: Record<string, unknown>) => askBroker(admission.socketPath, admission.secret, { tool_name: tool, tool_input: input, tool_use_id: `toolu_hook_${++n}`, cwd: worktree });
  assert.equal((await hook("TodoWrite", { todos: [] })).verdict, "pass");
  assert.equal((await hook("ToolSearch", { query: "select:WebFetch", max_results: 1 })).verdict, "pass");
  const todo = await taskAsk("TodoWrite", { todos: [] });
  assert.deepEqual([todo.decision, todo.bookkeeping, todo.approvalId], ["allow", true, null]);
  assert.equal(r.broker.pending().length, 0);
});

test("a request that says it is a chat's, from an agent no chat admitted, gets no web setting: the owner decides", async (t) => {
  const r = await rig(t);
  const other = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const stranger = r.broker.request({ taskId: null, chat: true, attemptId: other, role: CHAT_ROLE, tool: "WebFetch", command: JSON.stringify(FETCH), input: FETCH, cwd: ".", reason: null, toolCallId: "toolu_stranger" } as ApprovalRequest);
  // Not tied to a chat's admission: the web setting is not applied, and the owner decides.
  assert.equal(await waits(stranger), true);
  assert.equal(r.broker.pending()[0]!.asksBecause, "Botbench could not tell what this would run, or which of its agents asked.");
  r.broker.answer(r.broker.pending()[0]!.id, "decline");
  assert.equal((await stranger).decision, "decline");
});

test("a chat's approval left pending when Botbench stopped ends as not answered at the next start, with a plain line; a task's stays parked", async (t) => {
  const r = await rig(t);
  setChatWebAccess(r.db, "ask");
  void ask(r, "WebFetch", FETCH, JSON.stringify(FETCH));
  const taskId = createTask(r.db, { repo: path.join(r.dir, "repo"), prompt: "ls" }).id;
  const taskAttempt = Number(r.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  void r.broker.request({ taskId, attemptId: taskAttempt, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_task" });
  const [chatCard, taskCard] = r.broker.pending();
  const home2 = path.join(r.dir, "home2");
  fs.mkdirSync(home2, { mode: 0o700 });
  const again = createBroker({ db: r.db, home: home2, onChange: () => {} });
  t.after(() => again.close());
  await again.listen();
  assert.deepEqual(again.pending().map((a) => a.id), [taskCard!.id]);
  const ended = actionLog(r.db).find((e) => e.approvalId === chatCard!.id && e.rule === "ended_unanswered");
  assert.match(ended?.detail ?? "", /Botbench restarted before you answered/);
});
