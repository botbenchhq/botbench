import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { actionLog, createBroker, listApprovals, type Answer, type Approval, type Broker } from "../../src/approvals/broker.ts";
import { askBroker } from "../../src/approvals/permission-proxy.ts";
import { toolResultsFolder } from "../../src/drivers/claude-code.ts";
import { capIssue, storeIssue } from "../../src/engine/intake.ts";
import type { RunMode } from "../../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { parseIssueView } from "../../src/github.ts";
import { openStore } from "../../src/store/db.ts";
import { ISSUE_NUMBER, ISSUE_REPO, loadIssueCapture } from "../support/replay-issue.ts";
import { tempDir } from "../support/repo.ts";

// The shapes the owner saw asked about in a Semi-autonomous run that read a GitHub issue (Outside text), each put through
// the real gate the way an attempt's CLI puts it: the pre-tool hook over the broker's real socket first, then the CLI's
// own permission request. Real SQLite, real files and links, no model: the requests are the CLI's, written out.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  broker: Broker;
  dir: string;
  /** Claude Code's configuration folder for these attempts. */
  config: string;
}

/** The session the attempt's CLI reported, as Claude Code writes one. */
const SESSION = "4c1d8a52-7d0e-4a8b-9f43-2a51d3b1c6e0";
const OTHER_SESSION = "9b0e2f17-3c44-4d1a-8e65-0f7a2c9d4b11";

