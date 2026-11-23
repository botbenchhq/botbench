import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createBroker, permissionResponse } from "../../src/approvals/broker.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { createTask } from "../../src/engine/task.ts";
import { draftRules, parseDrafts } from "../../src/peers/drafts.ts";
import { openStore } from "../../src/store/db.ts";
import { checkRecording } from "./recording-check.ts";
import { initRepo, tempDir } from "./repo.ts";

/*
 * Makes test/recordings/peer-draft.json, a NEW file: it refuses to run when the file is already there, so no recording
 * is ever changed by it. Run by hand, once, on the owner's login (one turn on the cheapest model):
 *   node test/support/capture-peer-draft.ts
 *
 * What it records is a real Claude Code session, driven as a task's builder is, through Botbench's own driver,
 * permission check and broker, given the task's words and then Botbench's own instructions for drafting a message to a
 * paired workbench named bob (src/peers/drafts.ts draftRules), as a builder in a paired repository is. It stops,
 * writing nothing, unless the reply holds exactly one botbench-peer-message block that Botbench parses as a question.
 * Every request for permission is declined, so nothing runs; the turn is only asked to reply.
 */

const TASK = "Do not use any tool. You need to know which port bob's login service listens on, and you cannot find it here. Reply with one sentence, then ask bob's workbench for it.";
const PROMPT = `${TASK}\n\n${draftRules({ peerName: "bob" }, { given: null, cap: 5 })}`;
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "peer-draft.json");

if (fs.existsSync(OUT)) {
  console.error(`${OUT} already exists. This script only ever adds it; nothing was changed. Delete it first to record again.`);
  process.exit(1);
}

const dir = tempDir("botbench-capture-");
const home = path.join(dir, "home");
const repo = path.join(dir, "repo");
initRepo(repo, { "README.md": "# Login\n" });
const db = openStore(home);
const broker = createBroker({ db, home, onChange: () => {} });
await broker.listen();
const driver = new ClaudeCodeDriver();
const taskId = createTask(db, { repo, prompt: TASK }).id;
const admission = broker.admit({ taskId, role: "implementer", worktree: repo, confined: true });
const session = await driver.startAttempt({ db, cwd: repo, allowEdits: true, gate: admission, model: "haiku", confinement: { dataDir: home, allowedHosts: [] } });
admission.bind(session.attemptId);
session.onEvent((event: DriverEvent) => {
  if (event.type !== "permission_request") return;
  void broker
    .request({ taskId, attemptId: session.attemptId, role: "implementer", tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
    .then((answer) => session.respondToRequest(event.id, permissionResponse(answer)))
    .catch((err: unknown) => console.error(`The answer could not be given: ${String(err)}`));
  setImmediate(() => {
    for (const card of broker.pending()) broker.answer(card.id, "decline", "Do not use any tool: only reply.");
  });
});
const limit = setTimeout(() => void session.interruptTurn(), 5 * 60_000);
const end = await session.sendTurn(PROMPT);
clearTimeout(limit);
await session.close();
admission.release();

const events = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(session.attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);
const texts = events.filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text").map((e) => e.text);
const drafts = texts.flatMap(parseDrafts);
if (end !== "completed" || drafts.length !== 1 || !("kind" in drafts[0]!) || drafts[0]!.kind !== "question") {
  console.error(`The turn ended ${end} with ${drafts.length} draft blocks (${JSON.stringify(drafts).slice(0, 300)}), not one question. Nothing was written. Its texts:`);
  for (const text of texts) console.error(text.slice(0, 600));
  process.exit(1);
}

const recording = {
  about:
    "A real Claude Code session, recorded through Botbench's driver, permission check and broker by test/support/capture-peer-draft.ts, as a task's builder in a repository paired with bob's workbench is driven: given the task's words and Botbench's instructions for drafting (src/peers/drafts.ts draftRules), it replied with one botbench-peer-message block holding a question. `events` is the whole attempt as Botbench stored it.",
  cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  model: "haiku",
  recordedAt: new Date().toISOString(),
  prompt: PROMPT,
  events,
};
const text = `${JSON.stringify(recording, null, 2)}\n`;
checkRecording(text.split("\n"));
fs.writeFileSync(OUT, text, { flag: "wx" });
await broker.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Recorded ${events.length} events to ${OUT}, with the draft ${JSON.stringify(drafts[0])}.`);
