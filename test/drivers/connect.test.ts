import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createConnect, ConnectError, type ConnectableAgent, type FlowState } from "../../src/drivers/connect.ts";
import type { DriverProbe } from "../../src/drivers/contract.ts";
import { claudeCodeSignIn, codexSignIn, linkOn, NO_BROWSER, parseClaudeSignIn, parseCodexSignIn, pastedCode, plainText, signInFailure, type SignInDefinition } from "../../src/drivers/sign-in.ts";
import { CLAUDE_RECORDING, CODEX_RECORDING, fill, randomDeviceCode, randomState, replayedClaude, replayedCodex } from "../support/replay-sign-in.ts";

// The parsers are read against output captured from each real CLI (test/recordings/sign-in/). The state machine runs
// a real child process: the capture replayed (see test/support/replay-sign-in.ts). No vendor is reached here; that is
// test/live/connect.live.test.ts.

type T = { after(fn: () => unknown): void };
const claudeCapture = JSON.parse(fs.readFileSync(CLAUDE_RECORDING, "utf8")) as { beforeCode: { stdout: string }; wrongCode: { stdout: string; stderr: string; exitCode: number } };
const codexCapture = JSON.parse(fs.readFileSync(CODEX_RECORDING, "utf8")) as { stdout: string };

const probeOf = (signedIn: boolean): DriverProbe => ({ installed: true, version: "1.0.0", supported: true, signedIn, billing: signedIn ? "subscription" : "unknown", problem: signedIn ? null : "signed out" });

/** The connect state machine over one agent, with every state change it reports, closed after the test. */
function connectFor(t: T, signIn: SignInDefinition, probe: () => Promise<DriverProbe> = async () => probeOf(false), startLimitMs?: number) {
  const changes: string[] = [];
  const agent: ConnectableAgent = { signIn, probe };
  const connect = createConnect({ agents: [agent], onChange: (driver, state) => changes.push(`${driver}:${state}`), ...(startLimitMs ? { startLimitMs } : {}) });
  t.after(() => connect.close());
  return { connect, changes };
}

