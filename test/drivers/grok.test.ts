import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { HOME_SECRETS, SANDBOX_EXEC } from "../../src/confinement.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { GROK_CAPABILITIES, GROK_TOOLS, grokArgs, grokEnv, grokInput, grokProfile, grokReader, grokTools, parseGrokLogin, parseGrokModels, GrokDriver } from "../../src/drivers/grok.ts";
import { checkVersion } from "../../src/drivers/launch.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// Nothing in this file starts `grok`.

/** The values of a flag that takes one. */
const valueOf = (args: readonly string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("a turn runs `grok -p -` (the prompt on its input), streams JSON events, and starts with no memory and no subagents", () => {
  for (const mode of ["chat", "review"] as const) {
    const args = grokArgs({ mode, model: "grok-4.7-build-fast" });
    assert.deepEqual(args.slice(0, 2), ["-p", "-"], "the prompt is read from the input, never put on the command line");
    assert.equal(valueOf(args, "--output-format"), "streaming-json");
    for (const flag of ["--no-memory", "--no-subagents"]) assert.ok(args.includes(flag), flag);
    assert.equal(valueOf(args, "-m"), "grok-4.7-build-fast");
    assert.equal(grokArgs({ mode }).includes("-m"), false, "no model named: the CLI's own default");
    // Grok's own sandbox cannot run inside Botbench's (macOS does not nest them), and nothing here changes the folder or resumes.
    for (const flag of ["--sandbox", "--tools", "--add-dir", "--cwd", "-w", "--worktree", "-c", "--continue", "-r", "--resume", "--max-turns"]) assert.equal(grokArgs({ mode }).includes(flag), false, flag);
  }
});

test("web search follows the setting: Allow keeps Grok's own web search (its X search runs on xAI's servers too), Off turns it off; web fetch, which would run on this Mac, is removed either way", () => {
  for (const mode of ["chat", "review"] as const) {
    const on = grokArgs({ mode, webSearch: true });
    assert.equal(on.includes("--disable-web-search"), false);
    assert.equal(valueOf(on, "--disallowed-tools")!.split(",").includes("web_search"), false);
    assert.ok(valueOf(on, "--disallowed-tools")!.split(",").includes("web_fetch"));
    for (const off of [grokArgs({ mode, webSearch: false }), grokArgs({ mode })]) {
      assert.ok(off.includes("--disable-web-search"));
      assert.ok(valueOf(off, "--disallowed-tools")!.split(",").includes("web_search"));
    }
  }
});

test("CRITICAL: Grok keeps only its command, file and task-list tools (a review without the two that write), and every other built-in tool of 1.0.92 is removed, the MCP, subagent, scheduler and fetch ones included", () => {
  assert.deepEqual(grokTools({ mode: "chat" }), ["run_terminal_command", "get_command_or_subagent_output", "kill_command_or_subagent", "read_file", "list_dir", "grep", "search_replace", "write", "todo_write"]);
  assert.deepEqual(grokTools({ mode: "review" }), ["run_terminal_command", "get_command_or_subagent_output", "kill_command_or_subagent", "read_file", "list_dir", "grep", "todo_write"]);
  for (const mode of ["chat", "review"] as const) {
    const removed = valueOf(grokArgs({ mode }), "--disallowed-tools")!.split(",");
    const kept = grokTools({ mode });
    assert.deepEqual([...removed, ...kept].sort(), [...GROK_TOOLS].sort(), "each tool Grok offers is either kept or removed");
    for (const tool of ["spawn_subagent", "Agent", "scheduler_create", "monitor", "search_tool", "use_tool", "web_fetch", "send_feedback", "ask_user_question", "workflow", "update_goal"]) assert.ok(removed.includes(tool), tool);
  }
});

test("CRITICAL: Grok's tools run without a prompt for this one process only: `--always-approve`, and no permission rule or mode that Grok would keep (no allow-always)", () => {
  for (const mode of ["chat", "review"] as const) {
    const args = grokArgs({ mode, webSearch: true });
    assert.ok(args.includes("--always-approve"), "grok -p refuses a tool that needs approval without it: it asks no one");
    for (const flag of ["--allow", "--allowedTools", "--allowed-tools", "--permission-mode", "--deny", "--yolo"]) assert.equal(args.includes(flag), false, flag);
  }
});

test("a model name that could be a flag is refused", () => {
  assert.throws(() => grokArgs({ mode: "chat", model: "--always-approve" }), /model name/);
});

test("AE7: the review's environment has no provider key and turns off what Grok would load from Claude's and Cursor's settings, memory, workflows and updates", () => {
  const env = grokEnv({ ...process.env, XAI_API_KEY: "xai-x", GROK_API_KEY: "y", GROK_CODE_XAI_API_KEY: "z", GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", GROK_HOME: "/Volumes/elsewhere/grok" });
  for (const name of ["XAI_API_KEY", "GROK_API_KEY", "GROK_CODE_XAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"]) assert.equal(name in env, false, name);
  assert.equal(env.GROK_HOME, "/Volumes/elsewhere/grok", "a moved Grok folder is kept, so its own sign-in is found");
  for (const vendor of ["CLAUDE", "CURSOR"]) for (const surface of ["HOOKS", "MCPS", "SKILLS", "RULES", "AGENTS"]) assert.equal(env[`GROK_${vendor}_${surface}_ENABLED`], "false", `${vendor} ${surface}`);
  assert.equal(env.GROK_MEMORY, "0");
  assert.equal(env.GROK_WORKFLOWS, "0");
  assert.equal(env.GROK_SUBAGENTS, "0");
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null", "git in a command does not stop at the unreadable ~/.gitconfig");
});

/** The rules of a profile whose line starts with `head`, e.g. "(allow file-read*". */
const rules = (profile: string, head: string): string[] => profile.split("\n").filter((line) => line.startsWith(head));

test("CRITICAL: the profile of a Grok chat: the home folder, every secret place and Botbench's data folder are unreadable but Grok's own folder, the chat's folder and the attached repository; it writes only its own folder, the chat's folder and its private temporary folder, never the repository or the shared temporary folder; its only network is Botbench's proxy", () => {
  const home = os.homedir();
  const data = fs.realpathSync(tempDir("botbench-grok-profile-"));
  const chatFolder = path.join(data, "scratch");
  const repo = path.join(data, "..", "some-repo");
  const profile = grokProfile({ dataDir: data, folder: chatFolder, readOnly: [repo, `${repo}/.git`], temp: path.join(data, "..", "grok-temp"), proxyPort: 41234, env: {} });
  const [denyAll, denyAgain] = rules(profile, "(deny file-read*");
  const [openRepo, openOwn] = rules(profile, "(allow file-read*");
  assert.ok(denyAll!.includes(`(subpath "${home}")`), "the whole home folder");
  for (const place of HOME_SECRETS) assert.ok(denyAll!.includes(`"${path.join(home, place)}"`) && denyAgain!.includes(`"${path.join(home, place)}"`), place);
  assert.ok(denyAll!.includes(`"${data}"`), "Botbench's data folder");
  assert.ok(!denyAgain!.includes(`"${data}"`), "denied once, before the read-only places: a review's copy lies inside it (an attached repository may not hold it)");
  assert.ok(openRepo!.includes(`"${path.resolve(repo)}"`));
  assert.ok(openOwn!.includes(`"${path.join(home, ".grok")}"`) && openOwn!.includes(`"${chatFolder}"`));
  assert.ok(profile.indexOf(openRepo!) < profile.indexOf(denyAgain!) && profile.indexOf(denyAgain!) < profile.indexOf(openOwn!), "a repository that holds a secret place does not open it: the list is denied again after it");
  for (const secret of [".codex", ".ssh", ".claude"]) assert.ok(!openOwn!.includes(secret) && !openRepo!.includes(secret), secret);
  const [allowWrite] = rules(profile, "(allow file-write*");
  assert.ok(allowWrite!.includes(`"${path.join(home, ".grok")}"`) && allowWrite!.includes(`"${chatFolder}"`));
  assert.ok(!allowWrite!.includes(`"${home}"`), "not the home folder");
  assert.ok(allowWrite!.includes(`"${path.resolve(data, "..", "grok-temp")}"`), "its private temporary folder");
  assert.ok(!allowWrite!.includes(`"${os.tmpdir()}"`) && denyAll!.includes(`"${os.tmpdir()}"`), "not the shared temporary folder, which is unreadable too");
  for (const line of rules(profile, "(allow network-")) assert.ok(!line.includes(`"${os.tmpdir()}"`), `no socket in the shared temporary folder: ${line}`);
  const [denyWrite] = rules(profile, "(deny file-write* (subpath");
  assert.ok(denyWrite!.includes(`"${path.resolve(repo)}"`), "the repository stays unwritable, even inside a writable place");
  assert.ok(profile.indexOf(denyWrite!) > profile.indexOf(allowWrite!), "a later rule wins: the repository's deny comes after the writable places");
  assert.ok(profile.includes("(deny network*)"));
  assert.deepEqual(rules(profile, "(allow network-outbound (remote ip"), ['(allow network-outbound (remote ip "localhost:41234"))'], "the proxy's port and nothing else");
  assert.ok(profile.includes("(deny lsopen)") && profile.includes("(deny appleevent-send)"));
  const moved = grokProfile({ dataDir: data, folder: chatFolder, readOnly: [], temp: "/tmp/t", proxyPort: 41234, env: { GROK_HOME: "/Volumes/elsewhere/grok" } });
  assert.match(moved, /\(allow file-read\* [^\n]*"\/Volumes\/elsewhere\/grok"/);
  fs.rmSync(data, { recursive: true, force: true });
});

test("CRITICAL: the profile of a Grok review reads the task's copy and its git folder and writes neither; Grok works in the review folder", () => {
  const data = fs.realpathSync(tempDir("botbench-grok-review-profile-"));
  const copy = path.join(data, "worktrees", "run-1", "task-1");
  const gitDir = path.join(data, "..", "repo", ".git");
  const folder = path.join(data, "reviewers", "r1");
  const profile = grokProfile({ dataDir: data, folder, readOnly: [copy, gitDir], temp: path.join(data, "..", "t"), proxyPort: 5000, env: {} });
  assert.ok(rules(profile, "(allow file-read*")[0]!.includes(`"${copy}"`));
  const [denyWrite] = rules(profile, "(deny file-write* (subpath");
  assert.ok(denyWrite!.includes(`"${copy}"`) && denyWrite!.includes(`"${path.resolve(gitDir)}"`));
  assert.ok(rules(profile, "(allow file-write*")[0]!.includes(`"${folder}"`) && !rules(profile, "(allow file-write*")[0]!.includes(`"${copy}"`));
  fs.rmSync(data, { recursive: true, force: true });
});

test("CRITICAL: under the profile of a Grok review, the task's copy, which lies inside Botbench's data folder, is readable and unwritable, and the rest of the data folder stays unreadable", { skip: NO_SANDBOX }, (t) => {
  const data = fs.realpathSync(tempDir("botbench-grok-review-read-"));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const copy = path.join(data, "worktrees", "run-1", "task-1");
  const folder = path.join(data, "reviewers", "r1");
  const temp = path.join(data, "..", `grok-temp-${process.pid}`);
  for (const d of [copy, folder, temp]) fs.mkdirSync(d, { recursive: true });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(copy, "calc.py"), "def add(a, b):\n    return a - b\n");
  fs.writeFileSync(path.join(data, "botbench.db"), "DATA\n");
  const profile = grokProfile({ dataDir: data, folder, readOnly: [copy], temp, proxyPort: 5000, env: {} });
  const sh = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { encoding: "utf8", cwd: folder });
  assert.equal(sh(`cat ${copy}/calc.py`).stdout, "def add(a, b):\n    return a - b\n", "the reviewer reads the task's copy");
  assert.equal(sh(`ls ${copy}`).stdout, "calc.py\n");
  assert.notEqual(sh(`echo x >> ${copy}/calc.py`).status, 0, "and cannot change it");
  assert.notEqual(sh(`cat ${data}/botbench.db`).status, 0, "Botbench's own files stay unreadable");
});

test("Grok reports what it lacks: no resume, no permission requests, no edits of a task's copy; it has its own tools in a chat and can be stopped", () => {
  assert.deepEqual(GROK_CAPABILITIES, { resume: false, interrupt: true, permissionRequests: false, edits: false, chatTools: true });
});

test("CRITICAL: an @ reaches Grok only before a path inside the folders it may read, resolved through links; any other @ is written as ＠, so Grok attaches nothing else", () => {
  const dir = fs.realpathSync(tempDir("botbench-grok-mentions-"));
  const chatFolder = path.join(dir, "scratch");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(chatFolder);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(chatFolder, "notes.md"), "mine\n");
  fs.writeFileSync(path.join(repo, "a.ts"), "x\n");
  fs.writeFileSync(path.join(dir, "decoy.txt"), "DECOY\n");
  fs.symlinkSync(path.join(dir, "decoy.txt"), path.join(chatFolder, "link-out.txt"));
  const o = { cwd: chatFolder, allowed: [chatFolder, repo] };
  const sent = grokInput(`see @notes.md and @${repo}/a.ts:L3-5 too, not @${dir}/decoy.txt, @link-out.txt, @../decoy.txt, @~/.ssh/id_rsa, @/etc/hosts, @x@${dir}/decoy.txt or a@b.c`, o);
  assert.match(sent, /see @notes\.md and @[^ ]*\/repo\/a\.ts:L3-5 too, not ＠/);
  assert.equal(grokInput(`@${repo}/a.ts, then`, o).startsWith("＠"), true, "a word that runs on into punctuation names no file, and is rewritten");
  assert.ok(sent.includes(`＠${dir}/decoy.txt`), "a file outside the folders");
  assert.ok(sent.includes("＠link-out.txt"), "a link inside that leads out");
  assert.ok(sent.includes("＠../decoy.txt") && sent.includes("＠~/.ssh/id_rsa") && sent.includes("＠/etc/hosts"));
  assert.ok(sent.includes(`＠x＠${dir}/decoy.txt`), "a mention inside a word is one too");
  assert.ok(sent.includes("a＠b.c"));
  assert.equal(sent.match(/@/g)?.length, 2, "only the two allowed paths keep their @");
  assert.match(sent, /read each ＠ as an at sign\.$/);
  assert.equal(grokInput("plain", o), "plain");
  assert.equal(grokInput("see @notes.md", o), "see @notes.md", "nothing rewritten: sent as it is");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Grok refuses to start for a task's builder or planner, for a resume or for hosts, before it starts anything", async () => {
  const data = tempDir("botbench-grok-refuse-");
  const db = openStore(data);
  const driver = new GrokDriver();
  const base = { db, cwd: data, confinement: { dataDir: data, allowedHosts: [] } };
  await assert.rejects(driver.startAttempt({ ...base, allowEdits: true }), /Grok can only review or chat in Botbench/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, gate: { socketPath: "/x", secret: "y" } }), /Grok can only review or chat/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, chatTools: { readable: [] } }), /kept by Botbench's sandbox alone/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, resumeCursor: "abc" }), /cannot resume/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, confinement: { dataDir: data, allowedHosts: ["registry.npmjs.org"] } }), /no network/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 0);
  db.close();
  fs.rmSync(data, { recursive: true, force: true });
});

