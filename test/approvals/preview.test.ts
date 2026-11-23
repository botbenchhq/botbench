import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { appendLog } from "../../src/approvals/broker.ts";
import { MAX_ENTRY, insertStanding, realRepo } from "../../src/approvals/grants.ts";
import { commandProblem, previewCommand, type ModePreview } from "../../src/approvals/preview.ts";
import { createTask } from "../../src/engine/task.ts";
import { setAskEveryCommand } from "../../src/engine/modes.ts";
import { openStore } from "../../src/store/db.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { bannedIn } from "../../e2e/voice.ts";

// What a command would get in each mode, asked of the gate itself with a real store and a real repository. No driver
// is started and nothing is asked of anyone: the preview only reads.

type T = { after(fn: () => unknown): void };

function setup(t: T) {
  const dir = tempDir("botbench-preview-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const db = openStore(home);
  t.after(() => db.close());
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const settings = { home: path.join(dir, "owner"), dataDir: home };
  const ask = (command: string, preapproved: string[] = [], extra = {}): ModePreview[] => previewCommand(db, { settings: { ...settings, ...extra }, repo, preapproved, command });
  return { db, repo, ask };
}

const byMode = (modes: ModePreview[]): Record<string, ModePreview> => Object.fromEntries(modes.map((m) => [m.mode, m]));

test("`git push` asks in semi-autonomous mode, naming the always-ask rule git-push", (t) => {
  const { ask } = setup(t);
  const semi = byMode(ask("git push")).semi!;
  assert.equal(semi.verdict, "ask");
  assert.equal(semi.rule, "floor");
  assert.equal(semi.floor, "git-push");
  assert.equal(semi.words, "Asks you. On the always-ask list: it sends commits to another computer.");
});

test("a fully autonomous run refuses what would ask, and still names the rule", (t) => {
  const { ask } = setup(t);
  const modes = ask("git push origin main");
  assert.deepEqual(modes.map((m) => [m.mode, m.verdict, m.floor]), [["manual", "ask", "git-push"], ["semi", "ask", "git-push"], ["full", "refuse", "git-push"]]);
  const full = byMode(modes).full!;
  assert.equal(full.rule, "floor");
  assert.equal(full.words, "Refused: a fully autonomous run asks you nothing, so what would ask is not run. On the always-ask list: it sends commits to another computer.");
});

test("`npm test` that the repository's settings allow runs without asking in every mode, naming that rule", (t) => {
  const { ask } = setup(t);
  for (const m of ask("npm test", ["npm test"])) {
    assert.equal(m.verdict, "allow", m.mode);
    assert.equal(m.rule, "preapproved", m.mode);
    assert.deepEqual(m.grant, { kind: "preapproved", command: "npm test" }, m.mode);
    assert.equal(m.floor, undefined, m.mode);
    assert.equal(m.words, "Runs without asking: this repository's settings offer npm test as an allowed command for each task.", m.mode);
  }
  // With further arguments it is still the listed command, as for a task started with it.
  assert.ok(ask("npm test -- a.test.ts", ["npm test"]).every((m) => m.rule === "preapproved"));
});

test("a confined command nobody listed runs without asking by its mode; a chained one too unless a piece of it is named", (t) => {
  const { ask } = setup(t);
  for (const m of ask("ls src")) {
    assert.deepEqual([m.verdict, m.rule, m.grant, m.floor], ["allow", "mode_confined", undefined, undefined], m.mode);
    assert.equal(m.words, "Runs without asking: it runs kept in the task's copy, and the safety rules do not name it.");
  }
  assert.ok(ask("npm test && ls", ["npm test"]).every((m) => m.rule === "mode_confined"), "a chained command never runs on a listed command");
  assert.deepEqual(ask("ls && git push").map((m) => m.verdict), ["ask", "ask", "refuse"]);
});

test("the safety rules win over a listed command, and over a command the owner added to them", (t) => {
  const { ask } = setup(t);
  assert.deepEqual(ask("git push", ["git push"]).map((m) => [m.verdict, m.floor, m.grant]), [["ask", "git-push", undefined], ["ask", "git-push", undefined], ["refuse", "git-push", undefined]]);
  const added = ask("make deploy", ["make deploy"], { extra: [{ name: "make-deploy", words: ["make", "deploy"] }] });
  assert.deepEqual(added.map((m) => [m.verdict, m.floor]), [["ask", "make-deploy"], ["ask", "make-deploy"], ["refuse", "make-deploy"]]);
  assert.equal(added[0]!.words, "Asks you. On the always-ask list: make-deploy.");
});

test("an Always allow read from the store covers its command; another run's allowed commands do not", (t) => {
  const { db, repo, ask } = setup(t);
  // A task started with `make lint` allowed: its run's grant is for that run only.
  const task = createTask(db, { repo, prompt: "lint", preapproved: ["make lint"] });
  assert.ok(ask("make lint").every((m) => m.rule === "mode_confined"), "another run's allowed command is not this one's");
  // An Always allow the owner gave from a card, with the log entry that makes it stand.
  const id = insertStanding(db, { role: "implementer", repo: realRepo(repo), cwd: ".", words: ["make", "build"], taskId: task.id });
  appendLog(db, { taskId: task.id, runId: task.runId, attemptId: null, grantId: id, rule: "standing_granted", tool: "Bash", command: "make build", cwd: "." });
  for (const m of ask("make build")) {
    assert.deepEqual([m.verdict, m.rule, m.grant], ["allow", "standing", { kind: "standing", command: "make build" }], m.mode);
    assert.equal(m.words, "Runs without asking: you chose Always allow for make build.");
  }
  // Only the exact command: a longer one runs by its mode.
  assert.ok(ask("make build fast").every((m) => m.rule === "mode_confined"));
});

test("Ask before every command makes a Manual command ask, unless it is listed; the other modes are not changed", (t) => {
  const { db, ask } = setup(t);
  setAskEveryCommand(db, true);
  assert.deepEqual(ask("ls").map((m) => [m.mode, m.verdict, m.rule]), [["manual", "ask", "every_command"], ["semi", "allow", "mode_confined"], ["full", "allow", "mode_confined"]]);
  assert.equal(ask("ls")[0]!.words, "Asks you. Ask before every command is on in Settings.");
  assert.deepEqual(ask("npm test", ["npm test"]).map((m) => m.rule), ["preapproved", "preapproved", "preapproved"]);
});

test("a listed entry that could never be allowed for a task is left out, as a task's start refuses it", (t) => {
  const { ask } = setup(t);
  assert.ok(ask("sh", ["sh"]).every((m) => m.rule !== "preapproved"));
});

test("every line the check sends a screen keeps to the glossary", (t) => {
  const { db, ask } = setup(t);
  const lines = [
    ...["git push", "ls", "ls && git push", "rm -rf /", "cat ~/.ssh/id_rsa"].flatMap((command) => ask(command).map((m) => m.words)),
    ...ask("npm test", ["npm test"]).map((m) => m.words),
    ...["", "a".repeat(MAX_ENTRY + 1), "ls\0"].map((command) => commandProblem(command)!),
  ];
  setAskEveryCommand(db, true);
  lines.push(...ask("ls").map((m) => m.words));
  for (const line of lines) assert.deepEqual(bannedIn(line), [], line);
});

test("an empty command, one over the limit and one holding NUL are refused in words before the gate is asked", (t) => {
  const { ask } = setup(t);
  assert.equal(commandProblem(""), "Give a command to check.");
  assert.equal(commandProblem("   "), "Give a command to check.");
  assert.equal(commandProblem("a".repeat(MAX_ENTRY + 1)), `The command is too long to check: ${MAX_ENTRY} characters at most.`);
  assert.equal(commandProblem("ls\0"), "The command holds a NUL character, which no shell can be handed, so it cannot be checked.");
  assert.equal(commandProblem("a".repeat(MAX_ENTRY)), null);
  // Asked anyway, it gives no verdict: it throws with the same words.
  for (const command of ["", "a".repeat(MAX_ENTRY + 1), "ls\0"]) assert.throws(() => ask(command), { message: commandProblem(command)! });
});
