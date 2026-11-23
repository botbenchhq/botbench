import type { DatabaseSync } from "node:sqlite";
import type { DriverSession } from "../drivers/contract.ts";
import { killProcessGroup, processGroupAlive } from "../drivers/launch.ts";
import { now } from "../store/db.ts";

/*
 * The silence limit (`autonomy.silenceLimitSeconds`): a builder's or planner's turn whose agent sends nothing for that
 * long is stopped, with everything it started. Any event the session stores counts as a sign of work, so a long build
 * that keeps reporting is never stopped. While the agent waits on the owner's answer to a request, the clock does not
 * run at all, however long the owner takes; it starts again from the answer, which is itself an event. The review
 * keeps its own time limit (engine/review.ts); this is not it.
 */

/** The silence limit when the settings name none: 10 minutes. */
export const SILENCE_LIMIT_MS = 600_000;

export interface SilenceWatch {
  /** Whether the limit was reached and the turn was told to stop. */
  fired(): boolean;
  /** Stop watching: the turn ended, or was stopped another way. */
  clear(): void;
}

/**
 * Watch the running turn of `session` for silence. `waiting` says whether the agent waits on the owner now; it is read
 * after every event, so the caller's own listener, which keeps that count, must be registered first. Past `limitMs` of
 * silence the turn is stopped through the session; the caller sees the turn end as interrupted and asks `fired()`.
 * A `limitMs` of 0 watches nothing.
 */
export function watchSilence(session: DriverSession, limitMs: number, waiting: () => boolean): SilenceWatch {
  let fired = false;
  let over = limitMs <= 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (over || waiting()) return;
    timer = setTimeout(() => {
      if (over) return;
      fired = true;
      over = true;
      // How the stop went is the caller's to find out: it confirms the process group is gone before it records anything.
      void session.interruptTurn().catch((err: unknown) => console.error(`Stopping a silent agent failed: ${err instanceof Error ? err.message : String(err)}`));
    }, limitMs);
  };
  const stopListening = session.onEvent((event) => {
    if (event.type === "turn_ended") clear();
    else arm();
  });
  function clear(): void {
    over = true;
    clearTimeout(timer);
    stopListening();
  }
  arm();
  return { fired: () => fired, clear };
}

/** A duration as the owner reads it: whole minutes when it is whole minutes, else seconds. */
export function durationWords(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  const s = Math.round(ms / 100) / 10;
  return s === 1 ? "1 second" : `${s} seconds`;
}

/** What a builder stopped for silence says on its task, in words for the owner. `agent` is the agent's product name. */
export function silenceReason(agent: string, limitMs: number): string {
  return `${agent} went silent: it sent nothing for ${durationWords(limitMs)} while it was working, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started. The work done up to then is committed. Resume starts ${agent} again where it left off.`;
}

/** What a planner stopped for silence leaves on its run, in words for the owner. */
export function plannerSilenceReason(agent: string, limitMs: number): string {
  return `The planner went silent: ${agent} sent nothing for ${durationWords(limitMs)} while it was planning, which is the silence limit in Botbench's settings, so Botbench stopped it and everything it had started.`;
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
