import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIN_TOKEN_FILE, SESSION_COOKIE } from "../src/api/auth.ts";
import { insertStanding } from "../src/approvals/grants.ts";
import { dataHomes, localConfigFile, type Config } from "../src/config.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { DB_FILE, openStore } from "../src/store/db.ts";
import { LEGACY_DB_FILE, moveOldHome } from "../src/store/move-home.ts";
import { commitWork, createWorktree, describeWork, fileDiff, removeWorktree } from "../src/worktrees.ts";
import { git, initRepo, tempDir, write } from "./support/repo.ts";

// The product was called Smelt before it was called Botbench. An installation made under the old name keeps its data,
// its task branches and its settings. Every test here works on real folders, a real database and real git.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };
const CONFIG: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };

function scratch(t: T, prefix: string): string {
  const dir = tempDir(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Add a worktree the way the old name made them: on a `smelt/<run>/<task>` branch, under `<home>/worktrees`. */
function oldWorktree(repo: string, home: string, run: string, task: string): { path: string; branch: string; baseCommit: string } {
  const dir = path.join(home, "worktrees", run, task);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const branch = `smelt/${run}/${task}`;
  git(repo, "worktree", "add", "--quiet", "-b", branch, dir, "HEAD");
  return { path: dir, branch, baseCommit: git(repo, "rev-parse", "HEAD").trim() };
}

async function signIn(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

/**
 * An installation as the old name left it, in `<user>/.smelt`: a database named smelt.sqlite with a task on a
 * `smelt/` branch that has committed work, an answered approval, a standing permission, and a login token.
 */
async function oldInstallation(t: T, user: string): Promise<{ legacy: string; repo: string; token: string; taskId: number; worktree: string; head: string }> {
  const legacy = path.join(user, ".smelt");
  const repo = path.join(user, "repo");
  initRepo(repo);
  const server = await startServer({ config: CONFIG, home: legacy, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(legacy, LOGIN_TOKEN_FILE), "utf8").trim();
  const cookie = await signIn(base, token);
  const task = createTask(server.db, { repo, prompt: "add a note" });
  const worktree = oldWorktree(repo, legacy, "run-00000001", `task-${task.id}`);
  const attemptId = Number(server.db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  moveTask(server.db, task.id, "building", { worktree, attemptId });
  const asked = server.broker.request({ taskId: task.id, attemptId, role: "implementer", tool: "Bash", command: "npm test", cwd: ".", reason: "to check", toolCallId: "call-1" });
  let pending: { id: number }[] = [];
  for (let i = 0; i < 100 && pending.length === 0; i++) {
    pending = ((await (await fetch(`${base}/api/approvals?status=pending`, { headers: { cookie } })).json()) as { approvals: { id: number }[] }).approvals;
    if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const answered = await fetch(`${base}/api/approvals/${pending[0]!.id}`, { method: "POST", headers: { cookie, ...JSON_TYPE }, body: JSON.stringify({ decision: "allow" }) });
  assert.equal(answered.status, 200);
  await asked;
  insertStanding(server.db, { role: "implementer", repo, cwd: ".", words: ["npm", "test"], taskId: task.id });
  write(worktree.path, "NOTE.md", "a note\n");
  const done = await commitWork({ path: worktree.path, message: "the task's work" });
  assert.ok(done.committed);
  moveTask(server.db, task.id, "awaiting_decision", { headCommit: done.commit });
  await server.close();
  // The old name's database file. A clean close leaves no write-ahead log beside it.
  fs.renameSync(path.join(legacy, DB_FILE), path.join(legacy, LEGACY_DB_FILE));
  return { legacy, repo, token, taskId: task.id, worktree: worktree.path, head: done.commit };
}

/** The environment for a real `node src/server.ts` whose home directory is `user`: no data-folder variable of either name. */
function entryEnv(user: string, port: number, settings: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BOTBENCH|SMELT)_/.test(name)));
  return { ...env, HOME: user, BOTBENCH_PORT: String(port), BOTBENCH_CONFIG: settings };
}

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

test("A: the first start moves ~/.smelt to ~/.botbench and renames its database; tasks, approvals, permissions, the token and the copy all still work", async (t) => {
  const user = scratch(t, "botbench-user-");
  const old = await oldInstallation(t, user);
  const home = path.join(user, ".botbench");
  const settings = path.join(user, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ drivers: { "claude-code": { model: "haiku" } } }));
  const port = await freePort();
  const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const child = spawn(process.execPath, [entry], { env: entryEnv(user, port, settings), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => void child.kill("SIGKILL"));
  const exited = once(child, "exit");
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  for (let i = 0; i < 300 && !out.includes("listening"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(out, /listening/, out);

  // One plain line says what was done, and the token was not shown again: it is the same file, moved.
  const moved = out.split("\n").filter((line) => line.includes(old.legacy));
  assert.equal(moved.length, 1, out);
  assert.match(moved[0]!, new RegExp(`Moved the data folder ${old.legacy} to ${home}`));
  assert.doesNotMatch(out, /Login token/);
  assert.equal(fs.existsSync(old.legacy), false);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, DB_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, LOGIN_TOKEN_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(home, LEGACY_DB_FILE)), false);

  const base = `http://127.0.0.1:${port}`;
  const cookie = await signIn(base, old.token);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  const task = (await (await fetch(`${base}/api/tasks/${old.taskId}`, { headers: { cookie } })).json()) as { status: string; branch: string; files: { path: string }[] };
  assert.equal(task.status, "awaiting_decision");
  assert.equal(task.branch, `smelt/run-00000001/task-${old.taskId}`);
  assert.deepEqual(task.files.map((f) => f.path), ["NOTE.md"]);
  const diff = await fetch(`${base}/api/tasks/${old.taskId}/diff?file=NOTE.md`, { headers: { cookie } });
  assert.equal(diff.status, 200);
  assert.match(await diff.text(), /\+a note/);
  const approvals = (await (await fetch(`${base}/api/approvals`, { headers: { cookie } })).json()) as { approvals: { status: string }[] };
  assert.deepEqual(approvals.approvals.map((a) => a.status), ["allowed"]);

  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0, out);

  // The stored path of the task's copy follows the folder, and git's own links were repaired both ways.
  const db = new DatabaseSync(path.join(home, DB_FILE), { readOnly: true });
  const row = db.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get(old.taskId) as { worktree_path: string };
  assert.deepEqual(db.prepare("SELECT kind, words FROM grants").all().map((g) => ({ ...g })), [{ kind: "standing", words: '["npm","test"]' }]);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n > 0, "the action log came along");
  db.close();
  const now = path.join(home, "worktrees", "run-00000001", `task-${old.taskId}`);
  assert.equal(row.worktree_path, now);
  git(old.repo, "worktree", "prune");
  assert.match(git(old.repo, "worktree", "list", "--porcelain"), new RegExp(`worktree ${now}\n`));
  assert.equal(git(now, "rev-parse", "HEAD").trim(), old.head);
  assert.equal(fs.existsSync(path.join(home, "repair-worktrees")), false, "the repair is done and its marker gone");
});

