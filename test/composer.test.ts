import assert from "node:assert/strict";
import test from "node:test";
import { RUN_MODES } from "../src/engine/modes.ts";
import { chatOffer, readKnownAgents } from "../web/src/app/chat.ts";
import { arrive, blocked, builderName, chipModel, commandsWords, DEFAULTS, folderName, ISSUE_NOT_FULL, issueWords, modeFor, modeLine, oneTaskFor, startMode, READ_ABOUT, readName, readRemembered, repoName, returnsToList, reviewRows, rowsFor, sendFor, splitPath, writeRemembered, type Facts, type Remembered } from "../web/src/app/composer.ts";

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
const extras = { preapproved: ["npm test"], reviewer: null, delivery: "branch" as const, oneTask: false };

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
  assert.deepEqual(sendFor(inRepo({ kind: "run", mode: "semi" }), { ...extras, reviewer, delivery: "pull_request", oneTask: true }), {
    do: "run",
    repo: REPO,
    prompt: "Add a README",
    model: "haiku",
    preapproved: ["npm test"],
    reviewer,
    mode: "semi",
    delivery: "pull_request",
    oneTask: true,
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
  // The agent cannot be used: the reason names the problem and is followed by the one link to connect an agent.
  assert.deepEqual(blocked({ ...ready, builder: { state: "problem", words: "Claude Code is signed out." } }), { reason: "Claude Code is signed out. Nothing can be sent until this is fixed.", required: null, connect: true });
  // A repository is needed and none is chosen: the required chip stands in for the model chip.
  // Only New task and New run make a repository needed (see arrive): the reason is short, and the chip opens the view.
  assert.deepEqual(blocked({ ...ready, repo: { kind: "needed" } }), { reason: "Choose a repository", required: "repository" });
  assert.deepEqual(blocked({ ...ready, kind: "run", repo: { kind: "needed" } }), { reason: "Choose a repository", required: "repository" });
  // With no repository and no kind chosen on arrival, Send is a chat and nothing is required, whatever kind is remembered.
  for (const kind of ["task", "run"] as const) assert.equal(blocked({ ...ready, kind, repo: { kind: "none" } }), null);
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

test("the sheet shows only the rows that apply: a chat has a repository, one to read and a model, a task adds what to do, mode and commands, a run adds the rest", () => {
  const known = { reviewOffered: true, commandsKnown: true };
  assert.deepEqual(rowsFor({ repo: { kind: "none" }, kind: "run", ...known }), ["repository", "read", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "needed" }, kind: "task", ...known }), ["repository", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "task", ...known }), ["repository", "kind", "mode", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known }), ["repository", "kind", "spec", "mode", "tasks", "review", "delivery", "commands", "models"]);
  // No reviewer is set up at all: no Review row. The commands are not known until the repository is usable.
  assert.deepEqual(rowsFor({ repo: { kind: "other", path: REPO }, kind: "run", reviewOffered: false, commandsKnown: false }), ["repository", "kind", "spec", "mode", "tasks", "delivery", "models"]);
});

test("Keep it to one task is offered for a run in every mode, is on by default in Fully autonomous only, and is sent as the owner chose it", () => {
  assert.deepEqual(RUN_MODES.map((mode) => oneTaskFor(null, mode)), [false, false, true]);
  assert.equal(oneTaskFor(null, null), false, "not known yet while the default mode is read");
  for (const mode of RUN_MODES) {
    assert.equal(oneTaskFor(true, mode), true, mode);
    assert.equal(oneTaskFor(false, mode), false, mode);
  }
  const sent = sendFor(inRepo({ kind: "run", mode: "manual" }), { ...extras, oneTask: true });
  assert.equal(sent.do === "run" && sent.oneTask, true);
  // Choosing it returns to Add context, as the other two-way settings do.
  assert.equal(returnsToList({ view: "tasks", value: "one", run: true }), true);
});

