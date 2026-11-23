import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeersView } from "../web/src/api/client.ts";
import { issueWarnings, oldClaims, overlapLines, peerRows, spottedIssues } from "../web/src/app/peers.ts";

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

test("after a take-over and once a pull request is open, the composer and Work say so, and neither claim is offered to take over again", () => {
  const now = Date.parse("2026-11-23T13:30:00.000Z");
  const c = { workbench: "exp-c", branch: "botbench/exp-c/run-3/issue-4-at-20261123T111603365Z", issue: 4, startedAt: "2026-11-23T11:16:03.365Z", workedAt: "2026-11-23T11:16:03.365Z", takenOverBy: "exp-b", pullRequest: null };
  const b = { workbench: "exp-b", branch: "botbench/exp-b/run-7/issue-4-at-20261123T121654000Z", issue: 4, startedAt: "2026-11-23T12:16:54.000Z", workedAt: "2026-11-23T12:16:54.000Z", takenOverBy: null, pullRequest: 31 };
  const peers: PeersView = { ...view([]), claims: [b, c] } as PeersView;
  assert.deepEqual(issueWarnings(peers, { attached: 4, message: "", now }), ["exp-b has pull request #31 open for this issue.", "exp-c started on this issue 2 hours ago; exp-b took it over."]);
  // The pull request is said once when its own line says it.
  const withPr: PeersView = { ...view([{ workbench: "exp-b", number: 31, closes: [4], files: [] }]), claims: [b, c] } as PeersView;
  assert.deepEqual(issueWarnings(withPr, { attached: 4, message: "", now }), ["exp-b already has pull request #31 open for this issue.", "exp-c started on this issue 2 hours ago; exp-b took it over."]);
  if (peers.state !== "ready") return;
  assert.deepEqual(peerRows(peers, now).map((r) => r.rest), [" · Pull request #31 open for issue #4 · ", " · Started on issue #4 2 hours ago; exp-b took it over · "]);
  assert.deepEqual(oldClaims(peers, { attached: 4, message: "", now }), []);
});
