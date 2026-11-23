import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SANDBOX_EXEC } from "../../src/confinement.ts";
import { acpLines, acpReader, acpStartProblem, continuation, MAX_CONTINUATIONS, requestPaths, type AcpToolRequest } from "../../src/drivers/acp-turn.ts";
import {
  AGY_CHAT_TOOLS, AGY_CONFIG_DENIED, AGY_REVIEW_TOOLS, agyTerminal, AGY_WEB_TOOLS, agentDefinition, agentName, agyDecide, agyLoopback, agyProgram, agyTools, agyToolsProfile, plantedConfigProblem,
  ANTIGRAVITY_CAPABILITIES, antigravityProfile, antigravitySignIn, AntigravityDriver, parseAcpModels, prepareProfile, profileGeminiDir, profileSignedIn, resolvedPath, signInSandbox, SIGN_IN_FILES, writeAgent,
} from "../../src/drivers/antigravity.ts";
import { KEYCHAIN_DENIED, ownProgramOnly } from "../../src/drivers/cli-sandbox.ts";
import { createConnect } from "../../src/drivers/connect.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { buildChildEnv } from "../../src/drivers/launch.ts";
import { parseAntigravitySignIn, pastedAntigravityCode } from "../../src/drivers/sign-in.ts";
import { IMPLEMENTER, PLANNER, REVIEWER, roleProblem } from "../../src/engine/roles.ts";
import { openStore } from "../../src/store/db.ts";
import { NO_SANDBOX } from "../support/confined.ts";
import { fill, randomState, replayed } from "../support/replay-sign-in.ts";
import { tempDir } from "../support/repo.ts";

// Nothing in this file starts `agy`: its sign-in is replayed from test/recordings/sign-in/antigravity-1.5.14.json and
// its sessions are read from test/recordings/antigravity-acp.json. test/live/antigravity-tools.live.test.ts runs it.

