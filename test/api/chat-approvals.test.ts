import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createChat } from "../../src/api/chat.ts";
import { createTurns } from "../../src/api/turns.ts";
import { actionLog, createBroker, type Approval } from "../../src/approvals/broker.ts";
import { setChatWebAccess, WEB_OFF, type WebAccess } from "../../src/approvals/web-access.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { openStore } from "../../src/store/db.ts";
import { claudeChatReplay, type ClaudeChatSession } from "../support/replay-chat.ts";
import { tempDir } from "../support/repo.ts";

// A chat's Claude Code asking for approval, through the chat itself (src/api/chat.ts and turns.ts), the real broker and
// its socket, on real SQLite. Claude Code replays a real chat turn that asked to fetch https://example.com, recorded
// through this same path (test/support/capture-chat-fetch.ts); its calls are put to the real gate as its hook put them.

type T = { after(fn: () => unknown): void };
const PROMPT = "Fetch https://example.com and tell me its title.";

async function setup(t: T, sessions: ClaudeChatSession[], web: WebAccess) {
  const dir = tempDir("botbench-chat-approvals-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  setChatWebAccess(db, web);
  const announced: Approval[] = [];
  const broker = createBroker({ db, home, onChange: (approval) => announced.push(approval) });
  await broker.listen();
  const claude = claudeChatReplay(sessions);
  const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
  const chat = createChat({ db, home, turns, claude, agents: {}, onEvent: () => {} });
  t.after(async () => {
    await chat.close();
    await turns.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, broker, turns, chat, claude, announced };
}

const events = (db: DatabaseSync, attemptId: number): DriverEvent[] => db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((r) => JSON.parse(String(r.payload)) as DriverEvent);
const reply = (db: DatabaseSync, attemptId: number): string => events(db, attemptId).filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
const ended = (db: DatabaseSync, attemptId: number) => events(db, attemptId).find((e): e is Extract<DriverEvent, { type: "turn_ended" }> => e.type === "turn_ended");

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), what);
}

test("Ask: a chat's fetch waits as an approval of that chat, announced once; Allow once continues the turn and the reply arrives", async (t) => {
  const { db, broker, turns, chat, claude, announced } = await setup(t, ["allowed"], "ask");
  const [started] = await chat.send({ message: PROMPT, conversation: [], agents: [{ agent: "claude-code", model: null }] });
  const attemptId = started!.attemptId;
  await until("the fetch waits for the owner", () => broker.pending().length === 1);
  const [card] = broker.pending();
  assert.deepEqual([card!.chat, card!.taskId, card!.runId, card!.attemptId, card!.tool], [true, null, null, attemptId, "WebFetch"]);
  assert.equal(JSON.parse(card!.command).url, "https://example.com");
  assert.equal(turns.turnRunning(attemptId), true, "the turn waits");
  assert.equal(reply(db, attemptId), "", "no reply before the answer");
  assert.deepEqual(announced.filter((a) => a.status === "pending").map((a) => a.id), [card!.id], "the tray and the notification hear of it once");
  // It was started gated, in the chat's folder, with no host for its commands.
  assert.ok(claude.started[0]!.gate !== undefined);
  assert.deepEqual(claude.started[0]!.confinement.allowedHosts, []);

  broker.answer(card!.id, "allow");
  await until("the turn ends", () => !turns.turnRunning(attemptId));
  assert.equal(ended(db, attemptId)?.reason, "completed");
  assert.match(reply(db, attemptId), /Example Domain/);
  // The CLI loaded the fetch tool first (ToolSearch), which ran and is logged.
  assert.deepEqual(actionLog(db).map((e) => e.rule), ["bookkeeping", "asked_owner", "owner_allowed"]);
});

test("Ask: Deny with what to do instead hands Claude Code the note, the fetch is not run, and the turn ends cleanly", async (t) => {
  const { db, broker, turns, chat, claude } = await setup(t, ["declined"], "ask");
  const [started] = await chat.send({ message: PROMPT, conversation: [], agents: [{ agent: "claude-code", model: null }] });
  await until("the fetch waits for the owner", () => broker.pending().length === 1);
  broker.answer(broker.pending()[0]!.id, "decline", "Do not fetch it. Answer from what you already know.");
  await until("the turn ends", () => !turns.turnRunning(started!.attemptId));
  assert.deepEqual(claude.responses, [{ decision: "decline", note: "Do not fetch it. Answer from what you already know.", refused: null, files: false, web: false, chat: false, bookkeeping: false }]);
  const all = events(db, started!.attemptId);
  const fetch = all.find((e): e is Extract<DriverEvent, { type: "tool_call" }> => e.type === "tool_call" && e.name === "WebFetch")!;
  const result = all.find((e): e is Extract<DriverEvent, { type: "tool_result" }> => e.type === "tool_result" && e.id === fetch.id)!;
  assert.match(result.output, /denied this request, so it was not run/);
  assert.equal(ended(db, started!.attemptId)?.reason, "completed");
  assert.deepEqual(broker.pending(), []);
});

test("Allow, the default: the fetch runs with no card, and is logged under the setting", async (t) => {
  const { db, broker, turns, chat, claude, announced } = await setup(t, ["allowed"], "allow");
  const [started] = await chat.send({ message: PROMPT, conversation: [], agents: [{ agent: "claude-code", model: null }] });
  await until("the turn ends", () => !turns.turnRunning(started!.attemptId));
  assert.deepEqual(announced, [], "nothing was put to the owner");
  assert.deepEqual(broker.pending(), []);
  assert.deepEqual(claude.responses, [{ decision: "allow", note: null, refused: null, files: false, web: true, chat: false, bookkeeping: false }]);
  assert.match(reply(db, started!.attemptId), /Example Domain/);
  assert.deepEqual(actionLog(db).map((e) => [e.rule, e.tool]), [["bookkeeping", "ToolSearch"], ["chat_web_access", "WebFetch"]]);
});

test("Off: the fetch is refused without a card, and Claude Code is told where to turn it on", async (t) => {
  const { turns, chat, claude, announced } = await setup(t, ["declined"], "off");
  const [started] = await chat.send({ message: PROMPT, conversation: [], agents: [{ agent: "claude-code", model: null }] });
  await until("the turn ends", () => !turns.turnRunning(started!.attemptId));
  assert.deepEqual(announced, []);
  assert.deepEqual(claude.responses, [{ decision: "decline", note: null, refused: WEB_OFF, files: false, web: false, chat: false, bookkeeping: false }]);
});

test("Stop while a fetch waits: the card is no longer answerable", async (t) => {
  const { broker, turns, chat } = await setup(t, ["allowed"], "ask");
  const [started] = await chat.send({ message: PROMPT, conversation: [], agents: [{ agent: "claude-code", model: null }] });
  await until("the fetch waits for the owner", () => broker.pending().length === 1);
  const id = broker.pending()[0]!.id;
  await turns.interrupt(started!.attemptId);
  await until("the card is gone", () => broker.pending().length === 0);
  assert.throws(() => broker.answer(id, "allow"));
});
