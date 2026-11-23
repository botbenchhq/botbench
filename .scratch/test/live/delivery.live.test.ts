import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBroker } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { decideTask } from "../../src/engine/decision.ts";
import { createDeliveries, deliveryOf, deliverySteps } from "../../src/engine/delivery.ts";
import { createRun, createRuns, storePlan } from "../../src/engine/run.ts";
import { createTasks, getTask, TaskError } from "../../src/engine/task.ts";
import { createGitHub, ghArgs, runGh, type GhResult, type RunGh } from "../../src/github.ts";
import { openStore } from "../../src/store/db.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { GH_CAPTURE_FILE, type GhCapture } from "../support/replay-github.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The one test against real GitHub, safe by construction. With the owner's own gh (signed in as jon-lange), it makes a
// PRIVATE scratch repository named botbench-delivery-test-<random> under that account and nothing else, pushes a first
// commit, builds a real task with Botbench (its builder's turn replayed from a real Claude Code session, its setup and
// check commands real), accepts it in a run that chose pull requests, and lets Botbench push the branch and open the
// pull request with the real git and gh. It then checks the pull request on GitHub, that a second delivery opens no
// second one, and deletes the scratch repository (or archives it when the sign-in may not delete; then it says so).
// With BOTBENCH_CAPTURE_GH=1 it writes what gh printed to test/recordings/gh-delivery.json for the unit tests.

const OWNER = "jon-lange";
const SCRATCH = /^botbench-delivery-test-[0-9a-f]{12}$/;

/** gh run by the test itself, for setting up and checking the scratch repository: never on any other repository. */
function gh(args: string[], o: { allowFail?: boolean } = {}): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }) };
  } catch (err) {
    if (o.allowFail !== true) throw err;
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, out: String(e.stderr ?? "") };
  }
}