const RECORDING = path.resolve(import.meta.dirname, "..", "recordings", "sign-in", "antigravity-1.5.14.json");
const ACP = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "antigravity-acp.json"), "utf8")) as { sessions: Record<string, { lines: string[] }> };
const capture = JSON.parse(fs.readFileSync(RECORDING, "utf8")) as { beforeCode: { stdout: string }; wrongCode: { stdout: string } };
type T = { after(fn: () => unknown): void };
const dataDir = (t: T): string => {
  const dir = fs.realpathSync(tempDir("botbench-agy-data-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("Antigravity's sign-in link is read from its real output once it asks for the code, and only Google's page that lands on Antigravity's code page", () => {
  const output = fill(capture.beforeCode.stdout, randomState());
  const prompt = parseAntigravitySignIn(output);
  assert.ok(prompt);
  const url = new URL(prompt.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://antigravity.google/oauth-callback");
  assert.equal(prompt.code, null);
  assert.equal(parseAntigravitySignIn(output.slice(0, output.indexOf("Then paste"))), null, "not before it waits for the code");
  assert.equal(parseAntigravitySignIn(output.replaceAll("accounts.google.com", "accounts.google.com.example.net")), null);
  assert.equal(parseAntigravitySignIn(output.replace("antigravity.google%2Foauth-callback", "evil.example%2Fx")), null, "a link that would land anywhere else is not shown");
});

test("what the owner pastes back is the page's code, or the address of Antigravity's own code page, on one line; nothing else goes to the CLI", () => {
  assert.equal(pastedAntigravityCode(" 4/0AVGzR1abc-_xyz "), "4/0AVGzR1abc-_xyz");
  const page = "https://antigravity.google/oauth-callback?state=abc&code=4%2F0AVG&scope=email";
  assert.equal(pastedAntigravityCode(page), page);
  for (const bad of ["https://evil.example/oauth-callback?code=1", "https://antigravity.google/other?code=1", "https://antigravity.google/oauth-callback?state=1", "two words", "https://antigravity.google/oauth-callback?code=1\nrm -rf /", 42]) assert.equal(pastedAntigravityCode(bad), null, String(bad));
});

test("CRITICAL: Connect runs Antigravity's own sign-in for Botbench's profile: `agy acp --login --gemini-dir <profile>` under a sandbox that refuses the Keychain and every secret place, and opens no browser", (t) => {
  const data = dataDir(t);
  const signIn = antigravitySignIn(data);
  assert.equal(signIn.command, SANDBOX_EXEC);
  const args = signIn.args;
  const profile = fs.realpathSync(antigravityProfile(data));
  assert.deepEqual(args.slice(2), ["agy", "acp", "--login", "--gemini-dir", profileGeminiDir(profile)]);
  assert.equal(fs.statSync(profile).mode & 0o777, 0o700, "the profile is the owner's alone");
  const sandbox = args[1]!;
  assert.ok(sandbox.includes(KEYCHAIN_DENIED), "no Keychain: the sign-in is written to the profile, never over the owner's own");
  assert.ok(sandbox.includes(`(subpath "${path.join(os.homedir(), ".gemini")}")`), "the owner's ~/.gemini is on the unreadable list");
  assert.match(sandbox, /\(deny file-write\*\)/);
  assert.equal(signIn.env.BROWSER, "/usr/bin/true");
  assert.equal(signIn.keptByBotbench, true);
  assert.equal(signIn.takesCode, true);
  assert.equal(signInSandbox({ dataDir: data, profile }), sandbox);
});

test("a profile that is a link is refused; one that exists is made the owner's alone", (t) => {
  const data = dataDir(t);
  fs.symlinkSync(os.tmpdir(), path.join(data, "antigravity"));
  assert.throws(() => prepareProfile(data), /not a folder/);
  const other = dataDir(t);
  fs.mkdirSync(path.join(other, "antigravity"), { mode: 0o755 });
  prepareProfile(other);
  assert.equal(fs.statSync(path.join(other, "antigravity")).mode & 0o777, 0o700);
});

test("CRITICAL: connected is the sign-in file's existence, never its content (a file nobody can read still counts); signing out removes only that file and runs no command", async (t) => {
  const data = dataDir(t);
  const profile = prepareProfile(data);
  assert.equal(profileSignedIn(profile), false);
  const token = path.join(profile, SIGN_IN_FILES[0]!);
  fs.mkdirSync(path.dirname(token), { recursive: true });
  fs.writeFileSync(token, "not read");
  fs.chmodSync(token, 0o000);
  fs.writeFileSync(path.join(path.dirname(token), "other"), "kept");
  assert.equal(profileSignedIn(profile), true, "a file Botbench cannot read is still the sign-in: it is not read");
  fs.chmodSync(token, 0o600);
  fs.writeFileSync(token, "");
  assert.equal(profileSignedIn(profile), false, "an empty file is no sign-in");
  fs.writeFileSync(token, "x");
  const driver = new AntigravityDriver({ dataDir: data });
  const connect = createConnect({ agents: [{ signIn: { ...driver.signIn, command: "/usr/bin/false" }, probe: async () => ({ installed: true, version: "1.5.14", supported: true, signedIn: profileSignedIn(profile), billing: "subscription", problem: null }) }] });
  t.after(() => connect.close());
  assert.equal((await connect.signOut("antigravity")).signedIn, false, "signed out, with no command run (the command here would fail)");
  assert.equal(fs.existsSync(token), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(token), "other"), "utf8"), "kept", "nothing else of the profile is touched");
});

