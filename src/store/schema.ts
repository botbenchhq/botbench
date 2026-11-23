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
    // work is (worktree, branch, the commit it started from and the one Botbench made). `run_id` stays
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
    // Approvals that outlive a restart. `parked_at` is set when a start finds the approval pending from a Botbench
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
  {
    // Runs. `runs` holds one row per run id: a planned run (a prompt or a spec file, a plan, the tasks approved from
    // it) with its state, or `single`, the run of one that a task started on its own is, which has no state of its
    // own. Ids go on from the highest `tasks.run_id` in use and are never used twice, so every grant and task from
    // before keeps the run it named. `plan_tasks` is a run's plan, fixed once the plan is approved; `run_events` is
    // the history of a run's states, only ever added to. A task names a run that exists and stays in it.
    // A planner asks for permission with no task, so an approval and a log entry may now name a run in a task's
    // place. A column's NOT NULL cannot be altered, so both tables are made again with every row kept, ids included.
    name: "runs",
    sql: `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('planned', 'single')),
  repo_path TEXT NOT NULL,
  prompt TEXT,
  spec_path TEXT,
  spec_text TEXT,
  status TEXT CHECK (status IN ('planning', 'awaiting_plan_approval', 'running', 'awaiting_decision', 'done', 'cancelled', 'failed')),
  reason TEXT,
  requested_model TEXT,
  planner_model TEXT,
  base_commit TEXT,
  attempt_id INTEGER REFERENCES attempts (id),
  plan_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'planned') = (status IS NOT NULL)),
  CHECK (kind <> 'planned' OR (prompt IS NULL) <> (spec_text IS NULL)),
  CHECK ((spec_path IS NULL) = (spec_text IS NULL))
);
INSERT INTO runs (id, kind, repo_path, prompt, created_at, updated_at)
  SELECT run_id, 'single', repo_path, prompt, created_at, updated_at FROM tasks
  WHERE id IN (SELECT MIN(id) FROM tasks WHERE run_id IS NOT NULL GROUP BY run_id) ORDER BY run_id;
CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
BEGIN SELECT RAISE(ABORT, 'a run is never removed'); END;
CREATE TRIGGER runs_end_is_end BEFORE UPDATE OF status ON runs
WHEN NEW.status IS NOT OLD.status AND (OLD.status IN ('cancelled', 'failed', 'done') OR (OLD.status IN ('running', 'awaiting_decision') AND NEW.status IN ('planning', 'awaiting_plan_approval')))
BEGIN SELECT RAISE(ABORT, 'a run that has ended stays ended, and an approved plan is not reopened'); END;
CREATE TRIGGER runs_fixed BEFORE UPDATE OF id, kind, repo_path, prompt, spec_path, spec_text, base_commit, created_at ON runs
BEGIN SELECT RAISE(ABORT, 'what a run was started with is never changed'); END;
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX run_events_run ON run_events (run_id, id);
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TABLE plan_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  criteria TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '',
  task_id INTEGER REFERENCES tasks (id),
  UNIQUE (run_id, position)
);
CREATE TRIGGER plan_tasks_open_insert BEFORE INSERT ON plan_tasks
WHEN (SELECT status FROM runs WHERE id = NEW.run_id) IS NOT 'planning' AND (SELECT status FROM runs WHERE id = NEW.run_id) IS NOT 'awaiting_plan_approval'
BEGIN SELECT RAISE(ABORT, 'a plan is changed only before it is approved'); END;
CREATE TRIGGER plan_tasks_open_update BEFORE UPDATE ON plan_tasks
WHEN (SELECT status FROM runs WHERE id = OLD.run_id) IS NOT 'planning' AND (SELECT status FROM runs WHERE id = OLD.run_id) IS NOT 'awaiting_plan_approval'
BEGIN SELECT RAISE(ABORT, 'a plan is changed only before it is approved'); END;
CREATE TRIGGER plan_tasks_open_delete BEFORE DELETE ON plan_tasks
WHEN (SELECT status FROM runs WHERE id = OLD.run_id) IS NOT 'planning' AND (SELECT status FROM runs WHERE id = OLD.run_id) IS NOT 'awaiting_plan_approval'
BEGIN SELECT RAISE(ABORT, 'a plan is changed only before it is approved'); END;
CREATE TRIGGER tasks_run_exists BEFORE INSERT ON tasks WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'a task belongs to a run that exists'); END;
CREATE TRIGGER tasks_run_fixed BEFORE UPDATE OF run_id ON tasks WHEN NEW.run_id IS NOT OLD.run_id
BEGIN SELECT RAISE(ABORT, 'a task stays in its run'); END;
CREATE INDEX tasks_run ON tasks (run_id, id);

ALTER TABLE approvals RENAME TO approvals_before_runs;
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks (id),
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
  resolved_at TEXT,
  parked_at TEXT,
  stored_decision TEXT CHECK (stored_decision IN ('allow', 'decline')),
  stored_at TEXT,
  run_id INTEGER REFERENCES runs (id),
  CHECK ((task_id IS NULL) <> (run_id IS NULL))
);
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, note, created_at, resolved_at, parked_at, stored_decision, stored_at)
  SELECT id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, note, created_at, resolved_at, parked_at, stored_decision, stored_at FROM approvals_before_runs ORDER BY id;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_runs;
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
  run_id INTEGER REFERENCES runs (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id FROM action_log_before_runs ORDER BY id;
DROP TABLE action_log_before_runs;
DROP TABLE approvals_before_runs;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;

CREATE INDEX approvals_status ON approvals (status, id);
CREATE INDEX approvals_task ON approvals (task_id, status);
CREATE INDEX approvals_run ON approvals (run_id, status);
CREATE TRIGGER approvals_answered_once BEFORE UPDATE ON approvals WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'this approval is already answered'); END;
CREATE TRIGGER approvals_request_fixed BEFORE UPDATE OF id, task_id, run_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, created_at ON approvals
BEGIN SELECT RAISE(ABORT, 'what an approval asks for cannot be changed'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;
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
`,
  },
  {
    // Evidence: one row per command Botbench ran on a task (unit 12: the repository's setup commands), with how it ended,
    // its exit code or signal, the end of its output, its time limit and its times. Rows are only ever added; the
    // triggers refuse edits and deletes, and with recursive triggers on, a row replaced by INSERT OR REPLACE too.
    name: "evidence",
    sql: `
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL CHECK (kind IN ('setup')),
  position INTEGER NOT NULL CHECK (position >= 1),
  command TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'timed_out', 'stopped')),
  exit_code INTEGER,
  signal TEXT,
  output TEXT NOT NULL,
  output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
  limit_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  UNIQUE (task_id, kind, position)
);
CREATE INDEX evidence_task ON evidence (task_id, id);
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
`,
  },
  {
    // Checks (unit 13): the commands that verify a task's work are stored as evidence too, beside its setup commands.
    // A CHECK constraint cannot be altered, so the evidence table is made again with every row kept, ids included, and
    // its append-only triggers put back. A task gains `checks`, what its checks found once it was built: passed,
    // failed (one failed or ran out of time), or none (the repository has no check commands). It is written once.
    name: "checks",
    sql: `
DROP TRIGGER evidence_no_update;
DROP TRIGGER evidence_no_delete;
DROP INDEX evidence_task;
ALTER TABLE evidence RENAME TO evidence_before_checks;
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'check')),
  position INTEGER NOT NULL CHECK (position >= 1),
  command TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'timed_out', 'stopped')),
  exit_code INTEGER,
  signal TEXT,
  output TEXT NOT NULL,
  output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
  limit_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  UNIQUE (task_id, kind, position)
);
INSERT INTO evidence (id, task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms)
  SELECT id, task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms FROM evidence_before_checks ORDER BY id;
DROP TABLE evidence_before_checks;
CREATE INDEX evidence_task ON evidence (task_id, id);
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
ALTER TABLE tasks ADD COLUMN checks TEXT CHECK (checks IN ('passed', 'failed', 'none'));
CREATE TRIGGER tasks_checks_once BEFORE UPDATE OF checks ON tasks WHEN OLD.checks IS NOT NULL AND NEW.checks IS NOT OLD.checks
BEGIN SELECT RAISE(ABORT, 'what the checks found is recorded once'); END;
`,
  },
  {
    // Decisions (unit 14): the owner accepts or rejects a task that is ready for review. One row per task, written once
    // and never changed: who decided (the owner), what, what became of the branch, the branch and the commit it held,
    // the files the checks had left in the task's copy that went with it, and when. A row is written only for a task
    // that is ready for review, and a task becomes accepted or rejected only with its row. The action log gains a
    // rule for each decision. A check cannot be altered in place, so the log is made again with every row kept, ids
    // included, and its indexes and append-only triggers put back.
    name: "decisions",
    sql: `
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks (id),
  decided_by TEXT NOT NULL CHECK (decided_by = 'owner'),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  branch TEXT NOT NULL CHECK (branch IN ('kept', 'deleted')),
  branch_name TEXT NOT NULL,
  head_commit TEXT,
  leftovers TEXT NOT NULL DEFAULT '[]',
  decided_at TEXT NOT NULL,
  CHECK (decision <> 'accept' OR branch = 'kept')
);
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER decisions_ready_only BEFORE INSERT ON decisions
WHEN (SELECT status FROM tasks WHERE id = NEW.task_id) IS NOT 'awaiting_decision'
BEGIN SELECT RAISE(ABORT, 'a decision is made only on a task that is ready for review'); END;
CREATE TRIGGER tasks_decided_with_decision BEFORE UPDATE OF status ON tasks
WHEN NEW.status IN ('accepted', 'rejected') AND NOT EXISTS (SELECT 1 FROM decisions WHERE task_id = NEW.id AND decision = (CASE NEW.status WHEN 'accepted' THEN 'accept' ELSE 'reject' END))
BEGIN SELECT RAISE(ABORT, 'a task is accepted or rejected only with its decision'); END;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_decisions;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected') OR task_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id FROM action_log_before_decisions ORDER BY id;
DROP TABLE action_log_before_decisions;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // Discards (unit 16): the owner removes what a task that failed, was stopped or was cancelled left behind, its copy
    // (the git worktree) and Botbench's branch. Such a task was never ready for review, so this is no decision: the
    // task keeps its state and reason, and the action log gains a rule for it, which names its task. A check cannot be
    // altered in place, so the log is made again with every row kept, ids included, and its indexes and append-only
    // triggers put back.
    name: "discards",
    sql: `
DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_discards;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded') OR task_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id FROM action_log_before_discards ORDER BY id;
DROP TABLE action_log_before_discards;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // Recovery after a restart (unit 15). Evidence gains `round`: which time its list of commands was run on the task,
    // from 1. A list stopped by a restart is run again from the start as the next round, and the stopped round stays on
    // record, so the unique key takes the round. A constraint cannot be altered, so the table is made again with every
    // row kept, ids included, as round 1, and its append-only triggers put back. Tasks and runs gain `restarts`: how
    // many times a restart took them up again since the owner last started or resumed them; the second restart stops
    // them for the owner instead. `command_processes`: one row per setup or check command Botbench starts, written
    // before it starts, with its process group and when it was started once it runs, and its temporary folder, and
    // closed (`ended_at`, no group) in the same write that stores its evidence. A row left open is a command a
    // stopped Botbench left running: the next start stops its group, after checking it is still that command's.
    // A done run may go back to running, and only to running: the owner resumed one of its stopped tasks.
    name: "recovery",
    sql: `
DROP TRIGGER evidence_no_update;
DROP TRIGGER evidence_no_delete;
DROP INDEX evidence_task;
ALTER TABLE evidence RENAME TO evidence_before_recovery;
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'check')),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  position INTEGER NOT NULL CHECK (position >= 1),
  command TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'timed_out', 'stopped')),
  exit_code INTEGER,
  signal TEXT,
  output TEXT NOT NULL,
  output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
  limit_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  UNIQUE (task_id, kind, round, position)
);
INSERT INTO evidence (id, task_id, kind, round, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms)
  SELECT id, task_id, kind, 1, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms FROM evidence_before_recovery ORDER BY id;
DROP TABLE evidence_before_recovery;
CREATE INDEX evidence_task ON evidence (task_id, id);
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
ALTER TABLE tasks ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0 CHECK (restarts >= 0);
ALTER TABLE runs ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0 CHECK (restarts >= 0);
CREATE TABLE command_processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'check')),
  round INTEGER NOT NULL CHECK (round >= 1),
  position INTEGER NOT NULL CHECK (position >= 1),
  command TEXT NOT NULL,
  limit_ms INTEGER NOT NULL,
  tmp_dir TEXT,
  pgid INTEGER,
  spawned_at TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX command_processes_open ON command_processes (ended_at, task_id);
DROP TRIGGER runs_end_is_end;
CREATE TRIGGER runs_end_is_end BEFORE UPDATE OF status ON runs
WHEN NEW.status IS NOT OLD.status AND (OLD.status IN ('cancelled', 'failed') OR (OLD.status = 'done' AND NEW.status <> 'running') OR (OLD.status IN ('running', 'awaiting_decision') AND NEW.status IN ('planning', 'awaiting_plan_approval')))
BEGIN SELECT RAISE(ABORT, 'a run that has ended stays ended, apart from a done run the owner resumes a stopped task of, and an approved plan is not reopened'); END;
`,
  },
  {
    // Reviews (U20, in part): a run may name a reviewer, an agent and model chosen when it starts and never changed after.
    // Once a task of such a run is built and checked, the reviewer reads its diff and the reply is stored, one row per
    // task, never changed: who reviewed, how it ended, the verdict read from the reply's first line, the reply itself,
    // the plain reason when there is no review, how long the diff was and whether it was cut, and the times. A row is
    // written only for a task at the review station. Rows are only ever added; with recursive triggers on, a row
    // replaced by INSERT OR REPLACE is refused too.
    name: "reviews",
    sql: `
ALTER TABLE runs ADD COLUMN reviewer_agent TEXT;
ALTER TABLE runs ADD COLUMN reviewer_model TEXT;
CREATE TRIGGER runs_reviewer_fixed BEFORE UPDATE OF reviewer_agent, reviewer_model ON runs
BEGIN SELECT RAISE(ABORT, 'a run''s reviewer is chosen when it starts and never changed'); END;
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks (id),
  agent TEXT NOT NULL,
  model TEXT,
  attempt_id INTEGER REFERENCES attempts (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('reviewed', 'failed', 'timed_out', 'stopped')),
  verdict TEXT CHECK (verdict IN ('looks_right', 'concerns')),
  text TEXT NOT NULL,
  problem TEXT,
  diff_chars INTEGER NOT NULL,
  diff_cut INTEGER NOT NULL CHECK (diff_cut IN (0, 1)),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  CHECK ((outcome = 'reviewed') = (problem IS NULL)),
  CHECK (outcome = 'reviewed' OR verdict IS NULL)
);
CREATE TRIGGER reviews_no_update BEFORE UPDATE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are append-only'); END;
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are append-only'); END;
CREATE TRIGGER reviews_task_reviewing BEFORE INSERT ON reviews
WHEN (SELECT status FROM tasks WHERE id = NEW.task_id) IS NOT 'reviewing'
BEGIN SELECT RAISE(ABORT, 'a review is stored only for a task at the review station'); END;
`,
  },
  {
    // Notifications (unit 23): one row per device the owner turned notifications on for. The endpoint is the push
    // service's address for that device and is secret to it; p256dh and auth are the device's public key and secret,
    // which messages are encrypted to. A device turning them off, or the push service saying it expired, deletes it.
    name: "push_subscriptions",
    sql: `
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    // Modes (manual, semi-autonomous, fully autonomous): a run's mode is chosen when it starts and never changed after.
    // A fully autonomous run may accept a task without the owner: `decisions` then names the mode as who decided, with
    // the reasons the task qualified, and only for an accept that keeps the branch, of a task of a fully autonomous
    // run whose checks passed, with nothing left by the checks in its copy. The action log gains a rule for a command a
    // mode let run without asking, one for what a fully autonomous run refused, and one for its accept, which names its
    // task. `owner_settings` keeps what the owner chose in Settings: the mode a new run is given when none is named.
    // A check cannot be altered in place, so both tables are made again with every row kept, ids included, and their
    // indexes and triggers put back; the trigger on tasks that reads `decisions` is dropped first and made again.
    name: "modes",
    sql: `
ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'semi', 'full'));
CREATE TRIGGER runs_mode_fixed BEFORE UPDATE OF mode ON runs
BEGIN SELECT RAISE(ABORT, 'a run''s mode is chosen when it starts and never changed'); END;
CREATE TABLE owner_settings (
  name TEXT PRIMARY KEY CHECK (name IN ('default_mode')),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (name <> 'default_mode' OR value IN ('manual', 'semi', 'full'))
);

