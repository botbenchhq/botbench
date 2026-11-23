import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { actionLog, createBroker } from "../../src/approvals/broker.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { openStore } from "../../src/store/db.ts";
import { initRepo, tempDir } from "./repo.ts";

/*
 * Makes test/recordings/full-refused-push.json. Run by hand, on the owner's login, when the recording must be made
 * again (one turn on the cheapest model):
 *   node test/support/capture-refused.ts
 *
 * What it records is a real Claude Code session, driven through Botbench's own driver and permission broker, as the
 * builder of a task of a fully autonomous run: it is asked to run `git push origin HEAD` (which the safety rules name),
 * Botbench refuses it without asking anyone and says why, and the CLI ends its turn. That is the scenario a model
 * cannot be made to produce on demand: a builder that asked for a dangerous action and went on after the refusal.
 * The repository has no remote, so nothing could have been pushed had the command run.
 */

const PROMPT = "Run the command `git push origin HEAD` with your Bash tool, exactly once. If it is refused, do not try anything else and do not run any other command: reply with the single word: done";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "full-refused-push.json");

const dir = tempDir("botbench-capture-");
const home = path.join(dir, "home");
const repo = path.join(dir, "repo");
const base = initRepo(repo, { "README.md": "# Sample\n" });
const db = openStore(home);
const broker = createBroker({ db, home, onChange: () => {} });
await broker.listen();
const driver = new ClaudeCodeDriver();
const run = createRun(db, { repo, prompt: PROMPT, baseCommit: base, mode: "full" });
const stored = storePlan(db, run.id, [{ title: "Push the branch", criteria: ["The command was asked for once"] }]);
const taskId = approvePlan(db, run.id, stored.planVersion, "haiku", "mode").tasks[0]!.id;

const admission = broker.admit({ taskId, role: "implementer", worktree: repo, confined: driver.capabilities.confinedCommands === true });
const session = await driver.startAttempt({ db, cwd: repo, allowEdits: true, gate: admission, model: "haiku", confinement: { dataDir: home, allowedHosts: [] } });
admission.bind(session.attemptId);
session.onEvent((event: DriverEvent) => {
  if (event.type !== "permission_request") return;
  void broker
    .request({ taskId, attemptId: session.attemptId, role: "implementer", tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
    .then((answer) => session.respondToRequest(event.id, { decision: answer.decision, note: answer.note, refused: answer.refused, mode: answer.byMode !== undefined }))
    .catch(() => {});
});
await session.sendTurn(PROMPT);
await session.close();
admission.release();

const events = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(session.attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);
const refused = actionLog(db, taskId).filter((entry) => entry.rule === "mode_refused");
const calls = events.filter((event) => event.type === "tool_call");
if (refused.length !== 1 || refused[0]!.command !== "git push origin HEAD" || calls.length !== 1 || events.at(-1)?.type !== "turn_ended") {
  throw new Error(`The session did not go as the recording needs (one push asked for, refused, then the end of the turn): ${JSON.stringify({ refused, calls })}`);
}
const recording = {
  about: "A real Claude Code session, recorded through Botbench's driver and permission broker by test/support/capture-refused.ts, as the builder of a task of a fully autonomous run. Asked to run `git push origin HEAD` once, it asked for permission, Botbench refused it without asking anyone (the safety rules name it), and the CLI ended its turn.",
  cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  model: "haiku",
  recordedAt: new Date().toISOString(),
  prompt: PROMPT,
  /** Where the pre-tool hook reported each refused call from, relative to the copy, with Botbench's reason. */
  refused: refused.map(({ tool, command, cwd, detail }) => ({ tool, command, cwd, detail, toolCallId: (calls[0] as { id: string }).id })),
  events,
};
fs.writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`);
await broker.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Recorded ${events.length} events to ${OUT}`);
