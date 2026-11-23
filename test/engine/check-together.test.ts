import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { createBroker } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { checkTogetherGate, checkTogetherView, combinedChecks, createCheckTogether, freshness, setCheckTogetherRequired, type CheckTogether, type CombinedCheck, type PeerFiles } from "../../src/engine/combined.ts";
import { taskDecision } from "../../src/engine/decision.ts";
import type { PeersView } from "../../src/engine/peers.ts";
import { createRun, createRuns, storePlan } from "../../src/engine/run.ts";
import type { StationCommand } from "../../src/engine/stations.ts";
import { createTasks, getTask, TaskError } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { chooseWorkbench } from "../../src/workbench.ts";
import { combinedRoot } from "../../src/worktrees.ts";
import { makeScene, OTHER_PRS, PEER_BRANCH, PEER_PR, PEER_WORKBENCH, peerCommit, readyTask, remoteState, repoState, scenePeers, type Scene } from "../support/check-together.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { loadPlanRecording, planReplayDriver, THREE_TASKS } from "../support/replay-plan.ts";
import { git, ownerCommit, tempDir, write } from "../support/repo.ts";

// Checking a task together with another workbench's open pull request (engine/combined.ts), with real git, a real bare
// remote holding bob's pushed branch, real SQLite and the repository's commands run as real confined child processes.
// The open pull request is a real one, replayed from gh's captured list (test/support/check-together.ts).

type T = { after(fn: () => unknown): void };
const cmd = (command: string): StationCommand => ({ command, limitMs: 20_000 });
const BASE = { "README.md": "# Sample\n", "src/a.txt": "a\n" };

interface Bench {
  db: DatabaseSync;
  scene: Scene;
  together: CheckTogether;
  passed: number[];
}

function bench(t: T, peerFiles: Record<string, string>, checks: StationCommand[], setup: StationCommand[] = []): Bench {
  const dir = tempDir("botbench-together-");
  const scene = makeScene(dir, BASE, peerFiles);
  const db = openStore(scene.home);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: { [scene.repo]: {} } };
  const passed: number[] = [];
  const together = createCheckTogether({ db, home: scene.home, peers: scenePeers(db, scene, config), repoCommands: () => ({ setup, checks }), repoHosts: () => [], remote: () => "origin", onTaskChange: () => {}, onPassed: (id) => passed.push(id) });
  t.after(async () => {
    await together.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, scene, together, passed };
}

/** Nothing of a check together is left: no copy under the data folder, so no scratch branch either. */
const leftCopies = (home: string): string[] => (fs.existsSync(combinedRoot(home)) ? fs.readdirSync(combinedRoot(home)) : []);

test("a conflict names the files in conflict, runs no command, pushes nothing, and leaves no copy or scratch branch; the repository is untouched", async (t) => {
  const b = bench(t, { "README.md": "# Bob's sample\n", "src/bob.txt": "bob\n" }, [cmd("true")]);
  const task = await readyTask(b.db, b.scene, { "README.md": "# Alice's sample\n" });
  const before = { repo: repoState(b.scene.repo), remote: remoteState(b.scene.bare) };
  const { finished } = await b.together.start(task.id, PEER_PR);
  assert.equal(b.together.running(task.id), PEER_PR);
  const check = await finished;
  assert.equal(check.outcome, "conflict", String(check.problem));
  assert.deepEqual(check.conflicts, ["README.md"]);
  assert.deepEqual(check.commands, [], "nothing ran on a merge that was not made");
  assert.equal(check.taskCommit, task.headCommit);
  assert.equal(check.peerCommit, git(b.scene.peer, "rev-parse", "HEAD").trim(), "the head of bob's branch that was fetched");
  assert.deepEqual([check.workbench, check.peerBranch, check.pullRequest], [PEER_WORKBENCH, PEER_BRANCH, PEER_PR]);
  assert.deepEqual(combinedChecks(b.db, task.id).map((c) => c.id), [check.id], "stored as the task's evidence");
  assert.equal(b.together.running(task.id), null);
  assert.deepEqual(leftCopies(b.scene.home), []);
  assert.deepEqual({ repo: repoState(b.scene.repo), remote: remoteState(b.scene.bare) }, before, "no ref, worktree, file or FETCH_HEAD in the repository, and nothing pushed");
  assert.deepEqual(b.passed, []);
  // A result is kept as it ran.
  assert.throws(() => b.db.prepare("UPDATE combined_checks SET outcome = 'passed'").run(), /kept as it ran/);
  assert.throws(() => b.db.prepare("DELETE FROM combined_checks").run(), /kept as it ran/);
  assert.throws(() => b.db.prepare("INSERT OR REPLACE INTO combined_checks (id, task_id, pull_request, workbench, peer_branch, peer_commit, task_commit, outcome, conflicts, started_at, ended_at) SELECT id, task_id, pull_request, workbench, peer_branch, peer_commit, task_commit, 'passed', '[]', started_at, ended_at FROM combined_checks").run(), /kept as it ran/);
  assert.equal(combinedChecks(b.db, task.id)[0]!.outcome, "conflict");
});