test("A: with both folders present the new one is used and the old one is left as it is", async (t) => {
  const user = scratch(t, "botbench-both-");
  const legacy = path.join(user, ".smelt");
  const home = path.join(user, ".botbench");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, LEGACY_DB_FILE), "old");
  openStore(home).close();
  const lines: string[] = [];
  await moveOldHome({ home, legacy, log: (line) => lines.push(line) });
  assert.equal(fs.readFileSync(path.join(legacy, LEGACY_DB_FILE), "utf8"), "old");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`Using ${home}\\. The old data folder ${legacy} was left untouched`));
});

test("A: a failed move stops the start with what to do, and loses nothing", async (t) => {
  const user = scratch(t, "botbench-fail-");
  const legacy = path.join(user, "old", ".smelt");
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  openStore(legacy).close();
  fs.renameSync(path.join(legacy, DB_FILE), path.join(legacy, LEGACY_DB_FILE));
  // The new place is in a folder this process may not write to, so the folder cannot be renamed into it.
  const locked = path.join(user, "locked");
  fs.mkdirSync(locked, { mode: 0o500 });
  const home = path.join(locked, ".botbench");
  await assert.rejects(moveOldHome({ home, legacy, log: () => {} }), (err: Error) => err.message.includes(legacy) && err.message.includes(home) && /Nothing was deleted/.test(err.message) && /move the folder/i.test(err.message));
  assert.equal(fs.existsSync(home), false);
  // Everything is still in the old folder, readable by the same code.
  const db = openStore(legacy);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM schema_version").get());
  db.close();
});

