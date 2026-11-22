import assert from "node:assert/strict";
import test from "node:test";
import { arrive, blocked, commandsWords, DEFAULTS, issueWords, ISSUE_NOT_FULL, readRemembered, repoName, rowsFor, sendFor, splitPath, writeRemembered, type Facts, type Remembered } from "../web/src/app/composer.ts";

// The composer on the home screen starts a chat, a task or a run. What Send does, which rows the Add context sheet
// shows, why Send is disabled and what is remembered on the device are decided here, without a browser.

const REPO = "/Users/owner/code/api";
const ready: Facts = {
  text: "Add a README",
  repo: { kind: "none" },
  repoStatus: { state: "none" },
  kind: "task",
  specPath: "",
  mode: "manual",
  builder: { state: "ready" },
  model: { ok: true, model: "haiku" },
  buildModel: null,
  commandTyped: false,
  hasChecks: null,
};
const inRepo = (over: Partial<Facts> = {}): Facts => ({ ...ready, repo: { kind: "known", path: REPO }, repoStatus: { state: "usable" }, ...over });
const extras = { preapproved: ["npm test"], reviewer: null, delivery: "branch" as const };

test("Send is disabled for a fully autonomous run on a repository with no check commands, and only then", () => {
  const why = /^Fully autonomous needs a check command for this repository\./;
  assert.match(blocked(inRepo({ kind: "run", mode: "full", hasChecks: false }))!.reason, why);
  assert.equal(sendFor(inRepo({ kind: "run", mode: "full", hasChecks: false }), extras).do, "blocked");
  // With a check, other modes, a task, or checks not known yet, nothing is said that the server has not said.
  for (const over of [{ hasChecks: true }, { hasChecks: null }, { mode: "semi" as const }, { kind: "task" as const }])
    assert.equal(blocked(inRepo({ kind: "run", mode: "full", hasChecks: true, ...over })), null);
});

test("with no repository, Send posts a chat turn with the prompt and model, whatever kind was chosen before", () => {
  assert.deepEqual(sendFor(ready, extras), { do: "chat", prompt: "Add a README", model: "haiku" });
  assert.deepEqual(sendFor({ ...ready, kind: "run" }, extras), { do: "chat", prompt: "Add a README", model: "haiku" });
});

test("with a repository and One task, Send starts a task with the path, prompt, model and the listed commands, and no mode", () => {
  assert.deepEqual(sendFor(inRepo(), extras), { do: "task", repo: REPO, prompt: "Add a README", model: "haiku", preapproved: ["npm test"] });
  // A task started on its own is always manual in the engine: a mode chosen for runs is not sent with it.
  assert.deepEqual(sendFor(inRepo({ mode: "full" }), extras), { do: "task", repo: REPO, prompt: "Add a README", model: "haiku", preapproved: ["npm test"] });
  // A typed path is sent as typed, trimmed; the server checks it again.
  assert.deepEqual(sendFor(inRepo({ repo: { kind: "other", path: `  ${REPO}/ ` } }), extras), { do: "task", repo: `${REPO}/`, prompt: "Add a README", model: "haiku", preapproved: ["npm test"] });
});

test("with a repository and Plan a run, Send starts a run with its mode, reviewer, delivery and build model", () => {
  const reviewer = { agent: "codex", model: null };
  assert.deepEqual(sendFor(inRepo({ kind: "run", mode: "semi" }), { ...extras, reviewer, delivery: "pull_request" }), {
    do: "run",
    repo: REPO,
    prompt: "Add a README",
    model: "haiku",
    preapproved: ["npm test"],
    reviewer,
    mode: "semi",
    delivery: "pull_request",
  });
  // A build model of its own is sent only when the owner chose one.
  const run = sendFor(inRepo({ kind: "run", buildModel: { ok: true, model: "opus" } }), extras);
  assert.equal(run.do === "run" && run.buildModel, "opus");
  // A spec file in place of a prompt.
  const spec = sendFor(inRepo({ kind: "run", text: "  ", specPath: " /tmp/spec.md " }), extras);
  assert.equal(spec.do, "run");
  assert.equal(spec.do === "run" && "specPath" in spec && spec.specPath, "/tmp/spec.md");
  assert.equal(spec.do === "run" && "prompt" in spec, false);
});

test("an empty box sends nothing and puts the cursor in the box", () => {
  assert.deepEqual(sendFor({ ...ready, text: "   " }, extras), { do: "focus" });
  assert.deepEqual(sendFor(inRepo({ text: "" }), extras), { do: "focus" });
  assert.deepEqual(sendFor(inRepo({ kind: "run", text: "" }), extras), { do: "focus" });
});

