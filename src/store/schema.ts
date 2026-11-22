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
  {
    // `approvals`: one row per request an agent made that the owner must answer, with what the card shows.
    // A row is answered once: it leaves `pending` a single time and is never deleted.
    // `action_log`: what was decided or let run, and by which rule. Rows are only ever added.
    name: "approvals",
    sql: `
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  role TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  reason TEXT,
  tool_call_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'declined', 'superseded')),
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX approvals_status ON approvals (status, id);
CREATE INDEX approvals_task ON approvals (task_id, status);
CREATE TRIGGER approvals_answered_once BEFORE UPDATE ON approvals WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'this approval is already answered'); END;
CREATE TRIGGER approvals_request_fixed BEFORE UPDATE OF id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, created_at ON approvals
BEGIN SELECT RAISE(ABORT, 'what an approval asks for cannot be changed'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // The model the owner asked for when the task was started. NULL means the CLI's own default.
    // The model that answered is on the task's attempt, taken from the driver's session event.
    name: "task model",
    sql: `
ALTER TABLE tasks ADD COLUMN requested_model TEXT;
`,
  },
  {
    // Approvals that outlive a restart. `parked_at` is set when a start finds the approval pending from a Smelt
    // that stopped; only such an approval can carry the owner's answer (`stored_decision`, with `note`) until the
    // task is re-driven, and it ends as that answer or as superseded, never as anything else.
    // The action log gains the two rules for what became of a stored answer. A check cannot be altered in place,
    // so the table is made again with every row kept, its ids included.
    name: "parked approvals",
    sql: `
ALTER TABLE approvals ADD COLUMN parked_at TEXT;
ALTER TABLE approvals ADD COLUMN stored_decision TEXT CHECK (stored_decision IN ('allow', 'decline'));
ALTER TABLE approvals ADD COLUMN stored_at TEXT;
CREATE TRIGGER approvals_parked_once BEFORE UPDATE OF parked_at ON approvals WHEN OLD.parked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an approval is parked once'); END;
CREATE TRIGGER approvals_stored_once BEFORE UPDATE OF stored_decision, stored_at ON approvals
WHEN OLD.stored_decision IS NOT NULL OR OLD.parked_at IS NULL OR NEW.stored_decision IS NULL OR NEW.stored_at IS NULL
BEGIN SELECT RAISE(ABORT, 'an answer is stored once, and only for an approval asked before a restart'); END;
CREATE TRIGGER approvals_parked_outcome BEFORE UPDATE OF status ON approvals
WHEN OLD.parked_at IS NOT NULL AND NEW.status <> 'superseded'
  AND NEW.status IS NOT (CASE OLD.stored_decision WHEN 'allow' THEN 'allowed' WHEN 'decline' THEN 'declined' END)
BEGIN SELECT RAISE(ABORT, 'a parked approval ends as its stored answer or as superseded'); END;
CREATE TRIGGER approvals_asked_plain BEFORE INSERT ON approvals
WHEN NEW.parked_at IS NOT NULL OR NEW.stored_decision IS NOT NULL OR NEW.stored_at IS NOT NULL OR NEW.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'an approval is first written as pending, neither parked nor answered'); END;
CREATE TRIGGER approvals_stored_note_fixed BEFORE UPDATE OF note ON approvals WHEN OLD.stored_decision IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'the note of a stored answer cannot be changed'); END;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
ALTER TABLE action_log RENAME TO action_log_before_parked;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail FROM action_log_before_parked ORDER BY id;
DROP TABLE action_log_before_parked;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // `grants`: what the owner has said may run without asking. A pre-approved grant belongs to one run and is written
    // with the task that starts it; `standing` is named so that unit 10 can add its rows. A grant is never changed or
    // removed. Every new task is its own one-task run until runs have a table: `tasks.run_id` is filled from here on.
    // The action log gains the rule for a command that ran on a pre-approved grant, and the grant it ran on. A check
    // cannot be altered in place, so the table is made again with every row kept, its ids included.
    name: "grants",
    sql: `
CREATE TABLE grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('preapproved', 'standing')),
  role TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  words TEXT NOT NULL,
  run_id INTEGER,
  task_id INTEGER REFERENCES tasks (id),
  created_at TEXT NOT NULL,
  CHECK (kind <> 'preapproved' OR run_id IS NOT NULL)
);
CREATE INDEX grants_run ON grants (run_id, id);
CREATE TRIGGER grants_no_update BEFORE UPDATE ON grants
BEGIN SELECT RAISE(ABORT, 'a grant is never changed'); END;
CREATE TRIGGER grants_no_delete BEFORE DELETE ON grants
BEGIN SELECT RAISE(ABORT, 'a grant is never removed'); END;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
ALTER TABLE action_log RENAME TO action_log_before_grants;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  CHECK (rule <> 'preapproved' OR grant_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail FROM action_log_before_grants ORDER BY id;
DROP TABLE action_log_before_grants;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // Standing permissions. A standing grant is a row of `grants` with no run; it is taken back by a row of
    // `grant_revocations`, which like the grant itself is never changed or removed, so what was granted and when it
    // was taken back both stay on record. The action log gains three rules: a command that ran on a standing grant,
    // the owner giving one, and the owner taking one back; each names its grant. A check cannot be altered in place,
    // so the table is made again with every row kept, its ids included. The log is also indexed by grant, for how
    // often a grant was used, and by approval, for counting the owner's approvals.
    name: "standing permissions",
    sql: `
CREATE TRIGGER grants_standing_has_no_run BEFORE INSERT ON grants WHEN NEW.kind = 'standing' AND NEW.run_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a standing grant belongs to no run'); END;
CREATE TABLE grant_revocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL UNIQUE REFERENCES grants (id),
  revoked_at TEXT NOT NULL
);
CREATE TRIGGER grant_revocations_standing_only BEFORE INSERT ON grant_revocations
WHEN (SELECT kind FROM grants WHERE id = NEW.grant_id) IS NOT 'standing'
BEGIN SELECT RAISE(ABORT, 'only a standing grant is taken back'); END;
CREATE TRIGGER grant_revocations_no_update BEFORE UPDATE ON grant_revocations
BEGIN SELECT RAISE(ABORT, 'a revocation is never changed'); END;
CREATE TRIGGER grant_revocations_no_delete BEFORE DELETE ON grant_revocations
BEGIN SELECT RAISE(ABORT, 'a revocation is never removed'); END;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
ALTER TABLE action_log RENAME TO action_log_before_standing;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id FROM action_log_before_standing ORDER BY id;
DROP TABLE action_log_before_standing;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
];
