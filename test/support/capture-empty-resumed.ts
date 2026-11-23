import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBroker } from "../../src/approvals/broker.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverSession } from "../../src/drivers/contract.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import type { CliChild } from "../../src/drivers/launch.ts";
import { createTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { checkRecording } from "./recording-check.ts";
import { initRepo, tempDir } from "./repo.ts";

/*
 * Makes test/fixtures/empty-resumed-turn/turn.json. Run by hand, on the owner's login, when it must be made again
 * (two short turns on the cheapest model):
 *   node test/support/capture-empty-resumed.ts
 *
 * What it records is a real Claude Code session, driven through Botbench's own driver and permission broker, the way
 * a build and then its round of fixes run (issue #111):
 *   attempt 1  is asked to start `sleep 600` as a background shell command and end its turn; the command is allowed,
 *              and the session is closed while that command still runs, as Botbench closes a build's session.
 *   attempt 2  resumes that session (`--resume`) and is sent a prompt, as a round of fixes is.
 * On resuming, the CLI first queues a notice of its own that the background command did not finish before the
 * previous session ended, and answers it with a `result` before it reads Botbench's prompt. That result is what the
 * driver took as the end of the round: no reply, no change, about four seconds. The raw lines the CLI printed in
 * attempt 2 are kept next to the driver's events, so the recording shows what the CLI sent, not only what Botbench
 * made of it.
 * `events` are what the driver at the time of recording stored. Recorded on the driver before the fix of #111, they
 * end the turn at the CLI's own result; on the fixed driver the turn ends at the prompt's result. The engine tests
 * replay the first, so remake the fixture with src/drivers/claude-code.ts as it was before the fix (commit 6ba063c).
 */

const FIRST_PROMPT = "Use your Bash tool with run_in_background set to true to start the command `sleep 600`, exactly once. Do not wait for it and do not check on it. Then reply with the single word: started";
const SECOND_PROMPT = "Reply with the single word: done";
const OUT = path.resolve(import.meta.dirname, "..", "fixtures", "empty-resumed-turn", "turn.json");

const dir = tempDir("botbench-capture-");
const home = path.join(dir, "home");
const repo = path.join(dir, "repo");
initRepo(repo, { "README.md": "# Sample\n" });
const db = openStore(home);
const broker = createBroker({ db, home, onChange: () => {} });
await broker.listen();
const driver = new ClaudeCodeDriver();
const taskId = createTask(db, { repo, prompt: FIRST_PROMPT }).id;

/** One attempt as Botbench's engine runs it, every permission request allowed; the CLI's stdout lines are kept as printed. */
async function attempt(prompt: string, resumeCursor: string | undefined): Promise<{ session: DriverSession; raw: { at: string; line: unknown }[] }> {
  const admission = broker.admit({ taskId, role: "implementer", worktree: repo });
  const session = await driver.startAttempt({ db, cwd: repo, allowEdits: true, gate: admission, model: "haiku", confinement: { dataDir: home, allowedHosts: [] }, ...(resumeCursor === undefined ? {} : { resumeCursor }) });
  admission.bind(session.attemptId);
  const raw: { at: string; line: unknown }[] = [];
  let pending = "";
  // The session's child process is not part of the driver contract; the capture reads its output beside the driver.
  (session as unknown as { child: CliChild }).child.stdout.on("data", (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop()!;
    // The one change: the owner's home folder (in the init line's memory paths) is written as "~".
    for (const line of lines) if (line.trim() !== "") raw.push({ at: new Date().toISOString(), line: JSON.parse(line.replaceAll(os.homedir(), "~")) });
  });
  session.onEvent((event: DriverEvent) => {
    if (event.type !== "permission_request") return;
    void broker
      .request({ taskId, attemptId: session.attemptId, role: "implementer", tool: event.name, command: summarize(event.name, event.input), reason: event.reason, toolCallId: event.toolCallId })
      .then((answer) => session.respondToRequest(event.id, answer))
      .catch(() => {});
    void broker.answer(broker.pending().at(-1)!.id, "allow");
  });
  await session.sendTurn(prompt);
  await session.close();
  admission.release();
  return { session, raw };
}

const eventsOf = (attemptId: number): DriverEvent[] => db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);

const first = await attempt(FIRST_PROMPT, undefined);
const cursor = first.session.resumeCursor();
if (cursor === null) throw new Error("The first attempt gave no resume cursor.");
if (!eventsOf(first.session.attemptId).some((e) => e.type === "tool_call" && JSON.stringify(e.input).includes('"run_in_background":true'))) throw new Error("The first attempt started no background command; the recording needs one.");
const second = await attempt(SECOND_PROMPT, cursor);
const events = eventsOf(second.session.attemptId);
if (!second.raw.some((r) => { const line = r.line as { type?: unknown; origin?: unknown }; return line.type === "result" && line.origin !== undefined; })) throw new Error("The resumed attempt printed no result of the CLI's own; the session did not go as the recording needs.");

const recording = {
  about:
    "A real Claude Code session, recorded through Botbench's driver and permission broker by test/support/capture-empty-resumed.ts (issue #111). Attempt 1 started `sleep 600` as a background shell command and ended its turn; its session was closed while the command ran. Attempt 2 resumed that session with `--resume` and was sent a prompt. `firstAttempt` and `events` are the driver's events of attempts 1 and 2 as Botbench stored them, before the fix of #111, unchanged; `raw` is every line the CLI printed in attempt 2, unchanged but for the owner's home folder, written as ~. The CLI answered the notice it queued itself on resuming (the background command did not finish before the previous session ended) with a result of no turns and no usage, before it read the prompt, and the driver took that result as the end of the turn: its turn_ended has no reply and no usage. The CLI then read the prompt and answered it: the text and the second usage come after that turn_ended, recorded while Botbench was closing the session, and were never taken as the round's reply.",
  cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  model: "haiku",
  recordedAt: new Date().toISOString(),
  resumeCursor: cursor,
  prompts: [FIRST_PROMPT, SECOND_PROMPT],
  firstAttempt: eventsOf(first.session.attemptId),
  events,
  raw: second.raw,
};
const text = `${JSON.stringify(recording, null, 2)}\n`;
checkRecording(text.split("\n"));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
await broker.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Recorded ${recording.events.length} events and ${recording.raw.length} raw lines of the resumed attempt to ${OUT}`);
