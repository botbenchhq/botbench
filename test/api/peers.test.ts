import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createTask } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { replayIssues } from "../support/replay-issue.ts";
import { PEERS_ADDRESS, replayPeers } from "../support/replay-peers.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The workbench's name and the view of other workbenches' work, over HTTP, with a real server, store and git. The
// shared remote is a real bare repository holding branches pushed from two other "installations" and from this one;
// the repository names it by the GitHub address of the owner's repository, which its git settings send to the bare
// repository (`url.<bare>.insteadOf`). gh's list of open pull requests is output captured once from the real gh for
// that repository, replayed through the GitHub seam (test/support/replay-peers.ts, the owner's approved exception).

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  repo: string;
  bare: string;
  lists: unknown[];
}

async function start(t: T, o: { workbench?: string } = {}): Promise<Api> {
  const dir = tempDir("botbench-peers-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", bare);
  git(repo, "config", `url.${bare}.insteadOf`, PEERS_ADDRESS);
  git(repo, "remote", "add", "origin", PEERS_ADDRESS);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: {} }, ...(o.workbench === undefined ? {} : { workbench: o.workbench }) };
  const replay = replayPeers(replayIssues().github);
  const server = await startServer({ config, home, signInDelayMs: 1, github: replay.github });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! }, repo, bare, lists: replay.lists };
}

type Body = Record<string, unknown>;
async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Body) };
}

/** Push a commit of `repo` to the shared remote under each of `branches`, as the installations that made them would. */
function pushed(api: Api, branches: string[]): void {
  for (const branch of branches) git(api.repo, "push", "--quiet", api.bare, `HEAD:refs/heads/${branch}`);
}

test("Settings shows the workbench name, made from the host name at first start, and saves a new one; a name a git ref could not carry is refused", async (t) => {
  const api = await start(t);
  const first = await call(api, "GET", "/api/settings");
  const shown = first.body.workbench as { name: string; setInFile: boolean };
  assert.match(shown.name, /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/);
  assert.equal(shown.setInFile, false);

  const saved = await call(api, "PUT", "/api/settings", { workbench: "alice" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual((await call(api, "GET", "/api/settings")).body.workbench, { name: "alice", setInFile: false });
  const bad = await call(api, "PUT", "/api/settings", { workbench: "Alice/../x" });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /lowercase letters, digits and hyphens/);
  assert.equal(((await call(api, "GET", "/api/settings")).body.workbench as { name: string }).name, "alice");
  assert.equal((await call(api, "PUT", "/api/settings", { defaultMode: "semi" })).status, 200, "the default mode is still saved on its own");
});

test("a workbench name set in the settings file is the one used, and Settings says it is changed there", async (t) => {
  const api = await start(t, { workbench: "from-file" });
  assert.deepEqual((await call(api, "GET", "/api/settings")).body.workbench, { name: "from-file", setInFile: true });
  const refused = await call(api, "PUT", "/api/settings", { workbench: "other" });
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /settings file/);
});

test("the view of a repository lists another workbench's pushed branches from the real remote, not this one's own nor the older forms, and is kept for a while", async (t) => {
  const api = await start(t, { workbench: "alice" });
  pushed(api, ["botbench/alice/run-1/task-1", "botbench/bob/run-1/task-1", "botbench/bob/run-2/task-2", "botbench/carol/run-1/task-1", "botbench/run-4/task-5", "botbench/Dave/run-1/task-1", "main"]);
  const res = await call(api, "GET", `/api/peers?path=${encodeURIComponent(api.repo)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const view = res.body.view as Record<string, unknown>;
  assert.equal(view.state, "ready", String(view.problem));
  assert.equal(view.repository, "github.com/jon-lange/botbench");
  assert.deepEqual(view.branches, [
    { workbench: "bob", branch: "botbench/bob/run-1/task-1" },
    { workbench: "bob", branch: "botbench/bob/run-2/task-2" },
    { workbench: "carol", branch: "botbench/carol/run-1/task-1" },
  ]);
  assert.deepEqual(view.pullRequests, [], "the real list had no open pull request");

  pushed(api, ["botbench/erin/run-1/task-1"]);
  const again = (await call(api, "GET", `/api/peers?path=${encodeURIComponent(api.repo)}`)).body.view as Record<string, unknown>;
  assert.equal((again.branches as unknown[]).length, 3, "read again only after a while");
  assert.equal(api.lists.length, 1, "gh was asked once");
});

test("the Work screen's views: each repository the owner has used; a repository with no GitHub remote says so in plain words", async (t) => {
  const api = await start(t, { workbench: "alice" });
  pushed(api, ["botbench/bob/run-1/task-1"]);
  const plain = path.join(path.dirname(api.repo), "plain");
  initRepo(plain);
  createTask(api.server.db, { repo: api.repo, prompt: "one" });
  createTask(api.server.db, { repo: plain, prompt: "two" });
  const res = await call(api, "GET", "/api/peers");
  assert.equal(res.status, 200);
  const views = res.body.views as Record<string, unknown>[];
  assert.deepEqual(views.map((v) => [v.repo, v.state]).sort(), [[api.repo, "ready"], [plain, "unavailable"]].sort());
  assert.match(String(views.find((v) => v.repo === plain)!.problem), /has no remote named origin/);
  const refused = await call(api, "GET", `/api/peers?path=${encodeURIComponent("/not/a/repository")}`);
  assert.equal(refused.status, 400);
});
