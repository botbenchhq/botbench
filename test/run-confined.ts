import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { botbenchHome } from "../src/config.ts";
import { confinementProblem } from "../src/confinement.ts";
import { confinedStart } from "../src/engine/stations.ts";
import { NO_SANDBOX } from "./support/confined.ts";

// `npm run test:confined`: Botbench's own tests as Botbench runs them when they are a repository's check. `npm test`
// runs under sandbox-exec with the profile and environment of a check command (src/engine/stations.ts), with this
// repository as the task's copy, a temporary folder of its own as the one place outside it that may be written, and no
// network but this Mac's own addresses. Inside that sandbox the tests that need a sandbox of their own or the process
// list are skipped (test/support/confined.ts). This script lists them with their reasons and fails unless the test
// runner skipped exactly EXPECTED_SKIPPED of them.

/**
 * How many tests the runner skips inside the sandbox. A test that newly takes its `skip` from test/support/confined.ts
 * makes this run fail until this number is changed with it.
 */
const EXPECTED_SKIPPED = 157;

const REPO = fs.realpathSync(path.resolve(import.meta.dirname, ".."));

function stop(why: string): never {
  console.error(`npm run test:confined: ${why}`);
  process.exit(1);
}

const unconfinable = confinementProblem();
if (unconfinable !== null) stop(unconfinable);
if (NO_SANDBOX) stop(`the tests cannot be put in a sandbox from here: ${NO_SANDBOX.replace(/ Run npm test.*$/, "")} Run it from a terminal outside any sandbox.`);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-test-confined-")));
// Stopped from the terminal, the `finally` below never runs: the folder goes here instead.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(128 + os.constants.signals[signal]);
  });
}
let exitCode: number | null = null;
let output = "";
try {
  const start = confinedStart({ command: "npm test", worktree: REPO, dataDir: botbenchHome(), tmp, proxyPort: null });
  console.log(`Running npm test in ${REPO} under the sandbox Botbench gives a check: writable only there and in ${tmp}, no network but this Mac's own addresses.\n`);
  exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(start.argv[0]!, start.argv.slice(1), { cwd: REPO, env: start.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The runner's own results: each skipped test's line, `﹣ <name> (<time>) # <reason>`, and its count, `ℹ skipped <n>`.
const skippedLines = output.split("\n").filter((line) => /^\s*﹣ /.test(line));
const counted = /^ℹ skipped (\d+)$/m.exec(output);
console.log(`\nSkipped inside the sandbox (${skippedLines.length}):`);
for (const line of skippedLines) {
  const [, name, reason] = /^\s*﹣ (.*?) \([\d.]+m?s\) # (.*)$/.exec(line) ?? [null, line.trim(), ""];
  console.log(`- ${name}\n  because ${reason}`);
}

if (exitCode !== 0) stop(`npm test ended with ${exitCode ?? "a signal"} inside the sandbox; its output is above.`);
if (counted === null) stop("the test runner's count of skipped tests (ℹ skipped …) is not in the output above, so the skips could not be counted.");
const skipped = Number(counted[1]);
if (skipped !== EXPECTED_SKIPPED) {
  stop(`the test runner skipped ${skipped} tests inside the sandbox, and ${EXPECTED_SKIPPED} are expected. If a test was meant to be skipped or to run again, change EXPECTED_SKIPPED in test/run-confined.ts with it.`);
}
console.log(`\nnpm test passed inside the sandbox, with the ${skipped} skips expected.`);
