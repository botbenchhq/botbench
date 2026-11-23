import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG_FILE, loadConfig, type Config } from "../../src/config.ts";
import { startWatch, type Proposal } from "../../src/engine/watch.ts";
import { deliveryEnv, ghArgs, parseWatchedIssues, type GhResult, type RunGh } from "../../src/github.ts";
import { createPush } from "../../src/push.ts";
import { openStore } from "../../src/store/db.ts";
import { decrypt, newDevice, startPushEndpoint } from "../support/push-service.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";
import { loadGhCapture } from "../support/replay-github.ts";
import { capturedIssue, loadWatchCapture, replayWatchGh, WATCH_ADDRESS, WATCH_REPO } from "../support/replay-watch.ts";

// The issue watch's engine (issue #73): polls of a real temporary repository whose origin is jon-lange/botbench, whose gh
// answers are replayed from the capture taken once from the real gh (test/support/replay-watch.ts, the owner's approved
// exception); its failures are the real gh's and the real process's (gh not signed in, no such program), or GitHub's
// documented answer over its limit; the seen table is a real SQLite file, closed and opened again.

function bench(t: { after(fn: () => void | Promise<void>): void }, o: { label?: string; intervalMinutes?: number } = {}): { home: string; repo: string; config: Config; label: string } {
  const dir = tempDir("botbench-watch-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  initRepo(repo);
  git(repo, "remote", "add", "origin", WATCH_ADDRESS);
  const label = o.label ?? loadWatchCapture().label;
  const config: Config = { ...loadConfig({ defaults: DEFAULT_CONFIG_FILE }), repositories: { [repo]: { watch: { label, ...(o.intervalMinutes === undefined ? {} : { intervalMinutes: o.intervalMinutes }) } } } };
  return { home: path.join(dir, "home"), repo, config, label };
}

const rows = (db: ReturnType<typeof openStore>): { number: number; state: string }[] => db.prepare("SELECT number, state FROM watched_issues ORDER BY number").all().map((r) => ({ number: Number(r.number), state: String(r.state) }));

test("a poll proposes each open issue gh listed with the label once, with only gh's read of the list, and a second poll proposes none", async (t) => {
  const b = bench(t);
  const db = openStore(b.home);
  t.after(() => db.close());
  const { run, calls } = replayWatchGh();
  const proposed: Proposal[] = [];
  const watch = startWatch({ db, config: b.config, run, timers: false, onProposed: (p) => proposed.push(p) });
  t.after(() => watch.close());
  const listed = parseWatchedIssues(loadWatchCapture().outputs.labelled.result.stdout, WATCH_REPO, b.label);

  await watch.pollNow(b.repo);
  assert.deepEqual(proposed.map((p) => p.number).sort(), listed.map((i) => i.number).sort());
  const first = capturedIssue();
  const shown = watch.proposals().find((p) => p.number === first.number)!;
  assert.deepEqual({ title: shown.title, author: shown.author, url: shown.url, repository: shown.repository, repoPath: shown.repoPath }, { title: first.title, author: first.author, url: first.url, repository: "github.com/jon-lange/botbench", repoPath: b.repo });
  assert.equal(watch.status()[0]!.state, "checked");
  assert.equal(watch.status()[0]!.problem, null);

  await watch.pollNow(b.repo);
  assert.equal(proposed.length, listed.length, "an issue already seen is not proposed again");
  // Only the list was asked, with its exact arguments: no write to GitHub, and nothing more read.
  assert.deepEqual(calls, [ghArgs.watchIssues(WATCH_REPO, b.label), ghArgs.watchIssues(WATCH_REPO, b.label)]);
  assert.deepEqual(rows(db).map((r) => r.state), listed.map(() => "proposed"));
});

test("the seen rows are kept in the SQLite file: after it is closed and opened again, nothing is proposed again, and a dismissed issue never returns", async (t) => {
  const b = bench(t);
  let db = openStore(b.home);
  let watch = startWatch({ db, config: b.config, run: replayWatchGh().run, timers: false });
  await watch.pollNow(b.repo);
  const first = watch.proposals().find((p) => p.number === capturedIssue().number)!;
  assert.equal(watch.dismiss(first.id), true);
  assert.equal(watch.dismiss(first.id), false, "a dismissed proposal is not dismissed twice");
  assert.equal(watch.proposal(first.id), null);
  assert.ok(!watch.proposals().some((p) => p.id === first.id), "Dismiss removes it from Work");
  const before = rows(db);
  await watch.close();
  db.close();

  db = openStore(b.home);
  t.after(() => db.close());
  const proposed: Proposal[] = [];
  watch = startWatch({ db, config: b.config, run: replayWatchGh().run, timers: false, onProposed: (p) => proposed.push(p) });
  t.after(() => watch.close());
  assert.deepEqual(rows(db), before, "the rows came back from the file as they were");
  await watch.pollNow(b.repo);
  assert.deepEqual(proposed, [], "after the restart nothing seen before is proposed again");
  assert.equal(watch.proposal(first.id), null);
  assert.equal(rows(db).find((r) => r.number === first.number)!.state, "dismissed");
  // The store itself refuses to bring a dismissed issue back, to change what was seen, or to forget it.
  assert.throws(() => db.prepare("UPDATE watched_issues SET state = 'proposed', dismissed_at = NULL WHERE id = ?").run(first.id), /dismissed once, and never proposed again/);
  assert.throws(() => db.prepare("UPDATE watched_issues SET title = 'other' WHERE id = ?").run(first.id), /kept as it was first seen/);
  assert.throws(() => db.prepare("DELETE FROM watched_issues WHERE id = ?").run(first.id), /never deleted/);
  assert.throws(() => db.prepare("INSERT INTO watched_issues (repository, number, repo_path, url, title, state, first_seen_at) VALUES ('x', 1, '/r', 'u', 't', 'dismissed', 'now')").run(), /first written as proposed/);
});

/** The real gh with a configuration folder of its own that holds no sign-in, as on a Mac where nobody ran gh auth login. */
function signedOutGh(dir: string): RunGh {
  return (args, o) =>
    new Promise((resolve) => {
      execFile("gh", [...args], { cwd: o.cwd, env: { ...deliveryEnv(), GH_CONFIG_DIR: dir }, timeout: 30_000 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ started: !(err !== null && err.code === "ENOENT"), code, stdout, stderr });
      });
    });
}

