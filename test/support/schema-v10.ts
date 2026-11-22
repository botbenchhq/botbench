// The version 10 schema exactly as unit 12 shipped it, read back from a database that release made (sqlite_schema, in
// order). A database created by that release must still open.
export const V10_SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (10);
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
, requested_model TEXT);
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
`;
