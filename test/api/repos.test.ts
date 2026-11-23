import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createTask } from "../../src/engine/task.ts";
import { startServer } from "../../src/server.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// The repositories New task and New run offer: the ones used before, newest first, then the ones the settings file
// names. No test here starts a driver: the tasks are rows made by the engine's own function and never built.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

async function start(t: T, dir: string, repositories?: Config["repositories"]) {
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, ...(repositories ? { repositories } : {}) };
  const home = path.join(dir, "home");
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { server, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

function workspace(t: T): string {
  const dir = fs.realpathSync(tempDir("botbench-repos-api-"));
  return dir;
}

const list = async (base: string, headers: Record<string, string>) => {
  const res = await fetch(`${base}/api/repos`, { headers });
  return { status: res.status, body: (await res.json()) as unknown };
};

test("the repository list needs a session", async (t) => {
  const { base } = await start(t, workspace(t));
  for (const without of [{}, { cookie: "botbench_session=not-a-session" }] as Record<string, string>[]) {
    assert.deepEqual(await list(base, without), { status: 401, body: { error: "sign in required" } });
  }
});

test("with nothing used and nothing configured, the list is empty", async (t) => {
  const { base, headers } = await start(t, workspace(t));
  assert.deepEqual(await list(base, headers), { status: 200, body: { repositories: [] } });
});

test("the repositories used before come newest first, each once, then the configured ones not already listed", async (t) => {
  const dir = workspace(t);
  const [alpha, beta, gamma, configured] = ["alpha", "beta", "gamma", "configured"].map((name) => path.join(dir, name));
  for (const repo of [alpha!, beta!, gamma!, configured!]) initRepo(repo);
  const { server, base, headers } = await start(t, dir, { [configured!]: { preapproved: [] }, [`${gamma}/`]: { checks: ["npm test"] } });
  createTask(server.db, { repo: alpha!, prompt: "first" });
  createTask(server.db, { repo: beta!, prompt: "second" });
  createTask(server.db, { repo: gamma!, prompt: "third" });
  // Used again: alpha is now the most recent.
  createTask(server.db, { repo: alpha!, prompt: "fourth" });
  assert.deepEqual(await list(base, headers), {
    status: 200,
    body: {
      repositories: [
        { name: "alpha", path: alpha },
        { name: "gamma", path: gamma },
        { name: "beta", path: beta },
        { name: "configured", path: configured },
      ],
    },
  });
});

test("at most ten repositories used before are listed, the newest ones", async (t) => {
  const dir = workspace(t);
  const { server, base, headers } = await start(t, dir);
  for (let i = 1; i <= 12; i++) {
    const repo = path.join(dir, `repo-${i}`);
    initRepo(repo);
    createTask(server.db, { repo, prompt: `task ${i}` });
  }
  const { body } = await list(base, headers);
  const names = (body as { repositories: { name: string }[] }).repositories.map((r) => r.name);
  assert.deepEqual(names, ["repo-12", "repo-11", "repo-10", "repo-9", "repo-8", "repo-7", "repo-6", "repo-5", "repo-4", "repo-3"]);
});