test("the sign-in Grok 1.0.92 reports in `grok models`: grok.com is a subscription, anything else is signed out or unknown", () => {
  assert.deepEqual(parseGrokLogin("You are logged in with grok.com.\n\nDefault model: grok-4.7\n", 0), { signedIn: true, billing: "subscription" });
  assert.deepEqual(parseGrokLogin("You are not authenticated.\n\nDefault model: grok-4.7\n", 0), { signedIn: false, billing: "unknown" });
  assert.deepEqual(parseGrokLogin("You are logged in with grok.com.\n", 1), { signedIn: false, billing: "unknown" }, "a failed listing is not a sign-in");
  assert.deepEqual(parseGrokLogin("You are logged in with an API key.\n", 0), { signedIn: true, billing: "unknown" }, "an unknown kind is not guessed");
});

test("the model list Grok 1.0.92 prints, with its own default, and nothing that could not be passed back", () => {
  const printed = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - --yolo\n";
  assert.deepEqual(parseGrokModels(printed), { models: [{ id: "grok-4.7" }, { id: "grok-4.7-build-fast" }, { id: "grok-4.6" }], cliDefault: "grok-4.7" });
  assert.equal(parseGrokModels("You are not authenticated.\n"), null);
});

test("Grok 1.0.92 is a version Botbench can drive, and an older one is not", () => {
  assert.equal(checkVersion("grok 1.0.92 (b06756fd6256)\n", "grok").supported, true);
  assert.equal(checkVersion("grok 1.0.91 (abc)\n", "grok").supported, false);
});

