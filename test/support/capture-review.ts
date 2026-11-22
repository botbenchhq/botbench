import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { codexArgs } from "../../src/drivers/codex.ts";
import { launch } from "../../src/drivers/launch.ts";
import { reviewerPrompt } from "../../src/engine/roles.ts";
import { commitsDiff, createWorktree, sharedGitDir } from "../../src/worktrees.ts";
import { initRepo, ownerCommit, tempDir, write } from "./repo.ts";

/*
 * Makes test/recordings/codex-review.json. Run by hand, on the owner's login, when the recording must be made again
 * (one review turn on Codex's cheapest model, and one signed-out turn that costs nothing):
 *   node test/support/capture-review.ts
 *
 * It records what `codex exec` printed, line for line, for two real sessions started with Botbench's own arguments
 * (`codexArgs`) in a real task copy of a real temporary repository:
 *   review      Botbench's reviewer prompt for a task whose diff adds `add` with a minus sign in it
 *   signed-out  the same prompt with CODEX_HOME pointed at an empty folder, so the CLI has no sign-in at all
 * The lines are the CLI's own. Nothing is taken out: they carry a session id, request ids and a server trace id, and no
 * token, account id or e-mail address; the script stops if a line looks like one.
 */

const MODEL = "gpt-6-luna";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "codex-review.json");

const dir = tempDir("botbench-capture-review-");
const repo = path.join(dir, "repo");
const home = path.join(dir, "home");
initRepo(repo, { "README.md": "# Calculator\n" });
const worktree = await createWorktree({ repo, home, run: "run-1", task: "task-1" });
write(worktree.path, "calc.py", "def add(a, b):\n    return a - b\n");
const head = ownerCommit(worktree.path, "Botbench task 1: add two numbers");
const task = { title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b), which returns the sum of a and b"] };
const prompt = reviewerPrompt({ task, diff: await commitsDiff({ path: worktree.path, baseCommit: worktree.baseCommit, headCommit: head }), cut: null });
const args = codexArgs({ place: { cwd: worktree.path, dataDir: home, gitDir: await sharedGitDir(repo) }, model: MODEL });

async function capture(extraEnv: Record<string, string>): Promise<{ lines: string[]; exitCode: number | null }> {
  const { child } = launch("codex", args, { cwd: worktree.path, extraEnv: { GIT_CONFIG_GLOBAL: "/dev/null", ...extraEnv } });
  const lines: string[] = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  child.stderr.resume();
  child.stdin.end(prompt);
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { lines, exitCode };
}

const review = await capture({});
const emptyHome = path.join(dir, "empty-codex-home");
fs.mkdirSync(emptyHome);
const signedOut = await capture({ CODEX_HOME: emptyHome });
fs.rmSync(dir, { recursive: true, force: true });

const SECRET = /sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10}|account[_-]?id|@[a-z0-9-]+\.[a-z]{2,}|bearer\s+[A-Za-z0-9]/i;
for (const line of [...review.lines, ...signedOut.lines]) {
  if (SECRET.test(line.replace("Missing bearer or basic authentication", ""))) throw new Error(`A recorded line looks like it holds a secret; nothing was written:\n${line.slice(0, 300)}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about:
        "What `codex exec` printed, line for line, for two real sessions started with Botbench's own arguments by test/support/capture-review.ts, in a task copy whose diff adds calc.py with `return a - b`. review: Botbench's reviewer prompt on the owner's ChatGPT sign-in. signed-out: the same prompt with CODEX_HOME pointed at an empty folder. Nothing was removed.",
      cli: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
      model: MODEL,
      recordedAt: new Date().toISOString(),
      prompt,
      sessions: { review, "signed-out": signedOut },
    },
    null,
    2,
  )}\n`,
);
console.log(`Recorded ${review.lines.length} and ${signedOut.lines.length} lines to ${OUT}.`);
