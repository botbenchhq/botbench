import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { blank, claudeArgs, limitedEnd, managedSettingsProblem, parseClaudeLine, parseModelList, parsePermissionRequest, repositoryInstructions, sandboxRefusal, shellWatch } from "../../src/drivers/claude-code.ts";
import { unreadablePaths } from "../../src/confinement.ts";
import { modelNameProblem } from "../../src/drivers/contract.ts";
import { PROXY_SCRIPT, SECRET_ENV, SOCKET_ENV } from "../../src/approvals/permission-proxy.ts";
import { tempDir } from "../support/repo.ts";
import { buildChildEnv, checkVersion, killProcessGroup, launch, processGroupAlive } from "../../src/drivers/launch.ts";

// Nothing in this file starts `claude`: the children are node and sh.

/** Where the attempts below would work: a task's copy inside a Botbench data folder, as real folders. */
const DATA_DIR = tempDir("botbench-args-");
const CWD = path.join(DATA_DIR, "worktrees", "run-1", "task-1");
fs.mkdirSync(CWD, { recursive: true });
process.on("exit", () => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
const CONFINED = { cwd: CWD, dataDir: DATA_DIR, allowedHosts: [] as string[] };

/** The settings object an attempt is started with, as the CLI reads it from the command line. */
function settingsOf(args: string[]): Record<string, unknown> {
  assert.equal(args.filter((a) => a === "--settings").length, 1, "one settings object");
  return JSON.parse(args[args.indexOf("--settings") + 1]!) as Record<string, unknown>;
}

const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"];

/** The parent environment of a shell that has provider keys exported. */
function parentWithKeys(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "en_US.UTF-8", BOTBENCH_UNRELATED: "x" };
  for (const name of KEY_VARS) env[name] = `value-of-${name}`;
  return env;
}

async function stdoutOf(child: ReturnType<typeof launch>["child"]): Promise<string> {
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  await once(child, "close");
  return out;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("AE7: the environment built for a child has no provider API keys", () => {
  const env = buildChildEnv(parentWithKeys());
  for (const name of KEY_VARS) assert.equal(name in env, false, `${name} must not reach the child`);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.LC_ALL, "en_US.UTF-8");
  assert.equal("BOTBENCH_UNRELATED" in env, false, "variables outside the allowlist are dropped");
});

test("AE7: a key cannot be passed back in through the extra variables", () => {
  const env = buildChildEnv(parentWithKeys(), { ANTHROPIC_API_KEY: "again", SOME_VENDOR_API_KEY: "k", CLAUDE_CONFIG_DIR: "/somewhere" });
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("SOME_VENDOR_API_KEY" in env, false);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/somewhere");
});

