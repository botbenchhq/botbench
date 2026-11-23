import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BRANCH_LOOKUPS, otherWork, withoutPullRequest } from "../src/engine/peers.ts";
import { replayGitHub } from "./support/replay-github.ts";
import { ghArgs, parsePullRequestList, parsePullRequestPage, type ListedPullRequest } from "../src/github.ts";
import { loadPeersCapture, PEERS_REPO } from "./support/replay-peers.ts";

// What other workbenches have in flight (Peers P2), read from gh's answer. The parser is tested on output captured
// once from the real gh for the owner's repository botbenchhq/botbench (test/support/replay-peers.ts, the owner's
// approved exception to "no fakes"); which of it counts as another workbench's is a pure rule, tested on its own.

test("gh is asked for the open pull requests with exact arguments, each value joined to its flag", () => {
  assert.deepEqual(ghArgs.prListOpen(PEERS_REPO), ["pr", "list", "--repo=github.com/botbenchhq/botbench", "--state=open", "--json=number,title,url,state,headRefName,isCrossRepository,closingIssuesReferences,files", "--limit=100"]);
  assert.deepEqual(loadPeersCapture().outputs.open.args, ghArgs.prListOpen(PEERS_REPO), "the capture was made with these arguments");
});

test("the real list is read: numbers, titles, head branches, the issues each closes on the same repository, and its files", () => {
  const capture = loadPeersCapture();
  assert.deepEqual(parsePullRequestList(capture.outputs.open.result.stdout, PEERS_REPO), [], "no pull request was open when it was captured");
  const all = parsePullRequestList(capture.outputs.all.result.stdout, PEERS_REPO);
  assert.equal(all.length, (JSON.parse(capture.outputs.all.result.stdout) as unknown[]).length, "every pull request of the repository itself is read");
  const pr63 = all.find((pr) => pr.number === 63)!;
  assert.deepEqual([pr63.state, pr63.headRefName, pr63.closes, pr63.url], ["MERGED", "botbench/run-2/task-2", [61], "https://github.com/botbenchhq/botbench/pull/63"]);
  assert.ok(pr63.files.includes("docs/security/threat-model.md"));
  assert.deepEqual(all.find((pr) => pr.number === 68)!.closes, [62]);
  assert.ok(all.every((pr) => !/[\n\r\t]/.test(pr.title) && pr.title.length <= 300));

  // The same answer is not taken for another repository's: every address names botbenchhq/botbench.
  assert.deepEqual(parsePullRequestList(capture.outputs.all.result.stdout, { host: "github.com", owner: "someone", name: "else" }), []);
  // Today's real pull requests carry the branch forms from before workbenches had names, or none: none is another workbench's.
  assert.deepEqual(otherWork(all.map((pr) => ({ ...pr, state: "OPEN" })), [], new Set(["alice"])).pullRequests, []);
});

test("what the parser leaves out: a fork's pull request, an address on another repository, a number that is not one, an issue of another repository", () => {
  const pr = (o: Record<string, unknown>) => ({ number: 7, title: "t", url: "https://github.com/botbenchhq/botbench/pull/7", state: "OPEN", headRefName: "botbench/bob/run-1/task-1", isCrossRepository: false, closingIssuesReferences: [], files: [], ...o });
  const read = (list: unknown[]) => parsePullRequestList(JSON.stringify(list), PEERS_REPO);
  assert.equal(read([pr({ isCrossRepository: true })]).length, 0);
  assert.equal(read([pr({ url: "https://evil.example/botbenchhq/botbench/pull/7" })]).length, 0);
  assert.equal(read([pr({ number: "7" })]).length, 0);
  assert.equal(read([pr({ number: 1.5 })]).length, 0);
  const closes = read([pr({ closingIssuesReferences: [{ number: 59, repository: { name: "botbench", owner: { login: "jon-lange" } } }, { number: 3, repository: { name: "other", owner: { login: "jon-lange" } } }, { number: "4" }] })]);
  assert.deepEqual(closes[0]!.closes, [59]);
  assert.equal(read([pr({ title: "a\nb\u0007c" })])[0]!.title, "a b c", "one plain line");
  assert.throws(() => parsePullRequestList("not json", PEERS_REPO), /could not be read/);
});

test("another workbench's work: an open pull request or a pushed branch under a name this installation never had", () => {
  const listed = (number: number, headRefName: string, state = "OPEN"): ListedPullRequest => ({ number, title: `Pull request ${number}`, url: `https://github.com/botbenchhq/botbench/pull/${number}`, state, headRefName, closes: [number + 100], files: ["src/a.ts"] });
  const own = new Set(["alice", "alices-mac"]);
  const work = otherWork(
    [listed(3, "botbench/bob/run-1/task-1"), listed(4, "botbench/alice/run-1/task-1"), listed(5, "botbench/alices-mac/run-2/task-2"), listed(6, "botbench/run-4/task-5"), listed(7, "feature/x"), listed(8, "botbench/carol/run-1/task-1", "MERGED"), listed(9, "botbench/Bob/run-1/task-1"), listed(10, "botbench/../x"), listed(11, "botbench/erin/run-1/task-1", "CLOSED")],
    [{ branch: "botbench/bob/run-1/task-1" }, { branch: "botbench/bob/run-2/task-3" }, { branch: "botbench/alice/run-9/task-9" }, { branch: "botbench/run-1/task-1" }, { branch: "botbench/carol/run-1/task-1" }, { branch: "botbench/erin/run-1/task-1" }, { branch: "botbench/x/y" }],
    own,
  );
  assert.deepEqual(work.pullRequests.map((pr) => [pr.workbench, pr.number, pr.closes]), [["bob", 3, [103]]]);
  assert.deepEqual(work.branches, [{ workbench: "bob", branch: "botbench/bob/run-2/task-3" }], "a branch with an open pull request is listed with it, one whose pull request was merged (carol's) or closed (erin's) is left out, and this installation's own are not listed");
  assert.deepEqual(work.claims, []);
});

