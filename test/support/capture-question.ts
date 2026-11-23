import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createBroker, permissionResponse } from "../../src/approvals/broker.ts";
import { summarize } from "../../src/approvals/gate.ts";
import { QUESTION_TOOL } from "../../src/approvals/question.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { createTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { checkRecording } from "./recording-check.ts";
import { initRepo, tempDir } from "./repo.ts";

/*
 * Makes test/recordings/ask-question.json, a NEW file: it refuses to run when the file is already there, so no
 * recording is ever changed by it. Run by hand, once, on the owner's login (one turn on the cheapest model):
 *   node test/support/capture-question.ts
 *
 * What it records is a real Claude Code session, driven as a task's builder is, through Botbench's own driver,
 * permission check and broker: the CLI is asked to put one question to its user with its AskUserQuestion tool. The
 * recording answers three things about headless mode, and the script stops, writing nothing, when the CLI does not
 * show them:
 *   1. the tool's name, as the CLI reports it in its permission prompt;
 *   2. that it arrives as a `control_request` of subtype `can_use_tool` (the driver turns only that into a
 *      `permission_request` event, parsePermissionRequest in src/drivers/claude-code.ts);
 *   3. the shape of its input, which Botbench must be able to read as one question with two to four choices.
 * The owner's side is played by the script: once the question's card is pending, it gives the answer "Hi" through
 * the broker, exactly as the API does, and the recording then shows whether the agent's turn goes on with it.
 *
 * What was known before the first capture, from Anthropic's Agent SDK guide ("Handle approvals and user input"): the
 * call reaches the host's permission callback with the tool name AskUserQuestion and the input
 * {questions:[{question, header, options:[{label, description}], multiSelect}]}, and is answered by an allow whose
 * updatedInput holds the questions and `answers` keyed by the question text. The capture checks that on the real CLI.
 */

const PROMPT =
  'Before you do anything else, use your AskUserQuestion tool exactly once to ask me one question: "Which greeting should I use?", with exactly two options, labelled "Hello" and "Hi". Do not use any other tool. Once I have answered, reply with only the label of the option I chose.';
const ANSWER = "Hi";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "ask-question.json");

if (fs.existsSync(OUT)) {
  console.error(`${OUT} already exists. This script only ever adds it; nothing was changed. Delete it first to record again.`);
  process.exit(1);
}

const dir = tempDir("botbench-capture-");
const home = path.join(dir, "home");
const repo = path.join(dir, "repo");
initRepo(repo, { "README.md": "# Sample\n" });
const db = openStore(home);
const broker = createBroker({ db, home, onChange: () => {} });
await broker.listen();
const driver = new ClaudeCodeDriver();
const taskId = createTask(db, { repo, prompt: PROMPT }).id;

const admission = broker.admit({ taskId, role: "implementer", worktree: repo, confined: true });
const session = await driver.startAttempt({ db, cwd: repo, allowEdits: true, gate: admission, model: "haiku", confinement: { dataDir: home, allowedHosts: [] } });
admission.bind(session.attemptId);
const requests: Extract<DriverEvent, { type: "permission_request" }>[] = [];
session.onEvent((event: DriverEvent) => {
  if (event.type !== "permission_request") return;
  requests.push(event);
  // As the engine does it (src/engine/task.ts): the broker decides, and its answer goes back to the CLI.
  void broker
    .request({ taskId, attemptId: session.attemptId, role: "implementer", tool: event.name, command: summarize(event.name, event.input), input: event.input, reason: event.reason, toolCallId: event.toolCallId })
    .then((answer) => session.respondToRequest(event.id, permissionResponse(answer)))
    .catch((err: unknown) => console.error(`The answer could not be given: ${String(err)}`));
  // The owner's side: a question's card that is pending gets the answer, through the broker as the API gives it.
  setImmediate(() => {
    const card = broker.pending().find((a) => a.question !== null);
    if (card) broker.answerQuestion(card.id, ANSWER);
  });
});
const end = await session.sendTurn(PROMPT);
await session.close();
admission.release();

const events = db.prepare("SELECT payload FROM events WHERE attempt_id = ? ORDER BY id").all(session.attemptId).map((row) => JSON.parse(String(row.payload)) as DriverEvent);
const asked = requests.find((r) => r.name === QUESTION_TOOL);
const report = (finding: string): never => {
  console.error(`${finding}\nNothing was written. What the CLI did, as Botbench's driver read it:`);
  for (const event of events) console.error(JSON.stringify(event).slice(0, 400));
  process.exit(1);
};
if (asked === undefined) {
  const called = events.find((e) => e.type === "tool_call" && e.name === QUESTION_TOOL);
  report(
    called === undefined
      ? `The model did not call ${QUESTION_TOOL}, so nothing was learned about how the CLI routes it. Try again; if it never calls it, the tool may be missing from the CLI's tool list in headless mode.`
      : `The model called ${QUESTION_TOOL}, but the CLI never sent Botbench a can_use_tool request for it: the question cannot be routed to the owner this way. Botbench must not be built on it.`,
  );
}
const resolved = events.find((e) => e.type === "permission_resolved" && e.toolCallId === asked!.toolCallId);
if (resolved === undefined || resolved.type !== "permission_resolved" || resolved.decision !== "answered") report(`The question reached Botbench but was not answered as a question (it ended ${resolved?.type === "permission_resolved" ? resolved.decision : "with no answer"}). See src/approvals/question.ts for what Botbench can show.`);
const after = events.slice(events.indexOf(resolved!) + 1);
if (end !== "completed" || !after.some((e) => e.type === "text")) report(`The answer was given, but the agent's turn did not go on with it (the turn ended ${end}).`);

const recording = {
  about:
    "A real Claude Code session, recorded through Botbench's driver, permission check and broker by test/support/capture-question.ts, as a task's builder is driven. The CLI was asked to put one question to its user with AskUserQuestion. `finding` is what arrived: the tool's name and the input of the can_use_tool control request, as the driver read it into its permission_request event. The script answered through the broker with `answer`, and `events` is the whole attempt as Botbench stored it, the answer and the turn that went on with it included.",
  cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  model: "haiku",
  recordedAt: new Date().toISOString(),
  prompt: PROMPT,
  finding: { controlRequest: "can_use_tool", tool: asked!.name, input: asked!.input },
  answer: ANSWER,
  events,
};
const text = `${JSON.stringify(recording, null, 2)}\n`;
checkRecording(text.split("\n"));
fs.writeFileSync(OUT, text, { flag: "wx" });
await broker.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Recorded ${events.length} events to ${OUT}. The CLI asked with tool ${asked!.name} and input keys ${Object.keys(asked!.input as object).join(", ")}.`);
