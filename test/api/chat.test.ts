import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { chatHistory, chatScopeWords, claudeContinues, createChat, type Chat } from "../../src/api/chat.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import { createTurns, SCRATCH_DIR, TurnError } from "../../src/api/turns.ts";
import { setChatWebAccess } from "../../src/approvals/web-access.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { openStore, now } from "../../src/store/db.ts";
import { usageReport } from "../../src/usage.ts";
import { chatReplayDriver, type ChatReplay, type ChatSession, type ConstructedSession } from "../support/replay-chat.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// Chat with Codex, Grok and Antigravity, one at a time or several at once, on real SQLite, each agent replaying a
// session captured from its real CLI (test/support/replay-chat.ts). No Claude Code turn is started here.

type T = { after(fn: () => unknown): void };
const QUESTION = "Name one more primary colour, in one word, and say in one short sentence why it is primary.";

function setup(t: T, sessions: Partial<Record<"codex" | "grok" | "antigravity", ChatSession | ChatSession[] | ConstructedSession>> = {}, o: { problem?: Partial<Record<string, string>>; limitMs?: number } = {}) {
  const dir = tempDir("botbench-chat-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const make = (name: "codex" | "grok" | "antigravity"): ChatReplay => chatReplayDriver(name, sessions[name] ?? "chat", o.problem?.[name] === undefined ? {} : { problem: o.problem[name]! });
  const agents = { codex: make("codex"), grok: make("grok"), antigravity: make("antigravity") };
  const claude = new ClaudeCodeDriver();
  // No Claude Code turn starts here, so the broker is not asked anything and its socket is not opened.
  const broker = createBroker({ db, home, onChange: () => {} });
  const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
  const chat = createChat({ db, home, turns, claude, agents, onEvent: () => {}, ...(o.limitMs === undefined ? {} : { limitMs: o.limitMs }) });
  t.after(async () => {
    await chat.close();
    await turns.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, home, agents, chat };
}

const events = (db: DatabaseSync, attemptId: number): DriverEvent[] => db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((r) => JSON.parse(String(r.payload)) as DriverEvent);
const ended = (db: DatabaseSync, attemptId: number): Extract<DriverEvent, { type: "turn_ended" }> | undefined => events(db, attemptId).find((e): e is Extract<DriverEvent, { type: "turn_ended" }> => e.type === "turn_ended");
const text = (db: DatabaseSync, attemptId: number): string => events(db, attemptId).filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");

/** Wait until no chat turn of these attempts runs. */
async function settled(chat: Chat, ids: readonly number[]): Promise<void> {
  for (let i = 0; i < 500 && ids.some((id) => chat.turnRunning(id)); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ids.every((id) => !chat.turnRunning(id)), "every turn ended");
}

test("a chat message to Codex is one turn stored under Codex, with its own tools in the chat's own folder (Claude Code's), no host, no way to ask, and web search as the setting allows", async (t) => {
  const { db, home, agents, chat } = setup(t);
  const [reply] = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }] });
  await settled(chat, [reply!.attemptId]);
  assert.equal(db.prepare("SELECT driver, model FROM attempts WHERE id = ?").get(reply!.attemptId)!.driver, "codex");
  assert.match(text(db, reply!.attemptId), /^Blue\./);
  assert.equal(ended(db, reply!.attemptId)?.reason, "completed");
  assert.equal(chat.info(reply!.attemptId)?.round?.message, QUESTION);

  const [options] = agents.codex.started;
  const { db: _db, ...rest } = options!;
  // Web access in chat is Allow until the owner changes it.
  assert.deepEqual(rest, { cwd: fs.realpathSync(path.join(home, SCRATCH_DIR)), chatTools: { readable: [] }, webSearch: true, confinement: { dataDir: home, allowedHosts: [] }, model: "gpt-6-luna" });
  assert.equal(fs.existsSync(rest.cwd), true, "the chat's folder stays: the files made there are the chat's");
});

