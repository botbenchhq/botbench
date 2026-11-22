import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { claudeCodeSignIn, codexSignIn, type SignInDefinition } from "../../src/drivers/sign-in.ts";

/*
 * Replays a sign-in captured from a real CLI (test/recordings/sign-in/) as a child process, for the scenarios a test
 * cannot get from a vendor on demand: a flow that waits, a wrong code, an abandoned flow, and the end of a sign-in.
 * This is the owner's one approved exception to "real CLIs only".
 *
 * What is real: every byte it prints is what the real CLI printed, in order, except the secret parts, which the
 * recording holds as X of the same shape and the replay fills with a fresh random value each run (so a test can
 * search for it). What is not: when it ends. "wait" waits until it is killed, or for a Claude Code code line (then it
 * prints the CLI's real answer to a wrong code and exits 1). "exit0" exits 0 after its output, or after a code line
 * when it takes one: the CLI's real success output was not captured, because that needs a real sign-in, so Botbench
 * reads no output to decide success. "silent" prints nothing and waits.
 *
 * Run as: node replay-sign-in.ts <recording> <wait|exit0|silent> <secret>
 */

const RECORDINGS = path.resolve(import.meta.dirname, "..", "recordings", "sign-in");
export const CLAUDE_RECORDING = path.join(RECORDINGS, "claude-code-2.1.322.json");
export const CODEX_RECORDING = path.join(RECORDINGS, "codex-0.171.0.json");

type Behaviour = "wait" | "exit0" | "silent";

/** A fresh value in place of each run of X: one shape for a device code, one for a link's state. */
export function fill(text: string, secret: string): string {
  if (secret.includes("-")) return text.replace(/X{4,5}-X{4,5}/g, secret);
  return text.replace(/X{20,}/g, (run) => secret.repeat(Math.ceil(run.length / secret.length)).slice(0, run.length));
}

/** A random device code in the shape Codex prints (XXXX-XXXXX). */
export const randomDeviceCode = (): string => {
  const pick = (n: number): string => Array.from(crypto.randomBytes(n), (b) => "ABCDEFGHJKLMNPQRSTUVWYZ0123456789"[b % 33]).join("");
  return `${pick(4)}-${pick(5)}`;
};

/** A random value in the shape of a link's state (43 letters and digits). */
export const randomState = (): string => crypto.randomBytes(32).toString("base64url").replace(/[-_]/g, "a").slice(0, 43);

/** The real definition of the agent, run through the replay in place of its CLI. */
export function replayed(definition: SignInDefinition, recording: string, behaviour: Behaviour, secret: string, change: Partial<SignInDefinition> = {}): SignInDefinition {
  return { ...definition, command: process.execPath, args: [import.meta.filename, recording, behaviour, secret], ...change };
}

export const replayedClaude = (behaviour: Behaviour, state: string, change: Partial<SignInDefinition> = {}): SignInDefinition => replayed(claudeCodeSignIn(), CLAUDE_RECORDING, behaviour, state, change);
export const replayedCodex = (behaviour: Behaviour, code: string, change: Partial<SignInDefinition> = {}): SignInDefinition => replayed(codexSignIn(), CODEX_RECORDING, behaviour, code, change);

if (process.argv[1] === import.meta.filename) {
  const [recordingFile, behaviour, secret] = process.argv.slice(2) as [string, Behaviour, string];
  const recording = JSON.parse(fs.readFileSync(recordingFile, "utf8")) as {
    stdout?: string;
    stderr?: string;
    beforeCode?: { stdout: string; stderr: string };
    wrongCode?: { stdout: string; stderr: string; exitCode: number };
  };
  const first = recording.beforeCode ?? { stdout: recording.stdout ?? "", stderr: recording.stderr ?? "" };
  const keepAlive = setInterval(() => {}, 60_000);
  if (behaviour !== "silent") {
    process.stdout.write(fill(first.stdout, secret));
    process.stderr.write(fill(first.stderr, secret));
  }
  const end = (code: number): void => {
    clearInterval(keepAlive);
    process.stdin.destroy();
    process.exitCode = code;
  };
  if (behaviour === "exit0" && recording.wrongCode === undefined) end(0);
  else if (recording.wrongCode !== undefined) {
    process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
      if (!chunk.includes("\n")) return;
      if (behaviour === "exit0") return end(0);
      process.stdout.write(recording.wrongCode!.stdout);
      process.stderr.write(recording.wrongCode!.stderr);
      end(recording.wrongCode!.exitCode);
    });
  }
}
