import fs from "node:fs";
import net from "node:net";

/*
 * The pre-tool hook Smelt gives Claude Code for a task's attempt. The CLI runs
 * this file before every tool call, with the call as JSON on stdin. It asks the
 * permission broker in the Smelt process, over the broker's socket, what the
 * gate says, and prints the answer in the form the CLI reads:
 *   pass   nothing is printed: the CLI's own rules decide (they allow file edits below the worktree)
 *   ask    the CLI must ask for permission, and that request goes to the owner
 *   deny   the call does not run
 * It cannot allow anything. Whatever goes wrong, the answer is deny.
 */

/** This file, as the CLI is told to run it. */
export const PROXY_SCRIPT = import.meta.filename;
/** The environment variables an attempt's CLI process carries for this hook. */
export const SOCKET_ENV = "SMELT_BROKER_SOCKET";
export const SECRET_ENV = "SMELT_BROKER_SECRET";

export interface ProxyReply {
  verdict: "pass" | "ask" | "deny";
  reason: string;
}

const VERDICTS = new Set(["pass", "ask", "deny"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const deny = (reason: string): ProxyReply => ({ verdict: "deny", reason: `Denied: ${reason} Nothing was run.` });

/** The input fields the gate decides on. A file's content stays behind: the gate needs to know where, not what. */
const SENT_FIELDS = ["command", "description", "file_path", "notebook_path", "path", "pattern", "url"];

/**
 * Ask the broker about one tool call, given the hook input the CLI handed over.
 * Never throws and never waits longer than `timeoutMs`.
 */
export function askBroker(socketPath: string | undefined, secret: string | undefined, hookInput: unknown, timeoutMs = 10_000): Promise<ProxyReply> {
  if (!socketPath || !secret) return Promise.resolve(deny("Smelt's permission gate is not set up for this session."));
  if (!isObject(hookInput) || !isObject(hookInput.tool_input)) return Promise.resolve(deny("Smelt's permission gate could not read the tool call."));
  const input: Record<string, unknown> = {};
  for (const field of SENT_FIELDS) if (field in hookInput.tool_input) input[field] = hookInput.tool_input[field];
  const message = `${JSON.stringify({ secret, tool: hookInput.tool_name, input, toolCallId: hookInput.tool_use_id, cwd: hookInput.cwd })}\n`;

  return new Promise((resolve) => {
    let answer = "";
    let settled = false;
    const finish = (reply: ProxyReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => finish(deny("Smelt's permission gate did not answer in time.")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", () => finish(deny("Smelt's permission gate could not be reached.")));
    socket.on("connect", () => socket.write(message));
    socket.on("data", (chunk: string) => {
      answer += chunk;
      if (answer.length > 64 * 1024) finish(deny("Smelt's permission gate gave an answer that is too long."));
    });
    socket.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer);
      } catch {
        return finish(deny("Smelt's permission gate gave no readable answer."));
      }
      if (!isObject(parsed) || typeof parsed.verdict !== "string" || !VERDICTS.has(parsed.verdict)) return finish(deny("Smelt's permission gate gave an answer that is no verdict."));
      finish({ verdict: parsed.verdict as ProxyReply["verdict"], reason: typeof parsed.reason === "string" ? parsed.reason : "" });
    });
    socket.on("close", () => finish(deny("Smelt's permission gate hung up without an answer.")));
  });
}

/** What the hook prints for the CLI. A pass prints nothing, which leaves the decision to the CLI's own rules. */
export function hookOutput(reply: ProxyReply): string {
  if (reply.verdict === "pass") return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: reply.verdict, permissionDecisionReason: reply.reason } });
}

async function main(): Promise<void> {
  let reply: ProxyReply;
  try {
    reply = await askBroker(process.env[SOCKET_ENV], process.env[SECRET_ENV], JSON.parse(fs.readFileSync(0, "utf8")));
  } catch {
    reply = deny("Smelt's permission gate could not read the tool call.");
  }
  process.stdout.write(hookOutput(reply));
}

if (process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((err: unknown) => {
    // Exit code 2 is the CLI's own "blocked" for a hook that could not even print its answer.
    process.stderr.write(`Denied: Smelt's permission hook failed (${err instanceof Error ? err.message : String(err)}). Nothing was run.`);
    process.exitCode = 2;
  });
}
