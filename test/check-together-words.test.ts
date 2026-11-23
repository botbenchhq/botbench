import assert from "node:assert/strict";
import { test } from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import { checkTogetherGate } from "../src/engine/combined.ts";
import type { CombinedCheck } from "../web/src/api/client.ts";
import { checkButton, commitsLine, othersCodeLine, outcomeLine, requirementLine, staleLine } from "../web/src/app/check-together.ts";

// What the task screen and the server say about checking together (Peers P4): plain functions, no browser, each sentence
// read for the words docs/product/voice.md never shows.

const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const B = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const C = "c1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const check = (o: Partial<CombinedCheck>): CombinedCheck => ({ id: 1, pullRequest: 12, workbench: "bob", peerBranch: "botbench/bob/run-1/task-1", peerCommit: B, taskCommit: A, outcome: "passed", conflicts: [], problem: null, startedAt: "", endedAt: "", commands: [], freshness: { state: "current" }, ...o });

test("each result says what it found, on which two commits, and that it includes another workbench's code", () => {
  assert.equal(outcomeLine(check({})), "Merged cleanly, and every check passed on the merge.");
  assert.equal(outcomeLine(check({ outcome: "conflict", conflicts: ["README.md", "src/a.ts"] })), "The two did not merge: 2 files are in conflict, README.md and src/a.ts. No check was run.");
  assert.equal(outcomeLine(check({ outcome: "failed", commands: [{ outcome: "failed" }, { outcome: "passed" }] as CombinedCheck["commands"] })), "Merged cleanly, and 1 command did not pass on the merge.");
  assert.equal(outcomeLine(check({ outcome: "not_run", problem: "Botbench could not merge pull request #12 with this task's work: no such branch." })), "Botbench could not merge pull request #12 with this task's work: no such branch.");
  assert.equal(commitsLine(check({})), "Ran on pull request #12 at b1b2c3d and this task at a1b2c3d.");
  assert.match(othersCodeLine(check({})), /^Includes another workbench's code: bob's pull request #12/);
  assert.equal(checkButton(12), "Check together with pull request #12");
});

test("a stale result names the commit it ran on and the new one, for either side, and says to check again", () => {
  assert.equal(staleLine(check({})), null);
  assert.equal(staleLine(check({ freshness: { state: "stale", taskMoved: false, pullRequestMoved: true, taskNow: A, pullRequestNow: C } })), "Out of date: pull request #12 is now at c1b2c3d, and this ran on b1b2c3d. It no longer counts. Check together again.");
  assert.equal(staleLine(check({ freshness: { state: "stale", taskMoved: true, pullRequestMoved: false, taskNow: C, pullRequestNow: B } })), "Out of date: this task's branch is now at c1b2c3d, and this ran on a1b2c3d. It no longer counts. Check together again.");
  assert.match(String(staleLine(check({ freshness: { state: "closed" } }))), /no longer open/);
});

test("the requirement says what it means and what it still waits on", () => {
  const offers = [{ number: 12, title: "t", url: "", workbench: "bob", head: B, overlaps: ["src/a.ts"] }];
  assert.match(requirementLine({ required: false, waitingOn: [], offers }), /^Not required on this repository\./);
  assert.match(requirementLine({ required: true, waitingOn: [12], offers }), /Still needed: bob's pull request #12\.$/);
  assert.match(requirementLine({ required: true, waitingOn: [], offers }), /Nothing is waiting on it now\.$/);
});

test("no sentence about checking together uses a word the screens never show, the server's reasons included", () => {
  const view = { state: "ready" as const, repo: "/r", repository: "github.com/o/r", checkedAt: "", branches: [], pullRequests: [{ workbench: "bob", number: 12, title: "t", url: "", branch: "botbench/bob/run-1/task-1", closes: [], files: ["src/a.ts"], head: B }] };
  const gate = checkTogetherGate({ required: true, files: ["src/a.ts"], view, checks: [], taskHead: A });
  const unread = checkTogetherGate({ required: true, files: ["src/a.ts"], view: { state: "unavailable", repo: "/r", problem: "gh is not signed in.", checkedAt: "" }, checks: [], taskHead: A });
  const offers = [{ number: 12, title: "t", url: "", workbench: "bob", head: B, overlaps: [] }];
  const sentences = [
    gate.ok ? "" : `It needs your review: ${gate.why}`,
    unread.ok ? "" : unread.why,
    outcomeLine(check({ outcome: "conflict", conflicts: ["x"] })),
    outcomeLine(check({ outcome: "failed", commands: [] })),
    outcomeLine(check({})),
    commitsLine(check({})),
    othersCodeLine(check({})),
    String(staleLine(check({ freshness: { state: "stale", taskMoved: true, pullRequestMoved: true, taskNow: null, pullRequestNow: C } }))),
    String(staleLine(check({ freshness: { state: "unknown", problem: "x" } }))),
    String(staleLine(check({ freshness: { state: "closed" } }))),
    requirementLine({ required: true, waitingOn: [12], offers }),
    requirementLine({ required: false, waitingOn: [], offers }),
    checkButton(12),
  ];
  for (const sentence of sentences) assert.deepEqual(bannedIn(sentence), [], sentence);
  assert.equal(gate.ok ? "" : gate.why, "This repository requires checking together, and there is no passing check together with bob's pull request #12 at the commits both are at now.");
});
