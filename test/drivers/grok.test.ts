import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOME_SECRETS } from "../../src/confinement.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { GROK_CAPABILITIES, GROK_TOOLS, grokArgs, grokEnv, grokInput, grokProfile, grokReader, parseGrokLogin, parseGrokModels, GrokDriver } from "../../src/drivers/grok.ts";
import { checkVersion } from "../../src/drivers/launch.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// Nothing in this file starts `grok`.

/** The values of a flag that takes one. */
const valueOf = (args: readonly string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("a review turn runs `grok -p -` (the prompt on its input), streams JSON events, and starts with no memory, no subagents and no web search", () => {
  const args = grokArgs({ model: "grok-4.7-build-fast" });
  assert.deepEqual(args.slice(0, 2), ["-p", "-"], "the prompt is read from the input, never put on the command line");
  assert.equal(valueOf(args, "--output-format"), "streaming-json");
  for (const flag of ["--no-memory", "--no-subagents", "--disable-web-search"]) assert.ok(args.includes(flag), flag);
  assert.equal(valueOf(args, "--max-turns"), "1");
  assert.equal(valueOf(args, "-m"), "grok-4.7-build-fast");
  assert.equal(grokArgs({}).includes("-m"), false, "no model named: the CLI's own default");
  for (const flag of ["--always-approve", "--yolo", "--sandbox", "--tools", "--add-dir", "-c", "-r"]) assert.equal(grokArgs({}).includes(flag), false, flag);
});

test("CRITICAL: every built-in tool of Grok 1.0.92 is removed, the MCP and subagent ones included, so its model is offered none", () => {
  const removed = valueOf(grokArgs({}), "--disallowed-tools")!.split(",");
  // The tools `available_commands` listed on 1.0.92 for a default headless run, by the names Grok shows its model; with
  // Botbench's environment it also offered update_goal.
  const offered = ["run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "kill_command_or_subagent", "todo_write", "get_command_or_subagent_output", "spawn_subagent", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "search_tool", "use_tool", "workflow", "enter_plan_mode", "exit_plan_mode", "ask_user_question", "send_feedback", "web_search", "web_fetch", "image_gen", "image_edit", "image_to_video", "reference_to_video", "write"];
  for (const tool of [...offered, "update_goal", "Agent"]) assert.ok(removed.includes(tool), tool);
  assert.deepEqual(removed, [...GROK_TOOLS]);
});

test("a model name that could be a flag is refused", () => {
  assert.throws(() => grokArgs({ model: "--always-approve" }), /model name/);
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
});

test("CRITICAL: the whole Grok process is kept from every secret place but Grok's own folder, and from Botbench's data folder but the review folder, and writes nowhere else", () => {
  const home = os.homedir();
  const data = tempDir("botbench-grok-profile-");
  const folder = path.join(fs.realpathSync(data), "reviewers", "r1");
  const profile = grokProfile({ dataDir: data, folder, env: {} });
  const deny = /\(deny file-read\* (.*)\)/.exec(profile)![1]!;
  const allowRead = /\(allow file-read\* (.*)\)/.exec(profile)![1]!;
  const allowWrite = /\(allow file-write\* (.*)\)/.exec(profile)![1]!;
  for (const place of HOME_SECRETS) assert.ok(deny.includes(`"${path.join(home, place)}"`), place);
  assert.ok(deny.includes(`"${fs.realpathSync(data)}"`), "Botbench's data folder");
  assert.ok(allowRead.includes(`"${path.join(home, ".grok")}"`) && allowRead.includes(`"${folder}"`));
  assert.ok(!allowRead.includes(".codex") && !allowRead.includes(".ssh") && !allowRead.includes(".claude"));
  assert.ok(allowWrite.includes(`"${path.join(home, ".grok")}"`) && allowWrite.includes(`"${folder}"`));
  assert.ok(!allowWrite.includes(`"${home}"`), "not the home folder");
  const moved = grokProfile({ dataDir: data, folder, env: { GROK_HOME: "/Volumes/elsewhere/grok" } });
  assert.match(moved, /\(allow file-read\* [^)]*"\/Volumes\/elsewhere\/grok"/);
  fs.rmSync(data, { recursive: true, force: true });
});

test("Grok reports what it lacks for any role but review: no resume, no permission requests, no edits, no tools; it can be stopped", () => {
  assert.deepEqual(GROK_CAPABILITIES, { resume: false, interrupt: true, permissionRequests: false, edits: false, tools: false });
});

test("CRITICAL: no @ reaches Grok, which would read the path after it as a file to send its model; a prompt without one is sent as it is", () => {
  const sent = grokInput("diff: +see @~/.ssh/id_rsa and @/etc/hosts");
  assert.equal(sent.includes("@"), false);
  assert.equal(sent, "diff: +see ＠~/.ssh/id_rsa and ＠/etc/hosts\n\nBotbench wrote each at sign above as ＠ before sending it; read each ＠ as an at sign.");
  assert.equal(grokInput("plain"), "plain");
});

test("Grok refuses to start for anything but a read-only review with no network, before it starts anything", async () => {
  const data = tempDir("botbench-grok-refuse-");
  const db = openStore(data);
  const driver = new GrokDriver();
  const base = { db, cwd: data, confinement: { dataDir: data, allowedHosts: [] } };
  await assert.rejects(driver.startAttempt({ ...base, allowEdits: true }), /Grok can only review in Botbench/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, gate: { socketPath: "/x", secret: "y" } }), /Grok can only review/);
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
  assert.match(offered.stop ?? "", /Grok offered its model a tool \(read_file\)/);
  const none = read(['{"type":"available_commands","tools":[],"commands":["review"]}'])[0]!;
  assert.deepEqual(none, { events: [], stop: null });
  const call = read(['{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"/etc/hosts"}}'])[0]!;
  assert.deepEqual(call.events, [{ type: "tool_call", id: "call_1", name: "read_file", input: { path: "/etc/hosts" } }]);
  assert.match(call.stop ?? "", /Grok tried to use a tool \(read_file\)/);
});

const RECORDING = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "grok-review.json"), "utf8")) as { cli: string; sessions: Record<"review" | "signed-out", { lines: string[] }> };
const eventsOf = (lines: readonly string[]): { events: DriverEvent[]; stops: string[] } => {
  const results = read(lines);
  return { events: results.flatMap((r) => r.events), stops: results.flatMap((r) => (r.stop === null ? [] : [r.stop])) };
};

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