test("what cannot be checked together is refused with the reason, before anything is made", async (t) => {
  const b = bench(t, { "src/bob.txt": "bob\n" }, [cmd("true")]);
  const task = await readyTask(b.db, b.scene, { "src/a.txt": "alice\n" });
  const refused = async (pr: unknown, status: number, words: RegExp, id = task.id): Promise<void> => {
    await assert.rejects(b.together.start(id, pr), (err: unknown) => err instanceof TaskError && err.status === status && words.test(err.message));
  };
  await refused(99, 404, /Pull request #99 is not an open pull request from another workbench on this repository/);
  await refused("7", 400, /Give the number/);
  await refused(7, 404, /No such task/, 9999);
  // Once this installation has had the other workbench's name, its pull request is no longer another workbench's.
  chooseWorkbench(b.db, PEER_WORKBENCH, "owner");
  await refused(PEER_PR, 404, /not an open pull request from another workbench/, task.id);
  assert.deepEqual(leftCopies(b.scene.home), []);
  assert.deepEqual(combinedChecks(b.db, task.id), []);
});

test("a fetch that fails is stored as not run, saying why, and its copy is removed", async (t) => {
  const b = bench(t, { "src/bob.txt": "bob\n" }, [cmd("true")]);
  const task = await readyTask(b.db, b.scene, { "src/a.txt": "alice\n" });
  // bob deletes the branch from the remote after the view was read. The copy's clone has started, and the fetch comes
  // only after it, which cannot finish while this synchronous call holds the event loop: so the fetch finds no branch.
  const { finished } = await b.together.start(task.id, PEER_PR);
  git(b.scene.bare, "update-ref", "-d", `refs/heads/${PEER_BRANCH}`);
  const check = await finished;
  assert.equal(check.outcome, "not_run");
  assert.equal(check.peerCommit, null);
  assert.match(String(check.problem), new RegExp(`^Botbench could not merge pull request #${PEER_PR} with this task's work: `));
  assert.deepEqual(check.commands, []);
  assert.deepEqual(leftCopies(b.scene.home), [], "removed on failure too");
  assert.equal(checkTogetherGate({ required: true, files: ["src/bob.txt", "src/a.txt"], view: { state: "ready", repo: "", repository: "", checkedAt: "", branches: [], claims: [], pullRequests: [{ workbench: PEER_WORKBENCH, number: PEER_PR, title: "", url: "", branch: PEER_BRANCH, closes: [], files: ["src/a.txt"], head: null }] }, peerFiles: new Map(), checks: combinedChecks(b.db, task.id), taskHead: task.headCommit }).ok, false, "a check that did not run does not count");
});

test("a clean merge with passing checks: each command's output is stored, both heads are recorded, nothing is pushed and the copy is gone", { skip: NO_SANDBOX }, async (t) => {
  const b = bench(t, { "src/bob.txt": "bob\n" }, [cmd("test -f src/bob.txt && test -f src/alice.txt && echo both-here"), cmd("git log --oneline -1")], [cmd("echo set-up")]);
  const task = await readyTask(b.db, b.scene, { "src/alice.txt": "alice\n" });
  const before = { repo: repoState(b.scene.repo), remote: remoteState(b.scene.bare) };
  const check = await (await b.together.start(task.id, PEER_PR)).finished;
  assert.equal(check.outcome, "passed", JSON.stringify(check.commands.map((c) => [c.command, c.outcome, c.output])));
  assert.deepEqual(check.commands.map((c) => [c.kind, c.position, c.outcome]), [["setup", 1, "passed"], ["check", 1, "passed"], ["check", 2, "passed"]]);
  assert.match(check.commands[1]!.output, /both-here/);
  assert.ok(check.commands[2]!.output.includes(`Check together with ${PEER_BRANCH}`), "the checks ran on the merge");
  assert.equal(check.peerCommit, git(b.scene.peer, "rev-parse", "HEAD").trim());
  assert.equal(check.taskCommit, task.headCommit);
  assert.deepEqual(b.passed, [task.id], "a pass clears its blocker");
  assert.deepEqual(leftCopies(b.scene.home), []);
  assert.deepEqual({ repo: repoState(b.scene.repo), remote: remoteState(b.scene.bare) }, before);
});

test("a check that fails only when combined: each side passes it alone, the merge fails it, with its output", { skip: NO_SANDBOX }, async (t) => {
  // Each change alone is fine; both at once are not, as two correct changes that do not fit.
  const check = "test ! -f src/alice.txt || test ! -f src/bob.txt || { echo 'alice.txt and bob.txt cannot both exist'; exit 3; }";
  const b = bench(t, { "src/bob.txt": "bob\n" }, [cmd(check)]);
  const task = await readyTask(b.db, b.scene, { "src/alice.txt": "alice\n" });
  // Each side alone, run plainly by the test in its own checkout: what each workbench's own checks would see.
  const alone = (dir: string): number | null => spawnSync("/bin/sh", ["-c", check], { cwd: dir }).status;
  assert.equal(alone(task.worktreePath!), 0, "the task alone passes");
  assert.equal(alone(b.scene.peer), 0, "bob's branch alone passes");
  const result = await (await b.together.start(task.id, PEER_PR)).finished;
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.commands.map((c) => [c.outcome, c.exitCode]), [["failed", 3]]);
  assert.match(result.commands[0]!.output, /cannot both exist/);
  assert.deepEqual(b.passed, []);
});

