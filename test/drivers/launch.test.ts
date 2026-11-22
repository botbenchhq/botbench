import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { claudeArgs, parseClaudeLine } from "../../src/drivers/claude-code.ts";
import { buildChildEnv, checkVersion, killProcessGroup, launch, processGroupAlive } from "../../src/drivers/launch.ts";

// Nothing in this file starts `claude`: the children are node and sh.

const KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"];

/** The parent environment of a shell that has provider keys exported. */
function parentWithKeys(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "en_US.UTF-8", SMELT_UNRELATED: "x" };
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
  assert.equal("SMELT_UNRELATED" in env, false, "variables outside the allowlist are dropped");
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
  const args = claudeArgs({ model: "haiku" });
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  assert.equal(valueOf("--setting-sources"), "project", "user and local settings are not loaded");
  assert.ok(args.includes("--strict-mcp-config"), "only the MCP servers Smelt names are used");
  assert.deepEqual(JSON.parse(valueOf("--mcp-config") ?? "null"), { mcpServers: {} }, "and Smelt names none");
  assert.equal(args.filter((a) => a === "--mcp-config").length, 1);
  assert.equal(valueOf("--input-format"), "stream-json");
  assert.equal(valueOf("--output-format"), "stream-json");
  assert.equal(valueOf("--model"), "haiku");
  assert.equal(valueOf("--permission-prompts"), "none", "with no permission broker yet, anything that would ask is denied");
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--settings", "--plugin-dir", "--bare"]) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }
  assert.equal(args.includes("--resume"), false);
});

test("the Claude Code arguments resume a session from its cursor", () => {
  const args = claudeArgs({ resumeCursor: "5a850a06-92af-40cd-8cde-1c4435399134" });
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

test("an output line that is not JSON becomes an error event", () => {
  assert.deepEqual(parseClaudeLine("this is not json"), [{ type: "error", message: "The CLI printed a line that is not JSON.", raw: "this is not json" }]);
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

test("an attempt that may edit gets edits inside its working directory allowed, and loads no settings files at all", () => {
  const args = claudeArgs({ model: "haiku", allowEdits: true });
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
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--settings", "--plugin-dir", "--bare", "--add-dir"]) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }
  // Without the option nothing is allowed, as before.
  assert.equal(claudeArgs({ model: "haiku" }).includes("--allowedTools"), false);
  assert.equal(checkVersion("2.1.322").missingFlags.includes("--allowedTools"), false);
  assert.ok(checkVersion("2.1.0").missingFlags.includes("--allowedTools"));
});

test("a permission the CLI denied becomes a permission_denied event naming the tool call", () => {
  // The line Claude Code 2.1.322 printed on 2026-11-22 when a turn asked to run `sh make-marker.sh` with nobody to approve it
  // (the trailing session_id field is left out).
  const line =
    '{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_01GZ1Xt2X9EptfvaCaRhaiuh","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically","message":"Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically. The action was NOT performed; do not claim it succeeded, and do not retry it: this action, and anything else that requires approval, will be denied the same way for the rest of this session. Tell the user what was blocked and why you needed it, then continue with the parts of the task that do not require approval. What required approval: This command requires approval","uuid":"eb5a6d33-f4dc-4e09-ae39-62acfec51b0a"}';
  assert.deepEqual(parseClaudeLine(line), [
    { type: "permission_denied", id: "toolu_01GZ1Xt2X9EptfvaCaRhaiuh", name: "Bash", reason: "no approval surface in this session; permission request denied automatically" },
  ]);
  assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"permission_denied"}'), [{ type: "permission_denied", id: "", name: "", reason: null }]);
  // Other system lines still carry nothing for the transcript.
  assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"task_summary","summary":"x"}'), []);
});