test("Send is disabled, with the reason in words, while something it needs is missing", () => {
  assert.equal(blocked(ready), null);
  assert.equal(blocked(inRepo()), null);
  assert.deepEqual(blocked({ ...ready, builder: { state: "checking" } }), { reason: "Checking that Claude Code is ready.", required: null });
  assert.deepEqual(blocked({ ...ready, builder: { state: "problem", words: "Claude Code is signed out." } }), { reason: "Claude Code is signed out. Nothing can be sent until this is fixed.", required: null });
  // A repository is needed and none is chosen: the required chip stands in for the model chip.
  assert.deepEqual(blocked({ ...ready, repo: { kind: "needed" } }), { reason: "Choose a repository for the task, or None to just chat.", required: "repository" });
  assert.deepEqual(blocked({ ...ready, kind: "run", repo: { kind: "needed" } }), { reason: "Choose a repository for the run, or None to just chat.", required: "repository" });
  assert.deepEqual(blocked(inRepo({ repo: { kind: "other", path: " " }, repoStatus: { state: "none" } })), { reason: "Enter the full path of a git repository on this Mac.", required: "repository" });
  assert.deepEqual(blocked(inRepo({ repoStatus: { state: "checking" } })), { reason: "Checking the repository.", required: null });
  assert.deepEqual(blocked(inRepo({ repoStatus: { state: "refused", words: "This folder is not a git repository." } })), { reason: "This folder is not a git repository.", required: "repository" });
  // A check that could not be made does not stop the start: the server checks again.
  assert.equal(blocked(inRepo({ repoStatus: { state: "unknown", words: "The path could not be checked." } })), null);
  assert.deepEqual(blocked(inRepo({ kind: "run", mode: null })), { reason: "Reading the default mode from Settings.", required: null });
  assert.deepEqual(blocked(inRepo({ kind: "run", specPath: "/tmp/spec.md" })), { reason: "Give a message or a spec file, not both.", required: null });
  assert.deepEqual(blocked(inRepo({ model: { ok: false, why: "Enter a model name, or pick one from the list." } })), { reason: "Model: Enter a model name, or pick one from the list.", required: null });
  assert.deepEqual(blocked(inRepo({ kind: "run", buildModel: { ok: false, why: "Enter a model name, or pick one from the list." } })), { reason: "Build model: Enter a model name, or pick one from the list.", required: null });
  // The build model is the run's alone: for a task it is not asked about.
  assert.equal(blocked(inRepo({ kind: "task", buildModel: { ok: false, why: "x" } })), null);
  assert.deepEqual(blocked(inRepo({ commandTyped: true })), { reason: "Add the command you typed to Allowed commands, or clear it: it is not on the list yet.", required: null });
  // Mode and spec belong to a run; with no repository the chat needs neither.
  assert.equal(blocked({ ...ready, kind: "run", mode: null, specPath: "/tmp/x.md" }), null);
});

test("a disabled Send sends nothing", () => {
  assert.deepEqual(sendFor({ ...ready, builder: { state: "checking" } }, extras), { do: "blocked", reason: "Checking that Claude Code is ready." });
  assert.deepEqual(sendFor(inRepo({ repoStatus: { state: "checking" } }), extras), { do: "blocked", reason: "Checking the repository." });
});

test("the sheet shows only the rows that apply: a chat has a repository and a model, a task adds what to do, mode and commands, a run adds the rest", () => {
  const known = { reviewOffered: true, commandsKnown: true };
  assert.deepEqual(rowsFor({ repo: { kind: "none" }, kind: "run", ...known }), ["repository", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "needed" }, kind: "task", ...known }), ["repository", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "task", ...known }), ["repository", "kind", "mode", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known }), ["repository", "kind", "spec", "mode", "review", "delivery", "commands", "models"]);
  // No reviewer is set up at all: no Review row. The commands are not known until the repository is usable.
  assert.deepEqual(rowsFor({ repo: { kind: "other", path: REPO }, kind: "run", reviewOffered: false, commandsKnown: false }), ["repository", "kind", "spec", "mode", "delivery", "models"]);
});

test("the repository, kind, mode, review and delivery are remembered on the device, and anything else read back is ignored", () => {
  const chosen: Remembered = { repo: { kind: "known", path: REPO }, kind: "run", mode: "full", review: "codex gpt-5", delivery: "pull_request" };
  assert.deepEqual(readRemembered(writeRemembered(chosen)), chosen);
  assert.deepEqual(readRemembered(writeRemembered({ ...chosen, repo: { kind: "other", path: "/x" } })).repo, { kind: "other", path: "/x" });
  assert.deepEqual(readRemembered(null), DEFAULTS);
  assert.deepEqual(DEFAULTS, { repo: { kind: "none" }, kind: "task", mode: null, review: "", delivery: "branch" });
  assert.deepEqual(readRemembered("not json"), DEFAULTS);
  assert.deepEqual(readRemembered(JSON.stringify({ repo: { kind: "known", path: 3 }, kind: "everything", mode: "reckless", review: 1, delivery: "push" })), DEFAULTS);
  // "Needed" is a state of one visit, never remembered.
  assert.deepEqual(readRemembered(JSON.stringify({ ...chosen, repo: { kind: "needed" } })).repo, { kind: "none" });
});