/** A program that is not there, started as runGh starts gh: the real failure of a Mac without gh. */
const missingGh: RunGh = () =>
  new Promise((resolve) => {
    const child = spawn("botbench-no-such-gh-program", [], { stdio: "ignore" });
    child.on("error", () => resolve({ started: false, code: null, stdout: "", stderr: "" }));
    child.on("close", (code) => resolve({ started: true, code, stdout: "", stderr: "" }));
  });

// Asked with a configuration folder of its own, as the test runs gh, so a gh whose own folder cannot be read still counts.
let ghInstalled = true;
const versionConfig = tempDir("botbench-gh-version-");
try {
  execFileSync("gh", ["--version"], { stdio: "ignore", env: { ...process.env, GH_CONFIG_DIR: versionConfig } });
} catch {
  ghInstalled = false;
} finally {
  fs.rmSync(versionConfig, { recursive: true, force: true });
}

test("a poll that fails shows its repository's failure in plain words with what gh said and the next try, writes nothing, and the next poll proposes", { skip: ghInstalled ? false : "gh is not installed here" }, async (t) => {
  const b = bench(t, { intervalMinutes: 15 });
  const db = openStore(b.home);
  t.after(() => db.close());
  const config = path.join(b.home, "gh-signed-out");
  fs.mkdirSync(config, { recursive: true });
  // What the real gh printed for a pull request it opened: an answer, but not the list's JSON.
  const notJson = loadGhCapture().outputs.prCreate.result;
  const answers: RunGh[] = [missingGh, signedOutGh(config), async () => notJson];
  let next: RunGh = answers[0]!;
  const proposed: Proposal[] = [];
  const at = Date.parse("2026-11-23T10:00:00Z");
  const watch = startWatch({ db, config: b.config, run: (args, o) => next(args, o), timers: false, now: () => at, onProposed: (p) => proposed.push(p) });
  t.after(() => watch.close());
  const expected = [
    { problem: "The gh tool is not installed, or is not on the PATH Botbench runs with. Install it and sign in with gh auth login in a terminal.", said: null },
    { problem: "The gh tool is not signed in. Run gh auth login in a terminal on this Mac.", said: /To get started with GitHub CLI, please run: gh auth login/ },
    { problem: "The gh tool's answer to which issues carry the label could not be read.", said: null },
  ];
  for (const [i, answer] of answers.entries()) {
    next = answer;
    await watch.pollNow(b.repo);
    const status = watch.status()[0]!;
    assert.equal(status.state, "failed");
    assert.equal(status.problem, expected[i]!.problem);
    if (expected[i]!.said === null) assert.equal(status.said, null);
    else assert.match(status.said!, expected[i]!.said as RegExp);
    assert.equal(status.nextAt, "2026-11-23T10:15:00.000Z", "tried again at the next interval");
    assert.deepEqual(rows(db), [], "a failed poll writes nothing");
  }
  next = replayWatchGh().run;
  await watch.pollNow(b.repo);
  assert.equal(watch.status()[0]!.state, "checked");
  assert.equal(proposed.length, parseWatchedIssues(loadWatchCapture().outputs.labelled.result.stdout, WATCH_REPO, b.label).length, "no proposal was lost to the failures");
});