test("AE7: a real child started by launch does not receive the keys", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "set-in-the-parent";
  try {
    // No environment is handed to launch: it reads the real parent environment itself.
    const { child } = launch(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { cwd: process.cwd() });
    const childEnv = JSON.parse(await stdoutOf(child)) as Record<string, string>;
    assert.equal("ANTHROPIC_API_KEY" in childEnv, false);
    assert.equal(childEnv.HOME, process.env.HOME);
    assert.equal(childEnv.PATH, process.env.PATH);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("the Claude Code arguments leave out personal settings and personal MCP servers", () => {
  const args = claudeArgs({ confinement: CONFINED, model: "haiku" });
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  assert.equal(valueOf("--setting-sources"), "project", "user and local settings are not loaded");
  assert.ok(args.includes("--strict-mcp-config"), "only the MCP servers Botbench names are used");
  assert.deepEqual(JSON.parse(valueOf("--mcp-config") ?? "null"), { mcpServers: {} }, "and Botbench names none");
  assert.equal(args.filter((a) => a === "--mcp-config").length, 1);
  assert.equal(valueOf("--input-format"), "stream-json");
  assert.equal(valueOf("--output-format"), "stream-json");
  assert.equal(valueOf("--model"), "haiku");
  assert.equal(valueOf("--permission-prompts"), "none", "with no permission broker yet, anything that would ask is denied");
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare"]) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }
  // The one settings object holds the sandbox and the read rule, and no hook or permission rule of anyone's.
  assert.deepEqual(Object.keys(settingsOf(args)).sort(), ["permissions", "sandbox"]);
  assert.deepEqual(settingsOf(args).permissions, { blockReadsOutsideWorkingDirectories: true });
  assert.equal(args.includes("--resume"), false);
});

test("the Claude Code arguments resume a session from its cursor", () => {
  const args = claudeArgs({ confinement: CONFINED, resumeCursor: "5a850a06-92af-40cd-8cde-1c4435399134" });
  assert.equal(args[args.indexOf("--resume") + 1], "5a850a06-92af-40cd-8cde-1c4435399134");
  assert.equal(args.includes("--model"), false, "no model named means the CLI's default");
});

test("a CLI version missing a required flag is unsupported", () => {
  const current = checkVersion("2.1.322 (Claude Code)");
  assert.deepEqual(current, { supported: true, version: "2.1.322", missingFlags: [] });
  assert.equal(checkVersion("2.2.0 (Claude Code)").supported, true);
  assert.equal(checkVersion("3.0.1").supported, true);

  const old = checkVersion("1.0.3 (Claude Code)");
  assert.equal(old.supported, false);
  assert.equal(old.version, "1.0.3");
  assert.ok(old.missingFlags.includes("--setting-sources"));
  assert.ok(old.missingFlags.includes("--strict-mcp-config"));
  assert.equal(checkVersion("2.1.321 (Claude Code)").supported, false);

  assert.deepEqual(checkVersion("not a version"), { supported: false, version: null, missingFlags: [] });
  assert.equal(checkVersion("").supported, false);
});

test("killing the process group leaves neither the child nor its grandchild", async () => {
  const { child, pgid } = launch("/bin/sh", ["-c", "sleep 300 & echo $!; wait"], { cwd: process.cwd() });
  child.stdout.setEncoding("utf8");
  const [firstChunk] = (await once(child.stdout, "data")) as [string];
  const grandchild = Number(firstChunk.trim());
  assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  assert.equal(pgid, child.pid);
  assert.equal(pidAlive(grandchild), true);
  assert.equal(processGroupAlive(pgid), true);

  await killProcessGroup(pgid);

  assert.equal(processGroupAlive(pgid), false);
  assert.equal(pidAlive(child.pid!), false);
  assert.equal(pidAlive(grandchild), false);
});

test("a group that ignores the polite signal is killed anyway", async () => {
  const { child, pgid } = launch("/bin/sh", ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"], { cwd: process.cwd() });
  await once(child.stdout, "data");
  await killProcessGroup(pgid, { graceMs: 200 });
  assert.equal(processGroupAlive(pgid), false);
});

test("killing a group that is already gone is not an error", async () => {
  const { child, pgid } = launch(process.execPath, ["-e", ""], { cwd: process.cwd() });
  child.stdout.resume();
  await once(child, "close");
  await killProcessGroup(pgid);
  assert.equal(processGroupAlive(pgid), false);
});

test("a group whose leader has just exited, which macOS answers with EPERM, is waited for and not an error", { skip: process.platform !== "darwin" && "EPERM for such a group is macOS's" }, async (t) => {
  // A real perl forks a child that leads a group of its own and exits at once. Until perl collects it (1.5 seconds
  // later), the group holds only that exited process, and signalling the group gives EPERM, as it does when Claude
  // Code has exited and Botbench has not yet collected it.
  const script = '$| = 1; my $c = fork(); if ($c == 0) { setpgrp(0, 0); exit 0 } select(undef, undef, undef, 0.2); print "$c\\n"; select(undef, undef, undef, 1.5); waitpid($c, 0); sleep 30';
  const { child } = launch("/usr/bin/perl", ["-e", script], { cwd: process.cwd() });
  t.after(() => void child.kill("SIGKILL"));
  child.stdout.setEncoding("utf8");
  const [chunk] = (await once(child.stdout, "data")) as [string];
  const group = Number(chunk.trim());
  assert.ok(Number.isInteger(group) && group > 1);
  assert.throws(() => process.kill(-group, "SIGTERM"), (err: NodeJS.ErrnoException) => err.code === "EPERM", "the group answers EPERM while its exited leader is not collected");
  assert.equal(processGroupAlive(group), true, "EPERM is not read as gone: the group is confirmed empty only once the system no longer knows it");

  await killProcessGroup(group);

  assert.equal(processGroupAlive(group), false);
  assert.throws(() => process.kill(-group, 0), (err: NodeJS.ErrnoException) => err.code === "ESRCH");
});

test("an output line that is not JSON becomes an error event", () => {
  assert.deepEqual(parseClaudeLine("this is not json"), [{ type: "error", message: "Claude Code printed a line Botbench could not read.", raw: "this is not json" }]);
  const [event] = parseClaudeLine('{"type":"assistant","message":');
  assert.equal(event?.type, "error");
  assert.deepEqual(parseClaudeLine("   "), []);
  assert.deepEqual(parseClaudeLine('"just a string"').map((e) => e.type), ["error"]);
});

test("output lines recorded from Claude Code 2.1.322 become normalized events", () => {
  // Lines as the real CLI printed them on 2026-11-21, with long fields left out.
  const session = "5a850a06-92af-40cd-8cde-1c4435399134";
  assert.deepEqual(parseClaudeLine(`{"type":"system","subtype":"init","cwd":"/private/tmp/x","session_id":"${session}","mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.322"}`), [
    { type: "session_started", resumeCursor: session, model: "claude-haiku-5-5", keySource: "none" },
  ]);
  assert.deepEqual(parseClaudeLine(`{"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"},{"type":"text","text":"pong"}],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":4}},"parent_tool_use_id":null,"session_id":"${session}"}`), [
    { type: "text", text: "pong" },
  ]);
  assert.deepEqual(parseClaudeLine(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795734000,"rateLimitType":"seven_day","overageStatus":"rejected","isUsingOverage":false},"session_id":"${session}"}`), [
    { type: "rate_limit", limited: false, status: "allowed", resetsAt: "2026-11-26T23:00:00.000Z" },
  ]);
  assert.deepEqual(
    parseClaudeLine(`{"duration_api_ms":1341,"stop_reason":"end_turn","session_id":"${session}","total_cost_usd":0.00156884,"usage":{"input_tokens":2,"cache_creation_input_tokens":7264,"cache_read_input_tokens":11384,"output_tokens":4},"terminal_reason":"completed","is_error":false,"num_turns":1,"subtype":"success","result":"pong","type":"result"}`),
    [
      { type: "usage", inputTokens: 2, outputTokens: 4, cacheReadTokens: 11384, cacheWriteTokens: 7264 },
      { type: "turn_ended", reason: "completed", detail: null },
    ],
  );
  // The result the CLI printed after an interrupt request.
  assert.deepEqual(
    parseClaudeLine(`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","stop_reason":null,"session_id":"${session}","usage":{"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":18648,"output_tokens":9}}`).map((e) => (e.type === "turn_ended" ? e.reason : e.type)),
    ["usage", "interrupted"],
  );
  // Lines that carry nothing for the transcript.
  assert.deepEqual(parseClaudeLine(`{"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[]}}}`), []);
  assert.deepEqual(parseClaudeLine(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"session_id":"${session}"}`), []);
});

// No capture in test/recordings/ holds a rate_limit_event whose status is "rejected": no real usage limit was reached
// while recording. The lines below take the shape the CLI documents for that event, the same shape as the "allowed"
// line recorded above (rate_limit_info.status, rate_limit_info.resetsAt in seconds since 1970), and are not a capture.
const REJECTED = (resetsAt: string) => `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt},"rateLimitType":"five_hour"},"session_id":"s"}`;

test("a rate_limit_event with status rejected is read as the limit reached, with its reset time as an ISO time, or null when it gives none", () => {
  assert.deepEqual(parseClaudeLine(REJECTED("1795734000")), [{ type: "rate_limit", limited: true, status: "rejected", resetsAt: "2026-11-26T23:00:00.000Z" }]);
  assert.deepEqual(parseClaudeLine(REJECTED('"soon"')), [{ type: "rate_limit", limited: true, status: "rejected", resetsAt: null }]);
  assert.deepEqual(parseClaudeLine(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}`), [{ type: "rate_limit", limited: true, status: "rejected", resetsAt: null }]);
});