test("New task and New run arrive with their kind chosen, and ask for a repository only when none is remembered", () => {
  assert.deepEqual(arrive(DEFAULTS, "run"), { repo: { kind: "needed" }, kind: "run" });
  assert.deepEqual(arrive({ ...DEFAULTS, repo: { kind: "known", path: REPO } }, "run"), { repo: { kind: "known", path: REPO }, kind: "run" });
  assert.deepEqual(arrive({ ...DEFAULTS, kind: "run" }, null), { repo: { kind: "none" }, kind: "run" });
});

test("row values in words", () => {
  const known = [{ name: "api", path: REPO }];
  assert.equal(repoName({ kind: "none" }, known), "None (just chat)");
  assert.equal(repoName({ kind: "needed" }, known), "Choose");
  assert.equal(repoName({ kind: "known", path: REPO }, known), "api");
  assert.equal(repoName({ kind: "other", path: "/Users/owner/code/web/" }, known), "web");
  assert.equal(repoName({ kind: "other", path: "" }, known), "Another folder");
  assert.equal(commandsWords(0), "None");
  assert.equal(commandsWords(1), "1 command");
  assert.equal(commandsWords(3), "3 commands");
  assert.deepEqual(splitPath("/Users/owner/code/api"), ["/Users/owner/code/", "api"]);
  assert.deepEqual(splitPath("/Users/owner/code/api/"), ["/Users/owner/code/", "api/"]);
  assert.deepEqual(splitPath("api"), ["", "api"]);
});

// A run from a GitHub issue (engine/intake.ts): the From an issue row, its value, what Send sends, and why it is disabled.
const issue = { fetchId: 4, allowHosts: false, number: 123, title: "Crash when the log has a very long line in it" };

test("From an issue is a row of a run in a repository with a GitHub remote only, after What to do", () => {
  const known = { reviewOffered: true, commandsKnown: true };
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known, issueOffered: true }), ["repository", "kind", "issue", "spec", "mode", "review", "delivery", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "task", ...known, issueOffered: true }), ["repository", "kind", "mode", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known, issueOffered: false }), ["repository", "kind", "spec", "mode", "review", "delivery", "commands", "models"]);
});

test("the row's value is the issue's number and the start of its title, or None", () => {
  assert.equal(issueWords(null), "None");
  assert.equal(issueWords(issue), "#123 · Crash when the log has a very…");
  assert.equal(issueWords({ ...issue, title: "Short" }), "#123 · Short");
});

test("with an issue, Send starts a run with the issue and the owner's message, or the issue alone", () => {
  const facts = inRepo({ kind: "run", mode: "semi", issue });
  const sent = sendFor(facts, extras);
  assert.equal(sent.do, "run");
  assert.deepEqual(sent.do === "run" ? [sent.issue, "prompt" in sent ? sent.prompt : undefined] : [], [{ fetchId: 4, allowHosts: false }, "Add a README"]);
  const alone = sendFor({ ...facts, text: "  " }, extras);
  assert.deepEqual(alone.do === "run" ? [alone.issue, "prompt" in alone, "specPath" in alone] : [], [{ fetchId: 4, allowHosts: false }, false, false]);
  // Without an issue an empty message still only focuses the box.
  assert.deepEqual(sendFor(inRepo({ kind: "run", mode: "semi", text: "" }), extras), { do: "focus" });
});

test("a run from an issue cannot be sent fully autonomous, nor with a spec file, and says why", () => {
  assert.deepEqual(blocked(inRepo({ kind: "run", mode: "full", issue })), { reason: ISSUE_NOT_FULL, required: null });
  assert.match(ISSUE_NOT_FULL, /stranger's text must not lead to an accepted change and a pull request with nobody looking/);
  assert.match(blocked(inRepo({ kind: "run", mode: "manual", issue, specPath: "/x/spec.md", text: "" }))!.reason, /spec file/);
  assert.equal(blocked(inRepo({ kind: "run", mode: "semi", issue })), null);
  // A task never carries an issue, whatever was attached while planning a run.
  assert.equal(sendFor(inRepo({ kind: "task", issue }), extras).do, "task");
});