test("A: an old installation that is still running is not moved", async (t) => {
  const user = scratch(t, "botbench-live-");
  const legacy = path.join(user, ".smelt");
  const home = path.join(user, ".botbench");
  openStore(legacy).close();
  fs.renameSync(path.join(legacy, DB_FILE), path.join(legacy, LEGACY_DB_FILE));
  // A running Smelt answers on its permission socket in the data folder.
  const running = net.createServer((socket) => socket.end());
  running.listen(path.join(legacy, "broker.sock"));
  await once(running, "listening");
  t.after(() => running.close());
  await assert.rejects(moveOldHome({ home, legacy, log: () => {} }), (err: Error) => /still running/.test(err.message) && err.message.includes(legacy));
  assert.equal(fs.existsSync(home), false);
  assert.ok(fs.existsSync(path.join(legacy, LEGACY_DB_FILE)), "nothing in the old folder was renamed");
});

test("A: a move stopped half-way is finished by the next start", async (t) => {
  const user = scratch(t, "botbench-half-");
  const legacy = path.join(user, ".smelt");
  const home = path.join(user, ".botbench");
  const db = openStore(legacy);
  db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'done', 'now', 'now')").run();
  db.close();
  // As if the first start renamed the database and then stopped: the old folder holds the new name only.
  await moveOldHome({ home, legacy, log: () => {} });
  const again = openStore(home);
  assert.equal((again.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n, 1);
  again.close();
  // A database under the old name inside the data folder (BOTBENCH_HOME pointing at an old folder) is renamed too.
  const other = path.join(user, "custom");
  const custom = openStore(other);
  custom.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'done', 'now', 'now')").run();
  custom.close();
  fs.renameSync(path.join(other, DB_FILE), path.join(other, LEGACY_DB_FILE));
  const lines: string[] = [];
  await moveOldHome({ home: other, legacy: null, log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Renamed the database/);
  const renamed = openStore(other);
  assert.equal((renamed.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n, 1);
  renamed.close();
});

test("B: a task copy on an old smelt/ branch can be described, diffed, committed to and removed; new copies use botbench/", async (t) => {
  const dir = scratch(t, "botbench-branches-");
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "home");
  initRepo(repo);
  const old = oldWorktree(repo, home, "run-1", "task-1");
  write(old.path, "a.txt", "one\n");
  const committed = await commitWork({ path: old.path, message: "work" });
  assert.ok(committed.committed);
  const work = await describeWork({ path: old.path, baseCommit: old.baseCommit });
  assert.equal(work.branch, "smelt/run-1/task-1");
  assert.deepEqual(work.files.map((f) => f.path), ["a.txt"]);
  assert.match(await fileDiff({ path: old.path, baseCommit: old.baseCommit, file: "a.txt" }), /\+one/);
  await removeWorktree({ repo, path: old.path, deleteBranch: true });
  assert.equal(fs.existsSync(old.path), false);
  const fresh = await createWorktree({ repo, home, run: "run-2", task: "task-1" });
  assert.equal(fresh.branch, "botbench/run-2/task-1");
  // Any other branch is still refused.
  git(fresh.path, "checkout", "--quiet", "-b", "feature");
  await assert.rejects(commitWork({ path: fresh.path, message: "x" }), /not on its Botbench task branch/);
});