test("a turn that ended in error after a rejected rate limit in that turn ends as stopped by the usage limit and carries its reset time; every other end is left as it was", () => {
  const rejected = parseClaudeLine(REJECTED("1795734000"))[0] as Extract<DriverEvent, { type: "rate_limit" }>;
  const noTime = { ...rejected, resetsAt: null };
  const allowed = { ...rejected, limited: false, status: "allowed" };
  const error = { type: "turn_ended" as const, reason: "error" as const, detail: "Claude AI usage limit reached" };
  assert.deepEqual(limitedEnd(error, rejected), { ...error, usageLimit: { resetsAt: "2026-11-26T23:00:00.000Z" } });
  assert.deepEqual(limitedEnd(error, noTime), { ...error, usageLimit: { resetsAt: null } });
  // No rejected event in the turn: an error stays an error.
  assert.deepEqual(limitedEnd(error, null), error);
  assert.deepEqual(limitedEnd(error, allowed), error);
  // A turn that completed or was stopped is not a limit stop, whatever was reported before it.
  for (const reason of ["completed", "interrupted"] as const) assert.deepEqual(limitedEnd({ ...error, reason }, rejected), { ...error, reason });
});

test("a resumed session's result for the CLI's own notice of a background command does not end the turn; the prompt's result does (#111)", () => {
  // Every line the real CLI printed in a resumed attempt (test/support/capture-empty-resumed.ts): first its own notice that
  // a background command did not finish before the previous session ended, answered with a result of no turns, then the prompt's turn.
  const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "fixtures", "empty-resumed-turn", "turn.json"), "utf8")) as { raw: { line: unknown }[] };
  const events = fixture.raw.flatMap((r) => parseClaudeLine(JSON.stringify(r.line)));
  const ends = events.flatMap((e, i) => (e.type === "turn_ended" ? [i] : []));
  assert.equal(ends.length, 1, JSON.stringify(events.map((e) => e.type)));
  assert.equal(ends[0], events.length - 1, "the turn ends at the prompt's result, the last line");
  assert.deepEqual(events.filter((e) => e.type === "text"), [{ type: "text", text: "done" }]);
  // Its usage is still counted, as any turn's.
  assert.equal(events.filter((e) => e.type === "usage").length, 2);
});

test("an attempt that may edit gets edits inside its working directory allowed, and loads no settings files at all", () => {
  const args = claudeArgs({ confinement: CONFINED, model: "haiku", allowEdits: true });
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  // One rule, for the file-editing tools, on paths below the working directory. No shell rule, and no permission mode that allows more.
  assert.equal(valueOf("--allowedTools"), "Edit(./**)");
  assert.equal(args.filter((a) => /^(Bash|Write|Edit|Read|WebFetch)/.test(a)).length, 1, "the edit rule is the only rule");
  assert.equal(args.includes("--permission-mode"), false, "accept-edits mode also lets shell commands such as touch through, so it is not used");
  assert.equal(valueOf("--permission-prompts"), "none", "everything else that would ask is denied");
  // The working directory is a repository's content: its own CLI settings, allow rules and hooks must not load.
  assert.equal(valueOf("--setting-sources"), "");
  assert.equal(args.filter((a) => a === "--setting-sources").length, 1);
  assert.ok(args.includes("--strict-mcp-config"));
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--add-dir"]) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }
  assert.deepEqual(Object.keys(settingsOf(args)).sort(), ["permissions", "sandbox"], "the sandbox only: no hook, no rule");
  // Without the option nothing is allowed, as before.
  assert.equal(claudeArgs({ confinement: CONFINED, model: "haiku" }).includes("--allowedTools"), false);
  assert.equal(checkVersion("2.1.322").missingFlags.includes("--allowedTools"), false);
  assert.ok(checkVersion("2.1.0").missingFlags.includes("--allowedTools"));
});

test("a permission the CLI denied becomes a permission_denied event naming the tool call", () => {
  // The line Claude Code 2.1.322 printed on 2026-11-22 when a turn asked to run `sh make-marker.sh` with nobody to approve it
  // (the trailing session_id field is left out).
  const line =
    '{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_01GZ1Xt2X9EptfvaCaRhaiuh","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically","message":"Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically. The action was NOT performed; do not claim it succeeded, and do not retry it: this action, and anything else that requires approval, will be denied the same way for the rest of this session. Tell the user what was blocked and why you needed it, then continue with the parts of the task that do not require approval. What required approval: This command requires approval","uuid":"eb5a6d33-f4dc-4e09-ae39-62acfec51b0a"}';
  assert.deepEqual(parseClaudeLine(line), [
    { type: "permission_denied", id: "toolu_01GZ1Xt2X9EptfvaCaRhaiuh", name: "Bash", reason: "no approval surface in this session; permission request denied automatically", code: null },
  ]);
  assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"permission_denied"}'), [{ type: "permission_denied", id: "", name: "", reason: null, code: null }]);
  // Other system lines still carry nothing for the transcript.
  assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"task_summary","summary":"x"}'), []);
});

