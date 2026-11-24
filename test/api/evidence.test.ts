import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { git, initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";

// Evidence tied to the commit under review, over real HTTP: a real Botbench server, real SQLite, real temporary git
// repositories, real setup and check commands in the real sandbox. The builder is a turn replayed from a real Claude
// Code session (test/support/replay-build.ts); it changes no file, so each repository's setup writes the task's work.
// No model turn is started. The rules themselves are tested in test/engine/evidence.test.ts.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  base: string;
  headers: Record<string, string>;
  home: string;
  /** A repository with one check, and one with none. */
  checked: string;
  plain: string;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-evidence-api-");
  const home = path.join(dir, "home");
  const checked = path.join(dir, "checked");
  const plain = path.join(dir, "plain");
  initRepo(checked);
  initRepo(plain);
  const setup = ["printf 'hi\\n' > hello.txt"];
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [checked]: { setup, checks: ["test -f hello.txt"] }, [plain]: { setup } } };
  const server = await startServer({ config, home, signInDelayMs: 1, claudeCode: buildReplayDriver(["done", "done", "done"]) });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, home, checked, plain, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Body };
}

/** Start a task over HTTP and wait until it is ready for review; its description. */
async function ready(api: Api, repo: string): Promise<Body> {
  const started = await call(api, "POST", "/api/tasks", { repo, prompt: "Add a greeting file" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return until(api, Number(started.body.taskId), "awaiting_decision");
}

/** Read a task until it stands at `status`, whatever it ends as: a task that fails or stops ends the wait too. */
async function until(api: Api, id: number, status: string): Promise<Body> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const task = (await call(api, "GET", `/api/tasks/${id}`)).body;
    if (task.status === status) return task;
    if (["failed", "interrupted", "cancelled", "accepted", "rejected"].includes(String(task.status)) || Date.now() > deadline) assert.fail(`task ${id} is ${String(task.status)}, not ${status}: ${String(task.reason)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const state = (task: Body): Body => task.evidenceState as Body;
const checkRows = (task: Body): Body[] => (task.evidence as Body[]).filter((row) => row.kind === "check");

test("a task's description carries the state of its evidence and its facts; out-of-date checks refuse Accept with the words and the state, Run checks again stores a second result, and Accept is then made", { skip: NO_SANDBOX }, async (t) => {
  const api = await start(t);
  const task = await ready(api, api.checked);
  const id = Number(task.id);
  const head = String(task.headCommit);
  assert.deepEqual([state(task).state, state(task).checks, state(task).checkedCommit, state(task).headCommit, state(task).files, state(task).ignored, state(task).review, task.evidenceProblem], ["current", "passed", head, head, [], [], null, null]);
  assert.match(String(state(task).words), /^Evidence is current: the checks passed on commit [0-9a-f]{7}, the commit Accept keeps\.$/);
  assert.deepEqual(checkRows(task).map((row) => [row.round, row.commit]), [[1, head]]);
  assert.deepEqual([task.checkReruns, task.checkingAgain], [[], false]);

  // The owner commits on the task's branch, in its copy.
  const copy = git(api.checked, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).find((dir) => dir.endsWith(`task-${id}`))!;
  write(copy, "mine.txt", "the owner's own work\n");
  const later = ownerCommit(copy, "the owner's commit");
  const stale = (await call(api, "GET", `/api/tasks/${id}`)).body;
  assert.deepEqual([state(stale).state, state(stale).checkedCommit, state(stale).headCommit, state(stale).canRunAgain], ["stale", head, later, true]);

  const refused = await call(api, "POST", `/api/tasks/${id}/accept`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, `The checks are out of date: they ran on commit ${head.slice(0, 7)}, and the branch is now at commit ${later.slice(0, 7)}. Run checks again to check the commit you would accept.`);
  assert.equal((refused.body.evidenceState as Body).state, "stale");
  assert.equal(fs.existsSync(copy), true);

  // Run checks again needs a session, and takes nothing from its body: a command sent with it is not run.
  const unsigned = await fetch(`${api.base}/api/tasks/${id}/run-checks-again`, { method: "POST", headers: JSON_TYPE, body: "{}" });
  assert.equal(unsigned.status, 401);
  await unsigned.arrayBuffer();
  const marker = path.join(copy, "ran-by-request.txt");
  const again = await call(api, "POST", `/api/tasks/${id}/run-checks-again`, { command: `touch '${marker}'`, checks: [`touch '${marker}'`], commands: [{ command: `touch '${marker}'`, limitMs: 1000 }] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.status, again.body.checkingAgain, again.body.evidenceState], ["verifying", true, null]);
  // While they run, neither a decision nor a second re-run is taken.
  const meanwhile = await call(api, "POST", `/api/tasks/${id}/accept`, {});
  if (meanwhile.status !== 200) assert.match(String(meanwhile.body.error), /is still being checked|out of date/);
  const checkedAgain = await until(api, id, "awaiting_decision");
  if (meanwhile.status === 200) assert.fail("an accept was made while the checks ran again");
  assert.equal(fs.existsSync(marker), false, "nothing the request named was run");
  assert.deepEqual(checkRows(checkedAgain).map((row) => [row.round, row.command, row.outcome, row.commit]), [[1, "test -f hello.txt", "passed", head], [2, "test -f hello.txt", "passed", later]]);
  assert.deepEqual((checkedAgain.checkReruns as Body[]).map((r) => [r.requestedBy, r.fromCommit, r.headCommit, r.outcome]), [["owner", head, later, "passed"]]);
  assert.deepEqual([state(checkedAgain).state, state(checkedAgain).checkedCommit, checkedAgain.checkingAgain], ["current", later, false]);
  const nothing = await call(api, "POST", `/api/tasks/${id}/run-checks-again`, {});
  assert.equal(nothing.status, 409);
  assert.match(String(nothing.body.error), /already ran on commit/);

  const accepted = await call(api, "POST", `/api/tasks/${id}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const decision = accepted.body.decision as Body;
  assert.deepEqual([decision.decision, decision.headCommit, decision.checks, decision.checksCommit], ["accept", later, "passed", later]);
  assert.equal(accepted.body.evidenceState, null, "a decided task has no evidence left to weigh");
});

test("a copy that differs from its commit refuses Accept over HTTP, with the files in the answer, and Reject still works", { skip: NO_SANDBOX }, async (t) => {
  const api = await start(t);
  const task = await ready(api, api.checked);
  const id = Number(task.id);
  const copy = git(api.checked, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).find((dir) => dir.endsWith(`task-${id}`))!;
  write(copy, "hello.txt", "edited after the checks\n");
  write(copy, "notes.txt", "new, and not ignored\n");
  const shown = (await call(api, "GET", `/api/tasks/${id}`)).body;
  assert.equal(state(shown).state, "differs");
  assert.deepEqual(state(shown).files, [{ path: "hello.txt", change: "changed" }, { path: "notes.txt", change: "untracked" }]);
  const refused = await call(api, "POST", `/api/tasks/${id}/accept`, { removeLeftovers: ["hello.txt", "notes.txt"] });
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /^The task's copy has 2 files that differ from commit [0-9a-f]{7}: hello\.txt \(changed\), notes\.txt \(not on the branch\)\./);
  assert.deepEqual((refused.body.evidenceState as Body).files, state(shown).files);
  const rerun = await call(api, "POST", `/api/tasks/${id}/run-checks-again`, {});
  assert.equal(rerun.status, 409);
  assert.match(String(rerun.body.error), /^The task's copy has 2 files that differ/);
  assert.equal(fs.readFileSync(path.join(copy, "notes.txt"), "utf8"), "new, and not ignored\n");
  // Reject is always allowed, once the files it would remove are confirmed.
  const rejected = await call(api, "POST", `/api/tasks/${id}/reject`, { branch: "keep", removeLeftovers: ["hello.txt", "notes.txt"] });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
});

test("no checks set up: Accept over HTTP is refused until the request says it is without verification, and the decision and the action log say so", { skip: NO_SANDBOX }, async (t) => {
  const api = await start(t);
  const task = await ready(api, api.plain);
  const id = Number(task.id);
  assert.deepEqual([task.checks, state(task).state, state(task).canRunAgain], ["none", "none", false]);
  assert.equal(state(task).words, "No checks are set up for this repository, so nothing verified this work. You can accept it without verification.");

  const refused = await call(api, "POST", `/api/tasks/${id}/accept`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "No checks are set up for this repository, so nothing verified this work. To accept it all the same, choose Accept without verification.");
  assert.equal((await call(api, "POST", `/api/tasks/${id}/accept`, { withoutVerification: "true" })).status, 400);
  assert.equal((await call(api, "POST", `/api/tasks/${id}/run-checks-again`, {})).status, 409);
  assert.equal((await call(api, "GET", `/api/tasks/${id}`)).body.status, "awaiting_decision");

  const accepted = await call(api, "POST", `/api/tasks/${id}/accept`, { withoutVerification: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const decision = accepted.body.decision as Body;
  assert.deepEqual([decision.decision, decision.checks, decision.checksCommit], ["accept", "none", null]);
  const log = ((await call(api, "GET", `/api/action-log?taskId=${id}`)).body.entries as Body[]).filter((entry) => entry.rule === "owner_accepted");
  assert.equal(log.length, 1);
  assert.match(String(log[0]!.detail), /Accepted without verification: no checks are set up for this repository, so nothing verified this work\./);
});
