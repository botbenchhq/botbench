import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";
import { checkoutState, initRepo, tempDir } from "../support/repo.ts";

// The verify station on the real Claude Code, on the owner's login, through Smelt's HTTP API: a task of its own (a run
// of one) in a real temporary repository whose settings give it a check command, a fixture script committed in the
// repository that checks the agent's work. One tiny turn each, on the cheapest model.

const TASK_TIMEOUT = 240_000;
const JSON_TYPE = { "content-type": "application/json" };
// The check reads what the agent wrote: hello.txt must hold the word the check was given.
const CHECK_SCRIPT = '#!/bin/sh\necho "checking hello.txt for $1"\ngrep -q "$1" hello.txt && echo "found it" || { echo "hello.txt does not hold $1" >&2; exit 1; }\n';

interface Live {
  server: SmeltServer;
  base: string;
  headers: Record<string, string>;
  repo: string;
}
type Body = Record<string, unknown>;

async function start(t: TestContext, check: string): Promise<Live> {
  const dir = tempDir("smelt-live-verify-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "check.sh": CHECK_SCRIPT });
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } }, repositories: { [repo]: { checks: [{ command: check, timeoutSeconds: 60 }] } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return { server, base, repo, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

/** Start a task that writes hello.txt, decline anything it asks, and wait for its end. Returns the task and every state it was seen at. */
async function built(live: Live): Promise<{ task: Body; seen: string[] }> {
  const res = await fetch(`${live.base}/api/tasks`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ repo: live.repo, prompt: "Create the file hello.txt containing the single word hi, with your Write tool. Run no command." }) });
  const { taskId } = (await res.json()) as { taskId: number };
  const seen: string[] = [];
  const deadline = Date.now() + TASK_TIMEOUT - 30_000;
  for (;;) {
    const task = (await (await fetch(`${live.base}/api/tasks/${taskId}`, { headers: live.headers })).json()) as Body;
    if (seen.at(-1) !== task.status) seen.push(String(task.status));
    if (!["queued", "building", "verifying"].includes(String(task.status))) return { task, seen };
    for (const approval of ((await (await fetch(`${live.base}/api/approvals?status=pending`, { headers: live.headers })).json()) as { approvals: Body[] }).approvals) {
      await fetch(`${live.base}/api/approvals/${approval.id}`, { method: "POST", headers: { ...live.headers, ...JSON_TYPE }, body: JSON.stringify({ decision: "decline", note: "Write the file with your Write tool; run no command." }) });
    }
    if (Date.now() > deadline) assert.fail(`timed out; the task is ${JSON.stringify(task).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("live: a task whose fixture check passes ends Ready for review marked checks passed, with the check's output and exit status as evidence", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t, "sh check.sh hi");
  const before = checkoutState(live.repo);
  const { task } = await built(live);
  assert.equal(task.status, "awaiting_decision", String(task.reason));
  assert.equal(task.checks, "passed");
  const checks = (task.evidence as Body[]).filter((row) => row.kind === "check");
  assert.deepEqual(checks.map((row) => [row.command, row.outcome, row.exitCode]), [["sh check.sh hi", "passed", 0]]);
  assert.match(String(checks[0]!.output), /checking hello.txt for hi\nfound it/);
  assert.deepEqual(checkoutState(live.repo), before);
});

test("live (AE3): a task whose fixture check fails ends Ready for review marked checks failed, with the failing output attached", { timeout: TASK_TIMEOUT }, async (t) => {
  const live = await start(t, "sh check.sh goodbye");
  const { task } = await built(live);
  assert.equal(task.status, "awaiting_decision", String(task.reason));
  assert.equal(task.checks, "failed");
  const checks = (task.evidence as Body[]).filter((row) => row.kind === "check");
  assert.deepEqual(checks.map((row) => [row.command, row.outcome, row.exitCode]), [["sh check.sh goodbye", "failed", 1]]);
  assert.match(String(checks[0]!.output), /hello.txt does not hold goodbye/);
  assert.deepEqual((task.files as Body[]).map((f) => f.path), ["hello.txt"], "the agent's work is on the branch all the same");
});
