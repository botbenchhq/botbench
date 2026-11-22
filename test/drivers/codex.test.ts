import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOME_SECRETS } from "../../src/confinement.ts";
import { CODEX_CAPABILITIES, codexArgs, codexEnv, parseCodexLine, parseCodexModels, parseLoginStatus, REVIEW_PROFILE } from "../../src/drivers/codex.ts";
import { checkVersion } from "../../src/drivers/launch.ts";
import { tempDir } from "../support/repo.ts";

// Nothing in this file starts `codex`.

const DATA_DIR = tempDir("botbench-codex-args-");
const CWD = path.join(DATA_DIR, "worktrees", "run-1", "task-1");
const GIT_DIR = path.join(DATA_DIR, "repo", ".git");
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(GIT_DIR, { recursive: true });
process.on("exit", () => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
const PLACE = { cwd: CWD, dataDir: DATA_DIR, gitDir: GIT_DIR };

/** The value of every `-c key=value` override, by key. */
function overrides(args: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  args.forEach((arg, i) => {
    if (arg !== "-c") return;
    const pair = args[i + 1]!;
    const at = pair.indexOf("=");
    assert.equal(found.has(pair.slice(0, at)), false, `${pair.slice(0, at)} is set once`);
    found.set(pair.slice(0, at), pair.slice(at + 1));
  });
  return found;
}

/** The filesystem rules of the review profile, read back from the inline TOML table (its keys and values are JSON strings). */
function filesystemRules(args: readonly string[]): Map<string, string> {
  const table = overrides(args).get(`permissions.${REVIEW_PROFILE}.filesystem`)!;
  assert.match(table, /^\{.*\}$/);
  const rules = new Map<string, string>();
  for (const match of table.slice(1, -1).matchAll(/("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")/g)) rules.set(JSON.parse(match[1]!) as string, JSON.parse(match[2]!) as string);
  return rules;
}

test("a review turn runs `codex exec` with JSON events, the prompt on its input, no saved session, and none of the owner's own settings, rules, hooks, plugins, apps or MCP servers", () => {
  const args = codexArgs({ place: PLACE, model: "gpt-6-luna" });
  assert.equal(args[0], "exec");
  for (const flag of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules"]) assert.ok(args.includes(flag), flag);
  assert.equal(args.at(-1), "-", "the prompt is read from the input, never put on the command line");
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", CWD]);
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-6-luna"]);
  const set = overrides(args);
  assert.equal(set.get("approval_policy"), '"never"', "nothing ever waits on a prompt nobody can answer: what the profile forbids is refused");
  assert.equal(set.get("mcp_servers"), "{}");
  assert.equal(set.get("web_search"), '"disabled"');
  const disabled = args.flatMap((arg, i) => (arg === "--disable" ? [args[i + 1]] : []));
  for (const feature of ["hooks", "plugins", "apps", "browser_use", "computer_use"]) assert.ok(disabled.includes(feature), `--disable ${feature}`);
});

test("CRITICAL: the review is confined by Botbench's permissions profile and never by --sandbox, which would set the profile aside", () => {
  const args = codexArgs({ place: PLACE });
  assert.equal(args.includes("--sandbox") || args.includes("-s"), false);
  assert.equal(args.some((arg) => /^sandbox_mode\b/.test(arg)), false);
  const set = overrides(args);
  assert.equal(set.get("default_permissions"), JSON.stringify(REVIEW_PROFILE));
  assert.equal(set.get(`permissions.${REVIEW_PROFILE}.extends`), '":read-only"', "commands write nothing, the task's copy included");
  assert.equal(set.get(`permissions.${REVIEW_PROFILE}.network.enabled`), "false");
  assert.equal(args.includes("-m"), false, "no model named: the CLI's own default");
});

test("the profile denies the home folder, every secret place of the one shared list, Codex's moved sign-in and Botbench's data folder, and reads only the task's copy and the repository's git folder", () => {
  const home = os.homedir();
  const rules = filesystemRules(codexArgs({ place: PLACE, env: { CODEX_HOME: "/Volumes/elsewhere/codex" } }));
  assert.equal(rules.get(home), "deny");
  for (const place of HOME_SECRETS) assert.equal(rules.get(path.join(home, place)), "deny", place);
  assert.equal(rules.get(path.join(home, ".codex")), "deny");
  assert.equal(rules.get("/Volumes/elsewhere/codex"), "deny");
  assert.equal(rules.get(DATA_DIR), "deny");
  assert.equal(rules.get(fs.realpathSync(CWD)), "read");
  assert.equal(rules.get(fs.realpathSync(GIT_DIR)), "read");
  assert.deepEqual([...rules.values()].filter((v) => v !== "deny"), ["read", "read"], "nothing is ever writable");
});

test("a path that could break out of the profile's TOML, and a model name that could be a flag, are refused", () => {
  assert.throws(() => codexArgs({ place: { ...PLACE, cwd: '/tmp/a"b' } }), /quote/);
  assert.throws(() => codexArgs({ place: PLACE, model: "--sandbox" }), /model name/);
});

test("AE7: the review's environment has no provider key, keeps Codex's own folder when the owner moved it, and points git away from the denied home folder", () => {
  const env = codexEnv({ ...process.env, OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "y", ANTHROPIC_API_KEY: "z", CODEX_HOME: "/Volumes/elsewhere/codex" });
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"]) assert.equal(name in env, false, name);
  assert.equal(env.CODEX_HOME, "/Volumes/elsewhere/codex");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
});

test("Codex reports what it lacks for any role but review: no resume, no permission requests, no edits; it can be stopped", () => {
  assert.deepEqual(CODEX_CAPABILITIES, { resume: false, interrupt: true, permissionRequests: false, edits: false });
});

test("the login Codex 0.171.0 reports in its own words: ChatGPT is a subscription, an API key is billed by use, anything else is signed out", () => {
  assert.deepEqual(parseLoginStatus("Logged in using ChatGPT\n", 0), { signedIn: true, billing: "subscription" });
  assert.deepEqual(parseLoginStatus("Logged in using an API key - sk-proj-***ABCD\n", 0), { signedIn: true, billing: "metered" });
  assert.deepEqual(parseLoginStatus("Not logged in\n", 1), { signedIn: false, billing: "unknown" });
  assert.deepEqual(parseLoginStatus("Logged in using ChatGPT\n", 1), { signedIn: false, billing: "unknown" }, "a failed status is not a sign-in");
});

test("Codex 0.171.0 is a version Botbench can drive, and an older one is not", () => {
  assert.equal(checkVersion("codex-cli 0.171.0\n", "codex").supported, true);
  assert.equal(checkVersion("codex-cli 0.170.9\n", "codex").supported, false);
});

test("the model catalog keeps the models Codex lists for people, by name, and nothing it hides or that could not be passed back", () => {
  const catalog = JSON.stringify({ models: [
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 8 },
    { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", visibility: "list", priority: 1 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 12 },
    { slug: "--sandbox", display_name: "x", visibility: "list", priority: 2 },
  ] });
  assert.deepEqual(parseCodexModels(catalog), [{ id: "gpt-6.2-sol", label: "GPT-6.2-Sol" }, { id: "gpt-6-luna", label: "GPT-6-Luna" }]);
  assert.equal(parseCodexModels("not json"), null);
  assert.equal(parseCodexModels(JSON.stringify({ models: [] })), null);
});

test("an output line that is not JSON, or not an event, becomes an error event", () => {
  assert.equal(parseCodexLine("oops")[0]?.type, "error");
  assert.equal(parseCodexLine("[1]")[0]?.type, "error");
  assert.deepEqual(parseCodexLine(""), []);
});

const RECORDING = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "codex-review.json"), "utf8")) as { cli: string; sessions: Record<"review" | "signed-out", { lines: string[] }> };
const eventsOf = (lines: readonly string[]) => lines.flatMap(parseCodexLine);