test("C: the old environment names are read for one release with a line each, and the new names win", () => {
  const lines: string[] = [];
  const old = startupSettings({ SMELT_HOME: "/tmp/old-home", SMELT_PORT: "4999", SMELT_CONFIG: "/tmp/old.json" }, (line) => lines.push(line));
  assert.equal(old.homes.home, "/tmp/old-home");
  assert.equal(old.homes.legacy, null);
  assert.equal(old.port, 4999);
  assert.equal(old.localConfig, "/tmp/old.json");
  assert.equal(lines.length, 3);
  for (const name of ["HOME", "PORT", "CONFIG"]) assert.equal(lines.filter((line) => line.includes(`SMELT_${name}`) && line.includes(`BOTBENCH_${name}`)).length, 1, name);

  lines.length = 0;
  const both = startupSettings({ BOTBENCH_HOME: "/tmp/new-home", SMELT_HOME: "/tmp/old-home", BOTBENCH_PORT: "5000", SMELT_PORT: "4999", BOTBENCH_CONFIG: "/tmp/new.json", SMELT_CONFIG: "/tmp/old.json" }, (line) => lines.push(line));
  assert.equal(both.homes.home, "/tmp/new-home");
  assert.equal(both.port, 5000);
  assert.equal(both.localConfig, "/tmp/new.json");

  lines.length = 0;
  const none = startupSettings({}, (line) => lines.push(line));
  assert.equal(none.port, undefined);
  assert.equal(lines.length, 0);
  assert.throws(() => startupSettings({ BOTBENCH_PORT: "x" }, () => {}), /BOTBENCH_PORT must be a port number/);
});

test("C: only with no data-folder variable set is the old default folder a candidate to move", () => {
  assert.deepEqual(dataHomes({}, () => {}, "/Users/someone"), { home: "/Users/someone/.botbench", legacy: "/Users/someone/.smelt" });
  assert.deepEqual(dataHomes({ BOTBENCH_HOME: "~/x" }, () => {}, "/Users/someone"), { home: "/Users/someone/x", legacy: null });
  assert.deepEqual(dataHomes({ SMELT_HOME: "~/y" }, () => {}, "/Users/someone"), { home: "/Users/someone/y", legacy: null });
});

test("C: a browser that holds only the old cookie is simply signed out", async (t) => {
  const dir = scratch(t, "botbench-cookie-");
  const home = path.join(dir, "home");
  const server = await startServer({ config: CONFIG, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal(SESSION_COOKIE, "botbench_session");
  const cookie = await signIn(base, fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim());
  const oldCookie = `smelt_session=${cookie.split("=")[1]}`;
  const api = await fetch(`${base}/api/session`, { headers: { cookie: oldCookie } });
  assert.equal(api.status, 401);
  await api.arrayBuffer();
  const page = await fetch(`${base}/`, { headers: { cookie: oldCookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Botbench<\/title>/);
});

test("D: the old-named local settings file is read when the new one is absent, with one line, and never written", (t) => {
  const dir = scratch(t, "botbench-local-");
  const files = { current: path.join(dir, "botbench.local.json"), legacy: path.join(dir, "smelt.local.json") };
  const lines: string[] = [];
  assert.equal(localConfigFile({}, (line) => lines.push(line), files), files.current);
  assert.equal(lines.length, 0);
  fs.writeFileSync(files.legacy, "{}");
  const before = fs.statSync(files.legacy).mtimeMs;
  assert.equal(localConfigFile({}, (line) => lines.push(line), files), files.legacy);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`${files.legacy}.*botbench\\.local\\.json`));
  fs.writeFileSync(files.current, "{}");
  lines.length = 0;
  assert.equal(localConfigFile({}, (line) => lines.push(line), files), files.current);
  assert.equal(lines.length, 0);
  assert.equal(fs.statSync(files.legacy).mtimeMs, before);
});
