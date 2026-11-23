import type { DatabaseSync } from "node:sqlite";
import { askedByFor, askedByValues, OWNER, type AskedBy } from "./asked-by.ts";
import type { Pairing } from "./pairings.ts";

/*
 * Pairing's rows in the append-only action log (Peers P5, ADR 0004 decision 9 and the brief of #154's second unit):
 * every invite made, withdrawn or expired, every pair request taken or refused, each confirmation, each end, the
 * fixed-shape traffic sent without a Send, and what the peer listener refused. A row never holds an invite's secret or
 * the invite text; it names an invite by its id.
 *
 * Who asked: the owner for the owner's own steps (an invite, a confirmation, End pairing) and for Botbench's own sweep;
 * the peer, with its pairing, name and fingerprint as they are now, for what a paired workbench's traffic caused. A
 * caller with no pairing is no peer the log can name (decision 10 knows only owner, agent and peer): its rows are
 * Botbench's refusal, kept with the default `owner`, and the detail says where the request came from.
 */

export type PeerRule = "peer_invite" | "peer_pairing" | "peer_protocol" | "peer_refused" | "peer_message" | "peer_kind_refused" | "peer_send_attempt" | "peer_send_over_limit" | "peer_settings";

export interface PeerLogRow {
  rule: PeerRule;
  /** The step, short: "invite made", "pair request accepted", "end notice sent". */
  command: string;
  /** What happened, as a sentence. */
  detail: string;
  /** The pairing whose peer caused this; the owner (or Botbench itself) when absent. */
  byPeer?: Pairing;
  /** Who asked, when it is neither the owner nor `byPeer`: this workbench's agent, for its draft (src/peers/asked-by.ts). */
  asked?: AskedBy;
  /** The task, run or attempt the row is about (an agent's draft). Their run, when given a peer's message, names that peer. */
  taskId?: number | null;
  runId?: number | null;
  attemptId?: number | null;
  at?: Date;
}

export function logPeer(db: DatabaseSync, row: PeerLogRow): void {
  const at = (row.at ?? new Date()).toISOString();
  const p = row.byPeer;
  const given: AskedBy = p === undefined ? (row.asked ?? OWNER) : { by: "peer", pairingId: p.id, peerName: p.peerName, peerFingerprint: p.peerFingerprint };
  const taskId = row.taskId ?? null;
  const runId = row.runId ?? null;
  db.prepare(
    "INSERT INTO action_log (ts, task_id, run_id, attempt_id, rule, tool, command, cwd, detail, asked_by, asked_by_pairing_id, asked_by_peer_name, asked_by_peer_fingerprint) VALUES (?, ?, ?, ?, ?, 'peer', ?, '', ?, ?, ?, ?, ?)",
  ).run(at, taskId, runId, row.attemptId ?? null, row.rule, row.command, row.detail, ...askedByValues(askedByFor(db, taskId, runId, given)));
}
