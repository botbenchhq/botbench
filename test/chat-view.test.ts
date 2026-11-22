import assert from "node:assert/strict";
import test from "node:test";
import type { AgentState, ChatRound, StoredEvent } from "../web/src/api/client.ts";
import { chatOffer, chatTargets, chatView, readChatAgents, sendWords, type AttemptInfo } from "../web/src/app/chat.ts";

// Which agents a chat offers, what Send sends to whom, and how a chat with several agents reads, decided without a browser.

const agent = (name: string, problem: string | null = null): AgentState => ({ agent: name, installed: true, version: "1", supported: true, signedIn: problem === null, billing: "subscription", problem, roles: [] });
const all = [agent("claude-code"), agent("codex"), agent("grok", "Grok is signed out. Run `grok login` in a terminal."), agent("antigravity")];

test("every agent is offered for a chat, in a fixed order; one its own check finds unusable is listed with the reason, and cannot be chosen", () => {
  assert.deepEqual(chatOffer([all[3]!, all[2]!, all[1]!, all[0]!]), [
    { agent: "claude-code", name: "Claude Code", problem: null },
    { agent: "codex", name: "Codex", problem: null },
    { agent: "grok", name: "Grok", problem: "Grok is signed out. Run `grok login` in a terminal." },
    { agent: "antigravity", name: "Antigravity", problem: null },
  ]);
});

test("Send goes to the one agent chosen with its model, or to each agent ticked under Ask several; an unusable or too short choice says what to do", () => {
  const offer = chatOffer(all);
  const claude = { ok: true as const, model: "haiku" };
  assert.deepEqual(chatTargets({ pick: { kind: "one", agent: "claude-code" }, models: {} }, claude, offer), { ok: true, targets: [{ agent: "claude-code", model: "haiku" }] });
  assert.deepEqual(chatTargets({ pick: { kind: "one", agent: "codex" }, models: { codex: "gpt-6-luna" } }, claude, offer), { ok: true, targets: [{ agent: "codex", model: "gpt-6-luna" }] });
  assert.deepEqual(chatTargets({ pick: { kind: "one", agent: "antigravity" }, models: {} }, claude, offer), { ok: true, targets: [{ agent: "antigravity", model: null }] });
  assert.deepEqual(chatTargets({ pick: { kind: "one", agent: "grok" }, models: {} }, claude, offer), { ok: false, why: "Grok cannot answer now: Grok is signed out. Run `grok login` in a terminal. Choose another agent." });
  assert.deepEqual(chatTargets({ pick: { kind: "several", agents: ["codex", "claude-code", "antigravity"] }, models: {} }, claude, offer), { ok: true, targets: [{ agent: "claude-code", model: "haiku" }, { agent: "codex", model: null }, { agent: "antigravity", model: null }] });
  // An unusable agent ticked earlier is left out; fewer than two is not several.
  assert.deepEqual(chatTargets({ pick: { kind: "several", agents: ["codex", "grok"] }, models: {} }, claude, offer), { ok: false, why: "Tick at least two agents that can answer now, or choose one agent." });
  assert.deepEqual(chatTargets({ pick: { kind: "one", agent: "claude-code" }, models: {} }, { ok: false, why: "Enter a model name." }, offer), { ok: false, why: "Model: Enter a model name." });
  // Before the agents are checked, the one remembered is asked; the server checks it again.
  assert.deepEqual(chatTargets({ pick: { kind: "one", agent: "codex" }, models: {} }, claude, null), { ok: true, targets: [{ agent: "codex", model: null }] });
});

test("the Send button and the line under it say how many agents will be asked", () => {
  assert.deepEqual(sendWords(1), { label: "Send", line: null });
  assert.deepEqual(sendWords(3), { label: "Send to 3 agents", line: "Asks 3 agents: each reply counts toward that agent's usage." });
});

test("what the device remembers is read part by part, and Claude Code alone is the default", () => {
  assert.deepEqual(readChatAgents(null), { pick: { kind: "one", agent: "claude-code" }, models: {} });
  assert.deepEqual(readChatAgents('{"pick":{"kind":"several","agents":["codex",3,"grok"]},"models":{"codex":"gpt-6-luna","grok":null,"x":4}}'), { pick: { kind: "several", agents: ["codex", "grok"] }, models: { codex: "gpt-6-luna", grok: null } });
  assert.deepEqual(readChatAgents('{"pick":{"kind":"one","agent":""}}'), { pick: { kind: "one", agent: "claude-code" }, models: {} });
});

