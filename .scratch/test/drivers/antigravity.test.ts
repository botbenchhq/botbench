import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOME_SECRETS } from "../../src/confinement.ts";
import { AGY_SETTINGS, ANTIGRAVITY_CAPABILITIES, AntigravityDriver, agyArgs, agyEnv, agyInput, agyProfile, agyReader, parseAgyModels, parseAgyUsage, REVIEW_AGENT, writeReviewAgent } from "../../src/drivers/antigravity.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { checkVersion } from "../../src/drivers/launch.ts";
import { openStore } from "../../src/store/db.ts";
import { tempDir } from "../support/repo.ts";

// Nothing in this file starts `agy`.

const valueOf = (args: readonly string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("a review turn runs `agy` with one JSON message on its input and JSON events out, as Botbench's own agent, with no slash commands or skills", () => {
  const args = agyArgs({ model: "gemini-3.8-flash-low" });
  assert.equal(valueOf(args, "--input-format"), "stream-json", "the prompt is read from the input, never put on the command line");
  assert.equal(valueOf(args, "--output-format"), "stream-json");
  assert.equal(valueOf(args, "--agent"), REVIEW_AGENT);
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--sandbox"));
  assert.equal(valueOf(args, "--model"), "gemini-3.8-flash-low");
  assert.equal(agyArgs({}).includes("--model"), false, "no model named: the CLI's own default");
  for (const flag of ["-p", "--print", "--dangerously-skip-permissions", "--continue", "--conversation", "--add-dir", "--remote-agent", "--remote-control", "--mode"]) assert.equal(agyArgs({}).includes(flag), false, flag);
  assert.throws(() => agyArgs({ model: "--dangerously-skip-permissions" }), /model name/);
});

test("CRITICAL: Botbench's agent is offered no tool, and the session's settings deny every kind of action Antigravity has rules for, whatever the owner allows", () => {
  const folder = tempDir("botbench-agy-agent-");
  writeReviewAgent(folder);
  const file = fs.readFileSync(path.join(folder, ".agents", "agents", `${REVIEW_AGENT}.md`), "utf8");
  assert.match(file, /^---\nname: botbench-review\n/);
  assert.match(file, /\ntools: \[\]\n/);
  assert.match(file, /\nsubagent: false\n/);
  assert.match(file, /\nmcpServers: \[\]\n/);
  assert.match(file, /\ncommandExecutionPolicy: off\n/);
  const settings = JSON.parse(valueOf(agyArgs({}), "--settings")!) as typeof AGY_SETTINGS;
  assert.deepEqual(settings, AGY_SETTINGS);
  assert.deepEqual([...settings.permissions.deny].sort(), ["command(*)", "download_url(*)", "execute_url(*)", "mcp(*)", "read_file(*)", "read_url(*)", "unsandboxed(*)", "write_file(*)"]);
  assert.equal(settings.toolPermission, "request-review");
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.equal(settings.enableTerminalSandbox, true);
  assert.equal(settings.disableSlashCommands, true);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the prompt is one user message of Antigravity's input protocol, sent as written", () => {
  const line = agyInput("Review @this\nplease");
  assert.ok(line.endsWith("\n") && !line.slice(0, -1).includes("\n"));
  assert.deepEqual(JSON.parse(line), { event: "user", message: { content: "Review @this\nplease" } });
});

test("AE7: the review's environment has no provider key and no auto-update", () => {
  const env = agyEnv({ ...process.env, GEMINI_API_KEY: "g", GOOGLE_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/x.json", XAI_API_KEY: "x" });
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "XAI_API_KEY"]) assert.equal(name in env, false, name);
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
});

test("CRITICAL: the whole Antigravity process is kept from every secret place but its own folders and the Keychain it signs in with, and from Botbench's data folder but the review folder, and writes nowhere else", () => {
  const home = os.homedir();
  const data = tempDir("botbench-agy-profile-");
  const folder = path.join(fs.realpathSync(data), "reviewers", "r1");
  const profile = agyProfile({ dataDir: data, folder });
  const deny = /\(deny file-read\* (.*)\)/.exec(profile)![1]!;
  const allowRead = /\(allow file-read\* (.*)\)/.exec(profile)![1]!;
  const allowWrite = /\(allow file-write\* (.*)\)/.exec(profile)![1]!;
  for (const place of HOME_SECRETS) assert.ok(deny.includes(`"${path.join(home, place)}"`), place);
  assert.ok(deny.includes(`"${fs.realpathSync(data)}"`));
  for (const own of [".gemini/antigravity-cli", ".gemini/config", "Library/Keychains"]) assert.ok(allowRead.includes(`"${path.join(home, own)}"`), own);
  assert.ok(allowRead.includes(`"${folder}"`));
  assert.ok(!allowRead.includes(`"${path.join(home, ".gemini")}"`), "not the whole .gemini folder, which holds the Gemini CLI's sign-in");
  for (const other of [".codex", ".grok", ".ssh", ".claude"]) assert.ok(!allowRead.includes(other), other);
  assert.ok(!allowWrite.includes("Keychains"), "the Keychain is read, not written");
  assert.ok(allowWrite.includes(`"${folder}"`) && allowWrite.includes(`"${path.join(home, ".gemini/antigravity-cli")}"`));
  fs.rmSync(data, { recursive: true, force: true });
});

test("Antigravity reports what it lacks for any role but review: no resume, no permission requests, no edits, no tools; it can be stopped", () => {
  assert.deepEqual(ANTIGRAVITY_CAPABILITIES, { resume: false, interrupt: true, permissionRequests: false, edits: false, tools: false });
});

test("Antigravity refuses to start for anything but a read-only review with no network, before it starts anything", async () => {
  const data = tempDir("botbench-agy-refuse-");
  const db = openStore(data);
  const driver = new AntigravityDriver();
  const base = { db, cwd: data, confinement: { dataDir: data, allowedHosts: [] } };
  await assert.rejects(driver.startAttempt({ ...base, allowEdits: true }), /Antigravity can only review in Botbench/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, gate: { socketPath: "/x", secret: "y" } }), /Antigravity can only review/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, resumeCursor: "abc" }), /cannot resume/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, confinement: { dataDir: data, allowedHosts: ["registry.npmjs.org"] } }), /no network/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 0);
  db.close();
  fs.rmSync(data, { recursive: true, force: true });
});