/** The pids whose command line holds `marker`: the replay is started with the secret on its command line. */
async function pidsWith(marker: string): Promise<number[]> {
  const { execFileSync } = await import("node:child_process");
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function noneLeft(marker: string, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while ((await pidsWith(marker)).length > 0) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

test("Claude Code's link is read from its real output once it asks for the code, and only on its own hosts", () => {
  const output = fill(claudeCapture.beforeCode.stdout, "S".repeat(43));
  const prompt = parseClaudeSignIn(output);
  assert.ok(prompt);
  const url = new URL(prompt.url);
  assert.equal(url.hostname, "claude.com");
  assert.equal(url.pathname, "/cai/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  assert.equal(url.searchParams.get("state"), "S".repeat(43));
  assert.equal(prompt.code, null);
  // Before the prompt for the code, the CLI is not ready for one.
  assert.equal(parseClaudeSignIn(output.slice(0, output.indexOf("Paste code"))), null);
  // A link to anywhere else is never shown, even in the CLI's own words.
  assert.equal(parseClaudeSignIn(output.replaceAll("https://claude.com/", "https://claude.com.example.net/")), null);
  assert.equal(linkOn("visit https://user:pw@claude.com/x and https://claude.com:8443/y", ["claude.com"]), null);
  assert.equal(linkOn("visit http://claude.com/x", ["claude.com"]), null);
});

test("Codex's device page and one-time code are read from its real output, colour escapes and all", () => {
  const code = randomDeviceCode();
  const output = fill(codexCapture.stdout, code);
  assert.match(output, /\u001b\[94m/, "the capture keeps the CLI's colour escapes");
  assert.deepEqual(parseCodexSignIn(output), { url: "https://auth.openai.com/codex/device", code });
  assert.equal(plainText(output).includes("\u001b"), false);
  // The link alone is not enough: the code comes after it.
  assert.equal(parseCodexSignIn(output.slice(0, output.indexOf("2. Enter"))), null);
  assert.equal(parseCodexSignIn(output.slice(0, output.indexOf(code))), null);
});

test("each definition names its CLI's own sign-in and sign-out, keeps the subscription, and opens no browser on the Mac", () => {
  const claude = claudeCodeSignIn("/tmp/claude-config");
  assert.deepEqual([claude.command, ...claude.args], ["claude", "auth", "login", "--claudeai"]);
  assert.deepEqual(claude.signOutArgs, ["auth", "logout"]);
  assert.deepEqual(claude.env, { BROWSER: NO_BROWSER, CLAUDE_CONFIG_DIR: "/tmp/claude-config" });
  assert.equal(claude.kind, "link");
  assert.equal(claude.takesCode, true);
  assert.deepEqual(claudeCodeSignIn().env, { BROWSER: NO_BROWSER });

  const codex = codexSignIn("/tmp/codex-home");
  assert.deepEqual([codex.command, ...codex.args], ["codex", "login", "--device-auth"]);
  assert.deepEqual(codex.signOutArgs, ["logout"]);
  assert.deepEqual(codex.env, { BROWSER: NO_BROWSER, CODEX_HOME: "/tmp/codex-home" });
  assert.equal(codex.kind, "device-code");
  assert.equal(codex.takesCode, false);
  assert.equal(codex.limitMs, 15 * 60_000, "its code expires in 15 minutes");
});

test("a failure is the CLI's own last line, without colour, control characters or the flow's secrets", () => {
  assert.equal(signInFailure("", claudeCapture.wrongCode.stderr, []), "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.");
  assert.equal(signInFailure("first\n\u001b[31mError logging in: ABCD-EFGHI refused\u001b[0m\n\n", "", ["ABCD-EFGHI"]), "Error logging in: … refused");
  assert.equal(signInFailure("", "", []), null);
  assert.equal(signInFailure("x".repeat(400), "", [])!.length, 300);
});

test("a pasted code is one line of code characters; anything else is refused", () => {
  assert.equal(pastedCode("  abc_DEF-123#state.~+/=  "), "abc_DEF-123#state.~+/=");
  for (const bad of ["", "two words", "line\nbreak", "semi;colon", "$(x)", 42, null, "a".repeat(2049)]) assert.equal(pastedCode(bad), null, String(bad));
});

test("a sign-in waits with its link and code, a second start is refused, and cancel kills its process group and drops both", async (t) => {
  const code = randomDeviceCode();
  const { connect, changes } = connectFor(t, replayedCodex("wait", code));
  assert.equal(connect.view("codex").state, "idle");
  const waiting = await connect.start("codex");
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.url, "https://auth.openai.com/codex/device");
  assert.equal(waiting.code, code);
  assert.equal(waiting.kind, "device-code");
  assert.ok(Date.parse(waiting.expiresAt!) > Date.now() + 14 * 60_000);
  assert.equal((await pidsWith(code)).length, 1, "the sign-in runs");

  await assert.rejects(connect.start("codex"), (err: unknown) => err instanceof ConnectError && err.status === 409);
  assert.equal((await pidsWith(code)).length, 1, "the refused start started nothing");

  const cancelled = await connect.cancel("codex");
  assert.deepEqual([cancelled.state, cancelled.url, cancelled.code, cancelled.expiresAt], ["cancelled", null, null, null]);
  assert.ok(await noneLeft(code), "no process of the sign-in is left");
  assert.deepEqual(changes, ["codex:starting", "codex:waiting", "codex:cancelled"]);
  await assert.rejects(connect.cancel("codex"), (err: unknown) => err instanceof ConnectError && err.status === 409);
  // After an end a new sign-in may start.
  assert.equal((await connect.start("codex")).state, "waiting");
  await connect.cancel("codex");
});

test("an abandoned sign-in ends at its time limit, with its process group killed", async (t) => {
  const code = randomDeviceCode();
  const { connect, changes } = connectFor(t, replayedCodex("wait", code, { limitMs: 600 }));
  assert.equal((await connect.start("codex")).state, "waiting");
  const until = Date.now() + 5000;
  while (connect.view("codex").state === "waiting" && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  const ended = connect.view("codex");
  assert.equal(ended.state, "failed");
  assert.match(ended.reason!, /^The sign-in was not finished within 0 minutes, so Botbench stopped it\./);
  assert.equal(ended.code, null);
  assert.ok(await noneLeft(code));
  assert.deepEqual(changes.at(-1), "codex:failed");
});

test("a CLI that prints no link in time is stopped and the start says so", async (t) => {
  const marker = randomDeviceCode();
  const { connect } = connectFor(t, replayedCodex("silent", marker), undefined, 500);
  const view = await connect.start("codex");
  assert.equal(view.state, "failed");
  assert.match(view.reason!, /^Codex did not give a sign-in link within 1 seconds\. Try again, or run `codex login --device-auth` in a terminal on the Mac\.$/);
  assert.ok(await noneLeft(marker));
});

test("a CLI that is not installed fails the start in words, leaving nothing running", async (t) => {
  const { connect } = connectFor(t, { ...codexSignIn(), command: "botbench-no-such-command-u26" });
  const view = await connect.start("codex");
  assert.equal(view.state, "failed");
  assert.equal(view.reason, "Codex could not be started. Check that `botbench-no-such-command-u26` is installed and on the PATH.");
});

test("success is the CLI ending with exit 0 and the probe then saying signed in; exit 0 while still signed out is a failure", async (t) => {
  let probes = 0;
  const signedIn = connectFor(t, replayedCodex("exit0", randomDeviceCode()), async () => (probes++, probeOf(true)));
  // It may end before the start returns: the start then answers with the end.
  const first = await signedIn.connect.start("codex");
  const until = Date.now() + 5000;
  while (signedIn.connect.view("codex").state !== "succeeded" && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.ok(["waiting", "checking", "succeeded"].includes(first.state));
  assert.equal(signedIn.connect.view("codex").state, "succeeded");
  assert.equal(probes, 1, "probed once, after the end");
  assert.deepEqual(signedIn.changes.slice(-2), ["codex:checking", "codex:succeeded"]);

  const stillOut = connectFor(t, replayedCodex("exit0", randomDeviceCode()), async () => probeOf(false));
  await stillOut.connect.start("codex");
  const until2 = Date.now() + 5000;
  while (stillOut.connect.view("codex").state !== "failed" && Date.now() < until2) await new Promise((r) => setTimeout(r, 25));
  assert.equal(stillOut.connect.view("codex").reason, "Codex finished, but still says it is signed out.");
});

test("Claude Code: the pasted code goes to the waiting CLI; the CLI's own answer to a wrong code is the reason", async (t) => {
  const state = randomState();
  const { connect, changes } = connectFor(t, replayedClaude("wait", state));
  const waiting = await connect.start("claude-code");
  assert.equal(waiting.state, "waiting");
  assert.equal(new URL(waiting.url!).searchParams.get("state"), state);
  assert.equal(waiting.code, null);
  assert.equal(waiting.takesCode, true);
  assert.throws(() => connect.sendCode("claude-code", "not one line\n"), (err: unknown) => err instanceof ConnectError && err.status === 400);
  assert.equal(connect.sendCode("claude-code", "notarealcode0000#notarealstate0000").state, "checking");
  assert.throws(() => connect.sendCode("claude-code", "again"), (err: unknown) => err instanceof ConnectError && err.status === 409);
  const until = Date.now() + 5000;
  while (connect.view("claude-code").state === "checking" && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  const ended = connect.view("claude-code");
  assert.equal(ended.state, "failed");
  assert.equal(ended.reason, signInFailure("", claudeCapture.wrongCode.stderr, []));
  assert.equal(ended.url, null);
  assert.ok(await noneLeft(state));
  assert.deepEqual(changes, ["claude-code:starting", "claude-code:waiting", "claude-code:checking", "claude-code:failed"] satisfies `claude-code:${FlowState}`[]);
});

test("Codex takes no code back; an unknown agent is 404; a sign-in only on the Mac is refused with the command to run there", async (t) => {
  const { connect } = connectFor(t, replayedCodex("wait", randomDeviceCode()));
  await connect.start("codex");
  assert.throws(() => connect.sendCode("codex", "abc"), (err: unknown) => err instanceof ConnectError && err.status === 409);
  assert.throws(() => connect.view("grok"), (err: unknown) => err instanceof ConnectError && err.status === 404);
  await assert.rejects(connect.start("grok"), (err: unknown) => err instanceof ConnectError && err.status === 404);

  const onMac = connectFor(t, { ...codexSignIn(), kind: "on-the-mac", terminalCommand: "codex login" });
  await assert.rejects(onMac.connect.start("codex"), (err: unknown) => err instanceof ConnectError && err.status === 409 && err.message === "Codex can only be signed in on the Mac itself. Run `codex login` in a terminal there.");
  assert.equal(onMac.connect.view("codex").kind, "on-the-mac");
});

test("disconnect runs the CLI's own sign-out and probes again, and is refused while a sign-in runs", async (t) => {
  const code = randomDeviceCode();
  // The sign-out is the replay too, ending with exit 0. The real sign-out runs only in the live test, on an empty configuration.
  const signOutOk = replayedCodex("wait", code);
  let probes = 0;
  const { connect, changes } = connectFor(t, { ...signOutOk, signOutArgs: [signOutOk.args[0]!, CODEX_RECORDING, "exit0", code] }, async () => (probes++, probeOf(false)));
  await connect.start("codex");
  await assert.rejects(connect.signOut("codex"), (err: unknown) => err instanceof ConnectError && err.status === 409);
  await connect.cancel("codex");
  assert.equal((await connect.signOut("codex")).signedIn, false);
  assert.equal(probes, 1);
  assert.equal(changes.at(-1), "codex:signed-out");
  assert.equal(connect.view("codex").state, "idle");
});

test("closing stops every sign-in that is under way", async () => {
  const code = randomDeviceCode();
  const connect = createConnect({ agents: [{ signIn: replayedCodex("wait", code), probe: async () => probeOf(false) }] });
  await connect.start("codex");
  await connect.close();
  assert.equal(connect.view("codex").state, "cancelled");
  assert.ok(await noneLeft(code));
});
