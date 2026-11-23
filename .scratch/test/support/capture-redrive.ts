import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createBroker, listApprovals } from "../../src/approvals/broker.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverSession } from "../../src/drivers/contract.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { createTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { initRepo, tempDir } from "./repo.ts";

/*
 * Makes test/recordings/redrive-other-request.json. Run by hand, on the owner's login, when the recording
 * must be made again (two turns on the cheapest model):
 *   node test/support/capture-redrive.ts
 *
 * What it records is a real Claude Code session, driven through Botbench's own driver and permission broker:
 *   attempt 1  is asked to run `sh make-marker.sh`, asks for permission, and is stopped while it waits.
 *   attempt 2  resumes that session and is told to run `sh other.sh` instead; it asks for permission
 *              for that, is allowed, runs it and ends its turn.
 * Attempt 2 is the scenario a model cannot be made to produce on demand under Botbench's own words after a
 * restart: a resumed turn whose first permission request is not the one that was waiting. The second
 * prompt here is the capture's own, and the recording says so.
 */

const FIRST_PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";
const SECOND_PROMPT = "Do not run that command after all. Run the command `sh other.sh` with your Bash tool instead, exactly once. Then reply with the single word: done";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "redrive-other-request.json");

const dir = tempDir("botbench-capture-");
const home = path.join(dir, "home");
const repo = path.join(dir, "repo");
initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n', "other.sh": '#!/bin/sh\necho other > "$(dirname "$0")/other.txt"\n' });
const db = openStore(home);
const broker = createBroker({ db, home, onChange: () => {} });
await broker.listen();
const driver = new ClaudeCodeDriver();
const taskId = createTask(db, { repo, prompt: FIRST_PROMPT }).id;

/** One attempt as Botbench's engine runs it: its permission requests go to the broker and wait there. */
async function attempt(prompt: string, resumeCursor: string | undefined, onAsked: (session: DriverSession, approvalId: number) => Promise<void>): Promise<DriverSession> {
  const admission = broker.admit({ taskId, role: "implementer", worktree: repo });
  const session = await driver.startAttempt({ db, cwd: repo, allowEdits: true, gate: admission, model: "haiku", confinement: { dataDir: home, allowedHosts: [] }, ...(resumeCursor === undefined ? {} : { resumeCursor }) });
  admission.bind(session.attemptId);
  session.onEvent((event: DriverEvent) => {
    if (event.type !== "permission_request") return;
    void broker
      .request({ taskId, attemptId: session.attemptId, role: "implementer", tool: event.name, command: summarize(event.name, event.input), reason: event.reason, toolCallId: event.toolCallId })
      .then((answer) => session.respondToRequest(event.id, answer))
      .catch(() => {});
    const asked = broker.pending().at(-1)!;
    void onAsked(session, asked.id);
  });
  await session.sendTurn(prompt);
  await session.close();
  admission.release();
  return session;
}

const eventsOf = (attemptId: number): DriverEvent[] => db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);

const first = await attempt(FIRST_PROMPT, undefined, (session) => session.close());
const cursor = first.resumeCursor();
if (cursor === null) throw new Error("The first attempt gave no resume cursor.");
const second = await attempt(SECOND_PROMPT, cursor, async (_session, approvalId) => void broker.answer(approvalId, "allow"));

const approvals = listApprovals(db).map(({ attemptId, tool, command, cwd, toolCallId, status }) => ({ attempt: attemptId === first.attemptId ? 1 : 2, tool, command, cwd, toolCallId, status }));
const recording = {
  about: "A real Claude Code session, recorded through Botbench's driver and permission broker by test/support/capture-redrive.ts. Attempt 1 asked to run `sh make-marker.sh` and was stopped while it waited. Attempt 2 resumed the session under the capture's own prompt (not the one Botbench sends after a restart) and asked to run `sh other.sh` instead, was allowed, and finished.",
  cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  model: "haiku",
  recordedAt: new Date().toISOString(),
  resumeCursor: cursor,
  prompts: [FIRST_PROMPT, SECOND_PROMPT],
  /** What the pre-tool hook reported for each request: the directory, relative to the worktree. */
  approvals,
  attempts: [eventsOf(first.attemptId), eventsOf(second.attemptId)],
};
if (!fs.existsSync(path.join(repo, "other.txt")) || fs.existsSync(path.join(repo, "marker.txt"))) throw new Error("The session did not go as the recording needs: other.sh must have run and make-marker.sh must not.");
fs.writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`);
await broker.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Recorded ${recording.attempts[1]!.length} events of the resumed attempt to ${OUT}`);
