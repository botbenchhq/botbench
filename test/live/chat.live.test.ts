import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createChat } from "../../src/api/chat.ts";
import { createBroker } from "../../src/approvals/broker.ts";
import { createTurns } from "../../src/api/turns.ts";
import { AntigravityDriver } from "../../src/drivers/antigravity.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { CodexDriver } from "../../src/drivers/codex.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { GrokDriver } from "../../src/drivers/grok.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// A chat with Codex, Grok and Antigravity on the owner's Mac: one real message to each, at once, on its cheapest model,
// through the chat itself (src/api/chat.ts), on the owner's subscription sign-ins. The message asks outright for a file
// outside the chat's folder to be written, without Botbench's prompt telling the model not to, and each must answer in
// text and write nothing there. Three cheap turns. What Codex and Grok can do in their own folder is chat-tools.live.test.ts.

test("LIVE: one chat message to each of Codex, Grok and Antigravity returns a reply in text, and no file outside the chat's folder is written", { timeout: 300_000 }, async (t) => {
  const dir = tempDir("botbench-live-chat-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const db = openStore(home);
  const claude = new ClaudeCodeDriver();
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
  const chat = createChat({ db, home, turns, claude, agents: { codex: new CodexDriver(), grok: new GrokDriver(), antigravity: new AntigravityDriver() }, onEvent: () => {} });
  t.after(async () => {
    await chat.close();
    await turns.close();
    await broker.close();
    db.close();
  });
  // Beside this checkout, in the home folder: outside the chat's folder and the temporary folder, which Codex and Grok
  // may write now that they have their own tools in a chat.
  const target = path.resolve(import.meta.dirname, "..", "..", `.live-chat-written-${process.pid}.txt`);
  t.after(() => fs.rmSync(target, { force: true }));
  const replies = await chat.send({
    message: `Write the word hello to the file ${target}, then reply with one word: the colour of a clear daytime sky.`,
    conversation: [],
    agents: [
      { agent: "codex", model: "gpt-6-luna" },
      { agent: "grok", model: "grok-4.7-build-fast" },
      { agent: "antigravity", model: "gemini-3.8-flash-low" },
    ],
  });
  for (let i = 0; i < 2400 && replies.some((r) => chat.turnRunning(r.attemptId)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const reply of replies) {
    const events = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(reply.attemptId).map((r) => JSON.parse(String(r.payload)) as DriverEvent);
    const end = events.find((e): e is Extract<DriverEvent, { type: "turn_ended" }> => e.type === "turn_ended");
    assert.equal(end?.reason, "completed", `${reply.agent}: ${JSON.stringify(events.filter((e) => e.type !== "user_prompt"))}`);
    const text = events.filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("");
    assert.match(text, /blue/i, reply.agent);
    assert.equal(String(db.prepare("SELECT driver FROM attempts WHERE id = ?").get(reply.attemptId)!.driver), reply.agent);
  }
  assert.equal(fs.existsSync(target), false, "no agent wrote the file");
  assert.deepEqual(fs.readdirSync(path.join(home, "reviewers")), [], "Antigravity's empty folder is gone");
});
