import type { Driver, DriverProbe } from "../drivers/contract.ts";

/** How long the agents' last check answers `GET /api/agents` before it is made again, in the background. */
export const AGENT_CHECK_FRESH_MS = 60_000;

/** Each agent as its own check found it, and when that check ended. */
export interface AgentCheck {
  agents: (DriverProbe & { agent: string })[];
  checkedAt: string;
}

export interface AgentChecks {
  /**
   * The last check at once when there is one, with whether a new one is running; it starts one when the last is older
   * than the window. With none yet, it waits for the first.
   */
  read(): Promise<AgentCheck & { checking: boolean }>;
  /** A check that ends after this call began: the one running, else a new one. */
  fresh(): Promise<AgentCheck>;
  /** Make the last check old, so the next read starts a new one (after a sign-in or a sign-out). */
  forget(): void;
}

/**
 * The agents' checks, kept for a short time. Each check runs every agent's own program (`--version`, its sign-in
 * status), which takes seconds; a screen that opens should not wait for that each time.
 */
export function createAgentChecks(drivers: readonly Driver[], options: { freshMs?: number; now?: () => number } = {}): AgentChecks {
  const freshMs = options.freshMs ?? AGENT_CHECK_FRESH_MS;
  const now = options.now ?? Date.now;
  let last: (AgentCheck & { at: number }) | null = null;
  let running: Promise<AgentCheck> | null = null;

  const check = (): Promise<AgentCheck> => {
    running ??= Promise.all(drivers.map(async (d) => ({ agent: d.name, ...(await d.probe()) })))
      .then((agents) => {
        const at = now();
        last = { agents, checkedAt: new Date(at).toISOString(), at };
        return { agents, checkedAt: last.checkedAt };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    async read() {
      if (last === null) return { ...(await check()), checking: false };
      if (now() - last.at >= freshMs && running === null) {
        // A check that fails in the background leaves the last one; the next read tries again, and fresh() says why.
        check().catch(() => {});
      }
      return { agents: last.agents, checkedAt: last.checkedAt, checking: running !== null };
    },
    fresh: () => running ?? check(),
    forget() {
      if (last !== null) last = { ...last, at: -Infinity };
    },
  };
}
