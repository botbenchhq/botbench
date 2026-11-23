import { spawn } from "node:child_process";
import path from "node:path";
import { NO_SANDBOX } from "./support/confined.ts";
import { NO_SPEECH } from "./support/speech.ts";

// `npm run test:counted` (arguments after `--` go to the test runner): `npm test` with every skipped test listed with
// its reason, failing unless the test runner skipped exactly the number expected on this kind of computer, so that
// skips cannot grow without anyone seeing it. Both jobs of .github/workflows/ci.yml that run npm test run it this way.
// - Not a Mac (the Linux job): there is no sandbox-exec, so the tests that start it are skipped
//   (test/support/confined.ts), and so are the few that are about macOS alone.
// - A Mac without speech recognition (the macOS job: GitHub's runners are virtual machines): the dictation tests are
//   skipped (test/support/speech.ts).
// - Any other Mac: nothing is skipped.
// Inside a sandbox, `npm run test:confined` (test/run-confined.ts) counts instead.

/**
 * How many tests the runner skips on each kind of computer. A test that newly takes its `skip` from
 * test/support/confined.ts or test/support/speech.ts, or skips for being off a Mac, makes this run fail until the
 * number is changed with it.
 */
const EXPECTED_SKIPPED = { offMac: 152, macWithoutSpeech: 8, mac: 0 };

const REPO = path.resolve(import.meta.dirname, "..");

function stop(why: string): never {
  console.error(`npm run test:counted: ${why}`);
  process.exit(1);
}

if (process.platform === "darwin" && NO_SANDBOX) stop("this run is inside a macOS sandbox. Run npm run test:confined to count the skips there, or run this outside any sandbox.");
const [where, why, expected] =
  process.platform !== "darwin"
    ? ["off a Mac", NO_SANDBOX, EXPECTED_SKIPPED.offMac]
    : NO_SPEECH !== null
      ? ["on a Mac without speech recognition", NO_SPEECH, EXPECTED_SKIPPED.macWithoutSpeech]
      : ["on a Mac", null, EXPECTED_SKIPPED.mac];

console.log(`Running npm test in ${REPO} ${where}${why ? `: ${why}` : ""}.\n`);
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
console.log(`\nSkipped (${skippedLines.length}):`);
for (const line of skippedLines) {
  const [, name, reason] = /^\s*﹣ (.*?) \([\d.]+m?s\) # (.*)$/.exec(line) ?? [null, line.trim(), ""];
  console.log(`- ${name}\n  because ${reason}`);
}

if (exitCode !== 0) stop(`npm test ended with ${exitCode ?? "a signal"}; its output is above.`);
if (counted === null) stop("the test runner's count of skipped tests (ℹ skipped …) is not in the output above, so the skips could not be counted.");
const skipped = Number(counted[1]);
if (skipped !== expected) {
  stop(`the test runner skipped ${skipped} tests ${where}, and ${expected} are expected. If a test was meant to be skipped or to run again, change EXPECTED_SKIPPED in test/run-counted.ts with it.`);
}
console.log(`\nnpm test passed ${where}, with the ${skipped} skips expected.`);
