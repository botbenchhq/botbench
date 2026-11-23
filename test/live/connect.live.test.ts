import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { createConnect } from "../../src/drivers/connect.ts";
import type { DriverProbe } from "../../src/drivers/contract.ts";
import { runCli } from "../../src/drivers/launch.ts";
import { codexSignIn } from "../../src/drivers/sign-in.ts";
import { removedAtEnd } from "../support/repo.ts";

// The real sign-in of each CLI that has a definition, started the way Botbench starts it, each with a new, empty
// configuration directory: the owner's own sign-in is never read, changed or signed out. No model turn runs, and no
// sign-in is completed: the flow is started, its real link and code checked, and cancelled. The live code is never
// printed. Run with `npm run test:live`.

const START_LIMIT = 30_000;

function emptyDir(t: TestContext, prefix: string): string {
  const dir = fs.realpathSync(removedAtEnd(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Processes of this account whose environment names `dir`: the sign-in's, and anything it started. macOS `ps -E`. */
function processesUsing(dir: string): string[] {
  const out = execFileSync("ps", ["-Eww", "-x", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((line) => line.includes(dir) && !line.includes(" ps -Eww")).map((line) => line.trim().split(/\s+/)[0]!);
}

async function noneUsing(dir: string): Promise<string[]> {
  const until = Date.now() + 5000;
  for (;;) {
    const left = processesUsing(dir);
    if (left.length === 0 || Date.now() > until) return left;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("Claude Code: with an empty configuration, Connect gives a real claude.com link and waits for the code; cancel leaves no process; disconnect runs its own sign-out there", { timeout: 90_000 }, async (t) => {
  const realBefore = JSON.parse((await runCli("claude", ["auth", "status", "--json"], { cwd: os.tmpdir() })).stdout) as { loggedIn: boolean };
  const config = emptyDir(t, "botbench-live-connect-claude-");
  const driver = new ClaudeCodeDriver({ configDir: config });
  assert.equal(driver.signIn.env.CLAUDE_CONFIG_DIR, config, "the sign-in runs on the empty directory, never the owner's");
  assert.equal((await driver.probe()).signedIn, false, "the empty directory is signed out");
  const connect = createConnect({ agents: [{ signIn: driver.signIn, probe: () => driver.probe() }], startLimitMs: START_LIMIT });
  t.after(() => connect.close());

  const waiting = await connect.start("claude-code");
  assert.equal(waiting.state, "waiting", waiting.reason ?? "");
  const url = new URL(waiting.url!);
  assert.equal(url.origin, "https://claude.com");
  assert.equal(url.pathname, "/cai/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback", "the link whose page shows a code to paste back");
  assert.match(url.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{20,}$/);
  assert.ok(processesUsing(config).length > 0, "the sign-in runs");

  const cancelled = await connect.cancel("claude-code");
  assert.deepEqual([cancelled.state, cancelled.url], ["cancelled", null]);
  assert.deepEqual(await noneUsing(config), [], "no process of the sign-in is left");

  // The CLI's own sign-out, on the empty directory only.
  assert.equal((await connect.signOut("claude-code")).signedIn, false);
  const realAfter = JSON.parse((await runCli("claude", ["auth", "status", "--json"], { cwd: os.tmpdir() })).stdout) as { loggedIn: boolean };
  assert.equal(realAfter.loggedIn, realBefore.loggedIn, "the owner's own sign-in is as it was");
});

test("Codex: with an empty CODEX_HOME, Connect gives the real device page and a one-time code; cancel leaves no process", { timeout: 90_000 }, async (t) => {
  const home = emptyDir(t, "botbench-live-connect-codex-");
  const signIn = codexSignIn(home);
  // Codex's own account of the login in that directory, as a driver's probe would read it.
  const probe = async (): Promise<DriverProbe> => {
    const run = await runCli("codex", ["login", "status"], { cwd: os.tmpdir(), extraEnv: { CODEX_HOME: home } });
    const signedIn = run.exitCode === 0;
    return { installed: run.started, version: null, supported: true, signedIn, billing: "unknown", problem: signedIn ? null : "signed out" };
  };
  assert.equal((await probe()).signedIn, false, "the empty directory is signed out");
  const connect = createConnect({ agents: [{ signIn, probe }], startLimitMs: START_LIMIT });
  t.after(() => connect.close());

  const waiting = await connect.start("codex");
  assert.equal(waiting.state, "waiting", waiting.reason ?? "");
  assert.equal(waiting.url, "https://auth.openai.com/codex/device");
  assert.ok(/^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/.test(waiting.code ?? ""), "a one-time code in the shape Codex prints");
  assert.ok(processesUsing(home).length > 0, "the sign-in runs");

  const cancelled = await connect.cancel("codex");
  assert.deepEqual([cancelled.state, cancelled.code], ["cancelled", null]);
  assert.deepEqual(await noneUsing(home), [], "no process of the sign-in is left");
  assert.equal((await probe()).signedIn, false);
});