DROP TRIGGER decisions_no_update;
DROP TRIGGER decisions_no_delete;
DROP TRIGGER decisions_ready_only;
DROP TRIGGER tasks_decided_with_decision;
ALTER TABLE decisions RENAME TO decisions_before_modes;
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks (id),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('owner', 'mode')),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  branch TEXT NOT NULL CHECK (branch IN ('kept', 'deleted')),
  branch_name TEXT NOT NULL,
  head_commit TEXT,
  leftovers TEXT NOT NULL DEFAULT '[]',
  decided_at TEXT NOT NULL,
  reasons TEXT,
  CHECK (decision <> 'accept' OR branch = 'kept'),
  CHECK (decided_by = 'owner' OR (decision = 'accept' AND reasons IS NOT NULL AND leftovers = '[]'))
);
INSERT INTO decisions (id, task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, reasons)
  SELECT id, task_id, decided_by, decision, branch, branch_name, head_commit, leftovers, decided_at, NULL FROM decisions_before_modes ORDER BY id;
DROP TABLE decisions_before_modes;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER decisions_ready_only BEFORE INSERT ON decisions
WHEN (SELECT status FROM tasks WHERE id = NEW.task_id) IS NOT 'awaiting_decision'
BEGIN SELECT RAISE(ABORT, 'a decision is made only on a task that is ready for review'); END;
CREATE TRIGGER decisions_by_mode_only_full BEFORE INSERT ON decisions
WHEN NEW.decided_by = 'mode' AND ((SELECT r.mode FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = NEW.task_id) IS NOT 'full' OR (SELECT checks FROM tasks WHERE id = NEW.task_id) IS NOT 'passed')
BEGIN SELECT RAISE(ABORT, 'only a fully autonomous run decides without the owner, and only on a task whose checks passed'); END;
CREATE TRIGGER tasks_decided_with_decision BEFORE UPDATE OF status ON tasks
WHEN NEW.status IN ('accepted', 'rejected') AND NOT EXISTS (SELECT 1 FROM decisions WHERE task_id = NEW.id AND decision = (CASE NEW.status WHEN 'accepted' THEN 'accept' ELSE 'reject' END))
BEGIN SELECT RAISE(ABORT, 'a task is accepted or rejected only with its decision'); END;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_modes;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted') OR task_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id FROM action_log_before_modes ORDER BY id;
DROP TABLE action_log_before_modes;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // Three findings from building Botbench with itself. Decisions gain the owner's optional short note, written with
    // the decision and, as the decision is append-only, never changed; a decision the mode made has none. A run gains the model its tasks are built on,
    // chosen when it starts and never changed after; `build_model_set` tells a run that recorded one (null then means
    // the agent's own default) from a run made before this, which did not. And each time a list of setup or check
    // commands is run on a task, how many commands that list holds is recorded as it starts, so a count shown while it
    // runs is out of the whole list. Rows are only ever added.
    name: "decision notes, build model and list sizes",
    sql: `
ALTER TABLE decisions ADD COLUMN note TEXT;
CREATE TRIGGER decisions_note_owner_only BEFORE INSERT ON decisions
WHEN NEW.note IS NOT NULL AND NEW.decided_by <> 'owner'
BEGIN SELECT RAISE(ABORT, 'only the owner''s decision carries a note'); END;
ALTER TABLE runs ADD COLUMN build_model TEXT;
ALTER TABLE runs ADD COLUMN build_model_set INTEGER NOT NULL DEFAULT 0 CHECK (build_model_set IN (0, 1));
CREATE TRIGGER runs_build_model_fixed BEFORE UPDATE OF build_model, build_model_set ON runs
BEGIN SELECT RAISE(ABORT, 'a run''s build model is chosen when it starts and never changed'); END;
CREATE TABLE command_lists (
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'check')),
  round INTEGER NOT NULL CHECK (round >= 1),
  total INTEGER NOT NULL CHECK (total >= 0),
  started_at TEXT NOT NULL,
  PRIMARY KEY (task_id, kind, round)
);
CREATE TRIGGER command_lists_no_update BEFORE UPDATE ON command_lists
BEGIN SELECT RAISE(ABORT, 'command lists are append-only'); END;
CREATE TRIGGER command_lists_no_delete BEFORE DELETE ON command_lists
BEGIN SELECT RAISE(ABORT, 'command lists are append-only'); END;
`,
  },
  {
    // Delivery: a run is started with a choice of what becomes of each task it accepts, "branch" (the branch stays in
    // the repository, as before) or "pull_request" (Botbench pushes the branch and opens a pull request), fixed when the
    // run starts. A run of one task keeps its branch. `deliveries` is the ledger of each delivery, only ever added to:
    // the request, made after every check passed and before anything is sent; the push; the pull request opened or
    // found already there; or a failure in plain words. Rows exist only for accepted tasks, and at most one pull
    // request is ever recorded for a task. The action log gains a rule for each step, which names its task; a check
    // cannot be altered in place, so the log is made again with every row kept, as before.
    name: "deliveries",
    sql: `
ALTER TABLE runs ADD COLUMN delivery TEXT NOT NULL DEFAULT 'branch' CHECK (delivery IN ('branch', 'pull_request'));
CREATE TRIGGER runs_delivery_fixed BEFORE UPDATE OF delivery ON runs
BEGIN SELECT RAISE(ABORT, 'a run''s delivery is chosen when it starts and never changed'); END;
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  step TEXT NOT NULL CHECK (step IN ('requested', 'pushed', 'opened', 'failed')),
  requested_by TEXT CHECK (requested_by IN ('owner', 'run')),
  remote TEXT,
  repository TEXT,
  base TEXT,
  branch TEXT,
  head_commit TEXT,
  url TEXT,
  number INTEGER,
  adopted INTEGER CHECK (adopted IN (0, 1)),
  pr_state TEXT,
  failed_step TEXT CHECK (failed_step IN ('check', 'push', 'pull_request')),
  detail TEXT,
  created_at TEXT NOT NULL,
  CHECK ((step = 'requested') = (requested_by IS NOT NULL)),
  CHECK ((step = 'opened') = (url IS NOT NULL AND number IS NOT NULL AND adopted IS NOT NULL)),
  CHECK ((step = 'failed') = (failed_step IS NOT NULL AND detail IS NOT NULL))
);
CREATE INDEX deliveries_task ON deliveries (task_id, id);
CREATE TRIGGER deliveries_no_update BEFORE UPDATE ON deliveries
BEGIN SELECT RAISE(ABORT, 'deliveries are append-only'); END;
CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON deliveries
BEGIN SELECT RAISE(ABORT, 'deliveries are append-only'); END;
CREATE TRIGGER deliveries_accepted_only BEFORE INSERT ON deliveries
WHEN (SELECT status FROM tasks WHERE id = NEW.task_id) IS NOT 'accepted'
BEGIN SELECT RAISE(ABORT, 'only an accepted task is delivered'); END;
CREATE TRIGGER deliveries_one_pull_request BEFORE INSERT ON deliveries
WHEN NEW.step = 'opened' AND EXISTS (SELECT 1 FROM deliveries WHERE task_id = NEW.task_id AND step = 'opened')
BEGIN SELECT RAISE(ABORT, 'a task has at most one pull request'); END;
DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_deliveries;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted', 'delivery')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted', 'delivery') OR task_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id FROM action_log_before_deliveries ORDER BY id;
DROP TABLE action_log_before_deliveries;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // The refine loop: after a review with concerns the builder is given the review and asked to fix what it agrees
    // with, its work is committed and checked again, and the reviewer looks again. A run gains `max_refine_rounds`,
    // the cap on rounds of fixes, taken from the settings when it starts and never changed after (0 for runs from
    // before). A task now has one review per round, so `reviews` is made again with every row kept, ids included, as
    // round 1, gains the commit it reviewed (unknown for the rows kept), and its append-only triggers are put back.
    // `refinements`: one row per round of fixes that ended, after the review of the same round: the builder's attempt,
    // whether its turn finished, failed or was stopped by a cancel, whether it changed the work, the builder's reply,
    // the commit it started from and the one Botbench made after it, and the times. Rows are only ever added. What a
    // task's checks found may now change once more for each round of fixes that changed the work: the checks of that
    // commit, and no other change.
    name: "refine loop",
    sql: `
ALTER TABLE runs ADD COLUMN max_refine_rounds INTEGER NOT NULL DEFAULT 0 CHECK (max_refine_rounds BETWEEN 0 AND 5);
CREATE TRIGGER runs_refine_cap_fixed BEFORE UPDATE OF max_refine_rounds ON runs
BEGIN SELECT RAISE(ABORT, 'a run''s cap on rounds of fixes is set when it starts and never changed'); END;
DROP TRIGGER reviews_no_update;
DROP TRIGGER reviews_no_delete;
DROP TRIGGER reviews_task_reviewing;
ALTER TABLE reviews RENAME TO reviews_before_refine;
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  agent TEXT NOT NULL,
  model TEXT,
  attempt_id INTEGER REFERENCES attempts (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('reviewed', 'failed', 'timed_out', 'stopped')),
  verdict TEXT CHECK (verdict IN ('looks_right', 'concerns')),
  text TEXT NOT NULL,
  problem TEXT,
  head_commit TEXT,
  diff_chars INTEGER NOT NULL,
  diff_cut INTEGER NOT NULL CHECK (diff_cut IN (0, 1)),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  UNIQUE (task_id, round),
  CHECK ((outcome = 'reviewed') = (problem IS NULL)),
  CHECK (outcome = 'reviewed' OR verdict IS NULL)
);
INSERT INTO reviews (id, task_id, round, agent, model, attempt_id, outcome, verdict, text, problem, head_commit, diff_chars, diff_cut, started_at, ended_at, duration_ms)
  SELECT id, task_id, 1, agent, model, attempt_id, outcome, verdict, text, problem, NULL, diff_chars, diff_cut, started_at, ended_at, duration_ms FROM reviews_before_refine ORDER BY id;
