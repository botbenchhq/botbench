import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTask, moveTask } from "../src/engine/task.ts";
import { workUnderWay } from "../src/server.ts";
import { openStore } from "../src/store/db.ts";
import { setDefaultMode } from "../src/engine/modes.ts";
import { checkBuildStarts, checkMigrations, checkoutVersion, createUpdates, isNewerVersion, latestRelease, parseVersion, preflight, releaseSummary, switchCheckout, UpdateRefused } from "../src/update.ts";
import { bumpVersion, commitAndTag, notesFor, smallRepo, startReleaseServer } from "./support/releases.ts";
import { git, ownerCommit, tempDir, write } from "./support/repo.ts";

// The parts of updating Botbench to a release (src/update.ts) that decide whether it may go ahead, each against real
// git repositories: one acting as GitHub's, with real tags, and a clone of it as the installation. The version compare
// and the notes' summary are plain functions. The build check starts this checkout's own server.

type T = { after(fn: () => unknown): void };
const head = (dir: string): string => git(dir, "rev-parse", "HEAD").trim();
const ROOT = path.resolve(import.meta.dirname, "..");

test("a version is newer only when it is a later plain release; anything else is never offered", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("v0.1.1", "0.1.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.10.0", "0.9.0"), true, "compared as numbers, not as text");
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.2.0-beta.1", "0.1.0"), false, "a prerelease is never offered");
  assert.equal(isNewerVersion("latest", "0.1.0"), false);
  assert.equal(isNewerVersion("01.2.3", "0.1.0"), false);
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("1.2"), null);
});

