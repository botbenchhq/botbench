import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeersView } from "../web/src/api/client.ts";
import { issueWarnings, overlapLines, spottedIssues } from "../web/src/app/peers.ts";

// What the composer and the task screen say about other workbenches' work (Peers P2): plain functions, no browser.

const view = (pullRequests: { workbench: string; number: number; closes: number[]; files: string[] }[]): PeersView => ({
  state: "ready",
  repo: "/r",
  repository: "github.com/o/r",
  pullRequests: pullRequests.map((pr) => ({ ...pr, title: `Pull request ${pr.number}`, url: `https://github.com/o/r/pull/${pr.number}`, branch: `botbench/${pr.workbench}/run-1/task-${pr.number}`, head: null })),
  branches: [],
  claims: [],
  checkedAt: "2026-11-22T00:00:00.000Z",
});

test("issue numbers are spotted in a message: #59 and Issue #59, not an anchor, an entity, a colour or a number inside a word", () => {
  assert.deepEqual(spottedIssues("Fix #59 please"), [59]);
  assert.deepEqual(spottedIssues("Issue #59: the gate. Also (#60)."), [59, 60]);
  assert.deepEqual(spottedIssues("#59 and #59 again"), [59], "once each");
  assert.deepEqual(spottedIssues("see page.html#59, a&#59;b, x#59, colour #fff, #0, #12345678901"), []);
  assert.deepEqual(spottedIssues("no number here"), []);
});

test("the composer warns, without blocking, when another workbench has an open pull request for the attached issue or one the message names", () => {
  const peers = view([{ workbench: "bob", number: 71, closes: [59], files: [] }, { workbench: "carol", number: 72, closes: [60], files: [] }]);
  assert.deepEqual(issueWarnings(peers, { attached: 59, message: "" }), ["bob already has pull request #71 open for this issue."]);
  assert.deepEqual(issueWarnings(peers, { attached: null, message: "Fix Issue #60 now" }), ["A best-effort match on #60 in your message: carol already has pull request #72 open for issue #60."]);
  assert.deepEqual(issueWarnings(peers, { attached: 59, message: "Fix #59" }), ["bob already has pull request #71 open for this issue."], "the attached issue is said once");
  assert.deepEqual(issueWarnings(peers, { attached: 61, message: "Fix #62" }), []);
  assert.deepEqual(issueWarnings({ state: "unavailable", repo: "/r", problem: "no network", checkedAt: "" }, { attached: 59, message: "#59" }), []);
  assert.deepEqual(issueWarnings(null, { attached: 59, message: "#59" }), []);
});

test("at review time, the files a task changed that another workbench's open pull request also changes, one line per pull request, the list capped", () => {
  const peers = view([
    { workbench: "bob", number: 71, closes: [], files: ["src/a.ts", "src/b.ts", "README.md"] },
    { workbench: "carol", number: 72, closes: [], files: ["docs/x.md"] },
    { workbench: "dave", number: 73, closes: [], files: ["1", "2", "3", "4", "5", "6", "7"] },
  ]);
  assert.deepEqual(overlapLines(peers, ["src/b.ts", "src/a.ts", "web/c.tsx"]), ["bob's open pull request #71 also changes src/a.ts and src/b.ts, so the two may conflict when both are merged."]);
  assert.deepEqual(overlapLines(peers, ["1", "2", "3", "4", "5", "6", "7"]), ["dave's open pull request #73 also changes 1, 2, 3, 4, 5 and 2 more files, so the two may conflict when both are merged."]);
  assert.deepEqual(overlapLines(peers, ["README.md"]), ["bob's open pull request #71 also changes README.md, so the two may conflict when both are merged."]);
  assert.deepEqual(overlapLines(peers, ["other.ts"]), []);
  assert.deepEqual(overlapLines(null, ["src/a.ts"]), []);
});
