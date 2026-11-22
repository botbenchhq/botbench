import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "./repo.ts";

/*
 * Makes test/recordings/planner-plans.json. Run by hand, on the owner's login, when the recording must be made
 * again (three turns on the cheapest model):
 *   node test/support/capture-plan.ts
 *
 * What it records is one real Claude Code session of three turns, driven through Smelt's own driver. In each turn
 * the model is asked to reply with a given plan in the planner's reply format:
 *   turn 1  a plan with no tasks, which Smelt does not accept
 *   turn 2  a plan whose one task has no title and no criteria, which Smelt does not accept
 *   turn 3  a plan of three tasks that Smelt accepts
 * A planner cannot be made to return a plan that breaks the rules on demand under Smelt's own planner prompt, which
 * asks for the opposite. The prompts here are the capture's own, and the recording says so.
 */

const fenced = (plan: unknown): string => "Reply with exactly the following fenced block and nothing else, character for character:\n```json\n" + JSON.stringify(plan) + "\n```";
const PROMPTS = [
  fenced({ tasks: [] }),
  fenced({ tasks: [{ title: "", criteria: [] }] }),
  fenced({
    tasks: [
      { title: "Add a greeting file", criteria: ["hello.txt exists at the top of the repository", "hello.txt holds the single line hi"] },
      { title: "Add a farewell file", criteria: ["bye.txt exists at the top of the repository"] },
      { title: "Describe both files in the README", criteria: ["README.md names hello.txt", "README.md names bye.txt"] },
    ],
  }),
];
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "planner-plans.json");

const dir = tempDir("smelt-capture-plan-");
const db = openStore(path.join(dir, "home"));
const cwd = path.join(dir, "empty");
fs.mkdirSync(cwd);
const session = await new ClaudeCodeDriver().startAttempt({ db, cwd, model: "haiku" });
const turns: { prompt: string; events: DriverEvent[] }[] = [];
let current: DriverEvent[] = [];
session.onEvent((event) => current.push(event));
for (const prompt of PROMPTS) {
  current = [];
  const end = await session.sendTurn(prompt);
  if (end !== "completed") throw new Error(`A turn ended as ${end}; nothing was recorded.`);
  turns.push({ prompt, events: current });
}
await session.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about:
        "One real Claude Code session of three turns, recorded through Smelt's driver by test/support/capture-plan.ts. Each turn was asked to reply with a given plan in the planner's reply format: turn 1 a plan with no tasks, turn 2 a plan whose task has no title and no criteria, turn 3 a plan of three tasks. The prompts are the capture's own, not Smelt's planner prompt.",
      cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
      model: "haiku",
      recordedAt: new Date().toISOString(),
      turns,
    },
    null,
    2,
  )}\n`,
);
console.log(`Recorded ${turns.length} turns to ${OUT}.`);
