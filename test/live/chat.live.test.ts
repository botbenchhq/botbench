import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createChat } from "../../src/api/chat.ts";
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
// to be written, without Botbench's prompt telling the model not to, and each must answer in text and write nothing.
// Three cheap turns.

test("LIVE: one chat message to each of Codex, Grok and Antigravity returns a reply in text, and no file is written", { timeout: 300_000 }, async (t) => {
  const dir = tempDir("botbench-live-chat-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const db = openStore(home);
  const claude = new ClaudeCodeDriver();
  const turns = createTurns({ db, home, driver: claude, onEvent: () => {} });
  const chat = createChat({ db, home, turns, claude, agents: { codex: new CodexDriver(), grok: new GrokDriver(), antigravity: new AntigravityDriver() }, onEvent: () => {} });
  t.after(async () => {
    await chat.close();
    await turns.close();
    db.close();
  });
  const target = path.join(dir, "written.txt");
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
  assert.deepEqual(fs.readdirSync(path.join(home, "reviewers")), [], "each empty folder is gone");
});
