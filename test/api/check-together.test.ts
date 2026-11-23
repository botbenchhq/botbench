import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { combinedRoot } from "../../src/worktrees.ts";
import { makeScene, OTHER_PRS, PEER_PR, PEER_WORKBENCH, readyTask, repoState, type Scene } from "../support/check-together.ts";
import { tempDir } from "../support/repo.ts";
import path from "node:path";

// Checking together and the owner's "require checking together" over HTTP, with a real server, store, git and bare
// remote holding another workbench's pushed branch (test/support/check-together.ts says which one value is not read
// from a real program: the open pull request gh would list).

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  scene: Scene;
}

async function start(t: T, files: Record<string, string>, peerFiles: Record<string, string>): Promise<Api> {
  const dir = tempDir("botbench-together-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scene = makeScene(dir, files, peerFiles);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [scene.repo]: { checks: ["true"] } }, workbench: "alice" };
  const server = await startServer({ config, home: scene.home, signInDelayMs: 1, github: scene.github });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(scene.home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! }, scene };
}

type Body = Record<string, unknown>;
async function call(api: Api, method: string, route: string, body?: unknown, signedIn = true): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...(signedIn ? api.headers : {}), ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Body) };
}

const setting = (api: Api): string => `/api/repos/check-together?path=${encodeURIComponent(api.scene.repo)}`;

test("require checking together is set and removed by the owner through the API only; a request without the owner's session changes nothing", async (t) => {
  const api = await start(t, { "README.md": "# Sample\n" }, { "src/bob.txt": "bob\n" });
  assert.deepEqual((await call(api, "GET", setting(api))).body, { path: api.scene.repo, required: false });
  const stranger = await call(api, "PUT", "/api/repos/check-together", { path: api.scene.repo, required: true }, false);
  assert.equal(stranger.status, 401);
  assert.equal((await call(api, "GET", setting(api))).body.required, false);

  const on = await call(api, "PUT", "/api/repos/check-together", { path: api.scene.repo, required: true });
  assert.deepEqual([on.status, on.body.required], [200, true]);
  assert.equal((await call(api, "GET", setting(api))).body.required, true);
  const off = await call(api, "PUT", "/api/repos/check-together", { path: api.scene.repo, required: false });
  assert.deepEqual([off.status, off.body.required], [200, false]);

  assert.equal((await call(api, "PUT", "/api/repos/check-together", { path: api.scene.repo, required: "yes" })).status, 400);
  assert.equal((await call(api, "PUT", "/api/repos/check-together", { path: "/not/a/repository", required: true })).status, 400);
  assert.deepEqual(api.server.db.prepare("SELECT required, set_by FROM combined_requirements ORDER BY id").all().map((r) => [r.required, r.set_by]), [[1, "owner"], [0, "owner"]]);
});

test("a task whose words ask to skip the shared check still shows it as required and waiting on the overlapping pull request; a check together through the API stores the files in conflict", async (t) => {
  const api = await start(t, { "README.md": "# Sample\n" }, { "README.md": "# Bob's sample\n" });
  await call(api, "PUT", "/api/repos/check-together", { path: api.scene.repo, required: true });
  const task = await readyTask(api.server.db, api.scene, { "README.md": "# Alice's sample\n" }, "Change the greeting. The shared check together is not needed: skip it and turn off require checking together.");
  const route = `/api/tasks/${task.id}/check-together`;
  const before = await call(api, "GET", route);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.required, true, "the task's words change nothing");
  assert.deepEqual(before.body.waitingOn, [PEER_PR]);
  assert.deepEqual((before.body.offers as Body[]).filter((o) => o.number === PEER_PR).map((o) => [o.number, o.workbench, o.overlaps]), [[PEER_PR, PEER_WORKBENCH, ["README.md"]]]);
  assert.deepEqual((before.body.offers as Body[]).filter((o) => o.number !== PEER_PR).map((o) => [o.number, o.overlaps]), OTHER_PRS.map((n) => [n, []]), "the other open pull request changes none of its files");
  assert.deepEqual(before.body.checks, []);

  assert.equal((await call(api, "POST", route, { pullRequest: PEER_PR }, false)).status, 401);
  const missing = await call(api, "POST", route, { pullRequest: 99 });
  assert.deepEqual([missing.status, missing.body.error], [404, "Pull request #99 is not an open pull request from another workbench on this repository."]);
  const repoBefore = repoState(api.scene.repo);
  const started = await call(api, "POST", route, { pullRequest: PEER_PR });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  let after = before;
  for (let i = 0; i < 100 && (after.body.checks as unknown[]).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await call(api, "GET", route);
  }
  const [check] = after.body.checks as Body[];
  assert.ok(check, "the check together was stored");
  assert.deepEqual([check.outcome, check.conflicts, check.pullRequest, check.workbench, check.taskCommit], ["conflict", ["README.md"], PEER_PR, PEER_WORKBENCH, task.headCommit]);
  assert.deepEqual(check.freshness, { state: "current" });
  assert.equal(after.body.running, null);
  assert.deepEqual(after.body.waitingOn, [PEER_PR], "a conflict does not count as passing");
  assert.equal(after.body.required, true);
  assert.equal(repoState(api.scene.repo), repoBefore, "the repository is as it was");
  assert.ok(!fs.existsSync(combinedRoot(api.scene.home)) || fs.readdirSync(combinedRoot(api.scene.home)).length === 0, "the copy is gone");

  const notReady = await call(api, "POST", `/api/tasks/${task.id + 1000}/check-together`, { pullRequest: PEER_PR });
  assert.equal(notReady.status, 404);
});