test("the repository, kind, mode, review and delivery are remembered on the device, and anything else read back is ignored", () => {
  const chosen: Remembered = { repo: { kind: "known", path: REPO }, kind: "run", mode: { repo: REPO, mode: "semi" }, review: "codex gpt-5", delivery: "pull_request", sameBuild: false };
  assert.deepEqual(readRemembered(writeRemembered(chosen)), chosen);
  assert.deepEqual(readRemembered(writeRemembered({ ...chosen, repo: { kind: "other", path: "/x" } })).repo, { kind: "other", path: "/x" });
  assert.deepEqual(readRemembered(null), DEFAULTS);
  assert.deepEqual(DEFAULTS, { repo: { kind: "none" }, kind: "task", mode: null, review: "", delivery: "branch", sameBuild: true });
  // Building on the planning model unless a build model of its own was chosen; anything but true or false is that default.
  assert.equal(readRemembered(JSON.stringify({ ...chosen, sameBuild: "no" })).sameBuild, true);
  assert.deepEqual(readRemembered("not json"), DEFAULTS);
  assert.deepEqual(readRemembered(JSON.stringify({ repo: { kind: "known", path: 3 }, kind: "everything", mode: { repo: REPO, mode: "reckless" }, review: 1, delivery: "push" })), DEFAULTS);
  // "Needed" is a state of one visit, never remembered.
  assert.deepEqual(readRemembered(JSON.stringify({ ...chosen, repo: { kind: "needed" } })).repo, { kind: "none" });
});

test("New task and New run arrive with their kind chosen, and ask for a repository, opening its view, only when none is remembered", () => {
  assert.deepEqual(arrive(DEFAULTS, "run"), { repo: { kind: "needed" }, kind: "run", opens: "repository" });
  assert.deepEqual(arrive(DEFAULTS, "task"), { repo: { kind: "needed" }, kind: "task", opens: "repository" });
  assert.deepEqual(arrive({ ...DEFAULTS, repo: { kind: "known", path: REPO } }, "run"), { repo: { kind: "known", path: REPO }, kind: "run", opens: null });
  // Arriving on the home screen itself chooses no kind: no repository means a chat, and no sheet opens.
  assert.deepEqual(arrive({ ...DEFAULTS, kind: "run" }, null), { repo: { kind: "none" }, kind: "run", opens: null });
  assert.equal(sendFor({ ...ready, ...arrive({ ...DEFAULTS, kind: "run" }, null) }, extras).do, "chat");
  assert.equal(sendFor({ ...ready, ...arrive(DEFAULTS, "run") }, extras).do, "blocked");
});

test("a folder's name is its last part, for a repository shown by name", () => {
  assert.equal(folderName("/Users/owner/code/api"), "api");
  assert.equal(folderName("/Users/owner/code/api/"), "api");
  assert.equal(folderName("api"), "api");
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
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known, issueOffered: true }), ["repository", "kind", "issue", "spec", "mode", "tasks", "review", "delivery", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "task", ...known, issueOffered: true }), ["repository", "kind", "mode", "commands", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known, issueOffered: false }), ["repository", "kind", "spec", "mode", "tasks", "review", "delivery", "commands", "models"]);
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

test("Plan a run starts in the mode last chosen for its repository, Fully autonomous included, and otherwise in the mode from Settings", () => {
  // Screenshot 009 of the self-review: a Fully autonomous chosen once, on another visit, was read back as the default
  // for every repository. A mode is now remembered only with the repository it was chosen for.
  assert.equal(readRemembered(JSON.stringify({ ...DEFAULTS, mode: "full" })).mode, null, "a mode remembered by an earlier version, for no repository, is dropped");
  assert.equal(readRemembered(JSON.stringify({ ...DEFAULTS, mode: { repo: "", mode: "full" } })).mode, null, "a mode for no named repository is dropped");
  for (const mode of RUN_MODES) assert.deepEqual(readRemembered(writeRemembered({ ...DEFAULTS, mode: { repo: REPO, mode } })).mode, { repo: REPO, mode }, mode);
  // Nothing chosen: the Settings default, Manual when the owner never changed it; null while it is being read.
  assert.equal(modeFor(null, REPO, "manual"), "manual");
  assert.equal(modeFor(null, REPO, null), null);
  // Chosen for this repository: that choice. Chosen for another: the Settings default.
  assert.equal(modeFor({ repo: REPO, mode: "full" }, REPO, "manual"), "full");
  assert.equal(modeFor({ repo: "/Users/owner/code/other", mode: "full" }, REPO, "manual"), "manual");
  assert.equal(modeFor({ repo: "/Users/owner/code/other", mode: "semi" }, REPO, "semi"), "semi");
});

