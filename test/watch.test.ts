import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, repositoryWatch, watchedRepositories } from "../src/config.ts";
import { backoffMs, ghArgs, ghSaysLimited, githubRetryDelay, labelProblem, parseApiHead, parseWatchedIssues, type RepoRef } from "../src/github.ts";
import { ISSUE_REPO, loadIssueCapture } from "./support/replay-issue.ts";
import { capturedIssue, loadWatchCapture, WATCH_REPO } from "./support/replay-watch.ts";

// Watching a repository for labelled issues (issue #73), at the lowest layer: the one list command's exact arguments,
// the reading of gh's answer, the label and interval settings, and the wait after GitHub's limits. Pure functions: no
// process, no network. The answers are the real gh's: the capture from jon-lange/botbench (test/live/watch.live.test.ts)
// and the issue capture from cli/cli (test/live/issue.live.test.ts), whose entries have the same shape as a list's.

const repo: RepoRef = { host: "github.com", owner: "jon-lange", name: "example" };

test("the watch's list is one exact argument list, every value joined to its flag with =, asking only for open issues with the label", () => {
  assert.deepEqual(ghArgs.watchIssues(repo, "botbench"), ["issue", "list", "--repo=github.com/jon-lange/example", "--label=botbench", "--state=open", "--json=number,title,author,url,labels", "--limit=1000"]);
  assert.deepEqual(ghArgs.watchIssues(repo, "good first issue")[3], "--label=good first issue");
  // A label that reads as a flag stays the label's value.
  assert.deepEqual(ghArgs.watchIssues(repo, "--repo=evil/x")[3], "--label=--repo=evil/x");
  for (const bad of ["", "a,b", 'say "x"', " lead", "trail ", "two\nlines", "x".repeat(51)]) assert.throws(() => ghArgs.watchIssues(repo, bad), /label/, JSON.stringify(bad));
  assert.deepEqual(ghArgs.watchHead(repo), ["api", "-i", "--method=GET", "--hostname=github.com", "repos/jon-lange/example"]);
});

