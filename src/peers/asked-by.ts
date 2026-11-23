import type { DatabaseSync } from "node:sqlite";

/*
 * Who asked (Peers P5, ADR 0004 decision 10), for every approval and action-log row. Rows of a run the owner gave a
 * peer's message to name that peer, with the pairing and the peer's name and fingerprint as they were when the run
 * started (`runs.peer_*`); a trigger refuses any such row that names someone else (store/schema.ts, "peer messages").
 *
 * The narrowest reading of the ADR, chosen in the third unit: `peer` for everything work given a peer's message causes;
 * `agent` only for a row that records this workbench's agent reaching toward a peer of its own accord, which is its
 * draft of a message (`peer_send_attempt`, `peer_send_over_limit`, and the rows of its card) in work no peer's message
 * started; `owner` for everything else, including what an agent asks while it works on what the owner started.
 */

export interface AskedBy {
  by: "owner" | "agent" | "peer";
  pairingId: string | null;
  peerName: string | null;
  peerFingerprint: string | null;
}

export const OWNER: AskedBy = { by: "owner", pairingId: null, peerName: null, peerFingerprint: null };
export const AGENT: AskedBy = { by: "agent", pairingId: null, peerName: null, peerFingerprint: null };

/** The peer whose message the run (or the task's run) was given; null when it was given none. */
export function peerOfWork(db: DatabaseSync, taskId: number | null, runId: number | null | undefined): AskedBy | null {
  const run = runId ?? (taskId === null ? null : (db.prepare("SELECT run_id FROM tasks WHERE id = ?").get(taskId)?.run_id ?? null));
  if (run === null || run === undefined) return null;
  const row = db.prepare("SELECT peer_pairing_id, peer_name, peer_fingerprint FROM runs WHERE id = ?").get(run);
  if (row === undefined || row.peer_pairing_id == null) return null;
  return { by: "peer", pairingId: String(row.peer_pairing_id), peerName: String(row.peer_name), peerFingerprint: String(row.peer_fingerprint) };
}

/** Who asked for a row of this task or run: its peer when it was given a peer's message, else `otherwise`. */
export const askedByFor = (db: DatabaseSync, taskId: number | null, runId: number | null | undefined, otherwise: AskedBy = OWNER): AskedBy => peerOfWork(db, taskId, runId) ?? otherwise;

/** The four columns, in the order the INSERTs list them. */
export const askedByValues = (a: AskedBy): [string, string | null, string | null, string | null] => [a.by, a.pairingId, a.peerName, a.peerFingerprint];