DROP TABLE reviews_before_refine;
CREATE TRIGGER reviews_no_update BEFORE UPDATE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are append-only'); END;
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are append-only'); END;
CREATE TRIGGER reviews_task_reviewing BEFORE INSERT ON reviews
WHEN (SELECT status FROM tasks WHERE id = NEW.task_id) IS NOT 'reviewing'
BEGIN SELECT RAISE(ABORT, 'a review is stored only for a task at the review station'); END;
CREATE TABLE refinements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  round INTEGER NOT NULL CHECK (round >= 1),
  attempt_id INTEGER REFERENCES attempts (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('finished', 'failed', 'stopped')),
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  reply TEXT NOT NULL,
  problem TEXT,
  from_commit TEXT NOT NULL,
  head_commit TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  UNIQUE (task_id, round),
  CHECK ((outcome = 'finished') = (problem IS NULL))
);
DROP TRIGGER tasks_checks_once;
CREATE TRIGGER tasks_checks_once BEFORE UPDATE OF checks ON tasks WHEN OLD.checks IS NOT NULL AND NEW.checks IS NOT OLD.checks
  AND NOT EXISTS (SELECT 1 FROM refinements WHERE task_id = NEW.id AND changed = 1 AND head_commit = NEW.head_commit)
BEGIN SELECT RAISE(ABORT, 'what the checks found is recorded once for each version of the work'); END;
CREATE TRIGGER refinements_no_update BEFORE UPDATE ON refinements
BEGIN SELECT RAISE(ABORT, 'rounds of fixes are append-only'); END;
CREATE TRIGGER refinements_no_delete BEFORE DELETE ON refinements
BEGIN SELECT RAISE(ABORT, 'rounds of fixes are append-only'); END;
CREATE TRIGGER refinements_after_review BEFORE INSERT ON refinements
WHEN NOT EXISTS (SELECT 1 FROM reviews WHERE task_id = NEW.task_id AND round = NEW.round)
BEGIN SELECT RAISE(ABORT, 'a round of fixes follows the review of the same round'); END;
`,
  },
  {
    // A device stays signed in across restarts. Only the SHA-256 of a session's secret is kept, never the secret.
    name: "browser_sessions",
    sql: `