test("a run planned last time is what the composer opens on: Plan a run in that repository, with its mode, reviewer and delivery, and Send still sends nothing on its own", () => {
  const last: Remembered = { repo: { kind: "known", path: REPO }, kind: "run", mode: { repo: REPO, mode: "full" }, review: "codex gpt-5", delivery: "pull_request", sameBuild: false };
  const back = readRemembered(writeRemembered(last));
  assert.deepEqual(back, last, "a fully autonomous choice is kept with its repository, and so is a build model of its own");
  assert.deepEqual(arrive(back, null), { repo: { kind: "known", path: REPO }, kind: "run", opens: null });
  assert.equal(modeFor(back.mode, REPO, "manual"), "full");
  // Another repository gets the Settings default, whatever was chosen for this one.
  assert.equal(modeFor(back.mode, "/Users/owner/code/web", "manual"), "manual");
  // Opening the composer with all of it chosen sends nothing: an empty box only puts the cursor there.
  assert.deepEqual(sendFor(inRepo({ kind: "run", mode: "full", hasChecks: true, text: "" }), extras), { do: "focus" });
});

test("a remembered Fully autonomous that cannot start here falls back to Semi-autonomous, saying why in one sentence; it never starts looser", () => {
  const remembered = { remembered: true, hasChecks: true, issue: false };
  // No check command: Semi-autonomous, which can be sent; the line under the box names the mode and why.
  const noChecks = startMode("full", { ...remembered, hasChecks: false });
  assert.deepEqual(noChecks, { mode: "semi", why: "Fully autonomous, your last choice for this repository, needs a check command, and this repository has none, so this run starts Semi-autonomous." });
  assert.equal(blocked(inRepo({ kind: "run", mode: noChecks.mode, hasChecks: false })), null);
  const sent = sendFor(inRepo({ kind: "run", mode: noChecks.mode, hasChecks: false }), extras);
  assert.equal(sent.do === "run" && sent.mode, "semi");
  assert.equal(modeLine(noChecks), `Mode: Semi-autonomous. ${noChecks.why}`);
  // From a GitHub issue: the same, with the issue's reason. The refusal itself still stands for a Fully autonomous one.
  const fromIssue = startMode("full", { ...remembered, issue: true });
  assert.deepEqual(fromIssue, { mode: "semi", why: "A run started from a GitHub issue cannot be fully autonomous, so this run starts Semi-autonomous, not Fully autonomous as you last chose for this repository." });
  assert.equal(blocked(inRepo({ kind: "run", mode: fromIssue.mode, issue })), null);
  assert.deepEqual(blocked(inRepo({ kind: "run", mode: "full", issue })), { reason: ISSUE_NOT_FULL, required: null });
  // Each sentence is one sentence.
  for (const why of [noChecks.why!, fromIssue.why!]) assert.equal(why.split(/\.\s/).length, 1, why);
  // Chosen on this visit, Fully autonomous is not changed behind the owner's back: Send says why it is disabled, as before.
  assert.deepEqual(startMode("full", { ...remembered, remembered: false, hasChecks: false }), { mode: "full", why: null });
  assert.match(blocked(inRepo({ kind: "run", mode: "full", hasChecks: false }))!.reason, /^Fully autonomous needs a check command for this repository\./);
  // Checks not known yet, a mode that can start, or the mode still being read: as it is.
  assert.deepEqual(startMode("full", { ...remembered, hasChecks: null }), { mode: "full", why: null });
  for (const mode of ["manual", "semi"] as const) assert.deepEqual(startMode(mode, { ...remembered, hasChecks: false, issue: true }), { mode, why: null });
  assert.deepEqual(startMode(null, remembered), { mode: null, why: null });
  // Never looser than what was remembered (the modes go from strictest to loosest).
  for (const mode of RUN_MODES)
    for (const hasChecks of [true, false, null])
      for (const fromAnIssue of [true, false]) {
        const start = startMode(mode, { remembered: true, hasChecks, issue: fromAnIssue });
        assert.ok(RUN_MODES.indexOf(start.mode!) <= RUN_MODES.indexOf(mode), `${mode} ${hasChecks} ${fromAnIssue}`);
      }
  assert.equal(modeLine({ mode: "full", why: null }), "Mode: Fully autonomous.");
  assert.equal(modeLine({ mode: null, why: null }), null);
});