test("the screen is told in plain words what each agent can do in a chat: for Codex and Grok, that the sandbox is the control because they cannot ask", () => {
  const { codex, grok, antigravity } = { codex: chatReplayDriver("codex"), grok: chatReplayDriver("grok"), antigravity: chatReplayDriver("antigravity") };
  for (const [driver, name] of [[codex, "Codex"], [grok, "Grok"]] as const) {
    const words = chatScopeWords(driver)!;
    assert.ok(words.startsWith(`${name} cannot ask you before it acts, so Botbench's sandbox is what keeps it in bounds:`), words);
    assert.match(words, /only in the chat's own folder, its commands reach nothing on the network but its own provider, and it searches the web only when Web access in chat is Allow\./);
  }
  assert.match(chatScopeWords(antigravity)!, /^Antigravity answers from the conversation alone: it cannot read your files or change anything here\./);
  assert.equal(chatScopeWords(new ClaudeCodeDriver()), null, "Claude Code asks you itself");
});

test("web search follows \"Web access in chat\": Off turns it off, and so does Ask, as Codex and Grok cannot ask", async (t) => {
  const { db, agents, chat } = setup(t);
  for (const [setting, expected] of [["off", false], ["ask", false], ["allow", true]] as const) {
    setChatWebAccess(db, setting);
    const replies = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: null }, { agent: "grok", model: null }] });
    await settled(chat, replies.map((r) => r.attemptId));
    assert.equal(agents.codex.started.at(-1)!.webSearch, expected, `codex, ${setting}`);
    assert.equal(agents.grok.started.at(-1)!.webSearch, expected, `grok, ${setting}`);
  }
});

test("Antigravity, which has no tools here, still answers in a new empty folder that is gone afterwards, read-only, with no web search", async (t) => {
  const { home, agents, chat } = setup(t);
  const [reply] = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "antigravity", model: null }] });
  await settled(chat, [reply!.attemptId]);
  const { db: _db, cwd, ...rest } = agents.antigravity.started[0]!;
  assert.deepEqual(rest, { readOnly: true, confinement: { dataDir: home, allowedHosts: [] } });
  assert.equal(path.dirname(cwd), path.join(fs.realpathSync(home), "reviewers"));
  assert.equal(fs.existsSync(cwd), false);
});

test("with a repository attached, Codex and Grok read it and its git folder, resolved once, and are told where it is; Claude Code and Antigravity are not asked, and nothing is sent", async (t) => {
  const { home, agents, chat } = setup(t);
  const repo = path.join(path.dirname(home), "attached");
  initRepo(repo, { "README.md": "# Attached\n" });
  const link = path.join(path.dirname(home), "attached-link");
  fs.symlinkSync(repo, link);
  const replies = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: null }, { agent: "grok", model: null }], repository: link });
  await settled(chat, replies.map((r) => r.attemptId));
  const real = fs.realpathSync(repo);
  for (const agent of [agents.codex, agents.grok]) {
    assert.deepEqual(agent.started[0]!.chatTools, { readable: [real, path.join(real, ".git")] });
    assert.match(agent.prompts[0]!, new RegExp(`The owner attached the repository at ${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: you can read it there, and you cannot change it`));
  }
  await assert.rejects(chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "claude-code", model: undefined }], repository: repo }), /Claude Code works on a repository as a task/);
  await assert.rejects(chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: null }, { agent: "antigravity", model: null }], repository: repo }), /Antigravity cannot read a repository in Botbench/);
  await assert.rejects(chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: null }], repository: path.join(repo, "missing") }), TurnError);
  await assert.rejects(chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: null }], repository: "relative/path" }), /full path/);
  initRepo(path.join(home, "inside"), { "a.txt": "a\n" });
  await assert.rejects(chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: null }], repository: path.join(home, "inside") }), /Botbench's own data/);
  assert.equal(agents.codex.started.length, 1, "a refused message starts nothing");
  assert.equal(agents.antigravity.started.length, 0);
});

