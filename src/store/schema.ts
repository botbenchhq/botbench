/**
 * Forward-only migrations, in order. A migration's version is its position in
 * this list, starting at 1. Never edit or reorder an entry that has shipped:
 * append a new one. Each unit adds the tables it writes to, so no table exists
 * before something uses it.
 */
export interface Migration {
  /** Short label used in error messages. */
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    // One row per driver session working on something: which CLI and model,
    // where to resume it, how it stands, and the process group to stop.
    name: "attempts",
    sql: `
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
`,
  },
  {
    // The transcript: one row per normalized driver event, grouped by turn.
    // Rows are only ever added; the triggers refuse edits and deletes.
    name: "events",
    sql: `
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
`,
  },
];
