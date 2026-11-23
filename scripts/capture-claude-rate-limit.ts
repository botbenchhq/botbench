import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { claudeArgs, limitedEnd, parseClaudeLine } from "../src/drivers/claude-code.ts";
import type { DriverEvent } from "../src/drivers/events.ts";
import { killProcessGroup, launch, runCli } from "../src/drivers/launch.ts";
import { tempDir } from "../test/support/repo.ts";

/*
 * Records the `rate_limit_event` lines a real Claude Code turn prints into a NEW file under test/recordings/, for the
 * hand-off on a usage limit (src/engine/handoff.ts) to be replayed from what the CLI really prints. Run by hand, outside
 * any sandbox, on the owner's own Claude Code sign-in:
 *   node scripts/capture-claude-rate-limit.ts
 * It costs one short turn on the cheapest model (CLAUDE_CAPTURE_MODEL, haiku when unset). A turn that is under the
 * login's limit prints `allowed` events; a `rejected` one is printed only when the limit has been reached, so run it
 * again then to record that (the file name carries the time, and an existing file is never changed or replaced).
 *
 * How it runs the CLI: with Botbench's own arguments for a turn that edits nothing (`claudeArgs`: stream-json in and out,
 * no settings file but the project's, no MCP server, no permission prompts, Claude Code's sandbox on), from Botbench's
 * own launcher (`launch`: the allowlisted environment, API-key variables removed, its own process group), in a new
 * temporary folder that holds nothing. It sends one message, reads every line until the turn's result, and stops the
 * process group. Nothing is read from or written to ~/.claude by this script; the CLI reads its own sign-in itself.
 *
 * What is kept: each rate_limit_event line as printed, without its session and message ids, and of the turn's result
 * line only whether it was an error and its subtype. The text of the reply, the session's init line (which lists the
 * tools, model and folders) and the usage are not kept. Each kept line is also given as the driver parses it, with how
 * the driver ends the turn (`limitedEnd`). The script stops, writing nothing, when a kept line looks like a secret.
 */

const MODEL = process.env.CLAUDE_CAPTURE_MODEL ?? "haiku";
const PROMPT = "Reply with the single word: done";
const RECORDINGS = path.resolve(import.meta.dirname, "..", "test", "recordings");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.join(RECORDINGS, `claude-code-rate-limit-${stamp}.json`);
if (fs.existsSync(OUT)) {
  console.error(`${OUT} exists already, and a recording is never changed. Run the script again.`);
  process.exit(1);
}

const version = await runCli("claude", ["--version"], { cwd: RECORDINGS });
if (!version.started) {
  console.error("Claude Code is not installed, or `claude` is not on the PATH.");
  process.exit(1);
}
const dir = tempDir("botbench-capture-limit-");
const data = path.join(dir, "data");
const cwd = path.join(dir, "folder");
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const args = claudeArgs({ confinement: { dataDir: data, allowedHosts: [], cwd }, model: MODEL });
const { child, pgid } = launch("claude", args, { cwd });
if (!pgid) {
  console.error("Claude Code could not be started.");
  process.exit(1);
}
child.stderr.resume();
const rateLimitLines: string[] = [];
let result: { isError: boolean; subtype: string | null } | null = null;
const done = new Promise<void>((resolve) => {
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    if (message.type === "rate_limit_event") {
      const { session_id: _session, uuid: _uuid, ...kept } = message;
      rateLimitLines.push(JSON.stringify(kept));
    }
    if (message.type === "result") {
      result = { isError: message.is_error === true, subtype: typeof message.subtype === "string" ? message.subtype : null };
      resolve();
    }
  });
  child.once("close", () => resolve());
});
child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: PROMPT } })}\n`);
const limit = setTimeout(() => void killProcessGroup(pgid).catch(() => {}), 180_000);
await done;
clearTimeout(limit);
child.stdin.end();
await killProcessGroup(pgid).catch(() => {});
fs.rmSync(dir, { recursive: true, force: true });

// A kept line that looks like a key or a token stops the script before anything is written.
const SECRET = /\b(sk-ant-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{40,})\b/;
const leaking = rateLimitLines.find((line) => SECRET.test(line));
if (leaking !== undefined) {
  console.error("A rate_limit_event line looks like it holds a secret, so nothing was written. Look at the CLI's output by hand.");
  process.exit(1);
}

const parsed = rateLimitLines.flatMap((line) => parseClaudeLine(line));
const lastRejected = [...parsed].reverse().find((event): event is Extract<DriverEvent, { type: "rate_limit" }> => event.type === "rate_limit" && event.limited) ?? null;
const ended = result as { isError: boolean; subtype: string | null } | null;
const turnEnd = limitedEnd({ type: "turn_ended", reason: ended?.isError === true ? "error" : "completed", detail: null }, lastRejected);
const recording = {
  about: `A real Claude Code turn on ${MODEL}, run by scripts/capture-claude-rate-limit.ts with Botbench's own arguments and launcher: the rate_limit_event lines it printed, as printed but without their session and message ids, and whether its result was an error. ${lastRejected === null ? "No rejected event was printed: the login was under its usage limit." : "A rejected event was printed: the login had reached its usage limit."}`,
  cli: version.stdout.trim(),
  recordedAt: new Date().toISOString(),
  model: MODEL,
  rateLimitLines,
  result: ended,
  parsed,
  driverTurnEnd: turnEnd,
};
fs.writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`, { flag: "wx" });
console.log(`Wrote ${OUT}: ${rateLimitLines.length} rate_limit_event line${rateLimitLines.length === 1 ? "" : "s"}, ${lastRejected === null ? "none rejected" : "one rejected"}.`);
