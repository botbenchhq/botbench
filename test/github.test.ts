import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHub, deliveryEnv, ghArgs, ghFailure, githubRepoOf, parseAuthStatus, parsePrCreate, parsePrList, parseRepoView, redact, titleLine, type RunGh } from "../src/github.ts";
import { loadGhCapture } from "./support/replay-github.ts";

// The gh tool's arguments and the reading of its answers. Pure functions: no process, no network. The answers are
// the real `gh`'s, captured once against a private scratch repository (test/live/delivery.live.test.ts).

const repo = { host: "github.com", owner: "jon-lange", name: "example" };

test("each gh command is the exact argument list, every value joined to its flag, the body never an argument", () => {
  assert.deepEqual(ghArgs.authStatus("github.com"), ["auth", "status", "--hostname=github.com", "--active", "--json=hosts"]);
  assert.deepEqual(ghArgs.repoView(repo), ["repo", "view", "github.com/jon-lange/example", "--json=nameWithOwner,defaultBranchRef"]);
  assert.deepEqual(ghArgs.prList(repo, "botbench/run-3/task-7"), ["pr", "list", "--repo=github.com/jon-lange/example", "--head=botbench/run-3/task-7", "--state=all", "--json=number,url,state,headRefName,isCrossRepository", "--limit=100"]);
  assert.deepEqual(ghArgs.prCreate(repo, { base: "main", head: "botbench/run-3/task-7", title: "Add a greeting" }), ["pr", "create", "--repo=github.com/jon-lange/example", "--base=main", "--head=botbench/run-3/task-7", "--title=Add a greeting", "--body-file=-"]);
});

test("a title or branch an agent wrote cannot become a gh option: titles are one line in --title=, odd branches are refused", () => {
  const args = ghArgs.prCreate(repo, { base: "main", head: "botbench/run-1/task-1", title: "--repo=evil/x\n--base main" });
  assert.equal(args.filter((a) => a.startsWith("--repo=")).length, 1);
  assert.equal(args[5], "--title=--repo=evil/x --base main");
  assert.equal(args.includes("--base"), false);
  for (const bad of ["-x", "--head=evil", "a..b", "has space", "x;rm", ""]) assert.throws(() => ghArgs.prList(repo, bad), /not a branch name/, bad);
  assert.throws(() => ghArgs.prCreate(repo, { base: "-main", head: "botbench/a", title: "t" }), /not a branch name/);
  assert.throws(() => ghArgs.prCreate(repo, { base: "main", head: "botbench/a", title: "  \n " }), /needs a title/);
  assert.equal(titleLine("x".repeat(300)).length, 200);
});

test("GitHub addresses are read from https, ssh and scp-style remotes, credentials ignored; anything else is no GitHub repository", () => {
  for (const url of ["https://github.com/jon-lange/example.git", "https://github.com/jon-lange/example", "https://jon:tok@github.com/jon-lange/example.git", "ssh://git@github.com/jon-lange/example.git", "git@github.com:jon-lange/example.git", "https://GitHub.com/jon-lange/example/"]) {
    assert.deepEqual(githubRepoOf(url), repo, url);
  }
  for (const url of ["/tmp/bare.git", "file:///tmp/bare.git", "../other", "https://github.com/jon-lange", "https://github.com/a/b/c", "ext::sh -c evil", "https://github.com/-x/y", "git@github.com:/abs/path.git"]) {
    assert.equal(githubRepoOf(url), null, url);
  }
});

test("credentials in an address are taken out wherever they appear", () => {
  assert.equal(redact("fatal: unable to access 'https://jon:ghp_secret123@github.com/o/r.git/': 403"), "fatal: unable to access 'https://***@github.com/o/r.git/': 403");
  assert.equal(redact("https://x-access-token:abc@github.com/o/r and http://tok@host/x"), "https://***@github.com/o/r and http://***@host/x");
  assert.equal(redact("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(redact("no address here"), "no address here");
  assert.equal(redact("https://jon:pa/ss@word@github.com/o/r.git"), "https://***@github.com/o/r.git", "a / or @ inside the password goes too");
});

test("the real gh's answers are read: signed in or not, the default branch, a pull request found or none, one created", () => {
  const capture = loadGhCapture();
  const out = capture.outputs;
  const host = capture.repository.split("/")[0]!;
  assert.deepEqual(parseAuthStatus(out.authStatus.result.stdout, host), { login: "jon-lange" });
  assert.equal(parseAuthStatus(out.authStatusSignedOut.result.stdout, host), null);
  assert.equal(parseAuthStatus(out.authStatus.result.stdout, "ghe.example.com"), null, "another host is not signed in");
  assert.deepEqual(parseRepoView(out.repoView.result.stdout), { defaultBranch: "main" });
  assert.equal(parsePrList(out.prListNone.result.stdout, capture.branch), null);
  const created = parsePrCreate(out.prCreate.result.stdout);
  assert.match(created.url, new RegExp(`^https://github.com/${capture.repository.split("/").slice(1).join("/")}/pull/\\d+$`));
  assert.deepEqual(parsePrList(out.prListOne.result.stdout, capture.branch), created);
  assert.equal(parsePrList(out.prListOne.result.stdout, "botbench/other"), null, "a pull request of another branch is not this branch's");
  const [host2, owner, name] = capture.repository.split("/") as [string, string, string];
  assert.deepEqual(parsePrList(out.prListOne.result.stdout, capture.branch, { host: host2, owner, name }), created, "at this repository's own address");
  assert.equal(parsePrList(out.prListOne.result.stdout, capture.branch, { host: host2, owner: "someone-else", name }), null, "an address of another repository is never taken");
  for (const [name, { result }] of Object.entries(out)) assert.doesNotMatch(JSON.stringify(result), /gh[opsu]_[A-Za-z0-9]{10,}/, `${name} holds no token`);
});

test("a gh that is missing or fails is said in plain words, with credentials taken out", async () => {
  assert.match(ghFailure({ started: false, code: null, stdout: "", stderr: "" }), /not installed, or is not on the PATH/);
  assert.equal(ghFailure({ started: true, code: 1, stdout: "", stderr: "could not reach https://u:p@github.com\n" }), "The gh tool said: could not reach https://***@github.com");
  const run: RunGh = async () => ({ started: false, code: null, stdout: "", stderr: "" });
  const missing = await createGitHub(run).signedIn("github.com");
  assert.ok("problem" in missing && /not installed/.test(missing.problem));
});

test("git push and gh get the owner's environment without GitHub tokens or GIT_ variables, and with prompts off", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GH_TOKEN: "t1", GITHUB_TOKEN: "t2", GH_ENTERPRISE_TOKEN: "t3", GIT_DIR: "/elsewhere", SSH_AUTH_SOCK: "/tmp/agent.sock" });
    const env = deliveryEnv();
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GIT_DIR"]) assert.equal(env[name], undefined, name);
    assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock", "the owner's own ssh agent stays reachable");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GH_PROMPT_DISABLED, "1");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