test("the model chip says what Send uses first: for a run with a build model of its own, the planning model, then the build model", () => {
  assert.equal(chipModel({ run: false, sameBuild: false, plan: "Haiku 5.5", build: "Opus 5.5" }), "Haiku 5.5");
  assert.equal(chipModel({ run: true, sameBuild: true, plan: "Haiku 5.5", build: "Opus 5.5" }), "Haiku 5.5");
  assert.equal(chipModel({ run: true, sameBuild: false, plan: "Haiku 5.5", build: "Opus 5.5" }), "Haiku 5.5, then Opus 5.5");
});

test("choosing an option of a setting returns to Add context, unless the option opens a field or the view holds a second choice", () => {
  for (const view of ["kind", "mode", "review", "delivery"] as const) assert.equal(returnsToList({ view, value: "x", run: true }), true, view);
  assert.equal(returnsToList({ view: "repository", value: REPO, run: false }), true);
  assert.equal(returnsToList({ view: "repository", value: "?other", run: false }), false, "Another folder… opens Folder path");
  assert.equal(returnsToList({ view: "models", value: "haiku", run: false }), false, "a chat's Models view also holds the agent");
  assert.equal(returnsToList({ view: "models", value: "haiku", run: true }), false, "a run's Models view also holds the build model");
  assert.equal(returnsToList({ view: "review", value: "codex ?other", run: true }), false, "a reviewer's Other… opens a field");
  assert.equal(returnsToList({ view: "mode", value: "full", run: true }), false, "Fully autonomous stays in view with its warning");
  for (const view of ["spec", "commands", "issue"] as const) assert.equal(returnsToList({ view, value: "x", run: true }), false, view);
});

test("Review lists, for each agent that reviews, its own default and the configured model first, then Other… for any other name, not every model flat", () => {
  // Screenshot 012: about 45 rows, one per model of every agent, and no default among them.
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `gpt-${i}` }));
  const rows = reviewRows([
    { agent: "codex", models: { driver: "codex", source: "cli", models: many, default: "gpt-3", cliDefault: "gpt-6-luna" } },
    { agent: "grok", models: { driver: "grok", source: "cli", models: [{ id: "grok-5", label: "Grok 5" }], default: null, cliDefault: null } },
  ], (agent) => ({ codex: "Codex", grok: "Grok" })[agent] ?? agent);
  assert.deepEqual(rows.map((row) => [row.value, row.name, row.description]), [
    ["codex ?default", "Codex", "its default model (gpt-6-luna)"],
    ["codex gpt-3", "Codex", "gpt-3, as configured"],
    ["codex ?other", "Codex", "Other model…"],
    ["grok ?default", "Grok", "its default model"],
    ["grok ?other", "Grok", "Other model…"],
  ]);
});

// A repository a chat lets its agents read (Add context: Let this chat read a repository): not the Repository row's,
// which starts a task or a run. The server checks it again and refuses what these refuse (src/api/chat.ts).
const OTHER_REPO = "/Users/owner/code/docs";
const codex = { name: "Codex", reads: true };
const chatReading = (over: Partial<NonNullable<Facts["read"]>> = {}, asked: Facts["asked"] = [codex]): Facts => ({ ...ready, read: { pick: { kind: "known", path: OTHER_REPO }, status: { state: "usable" }, ...over }, ...(asked === undefined ? {} : { asked }) });

