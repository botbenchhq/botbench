import { spawn } from "node:child_process";
import path from "node:path";
import { NO_SANDBOX } from "./support/confined.ts";

// `npm run test:without-sandbox` (arguments after `--` go to the test runner): `npm test` on a computer that is not a
// Mac, as the Linux job of .github/workflows/ci.yml runs it. There is no sandbox-exec there, so the tests that start it are skipped
// (test/support/confined.ts), and so are the few that are about macOS alone. This script lists every skipped test with
// its reason and fails unless the test runner skipped exactly EXPECTED_SKIPPED of them, so that skips cannot grow
// without anyone seeing it. The macOS job runs the whole suite.

/**
 * How many tests the runner skips off macOS. A test that newly takes its `skip` from test/support/confined.ts, or skips
 * for being off a Mac, makes this run fail until this number is changed with it.
 */
const EXPECTED_SKIPPED = 136;

const REPO = path.resolve(import.meta.dirname, "..");

function stop(why: string): never {
  console.error(`npm run test:without-sandbox: ${why}`);
  process.exit(1);
}

if (process.platform === "darwin" || !NO_SANDBOX) stop("this is a Mac, where npm test runs every test. Run npm test here instead; this script is for a computer without sandbox-exec.");

console.log(`Running npm test in ${REPO} without a sandbox: ${NO_SANDBOX}\n`);
let output = "";
const exitCode = await new Promise<number | null>((resolve, reject) => {
  const child = spawn("npm", ["test", "--", ...process.argv.slice(2)], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
  child.on("error", reject);
  child.on("close", (code) => resolve(code));
});

// The runner's own results: each skipped test's line, `﹣ <name> (<time>) # <reason>`, and its count, `ℹ skipped <n>`.
const skippedLines = output.split("\n").filter((line) => /^\s*﹣ /.test(line));
const counted = /^ℹ skipped (\d+)$/m.exec(output);
console.log(`\nSkipped without a sandbox (${skippedLines.length}):`);
for (const line of skippedLines) {
  const [, name, reason] = /^\s*﹣ (.*?) \([\d.]+m?s\) # (.*)$/.exec(line) ?? [null, line.trim(), ""];
  console.log(`- ${name}\n  because ${reason}`);
}

if (exitCode !== 0) stop(`npm test ended with ${exitCode ?? "a signal"}; its output is above.`);
if (counted === null) stop("the test runner's count of skipped tests (ℹ skipped …) is not in the output above, so the skips could not be counted.");
const skipped = Number(counted[1]);
if (skipped !== EXPECTED_SKIPPED) {
  stop(`the test runner skipped ${skipped} tests, and ${EXPECTED_SKIPPED} are expected. If a test was meant to be skipped or to run again, change EXPECTED_SKIPPED in test/run-without-sandbox.ts with it.`);
}
console.log(`\nnpm test passed without a sandbox, with the ${skipped} skips expected.`);