test("a label is the name of one label: 1 to 50 characters, no comma, double quote or line break, no space at either end", () => {
  for (const good of ["botbench", "good first issue", "ready-for-botbench", "x".repeat(50), "Botbench: ready"]) assert.equal(labelProblem(good), null, good);
  assert.match(labelProblem(undefined)!, /^It needs a label\./);
  assert.match(labelProblem("")!, /^It needs a label\./);
  assert.match(labelProblem("a,b")!, /^"a,b" cannot be used\. A label is the name of one of the repository's labels/);
});

const issueCapture = loadIssueCapture().outputs;
const closedIssue = JSON.parse(issueCapture.issue.result.stdout) as Record<string, unknown>;
const pullRequest = JSON.parse(issueCapture.pullRequest.result.stdout) as Record<string, unknown>;

test("a closed issue, an issue without the label and a pull request are never kept, read from what the real gh printed", () => {
  // cli/cli#15019 as gh printed it: closed, labelled "bug". A list of open issues does not hold it; were it in one, it says CLOSED.
  assert.equal(closedIssue.state, "CLOSED");
  assert.deepEqual(parseWatchedIssues(JSON.stringify([closedIssue]), ISSUE_REPO, "bug"), []);
  // The same entry without its state, as a list's entry is, with the label it carries and one it does not.
  const { state: _state, body: _body, comments: _comments, ...listed } = closedIssue;
  assert.deepEqual(parseWatchedIssues(JSON.stringify([listed]), ISSUE_REPO, "Bug").map((i) => i.number), [15019], "GitHub compares label names without case");
  assert.deepEqual(parseWatchedIssues(JSON.stringify([listed]), ISSUE_REPO, "botbench"), []);
  // cli/cli#1 is a pull request: its address is /pull/1, so it is not an issue whatever it carries.
  const { state: _pr, ...pr } = pullRequest;
  assert.deepEqual(parseWatchedIssues(JSON.stringify([{ ...pr, labels: listed.labels }]), ISSUE_REPO, "bug"), []);
  // Another repository's issue, as gh would print it for a fork or a transfer, is left out by its address.
  assert.deepEqual(parseWatchedIssues(JSON.stringify([listed]), { host: "github.com", owner: "cli", name: "other" }, "bug"), []);
  assert.throws(() => parseWatchedIssues("not json", ISSUE_REPO, "bug"), /could not be read/);
  assert.throws(() => parseWatchedIssues("{}", ISSUE_REPO, "bug"), /could not be read/);
});

test("what is kept of an issue is its number, the address Botbench makes, and its title and author as plain outside text", () => {
  const { state: _state, body: _body, comments: _comments, ...listed } = closedIssue;
  const [kept] = parseWatchedIssues(JSON.stringify([{ ...listed, title: "Line one\n\u001b[31mtwo\t three", url: String(listed.url).toUpperCase() }]), ISSUE_REPO, "bug");
  assert.deepEqual(kept, { number: 15019, url: "https://github.com/cli/cli/issues/15019", title: "Line one [31mtwo three", author: "jeffwall-curlewlabs" });
});

test("the capture from jon-lange/botbench: every open issue gh listed with the label is kept, with its number, title and author", () => {
  const capture = loadWatchCapture();
  assert.equal(capture.command, `gh ${ghArgs.watchIssues(WATCH_REPO, capture.label).join(" ")}`, "the file states the exact command it was taken with");
  assert.deepEqual(capture.outputs.labelled.args, ghArgs.watchIssues(WATCH_REPO, capture.label));
  const raw = JSON.parse(capture.outputs.labelled.result.stdout) as { number: number; title: string; author: { login: string } }[];
  const kept = parseWatchedIssues(capture.outputs.labelled.result.stdout, WATCH_REPO, capture.label);
  assert.deepEqual(kept.map((i) => i.number), raw.map((i) => i.number));
  assert.equal(capturedIssue(capture).author, raw[0]!.author.login);
  // The same answer for another label keeps none of it.
  assert.deepEqual(parseWatchedIssues(capture.outputs.labelled.result.stdout, WATCH_REPO, `${capture.label}-not`), []);
  // The head of a real `gh api -i` answer: a 200, which is no limit.
  const head = parseApiHead(capture.outputs.head.result.stdout)!;
  assert.equal(head.status, 200);
  assert.equal(githubRetryDelay(head, { attempt: 1, now: Date.now(), baseMs: 60_000, capMs: 3600_000 }), null);
});

/*
 * GitHub's own example of an answer over the limit, as its REST documentation records it
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, "Exceeding the primary rate limit"),
 * printed the way `gh api -i` prints an answer: the status line, the headers, a blank line, the body.
 */
const RECORDED_LIMIT = "HTTP/2.0 403 Forbidden\nDate: Tue, 20 Aug 2013 14:50:41 GMT\nX-Ratelimit-Limit: 60\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1377013266\nX-Ratelimit-Used: 60\nX-Ratelimit-Resource: core\n\n{\"message\":\"API rate limit exceeded for xxx.xxx.xxx.xxx.\",\"documentation_url\":\"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting\"}";
/** The same documentation's secondary limit: a 403 that names how long to wait. */
const RECORDED_SECONDARY = "HTTP/2.0 403 Forbidden\nRetry-After: 60\nX-Ratelimit-Remaining: 4999\n\n{\"message\":\"You have exceeded a secondary rate limit.\"}";

test("after GitHub's limit the watch waits until retry-after or x-ratelimit-reset, with a capped backoff otherwise", () => {
  const at = Date.parse("Tue, 20 Aug 2013 14:50:41 GMT");
  const o = { attempt: 1, now: at, baseMs: 60_000, capMs: 3600_000 };
  const limit = parseApiHead(RECORDED_LIMIT)!;
  assert.equal(limit.status, 403);
  assert.equal(limit.headers["x-ratelimit-remaining"], "0");
  // x-ratelimit-reset 1377013266 is 15:41:06 that day: wait until it, 50 minutes 25 seconds after the answer.
  assert.equal(githubRetryDelay(limit, o), 3025_000);
  assert.equal(githubRetryDelay(parseApiHead(RECORDED_SECONDARY)!, o), 60_000);
  assert.equal(githubRetryDelay({ status: 429, headers: { "retry-after": "Tue, 20 Aug 2013 14:52:41 GMT" } }, o), 120_000);
  // A 429 with a reset and no count of what remains waits until the reset.
  assert.equal(githubRetryDelay({ status: 429, headers: { "x-ratelimit-reset": String(Math.floor(at / 1000) + 300) } }, o), 300_000);
  // A 429 that names no wait, and a 403 whose reset cannot be believed: the backoff, doubling, capped.
  assert.equal(githubRetryDelay({ status: 429, headers: {} }, o), 60_000);
  assert.equal(githubRetryDelay({ status: 429, headers: {} }, { ...o, attempt: 3 }), 240_000);
  assert.equal(githubRetryDelay({ status: 429, headers: {} }, { ...o, attempt: 20 }), 3600_000);
  assert.equal(githubRetryDelay({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(at / 1000) + 10 * 86_400) } }, o), 60_000);
  // A 403 without either header is a refusal, not a limit; a 200 or a 404 is no limit at all.
  assert.equal(githubRetryDelay({ status: 403, headers: { "x-ratelimit-remaining": "12" } }, o), null);
  assert.equal(githubRetryDelay({ status: 200, headers: { "x-ratelimit-remaining": "0" } }, o), null);
  assert.equal(parseApiHead("not a head"), null);
  assert.equal(backoffMs({ attempt: 0, baseMs: 10, capMs: 100 }), 10);
});

