import type { DatabaseSync } from "node:sqlite";
import type { DriverSession } from "../drivers/contract.ts";
import { killProcessGroup, processGroupAlive } from "../drivers/launch.ts";
import { now } from "../store/db.ts";
import { firstLine } from "../shorten.ts";
import { commandOf, durationWords, NOT_RUN, oldestCommand, pausedUntil, type RunningCommand } from "./command-limit.ts";

export { durationWords };

/*
 * The silence limit (`autonomy.silenceLimitSeconds`): a builder's or planner's turn whose agent sends nothing for that
 * long is stopped, with everything it started. Any event the session stores counts as a sign of work, so a long build
 * that keeps reporting is never stopped. While the agent waits on the owner's answer to a request, the clock does not
 * run at all, however long the owner takes; it starts again from the answer, which is itself an event. While a shell
 * command it started has not returned, the clock is paused until that command's own time limit has passed
 * (engine/command-limit.ts): the agent's CLI prints nothing while its command runs, and a whole test suite run as one
 * command is the agent at work, not gone quiet. Past the command's limit the clock runs again, so a command that never
 * returns is still stopped. The review keeps its own time limit (engine/review.ts); this is not it.
 */

/** The command a turn was stopped during, and when it was stopped (ms since the epoch). */
export interface StoppedDuring {
  command: RunningCommand;
  at: number;
}

/** The silence limit when the settings name none: 10 minutes. */
export const SILENCE_LIMIT_MS = 600_000;

export interface SilenceWatch {
  /** Whether the limit was reached and the turn was told to stop. */
  fired(): boolean;
  /** The command still running when the limit was reached (the longest-running one) and when that was; null when none ran. */
  stoppedDuring(): StoppedDuring | null;
  /** Stop watching: the turn ended, or was stopped another way. */
  clear(): void;
}

/**
 * Watch the running turn of `session` for silence. `waiting` says whether the agent waits on the owner now; it is read
 * after every event, so the caller's own listener, which keeps that count, must be registered first. Past `limitMs` of
 * silence the turn is stopped through the session; the caller sees the turn end as interrupted and asks `fired()`.
 * While a command runs, the silence counts only from the end of the command's own limit. A `limitMs` of 0 watches nothing.
 */
export function watchSilence(session: DriverSession, limitMs: number, waiting: () => boolean): SilenceWatch {
  let fired = false;
  let during: StoppedDuring | null = null;
  let over = limitMs <= 0;
  let timer: NodeJS.Timeout | undefined;
  /** The commands started in this turn that have not returned, by tool call id. */
  const running = new Map<string, RunningCommand>();
  const arm = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (over || waiting()) return;
    // From the last event, or from the end of the latest own limit of a command still running, whichever is later.
    const from = Math.max(Date.now(), pausedUntil(running.values()));
    timer = setTimeout(() => {
      if (over) return;
      fired = true;
      over = true;
      const command = oldestCommand(running.values());
      during = command === null ? null : { command, at: Date.now() };
      // How the stop went is the caller's to find out: it confirms the process group is gone before it records anything.
      void session.interruptTurn().catch((err: unknown) => console.error(`Stopping a silent agent failed: ${err instanceof Error ? err.message : String(err)}`));
    }, from - Date.now() + limitMs);
  };
  const stopListening = session.onEvent((event) => {
    if (event.type === "turn_ended") return clear();
    if (event.type === "tool_call") {
      const command = commandOf(event, Date.now());
      if (command !== null) running.set(command.id, command);
    } else if (event.type === "tool_result" || event.type === "permission_denied") running.delete(event.id);
    else if (event.type === "permission_resolved" && NOT_RUN.has(event.decision)) running.delete(event.toolCallId);
    arm();
  });
  function clear(): void {
    over = true;
    clearTimeout(timer);
    stopListening();
  }
  arm();
  return { fired: () => fired, stoppedDuring: () => during, clear };
}

/**
 * What a builder stopped for silence says on its task, in words for the owner. `agent` is the agent's product name.
 * `during`: the command still running when it was stopped, named with how long it had run and its own limit.
 */
export function silenceReason(agent: string, limitMs: number, during: StoppedDuring | null = null): string {
  const what = during === null ? `it sent nothing for ${durationWords(limitMs)} while it was working, which is the silence limit in Botbench's settings` : commandSilence(during, limitMs);
  return `${agent} went silent: ${what}, so Botbench stopped it and everything it had started. The work done up to then is committed. Resume starts ${agent} again where it left off.`;
}

/** The part of a silence reason that names the command that was running: what ran, for how long, and the two limits it went past. */
function commandSilence({ command, at }: StoppedDuring, limitMs: number): string {
  return `it sent nothing for ${durationWords(roundedMs(at - command.startedAt))} while its command ${firstLine(command.command, 80)} ran, past the command's own time limit of ${durationWords(command.limitMs)} and then the silence limit of ${durationWords(limitMs)} in Botbench's settings`;
}

/** A measured time rounded to what the owner reads: whole minutes from a minute up, tenths of a second below. */
const roundedMs = (ms: number): number => (ms >= 60_000 ? Math.round(ms / 60_000) * 60_000 : Math.round(ms / 100) * 100);

/** What a planner stopped for silence leaves on its run, in words for the owner; `during` as for `silenceReason`. */
export function plannerSilenceReason(agent: string, limitMs: number, during: StoppedDuring | null = null): string {
  return during === null
    ? `The planner went silent: ${agent} sent nothing for ${durationWords(limitMs)} while it was planning, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started.`
    : `The planner went silent: ${agent} ${commandSilence(during, limitMs).replace(/^it /, "")}, so Botbench stopped it and everything it had started.`;
}

/** Whether a task was stopped because its builder went silent: its Resume tells the agent so. */
export const stoppedForSilence = (task: { status: string; reason: string | null }): boolean => task.status === "interrupted" && task.reason !== null && / went silent: it sent nothing for /.test(task.reason);

/**
 * Make sure nothing of an attempt's process group is left: the group its driver recorded is killed if anything of it
 * still runs, and the record is cleared only once the group is gone. Rejects, saying so, when it is still there. The
 * group was this attempt's moments ago and a group's number is not given out again while the group exists, so it is
 * not someone else's.
 */
export async function confirmGroupGone(db: DatabaseSync, attemptId: number): Promise<void> {
  const row = db.prepare("SELECT pgid FROM attempts WHERE id = ?").get(attemptId);
  if (typeof row?.pgid !== "number") return;
  await killProcessGroup(row.pgid);
  if (processGroupAlive(row.pgid)) throw new Error(`process group ${row.pgid} is still running`);
  db.prepare("UPDATE attempts SET pgid = NULL, updated_at = ? WHERE id = ?").run(now(), attemptId);
}