CREATE TABLE browser_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  device TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
  {
    // Intake: a GitHub issue read for the owner, kept as it was read and only ever added to, so a run started from it
    // is given exactly what the owner was shown. A run that read one names it and is marked as having read outside
    // text; `outside_hosts` is the owner's choice to let its commands reach the repository's allowed hosts all the same.
    // All three are set when the run starts and never changed, and a marked run is never fully autonomous. A run from an
    // issue with no message of the owner's own stores an empty prompt, which the runs table's check allows; no other run may.
    name: "issue_intake",
    sql: `
CREATE TABLE issue_fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  state TEXT NOT NULL,
  labels TEXT NOT NULL,
  body TEXT NOT NULL,
  comments TEXT NOT NULL,
  comment_count INTEGER NOT NULL,
  cut TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TRIGGER issue_fetches_no_update BEFORE UPDATE ON issue_fetches
BEGIN SELECT RAISE(ABORT, 'an issue is kept as it was read'); END;
CREATE TRIGGER issue_fetches_no_delete BEFORE DELETE ON issue_fetches
BEGIN SELECT RAISE(ABORT, 'an issue is kept as it was read'); END;
ALTER TABLE runs ADD COLUMN issue_fetch_id INTEGER REFERENCES issue_fetches (id);
ALTER TABLE runs ADD COLUMN outside_text INTEGER NOT NULL DEFAULT 0 CHECK (outside_text IN (0, 1));
ALTER TABLE runs ADD COLUMN outside_hosts INTEGER NOT NULL DEFAULT 0 CHECK (outside_hosts IN (0, 1));
CREATE TRIGGER runs_outside_fixed BEFORE UPDATE OF issue_fetch_id, outside_text, outside_hosts ON runs
BEGIN SELECT RAISE(ABORT, 'what a run read from outside is set when it starts and never changed'); END;
CREATE TRIGGER runs_issue_marked BEFORE INSERT ON runs
WHEN (NEW.issue_fetch_id IS NOT NULL AND NEW.outside_text = 0) OR (NEW.outside_text = 0 AND NEW.outside_hosts = 1)
BEGIN SELECT RAISE(ABORT, 'a run that read an issue is marked as having read outside text'); END;
CREATE TRIGGER runs_empty_prompt_issue_only BEFORE INSERT ON runs
WHEN NEW.prompt = '' AND NEW.issue_fetch_id IS NULL
BEGIN SELECT RAISE(ABORT, 'only a run started from an issue may have no message'); END;
CREATE TRIGGER runs_outside_not_full BEFORE INSERT ON runs
WHEN NEW.outside_text = 1 AND NEW.mode = 'full'
BEGIN SELECT RAISE(ABORT, 'a run that read outside text is never fully autonomous'); END;
`,
  },
  {
    // Chat with any agent (src/api/chat.ts). `chat_rounds`: one row per message the owner sent to agents that are given
    // the conversation by Botbench, or per request to compare a round's answers (`compares` names that round).
    // `chat_attempts`: every attempt a chat started, so only a chat's own text is ever passed on as its conversation;
    // `round_id` is null for a Claude Code session that kept the conversation itself. Both are append-only.
    name: "chat_rounds",
    sql: `
CREATE TABLE chat_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'compare')),
  message TEXT NOT NULL,
  compares INTEGER REFERENCES chat_rounds (id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'compare') = (compares IS NOT NULL))
);
CREATE TABLE chat_attempts (
  attempt_id INTEGER PRIMARY KEY REFERENCES attempts (id),
  round_id INTEGER REFERENCES chat_rounds (id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER chat_rounds_no_update BEFORE UPDATE ON chat_rounds
BEGIN SELECT RAISE(ABORT, 'chat rounds are append-only'); END;
CREATE TRIGGER chat_rounds_no_delete BEFORE DELETE ON chat_rounds
BEGIN SELECT RAISE(ABORT, 'chat rounds are append-only'); END;
CREATE TRIGGER chat_attempts_no_update BEFORE UPDATE ON chat_attempts
BEGIN SELECT RAISE(ABORT, 'chat attempts are append-only'); END;
CREATE TRIGGER chat_attempts_no_delete BEFORE DELETE ON chat_attempts
BEGIN SELECT RAISE(ABORT, 'chat attempts are append-only'); END;
`,
  },
  {
    // Notifications already sent for a task's or run's end (src/push.ts): one row per task or run and fixed text, so a
    // notification is sent once even across a restart. It holds no words of the task, only what the payload holds.
    name: "push_sent",
    sql: `
CREATE TABLE push_sent (
  subject TEXT NOT NULL CHECK (subject IN ('task', 'run')),
  subject_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (subject, subject_id, title)
);
`,
  },
  {
    // The workbench's names (src/workbench.ts): the name this installation's task branches carry, the latest row being
    // the one in use. Append-only, so every name it has had stays known as its own, and a branch made before a rename
    // is still recognised as this installation's.
    name: "workbench_names",
    sql: `
CREATE TABLE workbench_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30 AND name NOT GLOB '*[^a-z0-9-]*' AND name NOT GLOB '-*' AND name NOT GLOB '*-'),
  source TEXT NOT NULL CHECK (source IN ('host', 'owner', 'settings_file')),
  chosen_at TEXT NOT NULL
);
CREATE TRIGGER workbench_names_no_update BEFORE UPDATE ON workbench_names
BEGIN SELECT RAISE(ABORT, 'workbench names are append-only'); END;
CREATE TRIGGER workbench_names_no_delete BEFORE DELETE ON workbench_names
BEGIN SELECT RAISE(ABORT, 'workbench names are append-only'); END;
`,
  },
  {
    // A card says why its request asks (`asks_because`, one plain line) and, for a file tool, the file it is aimed at
    // (`target`: relative to the task's copy when inside it, a full path when not). Both are written with the approval
    // and never changed; an approval from before this has neither.
    name: "approval_reasons",
    sql: `
ALTER TABLE approvals ADD COLUMN asks_because TEXT;
ALTER TABLE approvals ADD COLUMN target TEXT;
CREATE TRIGGER approvals_reason_fixed BEFORE UPDATE OF asks_because, target ON approvals
BEGIN SELECT RAISE(ABORT, 'why an approval asks and what it is aimed at cannot be changed'); END;
`,
  },
  {
    // The first run of an installation (src/api/settings.ts, `firstRun`): the home screen's first-run lines show until
    // the first chat, task or run is stored. One row, written by the store itself the moment the first attempt, task or
    // run is inserted, whatever code path inserts it, and kept for good: deleting that chat, task or run later, or a
    // restart, never brings the lines back. An installation that already holds any of them is marked as it migrates.
    name: "first_use",
    sql: `
CREATE TABLE first_use (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL
);
INSERT INTO first_use (id, at) SELECT 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE EXISTS (SELECT 1 FROM attempts) OR EXISTS (SELECT 1 FROM tasks) OR EXISTS (SELECT 1 FROM runs);
CREATE TRIGGER first_use_by_attempt AFTER INSERT ON attempts WHEN NOT EXISTS (SELECT 1 FROM first_use)
BEGIN INSERT INTO first_use (id, at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER first_use_by_task AFTER INSERT ON tasks WHEN NOT EXISTS (SELECT 1 FROM first_use)
BEGIN INSERT INTO first_use (id, at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER first_use_by_run AFTER INSERT ON runs WHEN NOT EXISTS (SELECT 1 FROM first_use)
BEGIN INSERT INTO first_use (id, at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER first_use_no_update BEFORE UPDATE ON first_use
BEGIN SELECT RAISE(ABORT, 'first use is kept: it is never changed'); END;
CREATE TRIGGER first_use_no_delete BEFORE DELETE ON first_use
BEGIN SELECT RAISE(ABORT, 'first use is kept: it is never deleted'); END;
`,
  },
  {
    // A chat's Claude Code asks through the same broker as a task's builder (src/api/turns.ts). An approval belongs to
    // a task, a run's planner or a chat (`chat` = 1), exactly one of the three. The action log gains the rules for a web
    // tool of a chat decided by the owner's setting "Web access in chat" (`chat_web_access`) and for a chat's confined
    // command that ran without asking (`chat_confined`); the setting `owner_settings` now
    // keeps beside the default mode. A check cannot be altered in place, so the three tables are made again with every
    // row kept, ids included, and their indexes and triggers put back.
    name: "chat approvals",
    sql: `
ALTER TABLE approvals RENAME TO approvals_before_chat;
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks (id),
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
  resolved_at TEXT,
  parked_at TEXT,
  stored_decision TEXT CHECK (stored_decision IN ('allow', 'decline')),
  stored_at TEXT,
  run_id INTEGER REFERENCES runs (id),
  asks_because TEXT,
  target TEXT,
  chat INTEGER NOT NULL DEFAULT 0 CHECK (chat IN (0, 1)),
  CHECK ((task_id IS NOT NULL) + (run_id IS NOT NULL) + chat = 1)
);
INSERT INTO approvals (id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, note, created_at, resolved_at, parked_at, stored_decision, stored_at, run_id, asks_because, target)
  SELECT id, task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, note, created_at, resolved_at, parked_at, stored_decision, stored_at, run_id, asks_because, target FROM approvals_before_chat ORDER BY id;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_chat;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted', 'delivery', 'chat_web_access', 'chat_confined')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted', 'delivery') OR task_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id FROM action_log_before_chat ORDER BY id;
DROP TABLE action_log_before_chat;
DROP TABLE approvals_before_chat;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;

CREATE INDEX approvals_status ON approvals (status, id);
CREATE INDEX approvals_task ON approvals (task_id, status);
CREATE INDEX approvals_run ON approvals (run_id, status);
CREATE TRIGGER approvals_answered_once BEFORE UPDATE ON approvals WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'this approval is already answered'); END;
CREATE TRIGGER approvals_request_fixed BEFORE UPDATE OF id, task_id, run_id, chat, attempt_id, role, tool, command, cwd, reason, tool_call_id, created_at ON approvals
BEGIN SELECT RAISE(ABORT, 'what an approval asks for cannot be changed'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;
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
CREATE TRIGGER approvals_reason_fixed BEFORE UPDATE OF asks_because, target ON approvals
BEGIN SELECT RAISE(ABORT, 'why an approval asks and what it is aimed at cannot be changed'); END;
CREATE TRIGGER approvals_chat_not_stored BEFORE UPDATE OF stored_decision ON approvals WHEN OLD.chat = 1
BEGIN SELECT RAISE(ABORT, 'a chat''s approval is never answered for a later start'); END;

ALTER TABLE owner_settings RENAME TO owner_settings_before_chat;
CREATE TABLE owner_settings (
  name TEXT PRIMARY KEY CHECK (name IN ('default_mode', 'chat_web_access')),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (name <> 'default_mode' OR value IN ('manual', 'semi', 'full')),
  CHECK (name <> 'chat_web_access' OR value IN ('allow', 'ask', 'off'))
);
INSERT INTO owner_settings (name, value, updated_at) SELECT name, value, updated_at FROM owner_settings_before_chat;
DROP TABLE owner_settings_before_chat;
`,
  },
  {
    // How an issue's author relates to its repository, as GitHub's author_association said when it was read; null when
    // it did not say, and for an issue read before this. Kept with the rest of the issue as read, never changed (the
    // table's triggers), and shown to the owner only: a run from the issue is marked as outside text whatever it says.
    name: "issue_author_relation",
    sql: `
ALTER TABLE issue_fetches ADD COLUMN author_relation TEXT CHECK (author_relation IN ('OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE'));
`,
  },
  {
    // What kind of request a fully autonomous run refused (`refusal`, src/approvals/refusals.ts), written with its
    // `mode_refused` entry and on no other: whether it blocks the accept is read from it. An entry from before this has
    // none and blocks, as every refusal did. And a run may be kept to one task (`one_task`), chosen when it starts and
    // never changed after, like its mode.
    name: "refusal_kinds_and_one_task",
    sql: `
ALTER TABLE action_log ADD COLUMN refusal TEXT CHECK (refusal IS NULL OR (rule = 'mode_refused' AND refusal IN ('floor', 'network', 'outside_copy', 'unconfined', 'read_only', 'other')));
ALTER TABLE runs ADD COLUMN one_task INTEGER NOT NULL DEFAULT 0 CHECK (one_task IN (0, 1));
CREATE TRIGGER runs_one_task_fixed BEFORE UPDATE OF one_task ON runs
BEGIN SELECT RAISE(ABORT, 'whether a run is kept to one task is chosen when it starts and never changed'); END;
`,
  },
  {
    // Approvals are for actions and changes, not for using a tool (src/approvals/gate.ts). The owner's settings gain "Ask
    // before every command" (`ask_every_command`, on or off), which brings back a card for every command of a manual
    // run or a task started on its own. The action log gains the rules for a web tool of a task or a run decided by the
    // owner's setting Web access: run without asking (`web_allowed`) or refused because it is off (`web_refused`); and
    // one of the CLI's own bookkeeping tools that ran (`bookkeeping`), as every agent action that ran is logged.
    // A check cannot be altered in place, so both tables are made again with every row kept, ids included, and the
    // log's indexes and triggers put back.
    name: "approvals for actions",
    sql: `
DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_actions;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted', 'delivery', 'chat_web_access', 'chat_confined', 'web_allowed', 'web_refused', 'bookkeeping')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  refusal TEXT CHECK (refusal IS NULL OR (rule = 'mode_refused' AND refusal IN ('floor', 'network', 'outside_copy', 'unconfined', 'read_only', 'other'))),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted', 'delivery') OR task_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal FROM action_log_before_actions ORDER BY id;
DROP TABLE action_log_before_actions;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;

ALTER TABLE owner_settings RENAME TO owner_settings_before_actions;
CREATE TABLE owner_settings (
  name TEXT PRIMARY KEY CHECK (name IN ('default_mode', 'chat_web_access', 'ask_every_command')),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (name <> 'default_mode' OR value IN ('manual', 'semi', 'full')),
  CHECK (name <> 'chat_web_access' OR value IN ('allow', 'ask', 'off')),
  CHECK (name <> 'ask_every_command' OR value IN ('on', 'off'))
);
INSERT INTO owner_settings (name, value, updated_at) SELECT name, value, updated_at FROM owner_settings_before_actions;
DROP TABLE owner_settings_before_actions;
`,
  },
  {
    // Claiming an issue on the shared remote (Peers P3, engine/claims.ts), step by step for a run, append-only: the
    // commit Botbench made for the claim, stored before it is pushed (`claiming`), so a restart finds a push it never saw
    // end; the branches pushed with it (`claimed`), a claim that could not be made or was not to be made, and why
    // (`not_claimed`), a claim given up because another workbench holds the issue's lock (`withdrawn`, naming it), and
    // when the run ended without a pull request, the branches deleted (`released`) or left on the remote and why
    // (`kept`). A run claims at most once. `claim_takeovers`: another workbench's old claim the owner chose, after a confirm naming
    // its holder, not to give way to; stored with the run, before its claim. The action log gains `issue_claim`, one
    // entry per step that wrote to the remote or released a claim. A check cannot be altered in place, so the action
    // log is made again with every row kept, ids included, and its indexes and triggers put back.
    name: "issue_claims",
    sql: `
CREATE TABLE issue_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  step TEXT NOT NULL CHECK (step IN ('claiming', 'claimed', 'not_claimed', 'withdrawn', 'released', 'kept')),
  issue INTEGER NOT NULL CHECK (issue >= 1),
  remote TEXT,
  branch TEXT,
  commit_id TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((step = 'not_claimed') OR (remote IS NOT NULL AND branch IS NOT NULL AND commit_id IS NOT NULL))
);
CREATE INDEX issue_claims_run ON issue_claims (run_id, id);
CREATE UNIQUE INDEX issue_claims_once ON issue_claims (run_id) WHERE step IN ('claimed', 'not_claimed');
CREATE TRIGGER issue_claims_no_update BEFORE UPDATE ON issue_claims
BEGIN SELECT RAISE(ABORT, 'issue claims are append-only'); END;
CREATE TRIGGER issue_claims_no_delete BEFORE DELETE ON issue_claims
BEGIN SELECT RAISE(ABORT, 'issue claims are append-only'); END;

CREATE TABLE claim_takeovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  branch TEXT NOT NULL,
  holder TEXT NOT NULL,
  issue INTEGER NOT NULL CHECK (issue >= 1),
  started_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, branch)
);
CREATE TRIGGER claim_takeovers_no_update BEFORE UPDATE ON claim_takeovers
BEGIN SELECT RAISE(ABORT, 'claim take-overs are append-only'); END;
CREATE TRIGGER claim_takeovers_no_delete BEFORE DELETE ON claim_takeovers
BEGIN SELECT RAISE(ABORT, 'claim take-overs are append-only'); END;

DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_claims;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted', 'delivery', 'chat_web_access', 'chat_confined', 'web_allowed', 'web_refused', 'bookkeeping', 'issue_claim')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  refusal TEXT CHECK (refusal IS NULL OR (rule = 'mode_refused' AND refusal IN ('floor', 'network', 'outside_copy', 'unconfined', 'read_only', 'other'))),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted', 'delivery') OR task_id IS NOT NULL),
  CHECK (rule <> 'issue_claim' OR run_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal FROM action_log_before_claims ORDER BY id;
DROP TABLE action_log_before_claims;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // Checking a task together with another workbench's open pull request (engine/combined.ts, Peers P4). One row per
    // check, written once with everything it found: the two head commits it ran on, whether they merged and, when not,
    // the files in conflict, and each setup and check command run on the merge with its output. Both tables are
    // append-only: a result is never changed, only followed by a newer one.
    //
    // "Require checking together" for a repository is a list of the owner's changes, append-only, the latest in force.
    // Every row is the owner's (`set_by`): nothing else writes this table (the API's owner-only route does).
    name: "combined_checks",
    sql: `
CREATE TABLE combined_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  pull_request INTEGER NOT NULL CHECK (pull_request BETWEEN 1 AND 2147483647),
  workbench TEXT NOT NULL,
  peer_branch TEXT NOT NULL,
  peer_commit TEXT CHECK (peer_commit IS NULL OR length(peer_commit) IN (40, 64)),
  task_commit TEXT NOT NULL CHECK (length(task_commit) IN (40, 64)),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'conflict', 'not_run')),
  conflicts TEXT NOT NULL DEFAULT '[]',
  problem TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  CHECK (outcome = 'not_run' OR peer_commit IS NOT NULL),
  CHECK (outcome <> 'not_run' OR problem IS NOT NULL)
);
CREATE INDEX combined_checks_task ON combined_checks (task_id, id);
CREATE TABLE combined_check_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  combined_check_id INTEGER NOT NULL REFERENCES combined_checks (id),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'check')),
  position INTEGER NOT NULL,
  command TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'timed_out', 'stopped')),
  exit_code INTEGER,
  signal TEXT,
  output TEXT NOT NULL,
  output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
  limit_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX combined_check_commands_check ON combined_check_commands (combined_check_id, id);
