import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./schema.ts";

export const DB_FILE = "botbench.sqlite";

export const now = (): string => new Date().toISOString();

/**
 * Run `fn` inside one write transaction: everything it writes commits together,
 * or nothing does if it throws. Use it to store an event and the state change
 * it caused as one step. `fn` must be synchronous; transactions do not nest.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    // Also covers a failed COMMIT, so the connection is never left inside a transaction.
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

/** The schema version stored in the database; 0 when it has never been migrated. */
export function schemaVersion(db: DatabaseSync): number {
  const has = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_version'").get();
  if (!has) return 0;
  const row = db.prepare("SELECT version FROM schema_version").get();
  return typeof row?.version === "number" ? row.version : 0;
}

/**
 * Bring the database up to the last migration in the list. Each migration and
 * its version bump commit together, so a failure leaves the previous version
 * intact. A database newer than the list is refused: migrations only go forward.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`The database is at schema version ${current}, which is newer than this Botbench understands (${migrations.length}). Update Botbench to open it.`);
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    const m = migrations[version - 1]!;
    try {
      transaction(db, () => {
        db.exec(m.sql);
        db.exec("DELETE FROM schema_version");
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
      });
    } catch (err) {
      throw new Error(`Migration ${version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
}

/** Create the data directory if needed and make sure only the owner can enter it. */
export function ensureDataDir(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
}

/** Open the database under `home`, creating and migrating it as needed. */
export function openStore(home: string): DatabaseSync {
  ensureDataDir(home);
  const file = path.join(home, DB_FILE);
  // Create the file ourselves so it is owner-only from its first byte. SQLite
  // gives its journal files the same permissions as the database file.
  fs.closeSync(fs.openSync(file, "a", 0o600));
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  // With recursive triggers on, a row replaced by `INSERT OR REPLACE` fires its delete trigger, so the append-only
  // tables refuse that way of rewriting a row too.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
  migrate(db);
  return db;
}