test("live: an accepted task of a pull-request run is pushed and opened as one real pull request on a private scratch repository, once", { timeout: 300_000 }, async (t) => {
  const who = gh(["api", "user", "--jq", ".login"], { allowFail: true });
  if (who.code !== 0 || who.out.trim() !== OWNER) return t.skip(`gh is not signed in as ${OWNER} here`);
  const name = `botbench-delivery-test-${randomBytes(6).toString("hex")}`;
  assert.match(name, SCRATCH);
  const full = `${OWNER}/${name}`;
  const created = gh(["repo", "create", full, "--private", "--disable-issues", "--disable-wiki", "--description", "Scratch repository of a Botbench test; safe to delete."]);
  assert.match(created.out, new RegExp(name));
  let cleanup = "";
  t.after(() => {
    // Only the repository this test made, checked by its name once more.
    assert.match(name, SCRATCH);
    const deleted = gh(["repo", "delete", full, "--yes"], { allowFail: true });
    if (deleted.code === 0) cleanup = `deleted ${full}`;
    else {
      const archived = gh(["repo", "archive", full, "--yes"], { allowFail: true });
      cleanup = archived.code === 0 ? `could not delete (${deleted.out.trim()}); ARCHIVED ${full} for the owner to remove` : `could neither delete nor archive ${full}: ${deleted.out.trim()} ${archived.out.trim()}`;
    }
    console.log(`scratch repository: ${cleanup}`);
  });

  const dir = tempDir("botbench-delivery-live-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const base = initRepo(repo, { "README.md": "# Botbench delivery test\n" });
  git(repo, "remote", "add", "origin", `https://github.com/${full}.git`);
  // The first commit, pushed by the test with the owner's own git and its credential helper.
  execFileSync("git", ["-C", repo, "push", "--quiet", "origin", "main"], { stdio: ["ignore", "pipe", "pipe"] });

  const db = openStore(home);
  t.after(() => db.close());
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const setup = [{ command: "echo 'hello from Botbench' > hello.txt", limitMs: 30_000 }];
  const checks = [{ command: "test -f hello.txt", limitMs: 30_000 }];
  const tasks = createTasks({ db, home, driver: buildReplayDriver(["done"]), broker, model: "haiku", repoCommands: () => ({ setup, checks }), onEvent: () => {}, onTaskChange: () => {} });
  const runs = createRuns({ db, home, driver: buildReplayDriver([]), broker, model: "haiku", implementerModel: "haiku", line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });

  // What the real gh printed, by command.
  const seen: { args: string[]; result: GhResult }[] = [];
  const recording: RunGh = async (args, o) => {
    const result = await runGh(args, o);
    seen.push({ args: [...args], result });
    return result;
  };
  const config = { port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: {} } as unknown as Config;
  const deliveries = createDeliveries({ db, config, github: createGitHub(recording, dir), onTaskChange: () => {} });
  t.after(async () => {
    await deliveries.close();
    await runs.close();
    await tasks.close();
    await broker.close();
  });

  const run = createRun(db, { repo, prompt: "Add a greeting", baseCommit: base, delivery: "pull_request" });
  const planned = storePlan(db, run.id, [{ title: "Add a greeting file", criteria: ["hello.txt holds a greeting"] }]);
  const [task] = runs.approve(run.id, planned.planVersion).tasks;
  await tasks.idle();
  const built = getTask(db, task!.id)!;
  assert.equal(built.status, "awaiting_decision", built.reason ?? "");
  assert.equal(built.checks, "passed");

  await decideTask(db, { taskId: built.id, decision: "accept" });
  await deliveries.idle();
  const view = deliveryOf(db, getTask(db, built.id)!);
  assert.equal(view.state, "opened", view.problem ?? "");
  assert.deepEqual(deliverySteps(db, built.id).map((s) => s.step), ["requested", "pushed", "opened"]);

  // On GitHub: open, into main, from the task's branch, with the title and the body's sections.
  const pr = JSON.parse(gh(["pr", "view", String(view.number), "--repo", full, "--json", "state,baseRefName,headRefName,headRefOid,title,body,url"]).out) as Record<string, string>;
  assert.deepEqual([pr.state, pr.baseRefName, pr.headRefName, pr.headRefOid, pr.title, pr.url], ["OPEN", "main", built.branch, built.headCommit, "Add a greeting file", view.url]);
  for (const part of ["Built with Botbench", "## What was asked", "## Acceptance criteria", "hello.txt holds a greeting", "## Checks", "passed  test -f hello.txt"]) assert.ok(pr.body!.includes(part), part);
  // Only the task's branch and main are on GitHub.
  const branches = JSON.parse(gh(["api", `repos/${full}/branches`, "--jq", "[.[].name]"]).out) as string[];
  assert.deepEqual(branches.sort(), [built.branch!, "main"].sort());

  // A second delivery opens no second pull request: the ledger refuses it, and GitHub reports the one there is.
  assert.throws(() => deliveries.deliver(built.id, { by: "owner" }), (err: unknown) => err instanceof TaskError && /already has its pull request/.test(err.message));
  const found = await createGitHub(recording, dir).findPullRequest({ host: "github.com", owner: OWNER, name }, built.branch!);
  assert.deepEqual(found, { number: view.number, url: view.url, state: "OPEN" });
  const all = JSON.parse(gh(["pr", "list", "--repo", full, "--state", "all", "--json", "number"]).out) as unknown[];
  assert.equal(all.length, 1);

  if (process.env.BOTBENCH_CAPTURE_GH === "1") {
    const kind = (args: string[]): string => args.slice(0, 2).join(" ");
    const prLists = seen.filter((s) => kind(s.args) === "pr list");
    const signedOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-signed-out-"));
    const signedOutArgs = ghArgs.authStatus("github.com");
    let signedOut: GhResult;
    try {
      const out = execFileSync("gh", signedOutArgs, { encoding: "utf8", env: { ...process.env, GH_CONFIG_DIR: signedOutDir }, stdio: ["ignore", "pipe", "pipe"] });
      signedOut = { started: true, code: 0, stdout: out, stderr: "" };
    } finally {
      fs.rmSync(signedOutDir, { recursive: true, force: true });
    }
    const one = (k: string, s = seen.find((x) => kind(x.args) === k)) => {
      assert.ok(s, k);
      return s;
    };
    const capture: GhCapture = {
      gh: gh(["--version"]).out.split("\n")[0]!,
      captured: new Date().toISOString().slice(0, 10),
      repository: `github.com/${full}`,
      branch: built.branch!,
      outputs: { authStatus: one("auth status"), authStatusSignedOut: { args: signedOutArgs, result: signedOut }, repoView: one("repo view"), prListNone: prLists[0]!, prCreate: one("pr create"), prListOne: prLists.at(-1)! },
    };
    const text = JSON.stringify(capture, null, 2);
    assert.doesNotMatch(text, /gh[opsu]_[A-Za-z0-9]{10,}/, "no token in the capture");
    fs.writeFileSync(GH_CAPTURE_FILE, `${text}\n`);
  }
});
