import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createBroker } from "../../src/approvals/broker.ts";
import { loadConfig, repositoryCommands } from "../../src/config.ts";
import { chromeRules, seatbeltProfile } from "../../src/confinement.ts";
import { matchingFiles, machineChecksProblem, patternExpression, runMachineCheck, shellWord, type MachineCheck } from "../../src/engine/machine-checks.ts";
import { runCommand, taskEvidence, userTempDir, type StationCommand } from "../../src/engine/stations.ts";
import { createTask, createTasks, getTask } from "../../src/engine/task.ts";
import { taskCheckFixes } from "../../src/engine/check-fix.ts";
import { openStore } from "../../src/store/db.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { buildReplayDriver } from "../support/replay-build.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// Checks that need the real machine (#201): commands the owner lists that need what a check's sandbox does not give,
// run by Botbench itself after the checks, each allowed only what it names. Real sandbox-exec, real Chrome where this
// Mac has it, real temporary repositories, real SQLite; the builder's turns are replayed from real Claude Code sessions.

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NO_CHROME = NO_SANDBOX || (fs.existsSync(CHROME) ? false : `this Mac has no Google Chrome at ${CHROME}, so a check that starts it cannot run here. Install Chrome to test this.`);
const NESTED = "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true && echo nested sandbox started";
const cmd = (command: string): StationCommand => ({ command, limitMs: 60_000 });
const machine = (command: string, needs: MachineCheck["machine"]["needs"], files: string[] = []): MachineCheck => ({ command, limitMs: 120_000, machine: { needs, files } });

