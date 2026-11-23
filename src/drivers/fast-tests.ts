import path from "node:path";

// The fast test suite (`npm test`, `npm run test:confined`, `npm run test:counted`) never starts a real model turn on
// the owner's subscription: a real vendor driver refuses here before it starts one, so a test that would is found at
// once instead of running a real Claude Code, Codex, Grok or Antigravity session. The routine tests replay sessions
// captured from real CLI runs through the driver contract (test/support/replay*.ts); live turns are kept to test/live/
// (`npm run test:live`) and the LIVE-tagged browser tests, which run without this.
//
// What stays allowed under the fast suite, because none of it is a model turn or changes a sign-in: the probes
// (`--version`, `auth status`, `login status`, `app-server --help`) and the model lists (`claude`'s `initialize`
// request, `codex debug models`, `grok models`, Antigravity's `session/new` without a prompt).

/** Set to 1 by the fast suite's runner (package.json's `npm test`). */
export const FAST_TESTS_ENV = "BOTBENCH_FAST_TESTS";
/** Set to 1 by `npm run test:live`, for a live test run by the test runner. */
export const LIVE_TESTS_ENV = "BOTBENCH_LIVE_TESTS";

/** Thrown by a real driver asked to start a turn, sign in or sign out under the fast suite. */
export class FastTestRealTurnError extends Error {
  constructor(agent: string, what = "turn") {
    super(`A fast test tried to start a real ${agent} ${what}; use a recorded session, or put the test under test/live/ (run with npm run test:live).`);
    this.name = "FastTestRealTurnError";
  }
}

/**
 * Whether a real driver must refuse here: under `npm test` always, and in any file the test runner runs (it sets
 * NODE_TEST_CONTEXT, also for a file run on its own with `node --test`) unless `npm run test:live` said it is live.
 */
export function inFastTests(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[FAST_TESTS_ENV] === "1") return true;
  return env.NODE_TEST_CONTEXT !== undefined && env[LIVE_TESTS_ENV] !== "1";
}

/** Throw `FastTestRealTurnError` under the fast suite; call it before a real driver starts anything of a turn. */
export function refuseInFastTests(agent: string, what?: string): void {
  if (inFastTests()) throw new FastTestRealTurnError(agent, what);
}

/** A sign-in's own commands: the vendor CLIs, and sandbox-exec, which Antigravity's sign-in runs `agy` under. */
const VENDOR_COMMANDS = new Set(["claude", "codex", "grok", "agy", "sandbox-exec"]);

/** Whether a sign-in's command is a vendor CLI itself, not a replay (test/support/replay-sign-in.ts runs node). */
export function isVendorCommand(command: string): boolean {
  return VENDOR_COMMANDS.has(path.basename(command));
}