const read = (lines: readonly string[]) => {
  const reader = grokReader();
  return lines.map(reader);
};

test("a search Grok runs on xAI's own servers (X search) is recorded and does not stop the turn; a tool on this Mac still does", () => {
  // The line Grok 1.0.92 printed in a real chat on the owner's Mac, 2026-11-22: a backend tool, run by xAI, not here.
  const backend = read(['{"type":"tool_call","toolCallId":"ctc_1","toolName":"X search:","rawInput":{"variant":"XSearch","backend":true}}'])[0]!;
  assert.deepEqual(backend.events, [{ type: "tool_call", id: "ctc_1", name: "X search:", input: { variant: "XSearch", backend: true } }]);
  assert.equal(backend.stop, null);
  // "backend" must be exactly true, and a local tool's name does not become harmless by claiming it.
  for (const rawInput of ['{"variant":"XSearch","backend":"true"}', '{"variant":"XSearch"}', '{"backend":false}', "null"]) {
    const local = read([`{"type":"tool_call","toolCallId":"c","toolName":"X search:","rawInput":${rawInput}}`])[0]!;
    assert.match(local.stop ?? "", /Grok tried to use a tool/);
  }
  for (const name of ["run_terminal_cmd", "read_file", "write", "edit_file", "search_tool", "use_tool"]) {
    const claimed = read([`{"type":"tool_call","toolCallId":"c","toolName":"${name}","rawInput":{"backend":true,"path":"/etc/hosts"}}`])[0]!;
    assert.match(claimed.stop ?? "", /Grok tried to use a tool/, name);
  }
  // The wording no longer says "a reviewer": the same stop is shown in a chat.
  const call = read(['{"type":"tool_call","toolCallId":"c","toolName":"read_file","rawInput":{"path":"/etc/hosts"}}'])[0]!;
  assert.doesNotMatch(call.stop ?? "", /reviewer/);
});