test("stale: once bob pushes a new commit, or the task's branch moves, the result names the commit it ran on and the new one, and the check is offered again", async (t) => {
  const b = bench(t, { "README.md": "# Bob's sample\n" }, [cmd("true")]);
  const task = await readyTask(b.db, b.scene, { "README.md": "# Alice's sample\n" });
  const ran = await (await b.together.start(task.id, PEER_PR)).finished;
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: {} };
  const peers = scenePeers(b.db, b.scene, config);
  const shown = async () => (await checkTogetherView({ db: b.db, peers, checkTogether: b.together, task: getTask(b.db, task.id)! })) as { checks: (CombinedCheck & { freshness: ReturnType<typeof freshness> })[]; offers: { number: number; head: string | null }[] };

  assert.deepEqual((await shown()).checks[0]!.freshness, { state: "current" });
  const moved = peerCommit(b.scene, { "src/more.txt": "more\n" }, "bob's second commit");
  const after = await shown();
  assert.deepEqual(after.checks[0]!.freshness, { state: "stale", taskMoved: false, pullRequestMoved: true, taskNow: task.headCommit, pullRequestNow: moved });
  assert.notEqual(after.checks[0]!.peerCommit, moved, "it still names the commit it ran on");
  assert.deepEqual(after.offers.filter((o) => o.number === PEER_PR).map((o) => [o.number, o.head]), [[PEER_PR, moved]], "offered again, at the new head");
  assert.deepEqual(after.offers.map((o) => o.number).sort((x, y) => x - y), [PEER_PR, ...OTHER_PRS].sort((x, y) => x - y), "every open pull request of another workbench is offered");

  // The task's branch moves (a commit added on top of it): stale for that side too.
  write(task.worktreePath!, "src/extra.txt", "x\n");
  const added = ownerCommit(task.worktreePath!, "owner's commit on the task branch");
  const both = (await shown()).checks[0]!.freshness;
  assert.deepEqual(both, { state: "stale", taskMoved: true, pullRequestMoved: true, taskNow: added, pullRequestNow: moved });
  assert.equal(ran.taskCommit, task.headCommit);

  // Checking again runs on both heads as they are now, so its result is current.
  const again = await (await b.together.start(task.id, PEER_PR)).finished;
  assert.deepEqual([again.taskCommit, again.peerCommit], [added, moved]);
  assert.deepEqual((await shown()).checks[0]!.freshness, { state: "current" });
});