test("a web search an agent reports is a step of the chat's transcript: Codex's own search and Grok's X search, replayed through each one's reader", async (t) => {
  // Constructed lines, in the forms each CLI prints (Codex 0.171.0's items; Grok's recorded X search line): no CLI ran.
  const codexLines = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.started","item":{"id":"ws_1","type":"web_search","query":"node 24 release date"}}',
    '{"type":"item.completed","item":{"id":"ws_1","type":"web_search","query":"node 24 release date"}}',
    '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"April 2025."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}',
  ];
  const grokLines = [
    '{"type":"tool_call","toolCallId":"ctc_1","toolName":"X search:","rawInput":{"variant":"XSearch","backend":true}}',
    '{"type":"text","data":"People say yes."}',
    '{"type":"end","stopReason":"end_turn","sessionId":"s1","usage":{"input_tokens":5,"output_tokens":2}}',
  ];
  const { db, chat } = setup(t, { codex: { lines: codexLines }, grok: { lines: grokLines } });
  const [codex, grok] = await chat.send({ message: "Search, please.", conversation: [], agents: [{ agent: "codex", model: null }, { agent: "grok", model: null }] });
  await settled(chat, [codex!.attemptId, grok!.attemptId]);
  const steps = (id: number) => events(db, id).filter((e) => e.type === "tool_call" || e.type === "tool_result");
  assert.deepEqual(steps(codex!.attemptId), [
    { type: "tool_call", id: "ws_1", name: "web_search", input: { query: "node 24 release date" } },
    { type: "tool_result", id: "ws_1", output: "node 24 release date", isError: false },
  ]);
  assert.deepEqual(steps(grok!.attemptId), [{ type: "tool_call", id: "ctc_1", name: "X search:", input: { variant: "XSearch", backend: true } }]);
  assert.equal(ended(db, codex!.attemptId)?.reason, "completed");
  assert.equal(ended(db, grok!.attemptId)?.reason, "completed");
  assert.equal(text(db, grok!.attemptId), "People say yes.");
});

test("a second message, to another agent, carries the first message and the first reply, and the replies say who wrote them", async (t) => {
  const { db, agents, chat } = setup(t);
  const [first] = await chat.send({ message: "Name one primary colour.", conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }] });
  await settled(chat, [first!.attemptId]);
  const [second] = await chat.send({ message: QUESTION, conversation: [first!.attemptId], agents: [{ agent: "grok", model: null }] });
  await settled(chat, [second!.attemptId]);
  const sent = agents.grok.prompts[0]!;
  assert.match(sent, /From the owner:\n<message>\nName one primary colour\.\n<\/message>/);
  assert.match(sent, /From Codex \(gpt-6-luna\), another AI model:\n<message>\nBlue\. It is a primary colour/);
  assert.match(sent, /The owner's new message, which you answer:\n<message>\nName one more primary colour/);
  assert.equal(db.prepare("SELECT driver FROM attempts WHERE id = ?").get(second!.attemptId)!.driver, "grok");
  assert.match(text(db, second!.attemptId), /^Blue\./);
  // What was passed on is the chat's text only: no framing Botbench wrote around the first message.
  assert.deepEqual(chatHistory(db, [first!.attemptId, second!.attemptId]).map((e) => e.from), ["owner", "Codex (gpt-6-luna)", "owner", "Grok (its default model)"]);
});