async function rig(t: T): Promise<Rig> {
  const dir = tempDir("botbench-shapes-");
  const home = path.join(dir, "home");
  const config = path.join(dir, "claude-config");
  const db = openStore(home);
  // The same function the server gives the broker, pointed at this test's configuration folder.
  const broker = createBroker({ db, home, onChange: () => {}, sessionOutput: ({ driver, session, worktree }) => (driver === "claude-code" ? toolResultsFolder({ cwd: worktree, session, configDir: config }) : null) });
  await broker.listen();
  t.after(async () => {
    await broker.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, broker, dir, config };
}

let n = 0;
/** A task of a run in `mode` with a builder admitted in its copy; `outside` marks the run as having read a GitHub issue. */
function agent(r: Rig, mode: RunMode, o: { outside?: boolean; confined?: boolean } = {}) {
  const worktree = path.join(r.dir, `worktree-${++n}`);
  fs.mkdirSync(path.join(worktree, "sub", "deeper"), { recursive: true });
  const top = fs.realpathSync(worktree);
  const repo = path.join(r.dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const issue = o.outside === true ? storeIssue(r.db, fs.realpathSync(repo), capIssue(parseIssueView(loadIssueCapture().outputs.issue.result.stdout, ISSUE_REPO, ISSUE_NUMBER), "github.com/cli/cli")) : null;
  const run = createRun(r.db, { repo, prompt: "p", baseCommit: "0".repeat(40), mode, ...(issue === null ? {} : { issue: { fetchId: issue.id, allowHosts: false } }) });
  const stored = storePlan(r.db, run.id, [{ title: "t", criteria: ["c"] }]);
  const taskId = approvePlan(r.db, run.id, stored.planVersion, null, mode === "full" ? "mode" : "owner").tasks[0]!.id;
  const attemptId = Number(r.db.prepare("INSERT INTO attempts (driver, resume_cursor, status, created_at, updated_at) VALUES ('claude-code', ?, 'running', 'now', 'now')").run(SESSION).lastInsertRowid);
  const admission = r.broker.admit({ taskId, role: "implementer", worktree, confined: o.confined !== false });
  admission.bind(attemptId);
  /** What the hook hears for one call, made from `cwd` (a full path). */
  const hook = (tool: string, input: Record<string, unknown>, toolCallId: string, cwd = top) => askBroker(admission.socketPath, admission.secret, { tool_name: tool, tool_input: input, tool_use_id: toolCallId, cwd });
  /** The CLI's own permission request for a call, after its hook, as the engine puts it to the broker. Whatever waits for the owner is answered no. */
  const request = async (tool: string, input: Record<string, unknown>, toolCallId: string): Promise<{ answer: Answer; card: Approval | undefined }> => {
    const command = tool === "Bash" && typeof input.command === "string" && Object.keys(input).every((k) => k === "command" || k === "description") ? input.command : tool === "Read" && Object.keys(input).length === 1 ? String(input.file_path) : JSON.stringify(input);
    const answer = r.broker.request({ taskId, attemptId, role: "implementer", tool, command, input, reason: null, toolCallId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const card = listApprovals(r.db, "pending").find((a) => a.toolCallId === toolCallId);
    for (const pending of listApprovals(r.db, "pending")) r.broker.answer(pending.id, "decline");
    return { answer: await answer, card };
  };
  const ask = async (tool: string, input: Record<string, unknown>, toolCallId: string, cwd = top) => {
    const heard = await hook(tool, input, toolCallId, cwd);
    return { heard, ...(await request(tool, input, toolCallId)) };
  };
  return { taskId, top, ask, hook, request };
}

const rulesOf = (r: Rig, taskId: number): string[] => actionLog(r.db, taskId).map((entry) => entry.rule);

/** Read-only shell commands the owner saw asked about in Semi-autonomous, each with the description the CLI sends. */
const SHAPES = [
  `grep -n "startServer\\|createBroker" src/server.ts`,
  `grep -rn 'mode_allowed\\|byMode' src test`,
  `grep -n "admit(" src/engine/*.ts`,
  `ls src 2>/dev/null`,
  `cat docs/notes.md 2>/dev/null || echo none`,
  `for f in src/a.ts docs/b.md; do test -e "$f" && echo "$f yes" || echo "$f no"; done`,
  `for f in src/a.ts docs/b.md; do [ -e "$f" ] && echo "$f"; done`,
  `sed -n '1,40p' src/approvals/gate.ts`,
  `sed -n 1,40p src/approvals/gate.ts`,
  `ls`,
  `ls -la`,
  `ls docs/security`,
];

test("semi-autonomous, outside text: grep with \\|, a command ending in 2>/dev/null, a for loop testing paths, sed -n and ls run confined without asking, and each is logged", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi", { outside: true });
  let i = 0;
  for (const command of SHAPES) {
    for (const cwd of [a.top, path.join(a.top, "sub")]) {
      const { heard, answer } = await a.ask("Bash", { command, description: "Look around" }, `call-${++i}`, cwd);
      assert.equal(heard.verdict, "ask", "the hook never lets a command pass on its own");
      assert.deepEqual([answer.decision, answer.byMode, answer.approvalId], ["allow", "semi", null], `${command} from ${path.relative(a.top, cwd) || "."}`);
    }
  }
  assert.equal(listApprovals(r.db).length, 0, "nothing was put to the owner");
  const log = actionLog(r.db, a.taskId);
  assert.deepEqual(log.map((e) => e.rule), Array(SHAPES.length * 2).fill("mode_allowed"));
  assert.deepEqual(log.map((e) => e.command), SHAPES.flatMap((command) => [command, command]));
  assert.deepEqual(log.map((e) => e.cwd), SHAPES.flatMap(() => [".", "sub"]), "each is logged with the folder it ran in");
});

test("semi-autonomous, outside text: a command on the always-ask list and an unconfined one still ask, each card saying why; manual asks about the shapes above", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi", { outside: true });
  const push = await a.ask("Bash", { command: "git push origin HEAD" }, "push");
  assert.ok(push.answer.approvalId !== null);
  assert.equal(push.card?.asksBecause, "On the always-ask list: it sends commits to another computer.");
  const secrets = await a.ask("Bash", { command: "ls ~/.ssh 2>/dev/null" }, "secrets");
  assert.equal(secrets.card?.asksBecause, "On the always-ask list: it reaches your sign-ins, settings, home folder or Botbench's own files.");
  const keychain = await a.ask("Bash", { command: "security find-generic-password -s x" }, "keychain");
  assert.match(keychain.card?.asksBecause ?? "", /^On the always-ask list: /);
  const named = await a.ask("Bash", { command: `ls; "$PROGRAM" src` }, "named");
  assert.equal(named.card?.asksBecause, "On the always-ask list: Botbench cannot read from the command which program it runs.");
  const escape = await a.ask("Bash", { command: "ls", dangerouslyDisableSandbox: true }, "escape");
  assert.equal(escape.card?.asksBecause, "It could not be shown to run kept away from your sign-ins and the network.");
  // An attempt whose driver does not confine its commands: the mode lets nothing of it run.
  const loose = agent(r, "semi", { outside: true, confined: false });
  const unconfined = await loose.ask("Bash", { command: "ls" }, "loose");
  assert.equal(unconfined.card?.asksBecause, "It could not be shown to run kept away from your sign-ins and the network.");
  // A request the hook never heard of cannot be tied to the call that was checked.
  const unheard = await a.request("Bash", { command: "ls" }, "unheard");
  assert.equal(unheard.card?.asksBecause, "Botbench could not match it to the request it checked.");
  assert.deepEqual([push, secrets, keychain, named, escape, unconfined, unheard].map((x) => x.answer.byMode), Array(7).fill(undefined));

  const manual = agent(r, "manual", { outside: true });
  let i = 0;
  for (const command of SHAPES) {
    const { answer, card } = await manual.ask("Bash", { command }, `manual-${++i}`);
    assert.ok(answer.approvalId !== null, command);
    assert.equal(card?.asksBecause, "In Manual mode every command asks you.", command);
    assert.equal(card?.cwd, ".", command);
  }
  assert.deepEqual(rulesOf(r, manual.taskId), SHAPES.flatMap(() => ["asked_owner", "owner_declined"]));
});

test("a Write or an Edit inside the task's copy never asks, in any mode, also from a sub-folder; outside the copy it asks, or is refused when fully autonomous", async (t) => {
  const r = await rig(t);
  for (const mode of ["manual", "semi", "full"] as const) {
    const a = agent(r, mode);
    const sub = path.join(a.top, "sub");
    const inside = [
      ["Write", { file_path: path.join(a.top, "README.md"), content: "x" }],
      ["Edit", { file_path: path.join(a.top, "src", "a.ts"), old_string: "a", new_string: "b" }],
      ["Write", { file_path: path.join(sub, "deeper", "new.txt"), content: "x" }],
      ["Edit", { file_path: "deeper/rel.ts", old_string: "a", new_string: "b" }],
    ] as const;
    let i = 0;
    for (const [tool, input] of inside) {
      // The agent moved into sub/ and the CLI asked anyway, its own rule being narrower than the copy.
      const { heard, answer } = await a.ask(tool, input, `${mode}-in-${++i}`, sub);
      assert.equal(heard.verdict, "pass", `${mode} ${tool} ${input.file_path}`);
      assert.deepEqual([answer.decision, answer.files, answer.approvalId, answer.refused], ["allow", true, null, null], `${mode} ${tool} ${input.file_path}`);
    }
    // Each edit is logged twice: as the hook let it pass, and as Botbench let the CLI's request for it through.
    assert.deepEqual(actionLog(r.db, a.taskId).map((e) => [e.rule, e.command, e.cwd]), inside.flatMap(([, input]) => {
      const file = path.relative(a.top, path.resolve(sub, input.file_path));
      return [["auto_worktree_edit", file, "sub"], ["auto_worktree_edit", file, "sub"]];
    }));

    const elsewhere = path.join(r.dir, "elsewhere.txt");
    const outside = await a.ask("Write", { file_path: elsewhere, content: "x" }, `${mode}-out`, sub);
    assert.equal(outside.heard.verdict, "ask");
    if (mode === "full") {
      assert.deepEqual([outside.answer.decision, outside.answer.approvalId], ["decline", null]);
      assert.match(outside.answer.refused!, /Write was refused/);
    } else {
      assert.ok(outside.answer.approvalId !== null, mode);
      assert.deepEqual([outside.card?.target, outside.card?.cwd, outside.card?.asksBecause], [elsewhere, "sub", "Outside the task's copy."]);
    }
    // Git's own folder in the copy is not an ordinary file, in any mode.
    const git = await a.ask("Edit", { file_path: path.join(a.top, ".git", "config"), old_string: "a", new_string: "b" }, `${mode}-git`, sub);
    if (mode === "full") assert.ok(git.answer.refused !== null);
    else assert.equal(git.card?.asksBecause, "It changes git's own files or Claude Code's settings in the task's copy.");
  }
  assert.ok(!fs.existsSync(path.join(r.dir, "elsewhere.txt")), "nothing here writes a file: the CLI would, once allowed");
});

test("each card shows the folder its own call was made from, after the agent moved into a sub-folder and back, whatever order the requests come in", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi");
  const sub = path.join(a.top, "sub");
  // The calls as the hook records them, one by one: into sub/, a push from there, back out, a push from the top, a
  // write outside from the top, and a read outside from deeper/.
  await a.hook("Bash", { command: "cd sub" }, "c1", a.top);
  await a.hook("Bash", { command: "git push origin HEAD" }, "c2", sub);
  await a.hook("Bash", { command: "cd .." }, "c3", sub);
  await a.hook("Bash", { command: "git push origin HEAD" }, "c4", a.top);
  await a.hook("Write", { file_path: path.join(r.dir, "out.txt"), content: "x" }, "c5", a.top);
  await a.hook("Read", { file_path: path.join(r.dir, "notes.txt") }, "c6", path.join(sub, "deeper"));
  // The CLI's requests come later, and not in order.
  const c4 = await a.request("Bash", { command: "git push origin HEAD" }, "c4");
  const c6 = await a.request("Read", { file_path: path.join(r.dir, "notes.txt") }, "c6");
  const c2 = await a.request("Bash", { command: "git push origin HEAD" }, "c2");
  const c5 = await a.request("Write", { file_path: path.join(r.dir, "out.txt"), content: "x" }, "c5");
  // A file outside the copy is shown by its full path, never as a folder inside the copy.
  assert.deepEqual([c2, c4, c5, c6].map(({ card }) => [card?.cwd, card?.target]), [
    ["sub", null],
    [".", null],
    [".", path.join(r.dir, "out.txt")],
    [path.join("sub", "deeper"), path.join(r.dir, "notes.txt")],
  ]);
  // Asked again under the same call, nothing is left over from before: the record is per call.
  const again = await a.request("Bash", { command: "git push origin HEAD" }, "c2");
  assert.equal(again.card?.cwd, "", "a call is answered once; a second request for it was never heard by the hook");
});

test("a Read under the CLI's saved-output folder runs without asking only inside this task's own session; another session's, and the rest of the CLI's folder, ask", async (t) => {
  const r = await rig(t);
  for (const mode of ["manual", "semi"] as const) {
    const a = agent(r, mode, { outside: true });
    const own = toolResultsFolder({ cwd: a.top, session: SESSION, configDir: r.config })!;
    const other = toolResultsFolder({ cwd: a.top, session: OTHER_SESSION, configDir: r.config })!;
    const project = path.dirname(path.dirname(own));
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(own, "toolu_01.txt"), "long output");
    fs.writeFileSync(path.join(other, "toolu_02.txt"), "someone else's");
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), "{}");
    fs.writeFileSync(path.join(r.config, "settings.json"), "{}");
    // A link planted in the session's own folder that leads out of it.
    fs.symlinkSync(path.join(r.config, "settings.json"), path.join(own, "toolu_03.txt"));

    const read = (file: string, id: string) => a.ask("Read", { file_path: file }, `${mode}-${id}`);
    const mine = await read(path.join(own, "toolu_01.txt"), "own");
    assert.equal(mine.heard.verdict, "pass", "the hook lets it pass");
    assert.deepEqual([mine.answer.decision, mine.answer.files, mine.answer.approvalId], ["allow", true, null], "and so does the CLI's own request for it");
    for (const [file, id] of [[path.join(other, "toolu_02.txt"), "other"], [path.join(project, `${SESSION}.jsonl`), "transcript"], [path.join(r.config, "settings.json"), "settings"], [path.join(own, "toolu_03.txt"), "link"], [path.join(own, "..", "..", OTHER_SESSION, "tool-results", "toolu_02.txt"), "dots"]] as const) {
      const asked = await read(file, id);
      assert.equal(asked.heard.verdict, "ask", id);
      assert.ok(asked.answer.approvalId !== null, `${mode}: ${id} asks`);
      assert.deepEqual([asked.card?.asksBecause, asked.card?.target], ["Outside the task's copy.", path.resolve(file)], id);
    }
    // Reads are not logged, as reads inside the copy never are; what asked is.
    assert.deepEqual(rulesOf(r, a.taskId), Array(5).fill(["asked_owner", "owner_declined"]).flat());
  }
});

test("without a session reported yet, or for an agent whose CLI keeps no such folder, a Read there asks", async (t) => {
  const r = await rig(t);
  const a = agent(r, "semi");
  const own = toolResultsFolder({ cwd: a.top, session: SESSION, configDir: r.config })!;
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "toolu_01.txt"), "long output");
  r.db.prepare("UPDATE attempts SET resume_cursor = NULL").run();
  assert.ok((await a.ask("Read", { file_path: path.join(own, "toolu_01.txt") }, "no-session")).answer.approvalId !== null);
  r.db.prepare("UPDATE attempts SET resume_cursor = ?, driver = 'codex'").run(SESSION);
  assert.ok((await a.ask("Read", { file_path: path.join(own, "toolu_01.txt") }, "codex")).answer.approvalId !== null);
});
