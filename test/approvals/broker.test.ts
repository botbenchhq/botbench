import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import * as brokerModule from "../../src/approvals/broker.ts";
import { ApprovalError, actionLog, createBroker, listApprovals, type Approval, type Broker } from "../../src/approvals/broker.ts";
import { gate, summarize } from "../../src/approvals/gate.ts";
import { askBroker, hookOutput, PROXY_SCRIPT } from "../../src/approvals/permission-proxy.ts";
import { createTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// No test in this file starts a driver. The broker, its socket, the database and the proxy script are the real ones;
// the hook inputs are the JSON Claude Code 2.1.322 handed its pre-tool hook on 2026-11-22, with the paths changed.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  dir: string;
  home: string;
  worktree: string;
  broker: Broker;
  taskId: number;
  attemptId: number;
  changes: Approval[];
}

async function rig(t: T): Promise<Rig> {
  const dir = tempDir("botbench-broker-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const worktree = path.join(dir, "worktree");
  fs.mkdirSync(path.join(worktree, "sub"), { recursive: true });
  const db = openStore(home);
  const taskId = createTask(db, { repo: path.join(dir, "repo"), prompt: "run the marker script\nand more" }).id;
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'running', 'now', 'now')").run().lastInsertRowid);
  const changes: Approval[] = [];
  const broker = createBroker({ db, home, onChange: (approval) => changes.push(approval) });
  await broker.listen();
  // The broker writes to the store as it closes, so it goes first.
  t.after(async () => {
    await broker.close();
    db.close();
  });
  return { db, dir, home, worktree, broker, taskId, attemptId, changes };
}

/** The hook input as the CLI gives it: only the fields differ per call. */
function hookInput(r: Rig, tool: string, toolInput: Record<string, unknown>, id: string, cwd = r.worktree): Record<string, unknown> {
  return {
    session_id: "9d6fe08c-0092-443b-9776-50c737f95496",
    transcript_path: "/Users/owner/.claude/projects/x/9d6fe08c-0092-443b-9776-50c737f95496.jsonl",
    cwd,
    prompt_id: "2d5553d1-d204-43a3-9ac7-34ae4f4fa2ac",
    permission_mode: "default",
    effort: { level: "medium" },
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: id,
  };
}

const rules = (db: DatabaseSync): string[] => actionLog(db).map((e) => e.rule);

/** Write raw bytes to the broker's socket and return everything it answers before it closes the connection. */
function rawExchange(socketPath: string, bytes: string | Buffer, end = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("close", () => resolve(answer));
    socket.on("error", reject);
    socket.on("connect", () => (end ? socket.end(bytes) : socket.write(bytes)));
  });
}

/** Run the real proxy script the way the CLI runs a hook: the input on stdin, the answer on stdout. */
function runProxy(input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [PROXY_SCRIPT], { env: { PATH: process.env.PATH ?? "", ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin!.end(input);
  });
}

const decisionOf = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;

test("the broker's socket is inside the Botbench home, for the owner only, and is gone after close", async (t) => {
  const r = await rig(t);
  assert.equal(path.dirname(r.broker.socketPath), r.home);
  const stat = fs.statSync(r.broker.socketPath);
  assert.equal(stat.isSocket(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(r.home).mode & 0o777, 0o700);
  await r.broker.close();
  assert.equal(fs.existsSync(r.broker.socketPath), false);
});

test("a request waits as a pending approval until the owner answers; the answer and its log entry are written together", async (t) => {
  const r = await rig(t);
  let settled = false;
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "sh make-marker.sh", cwd: "sub", reason: "Run the marker script", toolCallId: "toolu_01" });
  void waiting.then(() => (settled = true));

  const [pending] = r.broker.pending();
  assert.ok(pending);
  assert.deepEqual(
    { ...pending, id: 0, createdAt: "" },
    { id: 0, taskId: r.taskId, chat: false, runId: null, taskTitle: "run the marker script", attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "sh make-marker.sh", cwd: "sub", reason: "Run the marker script", toolCallId: "toolu_01", status: "pending", note: null, createdAt: "", resolvedAt: null, parkedAt: null, storedDecision: null, outsideText: false, asksBecause: "In Manual mode every command asks you.", target: null },
  );
  assert.deepEqual(listApprovals(r.db, "pending"), [pending]);
  assert.deepEqual(rules(r.db), ["asked_owner"]);
  assert.deepEqual(r.changes.map((a) => [a.id, a.status]), [[pending.id, "pending"]]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "nothing answers but the owner");

  const answered = r.broker.answer(pending.id, "allow");
  assert.equal(answered.status, "allowed");
  assert.ok(answered.resolvedAt);
  assert.deepEqual(await waiting, { decision: "allow", note: null, approvalId: pending.id, refused: null });
  assert.deepEqual(r.broker.pending(), []);
  assert.deepEqual(r.changes.map((a) => a.status), ["pending", "allowed"]);
  const log = actionLog(r.db, r.taskId);
  assert.deepEqual(log.map((e) => [e.rule, e.taskId, e.attemptId, e.approvalId, e.tool, e.command, e.cwd]), [
    ["asked_owner", r.taskId, r.attemptId, pending.id, "Bash", "sh make-marker.sh", "sub"],
    ["owner_allowed", r.taskId, r.attemptId, pending.id, "Bash", "sh make-marker.sh", "sub"],
  ]);
  assert.deepEqual(actionLog(r.db, r.taskId + 1), []);
});