test("a chat with a repository to read sends it with the message; with none, or in a task or run, nothing to read is sent", () => {
  assert.deepEqual(sendFor(chatReading(), extras), { do: "chat", prompt: "Add a README", model: "haiku", repository: OTHER_REPO });
  // A typed folder is sent trimmed; the server checks it again.
  assert.deepEqual(sendFor(chatReading({ pick: { kind: "other", path: `  ${OTHER_REPO} ` } }), extras), { do: "chat", prompt: "Add a README", model: "haiku", repository: OTHER_REPO });
  // None: no `repository` key at all.
  const none = sendFor({ ...chatReading(), read: { pick: { kind: "none" }, status: { state: "none" } } }, extras);
  assert.deepEqual(none, { do: "chat", prompt: "Add a README", model: "haiku" });
  assert.equal("repository" in none, false);
  assert.equal("repository" in sendFor(ready, extras), false, "a chat that never had one");
  // A repository chosen under Repository starts a task or run as before: the one to read is not part of it.
  assert.deepEqual(sendFor({ ...chatReading(), repo: { kind: "known", path: REPO }, repoStatus: { state: "usable" } }, extras), { do: "task", repo: REPO, prompt: "Add a README", model: "haiku", preapproved: ["npm test"] });
  assert.equal(blocked({ ...chatReading({ status: { state: "checking" } }), repo: { kind: "known", path: REPO }, repoStatus: { state: "usable" } }), null, "not checked for a task");
  // Come from New task or New run, there is nothing to read, and the Read a repository row is not offered.
  assert.deepEqual(blocked({ ...chatReading({ status: { state: "checking" } }), repo: { kind: "needed" } }), { reason: "Choose a repository", required: "repository" });
  const known = { reviewOffered: true, commandsKnown: true };
  assert.deepEqual(rowsFor({ repo: { kind: "none" }, kind: "task", ...known }), ["repository", "read", "models"]);
  for (const repo of [{ kind: "needed" as const }, { kind: "known" as const, path: REPO }]) assert.equal(rowsFor({ repo, kind: "task", ...known }).includes("read"), false, repo.kind);
  // An empty box still just puts the cursor in it.
  assert.deepEqual(sendFor({ ...chatReading(), text: " " }, extras), { do: "focus" });
});

test("Send waits, with the reason in words, while the repository to read is empty, being checked or refused", () => {
  assert.equal(blocked(chatReading()), null);
  assert.deepEqual(blocked(chatReading({ pick: { kind: "other", path: "  " }, status: { state: "none" } })), { reason: "Enter the full path of a git repository on this Mac for the chat to read, or choose None.", required: null });
  assert.deepEqual(blocked(chatReading({ status: { state: "checking" } })), { reason: "Checking the repository for the chat to read.", required: null });
  assert.deepEqual(blocked(chatReading({ status: { state: "refused", words: "This folder is not a git repository." } })), { reason: "This folder is not a git repository. Choose another repository for the chat to read, or choose None.", required: null });
  assert.deepEqual(sendFor(chatReading({ status: { state: "checking" } }), extras), { do: "blocked", reason: "Checking the repository for the chat to read." });
  // A check that could not be made does not stop the message: the server checks again, and its refusal is shown.
  assert.equal(blocked(chatReading({ status: { state: "unknown", words: "The path could not be checked." } })), null);
});

test("with Claude Code or an agent that cannot read a repository asked, Send waits and says the repository is read only by the other agents", () => {
  const onlyOthers = "The repository is read only by the other agents: ask only them, or choose None for the repository to read.";
  assert.deepEqual(blocked(chatReading({}, [{ name: "Claude Code", reads: false }])), { reason: `Claude Code works on a repository only as a task, in a separate copy, so a chat does not give it one. ${onlyOthers}`, required: null });
  assert.deepEqual(blocked(chatReading({}, [codex, { name: "Antigravity", reads: false }])), { reason: `Antigravity cannot read a repository: it answers from the conversation alone. ${onlyOthers}`, required: null });
  assert.equal(sendFor(chatReading({}, [codex, { name: "Claude Code", reads: false }]), extras).do, "blocked");
  // Not known yet (an older check): asked as chosen, and the server's refusal is shown if it comes.
  assert.equal(blocked(chatReading({}, [{ name: "Grok", reads: null }])), null);
  // While the agents are being checked, an agent not yet known to read waits for the answer instead.
  assert.deepEqual(blocked({ ...chatReading({}, [codex, { name: "Antigravity", reads: null }]), agentsChecking: true }), { reason: "Checking which agents can read the repository.", required: null });
  assert.equal(blocked({ ...chatReading({}, [codex]), agentsChecking: true }), null, "all known: nothing to wait for");
  assert.equal(blocked(chatReading({}, undefined)), null);
  // With nothing to read, any agent is asked as before.
  assert.equal(blocked({ ...ready, read: { pick: { kind: "none" }, status: { state: "none" } }, asked: [{ name: "Claude Code", reads: false }] }), null);
});