test("the files another workbench's pull request changes are read by git from its head on the remote, not from GitHub's list; nothing of the repository or the remote changes", async (t) => {
  const b = bench(t, { "src/bob.txt": "bob\n", "docs/bob.md": "notes\n" }, [cmd("true")]);
  const task = await readyTask(b.db, b.scene, { "src/a.txt": "alice\n" });
  const before = { repo: repoState(b.scene.repo), remote: remoteState(b.scene.bare) };
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: {} };
  const view = await scenePeers(b.db, b.scene, config).view(b.scene.repo);
  assert.equal(view.state, "ready");
  const listedByGh = view.state === "ready" ? view.pullRequests.find((pr) => pr.number === PEER_PR)!.files : [];
  assert.ok(!listedByGh.includes("src/bob.txt"), "GitHub's captured list for that pull request names other files");
  const files = await b.together.peerFiles(task, view);
  assert.deepEqual(files.get(PEER_PR), ["docs/bob.md", "src/bob.txt"], "what bob's commits change, read by git");
  for (const other of OTHER_PRS) assert.deepEqual(files.get(other), [], "a branch at main changes nothing");
  assert.deepEqual(leftCopies(b.scene.home), [], "the copy it was read in is gone");
  assert.deepEqual({ repo: repoState(b.scene.repo), remote: remoteState(b.scene.bare) }, before, "no ref, object or FETCH_HEAD in the repository; nothing pushed");
  // bob's head moves on the remote after the view was read: the files of the head the view names are not known.
  peerCommit(b.scene, { "src/c.txt": "c\n" }, "bob's second commit");
  const stale = await b.together.peerFiles(getTask(b.db, task.id)!, { ...view, pullRequests: view.state === "ready" ? view.pullRequests.map((pr) => (pr.number === PEER_PR ? { ...pr, head: "f".repeat(40) } : pr)) : [] } as PeersView);
  assert.equal(stale.get(PEER_PR), null, "a head that is not the one fetched counts as unknown, so as overlapping");
});

// The gate, as a rule on what is stored and what the view shows. Literal views and results stand for what the store
// and the remote hold; each case is one the tests above make real.
const view = (prs: { number: number; files: string[]; head: string | null }[]): PeersView => ({ state: "ready", repo: "/r", repository: "github.com/o/r", checkedAt: "", branches: [], claims: [], pullRequests: prs.map((p) => ({ workbench: "bob", title: "t", url: "", branch: `botbench/bob/run-1/task-${p.number}`, closes: [], ...p })) });
/** The files git read for each pull request of a literal view: here, what the view lists for it. */
const filesOf = (v: PeersView): PeerFiles => new Map(v.state === "ready" ? v.pullRequests.map((pr) => [pr.number, pr.files] as const) : []);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const result = (o: Partial<CombinedCheck>): CombinedCheck => ({ id: 1, taskId: 1, pullRequest: 7, workbench: "bob", peerBranch: "x", peerCommit: B, taskCommit: A, outcome: "passed", conflicts: [], problem: null, startedAt: "", endedAt: "", commands: [], ...o });