async function copy(t: TestContext): Promise<{ dir: string; dataDir: string; worktree: string; decoy: string }> {
  const dir = tempDir("botbench-machine-checks-");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  const dataDir = path.join(dir, "home");
  fs.mkdirSync(dataDir);
  const decoy = path.join(dataDir, "decoy-login-token");
  fs.writeFileSync(decoy, "DECOY-not-for-checks\n");
  const { path: worktree } = await createWorktree({ repo, home: dataDir, run: "run-1", task: "task-1" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, dataDir, worktree, decoy };
}

test("the settings: a machine check names what it needs and, for {files}, the patterns it is filled from; anything else is refused, naming the setting", () => {
  assert.equal(machineChecksProblem([{ command: "npm run e2e -- {files}", needs: ["chrome"], files: ["e2e/*.e2e.ts", "e2e/**/*.desktop.ts"], timeoutSeconds: 1800 }, { command: "npm test", needs: ["nested-sandbox"] }]), null);
  const refused: [unknown, RegExp][] = [
    ["npm test", /must be a list of entries/],
    [[{ command: "npm test" }], /"needs" is not a list/],
    [[{ command: "npm test", needs: [] }], /"needs" is not a list/],
    [[{ command: "npm test", needs: ["network"] }], /"needs" is not a list/],
    [[{ command: "npm test", needs: ["chrome", "chrome"] }], /each once/],
    [[{ command: " ", needs: ["chrome"] }], /no "command"/],
    [[{ command: "npm run e2e -- {files}", needs: ["chrome"] }], /holds \{files\} but no "files"/],
    [[{ command: "npm run e2e", needs: ["chrome"], files: ["e2e/*.ts"] }], /no \{files\} to put them in/],
    [[{ command: "x {files}", needs: ["chrome"], files: ["../outside/*.ts"] }], /cannot be used/],
    [[{ command: "x {files}", needs: ["chrome"], files: ["/abs/*.ts"] }], /cannot be used/],
    [[{ command: "x {files}", needs: ["chrome"], files: ["e2e/[ab].ts"] }], /cannot be used/],
    [[{ command: "npm test", needs: ["chrome"], timeoutSeconds: 0 }], /"timeoutSeconds"/],
    [[{ command: "npm test", needs: ["chrome"], sandbox: false }], /unknown setting "sandbox"/],
  ];
  for (const [list, words] of refused) assert.match(machineChecksProblem(list) ?? "", words, JSON.stringify(list));

  // Read from the settings file beside "checks", into the commands Botbench runs.
  const dir = tempDir("botbench-machine-config-");
  const local = path.join(dir, "local.json");
  const defaults = path.join(dir, "defaults.json");
  fs.writeFileSync(defaults, JSON.stringify({ port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: { implementer: { driver: "claude-code" } } }));
  fs.writeFileSync(local, JSON.stringify({ repositories: { [dir]: { checks: ["npm test"], machineChecks: [{ command: "npm run e2e -- {files}", needs: ["chrome"], files: ["e2e/*.e2e.ts"], timeoutSeconds: 900 }] } } }));
  const config = loadConfig({ defaults, local });
  assert.deepEqual(repositoryCommands(config, dir).machineChecks, [{ command: "npm run e2e -- {files}", limitMs: 900_000, machine: { needs: ["chrome"], files: ["e2e/*.e2e.ts"] } }]);
  fs.writeFileSync(local, JSON.stringify({ repositories: { [dir]: { machineChecks: [{ command: "npm test", needs: ["root"] }] } } }));
  assert.throws(() => loadConfig({ defaults, local }), /"machineChecks" has an entry whose "needs"/);
});

test("{files} is filled from the change's own files, by pattern, each quoted so that no name is run or read as an option", () => {
  assert.ok(patternExpression("e2e/*.e2e.ts").test("e2e/task.e2e.ts"));
  assert.equal(patternExpression("e2e/*.e2e.ts").test("e2e/deep/task.e2e.ts"), false);
  assert.ok(patternExpression("e2e/**/*.e2e.ts").test("e2e/deep/er/task.e2e.ts"));
  assert.ok(patternExpression("e2e/**/*.e2e.ts").test("e2e/task.e2e.ts"));
  assert.equal(patternExpression("e2e/*.e2e.ts").test("e2exe2e.ts"), false, "a dot is a dot");
  const changed = [
    { path: "e2e/b.e2e.ts", status: "modified" },
    { path: "e2e/a.e2e.ts", status: "added" },
    { path: "e2e/gone.e2e.ts", status: "deleted" },
    { path: "src/x.ts", status: "modified" },
    { path: "e2e/new\nline.e2e.ts", status: "added" },
  ];
  assert.deepEqual(matchingFiles(changed, ["e2e/*.e2e.ts"]), ["e2e/a.e2e.ts", "e2e/b.e2e.ts"]);

  // A hostile name reaches the shell as one word: nothing in it runs, and it does not start with "-".
  const dir = tempDir("botbench-shell-word-");
  const hostile = `-x$(touch ${dir}/pwned)';touch ${dir}/pwned2;'.e2e.ts`;
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${shellWord(hostile)} ${shellWord("e2e/a b.e2e.ts")}`], { encoding: "utf8" });
  assert.equal(out, `./${hostile}\n./e2e/a b.e2e.ts\n`);
  assert.equal(fs.existsSync(path.join(dir, "pwned")) || fs.existsSync(path.join(dir, "pwned2")), false);
});

test("a command that starts a sandbox of its own fails in a check's sandbox, as macOS refuses it there, and passes as a machine check that needs nested-sandbox", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await copy(t);
  const confinement = { dataDir: l.dataDir, allowedHosts: [] };
  const asCheck = await runCommand({ command: NESTED, cwd: l.worktree, limitMs: 30_000, confinement });
  assert.equal(asCheck.outcome, "failed");
  assert.match(asCheck.output, /sandbox_apply: Operation not permitted/);
  const asMachine = await runCommand({ command: NESTED, cwd: l.worktree, limitMs: 30_000, confinement, profile: "unconfined" });
  assert.equal(asMachine.outcome, "passed", asMachine.output);
  assert.match(asMachine.output, /nested sandbox started/);
  // It still gets a check's environment: no provider key reaches it.
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-not-for-checks";
  t.after(() => (before === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = before)));
  const env = await runCommand({ command: "printenv ANTHROPIC_API_KEY || echo no key; echo tmp=$TMPDIR", cwd: l.worktree, limitMs: 30_000, confinement, profile: "unconfined" });
  assert.match(env.output, /^no key\ntmp=.*botbench-command-/);
});

test("headless Chrome cannot start in a check's sandbox; as a machine check that needs chrome it starts, and the check's other rules still hold", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const l = await copy(t);
  const confinement = { dataDir: l.dataDir, allowedHosts: [] };
  const chrome = `'${CHROME}' --headless=new --no-sandbox --no-first-run --disable-gpu --user-data-dir="$TMPDIR/profile" --dump-dom 'data:text/html,<p>machine-check-ok</p>' 2>/dev/null`;
  const asCheck = await runCommand({ command: chrome, cwd: l.worktree, limitMs: 60_000, confinement });
  assert.equal(asCheck.output.includes("machine-check-ok"), false, "Chrome does not start under a check's profile");
  const asMachine = await runCommand({ command: chrome, cwd: l.worktree, limitMs: 60_000, confinement, profile: "chrome" });
  assert.match(asMachine.output, /<p>machine-check-ok<\/p>/);
  // Botbench's data folder stays unreadable, and nothing outside the copy, its temporary folder and Chrome's own lock
  // folders may be written.
  const denied = await runCommand({ command: `cat '${l.decoy}'`, cwd: l.worktree, limitMs: 30_000, confinement, profile: "chrome" });
  assert.equal(denied.outcome, "failed");
  assert.equal(denied.output.includes("DECOY"), false);
  const outside = path.join(userTempDir(), `botbench-not-chrome-${process.pid}`);
  const wrote = await runCommand({ command: `mkdir '${outside}'`, cwd: l.worktree, limitMs: 30_000, confinement, profile: "chrome" });
  assert.equal(wrote.outcome, "failed");
  assert.equal(fs.existsSync(outside), false);
  // The rules name only Chrome's and Chromium's folders in the user's temporary folder.
  const rules = chromeRules(userTempDir());
  assert.equal(rules.length, 3);
  for (const rule of rules) assert.match(rule, /\(com\\\\?\.google\\\\?\.Chrome\|org\\\\?\.chromium\\\\?\.Chromium\)/);
  assert.ok(seatbeltProfile({ worktree: l.worktree, unreadable: [], writable: [], chrome: { userTemp: userTempDir() } }).endsWith(`${rules.join("\n")}\n`));
});

test("Botbench does not run a machine check where it cannot, and says why: a run that read outside text never runs one outside the sandbox", { skip: NO_SANDBOX }, async (t) => {
  const l = await copy(t);
  const db = openStore(path.join(l.dir, "store"));
  t.after(() => db.close());
  const task = createTask(db, { repo: path.join(l.dir, "repo"), prompt: "x" });
  const base = git(l.worktree, "rev-parse", "HEAD").trim();
  const at = { repo: path.join(l.dir, "repo"), baseCommit: base, headCommit: base, worktreePath: l.worktree };
  const track = (position: number) => ({ db, taskId: task.id, kind: "check" as const, round: 1, position });
  const confinement = { dataDir: l.dataDir, allowedHosts: [] };
  const outside = await runMachineCheck({ check: machine(NESTED, ["nested-sandbox"]), task: at, confinement, container: null, outsideText: true, unconfinable: null, track: track(1) });
  assert.equal(outside.outcome, "not_run");
  assert.match(outside.output, /runs outside any sandbox, with your own rights, and this task's run read outside text/);
  const container = await runMachineCheck({ check: machine("npm run e2e", ["chrome"]), task: at, confinement, container: { id: "x" } as never, outsideText: false, unconfinable: null, track: track(2) });
  assert.match(container.output, /run in a container/);
  const linux = await runMachineCheck({ check: machine("npm run e2e", ["chrome"]), task: at, confinement, container: null, outsideText: false, unconfinable: "Botbench keeps the commands an agent runs away from your sign-ins and the network only on macOS, and this computer runs linux.", track: track(3) });
  assert.match(linux.output, /only on macOS/);
  const nothing = await runMachineCheck({ check: machine("npm run e2e -- {files}", ["chrome"], ["e2e/*.e2e.ts"]), task: at, confinement, container: null, outsideText: false, unconfinable: null, track: track(4) });
  assert.equal(nothing.outcome, "skipped");
  assert.match(nothing.output, /this change touches no file that e2e\/\*\.e2e\.ts names/);
  assert.deepEqual(taskEvidence(db, task.id).map((row) => `${row.position}:${row.outcome}:${row.needs}`), ["1:not_run:nested-sandbox", "2:not_run:chrome", "3:not_run:chrome", "4:skipped:chrome"]);
});

test("in a task: the machine checks run after the checks in the same round, {files} filled from the change; a failing one goes back to the builder as a round of fixes, and the checks run again", { skip: NO_SANDBOX, timeout: 120_000 }, async (t) => {
  const dir = tempDir("botbench-machine-task-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Calculator\n" });
  const broker = createBroker({ db, home, onChange: () => {} });
  await broker.listen();
  // The build leaves calc.py subtracting; the recorded "refine" turn makes it add.
  const builder = buildReplayDriver(["done", "refine"]);
  const tasks = createTasks({
    db, home, driver: builder, broker, model: "haiku", checkFixRounds: 1,
    repoCommands: () => ({
      setup: [cmd("printf 'def add(a, b):\\n    return a - b\\n' > calc.py")],
      checks: [cmd("test -f calc.py")],
      machineChecks: [
        machine("grep -c return {files}", ["chrome"], ["*.py"]),
        machine("echo {files}", ["chrome"], ["e2e/*.e2e.ts"]),
        machine(`${NESTED} && grep -q 'a + b' calc.py`, ["nested-sandbox"]),
      ],
    }),
    onEvent: () => {}, onTaskChange: () => {},
  });
  t.after(async () => {
    await tasks.close();
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const started = await tasks.start(repo, "Add a function that adds two numbers");
  await tasks.idle();
  const task = getTask(db, started.id)!;
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  const rows = taskEvidence(db, task.id).filter((row) => row.kind === "check");
  assert.deepEqual(rows.map((row) => `${row.round}:${row.position}:${row.outcome}:${row.needs ?? "check"}:${row.command}`), [
    "1:1:passed:check:test -f calc.py",
    "1:2:passed:chrome:grep -c return './calc.py'",
    "1:3:skipped:chrome:echo {files}",
    `1:4:failed:nested-sandbox:${NESTED} && grep -q 'a + b' calc.py`,
    "2:1:passed:check:test -f calc.py",
    "2:2:passed:chrome:grep -c return './calc.py'",
    "2:3:skipped:chrome:echo {files}",
    `2:4:passed:nested-sandbox:${NESTED} && grep -q 'a + b' calc.py`,
  ]);
  assert.equal(task.checks, "passed", "a check with nothing to run is not a failure");
  assert.equal(builder.started.length, 2, "the failing machine check went back to the builder");
  assert.ok(builder.prompts[1]!.includes(`<check-command>\n${NESTED} && grep -q 'a + b' calc.py\n</check-command>`), builder.prompts[1]);
  assert.deepEqual(taskCheckFixes(db, task.id).map((fix) => `${fix.round}:${fix.outcome}:${fix.changed}`), ["1:finished:true"]);
});