let nextId = 1;
const ev = (attemptId: number, payload: StoredEvent["payload"], turn = 1): StoredEvent => ({ attemptId, id: nextId++, turn, ts: new Date(Date.UTC(2026, 10, 22, 12, 0, nextId)).toISOString(), type: payload.type, payload });
const ROUND: ChatRound = { id: 7, kind: "ask", message: "Name a colour", compares: null };

test("a round asked of several agents shows the owner's message once, then each reply as it finished, each named with its agent and model", () => {
  const infos = new Map<number, AttemptInfo>([
    [1, { agent: "codex", model: "gpt-6-luna", round: ROUND }],
    [2, { agent: "grok", model: null, round: ROUND }],
    [3, { agent: "antigravity", model: null, round: ROUND }],
  ]);
  const events = [
    ev(1, { type: "user_prompt", text: "[From Botbench] ... framed" }),
    ev(2, { type: "user_prompt", text: "[From Botbench] ... framed" }),
    ev(3, { type: "user_prompt", text: "[From Botbench] ... framed" }),
    ev(3, { type: "session_started", resumeCursor: "c", model: "gemini-3.8-flash-low", keySource: null }),
    ev(3, { type: "text", text: "Blue." }),
    ev(3, { type: "turn_ended", reason: "completed", detail: null }),
    ev(1, { type: "text", text: "Red." }),
    ev(1, { type: "turn_ended", reason: "completed", detail: null }),
    ev(2, { type: "turn_ended", reason: "error", detail: "Not signed in." }),
  ];
  const view = chatView(events, infos, [1, 2, 3]);
  const shown = view.events.map((e) => (e.payload.type === "user_prompt" ? `owner: ${e.payload.text}` : e.payload.type === "text" ? `${view.who(e.attemptId)}: ${e.payload.text}` : `${e.payload.type} ${e.attemptId}`));
  assert.deepEqual(shown, ["owner: Name a colour", "Antigravity · gemini-3.8-flash-low: Blue.", "turn_ended 3", "Codex · gpt-6-luna: Red.", "turn_ended 1", "turn_ended 2"]);
  assert.equal(view.who(2), "Grok · default model");
  // A round of several that has ended with two answers or more can be compared.
  assert.deepEqual(view.compare, { roundId: 7, answers: 2 });
  assert.equal(chatView(events.slice(0, 7), infos, [1, 2, 3]).compare, null, "not while one is still working");
});

test("a chat only Claude Code has answered keeps its prompts and its plain label; once another agent has answered, every reply says who", () => {
  const claudeOnly = new Map<number, AttemptInfo>([[10, { agent: "claude-code", model: null, round: null }]]);
  const events = [ev(10, { type: "user_prompt", text: "Hi" }), ev(10, { type: "session_started", resumeCursor: "c", model: "claude-haiku-5-5", keySource: null }), ev(10, { type: "text", text: "Hello." }), ev(10, { type: "turn_ended", reason: "completed", detail: null })];
  const alone = chatView(events, claudeOnly, [10]);
  assert.equal(alone.events.length, 4);
  assert.equal(alone.who(10), null, "the transcript's own label, Claude Code");
  assert.equal(alone.compare, null);
  const both = new Map(claudeOnly).set(11, { agent: "codex", model: "gpt-6-luna", round: { ...ROUND, id: 8 } });
  const more = [...events, ev(11, { type: "user_prompt", text: "framed" }), ev(11, { type: "text", text: "Hi from Codex." }), ev(11, { type: "turn_ended", reason: "completed", detail: null })];
  const view = chatView(more, both, [10, 11]);
  assert.equal(view.who(10), "Claude Code · claude-haiku-5-5");
  assert.equal(view.who(11), "Codex · gpt-6-luna");
  assert.equal(view.compare, null, "one agent asked is nothing to compare");
});

test("a compare request reads as the owner asking that agent to compare the answers", () => {
  const infos = new Map<number, AttemptInfo>([[20, { agent: "codex", model: "gpt-6-luna", round: { id: 9, kind: "compare", message: "Name a colour", compares: 7 } }]]);
  const view = chatView([ev(20, { type: "user_prompt", text: "[From Botbench, not from the owner] ..." }), ev(20, { type: "text", text: "They agree." })], infos, [20]);
  assert.equal(view.events[0]!.payload.type === "user_prompt" && view.events[0]!.payload.text, "Codex, compare the answers above: where they agree, where they differ, and which you would act on.");
});