test("the notes' summary is the changelog's items without links, issue numbers or commit hashes", () => {
  assert.equal(releaseSummary(notesFor("0.2.0", "update Botbench from Settings")), "update Botbench from Settings");
  const two = "## [0.3.0](https://x) (2026-12-01)\n\n### Features\n\n* **settings:** a version row ([#1](https://x)) ([abcdef1](https://x))\n\n### Bug Fixes\n\n* the phone list scrolls ([#2](https://x)) ([1234567](https://x))\n";
  assert.equal(releaseSummary(two), "settings: a version row; the phone list scrolls");
  assert.equal(releaseSummary("Just one line of text.\n"), "Just one line of text.");
  assert.equal(releaseSummary(""), "");
  const long = releaseSummary(`* ${"word ".repeat(100)}`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("the check reads GitHub's latest release with no credentials; none published yet is no update", async (t) => {
  const releases = await startReleaseServer();
  t.after(() => releases.close());
  assert.equal(await latestRelease(releases.url), null);
  releases.publish({ tag: "v0.2.0", notes: notesFor("0.2.0", "update Botbench from Settings") });
  assert.deepEqual(await latestRelease(releases.url), { version: "0.2.0", tag: "v0.2.0", summary: "update Botbench from Settings", url: "https://github.com/jon-lange/botbench/releases/tag/v0.2.0" });
  const sent = releases.requests.at(-1)!.headers;
  assert.equal(sent.authorization, undefined);
  assert.equal(sent.cookie, undefined);
  assert.equal(sent["user-agent"], "botbench-update-check");
  releases.publish({ tag: "nightly", notes: "" });
  await assert.rejects(latestRelease(releases.url), /no tag of the form vX\.Y\.Z/);
});

interface Place {
  remote: string;
  install: string;
  base: string;
}

/** A repository as GitHub's, at 0.1.0 tagged v0.1.0, and an installation cloned from it on main. */
function place(t: T, files: Record<string, string> = {}): Place {
  const dir = tempDir("botbench-update-");
  const remote = path.join(dir, "github");
  smallRepo(remote, "0.1.0");
  for (const [file, content] of Object.entries(files)) write(remote, file, content);
  if (Object.keys(files).length > 0) ownerCommit(remote, "the project's files");
  git(remote, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "tag", "-a", "-m", "v0.1.0", "v0.1.0");
  const base = head(remote);
  const install = path.join(dir, "install");
  git(dir, "clone", "--quiet", remote, install);
  return { remote, install, base };
}

/** A release on the remote's main: the version bumped, committed and tagged. */
function release(p: Place, version: string, change: (dir: string) => void = () => {}): string {
  bumpVersion(p.remote, version);
  change(p.remote);
  return commitAndTag(p.remote, `chore(main): release ${version}`, `v${version}`);
}

const v020 = { tag: "v0.2.0", version: "0.2.0" };

test("a clean installation on main, behind a tag on main, may move to it by fast-forward", async (t) => {
  const p = place(t);
  const target = release(p, "0.2.0");
  assert.deepEqual(await preflight(p.install, v020, p.remote), { previous: p.base, target });
  assert.equal(head(p.install), p.base, "the check moves nothing");
});

test("an installation with changes that are not committed is not updated, and nothing is fetched", async (t) => {
  const p = place(t);
  release(p, "0.2.0");
  write(p.install, "notes.txt", "mine\n");
  await assert.rejects(preflight(p.install, v020, p.remote), (err: Error) => err instanceof UpdateRefused && /changes that are not committed/.test(err.message));
  assert.equal(head(p.install), p.base);
  assert.equal(git(p.install, "tag", "--list", "v0.2.0").trim(), "");
  // A changed tracked file too.
  fs.rmSync(path.join(p.install, "notes.txt"));
  write(p.install, "package.json", "{}\n");
  await assert.rejects(preflight(p.install, v020, p.remote), /changes that are not committed/);
});

test("an installation not on main is not updated", async (t) => {
  const p = place(t);
  release(p, "0.2.0");
  git(p.install, "checkout", "--quiet", "-b", "trying-something");
  await assert.rejects(preflight(p.install, v020, p.remote), /on the branch trying-something, not main/);
  git(p.install, "checkout", "--quiet", "--detach", "main");
  await assert.rejects(preflight(p.install, v020, p.remote), /not on a branch/);
});

test("a release that is not a fast-forward of the installation is refused: nothing is reset or forced", async (t) => {
  const p = place(t);
  release(p, "0.2.0");
  write(p.install, "local.txt", "a commit only here\n");
  const local = ownerCommit(p.install, "a commit of the owner's own");
  await assert.rejects(preflight(p.install, v020, p.remote), /would not be a fast-forward/);
  assert.equal(head(p.install), local);
  assert.equal(git(p.install, "status", "--porcelain"), "");
});

test("a tag that is not on main's history is refused", async (t) => {
  const p = place(t);
  git(p.remote, "checkout", "--quiet", "-b", "side");
  release(p, "0.2.0");
  git(p.remote, "checkout", "--quiet", "main");
  await assert.rejects(preflight(p.install, v020, p.remote), /not on main's history/);
  assert.equal(head(p.install), p.base);
});

test("a tag that does not exist, or a local tag of the same name on another commit, is refused", async (t) => {
  const p = place(t);
  await assert.rejects(preflight(p.install, v020, p.remote), /could not be fetched/);
  const target = release(p, "0.2.0");
  git(p.install, "tag", "v0.2.0", p.base);
  await assert.rejects(preflight(p.install, v020, p.remote), /could not be fetched/);
  assert.equal(git(p.install, "rev-parse", "v0.2.0^{commit}").trim(), p.base, "the owner's tag is left as it was");
  assert.notEqual(target, p.base);
});

test("a tag whose package.json names another version, or that is not vX.Y.Z, is refused", async (t) => {
  const p = place(t);
  bumpVersion(p.remote, "0.3.0");
  commitAndTag(p.remote, "a mislabelled release", "v0.2.0");
  await assert.rejects(preflight(p.install, v020, p.remote), /names version 0\.3\.0, not 0\.2\.0/);
  await assert.rejects(preflight(p.install, { tag: "main", version: "main" }, p.remote), /not a release tag/);
  await assert.rejects(preflight(p.install, { tag: "v0.2.0", version: "0.9.0" }, p.remote), /not a release tag/);
});

/** A project npm installs from its lockfiles with nothing to download, and whose client build writes web/dist. */
const PROJECT: Record<string, string> = {
  "package-lock.json": `${JSON.stringify({ name: "sample", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "sample", version: "0.1.0" } } }, null, 2)}\n`,
  ".gitignore": "node_modules\nweb/dist\n",
  "web/package.json": `${JSON.stringify({ name: "sample-web", version: "0.0.0", private: true, scripts: { build: "node build.mjs" } }, null, 2)}\n`,
  "web/package-lock.json": `${JSON.stringify({ name: "sample-web", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "sample-web", version: "0.0.0" } } }, null, 2)}\n`,
  "web/build.mjs": 'import fs from "node:fs";\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/index.html", "<html></html>\\n");\n',
};

test("a release whose install fails after the checkout moved is undone: the checkout goes back and is installed again", async (t) => {
  const p = place(t, PROJECT);
  // The release's web/ has no lockfile, so npm ci there fails, as a broken release's install would.
  const target = release(p, "0.2.0", (dir) => fs.rmSync(path.join(dir, "web", "package-lock.json")));
  const { previous } = await preflight(p.install, v020, p.remote);
  await assert.rejects(switchCheckout(p.install, previous, target), /went back to the previous version/);
  assert.equal(head(p.install), p.base);
  assert.equal(git(p.install, "symbolic-ref", "--short", "HEAD").trim(), "main");
  assert.equal(git(p.install, "status", "--porcelain"), "");
  assert.ok(fs.existsSync(path.join(p.install, "web", "dist", "index.html")), "the previous version was built again");
  assert.equal(checkoutVersion(p.install), "0.1.0");
});

test("a release that installs moves the checkout by fast-forward and builds it there", async (t) => {
  const p = place(t, PROJECT);
  const target = release(p, "0.2.0");
  const { previous } = await preflight(p.install, v020, p.remote);
  await switchCheckout(p.install, previous, target);
  assert.equal(head(p.install), target);
  assert.equal(git(p.install, "status", "--porcelain"), "");
  assert.equal(checkoutVersion(p.install), "0.2.0");
  assert.ok(fs.existsSync(path.join(p.install, "web", "dist", "index.html")));
});

test("the build check starts this checkout's own server on an empty data folder, and refuses a wrong version", async (t) => {
  const dir = tempDir("botbench-check-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await checkBuildStarts(ROOT, path.join(dir, "h"), checkoutVersion(ROOT));
  await assert.rejects(checkBuildStarts(ROOT, path.join(dir, "h"), "9.9.9"), /did not start properly: it says it is version .*, not 9\.9\.9/);
});

test("work under way is a task queued, building, checking or reviewed, a run being planned, or a reply being written", (t) => {
  const dir = tempDir("botbench-busy-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  smallRepo(repo, "0.1.0");
  const idle = { anyRunning: () => false };
  const answering = { anyRunning: () => true };
  assert.equal(workUnderWay(db, idle, idle), false);
  assert.equal(workUnderWay(db, answering, idle), true);
  assert.equal(workUnderWay(db, idle, answering), true);
  const task = createTask(db, { repo, prompt: "add a file" });
  assert.equal(workUnderWay(db, idle, idle), true, "queued");
  moveTask(db, task.id, "building");
  assert.equal(workUnderWay(db, idle, idle), true, "building");
  moveTask(db, task.id, "awaiting_decision");
  assert.equal(workUnderWay(db, idle, idle), false, "ready for review is a resting point");
});

test("an update waits while work is under way, touching nothing, and goes ahead once it is not", async (t) => {
  const p = place(t, PROJECT);
  release(p, "0.2.0");
  const releases = await startReleaseServer();
  t.after(() => releases.close());
  releases.publish({ tag: "v0.2.0", notes: notesFor("0.2.0", "a change") });
  const db = openStore(path.join(p.install, "..", "home"));
  t.after(() => db.close());
  let busy = true;
  const lines: string[] = [];
  const updates = createUpdates({ db, home: path.join(p.install, "..", "home"), installDir: p.install, busy: () => busy, notifyUpdated: () => {}, options: { releasesUrl: releases.url, gitUrl: p.remote, serviceLabel: "dev.botbench.test-no-such-service" }, pollMs: 20, log: (l) => lines.push(l) });
  t.after(() => updates.close());
  await updates.check();
  updates.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual({ kind: updates.status().state.kind, message: updates.status().state.message }, { kind: "waiting", message: "Waiting for work to finish, then updating to 0.2.0." });
  assert.equal(head(p.install), p.base);
  assert.equal(git(p.install, "tag", "--list", "v0.2.0").trim(), "", "nothing fetched while waiting");
  busy = false;
  for (let i = 0; i < 300 && ["waiting", "updating"].includes(updates.status().state.kind); i++) await new Promise((r) => setTimeout(r, 50));
  // This small repository has no Botbench server in it, so its build check fails and it is not installed.
  assert.equal(updates.status().state.kind, "failed");
  assert.match(String(updates.status().state.message), /did not start properly/);
  assert.equal(head(p.install), p.base);
});

test("the new version's migrations run on a copy of the owner's data, and one that fails only on real data is caught", async (t) => {
  const dir = tempDir("botbench-migrate-");
  const db = openStore(path.join(dir, "home"));
  t.after(() => db.close());
  setDefaultMode(db, "semi");
  // This checkout's own store code opens the copy: nothing to migrate, and the owner's database is untouched.
  await checkMigrations(ROOT, db, path.join(dir, "m1"));
  // A release whose new migration fails only when the owner has chosen a default mode (a second row of the same name).
  const stage = path.join(dir, "stage");
  fs.mkdirSync(path.join(stage, "src", "store"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "src", "store", "db.ts"), path.join(stage, "src", "store", "db.ts"));
  const schema = fs.readFileSync(path.join(ROOT, "src", "store", "schema.ts"), "utf8");
  fs.writeFileSync(path.join(stage, "src", "store", "schema.ts"), schema.replace(/\n\];\s*$/, `\n  { name: "fails on real data", sql: "INSERT INTO owner_settings (name, value, updated_at) SELECT name, value, updated_at FROM owner_settings WHERE name = 'default_mode';" },\n];\n`));
  await checkMigrations(stage, openStore(path.join(dir, "empty")), path.join(dir, "m2"));
  await assert.rejects(checkMigrations(stage, db, path.join(dir, "m3")), /could not open a copy of your data\. Opening it failed: Migration \d+ \(fails on real data\) failed: UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT value FROM owner_settings WHERE name = 'default_mode'").get()?.value, "semi");
});
