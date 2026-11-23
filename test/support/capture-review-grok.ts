import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { makeReviewFolder, proxyEnv, sandboxed, startProviderProxy } from "../../src/drivers/cli-sandbox.ts";
import { GROK_EXTRA_ENV, GROK_PROVIDER, grokArgs, grokInput, grokProfile } from "../../src/drivers/grok.ts";
import { launch } from "../../src/drivers/launch.ts";
import { reviewerPrompt } from "../../src/engine/roles.ts";
import { commitsDiff, createWorktree, describeCommits } from "../../src/worktrees.ts";
import { checkRecording } from "./recording-check.ts";
import { initRepo, ownerCommit, tempDir, write } from "./repo.ts";

/*
 * Makes test/recordings/grok-review.json. Run by hand, on the owner's login, when the recording must be made again
 * (one review turn on Grok's cheapest model, and one signed-out turn that costs nothing):
 *   node test/support/capture-review-grok.ts
 *
 * It records what `grok` printed, line for line, for two real sessions started the way GrokDriver starts them (its
 * arguments, its environment, its sandbox profile, a new empty review folder), for the reviewer prompt of a real task
 * of a real temporary repository:
 *   review      Botbench's reviewer prompt, for a reviewer with no tools, for a diff that adds `add` with a minus sign in it
 *   signed-out  the same prompt with GROK_HOME pointed at an empty folder, so the CLI has no sign-in at all
 * The lines are the CLI's own. Nothing is taken out; the script stops if a line looks like it holds a secret, an
 * e-mail address or a path in the owner's home folder.
 */

const MODEL = "grok-4.7-build-fast";
const OUT = path.resolve(import.meta.dirname, "..", "recordings", "grok-review.json");

const dir = tempDir("botbench-capture-grok-");
const repo = path.join(dir, "repo");
const home = path.join(dir, "home");
initRepo(repo, { "README.md": "# Calculator\n" });
const worktree = await createWorktree({ repo, home, run: "run-1", task: "task-1" });
write(worktree.path, "calc.py", "def add(a, b):\n    return a - b\n");
const head = ownerCommit(worktree.path, "Botbench task 1: add two numbers");
const task = { title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b), which returns the sum of a and b"] };
const prompt = reviewerPrompt({ task, files: await describeCommits({ repo: worktree.path, baseCommit: worktree.baseCommit, headCommit: head }), diff: await commitsDiff({ path: worktree.path, baseCommit: worktree.baseCommit, headCommit: head }), tools: false });

async function capture(extraEnv: Record<string, string>): Promise<{ lines: string[]; exitCode: number | null }> {
  const folder = makeReviewFolder(home);
  // As GrokDriver starts a review since Grok has its own tools there: the task's copy read-only, a proxy to xAI.
  const proxy = await startProviderProxy(GROK_PROVIDER);
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-grok-")));
  const run = sandboxed(grokProfile({ dataDir: home, folder: folder.path, readOnly: [worktree.path], temp, proxyPort: proxy.port, env: { ...process.env, ...extraEnv } }), "grok", grokArgs({ mode: "review", model: MODEL }));
  const { child } = launch(run.command, run.args, { cwd: folder.path, extraEnv: { ...GROK_EXTRA_ENV, ...proxyEnv(proxy.port), TMPDIR: temp, TMP: temp, TEMP: temp, ...extraEnv } });
  child.once("close", () => (void proxy.close(), fs.rmSync(temp, { recursive: true, force: true })));
  const lines: string[] = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  child.stderr.resume();
  child.stdin.end(grokInput(prompt));
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  folder.remove();
  return { lines, exitCode };
}

const review = await capture({});
const emptyHome = path.join(dir, "empty-grok-home");
fs.mkdirSync(emptyHome);
const signedOut = await capture({ GROK_HOME: emptyHome });
fs.rmSync(dir, { recursive: true, force: true });

checkRecording([...review.lines, ...signedOut.lines]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about:
        "What `grok -p -` printed, line for line, for two real sessions started the way GrokDriver starts them, by test/support/capture-review-grok.ts, for a task whose diff adds calc.py with `return a - b`. review: Botbench's reviewer prompt for a reviewer with no tools, on the owner's grok.com sign-in. signed-out: the same prompt with GROK_HOME pointed at an empty folder. Nothing was removed.",
      cli: execFileSync("grok", ["--version"], { encoding: "utf8" }).trim(),
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
