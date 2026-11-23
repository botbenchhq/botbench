import assert from "node:assert/strict";
import test from "node:test";
import type { AgentState, ChatRound, StoredEvent } from "../web/src/api/client.ts";
import { agentAbout, agentList, defaultFirst, agentRowValue, chatOffer, chatTargets, chatView, chipWords, modelsShown, readChatAgents, readKnownAgents, sendWords, type AttemptInfo } from "../web/src/app/chat.ts";

// Which agents a chat offers, what Send sends to whom, and how a chat with several agents reads, decided without a browser.

const agent = (name: string, problem: string | null = null): AgentState => ({ agent: name, installed: true, version: "1", supported: true, signedIn: problem === null, billing: "subscription", problem, roles: [] });
const all = [agent("claude-code"), agent("codex"), agent("grok", "Grok is signed out. Run `grok login` in a terminal."), agent("antigravity")];

test("every agent is offered for a chat, in a fixed order; one its own check finds unusable is listed with the reason, and cannot be chosen", () => {
  assert.deepEqual(chatOffer([all[3]!, all[2]!, all[1]!, all[0]!]), [
    { agent: "claude-code", name: "Claude Code", problem: null, version: "1", state: "Available", chat: null },
    { agent: "codex", name: "Codex", problem: null, version: "1", state: "Available", chat: null },
    { agent: "grok", name: "Grok", problem: "Grok is signed out. Run `grok login` in a terminal.", version: "1", state: "Signed out", chat: null },
    { agent: "antigravity", name: "Antigravity", problem: null, version: "1", state: "Available", chat: null },
  ]);
});

test("what an agent can do in a chat is the server's sentence, kept with its check and shown on its row", () => {
  const words = "Codex cannot ask you before it acts, so Botbench's sandbox is what keeps it in bounds: …";
  const offer = chatOffer([{ ...agent("codex"), chat: words }, agent("claude-code")]);
  assert.equal(offer.find((o) => o.agent === "codex")!.chat, words);
  assert.equal(agentList({ known: offer, checking: false, failed: null, inRepository: false }).rows[1]!.chat, words);
  assert.equal(readKnownAgents(JSON.stringify(offer))!.find((o) => o.agent === "codex")!.chat, words, "the device keeps it with the check");
  assert.equal(agentList({ known: null, checking: true, failed: null, inRepository: false }).rows[1]!.chat, null, "nothing is said before the check is known");
});

