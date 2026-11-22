import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { blank, claudeArgs, parseClaudeLine, parseModelList, parsePermissionRequest, repositoryInstructions, shellWatch } from "../../src/drivers/claude-code.ts";
import { modelNameProblem } from "../../src/drivers/contract.ts";
import { PROXY_SCRIPT } from "../../src/approvals/permission-proxy.ts";
import { tempDir } from "../support/repo.ts";
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
  assert.deepEqual(parseClaudeLine("this is not json"), [{ type: "error", message: "Claude Code printed a line Smelt could not read.", raw: "this is not json" }]);
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

test("an attempt behind the permission gate asks Smelt about every tool call and answers the CLI's prompts itself; the repository's settings stay out", () => {
  const args = claudeArgs({ model: "haiku", allowEdits: true, gated: true, instructionsFile: "/smelt-home/instructions/abc.md" });
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  // The CLI's permission prompts come to Smelt on the protocol it is already driven over; nothing is auto-denied or auto-allowed.
  assert.equal(valueOf("--permission-prompt-tool"), "stdio");
  assert.equal(args.includes("--permission-prompts"), false, "prompts are answered, not dropped");
  assert.equal(args.includes("--permission-mode"), false);
  // The one settings object is Smelt's own, given on the command line: an ask rule for every shell command, and the pre-tool hook.
  assert.equal(args.filter((a) => a === "--settings").length, 1);
  const settings = JSON.parse(valueOf("--settings") ?? "null") as { permissions: { ask: string[]; allow?: unknown }; hooks: Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]> };
  assert.deepEqual(Object.keys(settings).sort(), ["hooks", "permissions"]);
  assert.deepEqual(settings.permissions, { ask: ["Bash"] }, "shell commands always prompt, also when the hook did not run; no allow rule");
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
  assert.equal(settings.hooks.PreToolUse!.length, 1);
  assert.equal(settings.hooks.PreToolUse![0]!.matcher, "*", "every tool call goes to the hook");
  const [hook] = settings.hooks.PreToolUse![0]!.hooks;
  assert.equal(settings.hooks.PreToolUse![0]!.hooks.length, 1);
  assert.equal(hook!.type, "command");
  assert.equal(hook!.command, `'${process.execPath}' '${PROXY_SCRIPT}'`);
  assert.equal(fs.existsSync(PROXY_SCRIPT), true);
  assert.ok(hook!.timeout >= 10 && hook!.timeout <= 60);
  // No secret is on the command line: it travels in the child's environment.
  assert.equal(args.some((a) => /secret/i.test(a)), false);
  // Settings files still do not load, so a repository's allow rules and hooks stay out; its instructions come as text.
  assert.equal(valueOf("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(valueOf("--allowedTools"), "Edit(./**)");
  assert.equal(valueOf("--append-system-prompt-file"), "/smelt-home/instructions/abc.md");
  for (const flag of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--add-dir"]) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }

  // Without the gate nothing changes: every prompt is denied and no settings are given.
  const ungated = claudeArgs({ model: "haiku", allowEdits: true });
  assert.equal(ungated[ungated.indexOf("--permission-prompts") + 1], "none");
  assert.equal(ungated.includes("--settings") || ungated.includes("--permission-prompt-tool") || ungated.includes("--append-system-prompt-file"), false);
  // The gate is only for an attempt in a worktree: without the edit rule it is not switched on.
  assert.equal(claudeArgs({ gated: true }).includes("--permission-prompt-tool"), false);
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
  const dir = tempDir("smelt-instructions-");
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
  const result = { type: "tool_result", id: "toolu_e", output: `HOME=/Users/owner\nSMELT_BROKER_SECRET=${secret}\nSMELT_BROKER_SOCKET=/home/broker.sock`, isError: false } as const;
  const stored = blank(result, secret);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.match(stored.output, /^HOME=\/Users\/owner\nSMELT_BROKER_SECRET=\[the attempt's gate secret, removed by Smelt\]\nSMELT_BROKER_SOCKET=/);
  const call = { type: "tool_call", id: "toolu_c", name: "Bash", input: { command: `echo ${secret} ${secret}` } } as const;
  assert.equal(JSON.stringify(blank(call, secret)).includes(secret), false);
  // An event without it is passed on as it is.
  const text = { type: "text", text: "done" } as const;
  assert.equal(blank(text, secret), text);
});

test("the launch arguments name a model only when one was chosen, as two separate entries", () => {
  for (const options of [{}, { allowEdits: true }, { allowEdits: true, gated: true }, { resumeCursor: "5a850a06-92af-40cd-8cde-1c4435399134" }]) {
    const without = claudeArgs(options);
    assert.equal(without.some((a) => a.startsWith("--model")), false, "no model chosen means the CLI's own default");
    for (const model of ["haiku", "claude-haiku-4-5-20251001", "claude-opus-4-8[1m]"]) {
      const args = claudeArgs({ ...options, model });
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
    assert.throws(() => claudeArgs({ model }), /model/i, JSON.stringify(model));
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
    '{"type":"control_response","response":{"subtype":"success","request_id":"smelt-models","response":{"models":[{"value":"default","resolvedModel":"claude-fable-5-2","displayName":"Default (recommended)","description":"Fable 5.2"},{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"For complex work and everyday tasks"},{"value":"haiku","resolvedModel":"claude-haiku-5-5","displayName":"Haiku 5.5","description":"Fastest for quick answers"},{"value":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5","description":"Fastest for quick answers"}],"claude_code_version":"2.1.322"}}}';
  assert.deepEqual(parseModelList(line), {
    models: [
      { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
      { id: "haiku", label: "Haiku 5.5", resolved: "claude-haiku-5-5" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ],
    cliDefault: "Fable 5.2",
  });
  // What the CLI prints is data: an entry whose name could not be passed back as an argument is left out.
  const odd = '{"type":"control_response","response":{"subtype":"success","request_id":"smelt-models","response":{"models":[{"value":"--bare","displayName":"x"},{"value":"sonnet","resolvedModel":"--not a name"},{"value":7},"haiku"]}}}';
  // The full name an alias stands for is kept only when it is itself a model name; it is what a session reports, so the client can show the label for it.
  assert.deepEqual(parseModelList(odd), { models: [{ id: "sonnet" }], cliDefault: null });
  for (const nothing of ["", "not json", '{"type":"control_response","response":{"subtype":"error","request_id":"smelt-models","error":"no"}}', '{"type":"control_response","response":{"subtype":"success","request_id":"smelt-models","response":{"models":[]}}}', '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}']) {
    assert.equal(parseModelList(nothing), null, nothing);
  }
});

test("a result the CLI marks as an error is an error in its own words, as printed for a model it does not know", () => {
  // Recorded from Claude Code 2.1.322 on 2026-11-22, started with a model name that does not exist; long fields left out.
  const line =
    '{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"duration_api_ms":0,"stop_reason":"stop_sequence","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"terminal_reason":"api_error","result":"There\'s an issue with the selected model (smelt-no-such-model-1). It may not exist or you may not have access to it. Run --model to pick a different model."}';
  const detail = "api_error: There's an issue with the selected model (smelt-no-such-model-1). It may not exist or you may not have access to it. Run --model to pick a different model.";
  assert.deepEqual(parseClaudeLine(line), [
    { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { type: "error", message: detail, raw: null },
    { type: "turn_ended", reason: "error", detail },
  ]);
});