test("an output line that is not JSON, or not an event, becomes an error event", () => {
  const [bad, notEvent, blank] = read(["oops", "[1]", ""]);
  assert.equal(bad!.events[0]?.type, "error");
  assert.equal(notEvent!.events[0]?.type, "error");
  assert.deepEqual(blank, { events: [], stop: null });
});

test("CRITICAL: Grok offering its model any tool stops the turn at once, and so does any tool call", () => {
  const offered = read(['{"type":"available_commands","tools":["read_file"],"commands":[]}'])[0]!;
  assert.match(offered.stop ?? "", /Grok offered its model a tool Botbench did not give it \(read_file\)/);
  const none = read(['{"type":"available_commands","tools":[],"commands":["review"]}'])[0]!;
  assert.deepEqual(none, { events: [], stop: null });
  const call = read(['{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"/etc/hosts"}}'])[0]!;
  assert.deepEqual(call.events, [{ type: "tool_call", id: "call_1", name: "read_file", input: { path: "/etc/hosts" } }]);
  assert.match(call.stop ?? "", /Grok tried to use a tool Botbench did not give it \(read_file\)/);
});

test("CRITICAL: with tools kept, Grok offering exactly those goes on, one more stops the turn, and its calls are recorded as steps", () => {
  const kept = grokTools({ mode: "chat", webSearch: true });
  const reader = grokReader(kept);
  assert.deepEqual(reader(JSON.stringify({ type: "available_commands", tools: kept, commands: [] })), { events: [], stop: null });
  const extra = reader(JSON.stringify({ type: "available_commands", tools: [...kept, "web_fetch"], commands: [] }));
  assert.match(extra.stop ?? "", /a tool Botbench did not give it \(web_fetch\)/);
  const call = grokReader(kept)('{"type":"tool_call","toolCallId":"c1","toolName":"Run command","rawInput":{"command":"ls"}}');
  assert.deepEqual(call, { events: [{ type: "tool_call", id: "c1", name: "Run command", input: { command: "ls" } }], stop: null });
});