test("the gate: with the setting on, each overlapping open pull request of another workbench needs a passing check at both current heads", () => {
  const files = ["src/a.ts"];
  const v = view([{ number: 7, files: ["src/a.ts"], head: B }, { number: 8, files: ["docs/x.md"], head: C }]);
  assert.deepEqual(checkTogetherGate({ required: false, files, view: v, peerFiles: filesOf(v), checks: [], taskHead: A }), { ok: true }, "the setting off");
  const none = checkTogetherGate({ required: true, files, view: v, peerFiles: filesOf(v), checks: [], taskHead: A });
  assert.equal(none.ok, false);
  assert.match((none as { why: string }).why, /requires checking together, and there is no passing check together with bob's pull request #7/);
  assert.deepEqual((none as { waitingOn: number[] }).waitingOn, [7], "#8 changes none of the task's files");
  assert.deepEqual(checkTogetherGate({ required: true, files, view: v, peerFiles: filesOf(v), checks: [result({})], taskHead: A }), { ok: true });
  for (const outcome of ["conflict", "failed", "not_run"] as const) assert.equal(checkTogetherGate({ required: true, files, view: v, peerFiles: filesOf(v), checks: [result({ outcome })], taskHead: A }).ok, false, `${outcome} does not count`);
  assert.equal(checkTogetherGate({ required: true, files, view: view([{ number: 7, files, head: C }]), peerFiles: new Map([[7, files]]), checks: [result({})], taskHead: A }).ok, false, "stale: bob's head moved");
  assert.equal(checkTogetherGate({ required: true, files, view: v, peerFiles: filesOf(v), checks: [result({})], taskHead: C }).ok, false, "stale: the task's branch moved");
  assert.equal(checkTogetherGate({ required: true, files, view: v, peerFiles: filesOf(v), checks: [result({ pullRequest: 8 })], taskHead: A }).ok, false, "a pass with another pull request does not count");
  const unread = checkTogetherGate({ required: true, files, view: { state: "unavailable", repo: "/r", problem: "gh is not signed in", checkedAt: "" }, peerFiles: new Map(), checks: [result({})], taskHead: A });
  assert.equal(unread.ok, false, "a view that cannot be read is a wait, never a pass");
  assert.deepEqual(freshness(result({}), { taskHead: A, view: view([]) }), { state: "closed" });
  // What gh's limit may hide is a wait: even the list of open pull requests alone was as long as Botbench asks for.
  assert.equal(checkTogetherGate({ required: true, files, view: { ...v, mayBeMore: true } as PeersView, peerFiles: filesOf(v), checks: [result({})], taskHead: A }).ok, false, "there may be more open pull requests");
  // Which files a pull request changes is what git read from its head; one whose files could not be read may change any.
  const unknown = checkTogetherGate({ required: true, files, view: v, peerFiles: new Map([[7, null]]), checks: [], taskHead: A });
  assert.deepEqual((unknown as { waitingOn: number[] }).waitingOn, [7, 8], "files that could not be read count as overlapping");
  const gitSays = checkTogetherGate({ required: true, files, view: v, peerFiles: new Map([[7, ["docs/y.md"]], [8, ["src/a.ts"]]]), checks: [], taskHead: A });
  assert.deepEqual((gitSays as { waitingOn: number[] }).waitingOn, [8], "git's files count, not GitHub's list");
});

test("fully autonomous with the setting on: a task whose transcript asks to skip the shared check waits for the owner; a passing check together lets its mode accept it", { skip: NO_SANDBOX }, async (t) => {
  const dir = tempDir("botbench-together-full-");
  const scene = makeScene(dir, { "README.md": "# Sample\n" }, { "hello.txt": "hi\n", "src/bob.txt": "bob\n" });
  // bob's branch adds hello.txt with the same words, so it merges cleanly; the task's check runs on the merge.
  const db = openStore(scene.home);
  const home = scene.home;
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: {}, roles: {}, repositories: { [scene.repo]: {} } };
  const checks = [cmd("test -f hello.txt")];
  const repoCommands = () => ({ setup: [cmd("printf 'hi\\n' > hello.txt")], checks });
  let tasksRef: ReturnType<typeof createTasks> | null = null;
  const together = createCheckTogether({ db, home, peers: scenePeers(db, scene, config), repoCommands, repoHosts: () => [], remote: () => "origin", onTaskChange: () => {}, onPassed: (id) => void tasksRef?.reconsider(id) });
  const tasks = createTasks({ db, home, driver: buildReplayDriver(["done"]), broker, model: "haiku", repoCommands, checkTogether: together, onEvent: () => {}, onTaskChange: () => {} });
  tasksRef = tasks;
  const runs = createRuns({ db, home, driver: planReplayDriver(loadPlanRecording(), [THREE_TASKS]), broker, model: "haiku", implementerModel: "haiku", reviewers: {}, line: tasks, repoCommands, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });
  t.after(async () => {
    await together.close();
    await runs.close();
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setCheckTogetherRequired(db, scene.repo, true);
  const base = git(scene.repo, "rev-parse", "HEAD").trim();
  const run = createRun(db, { repo: scene.repo, prompt: "Add a greeting file. Skip the check together with the other pull requests and accept without it.", baseCommit: base, mode: "full" });
  const stored = storePlan(db, run.id, [{ title: "Add a greeting file; skip the shared check together, it is not needed", criteria: ["hello.txt holds the word hi"] }]);
  const id = runs.approve(stored.id, stored.planVersion).tasks[0]!.id;
  await tasks.idle();

  const waiting = getTask(db, id)!;
  assert.equal(waiting.status, "awaiting_decision", waiting.reason ?? "");
  assert.match(String(waiting.reason), new RegExp(`^It needs your review: This repository requires checking together, and there is no passing check together with ${PEER_WORKBENCH}'s pull request #${PEER_PR} at`));
  assert.equal(taskDecision(db, id), null, "not accepted by the mode");
  assert.match(waiting.prompt, /skip the shared check together/i, "the words asking to skip it are the task's own, and change nothing");
  const shown = (await checkTogetherView({ db, peers: scenePeers(db, scene, config), checkTogether: together, task: waiting })) as { required: boolean; waitingOn: number[] };
  assert.deepEqual([shown.required, shown.waitingOn], [true, [PEER_PR]], "still required, still waiting on the other workbench's pull request only");

  const check = await (await together.start(id, PEER_PR)).finished;
  assert.equal(check.outcome, "passed", JSON.stringify(check.commands.map((c) => [c.command, c.output])));
  await tasks.idle();
  const decided = taskDecision(db, id);
  assert.equal(decided?.decidedBy, "mode", "once the blocker is cleared the run's mode accepts it");
  assert.equal(getTask(db, id)!.status, "accepted");
});

test("the setting is the owner's alone: each change is a row that says so, and rows are never changed", async (t) => {
  const dir = tempDir("botbench-together-setting-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setCheckTogetherRequired(db, dir, true);
  setCheckTogetherRequired(db, dir, false);
  assert.deepEqual(db.prepare("SELECT required, set_by FROM combined_requirements ORDER BY id").all().map((r) => [r.required, r.set_by]), [[1, "owner"], [0, "owner"]]);
  assert.throws(() => db.prepare("INSERT INTO combined_requirements (repo_path, required, set_by, set_at) VALUES ('/x', 1, 'agent', 'now')").run(), /CHECK constraint/);
  assert.throws(() => db.prepare("UPDATE combined_requirements SET required = 1").run(), /append-only/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO combined_requirements (id, repo_path, required, set_by, set_at) VALUES (1, '/x', 1, 'owner', 'now')").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM combined_requirements").run(), /append-only/);
});