test("a failed gh says GitHub's limit stopped it from REST's 429 and its words, and GraphQL's", () => {
  const failed = (stderr: string) => ({ started: true, code: 1, stdout: "", stderr });
  assert.equal(ghSaysLimited(failed("HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)")), true);
  assert.equal(ghSaysLimited(failed("GraphQL: API rate limit already exceeded for user ID 1.")), true);
  assert.equal(ghSaysLimited(failed("HTTP 429: Too Many Requests")), true);
  assert.equal(ghSaysLimited(failed(issueCapture.missing.result.stderr)), false, "the real gh's answer for no such issue is no limit");
  assert.equal(ghSaysLimited({ started: true, code: 0, stdout: "rate limit", stderr: "" }), false);
  assert.equal(ghSaysLimited({ started: false, code: null, stdout: "", stderr: "" }), false);
});

function configFile(t: { after(fn: () => void): void }, repositories: unknown): { defaults: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-watch-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defaults = path.join(dir, "botbench.config.json");
  fs.writeFileSync(defaults, JSON.stringify({ port: 4780, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: { implementer: { driver: "claude-code" } }, repositories }));
  return { defaults };
}

test("a repository's watch needs a label, and its interval is a whole number of minutes that defaults to 10", (t) => {
  const config = loadConfig(configFile(t, { "/r/a": { watch: { label: "botbench" } }, "/r/b": { watch: { label: "ready", intervalMinutes: 30 } }, "/r/c": { claimIssues: true } }));
  assert.deepEqual(repositoryWatch(config, "/r/a"), { label: "botbench", intervalMinutes: 10 });
  assert.deepEqual(repositoryWatch(config, "/r/b"), { label: "ready", intervalMinutes: 30 });
  assert.equal(repositoryWatch(config, "/r/c"), null);
  assert.deepEqual(watchedRepositories(config), [
    { path: "/r/a", label: "botbench", intervalMinutes: 10 },
    { path: "/r/b", label: "ready", intervalMinutes: 30 },
  ]);
  assert.deepEqual(watchedRepositories(loadConfig(configFile(t, undefined))), []);
  const refused: [unknown, RegExp][] = [
    [{}, /repository "\/r\/a": "watch" needs a "label": the name of the label that makes an open issue a proposed run on Work\. It needs a label\./],
    [{ label: "" }, /"watch" needs a "label"/],
    [{ label: "a,b" }, /repository "\/r\/a": "watch\.label" "a,b" cannot be used\./],
    [{ label: 7 }, /"watch" needs a "label"/],
    [{ label: "ok", intervalMinutes: 0 }, /"watch\.intervalMinutes" must be a whole number of minutes from 1 to 1440/],
    [{ label: "ok", intervalMinutes: 2.5 }, /"watch\.intervalMinutes" must be a whole number/],
    [{ label: "ok", intervalMinutes: "10" }, /"watch\.intervalMinutes" must be a whole number/],
    [{ label: "ok", every: 3 }, /"watch" has unknown setting "every"\. Known settings: label, intervalMinutes\./],
    ["botbench", /"watch" must be an object with a "label", such as \{ "label": "botbench", "intervalMinutes": 10 \}/],
  ];
  for (const [watch, message] of refused) assert.throws(() => loadConfig(configFile(t, { "/r/a": { watch } })), message, JSON.stringify(watch));
});
