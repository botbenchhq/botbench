import assert from "node:assert/strict";
import { test } from "node:test";
import { otherWork } from "../src/engine/peers.ts";
import { ghArgs, parsePullRequestList, type ListedPullRequest } from "../src/github.ts";
import { loadPeersCapture, PEERS_REPO } from "./support/replay-peers.ts";

// What other workbenches have in flight (Peers P2), read from gh's answer. The parser is tested on output captured
// once from the real gh for the owner's repository jon-lange/botbench (test/support/replay-peers.ts, the owner's
// approved exception to "no fakes"); which of it counts as another workbench's is a pure rule, tested on its own.

test("gh is asked for the open pull requests with exact arguments, each value joined to its flag", () => {
  assert.deepEqual(ghArgs.prListOpen(PEERS_REPO), ["pr", "list", "--repo=github.com/jon-lange/botbench", "--state=open", "--json=number,title,url,state,headRefName,isCrossRepository,closingIssuesReferences,files", "--limit=100"]);
  assert.deepEqual(loadPeersCapture().outputs.open.args, ghArgs.prListOpen(PEERS_REPO), "the capture was made with these arguments");
});

test("the real list is read: numbers, titles, head branches, the issues each closes on the same repository, and its files", () => {
  const capture = loadPeersCapture();
  assert.deepEqual(parsePullRequestList(capture.outputs.open.result.stdout, PEERS_REPO), [], "no pull request was open when it was captured");
  const all = parsePullRequestList(capture.outputs.all.result.stdout, PEERS_REPO);
  assert.equal(all.length, (JSON.parse(capture.outputs.all.result.stdout) as unknown[]).length, "every pull request of the repository itself is read");
  const pr63 = all.find((pr) => pr.number === 63)!;
  assert.deepEqual([pr63.state, pr63.headRefName, pr63.closes, pr63.url], ["MERGED", "botbench/run-2/task-2", [61], "https://github.com/jon-lange/botbench/pull/63"]);
  assert.ok(pr63.files.includes("docs/security/threat-model.md"));
  assert.deepEqual(all.find((pr) => pr.number === 68)!.closes, [62]);
  assert.ok(all.every((pr) => !/[\n\r\t]/.test(pr.title) && pr.title.length <= 300));

  // The same answer is not taken for another repository's: every address names jon-lange/botbench.
  assert.deepEqual(parsePullRequestList(capture.outputs.all.result.stdout, { host: "github.com", owner: "someone", name: "else" }), []);
  // Today's real pull requests carry the branch forms from before workbenches had names, or none: none is another workbench's.
  assert.deepEqual(otherWork(all.map((pr) => ({ ...pr, state: "OPEN" })), [], new Set(["alice"])).pullRequests, []);
});

test("what the parser leaves out: a fork's pull request, an address on another repository, a number that is not one, an issue of another repository", () => {
  const pr = (o: Record<string, unknown>) => ({ number: 7, title: "t", url: "https://github.com/jon-lange/botbench/pull/7", state: "OPEN", headRefName: "botbench/bob/run-1/task-1", isCrossRepository: false, closingIssuesReferences: [], files: [], ...o });
  const read = (list: unknown[]) => parsePullRequestList(JSON.stringify(list), PEERS_REPO);
  assert.equal(read([pr({ isCrossRepository: true })]).length, 0);
  assert.equal(read([pr({ url: "https://evil.example/jon-lange/botbench/pull/7" })]).length, 0);
  assert.equal(read([pr({ number: "7" })]).length, 0);
  assert.equal(read([pr({ number: 1.5 })]).length, 0);
  const closes = read([pr({ closingIssuesReferences: [{ number: 59, repository: { name: "botbench", owner: { login: "jon-lange" } } }, { number: 3, repository: { name: "other", owner: { login: "jon-lange" } } }, { number: "4" }] })]);
  assert.deepEqual(closes[0]!.closes, [59]);
  assert.equal(read([pr({ title: "a\nb\u0007c" })])[0]!.title, "a b c", "one plain line");
  assert.throws(() => parsePullRequestList("not json", PEERS_REPO), /could not be read/);
});

test("another workbench's work: an open pull request or a pushed branch under a name this installation never had", () => {
  const listed = (number: number, headRefName: string, state = "OPEN"): ListedPullRequest => ({ number, title: `Pull request ${number}`, url: `https://github.com/jon-lange/botbench/pull/${number}`, state, headRefName, closes: [number + 100], files: ["src/a.ts"] });
  const own = new Set(["alice", "alices-mac"]);
  const work = otherWork(
    [listed(3, "botbench/bob/run-1/task-1"), listed(4, "botbench/alice/run-1/task-1"), listed(5, "botbench/alices-mac/run-2/task-2"), listed(6, "botbench/run-4/task-5"), listed(7, "feature/x"), listed(8, "botbench/carol/run-1/task-1", "MERGED"), listed(9, "botbench/Bob/run-1/task-1"), listed(10, "botbench/../x")],
    [{ branch: "botbench/bob/run-1/task-1" }, { branch: "botbench/bob/run-2/task-3" }, { branch: "botbench/alice/run-9/task-9" }, { branch: "botbench/run-1/task-1" }, { branch: "botbench/carol/run-1/task-1" }, { branch: "botbench/x/y" }],
    own,
  );
  assert.deepEqual(work.pullRequests.map((pr) => [pr.workbench, pr.number, pr.closes]), [["bob", 3, [103]]]);
  assert.deepEqual(work.branches, [{ workbench: "bob", branch: "botbench/bob/run-2/task-3" }, { workbench: "carol", branch: "botbench/carol/run-1/task-1" }], "a branch with an open pull request is listed with it; this installation's own are not listed");
});

test("an open pull request carries the head its branch has on the remote, as git ls-remote listed it; none when the remote did not list it", () => {
  const listed = (number: number, headRefName: string): ListedPullRequest => ({ number, title: "t", url: `https://github.com/jon-lange/botbench/pull/${number}`, state: "OPEN", headRefName, closes: [], files: [] });
  const head = "0123456789abcdef0123456789abcdef01234567";
  const work = otherWork([listed(3, "botbench/bob/run-1/task-1"), listed(4, "botbench/bob/run-2/task-2")], [{ branch: "botbench/bob/run-1/task-1", commit: head }], new Set(["alice"]));
  assert.deepEqual(work.pullRequests.map((pr) => [pr.number, pr.head]), [[3, head], [4, null]]);
});
