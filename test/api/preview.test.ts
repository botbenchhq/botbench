import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { appendLog } from "../../src/approvals/broker.ts";
import { MAX_ENTRY, insertStanding, realRepo } from "../../src/approvals/grants.ts";
import type { Config } from "../../src/config.ts";
import { createTask } from "../../src/engine/task.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { tempDir } from "../support/repo.ts";

// The command check of the Permissions screen over HTTP: a real server, its own broker and a real store. Nothing is
// asked of anyone and no driver is started.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

async function start(t: T): Promise<{ server: BotbenchServer; repo: string; check(query: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> }> {
  const dir = tempDir("botbench-preview-api-");
  const home = path.join(dir, "home");
  // The check reads the repository's settings by its path and asks nothing of git, so a folder is all it needs.
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: { preapproved: ["npm test"] } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const check = async (query: Record<string, string>) => {
    const reply = await fetch(`${base}/api/permissions/preview?${new URLSearchParams(query)}`, { headers: { cookie } });
    return { status: reply.status, body: (await reply.json()) as Record<string, unknown> };
  };
  return { server, repo, check };
}

type Mode = { mode: string; verdict: string; rule: string; floor?: string; grant?: { kind: string; command: string }; words: string };

const counts = (server: BotbenchServer): Record<string, number> =>
  Object.fromEntries(["approvals", "action_log", "grants", "grant_revocations", "events", "tasks", "runs"].map((table) => [table, Number(server.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]));

test("a check answers for Manual, Semi-autonomous and Fully autonomous with the rule behind each, and writes nothing", async (t) => {
  const { server, repo, check } = await start(t);
  // Something on record already, so that a row added by the check would show.
  const task = createTask(server.db, { repo, prompt: "lint", preapproved: ["make lint"] });
  const id = insertStanding(server.db, { role: "implementer", repo: realRepo(repo), cwd: ".", words: ["make", "build"], taskId: task.id });
  appendLog(server.db, { taskId: task.id, runId: task.runId, attemptId: null, grantId: id, rule: "standing_granted", tool: "Bash", command: "make build", cwd: "." });
  const before = counts(server);

  const push = await check({ path: repo, command: "git push" });
  assert.equal(push.status, 200);
  assert.equal(push.body.repository, realRepo(repo));
  assert.equal(push.body.command, "git push");
  const pushModes = push.body.modes as Mode[];
  assert.deepEqual(pushModes.map((m) => [m.mode, m.verdict, m.floor]), [["manual", "ask", "git-push"], ["semi", "ask", "git-push"], ["full", "refuse", "git-push"]]);
  assert.equal(pushModes[1]!.words, "Asks you. On the always-ask list: it sends commits to another computer.");

  // The repository's settings list `npm test`: it runs without asking in each mode, on that rule.
  const npm = (await check({ path: repo, command: "npm test" })).body.modes as Mode[];
  assert.deepEqual(npm.map((m) => [m.mode, m.verdict, m.rule, m.grant?.kind]), [["manual", "allow", "preapproved", "preapproved"], ["semi", "allow", "preapproved", "preapproved"], ["full", "allow", "preapproved", "preapproved"]]);

  // The Always allow in the store covers its own command.
  assert.deepEqual(((await check({ path: repo, command: "make build" })).body.modes as Mode[]).map((m) => m.rule), ["standing", "standing", "standing"]);

  assert.deepEqual(counts(server), before, "no approval, log entry, grant or anything else was written");
});

test("a command that cannot be checked is refused in words, with no verdict", async (t) => {
  const { repo, check } = await start(t);
  for (const [command, words] of [
    ["", "Give a command to check."],
    ["a".repeat(MAX_ENTRY + 1), `The command is too long to check: ${MAX_ENTRY} characters at most.`],
    ["ls\0", "The command holds a NUL character, which no shell can be handed, so it cannot be checked."],
  ] as const) {
    const reply = await check({ path: repo, command });
    assert.equal(reply.status, 400, JSON.stringify(command.slice(0, 20)));
    assert.deepEqual(reply.body, { error: words });
  }
  assert.deepEqual((await check({ path: repo })).body, { error: "Give a command to check." });
});

test("a missing or relative repository path is a 400 in plain words", async (t) => {
  const { check } = await start(t);
  const words = 'Give one "path": the full path of a repository, starting with /.';
  const queries: Record<string, string>[] = [{ command: "ls" }, { path: "repo", command: "ls" }, { path: "", command: "ls" }, { path: "/a\0b", command: "ls" }];
  for (const query of queries) {
    assert.deepEqual(await check(query), { status: 400, body: { error: words } }, JSON.stringify(query));
  }
});
