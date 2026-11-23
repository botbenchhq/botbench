import assert from "node:assert/strict";
import test from "node:test";
import { roundLabel } from "../web/src/components/command-rounds.ts";
import type { Evidence } from "../web/src/api/client.ts";

// What an earlier time a task's list of commands ran is called on its screen. Run 3 of the self-review labelled the
// checks before each round of fixes "Checks before Botbench restarted", though nothing had restarted.

const row = (round: number, position: number, outcome: Evidence["outcome"], kind: Evidence["kind"] = "check"): Evidence => ({ id: round * 10 + position, kind, round, position, command: `c${position}`, outcome, exitCode: outcome === "failed" ? 1 : 0, signal: null, output: "", truncated: false, limitMs: 1000, startedAt: "", endedAt: "", durationMs: 1, needs: null });
const lists = (rounds: number[], total = 2) => rounds.map((round) => ({ kind: "check" as const, round, total }));

test("earlier rounds of checks are named by the build or round of fixes they checked, and a round a restart cut short says so", () => {
  // First checks, then after round 1 and round 2 of fixes: the latest is shown open, the two before it are named.
  const fixes = [row(1, 1, "failed"), row(1, 2, "passed"), row(2, 1, "failed"), row(2, 2, "passed"), row(3, 1, "passed"), row(3, 2, "passed")];
  assert.equal(roundLabel(fixes, lists([1, 2, 3]), 1, "check"), "Checks of the first build");
  assert.equal(roundLabel(fixes, lists([1, 2, 3]), 2, "check"), "Checks after round 1 of fixes");
  assert.equal(roundLabel(fixes, lists([1, 2, 3]), 3, "check"), "Checks after round 2 of fixes");
  // Checks rerun after a real restart: the round cut short is not counted as a build's checks.
  const restarted = [row(1, 1, "stopped"), row(2, 1, "passed"), row(2, 2, "passed"), row(3, 1, "passed"), row(3, 2, "passed")];
  assert.equal(roundLabel(restarted, lists([1, 2, 3]), 1, "check"), "Checks stopped before they finished");
  assert.equal(roundLabel(restarted, lists([1, 2, 3]), 2, "check"), "Checks of the first build");
  assert.equal(roundLabel(restarted, lists([1, 2, 3]), 3, "check"), "Checks after round 1 of fixes");
  // Setup commands run again only when a restart cut them short.
  const setup = [row(1, 1, "stopped", "setup"), row(2, 1, "passed", "setup")];
  assert.equal(roundLabel(setup, [{ kind: "setup", round: 1, total: 1 }], 1, "setup"), "Setup commands stopped before they finished");
});
