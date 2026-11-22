import { execFile } from "node:child_process";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Approval } from "../approvals/broker.ts";
import type { DriverCapabilities } from "../drivers/contract.ts";
import { killProcessGroup, processGroupAlive } from "../drivers/launch.ts";
import { now } from "../store/db.ts";

/*
 * What a start of Smelt does about a task that was waiting on the owner when the last run stopped: the
 * parked-approval half of restart recovery. Such a task is not re-driven and not interrupted. Its approval
 * stays pending, its CLI process from before is stopped if it survived, and it waits until the owner answers.
 * Tasks that were mid-turn without an approval are not handled here: they are marked interrupted by the engine.
 */

/**
 * What Smelt says to the agent when it re-drives a task after the owner answered a parked approval. The session
 * it resumes ends with a tool call that was never answered; the agent is asked to make it again, so that the
 * owner's stored answer can be given to exactly that request. These are Smelt's words and say so: the transcript
 * shows a prompt as the owner's.
 */
export const RESUME_PROMPT =
  "[From Smelt, not from the owner] Smelt was restarted while you were waiting for permission for your last tool call. That call was neither run nor refused. Make exactly that same tool call again now, unchanged, and then carry on with the task.";

const PS_LIMIT_MS = 5000;
/** A CLI is started just before its attempt row is written; the clock `ps` reads has whole seconds. */
const START_SLACK_MS = 5000;

/** When the process began, as the system reports it; null when there is no such process. Rejects when the system cannot be asked. */
function startedAt(pid: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // A time limit, and a fixed locale so the date reads the same on every machine.
    // `ps` is told to print the time in UTC and it is read as UTC, so neither Smelt's own time zone nor a clock change can shift it.
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: PS_LIMIT_MS, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC" } }, (err, stdout) => {
      // `ps` ends with 1 and prints nothing when the process does not exist.
      if (err && err.code === 1 && stdout.trim() === "") return resolve(null);
      const at = err ? NaN : Date.parse(`${stdout.trim()} UTC`);
      if (Number.isNaN(at)) return reject(new Error(`\`ps\` could not say when process ${pid} began${err ? `: ${err.message}` : ""}`));
      resolve(at);
    });
  });
}

/**
 * Stop whatever is left of an attempt's CLI process group from before this start, so that no second agent is
 * started beside it in the same worktree. Resolves once the group is gone and the attempt no longer names it;
 * rejects when it cannot be stopped.
 *
 * A group's number can pass to an unrelated process once the group is gone. The group is the attempt's own
 * while its leader is the process that was started for the attempt (it began no later than the attempt's row
 * was written), or while its leader is gone and members remain (a number is not given out again while its
 * group exists). A leader that began later is someone else's and is left alone, and so is everything when the
 * machine itself started after the attempt was made, or when the attempt's own time cannot be read.
 */
export async function stopSurvivor(db: DatabaseSync, attemptId: number): Promise<void> {
  const row = db.prepare("SELECT pgid, created_at FROM attempts WHERE id = ?").get(attemptId);
  if (!row || typeof row.pgid !== "number") return;
  const pgid = row.pgid;
  if (processGroupAlive(pgid)) {
    const made = Date.parse(String(row.created_at));
    const began = await startedAt(pgid);
    // Process 1 began when the machine did. Nothing from before that is still running.
    const booted = await startedAt(1);
    const ours = !Number.isNaN(made) && booted !== null && booted <= made + START_SLACK_MS && (began === null || began <= made + START_SLACK_MS);
    if (ours) await killProcessGroup(pgid);
  }
  // Whatever state the attempt was left in, nothing of it runs any more.
  db.prepare("UPDATE attempts SET pgid = NULL, status = CASE status WHEN 'running' THEN 'interrupted' ELSE status END, updated_at = ? WHERE id = ?").run(now(), attemptId);
}

/**
 * Why a task whose approvals were asked before a restart cannot be resumed, in words for the owner; null when it
 * can. Checked on start, so that no card is shown whose answer could lead nowhere, and again before re-driving.
 */
export function resumeProblem(db: DatabaseSync, task: { attemptId: number | null; worktreePath: string | null }, parked: readonly Approval[], capabilities: DriverCapabilities): string | null {
  if (task.attemptId === null || task.worktreePath === null) return "The task has no attempt to resume.";
  // A stored answer belongs to the attempt that asked, and that must be the attempt the task still stands at.
  const strangers = parked.filter((approval) => approval.attemptId !== task.attemptId);
  if (strangers.length > 0) return `The request was made by attempt ${strangers[0]!.attemptId}, which is not the attempt the task stands at (${task.attemptId}).`;
  if (!capabilities.resume) return "This task's driver cannot resume a session.";
  const attempt = db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(task.attemptId);
  if (!attempt || typeof attempt.resume_cursor !== "string" || attempt.resume_cursor === "") return "Its attempt recorded no session to resume.";
  if (!fs.statSync(task.worktreePath, { throwIfNoEntry: false })?.isDirectory()) return "The task's worktree is no longer there.";
  return null;
}
