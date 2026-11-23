import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityDriver } from "../../src/drivers/antigravity.ts";
import { chatPrompt, reviewerPrompt, type ChatEntry } from "../../src/engine/roles.ts";
import { openStore } from "../../src/store/db.ts";
import { commitsDiff, createWorktree, describeCommits } from "../../src/worktrees.ts";
import { checkRecording } from "./recording-check.ts";
import { initRepo, ownerCommit, tempDir, write } from "./repo.ts";

/*
 * Makes test/recordings/antigravity-acp.json. Run by hand, on the Mac where Antigravity is connected in Botbench
 * (~/.botbench/antigravity), when the recording must be made again (two cheap turns on Antigravity's cheapest model,
 * and one signed-out session that costs nothing):
 *   node test/support/capture-antigravity.ts
 *
 * It records what `agy acp` printed, line for line, for three real sessions started by AntigravityDriver itself (its
 * arguments, its environment, its sandbox, its agent definition, its answers to permission requests), in temporary
 * folders:
 *   chat        Botbench's chat prompt (one earlier exchange, one question), as a chat turn with no repository
 *   review      Botbench's reviewer prompt, for a reviewer with tools, for a diff that adds `add` with a minus sign in it
 *   signed-out  the chat prompt with a new empty data folder, whose profile holds no sign-in
 * The lines are the CLI's own. Nothing is taken out; the script stops if a line looks like it holds a secret, an
 * e-mail address or a path in the owner's home folder.
 */

const MODEL = "gemini-3.8-flash-low";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "antigravity-acp.json");
const DATA = path.join(os.homedir(), ".botbench");

const dir = fs.realpathSync(tempDir("botbench-capture-agy-acp-"));
const home = path.join(dir, "home");
const db = openStore(home);

const history: ChatEntry[] = [
  { from: "owner", text: "Name one primary colour, in one word." },
  { from: "Claude Code (haiku)", text: "Red." },
];
const { prompt: chat } = chatPrompt({ history, message: "Name one more primary colour, in one word, and say in one short sentence why it is primary." });

const repo = path.join(dir, "repo");
initRepo(repo, { "README.md": "# Calculator\n" });
const worktree = await createWorktree({ repo, home, run: "run-1", task: "task-1" });
write(worktree.path, "calc.py", "def add(a, b):\n    return a - b\n");
const head = ownerCommit(worktree.path, "Botbench task 1: add two numbers");
const task = { title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b), which returns the sum of a and b"] };
const review = reviewerPrompt({ task, files: await describeCommits({ repo: worktree.path, baseCommit: worktree.baseCommit, headCommit: head }), diff: await commitsDiff({ path: worktree.path, baseCommit: worktree.baseCommit, headCommit: head }), tools: true, copy: worktree.path, webSearch: false });

async function capture(o: { dataDir: string; prompt: string; review: boolean }): Promise<{ lines: string[]; end: string }> {
  const lines: string[] = [];
  const driver = new AntigravityDriver({ dataDir: o.dataDir, onLine: (line) => lines.push(line) });
  const scratch = fs.mkdtempSync(path.join(home, "scratch-"));
  const session = await driver.startAttempt(o.review ? { db, cwd: worktree.path, readOnly: true, confinement: { dataDir: home, allowedHosts: [] }, model: MODEL } : { db, cwd: scratch, chatTools: { readable: [] }, confinement: { dataDir: home, allowedHosts: [] }, model: MODEL });
  const end = await session.sendTurn(o.prompt);
  await session.close();
  return { lines, end };
}

const chatSession = await capture({ dataDir: DATA, prompt: chat, review: false });
const reviewSession = await capture({ dataDir: DATA, prompt: review, review: true });
// Signed out: a new empty profile. The driver's probe refuses to start a turn on it, so `agy acp` is started here
// under the same sign-in sandbox the driver lists models with, and asked for a session.
const empty = path.join(dir, "empty-data");
fs.mkdirSync(empty, { mode: 0o700 });
const signedOut = await (async () => {
  const { launch } = await import("../../src/drivers/launch.ts");
  const { prepareProfile, profileGeminiDir, signInSandbox, AGY_EXTRA_ENV } = await import("../../src/drivers/antigravity.ts");
  const { SANDBOX_EXEC } = await import("../../src/confinement.ts");
  const readline = await import("node:readline");
  const profile = prepareProfile(empty);
  const { child } = launch(SANDBOX_EXEC, ["-p", signInSandbox({ dataDir: empty, profile }), "agy", "acp", "--gemini-dir", profileGeminiDir(profile)], { cwd: empty, extraEnv: AGY_EXTRA_ENV });
  const lines: string[] = [];
  child.stderr.resume();
  const rl = readline.createInterface({ input: child.stdout });
  const done = new Promise<void>((resolve) => rl.on("line", (line) => {
    lines.push(line);
    const m = JSON.parse(line) as { id?: number };
    if (m.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: empty, mcpServers: [] } })}\n`);
    if (m.id === 2) resolve();
  }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "botbench", version: "0.1.0" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } })}\n`);
  await done;
  child.kill();
  return { lines, end: "error" };
})();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

checkRecording([...chatSession.lines, ...reviewSession.lines, ...signedOut.lines].map((line) => line.replaceAll(dir, "<capture>")));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about:
        "What `agy acp` printed, line for line, for three real sessions, by test/support/capture-antigravity.ts. chat and review: started by AntigravityDriver (its sandbox, its agent definition, its answers) on Botbench's own Google profile, a chat turn with Botbench's chat prompt and a review of a diff that adds calc.py with `return a - b`. signed-out: initialize and session/new on a new empty profile. Nothing was removed.",
      cli: execFileSync("agy", ["--version"], { encoding: "utf8" }).trim(),
      model: MODEL,
      recordedAt: new Date().toISOString(),
      prompts: { chat, review },
      sessions: { chat: chatSession, review: reviewSession, "signed-out": signedOut },
    },
    null,
    2,
  )}\n`,
);
console.log(`Recorded ${chatSession.lines.length}, ${reviewSession.lines.length} and ${signedOut.lines.length} lines to ${OUT}.`);
