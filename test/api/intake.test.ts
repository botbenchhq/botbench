import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { ISSUE_ADDRESS, ISSUE_NUMBER, replayIssues } from "../support/replay-issue.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The issue routes over real HTTP, against a real Botbench server, real git and real SQLite. No driver is started:
// a run is put in the store as the engine stores it. gh's answers are replayed from output captured once from the real
// gh (test/support/replay-issue.ts, the owner's approved exception), through the server's GitHub seam.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  dir: string;
  repo: string;
  reads: { number: number }[];
}

async function start(t: T, o: { defaultFull?: boolean } = {}): Promise<Api> {
  const dir = tempDir("botbench-intake-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  git(repo, "remote", "add", "origin", ISSUE_ADDRESS);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: { allowedHosts: ["registry.npmjs.org"], checks: ["true"] } }, ...(o.defaultFull ? { autonomy: { mode: "full" } } : {}) } as Config;
  const replay = replayIssues();
  const server = await startServer({ config, home, signInDelayMs: 1, github: replay.github });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, base, dir, repo, reads: replay.reads, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

test("a repository's GitHub repository and allowed hosts are told to the composer; one with no GitHub remote says why", async (t) => {
  const api = await start(t);
  const found = await call(api, "GET", `/api/repos/github?path=${encodeURIComponent(api.repo)}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { repository: "github.com/cli/cli", problem: null, hosts: ["registry.npmjs.org"] });
  const plain = path.join(api.dir, "plain");
  initRepo(plain);
  const none = await call(api, "GET", `/api/repos/github?path=${encodeURIComponent(plain)}`);
  assert.equal(none.body.repository, null);
  assert.match(String(none.body.problem), /no remote named origin/);
  assert.equal((await call(api, "GET", "/api/repos/github?path=relative")).status, 400);
});

test("an issue is looked up by number or same-repository address and kept as read; any other reference is refused before gh is run", async (t) => {
  const api = await start(t);
  const looked = await call(api, "POST", "/api/issues", { repo: api.repo, issue: `https://github.com/cli/cli/issues/${ISSUE_NUMBER}` });
  assert.equal(looked.status, 200, JSON.stringify(looked.body));
  const issue = looked.body.issue as Body;
  assert.equal(issue.number, ISSUE_NUMBER);
  assert.equal(issue.repository, "github.com/cli/cli");
  assert.equal(issue.state, "CLOSED");
  assert.equal(issue.author, "jeffwall-curlewlabs");
  assert.equal(typeof issue.body, "string");
  assert.equal(issue.commentCount, 3);
  assert.equal(issue.cutWords, null);
  assert.equal(typeof issue.fetchId, "number");
  assert.equal(api.server.db.prepare("SELECT COUNT(*) AS n FROM issue_fetches").get()!.n, 1);

  for (const [given, words] of [["https://github.com/someone/else/issues/3", /not github\.com\/cli\/cli/], ["https://github.com/cli/cli/pull/3", /pull request/], ["x; rm -rf ~", /not an issue number/]] as const) {
    const res = await call(api, "POST", "/api/issues", { repo: api.repo, issue: given });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), words);
  }
  assert.equal(api.reads.length, 1, "gh was asked only for the issue that could be named");
  const pull = await call(api, "POST", "/api/issues", { repo: api.repo, issue: "1" });
  assert.equal(pull.status, 400);
  assert.match(String(pull.body.error), /is a pull request, not an issue/);
  const missing = await call(api, "POST", "/api/issues", { repo: api.repo, issue: "#42" });
  assert.match(String(missing.body.error), /Issue #42 of github\.com\/cli\/cli could not be read: The gh tool said: GraphQL: Could not resolve/);
  assert.equal(api.server.db.prepare("SELECT COUNT(*) AS n FROM issue_fetches").get()!.n, 1, "nothing is kept of what could not be read");
});

test("a run from an issue is refused as fully autonomous, chosen or by default, and nothing is made; a marked run and its tasks say so and link the issue", async (t) => {
  const api = await start(t, { defaultFull: true });
  const fetchId = ((await call(api, "POST", "/api/issues", { repo: api.repo, issue: String(ISSUE_NUMBER) })).body.issue as Body).fetchId;
  for (const mode of ["full", undefined]) {
    const res = await call(api, "POST", "/api/runs", { repo: api.repo, issue: { fetchId, allowHosts: false }, ...(mode === undefined ? {} : { mode }) });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /^A run started from a GitHub issue cannot be fully autonomous: people outside this project wrote the issue, and a stranger's text must not lead to an accepted change and a pull request with nobody looking\./);
  }
  assert.equal(api.server.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);

  const db = api.server.db;
  const run = createRun(db, { repo: api.repo, baseCommit: git(api.repo, "rev-parse", "HEAD").trim(), issue: { fetchId: Number(fetchId), allowHosts: false }, mode: "manual" });
  const [task] = approvePlan(db, run.id, storePlan(db, run.id, [{ title: "Fix the cut log", criteria: ["Long lines are printed"] }]).planVersion).tasks;
  const shown = (await call(api, "GET", `/api/runs/${run.id}`)).body;
  assert.equal(shown.outsideText, true);
  assert.equal(shown.outsideHosts, false);
  assert.equal(shown.prompt, null);
  assert.match(String(shown.title), new RegExp(`^Issue #${ISSUE_NUMBER}: `));
  const linked = shown.issue as Body;
  assert.equal(linked.url, `https://github.com/cli/cli/issues/${ISSUE_NUMBER}`);
  assert.equal(typeof linked.fetchedAt, "string");
  const listed = ((await call(api, "GET", "/api/runs")).body.runs as Body[]).find((r) => r.id === run.id)!;
  assert.equal(listed.outsideText, true);
  const taskShown = (await call(api, "GET", `/api/tasks/${task!.id}`)).body;
  assert.equal(taskShown.outsideText, true);
  assert.equal((taskShown.issue as Body).number, ISSUE_NUMBER);
});
