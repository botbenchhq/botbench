import type { DriverState } from "../api/client.ts";

/*
 * The first run of an installation: until its first chat, task or run is stored, the home screen shows two plain lines
 * above the message box, what to do first and the state of the agent a chat needs. No tour and no overlay. Decided
 * here, without a browser; whether it is the first run is the server's to say (GET /api/first-run).
 */

/** Where Settings opens at its Agents section. */
export const AGENTS_ADDRESS = "#/settings/agents";

/** The link to it, in running text, and the sentence around it: in the agent's first-run line and in Send's reason. */
export const CONNECT = { before: "Connect an agent in ", link: "Settings → Agents", after: "." } as const;

/** The first line: what to do first. */
export const FIRST_STEP = "Tap + to choose a repository, or just ask a question.";

/** Claude Code's state as its check reported it: still checking, usable, or what is wrong. */
export type AgentStatus = "checking" | "ready" | "not-checked" | "not-installed" | "unsupported" | "signed-out" | "unavailable";

export function agentStatus(driver: DriverState | null, failed: boolean): AgentStatus {
  if (failed) return "not-checked";
  if (driver === null) return "checking";
  if (driver.problem === null) return "ready";
  return !driver.installed ? "not-installed" : !driver.supported ? "unsupported" : !driver.signedIn ? "signed-out" : "unavailable";
}

const WORDS: Record<AgentStatus, string> = {
  checking: "Checking Claude Code.",
  ready: "Claude Code is signed in.",
  "not-checked": "Botbench could not check Claude Code.",
  "not-installed": "Claude Code is not installed.",
  unsupported: "This version of Claude Code is not supported.",
  "signed-out": "Claude Code is signed out.",
  unavailable: "Claude Code cannot be used yet.",
};

/** The second line: the agent's state, and whether it is followed by the link to connect one (only when it cannot be used). */
export function agentLine(status: AgentStatus): { words: string; connect: boolean } {
  return { words: WORDS[status], connect: status !== "checking" && status !== "ready" };
}
