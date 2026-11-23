import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createAgentChecks } from "../../src/api/agents.ts";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { AntigravityDriver } from "../../src/drivers/antigravity.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { CodexDriver } from "../../src/drivers/codex.ts";
import { IMPLEMENTER, roleProblem } from "../../src/engine/roles.ts";
import type { Driver } from "../../src/drivers/contract.ts";
import { GrokDriver } from "../../src/drivers/grok.ts";
import { startServer } from "../../src/server.ts";
import { tempDir } from "../support/repo.ts";

/** Codex's roles here: a reviewer, and a builder too where the installed Codex can build (its probe says so; inside a sandbox, or with no Codex, it cannot). */
async function codexRoles(): Promise<string[]> {
  const codex = new CodexDriver();
  await codex.probe();
  return roleProblem(IMPLEMENTER, "codex", codex.capabilities) === null ? ["builder", "reviewer"] : ["reviewer"];
}

// The agents' checks run each agent's own program on this Mac; they are kept for a short time so a screen that opens
// does not wait for them. The drivers here are the real ones: only their calls to probe() are counted.

function counted(): { drivers: Driver[]; calls: () => number } {
  let calls = 0;
  const drivers: Driver[] = [new ClaudeCodeDriver(), new CodexDriver(), new GrokDriver(), new AntigravityDriver()];
  for (const d of drivers) {
    const real = d.probe.bind(d);
    d.probe = () => {
      calls++;
      return real();
    };
  }
  return { drivers, calls: () => calls };
}

test("a second read within the window answers from the last check and runs no agent's program; an older check answers at once and is made again behind it", async () => {
  let clock = 1_000_000;
  const { drivers, calls } = counted();
  const checks = createAgentChecks(drivers, { freshMs: 60_000, now: () => clock });
  const first = await checks.read();
  assert.equal(calls(), 4, "the first read checks each agent once");
  assert.deepEqual(first.agents.map((a) => a.agent), ["claude-code", "codex", "grok", "antigravity"]);
  assert.equal(first.checkedAt, new Date(clock).toISOString());
  assert.equal(first.checking, false);

  clock += 59_000;
  const second = await checks.read();
  assert.equal(calls(), 4, "within the window no program runs again");
  assert.equal(second.checkedAt, first.checkedAt);

  clock += 2_000;
  const stale = await checks.read();
  assert.equal(stale.checkedAt, first.checkedAt, "an old check still answers at once");
  assert.equal(stale.checking, true, "and says a new one is running");
  assert.equal(calls(), 8);
  const renewed = await checks.fresh();
  assert.equal(calls(), 8, "fresh() waits for the check already running");
  assert.equal(renewed.checkedAt, new Date(clock).toISOString());
  assert.equal((await checks.read()).checkedAt, renewed.checkedAt);

  checks.forget();
  await checks.read();
  await checks.fresh();
  assert.equal(calls(), 12, "after a sign-in or sign-out the next read checks again");
});

test("GET /api/agents says when the agents were checked, answers a second time from that check, and ?fresh=1 waits for a new one", async (t) => {
  const dir = tempDir("botbench-agents-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const server = await startServer({ config: { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} }, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signed = await fetch(`${base}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const headers = { cookie: signed.headers.getSetCookie()[0]!.split(";")[0]! };
  const get = async (route: string) => (await (await fetch(`${base}${route}`, { headers })).json()) as { agents: { agent: string; roles: string[]; readsRepository: boolean }[]; checkedAt: string; checking: boolean };

  const first = await get("/api/agents");
  assert.deepEqual(first.agents.map((a) => a.agent), ["claude-code", "codex", "grok", "antigravity"]);
  // Which agents read a repository attached to a chat: the rule the chat's own request is checked by (src/api/chat.ts).
  assert.deepEqual(first.agents.map((a) => a.readsRepository), [false, true, true, false]);
  assert.deepEqual(first.agents.map((a) => a.roles), [["planner", "builder"], await codexRoles(), ["reviewer"], ["reviewer"]]);
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)), first.checkedAt);
  const again = await get("/api/agents");
  assert.equal(again.checkedAt, first.checkedAt, "the second call answers from the same check");
  assert.equal(again.checking, false);
  const fresh = await get("/api/agents?fresh=1");
  assert.ok(Date.parse(fresh.checkedAt) > Date.parse(first.checkedAt), "a fresh check is a new one");
});