test("the Read a repository row names the repository or None, and its view returns to the rows unless Another folder… opens the field", () => {
  const known = [{ name: "docs", path: OTHER_REPO }];
  assert.equal(readName({ kind: "none" }, known), "None");
  assert.equal(readName({ kind: "known", path: OTHER_REPO }, known), "docs");
  assert.equal(readName({ kind: "other", path: "/Users/owner/code/notes/ " }, known), "notes");
  assert.equal(readName({ kind: "other", path: "" }, known), "Another folder");
  assert.equal(returnsToList({ view: "read", value: OTHER_REPO, run: false }), true);
  assert.equal(returnsToList({ view: "read", value: "?other", run: false }), false);
  assert.match(READ_ABOUT, /never change it: nothing in it is written, committed or pushed\.$/);
});

test("a repository to read is never remembered, nor mistaken for the repository a task starts in", () => {
  const remembered: Remembered = { repo: { kind: "none" }, kind: "task", mode: null, review: "", delivery: "branch", sameBuild: true };
  // What is written holds only what Remembered holds; nothing to read rides along.
  assert.deepEqual(Object.keys(JSON.parse(writeRemembered(remembered))).sort(), ["delivery", "kind", "mode", "repo", "review", "sameBuild"]);
  // A stored value that carries another key (an older or altered one) is still read part by part, and the key is dropped.
  const read = readRemembered(JSON.stringify({ ...remembered, read: { kind: "known", path: OTHER_REPO }, repository: OTHER_REPO }));
  assert.deepEqual(read, remembered);
  assert.equal("read" in read, false);
});

test("Builder is a row of a task and a run only once Codex can build; choosing Codex sends it as the builder, on its own default model, and Claude Code still plans", () => {
  const known = { reviewOffered: false, commandsKnown: false };
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "task", ...known, builderOffered: true }), ["repository", "kind", "builder", "mode", "models"]);
  assert.deepEqual(rowsFor({ repo: { kind: "known", path: REPO }, kind: "run", ...known, builderOffered: true }).slice(0, 3), ["repository", "kind", "builder"]);
  assert.equal(rowsFor({ repo: { kind: "known", path: REPO }, kind: "task", ...known }).includes("builder"), false);
  assert.equal(rowsFor({ repo: { kind: "none" }, kind: "task", ...known, builderOffered: true }).includes("builder"), false, "a chat has no builder");
  assert.deepEqual(sendFor(inRepo(), { ...extras, builder: "codex" }), { do: "task", repo: REPO, prompt: "Add a README", model: undefined, preapproved: ["npm test"], agent: "codex" });
  assert.deepEqual(sendFor(inRepo(), { ...extras, builder: null }), { do: "task", repo: REPO, prompt: "Add a README", model: "haiku", preapproved: ["npm test"] });
  const run = sendFor(inRepo({ kind: "run", buildModel: { ok: true, model: "sonnet" } }), { ...extras, builder: "codex" });
  assert.equal(run.do, "run");
  assert.ok(run.do === "run" && run.agent === "codex" && run.model === "haiku" && !("buildModel" in run), JSON.stringify(run));
  assert.equal(builderName(null), "Claude Code");
  assert.equal(builderName("codex"), "Codex");
});

test("the agents' check says which agent other than Claude Code can build, and a list kept on the device never does", () => {
  const offered = chatOffer([
    { agent: "claude-code", roles: ["planner", "builder"], installed: true, version: "2", supported: true, signedIn: true, billing: "subscription", problem: null },
    { agent: "codex", roles: ["reviewer", "builder"], installed: true, version: "0.171.0", supported: true, signedIn: true, billing: "subscription", problem: null },
    { agent: "grok", roles: ["reviewer"], installed: true, version: "1", supported: true, signedIn: true, billing: "subscription", problem: null },
  ]);
  assert.deepEqual(offered.map((a) => [a.agent, a.builds ?? false]), [["claude-code", false], ["codex", true], ["grok", false]]);
  assert.equal(readKnownAgents(JSON.stringify(offered))!.some((a) => a.builds === true), false);
});