const RECORDING = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "grok-review.json"), "utf8")) as { cli: string; sessions: Record<"review" | "signed-out", { lines: string[] }> };
const eventsOf = (lines: readonly string[]): { events: DriverEvent[]; stops: string[] } => {
  const results = read(lines);
  return { events: results.flatMap((r) => r.events), stops: results.flatMap((r) => (r.stop === null ? [] : [r.stop])) };
};

test("what Grok writes before a tool call is a text of its own, so the reply after the last call stands alone: a review's verdict line is its first line", () => {
  // Constructed lines in Grok 1.0.92's form: a remark, a command, then the review.
  const reader = grokReader(grokTools({ mode: "review" }));
  const events = [
    '{"type":"text","data":"I will check the copy first."}',
    '{"type":"tool_call","toolCallId":"c1","toolName":"run_terminal_command","rawInput":{"command":"git diff"}}',
    '{"type":"tool_call_update","toolCallId":"c1","rawOutput":{"exit_code":0}}',
    '{"type":"text","data":"Verdict: concerns\\n"}',
    '{"type":"text","data":"Findings:\\n- calc.py:2: subtracts"}',
    '{"type":"end","stopReason":"end_turn","sessionId":"s1","usage":{"input_tokens":5,"output_tokens":2}}',
  ].flatMap((line) => reader(line).events);
  assert.deepEqual(events.filter((e) => e.type === "text" || e.type === "tool_call").map((e) => e.type === "text" ? e.text : `call ${e.id}`), ["I will check the copy first.", "call c1", "Verdict: concerns\nFindings:\n- calc.py:2: subtracts"]);
});