test("the sign-in, replayed from the real CLI: Connect shows Google's link and waits; the page's address goes back to the CLI; a wrong code fails in the CLI's own words; the view says the sign-in is Botbench's own", async (t) => {
  const data = dataDir(t);
  const state = randomState();
  const signIn = replayed(antigravitySignIn(data), RECORDING, "wait", state);
  const connect = createConnect({ agents: [{ signIn, probe: async () => ({ installed: true, version: "1.5.14", supported: true, signedIn: false, billing: "unknown", problem: "signed out" }) }] });
  t.after(() => connect.close());
  const waiting = await connect.start("antigravity");
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.keptByBotbench, true);
  assert.equal(new URL(waiting.url!).searchParams.get("state"), state.slice(0, 22));
  assert.throws(() => connect.sendCode("antigravity", "https://evil.example/oauth-callback?code=1"), /not a code/);
  assert.equal(connect.sendCode("antigravity", "https://antigravity.google/oauth-callback?state=s&code=4%2F0A").state, "checking");
  for (let i = 0; i < 100 && connect.view("antigravity").state === "checking"; i++) await new Promise((r) => setTimeout(r, 20));
  const failed = connect.view("antigravity");
  assert.equal(failed.state, "failed");
  assert.match(failed.reason ?? "", /couldn't log in: token exchange failed/);
  assert.match(capture.wrongCode.stdout, /invalid_grant/);
});

