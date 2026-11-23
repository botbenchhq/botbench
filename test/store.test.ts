import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../src/store/atomic.ts";
import { DB_FILE, migrate, now, openStore, schemaVersion, transaction } from "../src/store/db.ts";
import { MIGRATIONS } from "../src/store/schema.ts";

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mode = (file: string): number => fs.statSync(file).mode & 0o777;
// Written out, not derived from the code under test: bump it by hand when a migration is added.
const CURRENT = MIGRATIONS.length;
// The version 1 schema exactly as it shipped. A database created by that release must still open.
const V1_SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (1);
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
`;

/** Everything SQLite knows about the schema, as the SQL that created it. */
function schemaSql(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}
const tableNames = (db: DatabaseSync): unknown[] =>
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const columnNames = (db: DatabaseSync, table: string): unknown[] =>
  db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table).map((r) => r.name);

test("a fresh data directory gets the current schema with owner-only permissions, and reopening changes nothing", (t) => {
  const home = path.join(tempDir(t), "nested", "botbench-home");
  const dbFile = path.join(home, DB_FILE);

  const first = openStore(home);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(dbFile), 0o600);
  for (const name of fs.readdirSync(home)) assert.equal(mode(path.join(home, name)), 0o600, `${name} is owner-only`);
  assert.equal(schemaVersion(first), CURRENT);
  assert.deepEqual(tableNames(first), ["action_log", "approvals", "attempts", "browser_sessions", "chat_attempts", "chat_members", "chat_rounds", "chat_titles", "claim_takeovers", "command_lists", "command_processes", "decisions", "deliveries", "events", "evidence", "first_use", "grant_revocations", "grants", "hidden_rows", "issue_claims", "issue_fetches", "owner_settings", "plan_tasks", "push_sent", "push_subscriptions", "refinements", "reviews", "run_events", "runs", "schema_version", "task_events", "tasks", "workbench_names"]);
  assert.deepEqual(columnNames(first, "attempts"), ["id", "driver", "model", "resume_cursor", "status", "pgid", "created_at", "updated_at"]);
  assert.deepEqual(columnNames(first, "events"), ["id", "attempt_id", "turn", "ts", "type", "payload"]);
  const schemaBefore = schemaSql(first);
  first.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("claude-code", "haiku", "running", "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
  first.close();

  const second = openStore(home);
  t.after(() => second.close());
  assert.equal(schemaVersion(second), CURRENT);
  assert.deepEqual(schemaSql(second), schemaBefore);
  assert.deepEqual(second.prepare("SELECT version FROM schema_version").all().map((r) => r.version), [CURRENT]);
  assert.equal(second.prepare("SELECT count(*) AS n FROM attempts").get()?.n, 1);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(dbFile), 0o600);
});

test("opening tightens a data directory that was left open to others", (t) => {
  const home = path.join(tempDir(t), "loose");
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(mode(home), 0o700);
});

test("atomic write creates the file with owner-only mode and leaves nothing else behind", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "token");
  writeFileAtomic(file, "first");
  assert.equal(fs.readFileSync(file, "utf8"), "first");
  assert.equal(mode(file), 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["token"]);
});

test("atomic write replaces an existing file whole, tightening a loose mode", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old content that is longer than the new one", { mode: 0o644 });
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(mode(file), 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("a failed atomic write leaves the old content and no partial file", (t) => {
  const dir = tempDir(t);
  // The destination is a non-empty directory, so the final rename really fails.
  const target = path.join(dir, "occupied");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep"), "kept");
  assert.throws(() => writeFileAtomic(target, "never lands"));
  assert.deepEqual(fs.readdirSync(dir), ["occupied"]);
  assert.equal(fs.readFileSync(path.join(target, "keep"), "utf8"), "kept");
});

test("a database at an older schema version is migrated forward and keeps its rows", (t) => {
  const home = tempDir(t);
  // A real database file holding the version 1 schema as that release wrote it.
  const old = new DatabaseSync(path.join(home, DB_FILE));
  old.exec(V1_SCHEMA);
  assert.equal(schemaVersion(old), 1);
  assert.deepEqual(tableNames(old), ["attempts", "schema_version"]);
  old.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("codex", "gpt-mini", "cursor-abc", "ended", 4242, "2026-11-20T10:00:00.000Z", "2026-11-20T10:05:00.000Z");
  old.close();

  const db = openStore(home);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), CURRENT);
  assert.deepEqual(tableNames(db), ["action_log", "approvals", "attempts", "browser_sessions", "chat_attempts", "chat_members", "chat_rounds", "chat_titles", "claim_takeovers", "command_lists", "command_processes", "decisions", "deliveries", "events", "evidence", "first_use", "grant_revocations", "grants", "hidden_rows", "issue_claims", "issue_fetches", "owner_settings", "plan_tasks", "push_sent", "push_subscriptions", "refinements", "reviews", "run_events", "runs", "schema_version", "task_events", "tasks", "workbench_names"]);
  assert.deepEqual({ ...db.prepare("SELECT * FROM attempts").get() }, {
    id: 1, driver: "codex", model: "gpt-mini", resume_cursor: "cursor-abc", status: "ended", pgid: 4242,
    created_at: "2026-11-20T10:00:00.000Z", updated_at: "2026-11-20T10:05:00.000Z",
  });
  // An installation that already held a chat when it was migrated is past its first run.
  assert.equal(db.prepare("SELECT count(*) AS n FROM first_use").get()?.n, 1);
  // The table added by the later migration works against the kept row.
  db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (1, 1, ?, 'text', '{}')").run("2026-11-21T00:00:00.000Z");
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE attempt_id = 1").get()?.n, 1);
});

test("a migration that fails part-way leaves the schema and its version untouched", (t) => {
  const home = tempDir(t);
  const db = new DatabaseSync(path.join(home, DB_FILE));
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 1));
  const before = schemaSql(db);
  const broken = [...MIGRATIONS.slice(0, 1), { name: "half-done", sql: "CREATE TABLE half (id INTEGER); CREATE TABLE attempts (id INTEGER);" }];
  assert.throws(() => migrate(db, broken), /half-done/);
  assert.equal(schemaVersion(db), 1);
  assert.deepEqual(schemaSql(db), before);
});

test("the list_rows migration only adds its own tables, index and triggers: every other table, index and trigger, and every row, is as it was", (t) => {
  const home = tempDir(t);
  const db = new DatabaseSync(path.join(home, DB_FILE));
  t.after(() => db.close());
  const at = MIGRATIONS.findIndex((m) => m.name === "list_rows");
  assert.ok(at > 0, "the list_rows migration exists");
  migrate(db, MIGRATIONS.slice(0, at));
  // A chat, as one stood before the migration.
  const attempt = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('codex', 'ended', ?, ?)").run(now(), now()).lastInsertRowid);
  const round = Number(db.prepare("INSERT INTO chat_rounds (kind, message, created_at) VALUES ('ask', 'Hi', ?)").run(now()).lastInsertRowid);
  db.prepare("INSERT INTO chat_attempts (attempt_id, round_id, created_at) VALUES (?, ?, ?)").run(attempt, round, now());
  const before = schemaSql(db) as { type: string; name: string; sql: string }[];
  const rowsOf = (table: string): unknown[] => db.prepare(`SELECT * FROM ${table}`).all();
  const keptRows = Object.fromEntries((tableNames(db) as string[]).map((table) => [table, table === "schema_version" ? null : rowsOf(table)]));

  migrate(db, MIGRATIONS.slice(0, at + 1));
  const after = schemaSql(db) as { type: string; name: string; sql: string }[];
  assert.deepEqual(after.filter((entry) => before.some((b) => b.type === entry.type && b.name === entry.name)), before, "nothing that was there changed");
  const added = after.filter((entry) => !before.some((b) => b.type === entry.type && b.name === entry.name)).map((entry) => `${entry.type} ${entry.name}`).sort();
  assert.deepEqual(added, ["index chat_members_chat", "table chat_members", "table chat_titles", "table hidden_rows", "trigger chat_members_no_delete", "trigger chat_members_no_update"]);
  for (const [table, rows] of Object.entries(keptRows)) if (rows !== null) assert.deepEqual(rowsOf(table), rows, `${table} keeps its rows`);

  // What the new tables allow: chat members are append-only, a chat's name is one trimmed line of at most 80 characters.
  db.prepare("INSERT INTO chat_members (attempt_id, chat_id, created_at) VALUES (?, ?, ?)").run(attempt, attempt, now());
  assert.throws(() => db.prepare("UPDATE chat_members SET chat_id = chat_id").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM chat_members").run(), /append-only/);
  for (const bad of ["", " padded", "two\nlines", "x".repeat(81)]) assert.throws(() => db.prepare("INSERT INTO chat_titles (chat_id, title, updated_at) VALUES (?, ?, ?)").run(attempt, bad, now()), /CHECK/, JSON.stringify(bad));
  db.prepare("INSERT INTO chat_titles (chat_id, title, updated_at) VALUES (?, ?, ?)").run(attempt, "x".repeat(80), now());
  assert.throws(() => db.prepare("INSERT INTO hidden_rows (kind, item_id, hidden_at) VALUES ('branch', 1, ?)").run(now()), /CHECK/);
});

test("a database from a newer Botbench is refused, not downgraded", (t) => {
  const home = tempDir(t);
  const newer = new DatabaseSync(path.join(home, DB_FILE));
  migrate(newer, [...MIGRATIONS, { name: "from-the-future", sql: "CREATE TABLE later (id INTEGER PRIMARY KEY);" }]);
  newer.close();
  assert.throws(() => openStore(home), new RegExp(`schema version ${CURRENT + 1}.*newer`));
  const check = new DatabaseSync(path.join(home, DB_FILE));
  t.after(() => check.close());
  assert.equal(schemaVersion(check), CURRENT + 1);
  assert.ok(tableNames(check).includes("later"));
});

const insertAttempt = (db: DatabaseSync, status: string): number =>
  Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', ?, ?, ?)").run(status, now(), now()).lastInsertRowid);
const insertEvent = (db: DatabaseSync, attempt: number, type: string): void => {
  db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, '{}')").run(attempt, now(), type);
};

test("a transaction commits an event and its state change together and returns the callback's value", (t) => {
  const db = openStore(tempDir(t));
  t.after(() => db.close());
  const attempt = insertAttempt(db, "running");
  const result = transaction(db, () => {
    insertEvent(db, attempt, "turn-end");
    db.prepare("UPDATE attempts SET status = 'ended' WHERE id = ?").run(attempt);
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(db.prepare("SELECT status FROM attempts WHERE id = ?").get(attempt)?.status, "ended");
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 1);
});

test("a transaction rolls back every write when the callback throws", (t) => {
  const db = openStore(tempDir(t));
  t.after(() => db.close());
  const attempt = insertAttempt(db, "running");
  assert.throws(() => transaction(db, () => {
    insertEvent(db, attempt, "turn-end");
    db.prepare("UPDATE attempts SET status = 'ended' WHERE id = ?").run(attempt);
    insertAttempt(db, "queued");
    throw new Error("the turn handler broke");
  }), /the turn handler broke/);
  assert.equal(db.prepare("SELECT status FROM attempts WHERE id = ?").get(attempt)?.status, "running");
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n, 1);
  // The connection is usable afterwards: the failed transaction was closed.
  transaction(db, () => insertEvent(db, attempt, "text"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 1);
});

test("events are append-only and belong to a real attempt", (t) => {
  const db = openStore(tempDir(t));
  t.after(() => db.close());
  const attempt = insertAttempt(db, "running");
  insertEvent(db, attempt, "text");
  assert.throws(() => db.exec("UPDATE events SET type = 'edited'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
  assert.throws(() => insertEvent(db, attempt + 99, "text"), /FOREIGN KEY/);
  assert.deepEqual(db.prepare("SELECT type FROM events").all().map((r) => r.type), ["text"]);
});
