import { spawnSync } from "node:child_process";
import { SANDBOX_EXEC } from "../../src/confinement.ts";

// Whether this computer is a Mac at all: on Linux (the Linux job of .github/workflows/ci.yml) there is no sandbox-exec,
// and the tests that start it are skipped with that reason; test/run-without-sandbox.ts holds how many there are.
// And whether this test run is itself inside a macOS sandbox, as it is when Botbench runs `npm test` as a repository's
// check, and when `npm run test:confined` (test/run-confined.ts) runs it the same way. Inside one, macOS lets a process
// neither start a sandbox of its own nor run `ps`, and the tests that need either are skipped with the reason below.
// Every such test takes its `skip` from here, and nowhere else; test/run-confined.ts holds how many there are.
// Each probe is one trivial real call, and only macOS's own refusal counts: anything else is not taken as a sandbox,
// so a broken probe makes the tests run and fail, never skip.

/** How a sandbox's refusal reads: sandbox-exec's own words, the system's EPERM, or pgrep's message when it may not list processes. */
const REFUSAL = /Operation not permitted|Cannot get process list/;

/** What `command args` printed when macOS refused it, or null when it ran or failed in some other way. */
function refusal(command: string, args: string[]): string | null {
  const ran = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  const error = ran.error as NodeJS.ErrnoException | undefined;
  if (error) return error.code === "EPERM" ? `${command}: ${error.message}` : null;
  const said = `${ran.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  return ran.status !== 0 && REFUSAL.test(said) ? said : null;
}

/**
 * Why this computer has no sandbox-exec to start, or null when it is a Mac. A Mac without it is not skipped: Botbench
 * cannot run there, so its tests run and fail.
 */
const sandboxMissing = process.platform === "darwin" ? null : `this computer runs ${process.platform}, and ${SANDBOX_EXEC} is macOS's alone`;

const sandboxRefused = process.platform === "darwin" ? refusal(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]) : null;
const processTableRefused = process.platform === "darwin" ? (refusal("ps", ["-o", "pid=", "-p", String(process.pid)]) ?? refusal("pgrep", ["-P", String(process.ppid)])) : null;

/**
 * Why a test that starts sandbox-exec itself, directly or through a task's setup and check commands, is skipped here;
 * false when this run is not inside a sandbox and the test runs.
 */
export const NO_SANDBOX: string | false =
  sandboxMissing !== null
    ? `${sandboxMissing}, so a test that starts one cannot run here. Run npm test on a Mac to test this.`
    : sandboxRefused === null
      ? false
      : `this run is already inside a macOS sandbox, and macOS does not let it start another one (${sandboxRefused}). Run npm test outside a sandbox to test this.`;

/** Why a test that lists processes with ps or pgrep is skipped here; false when this run may list them and the test runs. */
export const NO_PROCESS_LIST: string | false =
  processTableRefused === null ? false : `this run is inside a macOS sandbox, which does not let it list processes (${processTableRefused}). Run npm test outside a sandbox to test this.`;

/** Why a test that needs both is skipped here; false when it runs. */
export const NO_SANDBOX_OR_PROCESS_LIST: string | false = NO_SANDBOX || NO_PROCESS_LIST;