test("a review session recorded from Grok 1.0.92 offered no tool, and becomes its session, the whole reply as one text, the usage, and a completed turn, in that order", () => {
  assert.equal(RECORDING.cli, "grok 1.0.92 (b06756fd6256)");
  const tools = RECORDING.sessions.review.lines.map((line) => JSON.parse(line) as { type: string; tools?: string[] }).filter((e) => e.type === "available_commands");
  assert.ok(tools.length > 0 && tools.every((e) => e.tools?.length === 0), "the recording shows Grok offered its model no tool");
  const { events, stops } = eventsOf(RECORDING.sessions.review.lines);
  assert.deepEqual(stops, []);
  assert.deepEqual(events.map((e) => e.type), ["session_started", "text", "usage", "turn_ended"]);
  assert.match((events[1] as { text: string }).text, /^Verdict: concerns\nFindings:\n- calc\.py:2/);
  const usage = events[2] as Extract<DriverEvent, { type: "usage" }>;
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0);
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
});

test("a signed-out session recorded from Grok 1.0.92 ends the turn as an error in Grok's own words", () => {
  const { events } = eventsOf(RECORDING.sessions["signed-out"].lines);
  const end = events.at(-1) as { type: string; reason: string; detail: string };
  assert.equal(end.type, "turn_ended");
  assert.equal(end.reason, "error");
  assert.match(end.detail, /Not signed in/);
  assert.equal(events.some((e) => e.type === "text"), false);
});

test("a turn Grok ends for any reason but end_turn is not a completed review", () => {
  const { events } = eventsOf(['{"type":"text","data":"Verdict"}', '{"type":"end","stopReason":"max_turn_requests","sessionId":"s","usage":{"input_tokens":1,"output_tokens":1}}']);
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "error", detail: "Grok stopped before it finished its reply (max_turn_requests)." });
});