test("whether an agent reads a repository attached to a chat is the server's answer, kept with its check; not said is not known", () => {
  const offer = chatOffer([{ ...agent("codex"), readsRepository: true }, { ...agent("antigravity"), readsRepository: false }, agent("grok")]);
  assert.deepEqual(offer.map((o) => [o.agent, o.readsRepository]), [["codex", true], ["grok", undefined], ["antigravity", false]]);
  const kept = readKnownAgents(JSON.stringify([...offer, { agent: "claude-code", problem: null, readsRepository: "yes" }]))!;
  assert.deepEqual(kept.map((o) => [o.agent, o.readsRepository]), [["codex", true], ["grok", undefined], ["antigravity", false], ["claude-code", undefined]]);
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

// The Agent and model view: a row of agents (chips) that never scrolls away, then the chosen one's models. What it lists
// in each state is decided here, without a browser.
const rowsOf = (list: ReturnType<typeof agentList>) => list.rows.map((r) => [r.label, r.disabled]);

test("with nothing known yet, every agent Botbench drives is in the row by name as being checked, with one line that says so", () => {
  const list = agentList({ known: null, checking: true, failed: null, inRepository: false });
  assert.equal(list.line, "Checking the agents.");
  assert.deepEqual(rowsOf(list), [["Claude Code: Checking…", false], ["Codex: Checking…", false], ["Grok: Checking…", false], ["Antigravity: Checking…", false]]);
  assert.deepEqual(list.several, { label: "Ask several", disabled: false, tickable: ["claude-code", "codex", "grok", "antigravity"] });
  assert.equal(list.repository, false);
});

test("with a last check known, the row is drawn at once as it was, with no line, even while it is checked again", () => {
  for (const checking of [false, true]) {
    const list = agentList({ known: chatOffer(all.map((a) => ({ ...a, problem: null, signedIn: true }))), checking, failed: null, inRepository: false });
    assert.equal(list.line, null);
    assert.deepEqual(rowsOf(list), [["Claude Code", false], ["Codex", false], ["Grok", false], ["Antigravity", false]]);
    assert.equal(list.several.disabled, false);
  }
});

test("an agent its check finds unusable stays in the row, its state in words, and can be chosen to see why; it cannot be ticked under Ask several", () => {
  const list = agentList({ known: chatOffer(all), checking: false, failed: null, inRepository: false });
  assert.deepEqual(list.rows[2], { agent: "grok", name: "Grok", label: "Grok: Signed out", state: "Signed out", version: "1", problem: "Grok is signed out. Run `grok login` in a terminal.", disabled: false, chat: null });
  assert.deepEqual(list.several.tickable, ["claude-code", "codex", "antigravity"]);
});

test("a check that failed says so in words; the last known states stay, or, with none, the agents are listed as not checked", () => {
  const kept = agentList({ known: chatOffer(all), checking: false, failed: "Botbench did not answer in time.", inRepository: false });
  assert.equal(kept.line, "The agents could not be checked again: Botbench did not answer in time. Each shows what its last check found.");
  assert.equal(kept.rows[2]!.label, "Grok: Signed out");
  const none = agentList({ known: null, checking: false, failed: "Botbench could not be reached.", inRepository: false });
  assert.equal(none.line, "The agents could not be checked: Botbench could not be reached. Claude Code can still be asked.");
  assert.deepEqual(none.rows.map((r) => r.label), ["Claude Code: Not checked", "Codex: Not checked", "Grok: Not checked", "Antigravity: Not checked"]);
});

test("with a repository attached, the other agents and Ask several stay in the row as Chat only and cannot be chosen; the view offers to remove the repository", () => {
  const list = agentList({ known: chatOffer(all), checking: false, failed: null, inRepository: true });
  assert.deepEqual(rowsOf(list), [["Claude Code", false], ["Codex: Chat only", true], ["Grok: Chat only", true], ["Antigravity: Chat only", true]]);
  assert.deepEqual([list.several.label, list.several.disabled], ["Ask several: Chat only", true]);
  assert.equal(list.repository, true);
  assert.deepEqual(rowsOf(agentList({ known: null, checking: true, failed: null, inRepository: true })).slice(1), [["Codex: Chat only", true], ["Grok: Chat only", true], ["Antigravity: Chat only", true]]);
});

test("over an agent's models: its version and its sign-in state in words", () => {
  const [claude, , grok] = agentList({ known: chatOffer(all), checking: false, failed: null, inRepository: false }).rows;
  assert.equal(agentAbout(claude!), "Version 1 · Signed in");
  assert.equal(agentAbout(grok!), "Version 1 · Signed out");
  assert.equal(agentAbout(agentList({ known: null, checking: true, failed: null, inRepository: false }).rows[1]!), "Checking…");
});

test("the agents last checked are read back from the device part by part; anything else is nothing known", () => {
  assert.equal(readKnownAgents(null), null);
  assert.equal(readKnownAgents("not json"), null);
  assert.equal(readKnownAgents('{"agents":3}'), null);
  assert.deepEqual(readKnownAgents(JSON.stringify([{ agent: "codex", name: "Codex", problem: null, version: "0.172.0", state: "Available" }, { agent: "grok", problem: "Signed out.", state: 3 }, { agent: 4 }])), [
    { agent: "codex", name: "Codex", problem: null, version: "0.172.0", state: "Available", chat: null },
    { agent: "grok", name: "Grok", problem: "Signed out.", version: null, state: "Unavailable", chat: null },
  ]);
});

test("the chip names the model with the agent as its qualifier; an agent's own default is the agent's name alone", () => {
  assert.deepEqual(chipWords("Claude Code's default", "Claude Code"), { value: "Claude Code", qualifier: null });
  assert.deepEqual(chipWords("Codex's default", "Codex"), { value: "Codex", qualifier: null });
  assert.deepEqual(chipWords("Haiku 5.5", "Claude Code"), { value: "Haiku 5.5", qualifier: "Claude Code" });
  assert.deepEqual(chipWords("Ask several", "3 agents"), { value: "Ask several", qualifier: "3 agents" });
});

test("the Add context row for the agent names the agent, or how many are asked", () => {
  assert.equal(agentRowValue({ kind: "one", agent: "claude-code" }), "Claude Code");
  assert.equal(agentRowValue({ kind: "one", agent: "codex" }), "Codex");
  assert.equal(agentRowValue({ kind: "several", agents: ["codex", "grok", "antigravity"] }), "3 agents");
});

test("an agent's models: its default first, then four more, the rest behind More models…, opened when the choice is among them", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(modelsShown(ids, null), { first: ["a", "b", "c", "d"], rest: ["e", "f", "g"], restHoldsChoice: false });
  assert.deepEqual(modelsShown(ids, "f"), { first: ["a", "b", "c", "d"], rest: ["e", "f", "g"], restHoldsChoice: true });
  assert.deepEqual(modelsShown(["a", "b"], "b"), { first: ["a", "b"], rest: [], restHoldsChoice: false });
});

test("the agent's default model is first, under its own name with a default tag, and not listed again unless it is the one chosen", () => {
  const models = [{ id: "opus", label: "Opus 5.5" }, { id: "fable", label: "Fable 5.2" }, { id: "haiku" }];
  assert.deepEqual(defaultFirst("Claude Code", "Fable 5.2", models, null), { label: "Fable 5.2", models: [models[0], models[2]] });
  assert.deepEqual(defaultFirst("Claude Code", "Fable 5.2", models, "fable"), { label: "Fable 5.2", models });
  assert.deepEqual(defaultFirst("Codex", null, models, null), { label: "Codex's default", models });
});
