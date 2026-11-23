import assert from "node:assert/strict";
import test from "node:test";
import type { DriverState } from "../web/src/api/client.ts";
import { agentLine, agentStatus, AGENTS_ADDRESS, CONNECT, FIRST_STEP } from "../web/src/app/first-run.ts";
import { bannedIn } from "../e2e/voice.ts";

// The home screen's first-run lines, decided without a browser: what the agent's line says for each state Claude Code's
// own check can report, and when it carries the link to connect an agent. Whether it is the first run at all is the
// server's (test/api/first-run.test.ts); the lines on the screen are in e2e/first-run.e2e.ts.

const probe = (over: Partial<DriverState>): DriverState => ({ driver: "claude-code", installed: true, version: "2.1.0", supported: true, signedIn: true, billing: "subscription", problem: null, ...over });

test("the agent's line says it is signed in when Claude Code can be used, with no link", () => {
  assert.deepEqual(agentLine(agentStatus(probe({}), false)), { words: "Claude Code is signed in.", connect: false });
  assert.deepEqual(agentLine(agentStatus(null, false)), { words: "Checking Claude Code.", connect: false });
});

test("whenever Claude Code cannot be used, the agent's line is only the link to Settings → Agents: the header's line names what is wrong", () => {
  const cases: [DriverState | null, boolean][] = [
    [probe({ installed: false, supported: false, signedIn: false, problem: "Claude Code is not installed, or `claude` is not on the PATH." }), false],
    [probe({ supported: false, signedIn: false, problem: "Claude Code 1.0.0 is older than Botbench supports." }), false],
    [probe({ signedIn: false, problem: "Claude Code is signed out. Run `claude auth login` in a terminal." }), false],
    [probe({ problem: "Claude Code did not report its sign-in status." }), false],
    [null, true],
  ];
  for (const [driver, failed] of cases) assert.deepEqual(agentLine(agentStatus(driver, failed)), { words: "Connect an agent in Settings → Agents.", connect: true });
});

test("the first-run words are short, plain and use none of the words Botbench never shows, and the link opens Settings at Agents", () => {
  const all = [FIRST_STEP, `${CONNECT.before}${CONNECT.link}${CONNECT.after}`, ...(["checking", "ready", "not-checked", "not-installed", "unsupported", "signed-out", "unavailable"] as const).map((s) => agentLine(s).words)];
  for (const line of all) {
    assert.deepEqual(bannedIn(line), [], line);
    assert.ok(line.length <= 60, `"${line}" is one short line`);
  }
  assert.equal(FIRST_STEP, "Tap + to choose a repository, or just ask a question.");
  assert.equal(AGENTS_ADDRESS, "#/settings/agents");
});