test("an attempt behind the permission gate asks Botbench about every tool call and answers the CLI's prompts itself; the repository's settings stay out", () => {
  const args = claudeArgs({ confinement: CONFINED, model: "haiku", allowEdits: true, gated: true, instructionsFile: "/botbench-home/instructions/abc.md" });
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  // The CLI's permission prompts come to Botbench on the protocol it is already driven over; nothing is auto-denied or auto-allowed.
  assert.equal(valueOf("--permission-prompt-tool"), "stdio");
  assert.equal(args.includes("--permission-prompts"), false, "prompts are answered, not dropped");
  assert.equal(args.includes("--permission-mode"), false);
  // The one settings object is Botbench's own, given on the command line: an ask rule for every shell command, and the pre-tool hook.
  assert.equal(args.filter((a) => a === "--settings").length, 1);
  const settings = JSON.parse(valueOf("--settings") ?? "null") as { permissions: { ask: string[]; allow?: unknown }; hooks: Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]> };
  assert.deepEqual(Object.keys(settings).sort(), ["hooks", "permissions", "sandbox"]);
  assert.deepEqual(settings.permissions, { ask: ["Bash"], blockReadsOutsideWorkingDirectories: true }, "shell commands always prompt, also when the hook did not run; no allow rule");
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
  assert.equal(settings.hooks.PreToolUse!.length, 1);
  assert.equal(settings.hooks.PreToolUse![0]!.matcher, "*", "every tool call goes to the hook");
  const [hook] = settings.hooks.PreToolUse![0]!.hooks;
  assert.equal(settings.hooks.PreToolUse![0]!.hooks.length, 1);
  assert.equal(hook!.type, "command");
  assert.equal(hook!.command, `'${process.execPath}' '${PROXY_SCRIPT}'`);
  assert.equal(fs.existsSync(PROXY_SCRIPT), true);
  assert.ok(hook!.timeout >= 10 && hook!.timeout <= 60);
  // No secret is on the command line: it travels in the child's environment. Its variable's name is, for the sandbox to take it out of commands.
  assert.equal(args.some((a) => /secret/i.test(a.replaceAll(SECRET_ENV, ""))), false);
  // Settings files still do not load, so a repository's allow rules and hooks stay out; its instructions come as text.
  assert.equal(valueOf("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(valueOf("--allowedTools"), "Edit(./**)");
  assert.equal(valueOf("--append-system-prompt-file"), "/botbench-home/instructions/abc.md");
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--add-dir"]) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }

  // Without the gate nothing changes: every prompt is denied, and the settings hold the sandbox and no hook.
  const ungated = claudeArgs({ confinement: CONFINED, model: "haiku", allowEdits: true });
  assert.equal(ungated[ungated.indexOf("--permission-prompts") + 1], "none");
  assert.equal(ungated.includes("--permission-prompt-tool") || ungated.includes("--append-system-prompt-file"), false);
  assert.deepEqual(Object.keys(settingsOf(ungated)).sort(), ["permissions", "sandbox"]);
  for (const flag of ["--settings", "--permission-prompt-tool", "--append-system-prompt-file"]) {
    assert.ok(checkVersion("2.1.0").missingFlags.includes(flag), flag);
    assert.equal(checkVersion("2.1.322").missingFlags.includes(flag), false);
  }
});

test("a permission prompt from the CLI becomes a permission_request, and one that is not whole is refused", () => {
  // The lines Claude Code 2.1.322 printed on 2026-11-22 when a turn asked to run `sh make-marker.sh` and to read /etc/hosts.
  const bash = JSON.parse(
    '{"type":"control_request","request_id":"61aaa015-9aa7-47fa-9803-6047dbd615dd","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"sh make-marker.sh","description":"Run make-marker.sh script"},"description":"Run make-marker.sh script","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"sh make-marker.sh"}],"behavior":"allow","destination":"localSettings"}],"decision_reason":"This command requires approval","decision_reason_type":"other","tool_use_id":"toolu_01HUucZ8GmAgc9Rr4KabZqdQ"}}',
  ) as Record<string, unknown>;
  assert.deepEqual(parsePermissionRequest(bash), {
    type: "permission_request",
    id: "61aaa015-9aa7-47fa-9803-6047dbd615dd",
    toolCallId: "toolu_01HUucZ8GmAgc9Rr4KabZqdQ",
    name: "Bash",
    input: { command: "sh make-marker.sh", description: "Run make-marker.sh script" },
    reason: "Run make-marker.sh script",
  });
  const read = JSON.parse(
    '{"type":"control_request","request_id":"839195ad-1312-493e-9ab5-152e9c9623b1","request":{"subtype":"can_use_tool","tool_name":"Read","display_name":"Read","input":{"file_path":"/etc/hosts"},"description":"/etc/hosts","decision_reason":"Path is outside allowed working directories","decision_reason_type":"workingDir","tool_use_id":"toolu_01MSAwhGMNGxgiDqGb4gw3gh"}}',
  ) as Record<string, unknown>;
  // Only the agent's own account of a shell command is a stated reason; the CLI's label for a file is not.
  assert.deepEqual(parsePermissionRequest(read), { type: "permission_request", id: "839195ad-1312-493e-9ab5-152e9c9623b1", toolCallId: "toolu_01MSAwhGMNGxgiDqGb4gw3gh", name: "Read", input: { file_path: "/etc/hosts" }, reason: null });

  const request = bash.request as Record<string, unknown>;
  for (const broken of [
    { ...bash, request: { ...request, tool_name: "" } },
    { ...bash, request: { ...request, tool_use_id: undefined } },
    { ...bash, request: { ...request, input: "sh make-marker.sh" } },
    { ...bash, request: { ...request, subtype: "hook_callback" } },
    { ...bash, request: null },
    { ...bash, request_id: 7 },
  ]) {
    assert.equal(parsePermissionRequest(broken), null, JSON.stringify(broken).slice(0, 120));
  }
  // The line itself adds nothing to the transcript; the session records the request once it has checked it.
  assert.deepEqual(parseClaudeLine(JSON.stringify(bash)), []);
});

test("a repository's instructions file is handed over as text when it is an ordinary file of the repository, and not otherwise", (t) => {
  const dir = tempDir("botbench-instructions-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, "worktree");
  fs.mkdirSync(worktree);
  assert.equal(repositoryInstructions(worktree), null, "no file, no instructions");

  fs.writeFileSync(path.join(worktree, "CLAUDE.md"), "Use tabs.\n");
  const text = repositoryInstructions(worktree);
  assert.ok(text?.endsWith("Use tabs.\n"));
  assert.match(text ?? "", /^This repository's CLAUDE\.md file says:/);

  // A link out of the worktree is not followed: its target is none of the repository's business.
  fs.writeFileSync(path.join(dir, "private.txt"), "the owner's own notes\n");
  fs.rmSync(path.join(worktree, "CLAUDE.md"));
  fs.symlinkSync(path.join(dir, "private.txt"), path.join(worktree, "CLAUDE.md"));
  assert.equal(repositoryInstructions(worktree), null);
  // Nor is a directory, an empty file, or one too large to be instructions.
  fs.rmSync(path.join(worktree, "CLAUDE.md"));
  fs.mkdirSync(path.join(worktree, "CLAUDE.md"));
  assert.equal(repositoryInstructions(worktree), null);
  fs.rmSync(path.join(worktree, "CLAUDE.md"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "CLAUDE.md"), "");
  assert.equal(repositoryInstructions(worktree), null);
  fs.writeFileSync(path.join(worktree, "CLAUDE.md"), "x".repeat(70_000));
  assert.equal(repositoryInstructions(worktree), null);
});

test("a shell command that ran without the owner having allowed it is noticed from the transcript", () => {
  // The two lines Claude Code 2.1.322 printed on 2026-11-22 when it ran `ls` without asking anyone (long fields left out).
  const call = parseClaudeLine('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01WjxChzdxP4VivfVmLADLYr","name":"Bash","input":{"command":"ls","description":"List files in current directory"},"caller":{"type":"direct"}}]},"session_id":"9d6fe08c-0092-443b-9776-50c737f95496"}');
  const result = parseClaudeLine('{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01WjxChzdxP4VivfVmLADLYr","type":"tool_result","content":"CLAUDE.md\\nREADME.md\\nmake-marker.sh","is_error":false}]},"session_id":"9d6fe08c-0092-443b-9776-50c737f95496"}');
  assert.deepEqual([call.map((e) => e.type), result.map((e) => e.type)], [["tool_call"], ["tool_result"]]);
  const id = "toolu_01WjxChzdxP4VivfVmLADLYr";

  // As it happened: called, then a result, with no request in between.
  const unasked = shellWatch();
  assert.deepEqual([...call, ...result].map(unasked), [false, true]);

  // The same call with the owner's allow in between is what should happen.
  const allowed = shellWatch();
  const asked = [...call, { type: "permission_request", id: "r1", toolCallId: id, name: "Bash", input: { command: "ls" }, reason: null } as const, { type: "permission_resolved", id: "r1", toolCallId: id, decision: "allowed", note: null } as const, ...result];
  assert.deepEqual(asked.map(allowed), [false, false, false, false]);

  // A decline, or a request the CLI gave up on, allows nothing: a result that shows the command ran is noticed.
  for (const decision of ["declined", "cancelled"] as const) {
    const watch = shellWatch();
    assert.deepEqual([...call, { type: "permission_resolved", id: "r1", toolCallId: id, decision, note: null } as const, ...result].map(watch), [false, false, true], decision);
  }
  // A result that says the command did not run is what a decline looks like, and is fine.
  const refused = shellWatch();
  assert.deepEqual([...call, { type: "tool_result", id, output: "The owner denied this request", isError: true } as const].map(refused), [false, false]);
  // Tools other than the shell are the edit rule's and the CLI's own business.
  const other = shellWatch();
  assert.deepEqual([{ type: "tool_call", id: "toolu_w", name: "Write", input: { file_path: "y.txt" } } as const, { type: "tool_result", id: "toolu_w", output: "File created", isError: false } as const].map(other), [false, false]);
});

test("the attempt's gate secret is blanked out of an event before it is stored, wherever in the event it stands", () => {
  const secret = "ab".repeat(32);
  // What an allowed `env` would bring back.
  const result = { type: "tool_result", id: "toolu_e", output: `HOME=/Users/owner\nBOTBENCH_BROKER_SECRET=${secret}\nBOTBENCH_BROKER_SOCKET=/home/broker.sock`, isError: false } as const;
  const stored = blank(result, secret);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.match(stored.output, /^HOME=\/Users\/owner\nBOTBENCH_BROKER_SECRET=\[the attempt's gate secret, removed by Botbench\]\nBOTBENCH_BROKER_SOCKET=/);
  const call = { type: "tool_call", id: "toolu_c", name: "Bash", input: { command: `echo ${secret} ${secret}` } } as const;
  assert.equal(JSON.stringify(blank(call, secret)).includes(secret), false);
  // An event without it is passed on as it is.
  const text = { type: "text", text: "done" } as const;
  assert.equal(blank(text, secret), text);
});

test("the launch arguments name a model only when one was chosen, as two separate entries", () => {
  for (const options of [{}, { allowEdits: true }, { allowEdits: true, gated: true }, { resumeCursor: "5a850a06-92af-40cd-8cde-1c4435399134" }]) {
    const without = claudeArgs({ confinement: CONFINED, ...options });
    assert.equal(without.some((a) => a.startsWith("--model")), false, "no model chosen means the CLI's own default");
    for (const model of ["haiku", "claude-haiku-4-5-20251001", "claude-opus-4-8[1m]"]) {
      const args = claudeArgs({ confinement: CONFINED, ...options, model });
      const at = args.indexOf("--model");
      assert.notEqual(at, -1);
      assert.equal(args[at + 1], model, "the name is an entry of its own");
      assert.equal(args.filter((a) => a.startsWith("--model")).length, 1);
      // Nothing else changed: the same arguments as without a model, plus those two.
      assert.deepEqual(args.filter((_, i) => i !== at && i !== at + 1), without);
    }
  }
  // The driver itself refuses a value that could be read as a flag, whoever hands it over.
  for (const model of ["--dangerously-skip-permissions", "-p", "hai ku", "haiku\n", ""]) {
    assert.throws(() => claudeArgs({ confinement: CONFINED, model }), /model/i, JSON.stringify(model));
  }
});

test("a model name is letters, digits and a few signs, starts with a letter or digit, and is at most 100 characters", () => {
  for (const name of ["haiku", "sonnet", "claude-haiku-4-5-20251001", "claude-opus-4-8[1m]", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "provider/model@v2", "x".repeat(100)]) {
    assert.equal(modelNameProblem(name), null, name);
  }
  for (const name of ["-p", "--model=opus", " haiku", "hai ku", "haiku\n", "hai\u0000ku", "\u2014model", "haiku;rm", "$(id)", "ha'iku", "", "x".repeat(101), 7, null, undefined, ["haiku"]]) {
    assert.match(String(modelNameProblem(name)), /model name/i, JSON.stringify(name));
  }
});

test("the model list Claude Code 2.1.322 reports is read as its choices and its own default; anything else is no list", () => {
  // The CLI's answer to an `initialize` request, as printed on 2026-11-22: four of its fourteen entries, each cut to the
  // fields read here, and without the account it also describes.
  const line =
    '{"type":"control_response","response":{"subtype":"success","request_id":"botbench-models","response":{"models":[{"value":"default","resolvedModel":"claude-fable-5-2","displayName":"Default (recommended)","description":"Fable 5.2"},{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"For complex work and everyday tasks"},{"value":"haiku","resolvedModel":"claude-haiku-5-5","displayName":"Haiku 5.5","description":"Fastest for quick answers"},{"value":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5","description":"Fastest for quick answers"}],"claude_code_version":"2.1.322"}}}';
  assert.deepEqual(parseModelList(line), {
    models: [
      { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
      { id: "haiku", label: "Haiku 5.5", resolved: "claude-haiku-5-5" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ],
    cliDefault: "Fable 5.2",
  });
  // What the CLI prints is data: an entry whose name could not be passed back as an argument is left out.
  const odd = '{"type":"control_response","response":{"subtype":"success","request_id":"botbench-models","response":{"models":[{"value":"--bare","displayName":"x"},{"value":"sonnet","resolvedModel":"--not a name"},{"value":7},"haiku"]}}}';
  // The full name an alias stands for is kept only when it is itself a model name; it is what a session reports, so the client can show the label for it.
  assert.deepEqual(parseModelList(odd), { models: [{ id: "sonnet" }], cliDefault: null });
  for (const nothing of ["", "not json", '{"type":"control_response","response":{"subtype":"error","request_id":"botbench-models","error":"no"}}', '{"type":"control_response","response":{"subtype":"success","request_id":"botbench-models","response":{"models":[]}}}', '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}']) {
    assert.equal(parseModelList(nothing), null, nothing);
  }
});

test("a result the CLI marks as an error is an error in its own words, as printed for a model it does not know", () => {
  // Recorded from Claude Code 2.1.322 on 2026-11-22, started with a model name that does not exist; long fields left out.
  const line =
    '{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"duration_api_ms":0,"stop_reason":"stop_sequence","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"terminal_reason":"api_error","result":"There\'s an issue with the selected model (botbench-no-such-model-1). It may not exist or you may not have access to it. Run --model to pick a different model."}';
  const detail = "api_error: There's an issue with the selected model (botbench-no-such-model-1). It may not exist or you may not have access to it. Run --model to pick a different model.";
  assert.deepEqual(parseClaudeLine(line), [
    { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { type: "error", message: detail, raw: null },
    { type: "turn_ended", reason: "error", detail },
  ]);
});

test("every attempt runs its commands in Claude Code's sandbox: required, asking before each command, never unsandboxed, kept from the secret places and Botbench's data folder but not its own folder, and with no network unless hosts are allowed", (t) => {
  const kinds = { chat: {}, edits: { allowEdits: true }, gated: { allowEdits: true, gated: true }, planner: { readOnly: true, gated: true } };
  for (const [kind, options] of Object.entries(kinds)) {
    const settings = settingsOf(claudeArgs({ confinement: CONFINED, ...options }));
    assert.deepEqual(
      settings.sandbox,
      {
        enabled: true,
        // The CLI refuses to start rather than run commands unconfined.
        failIfUnavailable: true,
        // CRITICAL: with true, the CLI stops asking before a sandboxed command and Botbench's permission check is never heard.
        autoAllowBashIfSandboxed: false,
        // The model cannot ask for a command to run outside the sandbox.
        allowUnsandboxedCommands: false,
        filesystem: { denyRead: unreadablePaths({ dataDir: DATA_DIR }), allowRead: [CWD] },
        // Only an attempt that builds runs a project's tests: it may start servers on this Mac and use Unix sockets in its own folder.
        network: { allowedDomains: [], strictAllowlist: true, ...(kind === "edits" || kind === "gated" ? { allowLocalBinding: true, allowUnixSockets: [CWD] } : {}) },
        // The permission check's address and secret are for Botbench's hook, which runs outside the sandbox; commands never see them.
        credentials: { envVars: [{ name: SOCKET_ENV, mode: "deny" }, { name: SECRET_ENV, mode: "deny" }] },
      },
      kind,
    );
    // The CLI's own file tools run outside the sandbox: they may not read outside the folder the attempt works in.
    assert.equal((settings.permissions as Record<string, unknown>).blockReadsOutsideWorkingDirectories, true, kind);
  }
  // The data folder is denied and the task's copy inside it is not: Claude Code lets the narrower entry win (seen on 2.1.322).
  const denied = (settingsOf(claudeArgs({ confinement: CONFINED })).sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
  assert.ok(denied.includes(DATA_DIR) && !denied.includes(CWD));
  assert.ok(CWD.startsWith(`${DATA_DIR}${path.sep}`));

  // A repository's allowed hosts are the only hosts its commands may reach.
  const allowed = settingsOf(claudeArgs({ confinement: { ...CONFINED, allowedHosts: ["registry.npmjs.org", "github.com"] }, allowEdits: true, gated: true }));
  assert.deepEqual((allowed.sandbox as { network: unknown }).network, { allowedDomains: ["registry.npmjs.org", "github.com"], strictAllowlist: true, allowLocalBinding: true, allowUnixSockets: [CWD] });
  // A host that is not a plain name never gets onto the command line, whoever hands it over.
  assert.throws(() => claudeArgs({ confinement: { ...CONFINED, allowedHosts: ["*.npmjs.org"] } }), /plain host name/);

  // The repository's shared git folder stays readable, so git works in the copy, and is not writable: no command of the
  // agent's moves one of the owner's branches. Botbench makes the task's commit itself, outside the sandbox.
  const gitDir = path.join(DATA_DIR, "repo.git");
  fs.mkdirSync(gitDir, { recursive: true });
  const withGit = settingsOf(claudeArgs({ confinement: { ...CONFINED, gitDir }, allowEdits: true, gated: true }));
  assert.deepEqual((withGit.sandbox as { filesystem: unknown }).filesystem, { denyRead: unreadablePaths({ dataDir: DATA_DIR }), allowRead: [CWD], denyWrite: [gitDir] });

  // The folder Claude Code keeps its sign-in in, when the owner moved it, is denied as well.
  const moved = settingsOf(claudeArgs({ confinement: { ...CONFINED, configDir: "/opt/claude-config" } }));
  assert.ok((moved.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead.includes("/opt/claude-config"));

  // The attempt's own folder is given by its real path, which is what the sandbox compares.
  const linked = path.join(tempDir("botbench-args-link-"), "copy");
  t.after(() => fs.rmSync(path.dirname(linked), { recursive: true, force: true }));
  fs.symlinkSync(CWD, linked);
  assert.deepEqual((settingsOf(claudeArgs({ confinement: { ...CONFINED, cwd: linked } })).sandbox as { filesystem: { allowRead: string[] } }).filesystem.allowRead, [CWD]);
});

test("what the sandbox kept a command from is read out of its result, as Claude Code 2.1.322 reported it, and an ordinary result carries nothing of the kind", () => {
  // Lines Claude Code 2.1.322 printed on 2026-11-22 with Botbench's sandbox settings (paths are the experiment's).
  const network = parseClaudeLine(
    '{"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "toolu_01U1MCiCbkyxo9PR2iaqNAEA", "type": "tool_result", "content": "Exit code 56\\ncurl: (56) CONNECT tunnel failed, response 403\\n000\\n<sandbox_violations>\\ndeny network-outbound example.com:443 (host is not on the allow list)\\n</sandbox_violations>", "is_error": true}]}}',
  );
  assert.deepEqual(network, [{ type: "tool_result", id: "toolu_01U1MCiCbkyxo9PR2iaqNAEA", output: "Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\n000\n<sandbox_violations>\ndeny network-outbound example.com:443 (host is not on the allow list)\n</sandbox_violations>", isError: true, confined: { hosts: ["example.com:443"], files: false } }]);
  const read = parseClaudeLine('{"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "toolu_01URVg9VfbiVeAhZA84vSjGK", "type": "tool_result", "content": "Exit code 1\\ncat: /private/tmp/u27-exp/home/secret.txt: Operation not permitted", "is_error": true}]}}');
  assert.deepEqual(read.map((e) => (e.type === "tool_result" ? e.confined : null)), [{ hosts: [], files: true }]);
  // A command can end well and still have been kept from a file: the CLI marks the result as no error then.
  const quiet = parseClaudeLine('{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01GPiy1tihhaygwtcwr82PXL","type":"tool_result","content":"cat: /private/tmp/u27-exp/home/secret.txt: Operation not permitted\\nr1=1\\nINSIDE-OK\\nr2=0","is_error":false}]}}');
  assert.deepEqual(quiet.map((e) => (e.type === "tool_result" ? [e.isError, e.confined] : null)), [[false, { hosts: [], files: true }]]);
  // The CLI's own Read tool refused a file outside the folder.
  const tool = parseClaudeLine('{"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "toolu_01HMXM3Eoq8776Y2SVSzBsND", "type": "tool_result", "content": "/Users/owner/.u27-exp-home/token is outside /Users/owner/.u27-exp-home/worktrees/r/t; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.", "is_error": true}]}}');
  assert.deepEqual(tool.map((e) => (e.type === "tool_result" ? e.confined : null)), [{ hosts: [], files: true }]);
  const denied = parseClaudeLine('{"type": "system", "subtype": "permission_denied", "tool_name": "Read", "tool_use_id": "toolu_01HMXM3Eoq8776Y2SVSzBsND", "decision_reason_type": "other", "decision_reason_code": "outside_reads_blocked", "decision_reason": "Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting."}');
  assert.deepEqual(denied, [{ type: "permission_denied", id: "toolu_01HMXM3Eoq8776Y2SVSzBsND", name: "Read", reason: "Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.", code: "outside_reads_blocked" }]);

  const ordinary = parseClaudeLine('{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01WjxChzdxP4VivfVmLADLYr","type":"tool_result","content":"CLAUDE.md\\nREADME.md\\nmake-marker.sh","is_error":false}]}}');
  assert.deepEqual(ordinary, [{ type: "tool_result", id: "toolu_01WjxChzdxP4VivfVmLADLYr", output: "CLAUDE.md\nREADME.md\nmake-marker.sh", isError: false }]);
});

test("a CLI that will not start without its sandbox is reported in plain words, with its own reason", () => {
  // The two lines Claude Code 2.1.322 writes to its error output in that case, as its own code holds them (not seen: this Mac has a sandbox).
  const stderr = "\nError: sandbox required but unavailable: sandbox is enabled but cannot start here: sandbox-exec failed\n  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n";
  assert.equal(sandboxRefusal(stderr), "Claude Code did not start: its sandbox cannot run on this computer (sandbox is enabled but cannot start here: sandbox-exec failed), and Botbench does not let an agent run commands without it. Nothing was run.");
  assert.equal(sandboxRefusal("Error: something else\n"), null);
});

test("Claude Code with managed settings on this Mac starts no agent, since they come before Botbench's; a folder with a glob character cannot be confined", (t) => {
  assert.equal(managedSettingsProblem(), null, "this Mac has no managed settings");
  const dir = tempDir("botbench-managed-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "managed-settings.json");
  fs.writeFileSync(file, "{}");
  assert.match(managedSettingsProblem([path.join(dir, "absent.json"), file]) ?? "", /managed settings on this Mac .*managed-settings\.json.*starts no agent/);
  assert.throws(() => claudeArgs({ confinement: { ...CONFINED, cwd: "/tmp/data[1]/copy" } }), /\*, \? or \[/);
});

test("no attempt can start work that outlives its turn: the subagent, scheduling, background and remote tools are denied to the builder, the planner and chat alike", () => {
  // The names as Claude Code 2.1.322 lists them in its init event, each checked to leave that list when denied by name
  // (the subagent tool is listed as Task and also answers to Agent; denying either removes it).
  const outliving = ["Agent", "Task", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "Monitor", "TaskStop", "SendMessage", "ListAgents", "Workflow", "EnterWorktree", "ExitWorktree", "PushNotification"];
  const kinds = { chat: {}, edits: { allowEdits: true }, builder: { allowEdits: true, gated: true }, planner: { readOnly: true, gated: true } };
  for (const [kind, options] of Object.entries(kinds)) {
    const args = claudeArgs({ confinement: CONFINED, model: "haiku", ...options });
    assert.equal(args.filter((a) => a === "--disallowedTools").length, 1, `${kind}: one list of denied tools`);
    const denied = args[args.indexOf("--disallowedTools") + 1]!.split(",");
    for (const tool of outliving) assert.ok(denied.includes(tool), `${kind}: ${tool} is denied`);
    // The planner keeps its writing tools denied as well.
    if (kind === "planner") for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.ok(denied.includes(tool), `${kind}: ${tool}`);
    else assert.ok(!denied.includes("Edit"), `${kind} may still edit`);
  }
});

test("a chat's Claude Code goes through the gate with the CLI's full set of tools: no settings file, its prompts answered, only the tools that outlive a turn denied", () => {
  const args = claudeArgs({ confinement: CONFINED, model: "haiku", gated: true });
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  // The chat's folder is one the agent may write in: a settings file it wrote there must not be loaded by the next turn.
  assert.equal(valueOf("--setting-sources"), "");
  assert.equal(valueOf("--permission-prompt-tool"), "stdio");
  assert.equal(args.includes("--permission-prompts"), false, "prompts are answered, not dropped");
  const settings = settingsOf(args);
  assert.deepEqual(Object.keys(settings).sort(), ["hooks", "permissions", "sandbox"]);
  assert.deepEqual(settings.permissions, { ask: ["Bash"], blockReadsOutsideWorkingDirectories: true });
  // Nothing narrows the CLI's own tools: no list of tools, and the web tools are not denied.
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--allowedTools"), false, "no edit rule: Botbench's gate decides about each edit");
  const denied = valueOf("--disallowedTools")!.split(",");
  for (const tool of ["WebFetch", "WebSearch", "Bash", "Read", "Write", "Edit"]) assert.equal(denied.includes(tool), false, tool);
  // The chat's commands still reach no host.
  assert.deepEqual((settings.sandbox as { network: { allowedDomains: string[] } }).network.allowedDomains, []);
});
