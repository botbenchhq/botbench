import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createRun } from "../../src/engine/run.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { replayIssues } from "../support/replay-issue.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";
import { capturedIssue, loadWatchCapture, replayWatchGh, replayWatchIssue, WATCH_ADDRESS } from "../support/replay-watch.ts";

// The issue watch's routes over real HTTP, against a real Botbench server whose watch polls at its start, real git and
// a real SQLite file under a data folder that a second start opens again. gh's answers are replayed from the capture
// taken once from the real gh (test/support/replay-watch.ts, the owner's approved exception). No driver is started.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  repo: string;
  home: string;
}

function place(t: T): { home: string; repo: string } {
  const dir = tempDir("botbench-watch-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  initRepo(repo);
  git(repo, "remote", "add", "origin", WATCH_ADDRESS);
  return { home: path.join(dir, "home"), repo };
}

async function start(t: T, at: { home: string; repo: string }): Promise<Api> {
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [at.repo]: { watch: { label: loadWatchCapture().label } } } } as Config;
  const server = await startServer({ config, home: at.home, signInDelayMs: 1, watchGh: replayWatchGh().run, github: replayWatchIssue(replayIssues().github) });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(at.home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, base, ...at, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

/** The watch as GET /api/watch gives it, once its first poll has ended. */
async function polled(api: Api): Promise<{ watches: Body[]; proposals: Body[] }> {
  for (let i = 0; i < 200; i++) {
    const { body } = await call(api, "GET", "/api/watch");
    const watches = body.watches as Body[];
    if (watches.every((w) => w.state === "checked" || w.state === "failed")) return body as { watches: Body[]; proposals: Body[] };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the watch's first poll did not end");
}

const count = (api: Api, table: string): number => Number(api.server.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

test("the server polls at its start and lists each proposal with its title and author, and nothing is built, run or asked of a model", async (t) => {
  const api = await start(t, place(t));
  const { watches, proposals } = await polled(api);
  assert.deepEqual(watches.map((w) => ({ path: w.path, repository: w.repository, label: w.label, intervalMinutes: w.intervalMinutes, state: w.state, problem: w.problem })), [{ path: api.repo, repository: "github.com/jon-lange/botbench", label: loadWatchCapture().label, intervalMinutes: 10, state: "checked", problem: null }]);
  const issue = capturedIssue();
  const shown = proposals.find((p) => p.number === issue.number)!;
  assert.equal(shown.title, issue.title);
  assert.equal(shown.author, issue.author);
  assert.equal(shown.repoPath, api.repo);
  const one = await call(api, "GET", `/api/watch/proposals/${String(shown.id)}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.proposal, shown);
  // A proposal is only that: no run, no task, no session with any agent.
  for (const table of ["runs", "tasks", "attempts", "issue_fetches"]) assert.equal(count(api, table), 0, table);

  // Start reads the issue as the composer always does, and a run started from it takes it off Work.
  const read = await call(api, "POST", "/api/issues", { repo: api.repo, issue: String(issue.number) });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(count(api, "runs"), 0, "reading the issue starts nothing");
  const fetchId = Number((read.body.issue as Body).fetchId);
  createRun(api.server.db, { repo: api.repo, baseCommit: git(api.repo, "rev-parse", "HEAD").trim(), issue: { fetchId, allowHosts: false }, mode: "semi" });
  const after = await call(api, "GET", "/api/watch");
  assert.ok(!(after.body.proposals as Body[]).some((p) => p.id === shown.id), "a run was started from it");
  assert.equal((await call(api, "GET", `/api/watch/proposals/${String(shown.id)}`)).status, 404);
});

test("Dismiss takes a proposal off Work, and it does not come back after a restart", async (t) => {
  const at = place(t);
  const first = await start(t, at);
  const issue = capturedIssue();
  const shown = (await polled(first)).proposals.find((p) => p.number === issue.number)!;
  const dismissed = await call(first, "POST", `/api/watch/proposals/${String(shown.id)}/dismiss`, {});
  assert.deepEqual(dismissed, { status: 200, body: { dismissed: true } });
  assert.equal((await call(first, "POST", `/api/watch/proposals/${String(shown.id)}/dismiss`, {})).status, 404);
  assert.ok(!((await call(first, "GET", "/api/watch")).body.proposals as Body[]).some((p) => p.id === shown.id), "it is off Work");
  await first.server.close();

  const second = await start(t, at);
  const again = await polled(second);
  assert.equal(again.watches[0]!.state, "checked", "the second start polled again");
  assert.ok(!again.proposals.some((p) => p.number === issue.number), "a dismissed issue never returns");
  assert.equal(Number(second.server.db.prepare("SELECT count(*) AS n FROM watched_issues WHERE number = ? AND state = 'dismissed'").get(issue.number)!.n), 1);
});
