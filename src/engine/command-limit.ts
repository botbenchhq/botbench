import { firstLine } from "../shorten.ts";

/*
 * A shell command an agent is running, and the time limit it runs under. Pure, so the task screen reads the same rule
 * from the transcript as the silence limit reads from the session (engine/silence.ts).
 *
 * The rule, after OpenMausBot's turn watchdog (server/turn-watchdog.ts there): an agent's CLI reports a tool call when it
 * starts and when it returns, and nothing in between, so a long command is quiet however hard it works. While a command
 * has started and not returned, the silence clock is paused until the command's own time limit has passed; from then on
 * it runs again, so a command that never returns is still stopped. Only shell commands pause it: they are what runs for
 * minutes, and each states, or has, a limit of its own.
 */

/** Claude Code's own limit for a Bash command that names none: 2 minutes. */
export const DEFAULT_COMMAND_LIMIT_MS = 120_000;
/** The longest limit Claude Code lets a Bash command name: 10 minutes. A larger one is cut to it, as Claude Code cuts it. */
export const MAX_COMMAND_LIMIT_MS = 600_000;

/** A command a tool call started: its id, the command line, when it started (ms since the epoch) and its own limit. */
export interface RunningCommand {
  id: string;
  command: string;
  startedAt: number;
  limitMs: number;
}

/**
 * The command a tool call runs, with its own limit; null when the call runs no shell command. A command is a call whose
 * input has a `command` string (Claude Code's Bash, Codex's shell). Its limit is the `timeout` it names, in milliseconds
 * as Claude Code takes it, up to 10 minutes; with none, Claude Code's Bash default of 2 minutes, and for another agent's
 * command, whose limit Botbench is not told, the longest Claude Code allows.
 */
export function commandOf(call: { id: string; name: string; input: unknown }, startedAt: number): RunningCommand | null {
  const input = call.input as { command?: unknown; timeout?: unknown } | null;
  if (typeof input !== "object" || input === null || typeof input.command !== "string") return null;
  const named = typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? Math.min(input.timeout, MAX_COMMAND_LIMIT_MS) : null;
  return { id: call.id, command: input.command, startedAt, limitMs: named ?? (call.name === "Bash" ? DEFAULT_COMMAND_LIMIT_MS : MAX_COMMAND_LIMIT_MS) };
}

/** When the silence clock may run again with these commands running: the latest end of their own limits; 0 for none. */
export const pausedUntil = (running: Iterable<RunningCommand>): number => {
  let until = 0;
  for (const command of running) until = Math.max(until, command.startedAt + command.limitMs);
  return until;
};

/** The longest-running of these commands, the one the owner is told about; null for none. */
export function oldestCommand(running: Iterable<RunningCommand>): RunningCommand | null {
  let oldest: RunningCommand | null = null;
  for (const command of running) if (oldest === null || command.startedAt < oldest.startedAt) oldest = command;
  return oldest;
}

/**
 * The commands still running at the end of a list of events, in the driver's event shapes, each with the time it was
 * stored: those of the last turn whose call has neither returned nor been refused. For the task screen's transcript.
 */
export function runningCommands(events: readonly { type: string; ts: string; payload: unknown }[]): RunningCommand[] {
  const running = new Map<string, RunningCommand>();
  for (const event of events) {
    const p = event.payload as { id?: unknown; toolCallId?: unknown; name?: unknown; input?: unknown; decision?: unknown } | null;
    if (event.type === "user_prompt" || event.type === "turn_ended") running.clear();
    else if (event.type === "tool_call" && typeof p?.id === "string" && typeof p.name === "string") {
      const command = commandOf({ id: p.id, name: p.name, input: p.input }, Date.parse(event.ts));
      if (command !== null && Number.isFinite(command.startedAt)) running.set(command.id, command);
    } else if ((event.type === "tool_result" || event.type === "permission_denied") && typeof p?.id === "string") running.delete(p.id);
    else if (event.type === "permission_resolved" && typeof p?.toolCallId === "string" && NOT_RUN.has(String(p.decision))) running.delete(p.toolCallId);
  }
  return [...running.values()];
}

/** The answers to a request after which its call does not run. */
export const NOT_RUN = new Set(["declined", "denied", "cancelled"]);

/** A duration as the owner reads it: whole minutes when it is whole minutes, else seconds. */
export function durationWords(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  const s = Math.round(ms / 100) / 10;
  return s === 1 ? "1 second" : `${s} seconds`;
}


/**
 * What the task screen says of the command its agent is running now, from the stored transcript: what runs, and how long
 * it has run against its own time limit, as `duration` words it ("4m 12s"). The command
 * is its first line, shortened: the transcript holds it in full.
 */
export function runningWords(agent: string, command: RunningCommand, now: number, duration: (ms: number) => string): { line: string; time: string } {
  const ran = Math.max(0, now - command.startedAt);
  return {
    line: `${agent} is running ${firstLine(command.command, 80)}.`,
    time: `${duration(ran)} so far, ${ran <= command.limitMs ? "within" : "past"} its own time limit of ${durationWords(command.limitMs)}.`,
  };
}