test("a review session recorded from Codex 0.171.0 becomes its session, the reply as text, the usage, and a completed turn, in that order", () => {
  assert.equal(RECORDING.cli, "codex-cli 0.171.0");
  const events = eventsOf(RECORDING.sessions.review.lines);
  assert.deepEqual(events.map((e) => e.type), ["session_started", "text", "usage", "turn_ended"]);
  assert.match((events[0] as { resumeCursor: string }).resumeCursor, /^[0-9a-f-]{36}$/);
  assert.match((events[1] as { text: string }).text, /^Verdict: concerns\nFindings:\n- calc\.py:2:/);
  assert.deepEqual(events[2], { type: "usage", inputTokens: 12124, outputTokens: 31, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(events.at(-1), { type: "turn_ended", reason: "completed", detail: null });
});

test("a signed-out session recorded from Codex 0.171.0 reports each failed connection and ends the turn as an error in Codex's own words", () => {
  const events = eventsOf(RECORDING.sessions["signed-out"].lines);
  assert.equal(events.at(-1)?.type, "turn_ended");
  const end = events.at(-1) as { reason: string; detail: string };
  assert.equal(end.reason, "error");
  assert.match(end.detail, /401 Unauthorized/);
  assert.ok(events.filter((e) => e.type === "error").length >= 5);
  assert.equal(events.some((e) => e.type === "text"), false);
});

test("a command Codex 0.171.0 ran is a call when it starts and a call with its result when it ends; a refused one is an error result marked as kept from a file", () => {
  // Printed by a real `codex exec --json` turn on 0.171.0 that ran `cat calc.py` in a task copy.
  const started = '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'cat calc.py\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
  const completed = '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'cat calc.py\'","aggregated_output":"def add(a, b):\\n    return a - b\\n","exit_code":0,"status":"completed"}}';
  assert.deepEqual(parseCodexLine(started), [{ type: "tool_call", id: "item_0", name: "shell", input: { command: "/bin/zsh -lc 'cat calc.py'" } }]);
  assert.deepEqual(parseCodexLine(completed)[1], { type: "tool_result", id: "item_0", output: "def add(a, b):\n    return a - b\n", isError: false });
  const refused = completed.replace("def add(a, b):\\n    return a - b\\n", "cat: /Users/x/.codex/auth.json: Operation not permitted\\n").replace('"exit_code":0', '"exit_code":1').replace('"status":"completed"', '"status":"failed"');
  assert.deepEqual(parseCodexLine(refused)[1], { type: "tool_result", id: "item_0", output: "cat: /Users/x/.codex/auth.json: Operation not permitted\n", isError: true, confined: { hosts: [], files: true } });
});

test("Codex's notice that it ignored a setting is an error event in its own words (as 0.171.0 printed it for a setting it did not know)", () => {
  const line = '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\\n  session-flags: `projects.\\"/tmp/x\\"` is ignored."}}';
  const [event] = parseCodexLine(line);
  assert.equal(event?.type, "error");
  assert.match((event as { message: string }).message, /unrecognized configuration setting/);
});
