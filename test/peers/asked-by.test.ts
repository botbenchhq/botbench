import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";

const T = "2026-11-22T10:00:00.000Z";

test("the peers migration keeps every approval and action-log row, ids included, and each reads as asked by the owner", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-asked-by-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "botbench.sqlite"));
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
  const peers = MIGRATIONS.findIndex((m) => m.name === "peers messages store");
  assert.ok(peers > 0);
  migrate(db, MIGRATIONS.slice(0, peers));
  // Rows as the release before it wrote them.
  db.prepare("INSERT INTO attempts (id, driver, status, created_at, updated_at) VALUES (1, 'claude-code', 'running', ?, ?)").run(T, T);
  db.prepare("INSERT INTO approvals (id, chat, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at) VALUES (7, 1, 1, 'chat', 'Bash', 'npm test', '/tmp', 'call-1', 'pending', ?)").run(T);
  db.prepare("INSERT INTO action_log (id, ts, attempt_id, approval_id, rule, tool, command, cwd) VALUES (41, ?, 1, 7, 'asked_owner', 'Bash', 'npm test', '/tmp')").run(T);
  db.prepare("INSERT INTO action_log (id, ts, rule, tool, command, cwd, detail) VALUES (42, ?, 'memory', 'memory', 'remember note-1', '/tmp', 'remembered')").run(T);

  migrate(db, MIGRATIONS);
  assert.deepEqual(db.prepare("SELECT id, asked_by, asked_by_pairing_id, asked_by_peer_name, asked_by_peer_fingerprint FROM approvals").all().map((r) => ({ ...r })), [{ id: 7, asked_by: "owner", asked_by_pairing_id: null, asked_by_peer_name: null, asked_by_peer_fingerprint: null }]);
  assert.deepEqual(db.prepare("SELECT id, rule, asked_by, asked_by_pairing_id FROM action_log ORDER BY id").all().map((r) => ({ ...r })), [
    { id: 41, rule: "asked_owner", asked_by: "owner", asked_by_pairing_id: null },
    { id: 42, rule: "memory", asked_by: "owner", asked_by_pairing_id: null },
  ]);
  // The log is still append-only, and a new row is the owner's unless it says otherwise.
  assert.throws(() => db.exec("UPDATE action_log SET asked_by = 'agent'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM action_log"), /append-only/);
  db.prepare("INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES (?, 'bookkeeping', 'TodoWrite', '', '/tmp')").run(T);
  assert.equal(db.prepare("SELECT asked_by FROM action_log ORDER BY id DESC LIMIT 1").get()!.asked_by, "owner");

  // Who asked is whole: a peer comes with its pairing, name and fingerprint, and the owner or the agent with none.
  const pairing = "00000000-0000-4000-8000-000000000001";
  db.prepare("INSERT INTO peer_invites (id, secret, repository, created_at, expires_at, state) VALUES ('00000000-0000-4000-8000-000000000009', randomblob(32), 'r', ?, ?, 'open')").run(T, T);
  db.prepare(
    "INSERT INTO peer_pairings (id, role, invite_id, pairing_key, request_digest, own_key, peer_key, peer_name, peer_fingerprint, peer_address, repository, created_at) VALUES (?, 'inviter', '00000000-0000-4000-8000-000000000009', ?, ?, ?, ?, 'bob', '0000 0000 0000 0000 0000', '127.0.0.1:1', 'r', ?)",
  ).run(pairing, "a".repeat(64), "b".repeat(64), "A".repeat(43), "B".repeat(43), T);
  const approval = (askedBy: string, pairingId: string | null, name: string | null): void => {
    db.prepare("INSERT INTO approvals (chat, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at, asked_by, asked_by_pairing_id, asked_by_peer_name, asked_by_peer_fingerprint) VALUES (1, 1, 'chat', 'Bash', 'ls', '/tmp', ?, 'pending', ?, ?, ?, ?, ?)").run(`call-${Math.random()}`, T, askedBy, pairingId, name, name === null ? null : "0000 0000 0000 0000 0000");
  };
  approval("peer", pairing, "bob");
  approval("agent", null, null);
  assert.throws(() => approval("peer", null, null), /who asked is the owner, the agent, or a peer/);
  assert.throws(() => approval("owner", pairing, "bob"), /who asked is the owner, the agent, or a peer/);
  assert.throws(() => approval("someone", null, null), /CHECK constraint/);
  assert.throws(() => db.exec("UPDATE approvals SET asked_by = 'owner' WHERE asked_by = 'peer'"), /who asked for an approval cannot be changed/);
  assert.throws(() => db.prepare("INSERT INTO action_log (ts, rule, tool, command, cwd, asked_by) VALUES (?, 'bookkeeping', 'x', '', '/tmp', 'peer')").run(T), /CHECK constraint/);
  assert.throws(() => db.prepare("INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES (?, 'peer_message_conflict', 'peer', '', '')").run(T), /CHECK constraint/);
});
