import type { DatabaseSync } from "node:sqlite";
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

export type PeerRule = "peer_invite" | "peer_pairing" | "peer_protocol" | "peer_refused";

export interface PeerLogRow {
  rule: PeerRule;
  /** The step, short: "invite made", "pair request accepted", "end notice sent". */
  command: string;
  /** What happened, as a sentence. */
  detail: string;
  /** The pairing whose peer caused this; the owner (or Botbench itself) when absent. */
  byPeer?: Pairing;
  at?: Date;
}

export function logPeer(db: DatabaseSync, row: PeerLogRow): void {
  const at = (row.at ?? new Date()).toISOString();
  const p = row.byPeer;
  db.prepare(
    "INSERT INTO action_log (ts, task_id, run_id, attempt_id, rule, tool, command, cwd, detail, asked_by, asked_by_pairing_id, asked_by_peer_name, asked_by_peer_fingerprint) VALUES (?, NULL, NULL, NULL, ?, 'peer', ?, '', ?, ?, ?, ?, ?)",
  ).run(at, row.rule, row.command, row.detail, p === undefined ? "owner" : "peer", p?.id ?? null, p?.peerName ?? null, p?.peerFingerprint ?? null);
}
