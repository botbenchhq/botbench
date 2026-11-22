import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBroker } from "../../src/approvals/broker.ts";
import { ClaudeCodeDriver } from "../../src/drivers/claude-code.ts";
import { checkRepository, createTask, createTasks, getTask, listTasks, moveTask, TaskError } from "../../src/engine/task.ts";
import { DB_FILE, openStore, schemaVersion } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { checkoutState, git, initRepo, botbenchBranches, tempDir, worktreeCount, write } from "../support/repo.ts";

// No test in this file starts a driver: tasks that reach Claude Code are in test/live/task.live.test.ts.

type T = { after(fn: () => unknown): void };

/** A temporary directory for a Botbench home and the repositories of one test. Removing it removes their worktrees with them. */
function scratch(t: T): { dir: string; home: string } {
  const dir = tempDir("botbench-task-test-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home: path.join(dir, "home") };
}

function store(t: T): { db: DatabaseSync; dir: string; home: string } {
  const s = scratch(t);
  const db = openStore(s.home);
  t.after(() => db.close());
  return { db, ...s };
}

const row = (db: DatabaseSync, id: number) => ({ ...db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) });
const eventRows = (db: DatabaseSync, id: number) => db.prepare("SELECT status, detail FROM task_events WHERE task_id = ? ORDER BY id").all(id).map((r) => ({ ...r }));

