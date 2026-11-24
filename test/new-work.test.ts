import assert from "node:assert/strict";
import test from "node:test";
import type { StoredEvent } from "../web/src/api/client.ts";
import { compareRound, type AttemptInfo } from "../web/src/app/chat.ts";
import { approvalLevel, chooseIntent, intentOf, INTENTS, queueWords, sendSentence, severalProblem } from "../web/src/app/new-work.ts";
import { parseRoute } from "../web/src/app/route.ts";
import { bannedIn } from "../e2e/voice.ts";

// New chat or task, the levels of a decision and the cards of a round several agents answered, decided without a browser.

const run = { oneTask: false, codexBuilds: false, plansUnasked: false, pullRequest: false, claim: "" };

test("the composer's intent follows what it holds: no repository is a chat with one agent or several, a repository a task or a run", () => {
  assert.equal(intentOf({ repo: { kind: "none" }, kind: "task", pick: { kind: "one", agent: "codex" } }), "question");
  assert.equal(intentOf({ repo: { kind: "none" }, kind: "run", pick: { kind: "several", agents: ["claude-code", "codex"] } }), "several");
  assert.equal(intentOf({ repo: { kind: "known", path: "/r" }, kind: "task", pick: { kind: "several", agents: ["a", "b"] } }), "task");
  assert.equal(intentOf({ repo: { kind: "needed" }, kind: "run", pick: { kind: "one", agent: "claude-code" } }), "run");
});

test("choosing an intent sets only what it must: a task keeps or goes back to a repository or leaves it to be chosen, a chat takes it away", () => {
  const one = { kind: "one" as const, agent: "claude-code" };
  const known = { kind: "known" as const, path: "/r" };
  assert.deepEqual(chooseIntent("task", { repo: { kind: "none" }, pick: one, lastRepo: null, tickable: [] }), { repo: { kind: "needed" }, kind: "task", pick: null });
  assert.deepEqual(chooseIntent("run", { repo: { kind: "none" }, pick: one, lastRepo: known, tickable: [] }), { repo: known, kind: "run", pick: null });
  assert.deepEqual(chooseIntent("run", { repo: known, pick: one, lastRepo: null, tickable: [] }), { repo: known, kind: "run", pick: null });
  assert.deepEqual(chooseIntent("question", { repo: known, pick: one, lastRepo: null, tickable: [] }), { repo: { kind: "none" }, kind: null, pick: null });
  assert.deepEqual(chooseIntent("question", { repo: { kind: "none" }, pick: { kind: "several", agents: ["codex", "grok"] }, lastRepo: null, tickable: [] }), { repo: { kind: "none" }, kind: null, pick: { kind: "one", agent: "codex" } });
  assert.deepEqual(chooseIntent("several", { repo: known, pick: one, lastRepo: null, tickable: ["claude-code", "codex"] }), { repo: { kind: "none" }, kind: null, pick: { kind: "several", agents: ["claude-code", "codex"] } });
  assert.equal(chooseIntent("several", { repo: known, pick: one, lastRepo: null, tickable: ["claude-code"] }), null, "one agent is not several");
  assert.equal(severalProblem(["claude-code"]), "Needs two agents that can answer.");
  assert.equal(severalProblem(["claude-code", "codex"]), null);
});

test("the sentence under the composer says exactly what Send will start, and holds no internal word", () => {
  const base = { repo: "billing-api", agent: "Claude Code", asked: 1, chatScope: null, reads: null, run };
  assert.deepEqual(sendSentence({ ...base, intent: "task" }), { lead: "Send starts one task in billing-api.", rest: "Claude Code works on a new branch, in a separate copy of the repository (a git worktree). Your own files and your branch are not touched." });
  assert.equal(sendSentence({ ...base, intent: "task", repo: null }).lead, "Send starts nothing yet.");
  assert.equal(sendSentence({ ...base, intent: "run", run: { ...run, plansUnasked: true, pullRequest: true, oneTask: true } }).rest, "Claude Code plans one task first, reading a copy it cannot change. Building starts on the plan without your approval. Each accepted task is then opened as a pull request.");
  assert.equal(sendSentence({ ...base, intent: "run" }).rest, "Claude Code plans tasks first, reading a copy it cannot change. Nothing is built until you approve the plan.");
  assert.deepEqual(sendSentence({ ...base, intent: "question", reads: "export-service" }), { lead: "Send asks Claude Code.", rest: "Claude Code answers in a folder of its own, outside your projects. It can read export-service, and never change it." });
  assert.equal(sendSentence({ ...base, intent: "question", agent: "Codex", chatScope: "Codex reads and answers." }).rest, "Codex reads and answers.");
  assert.equal(sendSentence({ ...base, intent: "several", asked: 3 }).lead, "Send asks 3 agents the same question.");
  for (const intent of ["question", "task", "run", "several"] as const) {
    const said = sendSentence({ ...base, intent });
    assert.deepEqual(bannedIn(`${said.lead} ${said.rest}`), [], intent);
  }
  for (const { name, about } of INTENTS) assert.deepEqual(bannedIn(`${name} ${about}`), [], name);
});

