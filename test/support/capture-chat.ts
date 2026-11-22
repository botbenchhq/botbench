import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { AGY_EXTRA_ENV, agyArgs, agyInput, agyProfile, agyReader, writeReviewAgent } from "../../src/drivers/antigravity.ts";
import { makeReviewFolder, sandboxed } from "../../src/drivers/cli-sandbox.ts";
import { codexArgs, parseCodexLine } from "../../src/drivers/codex.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { GROK_EXTRA_ENV, grokArgs, grokInput, grokProfile, grokReader } from "../../src/drivers/grok.ts";
import { launch } from "../../src/drivers/launch.ts";
import { chatPrompt, comparePrompt, type ChatEntry } from "../../src/engine/roles.ts";
import { checkRecording } from "./recording-check.ts";
import { tempDir } from "./repo.ts";

/*
 * Makes test/recordings/chat-turns.json. Run by hand, on the owner's login, when the recording must be made again
 * (four cheap turns: one chat message to each of Codex, Grok and Antigravity on its cheapest model, and one request to
 * Codex to compare their three answers):
 *   node test/support/capture-chat.ts
 *
 * Each session is started the way its driver starts a chat turn (its arguments, its environment, its sandbox profile,
 * a new empty folder in Botbench's data folder), with Botbench's own chat prompt: one earlier exchange of the
 * conversation, then a one-line question. The lines are the CLI's own; nothing is taken out, and the script stops
 * before writing if a line looks like it holds a secret, an e-mail address or a path in the owner's home folder.
 */

const OUT = path.resolve(import.meta.dirname, "..", "recordings", "chat-turns.json");
const MODELS = { codex: "gpt-6-luna", grok: "grok-4.7-build-fast", antigravity: "gemini-3.8-flash-low" } as const;

const dir = tempDir("botbench-capture-chat-");
const home = path.join(dir, "home");
fs.mkdirSync(home, { mode: 0o700 });

const history: ChatEntry[] = [
  { from: "owner", text: "Name one primary colour, in one word." },
  { from: "Claude Code (haiku)", text: "Red." },
];
const QUESTION = "Name one more primary colour, in one word, and say in one short sentence why it is primary.";
const { prompt } = chatPrompt({ history, message: QUESTION });

async function run(command: string, args: string[], cwd: string, extraEnv: Record<string, string>, input: string): Promise<{ lines: string[]; exitCode: number | null }> {
  const { child } = launch(command, args, { cwd, extraEnv });
  const lines: string[] = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  child.stderr.resume();
  child.stdin.end(input);
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { lines, exitCode };
}

async function codex(text: string) {
  const folder = makeReviewFolder(home);
  try {
    return await run("codex", codexArgs({ place: { cwd: folder.path, dataDir: home }, model: MODELS.codex }), folder.path, { GIT_CONFIG_GLOBAL: "/dev/null" }, text);
  } finally {
    folder.remove();
  }
}
async function grok(text: string) {
  const folder = makeReviewFolder(home);
  try {
    const s = sandboxed(grokProfile({ dataDir: home, folder: folder.path }), "grok", grokArgs({ model: MODELS.grok }));
    return await run(s.command, s.args, folder.path, GROK_EXTRA_ENV, grokInput(text));
  } finally {
    folder.remove();
  }
}
async function antigravity(text: string) {
  const folder = makeReviewFolder(home);
  try {
    writeReviewAgent(folder.path);
    const s = sandboxed(agyProfile({ dataDir: home, folder: folder.path }), "agy", agyArgs({ model: MODELS.antigravity }));
    return await run(s.command, s.args, folder.path, AGY_EXTRA_ENV, agyInput(text));
  } finally {
    folder.remove();
  }
}

const reply = (events: DriverEvent[]): string => events.filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("\n\n");
const read = (lines: string[], reader: (line: string) => { events: DriverEvent[] }): DriverEvent[] => lines.flatMap((line) => reader(line).events);

const [c, g, a] = await Promise.all([codex(prompt), grok(prompt), antigravity(prompt)]);
const answers: ChatEntry[] = [
  { from: `Codex (${MODELS.codex})`, text: reply(c.lines.flatMap(parseCodexLine)) },
  { from: `Grok (${MODELS.grok})`, text: reply(read(g.lines, grokReader())) },
  { from: `Antigravity (${MODELS.antigravity})`, text: reply(read(a.lines, agyReader())) },
];
for (const answer of answers) if (answer.text.trim() === "") throw new Error(`${answer.from} gave no answer; nothing was written.`);
const compare = await codex(comparePrompt({ question: QUESTION, answers }));
fs.rmSync(dir, { recursive: true, force: true });

checkRecording([...c.lines, ...g.lines, ...a.lines, ...compare.lines]);

const version = (command: string): string => execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about:
        "What each CLI printed, line for line, for one real chat message started the way its driver starts a chat turn, by test/support/capture-chat.ts, on the owner's subscription sign-ins. codex, grok, antigravity: Botbench's chat prompt with one earlier exchange and a one-line question. compare: Codex asked to compare the three answers. Nothing was removed.",
      clis: { codex: version("codex"), grok: version("grok"), antigravity: version("agy") },
      models: MODELS,
      recordedAt: new Date().toISOString(),
      question: QUESTION,
      sessions: { codex: c, grok: g, antigravity: a, compare },
    },
    null,
    2,
  )}\n`,
);
console.log(`Recorded ${c.lines.length}, ${g.lines.length}, ${a.lines.length} and ${compare.lines.length} lines to ${OUT}.`);