test("a provider key in Botbench's environment never reaches Antigravity, nor do Google's project and Vertex settings", () => {
  const env = buildChildEnv({ PATH: "/usr/bin", HOME: "/Users/x", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/x.json", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_GENAI_USE_VERTEXAI: "true", AGY_ACP_CCPA_PROJECT: "p" }, { AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  assert.deepEqual(Object.keys(env).sort(), ["AGY_CLI_DISABLE_AUTO_UPDATE", "HOME", "PATH"]);
});

test("the program `agy` starts is found through Homebrew's script, which must name exactly one Mach-O program; else none", { skip: process.platform === "darwin" ? false : `this computer runs ${process.platform}, and a Mach-O program is macOS's alone. Run npm test on a Mac to test this.` }, (t) => {
  const dir = fs.realpathSync(tempDir("botbench-agy-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const program = path.join(dir, "antigravity");
  fs.copyFileSync("/usr/bin/true", program);
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "${program}"  "$@"\n`, { mode: 0o755 });
  assert.equal(agyProgram({ PATH: bin }), program);
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/bash\nexec "${program}" "$@"\nexec "/bin/sh" "$@"\n`, { mode: 0o755 });
  assert.equal(agyProgram({ PATH: bin }), null, "two programs named: none is trusted");
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/bash\nexec "/etc/hosts" "$@"\n`, { mode: 0o755 });
  assert.equal(agyProgram({ PATH: bin }), null, "not a program");
  fs.rmSync(path.join(bin, "agy"));
  fs.symlinkSync(program, path.join(bin, "agy"));
  assert.equal(agyProgram({ PATH: bin }), program);
  assert.equal(agyProgram({ PATH: "relative/bin" }), null);
});

test("CRITICAL: the sandbox of a turn keeps Botbench's profile, the sign-in in it, to Antigravity's own program, refuses the Keychain, MCP and hook files, and lets only Antigravity use this Mac's loopback", () => {
  const program = "/opt/agy/antigravity";
  const profile = agyToolsProfile({ dataDir: "/data", profile: "/data/antigravity", folder: "/data/scratch", readOnly: ["/repo"], temp: "/tmp/t", proxyPort: 4242, program, home: "/Users/someone" });
  for (const rule of ownProgramOnly({ own: ["/data/antigravity"], program, starter: SANDBOX_EXEC })) assert.ok(profile.includes(rule), rule);
  assert.ok(profile.includes(`(deny file-read* file-write* (require-all (subpath "/data/antigravity") (require-not (process-path "${program}"))))`));
  assert.ok(profile.includes(`(deny process-exec (require-all (literal "${program}") (require-not (process-path "${program}")) (require-not (process-path "${SANDBOX_EXEC}"))))`), "a command cannot start Antigravity again");
  for (const rule of [KEYCHAIN_DENIED, AGY_CONFIG_DENIED, agyTerminal(program), ...agyLoopback(program)]) assert.ok(profile.includes(rule), rule);
  for (const rule of agyLoopback(program)) assert.ok(rule.includes(`(process-path "${program}")`), "the loopback is Antigravity's alone");
  assert.ok(profile.includes('(deny file-read* (subpath "/Users/someone")'), "the home folder is unreadable");
  assert.ok(profile.includes('(allow network-outbound (remote ip "localhost:4242"))'));
  // The rules that narrow come last: sandbox-exec takes the last rule that matches.
  assert.ok(profile.indexOf("(require-not (process-path") > profile.lastIndexOf('(allow file-read* (subpath "/data/antigravity")'), "after the profile is opened");
});

test("CRITICAL: under the rules that keep a folder to one program, the program reads it and any other cannot, nor start the program; a repository's MCP file cannot be read", { skip: NO_SANDBOX }, (t) => {
  const dir = fs.realpathSync(tempDir("botbench-agy-own-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const own = path.join(dir, "own");
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, "secret"), "SECRET\n");
  fs.mkdirSync(path.join(dir, "repo", ".agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "repo", ".agents", "mcp_config.json"), "{}\n");
  const profile = ["(version 1)", "(allow default)", ...ownProgramOnly({ own: [own], program: "/usr/bin/head", starter: SANDBOX_EXEC }), AGY_CONFIG_DENIED, ""].join("\n");
  const run = (argv: string[]) => spawnSync(SANDBOX_EXEC, ["-p", profile, ...argv], { encoding: "utf8" });
  assert.equal(run(["/usr/bin/head", "-1", path.join(own, "secret")]).stdout, "SECRET\n", "the program itself reads its folder");
  assert.notEqual(run(["/bin/cat", path.join(own, "secret")]).status, 0, "another program cannot");
  assert.notEqual(run(["/bin/ls", own]).status, 0, "nor list it");
  const again = run(["/bin/sh", "-c", `/usr/bin/head -1 ${path.join(own, "secret")}`]);
  assert.notEqual(again.status, 0, "a command cannot start the program to read it");
  assert.equal(again.stdout.includes("SECRET"), false);
  assert.notEqual(run(["/bin/cat", path.join(dir, "repo", ".agents", "mcp_config.json")]).status, 0, "no MCP file is read");
  // This Mac's volume ignores case: `.AGENTS/HOOKS.JSON` is a file of the `.agents` folder.
  fs.writeFileSync(path.join(dir, "repo", ".agents", "HOOKS.JSON"), "{}\n");
  assert.notEqual(run(["/bin/cat", path.join(dir, "repo", ".AGENTS", "HOOKS.JSON")]).status, 0, "in any case");
  // A program of the owner's that is kept to itself, as Antigravity's is (Homebrew's is the owner's): it cannot be
  // linked under another name, and a copy is another program, with none of its rights.
  const program = path.join(dir, "prog");
  fs.copyFileSync("/usr/bin/head", program);
  const mine = ["(version 1)", "(allow default)", ...ownProgramOnly({ own: [own], program, starter: SANDBOX_EXEC }), ""].join("\n");
  const link = spawnSync(SANDBOX_EXEC, ["-p", mine, "/bin/ln", program, path.join(dir, "linked")], { encoding: "utf8" });
  assert.notEqual(link.status, 0, `no hard link to the program: ${link.stderr}`);
  fs.copyFileSync(program, path.join(dir, "copied"));
  const copied = spawnSync(SANDBOX_EXEC, ["-p", mine, path.join(dir, "copied"), "-1", path.join(own, "secret")], { encoding: "utf8" });
  assert.equal(copied.stdout.includes("SECRET"), false, "a copy has none of the program's rights");
});

test("a turn does not start where a link stands in for the folder or files Antigravity reads its MCP servers and hooks from, in any case", (t) => {
  const dir = fs.realpathSync(tempDir("botbench-agy-planted-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "folder");
  fs.mkdirSync(path.join(folder, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".agents", "rules.md"), "x");
  assert.equal(plantedConfigProblem([folder]), null);
  fs.writeFileSync(path.join(dir, "x.json"), "{}");
  fs.symlinkSync(path.join(dir, "x.json"), path.join(folder, ".agents", "MCP_config.json"));
  assert.match(plantedConfigProblem([folder]) ?? "", /MCP_config\.json is a link/);
  const other = path.join(dir, "other");
  fs.mkdirSync(path.join(dir, "cfg"));
  fs.mkdirSync(other);
  fs.symlinkSync(path.join(dir, "cfg"), path.join(other, "_Agents"));
  assert.match(plantedConfigProblem([path.join(dir, "missing"), other]) ?? "", /_Agents is a link/);
});

const req = (o: Partial<AcpToolRequest>): AcpToolRequest => ({ id: "1", toolCallId: "c", name: "read_file", kind: "read", rawInput: {}, paths: [], ...o });

test("CRITICAL: Botbench's answer to each permission request: its data folder is refused, reading and changing inside the chat's folder never ask, a repository is only read, a command goes to the permission check, and anything outside asks", (t) => {
  const data = dataDir(t);
  const folder = path.join(data, "scratch");
  const repo = fs.realpathSync(tempDir("botbench-agy-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(folder);
  fs.mkdirSync(path.join(data, "antigravity", ".gemini", "antigravity-cli"), { recursive: true });
  fs.symlinkSync(path.join(data, "antigravity", ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(folder, "link"));
  const chat = { folder, writable: true, readable: [repo], dataDir: data, kept: agyTools({ mode: "chat" }) };
  assert.deepEqual(agyDecide(req({ paths: [path.join(folder, "a.txt")] }), chat), { answer: "allow", rule: "files" });
  assert.deepEqual(agyDecide(req({ name: "write_file", kind: "edit", paths: [path.join(folder, "new", "b.txt")] }), chat), { answer: "allow", rule: "files" });
  assert.deepEqual(agyDecide(req({ paths: [path.join(repo, "README.md")] }), chat), { answer: "allow", rule: "files" });
  assert.equal((agyDecide(req({ name: "edit_file", kind: "edit", paths: [path.join(repo, "README.md")] }), chat) as { answer: string }).answer, "deny", "the repository is only read");
  for (const into of [path.join(data, "antigravity", ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(folder, "link"), path.join(data, "botbench.sqlite")]) {
    const answer = agyDecide(req({ paths: [into] }), chat);
    assert.equal((answer as { answer?: string }).answer, "deny", `${into} is in Botbench's data folder, also through a link`);
  }
  assert.deepEqual(agyDecide(req({ name: "run_command", kind: "execute", rawInput: { CommandLine: "ls -la" } }), chat), { ask: { name: "Bash", input: { command: "ls -la" } } });
  assert.deepEqual(agyDecide(req({ paths: ["/etc/hosts"] }), chat), { ask: { name: "Read", input: { file_path: "/private/etc/hosts" } } });
  assert.deepEqual(agyDecide(req({ name: "write_file", kind: "edit", paths: ["/tmp/x/out.txt"] }), chat), { ask: { name: "Edit", input: { file_path: path.join(fs.realpathSync("/tmp"), "x", "out.txt") } } });
  assert.equal((agyDecide(req({ name: "schedule", kind: "other" }), chat) as { answer: string }).answer, "deny", "a tool Botbench did not give is refused");
  // A request naming a place inside and one outside is put to the check by the one outside.
  assert.deepEqual(agyDecide(req({ paths: [path.join(folder, "a"), "/etc/hosts"] }), chat), { ask: { name: "Read", input: { file_path: "/private/etc/hosts" } } });
  assert.deepEqual(agyDecide(req({ name: "write_file", kind: "move", paths: [path.join(folder, "a"), "/tmp/b"] }), chat), { ask: { name: "write_file", input: { file_path: path.join(fs.realpathSync("/tmp"), "b") } } });
  // A command's own folder counts: one run in Botbench's data folder is refused.
  const inData = { CommandLine: "ls", Cwd: path.join(data, "antigravity") };
  assert.equal((agyDecide(req({ name: "run_command", kind: "execute", rawInput: inData, paths: requestPaths({ rawInput: inData }) }), chat) as { answer: string }).answer, "deny");
  // The profile is refused wherever it is, even outside the data folder named for the turn.
  assert.equal((agyDecide(req({ paths: ["/somewhere/profile/x"] }), { ...chat, profile: "/somewhere/profile" }) as { answer: string }).answer, "deny");
  // A review: the task's copy is read, never changed.
  const review = { folder: repo, writable: false, readable: [], dataDir: data, kept: agyTools({ mode: "review" }) };
  assert.deepEqual(agyDecide(req({ paths: [path.join(repo, "README.md")] }), review), { answer: "allow", rule: "files" });
  assert.equal((agyDecide(req({ name: "write_file", kind: "edit", paths: [path.join(repo, "x")] }), review) as { answer: string }).answer, "deny");
});

test("the paths of a request are its locations and its input's path fields; a path that does not exist yet resolves through its nearest folder", () => {
  assert.deepEqual(requestPaths({ locations: [{ path: "/a" }], rawInput: { Path: "/b", Content: "/c", TargetFile: "/d", CommandLine: "cat /e" } }).sort(), ["/a", "/b", "/d"]);
  assert.equal(resolvedPath("new/dir/f.txt", "/tmp"), path.join(fs.realpathSync("/tmp"), "new", "dir", "f.txt"));
});

test("Botbench's agent has exactly the tools of its turn: files, commands and its command list in a chat, reading and commands in a review, Google's search only with Web access Allow; never schedule or subagents", (t) => {
  assert.deepEqual(agyTools({ mode: "chat" }), ["read_file", "write_file", "edit_file", "run_command", "manage_task"]);
  assert.deepEqual(agyTools({ mode: "review" }), ["read_file", "run_command", "manage_task"]);
  assert.deepEqual(agyTools({ mode: "chat", webSearch: true }), [...AGY_CHAT_TOOLS, ...AGY_WEB_TOOLS]);
  for (const tools of [AGY_CHAT_TOOLS, AGY_REVIEW_TOOLS]) for (const never of ["schedule", "define_subagent", "invoke_subagent", "swarm", "send_message", "run_workflow"]) assert.equal(tools.includes(never), false, never);
  const definition = agentDefinition(agyTools({ mode: "review", webSearch: true }));
  assert.match(definition, /^---\nname: botbench-review-web\n/);
  assert.match(definition, /\ntools: \[read_file, run_command, manage_task, search_web\]\n/);
  assert.match(definition, /\nmcpServers: \[\]\n/);
  assert.match(definition, /\nsubagent: false\n/);
  const data = dataDir(t);
  const profile = prepareProfile(data);
  const name = writeAgent(profile, agyTools({ mode: "chat" }));
  assert.equal(name, agentName(agyTools({ mode: "chat" })));
  const file = path.join(profileGeminiDir(profile), "config", "agents", `${name}.md`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a captured chat turn of `agy acp` reads as the reply, its usage and a completed turn; a captured signed-out session says to connect in Settings", () => {
  const read = (lines: string[]): DriverEvent[] => {
    const r = acpLines("Antigravity", AGY_CHAT_TOOLS)();
    return lines.flatMap((line) => r(line).events);
  };
  const chat = read(ACP.sessions.chat!.lines);
  assert.ok(chat.some((e) => e.type === "session_started"));
  const text = chat.filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("");
  assert.ok(text.trim().length > 0);
  assert.ok(chat.some((e) => e.type === "usage" && e.inputTokens > 0));
  assert.deepEqual(chat.at(-1), { type: "turn_ended", reason: "completed", detail: null });
  const out = read(ACP.sessions["signed-out"]!.lines);
  assert.match(JSON.stringify(out.at(-1)), /not signed in in Botbench\. Connect it in Settings/);
  assert.match(acpStartProblem("Antigravity", { code: -32603, message: "boom" }), /could not start a session: boom/);
  const review = read(ACP.sessions.review!.lines);
  assert.equal(review.at(-1)?.type, "turn_ended");
});

test("a tool the turn was not given stops the turn at its call; a reply is given whole before a call", () => {
  const read = acpReader("Antigravity", AGY_REVIEW_TOOLS)();
  assert.deepEqual(read({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } }).events, []);
  const called = read({ sessionUpdate: "tool_call", toolCallId: "c1", name: "read_file", rawInput: { Path: "/x" } });
  assert.deepEqual(called, { events: [{ type: "text", text: "Looking" }, { type: "tool_call", id: "c1", name: "read_file", input: { Path: "/x" } }], stop: null });
  const done = read({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { output: "ok" } });
  assert.deepEqual(done.events, [{ type: "tool_result", id: "c1", output: "ok", isError: false }]);
  const wrote = read({ sessionUpdate: "tool_call", toolCallId: "c2", name: "write_file", rawInput: {} });
  assert.match(wrote.stop ?? "", /did not give it \(write_file\)/);
  assert.match(read({ sessionUpdate: "tool_call", toolCallId: "c3", name: "schedule" }).stop ?? "", /schedule/);
});

test("the models Antigravity lists for the profile are read from session/new", () => {
  assert.deepEqual(parseAcpModels({ models: { availableModels: [{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { modelId: "--bad" }] } }), [{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }]);
  assert.equal(parseAcpModels({}), null);
});

test("Antigravity reviews and chats with its tools and asks before it acts; it is never the builder or the planner", () => {
  assert.deepEqual(ANTIGRAVITY_CAPABILITIES, { resume: false, interrupt: true, permissionRequests: true, edits: false, confinedCommands: true, chatTools: true });
  assert.equal(roleProblem(REVIEWER, "antigravity", ANTIGRAVITY_CAPABILITIES), null);
  assert.match(roleProblem(IMPLEMENTER, "antigravity", ANTIGRAVITY_CAPABILITIES) ?? "", /cannot be the builder/);
  assert.match(roleProblem(PLANNER, "antigravity", ANTIGRAVITY_CAPABILITIES) ?? "", /cannot be the planner/);
});

test("an attempt that would edit a task's copy, resume, or reach a host is refused before anything starts", async (t) => {
  const data = dataDir(t);
  const db = openStore(data);
  t.after(() => db.close());
  const driver = new AntigravityDriver({ dataDir: data });
  const base = { db, cwd: data, confinement: { dataDir: data, allowedHosts: [] as string[] } };
  await assert.rejects(driver.startAttempt({ ...base, allowEdits: true }), /never edits/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, resumeCursor: "x" }), /cannot resume/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, confinement: { dataDir: data, allowedHosts: ["example.com"] } }), /no network/);
  await assert.rejects(driver.startAttempt({ ...base, chatTools: { readable: [] }, readOnly: true }), /cannot also be read-only/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, model: "--dangerously-skip-permissions" }), /model name/);
  await assert.rejects(driver.startAttempt({ ...base, readOnly: true, container: { name: "c" } as never }), /container/);
});

test("after a refusal ended Antigravity's answer, Botbench's next message says what was refused and why, as data from Botbench, a few times at most", () => {
  const text = continuation(["The owner said no to it, and wrote: not there."]);
  assert.match(text, /^\[From Botbench\] What you last asked to do was not run\. The owner said no to it, and wrote: not there\. Do not try it another way\./);
  assert.equal(MAX_CONTINUATIONS, 3);
});