test("a request that leaves this Mac is elevated risk; any other is an approval request; the queue is said only when there is one", () => {
  assert.equal(approvalLevel({ tool: "WebFetch", command: "https://example.com" }), "risk");
  assert.equal(approvalLevel({ tool: "WebSearch", command: "retry backoff" }), "risk");
  assert.equal(approvalLevel({ tool: "Bash", command: "curl https://example.com" }), "approval", "a command is not read for where it goes");
  // A fetch aimed at this Mac or its network asks too, and leaves nothing: it is an approval request.
  for (const near of ["http://localhost:3000/x", "http://127.0.0.1:8080", "http://192.168.1.4/", "http://10.0.0.2", "http://172.20.1.1", "http://[::1]:9000/", "http://printer.local/"]) assert.equal(approvalLevel({ tool: "WebFetch", command: near }), "approval", near);
  assert.equal(approvalLevel({ tool: "WebFetch", command: "http://172.32.0.1/" }), "risk");
  assert.equal(approvalLevel({ tool: "WebFetch", command: "not an address" }), "risk", "what cannot be read as an address is not called near");
  assert.equal(queueWords(0, 1), null);
  assert.equal(queueWords(0, 2), "1 of 2");
  assert.equal(queueWords(1, 2), "2 of 2");
});

test("New chat or task has an address of its own", () => {
  assert.deepEqual(parseRoute("#/new"), { screen: "turn", start: null, fresh: true });
  assert.deepEqual(parseRoute("#/turn"), { screen: "turn", start: null });
});

const event = (attemptId: number, id: number, payload: StoredEvent["payload"], ts = `2026-11-23T10:00:${String(id).padStart(2, "0")}Z`): StoredEvent => ({ attemptId, id, turn: 1, ts, type: payload.type, payload });

test("the newest round several agents were asked is one card an agent, in the order asked, each with its own model, reply, calls and end", () => {
  const round = { id: 4, kind: "ask" as const, message: "Fixed or exponential?", compares: null };
  const infos = new Map<number, AttemptInfo>([
    [1, { agent: "claude-code", model: null, round: null }],
    [2, { agent: "claude-code", model: "haiku", round }],
    [3, { agent: "codex", model: "gpt-6-luna", round }],
  ]);
  const events = [
    event(1, 1, { type: "text", text: "An earlier answer." }),
    event(2, 2, { type: "session_started", resumeCursor: "c", model: "claude-haiku-5-5", keySource: null }),
    event(2, 3, { type: "tool_call", id: "t1", name: "Read", input: { file_path: "retry.py" } }),
    event(2, 4, { type: "tool_result", id: "t1", output: "x", isError: false }),
    event(2, 5, { type: "text", text: "Exponential." }),
    event(3, 6, { type: "tool_call", id: "t2", name: "Bash", input: { command: "ls" } }),
    event(3, 8, { type: "permission_denied", id: "t2", name: "Bash", reason: null, code: null }),
    event(3, 9, { type: "error", message: "Codex is signed out.", raw: null }),
    event(3, 10, { type: "turn_ended", reason: "error", detail: "Codex could not be started." }),
    event(2, 7, { type: "turn_ended", reason: "completed", detail: null }),
  ] as StoredEvent[];
  const found = compareRound(events, infos, [1, 2, 3])!;
  assert.equal(found.roundId, 4);
  assert.equal(found.message, "Fixed or exponential?");
  assert.deepEqual(found.cards.map((c) => [c.agent, c.model, c.state, c.texts, c.errors, c.calls.map((call) => call.name)]), [
    ["claude-code", "claude-haiku-5-5", "answered", ["Exponential."], [], ["Read"]],
    ["codex", "gpt-6-luna", "failed", [], ["Codex is signed out."], ["Bash"]],
  ]);
  // An agent that failed says why, and a call that was not run is not counted as done.
  assert.equal(found.cards[1]!.detail, "Codex could not be started.");
  assert.deepEqual(found.cards[1]!.calls.map((call) => call.refused), [true]);
  assert.deepEqual(found.cards[0]!.calls.map((call) => call.refused), [false]);
  assert.equal(compareRound(events.slice(0, 5), infos, [1, 2, 3])!.cards[0]!.state, "working");
  assert.equal(found.cards[0]!.from, "2026-11-23T10:00:02Z");
  assert.equal(found.cards[0]!.to, "2026-11-23T10:00:07Z");
  assert.equal(compareRound(events, infos, [1]), null, "a round that asked one agent has no cards");
  assert.equal(compareRound(events, new Map([...infos, [5, { agent: "codex", model: null, round: { id: 6, kind: "compare" as const, message: "", compares: 4 } }]]), [1, 2, 3, 5]), null, "nor has a round that asked one to compare");
});