test("the sign-in Antigravity 1.5.14 shows in `agy -p /usage`: plan quotas are a subscription, a sign-in request is signed out", () => {
  const usage = "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-29T15:52:29Z\nGemini Models\tFive Hour Limit Remaining\t100%\t2026-11-22T20:52:29Z\n";
  assert.deepEqual(parseAgyUsage(usage, 0), { signedIn: true, billing: "subscription" });
  assert.deepEqual(parseAgyUsage("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x\nError: authentication interrupted.\n", 0), { signedIn: false, billing: "unknown" });
  assert.deepEqual(parseAgyUsage(usage, 1), { signedIn: false, billing: "unknown" });
  assert.deepEqual(parseAgyUsage("", 0), { signedIn: false, billing: "unknown" });
});

test("the model list Antigravity 1.5.14 prints, by slug and its own label, and nothing that could not be passed back", () => {
  const printed = "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n--x\tBad\n";
  assert.deepEqual(parseAgyModels(printed), [{ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" }, { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }]);
  assert.equal(parseAgyModels("Fetching available models...\n"), null);
});

test("Antigravity 1.5.14 is a version Botbench can drive, and an older one is not", () => {
  assert.equal(checkVersion("1.5.14\n", "antigravity").supported, true);
  assert.equal(checkVersion("1.5.13\n", "antigravity").supported, false);
});

const read = (lines: readonly string[]) => lines.map(agyReader());

test("an output line that is not JSON, or not an event, becomes an error event", () => {
  const [bad, notEvent, blank] = read(["oops", "[1]", ""]);
  assert.equal(bad!.events[0]?.type, "error");
  assert.equal(notEvent!.events[0]?.type, "error");
  assert.deepEqual(blank, { events: [], stop: null });
});

test("CRITICAL: a session that is not Botbench's own agent stops at once, and so does any tool step, its call shown", () => {
  const other = read(['{"event":"init","conversation_id":"c","init":{"cwd":"/x","tools":["run_command"],"permission_mode":"request-review"}}'])[0]!;
  assert.match(other.stop ?? "", /Stopped: Antigravity did not start as Botbench's reviewer agent/);
  const tool = read(['{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"manage_task","tool_info":{"name":"manage_task","parameters":{"Action":"list"}}}}'])[0]!;
  assert.deepEqual(tool.events, [{ type: "tool_call", id: "step-2", name: "manage_task", input: { Action: "list" } }]);
  assert.match(tool.stop ?? "", /Stopped: Antigravity tried to use a tool \(manage_task\)/);
  const refused = read(['{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/x"},"error":{"type":"TOOL_ERROR","message":"Permission denied for read_file(/x). Matches user-configured deny rule."}}}}'])[0]!;
  assert.deepEqual(refused.events[1], { type: "tool_result", id: "step-3", output: "Permission denied for read_file(/x). Matches user-configured deny rule.", isError: true });
});

const RECORDING = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "antigravity-review.json"), "utf8")) as { cli: string; sessions: Record<"review" | "signed-out", { lines: string[] }> };
const eventsOf = (lines: readonly string[]): { events: DriverEvent[]; stops: string[] } => {
  const results = read(lines);
  return { events: results.flatMap((r) => r.events), stops: results.flatMap((r) => (r.stop === null ? [] : [r.stop])) };
};

test("a review session recorded from Antigravity 1.5.14 ran as Botbench's agent with no tool step, and becomes its session, the reply as text, the usage, and a completed turn, in that order", () => {
  assert.equal(RECORDING.cli, "1.5.14");
  const init = JSON.parse(RECORDING.sessions.review.lines[0]!) as { event: string; init: { agent?: string } };
  assert.equal(init.init.agent, REVIEW_AGENT);
  const { events, stops } = eventsOf(RECORDING.sessions.review.lines);
  assert.deepEqual(stops, []);
  assert.deepEqual(events.map((e) => e.type), ["session_started", "text", "usage", "turn_ended"]);
  // The model wrote the file as a link: "- [calc.py:2](file:///calc.py#L2): …".
  assert.match((events[1] as { text: string }).text, /^Verdict: concerns\nFindings:\n- \S*calc\.py:2/);
  const usage = events[2] as Extract<DriverEvent, { type: "usage" }>;
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0);
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
});

test("a signed-out session recorded from Antigravity 1.5.14 ends the turn as an error in its own words", () => {
  const { events } = eventsOf(RECORDING.sessions["signed-out"].lines);
  const end = events.at(-1) as { type: string; reason: string; detail: string };
  assert.equal(end.type, "turn_ended");
  assert.equal(end.reason, "error");
  assert.match(end.detail, /authentication/);
  assert.equal(events.some((e) => e.type === "text"), false);
});