// The version 2 schema exactly as it shipped with units 1 to 5. A database created by that release must still open.
const V2_SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (2);
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  driver TEXT NOT NULL,
  model TEXT,
  resume_cursor TEXT,
  status TEXT NOT NULL,
  pgid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  turn INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX events_attempt ON events (attempt_id, id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`;

test("a database at the previous schema version gains the task tables and keeps its attempts and events", (t) => {
  const { home } = scratch(t);
  fs.mkdirSync(home, { recursive: true });
  const old = new DatabaseSync(path.join(home, DB_FILE));
  old.exec(V2_SCHEMA);
  old.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("claude-code", "haiku", "cursor-abc", "ended", null, "2026-11-21T10:00:00.000Z", "2026-11-21T10:05:00.000Z");
  old.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (1, 1, ?, 'text', ?)").run("2026-11-21T10:01:00.000Z", '{"type":"text","text":"kept"}');
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.deepEqual({ ...db.prepare("SELECT * FROM attempts").get() }, {
    id: 1, driver: "claude-code", model: "haiku", resume_cursor: "cursor-abc", status: "ended", pgid: null,
    created_at: "2026-11-21T10:00:00.000Z", updated_at: "2026-11-21T10:05:00.000Z",
  });
  assert.deepEqual({ ...db.prepare("SELECT * FROM events").get() }, { id: 1, attempt_id: 1, turn: 1, ts: "2026-11-21T10:01:00.000Z", type: "text", payload: '{"type":"text","text":"kept"}' });
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('tasks') ORDER BY cid").all().map((r) => r.name),
    ["id", "run_id", "repo_path", "prompt", "status", "reason", "worktree_path", "branch", "base_commit", "head_commit", "attempt_id", "depends_on", "created_at", "updated_at", "requested_model", "checks"],
  );
  assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('task_events') ORDER BY cid").all().map((r) => r.name), ["id", "task_id", "ts", "status", "detail"]);

  // The new tables work against the kept attempt.
  const task = createTask(db, { repo: "/somewhere/repo", prompt: "p" });
  const worktree = { path: "/somewhere/home/worktrees/r/task-1", branch: "botbench/r/task-1", baseCommit: "a".repeat(40) };
  moveTask(db, task.id, "building", { worktree });
  assert.equal(moveTask(db, task.id, "building", { attemptId: 1 }).attemptId, 1);
  assert.throws(() => moveTask(db, task.id, "building", { attemptId: 99 }), /FOREIGN KEY/, "an attempt that does not exist cannot be recorded");
});

test("a new task is stored as queued, with nothing it does not have yet, together with its first event", (t) => {
  const { db } = store(t);
  const task = createTask(db, { repo: "/repos/sample", prompt: "create hello.txt containing hi" });
  assert.equal(task.id, 1);
  const stored = row(db, task.id);
  assert.match(String(stored.created_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(stored.updated_at, stored.created_at);
  assert.deepEqual({ ...stored, created_at: null, updated_at: null }, {
    id: 1, run_id: 1, repo_path: "/repos/sample", prompt: "create hello.txt containing hi", status: "queued", reason: null,
    worktree_path: null, branch: null, base_commit: null, head_commit: null, attempt_id: null, depends_on: "", created_at: null, updated_at: null, requested_model: null, checks: null,
  });
  assert.deepEqual(eventRows(db, task.id), [{ status: "queued", detail: null }]);
  assert.deepEqual(getTask(db, task.id), task);
  assert.deepEqual(task, {
    id: 1, runId: 1, repo: "/repos/sample", prompt: "create hello.txt containing hi", requestedModel: null, status: "queued", reason: null,
    worktreePath: null, branch: null, baseCommit: null, headCommit: null, attemptId: null, checks: null, dependsOn: "", createdAt: stored.created_at, updatedAt: stored.created_at,
  });
  assert.equal(getTask(db, 2), null);

  const second = createTask(db, { repo: "/repos/other", prompt: "second" });
  assert.deepEqual(listTasks(db).map((x) => x.id), [second.id, task.id], "newest first");
});

test("a task moves along the line, and each state is stored with its event", (t) => {
  const { db } = store(t);
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'x', 'x')").run().lastInsertRowid);
  const task = createTask(db, { repo: "/repos/sample", prompt: "p" });
  const worktree = { path: "/home/worktrees/run-1/task-1", branch: "botbench/run-1/task-1", baseCommit: "b".repeat(40) };

  const building = moveTask(db, task.id, "building", { worktree });
  assert.deepEqual([building.status, building.worktreePath, building.branch, building.baseCommit, building.attemptId], ["building", worktree.path, worktree.branch, worktree.baseCommit, null]);
  const attached = moveTask(db, task.id, "building", { attemptId });
  assert.equal(attached.attemptId, attemptId);
  const done = moveTask(db, task.id, "awaiting_decision", { headCommit: "c".repeat(40) });
  assert.deepEqual([done.status, done.headCommit, done.reason], ["awaiting_decision", "c".repeat(40), null]);
  assert.deepEqual(getTask(db, task.id), done);
  assert.deepEqual(eventRows(db, task.id), [
    { status: "queued", detail: null },
    { status: "building", detail: `worktree on branch ${worktree.branch}` },
    { status: "building", detail: `attempt ${attemptId}` },
    { status: "awaiting_decision", detail: `head commit ${"c".repeat(40)}` },
  ]);

  // The other ends of the line carry their reason.
  const stopped = createTask(db, { repo: "/repos/sample", prompt: "p" });
  moveTask(db, stopped.id, "building", { worktree: { ...worktree, path: "/home/worktrees/run-2/task-2" } });
  assert.deepEqual([moveTask(db, stopped.id, "interrupted", { reason: "The turn was stopped." }).reason], ["The turn was stopped."]);
  const failed = createTask(db, { repo: "/repos/sample", prompt: "p" });
  assert.equal(moveTask(db, failed.id, "failed", { reason: "Claude Code is signed out." }).status, "failed");
  assert.deepEqual(eventRows(db, failed.id), [{ status: "queued", detail: null }, { status: "failed", detail: "Claude Code is signed out." }]);
});

test("a state change and its event are written together or not at all", (t) => {
  const { db } = store(t);
  const task = createTask(db, { repo: "/repos/sample", prompt: "p" });
  moveTask(db, task.id, "building", { worktree: { path: "/home/worktrees/r/task-1", branch: "botbench/r/task-1", baseCommit: "b".repeat(40) } });
  const before = { task: row(db, task.id), events: eventRows(db, task.id) };

  // The database itself refuses the event: the state change that caused it must not stay.
  db.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON task_events WHEN NEW.status = 'awaiting_decision' BEGIN SELECT RAISE(ABORT, 'event refused'); END;");
  assert.throws(() => moveTask(db, task.id, "awaiting_decision", { headCommit: "c".repeat(40) }), /event refused/);
  assert.deepEqual({ task: row(db, task.id), events: eventRows(db, task.id) }, before);
  assert.equal(db.isTransaction, false, "no transaction is left open");
  db.exec("DROP TRIGGER refuse_event");

  // The database refuses the state change: its event must not stay either.
  db.exec("CREATE TRIGGER refuse_state BEFORE UPDATE ON tasks WHEN NEW.status = 'interrupted' BEGIN SELECT RAISE(ABORT, 'state refused'); END;");
  assert.throws(() => moveTask(db, task.id, "interrupted", { reason: "stopped" }), /state refused/);
  assert.deepEqual({ task: row(db, task.id), events: eventRows(db, task.id) }, before);
  db.exec("DROP TRIGGER refuse_state");

  // The same for a new task: no row without its first event.
  db.exec("CREATE TRIGGER refuse_first BEFORE INSERT ON task_events WHEN NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'event refused'); END;");
  assert.throws(() => createTask(db, { repo: "/repos/sample", prompt: "p" }), /event refused/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 1);
  db.exec("DROP TRIGGER refuse_first");

  // With nothing in the way, the same change goes through.
  assert.equal(moveTask(db, task.id, "awaiting_decision", { headCommit: "c".repeat(40) }).status, "awaiting_decision");
});

test("a move the line does not have is refused and writes nothing; task events cannot be edited or deleted", (t) => {
  const { db } = store(t);
  const task = createTask(db, { repo: "/repos/sample", prompt: "p" });
  assert.throws(() => moveTask(db, task.id, "awaiting_decision", { headCommit: "c".repeat(40) }), /queued.*awaiting_decision/, "a task that never built has nothing to decide on");
  assert.throws(() => moveTask(db, 99, "building"), /No task 99/);
  moveTask(db, task.id, "failed", { reason: "could not start" });
  for (const to of ["queued", "building", "awaiting_decision", "interrupted", "failed"] as const) {
    assert.throws(() => moveTask(db, task.id, to), /failed/, `failed is an end: no move to ${to}`);
  }
  assert.throws(() => moveTask(db, task.id, "decided" as never), /failed|decided/);
  assert.deepEqual(eventRows(db, task.id), [{ status: "queued", detail: null }, { status: "failed", detail: "could not start" }]);
  assert.equal(row(db, task.id).status, "failed");

  assert.throws(() => db.prepare("UPDATE task_events SET status = 'building' WHERE task_id = ?").run(task.id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM task_events WHERE task_id = ?").run(task.id), /append-only/);
});

test("a repository path is checked before it is used: absolute, a git repository's top level, with a commit", async (t) => {
  const { dir } = scratch(t);
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "sub/file.txt": "x\n" });
  assert.equal(await checkRepository(repo), repo);
  assert.equal(await checkRepository(`${repo}/sub/..`), repo, "the path is stored without its detours");

  const empty = path.join(dir, "no-commits");
  fs.mkdirSync(empty);
  git(empty, "init", "--quiet");
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  const refusals: [unknown, RegExp][] = [
    ["repo", /full path/],
    ["./repo", /full path/],
    ["~/repo", /full path/],
    ["", /full path/],
    [undefined, /full path/],
    [42, /full path/],
    [`${repo}\0/x`, /full path/],
    [`/${"x".repeat(5000)}`, /too long/],
    [path.join(dir, "missing"), /does not exist/],
    [path.join(repo, "README.md"), /not a directory/],
    [plain, /not a git repository/],
    [empty, /no commits/],
    [path.join(repo, "sub"), /top level/],
  ];
  for (const [input, words] of refusals) {
    await assert.rejects(checkRepository(input), (err: unknown) => err instanceof TaskError && err.status === 400 && words.test(err.message), `refused: ${String(input).slice(0, 40)}`);
  }
});

test("on start, a task left building by a Botbench that stopped has its work committed by Botbench and is marked interrupted; the checkout is untouched", async (t) => {
  const { db, dir, home } = store(t);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  write(repo, "README.md", "# Sample\nthe owner is half-way through this line\n");
  write(repo, "notes.txt", "untracked, the owner's\n");
  const before = checkoutState(repo);

  // What a Botbench that was killed mid-build leaves: a queued task, and a building one with files its agent had written.
  const queued = createTask(db, { repo, prompt: "never started" });
  const building = createTask(db, { repo, prompt: "half done\nsecond line" });
  const worktree = await createWorktree({ repo, home, run: "run-old", task: `task-${building.id}` });
  moveTask(db, building.id, "building", { worktree });
  write(worktree.path, "partial.txt", "written before the stop\n");

  const announced: number[] = [];
  const tasks = createTasks({ db, home, driver: new ClaudeCodeDriver(), broker: createBroker({ db, home, onChange: () => {} }), onEvent: () => {}, onTaskChange: (task) => announced.push(task.id) });
  await tasks.idle();
  t.after(() => tasks.close());

  const after = getTask(db, building.id)!;
  assert.equal(after.status, "interrupted");
  assert.match(after.reason ?? "", /Botbench stopped/);
  assert.notEqual(after.headCommit, base);
  assert.equal(git(repo, "rev-parse", worktree.branch).trim(), after.headCommit);
  assert.equal(git(repo, "show", `${worktree.branch}:partial.txt`), "written before the stop\n");
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>|%s", worktree.branch).trim(), `Botbench <botbench@localhost>|Botbench task ${building.id}: half done`);
  assert.equal(git(worktree.path, "status", "--porcelain"), "", "nothing is left uncommitted in the worktree");

  const never = getTask(db, queued.id)!;
  assert.deepEqual([never.status, never.worktreePath, never.headCommit], ["interrupted", null, null]);
  assert.deepEqual(announced.sort(), [queued.id, building.id].sort(), "each change is announced");
  assert.deepEqual(checkoutState(repo), before, "the owner's checkout: same branch, same commit, same uncommitted changes");
  assert.equal(worktreeCount(repo), 2);
  assert.deepEqual(botbenchBranches(repo), [worktree.branch]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no driver was started");
});

test("a task whose worktree cannot be made fails with the reason, without a driver; after closing, nothing more is started", async (t) => {
  // Botbench's home inside the repository itself: the one place a worktree must never go.
  const dir = tempDir("botbench-task-test-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initRepo(dir);
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const before = checkoutState(dir);

  const announced: string[] = [];
  const tasks = createTasks({ db, home, driver: new ClaudeCodeDriver(), broker: createBroker({ db, home, onChange: () => {} }), onEvent: () => {}, onTaskChange: (task) => announced.push(`${task.id}:${task.status}`) });
  const started = await tasks.start(dir, "anything");
  assert.equal(started.status, "queued", "the answer comes before the build");
  await tasks.idle();
  const task = getTask(db, started.id)!;
  assert.equal(task.status, "failed");
  assert.match(task.reason ?? "", /copy of the project could not be created: .*inside the repository/);
  assert.deepEqual([task.worktreePath, task.branch, task.attemptId], [null, null, null]);
  assert.deepEqual(announced, [`${task.id}:queued`, `${task.id}:failed`]);
  assert.deepEqual(eventRows(db, task.id).map((e) => e.status), ["queued", "failed"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no driver was started");
  assert.equal(worktreeCount(dir), 1);
  assert.deepEqual(botbenchBranches(dir), []);
  assert.deepEqual(checkoutState(dir), before);

  await tasks.close();
  await assert.rejects(tasks.start(dir, "too late"), (err: unknown) => err instanceof TaskError && err.status === 503);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 1);
});
