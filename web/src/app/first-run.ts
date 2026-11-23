import type { DriverState } from "../api/client.ts";

/*
 * The first run of an installation: until its first chat, task or run is stored, the home screen shows two plain lines
 * above the message box, what to do first and the agent a chat needs: signed in, or, under the header's line that names
 * what is wrong with it, where to connect one. No tour and no overlay. Decided
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

/**
 * The second line: Claude Code's state while it is checked or when it can be used; when it cannot, only where to connect
 * an agent (`connect`), as the header's line above already names what is wrong.
 */
export function agentLine(status: AgentStatus): { words: string; connect: boolean } {
  if (status === "checking") return { words: "Checking Claude Code.", connect: false };
  if (status === "ready") return { words: "Claude Code is signed in.", connect: false };
  return { words: `${CONNECT.before}${CONNECT.link}${CONNECT.after}`, connect: true };
}