test("ask several: one message goes to each agent with the same conversation, one turn each in one round, and the one that fails does not fail the others", async (t) => {
  const { db, agents, chat } = setup(t, { grok: "signed-out" });
  const replies = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }, { agent: "grok", model: "grok-4.7-build-fast" }, { agent: "antigravity", model: "gemini-3.8-flash-low" }] });
  assert.deepEqual(replies.map((r) => r.agent), ["codex", "grok", "antigravity"]);
  assert.equal(new Set(replies.map((r) => r.roundId)).size, 1);
  await settled(chat, replies.map((r) => r.attemptId));
  const [codex, grok, agy] = replies.map((r) => r.attemptId) as [number, number, number];
  assert.equal(ended(db, codex)?.reason, "completed");
  assert.equal(ended(db, agy)?.reason, "completed");
  assert.equal(ended(db, grok)?.reason, "error");
  assert.match(text(db, agy), /^Blue\./);
  assert.equal(agents.codex.prompts[0], agents.grok.prompts[0], "the two with their own tools were sent the same");
  assert.match(agents.codex.prompts[0]!, /working in a folder of your own/);
  assert.match(agents.antigravity.prompts[0]!, /Answer from the conversation alone/, "Antigravity has none, and is told so");
  assert.equal(agents.codex.prompts[0]!.split("\n\n").slice(1).join("\n\n"), agents.antigravity.prompts[0]!.split("\n\n").slice(1).join("\n\n"), "the conversation and the message are the same for each");
  // The owner's message is in the conversation passed on once, then each reply that came.
  assert.deepEqual(chatHistory(db, [codex, grok, agy]).map((e) => e.from), ["owner", "Codex (gpt-6-luna)", "Antigravity (gemini-3.8-flash-low)"]);

  // Usage: each turn under its own agent.
  const usage = usageReport(db, { now: Date.now(), drivers: ["claude-code", "codex", "grok", "antigravity"], billing: {} });
  const turns = Object.fromEntries(usage.allTime.agents.map((a) => [a.driver, a.turns]));
  assert.equal(turns.codex, 1);
  assert.equal(turns.antigravity, 1);
  assert.equal(turns["claude-code"], 0);
});

test("compare: the one agent asked is sent the question and each labelled answer, as data, and its reply is a round of its own", async (t) => {
  const { db, agents, chat } = setup(t, { codex: ["chat", "compare"] });
  const replies = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }, { agent: "grok", model: "grok-4.7-build-fast" }, { agent: "antigravity", model: "gemini-3.8-flash-low" }] });
  await settled(chat, replies.map((r) => r.attemptId));
  const [compared] = await chat.send({ message: "", conversation: replies.map((r) => r.attemptId), agents: [{ agent: "codex", model: "gpt-6-luna" }], compare: replies[0]!.roundId! });
  await settled(chat, [compared!.attemptId]);
  const sent = agents.codex.prompts[1]!;
  assert.match(sent, /^\[From Botbench, not from the owner\]/);
  assert.match(sent, /The question:\n<message>\nName one more primary colour/);
  for (const from of ["Codex (gpt-6-luna)", "Grok (grok-4.7-build-fast)", "Antigravity (gemini-3.8-flash-low)"]) assert.match(sent, new RegExp(`The answer from ${from.replace(/[()]/g, "\\$&")}:\n<answer>\nBlue`));
  assert.match(text(db, compared!.attemptId), /All three name \*\*blue\*\*/);
  const info = chat.info(compared!.attemptId)!;
  assert.equal(info.round?.kind, "compare");
  assert.equal(info.round?.compares, replies[0]!.roundId);
});

