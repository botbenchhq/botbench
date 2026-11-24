import type { DatabaseSync } from "node:sqlite";
import { insertEvidence, nextRound, startCommandList, type CommandOutcome, type CommandRun } from "../../src/engine/stations.ts";

/**
 * Store one finished round of one check command on a task, with the functions the engine stores it with
 * (`startCommandList`, `insertEvidence`), for a test that puts a task at Ready for review without running the build
 * line. `commit` is the commit the round ran on; null stores a result whose commit is not known. Returns the round.
 */
export function storeChecks(db: DatabaseSync, taskId: number, commit: string | null, outcome: CommandOutcome = "passed", command = "npm test"): number {
  const round = nextRound(db, taskId, "check");
  startCommandList(db, taskId, "check", round, 1);
  const run: CommandRun = { command, outcome, exitCode: outcome === "passed" ? 0 : 1, signal: null, output: outcome === "passed" ? "ok\n" : "1 failing\n", truncated: false, limitMs: 600_000, startedAt: "2026-11-23T10:00:00.000Z", endedAt: "2026-11-23T10:00:01.000Z", durationMs: 1000 };
  insertEvidence(db, taskId, "check", 1, run, round, null, commit);
  return round;
}