/*
 * GitHub's documented answer over its primary limit (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
 * as `gh api -i` prints an answer, and the line gh prints when a REST call it made got it: recorded from the
 * documentation, since a real limit cannot be reached on demand.
 */
const LIMIT_HEAD = "HTTP/2.0 403 Forbidden\nDate: Tue, 20 Aug 2013 14:50:41 GMT\nX-Ratelimit-Limit: 60\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1377013266\nX-Ratelimit-Used: 60\nX-Ratelimit-Resource: core\n\n{\"message\":\"API rate limit exceeded for xxx.xxx.xxx.xxx.\"}";
const LIMIT_FAILURE: GhResult = { started: true, code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded for xxx.xxx.xxx.xxx. (https://api.github.com/repos/jon-lange/botbench/issues)\n" };

test("after GitHub's limit the watch reads one answer's head with gh api -i and waits until the reset it names, never less than the interval", async (t) => {
  const b = bench(t, { intervalMinutes: 10 });
  const db = openStore(b.home);
  t.after(() => db.close());
  const at = Date.parse("Tue, 20 Aug 2013 14:50:41 GMT");
  const { run, calls } = replayWatchGh({ answer: (args) => (args[0] === "issue" ? LIMIT_FAILURE : args[0] === "api" ? { started: true, code: 1, stdout: LIMIT_HEAD, stderr: "gh: API rate limit exceeded (HTTP 403)" } : undefined) });
  const watch = startWatch({ db, config: b.config, run, timers: false, now: () => at });
  t.after(() => watch.close());
  await watch.pollNow(b.repo);
  const status = watch.status()[0]!;
  assert.equal(status.state, "failed");
  assert.equal(status.problem, "GitHub asked Botbench to wait before it reads the issues again.");
  assert.match(status.said!, /^HTTP 403: API rate limit exceeded/);
  assert.equal(status.nextAt, new Date(1377013266_000).toISOString(), "until x-ratelimit-reset");
  assert.deepEqual(calls, [ghArgs.watchIssues(WATCH_REPO, b.label), ghArgs.watchHead(WATCH_REPO)]);
  assert.deepEqual(rows(db), []);
  // The head says nothing usable: the backoff from the interval, doubling with each limited poll in a row.
  const notStarted: GhResult = { started: false, code: null, stdout: "", stderr: "" };
  const blind = replayWatchGh({ answer: (args) => (args[0] === "issue" ? LIMIT_FAILURE : args[0] === "api" ? notStarted : undefined) });
  await watch.close();
  const again = startWatch({ db, config: b.config, run: blind.run, timers: false, now: () => at });
  t.after(() => again.close());
  await again.pollNow(b.repo);
  assert.equal(again.status()[0]!.nextAt, new Date(at + 600_000).toISOString());
  await again.pollNow(b.repo);
  assert.equal(again.status()[0]!.nextAt, new Date(at + 1_200_000).toISOString());
});

test("never two polls of one repository at once: a poll asked for while one is under way is that one", async (t) => {
  const b = bench(t);
  const db = openStore(b.home);
  t.after(() => db.close());
  const replay = replayWatchGh();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let lists = 0;
  const watch = startWatch({ db, config: b.config, timers: false, run: async (args, o) => (lists++, await gate, replay.run(args, o)) });
  t.after(() => watch.close());
  const one = watch.pollNow(b.repo);
  const two = watch.pollNow(b.repo);
  assert.equal(one, two);
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 100 && lists === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(watch.status()[0]!.state, "checking");
  release();
  await Promise.all([one, two]);
  assert.equal(lists, 1);
});

test("one watch per store, polling at start and then at its interval, stopped cleanly", async (t) => {
  const b = bench(t, { intervalMinutes: 1 });
  const db = openStore(b.home);
  t.after(() => db.close());
  const replay = replayWatchGh();
  let polled = 0;
  let finished!: () => void;
  let done = new Promise<void>((resolve) => (finished = resolve));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watch = startWatch({ db, config: b.config, run: async (args, o) => replay.run(args, o), onChange: () => {
      const s = watch?.status()[0];
      if (s?.state === "checked") (polled++, finished());
    } });
  assert.throws(() => startWatch({ db, config: b.config, run: replay.run }), /already running for this store/);
  t.mock.timers.tick(0);
  await done;
  assert.equal(polled, 1, "the first poll is at start");
  done = new Promise<void>((resolve) => (finished = resolve));
  t.mock.timers.tick(59_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polled, 1, "not before its interval");
  t.mock.timers.tick(1_000);
  await done;
  assert.equal(polled, 2, "again after one minute");
  await watch.close();
  t.mock.timers.tick(120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polled, 2, "a closed watch polls no more");
  // The store is free once it is stopped.
  const next = startWatch({ db, config: b.config, run: replay.run, timers: false });
  await next.close();
});

test("each newly proposed issue sends exactly one notification, 'An issue is ready to start', with nothing of the issue in it, and a repeated poll sends none", async (t) => {
  const b = bench(t);
  const db = openStore(b.home);
  t.after(() => db.close());
  const endpoint = await startPushEndpoint();
  t.after(() => endpoint.close());
  const device = newDevice();
  const push = createPush({ db, home: b.home, allowHttpEndpoints: true });
  push.subscribe(device.subscription(endpoint.url("phone")));
  const watch = startWatch({ db, config: b.config, run: replayWatchGh().run, timers: false, onProposed: () => push.issueProposed() });
  t.after(() => watch.close());
  await watch.pollNow(b.repo);
  await push.idle();
  const listed = parseWatchedIssues(loadWatchCapture().outputs.labelled.result.stdout, WATCH_REPO, b.label);
  assert.equal(endpoint.received.length, listed.length, "one per new proposal");
  const issue = capturedIssue();
  const raw = JSON.parse(loadWatchCapture().outputs.labelled.result.stdout) as { labels: { name: string }[] }[];
  for (const r of endpoint.received) {
    const message = JSON.parse(decrypt(r.body, device.privateKey, device.auth).toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(message, { title: "An issue is ready to start", path: "/#/work" });
    const text = JSON.stringify(message);
    for (const word of [issue.title, issue.author ?? "", String(issue.number), ...raw.flatMap((i) => i.labels.map((l) => l.name))]) if (word !== "") assert.ok(!text.includes(word), `${word} is not in the payload`);
  }
  await watch.pollNow(b.repo);
  await push.idle();
  assert.equal(endpoint.received.length, listed.length, "a repeated poll sends no second one");
});