test("when the list of pull requests was full, a pushed branch is kept only once gh says it has none; one it could not ask about is left out", async () => {
  const branches = Array.from({ length: MAX_BRANCH_LOOKUPS + 2 }, (_, i) => ({ workbench: "bob", branch: `botbench/bob/run-${i + 1}/task-1` }));
  // gh's real answers, captured once (test/support/replay-github.ts): none for a branch, and one pull request for a branch.
  const none = replayGitHub().github;
  const one = replayGitHub({ existing: true }).github;
  const repo = { host: "github.com", owner: "jon-lange", name: "botbench" };
  const answer = (branch: string) => (branch.endsWith("run-1/task-1") ? one.findPullRequest(repo, branch) : branch.endsWith("run-2/task-1") ? Promise.reject(new Error("no network")) : none.findPullRequest(repo, branch));
  const kept = await withoutPullRequest(branches, answer);
  assert.deepEqual(kept.map((b) => b.branch), branches.slice(2, MAX_BRANCH_LOOKUPS).map((b) => b.branch), "the one with a pull request, the one gh could not answer for, and those past the cap are left out");
});

test("another workbench's claim branch is read as a claim from its name alone; this installation's own and malformed ones are not", () => {
  const work = otherWork(
    [],
    [{ branch: "botbench/bob/run-3/issue-82-at-20261122T210530123Z" }, { branch: "botbench/alice/run-1/issue-82-at-20261122T210530123Z" }, { branch: "botbench/carol/run-2/issue-82-at-20261322T210530123Z" }, { branch: "botbench/dave/run-2/issue-0-at-20261122T210530123Z" }],
    new Set(["alice"]),
  );
  assert.deepEqual(work.claims, [{ workbench: "bob", branch: "botbench/bob/run-3/issue-82-at-20261122T210530123Z", issue: 82, startedAt: "2026-11-22T21:05:30.123Z", workedAt: "2026-11-22T21:05:30.123Z", takenOverBy: null, pullRequest: null }]);
  assert.deepEqual(work.branches.map((b) => b.branch), ["botbench/carol/run-2/issue-82-at-20261322T210530123Z", "botbench/dave/run-2/issue-0-at-20261122T210530123Z"], "a name that is not a real claim (month 13, issue 0) is only a pushed branch");
});

test("a page is full by what gh gave: the real list of botbenchhq/botbench held 61 when it was captured, so it is not full", () => {
  const capture = loadPeersCapture();
  const real = parsePullRequestPage(capture.outputs.all.result.stdout, PEERS_REPO);
  assert.deepEqual([real.pullRequests.length, real.full], [61, false]);
  // A full page with a fork's pull request among them is read live from a public repository: test/live/peers.live.test.ts.
});

test("an open pull request carries the head its branch has on the remote, as git ls-remote listed it; none when the remote did not list it", () => {
  const listed = (number: number, headRefName: string): ListedPullRequest => ({ number, title: "t", url: `https://github.com/botbenchhq/botbench/pull/${number}`, state: "OPEN", headRefName, closes: [], files: [] });
  const head = "0123456789abcdef0123456789abcdef01234567";
  const work = otherWork([listed(3, "botbench/bob/run-1/task-1"), listed(4, "botbench/bob/run-2/task-2")], [{ branch: "botbench/bob/run-1/task-1", commit: head }], new Set(["alice"]));
  assert.deepEqual(work.pullRequests.map((pr) => [pr.number, pr.head]), [[3, head], [4, null]]);
});

test("a claim another workbench took over reads as taken over; one whose run has its pull request open reads as that pull request; signs of work give the time and are not listed", () => {
  const C = "1".repeat(40);
  const B = "2".repeat(40);
  const own = new Set(["alice"]);
  const cClaim = "botbench/exp-c/run-3/issue-4-at-20261123T111603365Z";
  const bClaim = "botbench/exp-b/run-7/issue-4-at-20261123T121654000Z";
  const branches = [
    { branch: "botbench/claims/issue-4", commit: C },
    { branch: cClaim, commit: C },
    { branch: "botbench/exp-c/run-3/issue-4-worked-at-20261123T112603365Z", commit: C },
    // A sign at another commit than its claim's says nothing of it.
    { branch: "botbench/exp-c/run-3/issue-4-worked-at-20261123T115603365Z", commit: B },
    { branch: bClaim, commit: B },
    { branch: "botbench/exp-b/run-7/task-12", commit: "3".repeat(40) },
  ];
  const pr: ListedPullRequest = { number: 31, title: "Accept plus addresses", url: "https://github.com/o/r/pull/31", state: "OPEN", headRefName: "botbench/exp-b/run-7/task-12", closes: [], files: [] };
  const work = otherWork([pr], branches, own);
  assert.deepEqual(work.claims.map((c) => [c.branch, c.workedAt, c.takenOverBy, c.pullRequest]), [
    [bClaim, "2026-11-23T12:16:54.000Z", null, 31],
    [cClaim, "2026-11-23T11:26:03.365Z", "exp-b", null],
  ]);
  assert.deepEqual(work.branches, [], "signs of work and a branch with a pull request are not listed as pushed branches");
  // A later claim less than an hour after it is not a take-over (only an hour-old claim can be taken over).
  const early = otherWork([], [{ branch: "botbench/claims/issue-4", commit: C }, { branch: cClaim, commit: C }, { branch: "botbench/exp-b/run-7/issue-4-at-20261123T111703365Z", commit: B }], own);
  assert.deepEqual(early.claims.map((c) => c.takenOverBy), [null, null]);
});