test("refused, with nothing sent: an agent that is not usable now, an unknown agent, an agent twice, and a chat begun before Botbench kept chats", async (t) => {
  const { db, agents, chat } = setup(t, {}, { problem: { grok: "Grok is signed out. Run `grok login` in a terminal." } });
  const before = Number(db.prepare("SELECT count(*) AS n FROM attempts").get()!.n);
  await assert.rejects(chat.send({ message: "Hi", conversation: [], agents: [{ agent: "codex", model: null }, { agent: "grok", model: null }] }), (err: unknown) => err instanceof TurnError && err.status === 409 && /^Grok cannot answer now: Grok is signed out\. .* Nothing was sent\.$/.test(err.message));
  await assert.rejects(chat.send({ message: "Hi", conversation: [], agents: [{ agent: "gemini", model: null }] }), (err: unknown) => err instanceof TurnError && err.status === 400);
  await assert.rejects(chat.send({ message: "Hi", conversation: [], agents: [{ agent: "codex", model: null }, { agent: "codex", model: "x" }] }), (err: unknown) => err instanceof TurnError && err.status === 400);
  const at = now();
  const old = Number(db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES ('claude-code', NULL, 'ended', ?, ?)").run(at, at).lastInsertRowid);
  await assert.rejects(chat.send({ message: "Hi", conversation: [old], agents: [{ agent: "codex", model: null }] }), (err: unknown) => err instanceof TurnError && err.status === 409 && /Start a new chat/.test(err.message));
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM attempts").get()!.n), before + 1, "no attempt was started");
  assert.equal(agents.codex.started.length, 0);
});

test("compare is refused for a round with fewer than two answers", async (t) => {
  const { chat } = setup(t, { grok: "signed-out" });
  const replies = await chat.send({ message: "Hi", conversation: [], agents: [{ agent: "codex", model: null }, { agent: "grok", model: null }] });
  await settled(chat, replies.map((r) => r.attemptId));
  await assert.rejects(chat.send({ message: "", conversation: [], agents: [{ agent: "codex", model: null }], compare: replies[0]!.roundId! }), (err: unknown) => err instanceof TurnError && err.status === 409);
});

test("Stop ends one agent's turn and leaves the others; a turn past its time limit is stopped and says why", async (t) => {
  const { db, chat } = setup(t, { codex: "hang", antigravity: "hang" }, { limitMs: 300 });
  const replies = await chat.send({ message: "Hi", conversation: [], agents: [{ agent: "codex", model: null }, { agent: "grok", model: null }, { agent: "antigravity", model: null }] });
  const [codex, grok, agy] = replies.map((r) => r.attemptId) as [number, number, number];
  assert.equal(await chat.interrupt(codex), true);
  assert.equal(ended(db, codex)?.reason, "interrupted");
  await settled(chat, [codex, grok, agy]);
  assert.equal(ended(db, grok)?.reason, "completed", "Grok was not stopped with Codex");
  assert.equal(ended(db, agy)?.reason, "interrupted");
  assert.ok(events(db, agy).some((e) => e.type === "error" && /^Antigravity did not finish within 0 seconds and was stopped\.$/.test(e.message)));
  assert.equal(events(db, codex).some((e) => e.type === "error"), false);
  assert.equal(await chat.interrupt(codex), false, "nothing runs any more");
});

test("Claude Code alone continues its own session while it is the only agent that answered since its last reply; otherwise it is given the conversation", (t) => {
  const { db } = setup(t);
  const at = now();
  const attempt = (driver: string): number => Number(db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES (?, NULL, 'ended', ?, ?)").run(driver, at, at).lastInsertRowid);
  const round = (): number => Number(db.prepare("INSERT INTO chat_rounds (kind, message, compares, created_at) VALUES ('ask', 'Hi', NULL, ?)").run(at).lastInsertRowid);
  const join = (id: number, r: number | null): void => void db.prepare("INSERT INTO chat_attempts (attempt_id, round_id, created_at) VALUES (?, ?, ?)").run(id, r, at);
  assert.equal(claudeContinues(db, []), undefined);
  const claude = attempt("claude-code");
  join(claude, null);
  assert.equal(claudeContinues(db, [claude]), claude);
  const codex = attempt("codex");
  join(codex, round());
  assert.equal(claudeContinues(db, [claude, codex]), null, "Codex answered last");
  const given = attempt("claude-code");
  join(given, round());
  assert.equal(claudeContinues(db, [claude, codex, given]), given, "Claude Code was given the conversation, alone");
  const shared = round();
  const a = attempt("claude-code");
  const b = attempt("grok");
  join(a, shared);
  join(b, shared);
  assert.equal(claudeContinues(db, [claude, b, a]), null, "Grok answered beside it");
});
