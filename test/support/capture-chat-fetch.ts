import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { actionLog, createBroker } from "../../src/approvals/broker.ts";
import { setChatWebAccess } from "../../src/approvals/web-access.ts";
import { createTurns } from "../../src/api/turns.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { openStore } from "../../src/store/db.ts";
import { checkRecording } from "./recording-check.ts";
import { tempDir } from "./repo.ts";

/*
 * Makes test/recordings/chat-fetch.json. Run by hand, on the owner's login, when the recording must be made again (two
 * cheap turns on the cheapest model):
 *   node test/support/capture-chat-fetch.ts
 *
 * What it records are real Claude Code chat turns, driven through Botbench's own chat path (src/api/turns.ts), driver
 * and permission broker, with "Web access in chat" set to Ask. Each is asked to fetch https://example.com; the fetch
 * waits as an approval, and this script answers it as the owner would: the first is allowed once and Claude Code reads
 * the page, the second is denied with a note and Claude Code answers without it. Those are the scenarios the engine
 * and screen tests replay. Nothing is taken out of the lines; the script stops before writing if one looks like it holds
 * a secret, an e-mail address or a path in the owner's home folder.
 */

const PROMPT = "Fetch https://example.com and tell me its title.";
const NOTE = "Do not fetch it. Answer from what you already know.";
const MODEL = "haiku";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "chat-fetch.json");

const dir = tempDir("botbench-capture-chat-fetch-");
const home = path.join(dir, "home");
const db = openStore(home);
setChatWebAccess(db, "ask");
const broker = createBroker({
  db,
  home,
  onChange: (approval) => {
    if (approval.status !== "pending") return;
    // The owner's answer: Allow once for the first turn's request, Deny with a note for the second's.
    setTimeout(() => (turn === 1 ? broker.answer(approval.id, "allow") : broker.answer(approval.id, "decline", NOTE)), 200);
  },
});
await broker.listen();
const driver = new ClaudeCodeDriver();
const turns = createTurns({ db, home, driver, broker, model: MODEL, onEvent: () => {} });

let turn = 0;
const sessions: Record<string, DriverEvent[]> = {};
for (const name of ["allowed", "declined"]) {
  turn += 1;
  const { attemptId } = await turns.start(PROMPT);
  for (let i = 0; i < 1800 && turns.turnRunning(attemptId); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  sessions[name] = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);
}
await turns.close();
const log = actionLog(db).map(({ rule, tool, detail }) => ({ rule, tool, detail }));
await broker.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

for (const [name, events] of Object.entries(sessions)) {
  const asked = events.filter((e) => e.type === "permission_request");
  if (asked.length !== 1 || (asked[0] as { name: string }).name !== "WebFetch" || events.at(-1)?.type !== "turn_ended") {
    throw new Error(`The ${name} turn did not go as the recording needs (one fetch asked for, then the end of the turn): ${JSON.stringify(events)}`);
  }
}
const recording = {
  about: "Real Claude Code chat turns, recorded through Botbench's chat path, driver and permission broker by test/support/capture-chat-fetch.ts, with Web access in chat set to Ask. Each was asked to fetch https://example.com. The fetch asked for approval; in `allowed` the owner allowed it once and Claude Code read the page, in `declined` the owner denied it with a note.",
  cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  model: MODEL,
  recordedAt: new Date().toISOString(),
  prompt: PROMPT,
  note: NOTE,
  log,
  sessions,
};
const text = `${JSON.stringify(recording, null, 2)}\n`;
checkRecording(text.split("\n"));
fs.writeFileSync(OUT, text);
console.log(`Recorded ${Object.values(sessions).map((s) => s.length).join(" and ")} events to ${OUT}`);