test("declining carries the owner's note to the waiting request and into the log", async (t) => {
  const r = await rig(t);
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "sh make-marker.sh", cwd: ".", reason: null, toolCallId: "toolu_02" });
  const id = r.broker.pending()[0]!.id;
  const answered = r.broker.answer(id, "decline", "use the Write tool instead");
  assert.deepEqual([answered.status, answered.note], ["declined", "use the Write tool instead"]);
  assert.deepEqual(await waiting, { decision: "decline", note: "use the Write tool instead", approvalId: id, refused: null });
  assert.deepEqual(actionLog(r.db).map((e) => [e.rule, e.detail]), [["asked_owner", null], ["owner_declined", "use the Write tool instead"]]);
});

test("answering twice is refused, an unknown approval is not found, and neither writes anything", async (t) => {
  const r = await rig(t);
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_03" });
  const id = r.broker.pending()[0]!.id;
  r.broker.answer(id, "decline");
  assert.equal((await waiting).decision, "decline");
  const before = { rows: listApprovals(r.db), log: actionLog(r.db) };

  assert.throws(() => r.broker.answer(id, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /already declined/.test(err.message));
  assert.throws(() => r.broker.answer(id + 99, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 404);
  // A decision that is neither word is refused too, whatever a caller's types say.
  assert.throws(() => r.broker.answer(id, "yes" as "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 400);
  assert.deepEqual({ rows: listApprovals(r.db), log: actionLog(r.db) }, before);
  assert.equal(listApprovals(r.db)[0]!.status, "declined", "the first answer stands");
});

test("the action log cannot be changed or emptied, an answered approval cannot be answered over, and the store offers no function that would", async (t) => {
  const r = await rig(t);
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_04" });
  const id = r.broker.pending()[0]!.id;
  r.broker.answer(id, "allow");
  await waiting;

  assert.throws(() => r.db.prepare("UPDATE action_log SET rule = 'owner_declined'").run(), /action_log is append-only/);
  assert.throws(() => r.db.prepare("DELETE FROM action_log").run(), /action_log is append-only/);
  assert.throws(() => r.db.prepare("UPDATE approvals SET status = 'declined' WHERE id = ?").run(id), /already answered/);
  assert.throws(() => r.db.prepare("UPDATE approvals SET status = 'pending' WHERE id = ?").run(id), /already answered/);
  assert.throws(() => r.db.prepare("DELETE FROM approvals").run(), /approvals are never deleted/);
  // What a request asks for is fixed from the moment it is written, also while it still waits.
  const second = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_04b" });
  const waitingId = r.broker.pending()[0]!.id;
  assert.throws(() => r.db.prepare("UPDATE approvals SET command = 'rm -rf /' WHERE id = ?").run(waitingId), /cannot be changed/);
  assert.throws(() => r.db.prepare("UPDATE approvals SET cwd = 'elsewhere', tool = 'Read' WHERE id = ?").run(waitingId), /cannot be changed/);
  r.broker.answer(waitingId, "decline");
  await second;
  const before = actionLog(r.db);
  assert.equal(before.length, 4);
  assert.throws(() => r.db.prepare("INSERT INTO action_log (ts, rule, tool, command, cwd) VALUES ('now', 'owner_said_so', 'Bash', 'ls', '.')").run(), /constraint/i);
  assert.deepEqual(actionLog(r.db), before);

  // What the module offers: reading the log, and nothing that edits or removes from it.
  const offered = [...Object.keys(brokerModule), ...Object.keys(r.broker)];
  assert.ok(offered.includes("actionLog"));
  assert.deepEqual(offered.filter((name) => /update|delete|remove|clear|edit|purge|truncate/i.test(name)), []);
});

test("the gate lets edits inside the worktree pass, lets reads there pass, and asks for everything else", async (t) => {
  const r = await rig(t);
  const at = { worktree: r.worktree, cwd: r.worktree };
  fs.symlinkSync(r.dir, path.join(r.worktree, "way-out"));
  fs.symlinkSync(path.join(r.dir, "elsewhere.txt"), path.join(r.worktree, "link.txt"));

  // File edits below the worktree, by full path or relative to where the agent stands.
  assert.deepEqual(gate({ tool: "Write", input: { file_path: path.join(r.worktree, "y.txt"), content: "y" }, ...at }), { verdict: "allow", rule: "auto_worktree_edit" });
  assert.deepEqual(gate({ tool: "Edit", input: { file_path: "sub/new/deep.txt" }, ...at }), { verdict: "allow", rule: "auto_worktree_edit" });
  assert.deepEqual(gate({ tool: "NotebookEdit", input: { notebook_path: "n.ipynb" }, worktree: r.worktree, cwd: path.join(r.worktree, "sub") }), { verdict: "allow", rule: "auto_worktree_edit" });
  // Edits that leave it, by name, by `..`, through a link, or with no path at all.
  for (const file of [path.join(r.dir, "escape.txt"), "../escape.txt", "sub/../../escape.txt", "way-out/escape.txt", "link.txt", "/etc/hosts", "", 7, undefined]) {
    assert.deepEqual(gate({ tool: "Write", input: { file_path: file }, ...at }), { verdict: "ask", why: "outside_copy" }, `Write ${String(file)}`);
  }
  // Git's own entry in the worktree and the CLI's settings folder are not ordinary files.
  fs.mkdirSync(path.join(r.worktree, ".claude"));
  fs.symlinkSync(".claude", path.join(r.worktree, "cfg"));
  fs.symlinkSync(".git", path.join(r.worktree, "g"));
  for (const file of [".git", ".git/config", ".claude/settings.json", "sub/../.claude/settings.local.json", ".CLAUDE/settings.json", "cfg/settings.json", "g", "g/config", "sub/.claude/settings.json"]) {
    assert.deepEqual(gate({ tool: "Edit", input: { file_path: file }, ...at }), { verdict: "ask", why: "guarded_in_copy" }, `Edit ${file}`);
  }
  // Reads inside pass without a log entry; reads outside ask.
  assert.deepEqual(gate({ tool: "Read", input: { file_path: path.join(r.worktree, "README.md") }, ...at }), { verdict: "allow", rule: "worktree_read" });
  assert.deepEqual(gate({ tool: "Glob", input: { pattern: "**/*.ts" }, ...at }), { verdict: "allow", rule: "worktree_read" });
  assert.deepEqual(gate({ tool: "Grep", input: { pattern: "x", path: "sub" }, ...at }), { verdict: "allow", rule: "worktree_read" });
  assert.deepEqual(gate({ tool: "Read", input: { file_path: "/etc/hosts" }, ...at }), { verdict: "ask", why: "outside_copy" });
  assert.deepEqual(gate({ tool: "Grep", input: { pattern: "x", path: "way-out" }, ...at }), { verdict: "ask", why: "outside_copy" });
  // A search whose pattern itself reaches out of the worktree asks as well.
  for (const input of [{ pattern: "/etc/**" }, { pattern: "../../**/*.pem" }, { pattern: "~/.ssh/*" }, { pattern: "x", glob: "../*" }, { pattern: "sub/../../*" }]) {
    assert.deepEqual(gate({ tool: input.glob ? "Grep" : "Glob", input, ...at }), { verdict: "ask", why: "outside_copy" }, JSON.stringify(input));
  }
  // Every shell command asks, the ones Claude Code runs unasked included, and so does any tool the gate does not know.
  for (const command of ["ls", "cat README.md", "git status", "printf hi > x.txt", "sh make-marker.sh"]) {
    assert.equal(gate({ tool: "Bash", input: { command }, ...at }).verdict, "ask", command);
  }
  for (const tool of ["WebFetch", "WebSearch", "Task", "CronCreate", "mcp__x__y", "", "SomethingNew"]) {
    assert.deepEqual(gate({ tool, input: {}, ...at }), { verdict: "ask", why: "other_tool" }, tool);
  }

  // What a card shows is all of what an allow lets run: a plain command as itself, anything with more to it in full.
  assert.equal(summarize("Bash", { command: "sh make-marker.sh", description: "Run it" }), "sh make-marker.sh");
  assert.equal(summarize("Bash", { command: "sleep 9", run_in_background: true }), '{"command":"sleep 9","run_in_background":true}');
  assert.equal(summarize("Write", { file_path: "/tmp/x.txt", content: "a long file" }), '{"file_path":"/tmp/x.txt","content":"a long file"}');
  assert.equal(summarize("Read", { file_path: "/etc/hosts" }), "/etc/hosts");
  assert.equal(summarize("Read", { file_path: "/etc/hosts", limit: 5 }), '{"file_path":"/etc/hosts","limit":5}');
  assert.equal(summarize("WebFetch", { url: "https://example.invalid/", prompt: "read" }), '{"url":"https://example.invalid/","prompt":"read"}');
  assert.equal(summarize("Bash", {}), "{}");
});

test("through the socket: a shell command is sent on to the owner, an edit in the worktree passes and is logged, with the directory it was made from", async (t) => {
  const r = await rig(t);
  const admission = r.broker.admit({ taskId: r.taskId, role: "implementer", worktree: r.worktree });
  admission.bind(r.attemptId);
  assert.match(admission.secret, /^[0-9a-f]{64}$/);
  assert.equal(admission.socketPath, r.broker.socketPath);

  const ls = await askBroker(admission.socketPath, admission.secret, hookInput(r, "Bash", { command: "ls", description: "List files in current directory" }, "toolu_01WjxChzdxP4VivfVmLADLYr", path.join(r.worktree, "sub")));
  assert.equal(ls.verdict, "ask");
  const redirect = await askBroker(admission.socketPath, admission.secret, hookInput(r, "Bash", { command: "printf hi > x.txt", description: 'Write "hi" to x.txt' }, "toolu_01LcVxxpU9km77KpHJHFSojC"));
  assert.equal(redirect.verdict, "ask");
  const write = await askBroker(admission.socketPath, admission.secret, hookInput(r, "Write", { file_path: path.join(r.worktree, "y.txt"), content: "y" }, "toolu_01Kpa83oFEUmu8LE92JyaAyC"));
  assert.equal(write.verdict, "pass");
  const read = await askBroker(admission.socketPath, admission.secret, hookInput(r, "Read", { file_path: path.join(r.worktree, "README.md") }, "toolu_01MSAwhGMNGxgiDqGb4gw3gh"));
  assert.equal(read.verdict, "pass");
  const outside = await askBroker(admission.socketPath, admission.secret, hookInput(r, "Write", { file_path: path.join(r.dir, "escape.txt"), content: "out" }, "toolu_05"));
  assert.equal(outside.verdict, "ask");

  // The one thing that ran on Botbench's own say is in the log; asking is logged when the request reaches the owner.
  assert.deepEqual(actionLog(r.db).map((e) => [e.rule, e.taskId, e.attemptId, e.tool, e.command, e.cwd]), [["auto_worktree_edit", r.taskId, r.attemptId, "Write", "y.txt", "."]]);
  // The socket gave no decision to anyone: nothing is pending and nothing was allowed.
  assert.deepEqual(listApprovals(r.db), []);

  // When the CLI then asks for the command, the request knows the directory the hook saw.
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", reason: "List files in current directory", toolCallId: "toolu_01WjxChzdxP4VivfVmLADLYr" });
  assert.equal(r.broker.pending()[0]!.cwd, "sub");
  // A request whose call the hook never saw still reaches the owner, with the directory not known.
  const unseen = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "pwd", reason: null, toolCallId: "toolu_never_seen" });
  assert.equal(r.broker.pending()[1]!.cwd, "");

  // The proxy script itself, run as the CLI runs it, prints what the CLI understands.
  const env = { BOTBENCH_BROKER_SOCKET: admission.socketPath, BOTBENCH_BROKER_SECRET: admission.secret };
  const asked = await runProxy(JSON.stringify(hookInput(r, "Bash", { command: "sh make-marker.sh" }, "toolu_06")), env);
  assert.deepEqual([asked.code, decisionOf(asked.stdout)], [0, "ask"]);
  const passed = await runProxy(JSON.stringify(hookInput(r, "Write", { file_path: "z.txt", content: "z".repeat(300_000) }, "toolu_07")), env);
  assert.deepEqual([passed.code, passed.stdout], [0, ""], "a pass leaves the decision to the CLI's own edit rule");

  const waitingId = r.broker.pending()[0]!.id;
  admission.release();
  assert.deepEqual([(await waiting).decision, (await unseen).decision], ["decline", "decline"]);
  // A request that ended unanswered cannot be answered afterwards, and its end is in the log.
  assert.throws(() => r.broker.answer(waitingId, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /already superseded/.test(err.message));
  assert.deepEqual(rules(r.db).filter((rule) => rule === "ended_unanswered" || rule === "owner_allowed"), ["ended_unanswered", "ended_unanswered"]);
});

test("if the broker's socket is unavailable, the proxy answers deny", async (t) => {
  const r = await rig(t);
  const admission = r.broker.admit({ taskId: r.taskId, role: "implementer", worktree: r.worktree });
  admission.bind(r.attemptId);
  const input = hookInput(r, "Bash", { command: "ls" }, "toolu_08");

  // No socket at that path, no path at all, and a path that is a plain file.
  const nowhere = path.join(r.home, "no-such.sock");
  fs.writeFileSync(path.join(r.home, "plain-file"), "");
  for (const socketPath of [nowhere, undefined, "", path.join(r.home, "plain-file")]) {
    const reply = await askBroker(socketPath, admission.secret, input);
    assert.equal(reply.verdict, "deny", String(socketPath));
    assert.match(reply.reason, /Botbench/);
  }
  assert.equal((await askBroker(admission.socketPath, undefined, input)).verdict, "deny", "no secret");
  // A socket that accepts and never answers: the proxy gives up and denies.
  const silent = net.createServer(() => {});
  const silentPath = path.join(r.home, "silent.sock");
  await new Promise<void>((resolve) => silent.listen(silentPath, resolve));
  t.after(() => silent.close());
  assert.equal((await askBroker(silentPath, admission.secret, input, 200)).verdict, "deny");
  // A socket that answers with something that is no verdict.
  const wrong = net.createServer((socket) => socket.end('{"verdict":"allow"}\n'));
  const wrongPath = path.join(r.home, "wrong.sock");
  await new Promise<void>((resolve) => wrong.listen(wrongPath, resolve));
  t.after(() => wrong.close());
  assert.equal((await askBroker(wrongPath, admission.secret, input)).verdict, "deny", "allow is not a verdict the socket can give");

  // The script: with the broker gone, with no environment, with input that is not JSON, with no input.
  await r.broker.close();
  const env = { BOTBENCH_BROKER_SOCKET: admission.socketPath, BOTBENCH_BROKER_SECRET: admission.secret };
  for (const [what, stdin, withEnv] of [["broker closed", JSON.stringify(input), env], ["no environment", JSON.stringify(input), {}], ["not JSON", "this is not json {", env], ["empty", "", env]] as const) {
    const run = await runProxy(stdin, withEnv);
    assert.equal(run.code, 0, what);
    assert.equal(decisionOf(run.stdout), "deny", what);
  }
  assert.equal(JSON.parse(hookOutput({ verdict: "deny", reason: "why" })).hookSpecificOutput.permissionDecisionReason, "why");
});

test("a wrong per-attempt secret is refused, and so is a secret before its attempt exists or after it is over", async (t) => {
  const r = await rig(t);
  const admission = r.broker.admit({ taskId: r.taskId, role: "implementer", worktree: r.worktree });
  const edit = hookInput(r, "Write", { file_path: "y.txt", content: "y" }, "toolu_09");

  assert.equal((await askBroker(admission.socketPath, admission.secret, edit)).verdict, "deny", "not bound to an attempt yet");
  admission.bind(r.attemptId);
  assert.equal((await askBroker(admission.socketPath, admission.secret, edit)).verdict, "pass");

  const other = r.broker.admit({ taskId: r.taskId, role: "implementer", worktree: path.join(r.dir, "other-worktree") });
  assert.notEqual(other.secret, admission.secret, "every attempt has its own secret");
  for (const secret of ["0".repeat(64), admission.secret.slice(0, 63), `${admission.secret}0`, "", admission.secret.toUpperCase()]) {
    assert.equal((await askBroker(admission.socketPath, secret, edit)).verdict, "deny", `secret ${secret.length} long`);
  }
  // Another attempt's secret speaks for that attempt only: this worktree's file is outside its own.
  other.bind(r.attemptId);
  assert.equal((await askBroker(admission.socketPath, other.secret, hookInput(r, "Write", { file_path: path.join(r.worktree, "y.txt") }, "toolu_10"))).verdict, "ask");

  admission.release();
  assert.equal((await askBroker(admission.socketPath, admission.secret, edit)).verdict, "deny", "released");

  const log = actionLog(r.db);
  assert.deepEqual(log.filter((e) => e.rule === "auto_worktree_edit").length, 1, "only the one accepted call counts as an edit");
  assert.ok(log.filter((e) => e.rule === "broker_failure_denied").length >= 6, "every refusal is on record");
  // No secret is written anywhere in the database.
  const dump = JSON.stringify([log, listApprovals(r.db), r.db.prepare("SELECT * FROM events").all()]);
  assert.equal(dump.includes(admission.secret) || dump.includes(other.secret), false);
});

test("a malformed message is denied", async (t) => {
  const r = await rig(t);
  const admission = r.broker.admit({ taskId: r.taskId, role: "implementer", worktree: r.worktree });
  admission.bind(r.attemptId);
  const good = { secret: admission.secret, tool: "Write", input: { file_path: "y.txt" }, toolCallId: "toolu_11", cwd: r.worktree };
  const line = (message: unknown): string => `${JSON.stringify(message)}\n`;
  const verdict = (answer: string): unknown => (JSON.parse(answer) as { verdict: unknown }).verdict;

  assert.equal(verdict(await rawExchange(r.broker.socketPath, line(good))), "pass", "the well-formed message, for comparison");
  const malformed: [string, string | Buffer][] = [
    ["not JSON", "this is not json\n"],
    ["a JSON string", '"just a string"\n'],
    ["an array", "[]\n"],
    ["no secret", line({ ...good, secret: undefined })],
    ["a secret that is not text", line({ ...good, secret: 7 })],
    ["no tool", line({ ...good, tool: undefined })],
    ["a tool that is not text", line({ ...good, tool: { name: "Write" } })],
    ["no tool call id", line({ ...good, toolCallId: "" })],
    ["a relative directory", line({ ...good, cwd: "sub" })],
    ["no directory", line({ ...good, cwd: undefined })],
    ["input that is not an object", line({ ...good, input: "y.txt" })],
    ["a message with no end", JSON.stringify(good)],
    ["bytes that are not text", Buffer.from([0xff, 0xfe, 0x00, 0x0a])],
    ["two megabytes", `${"x".repeat(2_000_000)}\n`],
  ];
  for (const [what, bytes] of malformed) {
    assert.equal(verdict(await rawExchange(r.broker.socketPath, bytes)), "deny", what);
  }
  // Extra fields that ask to be let through change nothing: a shell command still goes to the owner.
  assert.equal(verdict(await rawExchange(r.broker.socketPath, line({ ...good, tool: "Bash", input: { command: "ls" }, verdict: "pass", allow: true, rule: "auto_worktree_edit" }))), "ask");
  // After all of that the broker goes on answering.
  assert.equal(verdict(await rawExchange(r.broker.socketPath, line(good))), "pass");
  assert.equal(actionLog(r.db).filter((e) => e.rule === "auto_worktree_edit").length, 2, "none of the malformed messages was taken for an edit");
  assert.ok(actionLog(r.db).some((e) => e.rule === "broker_failure_denied"));
});

test("a request the broker cannot record is declined, never allowed", async (t) => {
  const r = await rig(t);
  // A task that does not exist: the approval row cannot be written.
  const noTask = await r.broker.request({ taskId: r.taskId + 50, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_12" });
  assert.equal(noTask.decision, "decline");
  assert.equal(noTask.approvalId, null);
  assert.match(noTask.refused ?? "", /could not be recorded/, "the owner was never asked, and the answer says so");
  // A command too long to show the owner in full is not shown in part.
  const long = await r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: `echo ${"a".repeat(30_000)}`, cwd: ".", reason: null, toolCallId: "toolu_13" });
  assert.equal(long.decision, "decline");
  assert.match(long.refused ?? "", /too long to show the owner in full/);
  for (const bad of [{ tool: "" }, { toolCallId: "" }, { command: "" }]) {
    const answer = await r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_14", ...bad });
    assert.equal(answer.decision, "decline", JSON.stringify(bad));
  }
  assert.deepEqual(r.broker.pending(), []);
  assert.deepEqual([...new Set(rules(r.db))], ["broker_failure_denied"]);
  assert.equal(rules(r.db).length, 5);

  // After close, nothing can be asked and nothing waits.
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_15" });
  const id = r.broker.pending()[0]!.id;
  await r.broker.close();
  assert.equal((await waiting).decision, "decline");
  assert.equal(listApprovals(r.db).find((a) => a.id === id)!.status, "superseded");
  assert.throws(() => r.broker.answer(id, "allow"), (err: unknown) => err instanceof ApprovalError && err.status === 409);
  assert.equal((await r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_16" })).decision, "decline");
});

test("approvals left pending when a broker starts on the store stay pending and are marked as asked before that start; nothing ends them", async (t) => {
  // What a killed Botbench really leaves, and what the engine then does with it, is in test/engine/recover-approval.test.ts.
  const r = await rig(t);
  void r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_17" });
  const id = r.broker.pending()[0]!.id;
  assert.equal(r.broker.pending()[0]!.parkedAt, null, "asked in this run");
  // A second broker opens the same store, as the next start of Botbench would.
  const home2 = path.join(r.dir, "home2");
  fs.mkdirSync(home2, { mode: 0o700 });
  const again = createBroker({ db: r.db, home: home2, onChange: () => {} });
  t.after(() => again.close());
  await again.listen();
  const [kept] = again.pending();
  assert.deepEqual([kept!.id, kept!.status, kept!.storedDecision], [id, "pending", null]);
  assert.ok(kept!.parkedAt !== null);
  assert.deepEqual(rules(r.db), ["asked_owner"]);
});

test("a socket that takes a connection for a moment and is then gone (a Botbench killed just after it started a process) is no running Botbench: the next start listens", async (t) => {
  const r = await rig(t);
  const home = path.join(r.dir, "home-left");
  fs.mkdirSync(home, { mode: 0o700 });
  // What a killed Botbench's socket does while a process it had just started still holds it: one connection is taken, then it closes.
  const dying = net.createServer((socket) => {
    socket.destroy();
    dying.close();
  });
  await new Promise<void>((resolve) => dying.listen(path.join(home, "broker.sock"), resolve));
  t.after(() => dying.close());
  const next = createBroker({ db: r.db, home, onChange: () => {} });
  t.after(() => next.close());
  await next.listen();
  assert.equal(fs.statSync(next.socketPath).isSocket(), true);
});

test("a second Botbench on the same data directory is refused, and takes nothing from the first: its socket and its pending approvals stay", async (t) => {
  const r = await rig(t);
  const admission = r.broker.admit({ taskId: r.taskId, role: "implementer", worktree: r.worktree });
  admission.bind(r.attemptId);
  const waiting = r.broker.request({ taskId: r.taskId, attemptId: r.attemptId, role: "implementer", tool: "Bash", command: "ls", cwd: ".", reason: null, toolCallId: "toolu_18" });
  const id = r.broker.pending()[0]!.id;

  const second = createBroker({ db: r.db, home: r.home, onChange: () => {} });
  await assert.rejects(second.listen(), /Another Botbench is already running on this data directory/);
  await second.close();

  assert.equal(fs.statSync(r.broker.socketPath).isSocket(), true, "the first broker's socket is still there");
  assert.equal((await askBroker(admission.socketPath, admission.secret, hookInput(r, "Write", { file_path: "y.txt" }, "toolu_19"))).verdict, "pass", "and still answers");
  assert.deepEqual(r.broker.pending().map((a) => a.id), [id], "and its request still waits");
  r.broker.answer(id, "allow");
  assert.equal((await waiting).decision, "allow");
});
