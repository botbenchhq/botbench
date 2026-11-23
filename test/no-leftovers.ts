import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

// `node test/no-leftovers.ts <command> [args…]`: run a test command (npm test's node --test, npm run e2e's playwright)
// and fail when it leaves a botbench-* folder or file in the system's temporary folder. Every test removes what it
// makes (test/support/repo.ts, e2e/botbench.ts); this is where one that does not is caught. The command's own exit code
// is kept when it failed; a run that passed but left something behind fails here, with the names.

const PREFIX = "botbench-";
const tmp = os.tmpdir();

/** The botbench-* names in the temporary folder now. */
function botbenchEntries(): Set<string> {
  return new Set(fs.readdirSync(tmp).filter((name) => name.startsWith(PREFIX)));
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("node test/no-leftovers.ts: name the test command to run, such as: node test/no-leftovers.ts node --test 'test/*.test.ts'");
  process.exit(2);
}

const before = botbenchEntries();
const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", reject);
  child.on("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + os.constants.signals[signal])));
});
const after = botbenchEntries();
const left = [...after].filter((name) => !before.has(name)).sort();

console.log(`\nbotbench-* entries in ${tmp}: ${before.size} before this run, ${after.size} after it; ${left.length} left by it.`);
if (left.length > 0) {
  console.error(
    `node test/no-leftovers.ts: the run left ${left.length} botbench-* ${left.length === 1 ? "entry" : "entries"} in ${tmp}. A test that makes a temporary folder must remove it when it ends: use tempDir from test/support/repo.ts (or e2e/botbench.ts), and remove it in t.after or the fixture's teardown. Left behind:\n${left.map((name) => `- ${name}`).join("\n")}\n(A Botbench running at the same time makes botbench-command-* folders of its own; if one is listed, run again with it idle.)`,
  );
  process.exit(exitCode === 0 ? 1 : exitCode);
}
process.exit(exitCode);
