import assert from "node:assert/strict";
import { test } from "node:test";
import { AntigravityDriver } from "../../src/drivers/antigravity.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { CodexDriver } from "../../src/drivers/codex.ts";
import { createConnect } from "../../src/drivers/connect.ts";
import type { Driver, StartAttemptOptions } from "../../src/drivers/contract.ts";
import { FAST_TESTS_ENV, FastTestRealTurnError, inFastTests, isVendorCommand, LIVE_TESTS_ENV } from "../../src/drivers/fast-tests.ts";
import { GrokDriver } from "../../src/drivers/grok.ts";
import { claudeCodeSignIn } from "../../src/drivers/sign-in.ts";
import { tempDir } from "../support/repo.ts";

// The fast suite never starts a real model turn (src/drivers/fast-tests.ts): each real vendor driver refuses before it
// probes or starts anything, whether or not its CLI is installed, and so do the real sign-in and sign-out.

const REFUSED = (agent: string, what = "turn") => (err: unknown): boolean =>
  err instanceof FastTestRealTurnError && err.message.startsWith(`A fast test tried to start a real ${agent} ${what}; use a recorded session, or put the test under test/live/`);

test("the fast suite is recognised: npm test sets its flag, and any file the test runner runs counts unless npm run test:live said it is live", () => {
  assert.equal(inFastTests(), true, "this file runs under the test runner");
  assert.equal(inFastTests({ [FAST_TESTS_ENV]: "1" }), true);
  assert.equal(inFastTests({ [FAST_TESTS_ENV]: "1", [LIVE_TESTS_ENV]: "1" }), true, "npm test runs no live test, so its flag wins");
  assert.equal(inFastTests({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(inFastTests({ NODE_TEST_CONTEXT: "child-v8", [LIVE_TESTS_ENV]: "1" }), false, "npm run test:live");
  assert.equal(inFastTests({}), false, "Botbench itself, a capture script, a Playwright run");
});

test("in a fast test, each real driver refuses to start a turn with the message, before it starts any CLI", async () => {
  const dir = tempDir("botbench-fast-tests-");
  const base = { db: null as never, cwd: dir, confinement: { dataDir: dir, allowedHosts: [] } } satisfies StartAttemptOptions;
  const gate = { socketPath: "/nonexistent-socket", secret: "x" };
  const cases: [string, Driver, StartAttemptOptions][] = [
    ["Claude Code", new ClaudeCodeDriver(), { ...base, allowEdits: true, gate }],
    ["Claude Code", new ClaudeCodeDriver(), base],
    ["Codex", new CodexDriver(), { ...base, readOnly: true }],
    ["Codex", new CodexDriver(), { ...base, allowEdits: true, gate }],
    ["Codex", new CodexDriver(), { ...base, chatTools: { readable: [] } }],
    ["Grok", new GrokDriver(), { ...base, readOnly: true }],
    ["Grok", new GrokDriver(), { ...base, chatTools: { readable: [] } }],
    ["Antigravity", new AntigravityDriver({ dataDir: dir }), { ...base, readOnly: true }],
    ["Antigravity", new AntigravityDriver({ dataDir: dir }), { ...base, chatTools: { readable: [] } }],
  ];
  for (const [agent, driver, options] of cases) {
    await assert.rejects(driver.startAttempt(options), REFUSED(agent), `${agent} refused`);
  }
});

test("in a fast test, the real sign-in and sign-out refuse with the message and start no flow; a replayed sign-in (node) is not a vendor CLI", async (t) => {
  const signIn = claudeCodeSignIn();
  const connect = createConnect({ agents: [{ signIn, probe: async () => ({ installed: true, version: "2.0.0", supported: true, signedIn: false, billing: "unknown", problem: "signed out" }) }] });
  t.after(() => connect.close());
  await assert.rejects(connect.start("claude-code"), REFUSED("Claude Code", "sign-in"));
  assert.equal(connect.view("claude-code").state, "idle");
  await assert.rejects(connect.signOut("claude-code"), REFUSED("Claude Code", "sign-out"));
  for (const command of ["claude", "codex", "grok", "agy", "/usr/bin/sandbox-exec", "/opt/homebrew/bin/codex"]) assert.equal(isVendorCommand(command), true, command);
  assert.equal(isVendorCommand(process.execPath), false);
});
