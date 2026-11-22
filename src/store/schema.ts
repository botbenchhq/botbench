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
  {
    // One row per task: the repository and prompt it was given, the station it is at, and where its
    // work is (worktree, branch, the commit it started from and the one Smelt made). `run_id` stays
    // empty until runs exist, and `depends_on` until tasks may depend on each other.
    // `task_events` is the history of a task's states. Rows are only ever added.
    name: "tasks",
    sql: `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  repo_path TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  worktree_path TEXT,
  branch TEXT,
  base_commit TEXT,
  head_commit TEXT,
  attempt_id INTEGER REFERENCES attempts (id),
  depends_on TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX task_events_task ON task_events (task_id, id);
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
`,
  },
];
