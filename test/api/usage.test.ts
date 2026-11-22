import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { tempDir } from "../support/repo.ts";

// The usage route over real HTTP against a real Botbench server and real SQLite. The aggregation rules are in
// test/usage.test.ts; this proves the route: sign-in is needed, the agents Botbench has are listed from its configuration,
// and the sign-in kind comes from the agent's own probe (the real `claude auth status`).

test("GET /api/usage needs the owner's sign-in and reports stored usage, with the configured agent present even with no turns", async (t) => {
  const dir = tempDir("botbench-usage-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const refused = await fetch(`${base}/api/usage`);
  assert.equal(refused.status, 401);
  await refused.arrayBuffer();

  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  await signIn.arrayBuffer();
  const headers = { cookie: signIn.headers.getSetCookie()[0]!.split(";")[0]! };
  const read = async (): Promise<Record<string, any>> => {
    const res = await fetch(`${base}/api/usage`, { headers });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, any>;
  };

  const empty = await read();
  assert.deepEqual([empty.week.turns, empty.allTime.turns, empty.runs.total], [0, 0, 0]);
  assert.deepEqual(empty.week.agents.map((a: { driver: string; turns: number }) => [a.driver, a.turns]), [["claude-code", 0]]);
  assert.ok(["subscription", "metered", "unknown"].includes(empty.week.agents[0].billing));

  const attemptId = Number(server.db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES ('claude-code', 'claude-haiku-5-5', 'ended', ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  server.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, 'usage', ?)").run(attemptId, new Date().toISOString(), JSON.stringify({ type: "usage", inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 0 }));
  const used = await read();
  assert.deepEqual(used.week.agents[0].models, [{ model: "claude-haiku-5-5", turns: 1, inputTokens: 8, outputTokens: 4 }]);
  assert.equal(used.runs.total, 0, "a chat belongs to no run");
});
