import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTurns } from "../../src/api/turns.ts";
import { actionLog, createBroker, type Approval } from "../../src/approvals/broker.ts";
import { setChatWebAccess, type WebAccess } from "../../src/approvals/web-access.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// A chat's real Claude Code on its cheapest model, through Botbench's chat path, driver and broker, asked outright to
// fetch https://example.com. Three cheap turns: with the default setting it fetches with no approval; with Ask it waits
// for the owner, and allowed it reads the page; with Ask and denied it does not fetch.

const PROMPT = "Fetch https://example.com and tell me its title.";

async function chatTurn(web: WebAccess, answer: (broker: ReturnType<typeof createBroker>, approval: Approval) => void, prompt = PROMPT) {
  const dir = tempDir("botbench-live-chat-approval-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  setChatWebAccess(db, web);
  const asked: Approval[] = [];
  const broker = createBroker({
    db,
    home,
    onChange: (approval) => {
      if (approval.status !== "pending") return;
      asked.push(approval);
      setTimeout(() => answer(broker, approval), 100);
    },
  });
  await broker.listen();
  const turns = createTurns({ db, home, driver: new ClaudeCodeDriver(), broker, model: "haiku", onEvent: () => {} });
  try {
    const { attemptId } = await turns.start(prompt);
    for (let i = 0; i < 1800 && turns.turnRunning(attemptId); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const events = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);
    const fetches = events.filter((e): e is Extract<DriverEvent, { type: "tool_call" }> => e.type === "tool_call" && e.name === "WebFetch");
    const results = events.filter((e): e is Extract<DriverEvent, { type: "tool_result" }> => e.type === "tool_result" && fetches.some((f) => f.id === e.id) && !e.output.includes("InputValidationError"));
    const text = events.filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("");
    const shell = events.filter((e): e is Extract<DriverEvent, { type: "tool_call" }> => e.type === "tool_call" && e.name === "Bash");
    const shellResults = events.filter((e): e is Extract<DriverEvent, { type: "tool_result" }> => e.type === "tool_result" && shell.some((c) => c.id === e.id));
    return { events, asked, results, shell, shellResults, text, log: actionLog(db), end: events.findLast((e) => e.type === "turn_ended") };
  } finally {
    await turns.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("LIVE: with web access in chat at its default, a real chat turn fetches the page with no approval and names its title", { timeout: 300_000 }, async () => {
  const turn = await chatTurn("allow", () => assert.fail("nothing should be put to the owner"));
  assert.deepEqual(turn.asked, []);
  assert.ok(turn.results.some((r) => !r.isError && /Example Domain/.test(r.output)), JSON.stringify(turn.events));
  assert.match(turn.text, /Example Domain/);
  assert.ok(turn.log.some((e) => e.rule === "chat_web_access" && e.tool === "WebFetch"));
});

test("LIVE: with Ask, a real chat turn waits for the owner's approval of the fetch; allowed, it names the page's title", { timeout: 300_000 }, async () => {
  const turn = await chatTurn("ask", (broker, approval) => broker.answer(approval.id, "allow"));
  // The model may fetch more than once (once a redirect, say); each fetch is put to the owner, and nothing else is.
  assert.ok(turn.asked.length >= 1);
  assert.deepEqual(new Set(turn.asked.map((a) => `${a.tool} ${a.chat}`)), new Set(["WebFetch true"]));
  assert.match(turn.text, /Example Domain/);
  const rules = turn.log.filter((e) => e.tool === "WebFetch").map((e) => e.rule);
  assert.deepEqual(rules, turn.asked.flatMap(() => ["asked_owner", "owner_allowed"]));
});

test("LIVE: with Ask, a real chat turn whose fetch the owner denied does not fetch", { timeout: 300_000 }, async () => {
  const turn = await chatTurn("ask", (broker, approval) => broker.answer(approval.id, "decline", "Do not fetch it."));
  assert.ok(turn.asked.length >= 1);
  assert.ok(turn.results.length > 0 && turn.results.every((r) => /denied this request, so it was not run/.test(r.output)), JSON.stringify(turn.results));
  assert.equal(turn.log.some((e) => e.rule === "owner_allowed" || e.rule === "chat_web_access"), false);
  assert.equal((turn.end as { reason: string } | undefined)?.reason, "completed");
});

test("LIVE: a chat turn that runs ls in its own folder shows no card: the confined command runs as it would in Claude Code itself", { timeout: 300_000 }, async () => {
  const turn = await chatTurn("allow", () => assert.fail("nothing should be put to the owner"), "Run the shell command `ls -la` with your Bash tool, exactly once, then tell me how many entries it listed.");
  assert.deepEqual(turn.asked, []);
  assert.ok(turn.shell.length >= 1, JSON.stringify(turn.events));
  assert.ok(turn.shellResults.some((r) => !r.isError), JSON.stringify(turn.shellResults));
  assert.ok(turn.log.some((e) => e.rule === "chat_confined" && e.tool === "Bash"));
  assert.equal((turn.end as { reason: string } | undefined)?.reason, "completed");
});