CREATE TRIGGER combined_checks_no_update BEFORE UPDATE ON combined_checks
BEGIN SELECT RAISE(ABORT, 'a combined check is kept as it ran'); END;
CREATE TRIGGER combined_checks_no_delete BEFORE DELETE ON combined_checks
BEGIN SELECT RAISE(ABORT, 'a combined check is kept as it ran'); END;
CREATE TRIGGER combined_check_commands_no_update BEFORE UPDATE ON combined_check_commands
BEGIN SELECT RAISE(ABORT, 'a combined check is kept as it ran'); END;
CREATE TRIGGER combined_check_commands_no_delete BEFORE DELETE ON combined_check_commands
BEGIN SELECT RAISE(ABORT, 'a combined check is kept as it ran'); END;

CREATE TABLE combined_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  set_by TEXT NOT NULL CHECK (set_by = 'owner'),
  set_at TEXT NOT NULL
);
CREATE INDEX combined_requirements_repo ON combined_requirements (repo_path, id);
CREATE TRIGGER combined_requirements_no_update BEFORE UPDATE ON combined_requirements
BEGIN SELECT RAISE(ABORT, 'the owner''s changes to require checking together are append-only'); END;
CREATE TRIGGER combined_requirements_no_delete BEFORE DELETE ON combined_requirements
BEGIN SELECT RAISE(ABORT, 'the owner''s changes to require checking together are append-only'); END;
`,
  },
  {
    // Codex and Grok have their own tools in a chat and a review and cannot ask before they act (threat model, B18):
    // each tool call they report is logged as one that ran without asking under the agent's own sandbox (`sandboxed`),
    // as every agent action that ran is logged. A check cannot be altered in place, so the action log is made again
    // with every row kept, ids included, and its indexes and triggers put back.
    name: "sandboxed agent calls in the log",
    sql: `
DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_sandboxed;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted', 'delivery', 'chat_web_access', 'chat_confined', 'web_allowed', 'web_refused', 'bookkeeping', 'issue_claim', 'sandboxed')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  refusal TEXT CHECK (refusal IS NULL OR (rule = 'mode_refused' AND refusal IN ('floor', 'network', 'outside_copy', 'unconfined', 'read_only', 'other'))),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted', 'delivery') OR task_id IS NOT NULL),
  CHECK (rule <> 'issue_claim' OR run_id IS NOT NULL)
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal FROM action_log_before_sandboxed ORDER BY id;
DROP TABLE action_log_before_sandboxed;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // A task whose builder's turn ended on its agent's usage limit waits at `waiting_for_limit` until `retry_at` (an ISO
    // time), when Botbench resumes its session once (engine/usage-limit.ts). Kept in the store, not only in a timer, so
    // a restart keeps the wait; empty for every other task, and for every task from before this.
    name: "usage_limit_wait",
    sql: `
ALTER TABLE tasks ADD COLUMN retry_at TEXT;
`,
  },
  {
    // The workbench memory store (engine/memory.ts, ADR 0006) keeps its notes as files under the data folder, not here.
    // The action log gains `memory`: one entry per write the owner made to it (remember, edit, forget), naming the note
    // by its number and holding none of its text, and belonging to no task or run. A check cannot be altered in place,
    // so the action log is made again with every row kept, ids included, and its indexes and triggers put back.
    name: "memory_log",
    sql: `
DROP TRIGGER action_log_no_update;
DROP TRIGGER action_log_no_delete;
DROP INDEX action_log_task;
DROP INDEX action_log_grant;
DROP INDEX action_log_approval;
ALTER TABLE action_log RENAME TO action_log_before_memory;
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks (id),
  attempt_id INTEGER REFERENCES attempts (id),
  approval_id INTEGER REFERENCES approvals (id),
  rule TEXT NOT NULL CHECK (rule IN ('asked_owner', 'owner_allowed', 'owner_declined', 'ended_unanswered', 'auto_worktree_edit', 'broker_failure_denied', 'stored_answer_applied', 'stored_answer_discarded', 'preapproved', 'standing', 'standing_granted', 'standing_revoked', 'owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_allowed', 'mode_refused', 'mode_accepted', 'delivery', 'chat_web_access', 'chat_confined', 'web_allowed', 'web_refused', 'bookkeeping', 'issue_claim', 'sandboxed', 'memory')),
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  detail TEXT,
  grant_id INTEGER REFERENCES grants (id),
  run_id INTEGER REFERENCES runs (id),
  refusal TEXT CHECK (refusal IS NULL OR (rule = 'mode_refused' AND refusal IN ('floor', 'network', 'outside_copy', 'unconfined', 'read_only', 'other'))),
  CHECK (rule NOT IN ('preapproved', 'standing', 'standing_granted', 'standing_revoked') OR grant_id IS NOT NULL),
  CHECK (rule NOT IN ('owner_accepted', 'owner_rejected', 'owner_discarded', 'mode_accepted', 'delivery') OR task_id IS NOT NULL),
  CHECK (rule <> 'issue_claim' OR run_id IS NOT NULL),
  CHECK (rule <> 'memory' OR (task_id IS NULL AND run_id IS NULL))
);
INSERT INTO action_log (id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal)
  SELECT id, ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail, grant_id, run_id, refusal FROM action_log_before_memory ORDER BY id;
DROP TABLE action_log_before_memory;
CREATE INDEX action_log_task ON action_log (task_id, id);
CREATE INDEX action_log_grant ON action_log (grant_id, rule);
CREATE INDEX action_log_approval ON action_log (approval_id, rule);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
`,
  },
  {
    // An owner's note to a task that is building (src/engine/notes.ts): its task, its words and when it was sent, and how
    // it stands: `waiting` for the builder's turn to end, `delivered` as the next message of the session in `attempt_id`,
    // `replaced` by a later note before it was delivered, or `not_delivered` with a plain `reason`. One note waits for a
    // task at a time. A row is only ever added, leaves waiting once with what that change says (`settled_at`, and the
    // attempt or the reason), and is never changed after or deleted, so every note the owner sent stays known.
    name: "task_notes",
    sql: `
CREATE TABLE task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0 AND length(text) <= 4000),
  sent_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered', 'replaced', 'not_delivered')),
  attempt_id INTEGER REFERENCES attempts (id),
  reason TEXT,
  settled_at TEXT,
  CHECK ((state = 'waiting') = (settled_at IS NULL)),
  CHECK ((state = 'delivered') = (attempt_id IS NOT NULL)),
  CHECK ((state = 'not_delivered') = (reason IS NOT NULL))
);
CREATE INDEX task_notes_task ON task_notes (task_id, id);
CREATE UNIQUE INDEX task_notes_one_waiting ON task_notes (task_id) WHERE state = 'waiting';
CREATE TRIGGER task_notes_written_waiting BEFORE INSERT ON task_notes WHEN NEW.state <> 'waiting'
BEGIN SELECT RAISE(ABORT, 'a note is first written as waiting'); END;
CREATE TRIGGER task_notes_words_fixed BEFORE UPDATE OF id, task_id, text, sent_at ON task_notes
BEGIN SELECT RAISE(ABORT, 'what a note says, its task and when it was sent cannot be changed'); END;
CREATE TRIGGER task_notes_settled_once BEFORE UPDATE OF state, attempt_id, reason, settled_at ON task_notes WHEN OLD.state <> 'waiting' OR NEW.state = 'waiting'
BEGIN SELECT RAISE(ABORT, 'a note leaves waiting once, and is never changed after'); END;
CREATE TRIGGER task_notes_no_delete BEFORE DELETE ON task_notes
BEGIN SELECT RAISE(ABORT, 'notes are never deleted'); END;
`,
  },
  {
    // The lists' own state, per installation (src/api/board.ts, src/engine/chats.ts). `chat_members`: which chat each
    // chat attempt belongs to, a chat being named by its first attempt (`chat_id`), recorded as each message is sent;
    // append-only, like the chat itself. `chat_titles`: the name the owner gave a chat, one line, trimmed, at most 80
    // characters; no row means the chat is called by its first message. `hidden_rows`: a run, a task or a chat the owner
    // hid from the Work list. Renaming, hiding and showing change only these two tables: no run, task, chat, branch or
    // copy is changed or deleted by them. This migration adds its own tables and changes no other.
    name: "list_rows",
    sql: `
CREATE TABLE chat_members (
  attempt_id INTEGER PRIMARY KEY REFERENCES chat_attempts (attempt_id),
  chat_id INTEGER NOT NULL REFERENCES chat_attempts (attempt_id),
  created_at TEXT NOT NULL
);
CREATE INDEX chat_members_chat ON chat_members (chat_id, attempt_id);
CREATE TRIGGER chat_members_no_update BEFORE UPDATE ON chat_members
BEGIN SELECT RAISE(ABORT, 'chat members are append-only'); END;
CREATE TRIGGER chat_members_no_delete BEFORE DELETE ON chat_members
BEGIN SELECT RAISE(ABORT, 'chat members are append-only'); END;

CREATE TABLE chat_titles (
  chat_id INTEGER PRIMARY KEY REFERENCES chat_attempts (attempt_id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80 AND title = trim(title) AND instr(title, char(10)) = 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE hidden_rows (
  kind TEXT NOT NULL CHECK (kind IN ('run', 'task', 'chat')),
  item_id INTEGER NOT NULL CHECK (item_id >= 1),
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
`,
  },
  {
    // Adding a device with a one-time code (src/api/pairing.ts): at most one pairing, the one Settings made last. It holds
    // the SHA-256 of the code, never the code. `used_at` is set by the one sign-in it opened, so a second try is told the
    // code was used; `replaced_hash` is the code this one cancelled, so that code is told it was replaced. The row goes
    // once it has expired.
    name: "device_pairing",
    sql: `
CREATE TABLE device_pairing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  replaced_hash TEXT CHECK (replaced_hash IS NULL OR length(replaced_hash) = 64)
);
`,
  },
];
