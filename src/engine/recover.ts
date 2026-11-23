import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Approval } from "../approvals/broker.ts";
import type { DriverCapabilities } from "../drivers/contract.ts";
import type { DriverEvent } from "../drivers/events.ts";
import { killProcessGroup, processGroupAlive } from "../drivers/launch.ts";
import { now, transaction } from "../store/db.ts";
import { insertEvidence, type CommandRun, type EvidenceKind } from "./stations.ts";

/*
 * What a start of Botbench does about a task that was waiting on the owner when the last run stopped: the
 * parked-approval half of restart recovery. Such a task is not re-driven and not interrupted. Its approval
 * stays pending, its CLI process from before is stopped if it survived, and it waits until the owner answers.
 * It also holds what the rest of restart recovery (unit 15) needs to be safe: stopping a recorded process group only
 * once it is known to be Botbench's own, and closing the setup and check commands a stopped Botbench left running.
 * What is re-driven, and when a task is stopped for the owner instead, is the engine's (engine/task.ts).
 */

/**
 * What Botbench says to the agent when it re-drives a task after the owner answered a parked approval. The session
 * it resumes ends with a tool call that was never answered; the agent is asked to make it again, so that the
 * owner's stored answer can be given to exactly that request. These are Botbench's words and say so: the transcript
 * shows a prompt as the owner's.
 */
export const RESUME_PROMPT =
  "[From Botbench, not from the owner] Botbench was restarted while you were waiting for permission for your last tool call. That call was neither run nor refused. Make exactly that same tool call again now, unchanged, and then carry on with the task.";

/**
 * What Botbench says to the agent when it continues a task whose turn was stopped before it finished: by a restart of
 * Botbench, or by the owner's Resume after one. These are Botbench's words and say so: the transcript shows a prompt as the owner's.
 */
export const CONTINUE_PROMPT =
  "[From Botbench, not from the owner] Your work on this task was stopped before it finished, because Botbench stopped. The files in this folder are as you left them, and anything you were running then was stopped. Carry on with the task from where you left off, and finish it.";

/**
 * What Botbench says to the agent when the owner resumes a task whose last turn ended without changing a file (the agent
 * may have left the work to something that did not finish within the turn). Botbench's words, and they say so.
 */
export const CHANGED_NOTHING_PROMPT =
  "[From Botbench, not from the owner] Your last turn ended without changing any file in this folder, so there was nothing to check or review. Do the task now, in this turn, yourself: anything left running when the turn ends is stopped and not kept. Change the files the task needs before you finish.";

const PS_LIMIT_MS = 5000;
/** A CLI is started just before its attempt row is written; the clock `ps` reads has whole seconds. */
const START_SLACK_MS = 5000;

/** When the process began, as the system reports it; null when there is no such process. Rejects when the system cannot be asked. */
function startedAt(pid: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // A time limit, and a fixed locale so the date reads the same on every machine.
    // `ps` is told to print the time in UTC and it is read as UTC, so neither Botbench's own time zone nor a clock change can shift it.
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
 * Stop a process group a Botbench from before this start recorded, if it is still that one, and resolve once it is
 * gone; rejects when it cannot be stopped. `recordedAt` is when the group was written down, no earlier than its
 * leader's start.
 *
 * A group's number can pass to an unrelated process once the group is gone, so a bare number is never killed. The group
 * is the one recorded while its leader is the process that was started then (it began no later than the record was
 * written), or while its leader is gone and members remain (a number is not given out again while its group exists).
 * A leader that began later is someone else's and is left alone, and so is everything when the machine itself started
 * after the record was written, or when that time is unknown or cannot be read. Returns whether it was stopped.
 */
export async function stopRecordedGroup(pgid: number, recordedAt: string | null): Promise<boolean> {
  if (!processGroupAlive(pgid)) return false;
  const made = recordedAt === null ? NaN : Date.parse(recordedAt);
  if (Number.isNaN(made)) return false;
  const began = await startedAt(pgid);
  // Process 1 began when the machine did. Nothing from before that is still running.
  const booted = await startedAt(1);
  const ours = booted !== null && booted <= made + START_SLACK_MS && (began === null || began <= made + START_SLACK_MS);
  if (ours) await killProcessGroup(pgid);
  return ours;
}

/** How a turn cut off by a restart ends in its transcript: the detail of its closing `turn_ended`, shown as it is (web/src/api/client.ts). */
export const RESTART_STOPPED = "Stopped: Botbench restarted";

/**
 * Stop whatever is left of an attempt's CLI process group from before this start, so that no second agent is
 * started beside it in the same worktree. Resolves once the group is gone and the attempt no longer names it;
 * rejects when it cannot be stopped. A CLI is started just before its attempt row is written.
 *
 * An attempt still running then had its turn cut off by the restart (a chat or review turn, a builder's, a planner's):
 * its last turn, when it has no end, is closed as stopped, in the same write that marks the attempt interrupted, so the
 * transcript says what happened rather than looking unfinished. A second call finds the attempt no longer running and
 * adds nothing; an attempt that ended in the ordinary way is left as it is.
 */
export async function stopSurvivor(db: DatabaseSync, attemptId: number): Promise<void> {
  const row = db.prepare("SELECT pgid, created_at FROM attempts WHERE id = ?").get(attemptId);
  if (!row) return;
  if (typeof row.pgid === "number") await stopRecordedGroup(row.pgid, String(row.created_at));
  transaction(db, () => {
    const at = now();
    // Read again in the write: the status decides whether the turn is closed.
    const running = db.prepare("SELECT 1 FROM attempts WHERE id = ? AND status = 'running'").get(attemptId) !== undefined;
    const last = db.prepare("SELECT max(turn) AS turn FROM events WHERE attempt_id = ?").get(attemptId)?.turn;
    // Only a turn that was sent is closed: a session that had sent nothing yet had no turn to cut off.
    const has = (type: string): boolean => db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND turn = ? AND type = ?").get(attemptId, last as number, type) !== undefined;
    if (running && typeof last === "number" && has("user_prompt") && !has("turn_ended")) {
      const event: DriverEvent = { type: "turn_ended", reason: "interrupted", detail: RESTART_STOPPED };
      db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(attemptId, last, at, event.type, JSON.stringify(event));
    }
    // Whatever state the attempt was left in, nothing of it runs any more.
    db.prepare("UPDATE attempts SET pgid = NULL, status = CASE status WHEN 'running' THEN 'interrupted' ELSE status END, updated_at = ? WHERE id = ?").run(at, attemptId);
  });
}

/** Whether `dir` is a temporary folder of a command as stations.ts makes one, and nothing else that could be removed. */
function commandTmpDir(dir: string): boolean {
  if (!path.isAbsolute(dir) || !path.basename(dir).startsWith("botbench-command-")) return false;
  const parent = path.dirname(dir);
  const tmp = os.tmpdir();
  let real = tmp;
  try {
    real = fs.realpathSync(tmp);
  } catch {
    // The system's temporary folder as it is named is all there is to compare with.
  }
  return parent === tmp || parent === real;
}

/**
 * Close what a stopped Botbench left of the setup and check commands it was running: each group that is still that
 * command's is stopped, its temporary folder removed, and the command recorded as stopped by the restart, in the same
 * write that closes its row. Evidence is only added to: this is the command's one row. Returns the tasks one of whose
 * commands could not be stopped, with why: nothing more may run in their copies.
 */
export async function closeLeftCommands(db: DatabaseSync, before: string): Promise<Map<number, string>> {
  const failed = new Map<number, string>();
  for (const row of db.prepare("SELECT * FROM command_processes WHERE ended_at IS NULL AND created_at < ? ORDER BY id").all(before)) {
    const taskId = Number(row.task_id);
    if (typeof row.pgid === "number") {
      try {
        await stopRecordedGroup(row.pgid, typeof row.spawned_at === "string" ? row.spawned_at : null);
      } catch (err) {
        failed.set(taskId, `A command Botbench started for this task before it stopped could not be stopped: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    if (typeof row.tmp_dir === "string" && commandTmpDir(row.tmp_dir)) fs.rmSync(row.tmp_dir, { recursive: true, force: true });
    const at = now();
    const started = typeof row.spawned_at === "string" ? row.spawned_at : String(row.created_at);
    transaction(db, () => {
      const kind = String(row.kind) as EvidenceKind;
      const round = Number(row.round);
      const position = Number(row.position);
      if (!db.prepare("SELECT 1 FROM evidence WHERE task_id = ? AND kind = ? AND round = ? AND position = ?").get(taskId, kind, round, position)) {
        const run: CommandRun = { command: String(row.command), outcome: "stopped", exitCode: null, signal: null, output: "Botbench stopped while this command ran, so it did not finish. It was stopped when Botbench started again.\n", truncated: false, limitMs: Number(row.limit_ms), startedAt: started, endedAt: at, durationMs: Math.max(0, Date.parse(at) - Date.parse(started)) };
        insertEvidence(db, taskId, kind, position, run, round);
      }
      db.prepare("UPDATE command_processes SET pgid = NULL, ended_at = ? WHERE id = ?").run(at, Number(row.id));
    });
  }
  return failed;
}

/**
 * Why a task whose approvals were asked before a restart cannot be resumed, in words for the owner; null when it
 * can. Checked on start, so that no card is shown whose answer could lead nowhere, and again before re-driving.
 */
export function resumeProblem(db: DatabaseSync, task: { attemptId: number | null; worktreePath: string | null }, parked: readonly Approval[], capabilities: DriverCapabilities): string | null {
  if (task.attemptId === null || task.worktreePath === null) return "The task has nothing to resume.";
  // A stored answer belongs to the attempt that asked, and that must be the attempt the task still stands at.
  const strangers = parked.filter((approval) => approval.attemptId !== task.attemptId);
  if (strangers.length > 0) return `The request belongs to an earlier session of this task (number ${strangers[0]!.attemptId}), not the one it is on now (number ${task.attemptId}).`;
  if (!capabilities.resume) return "This task's agent cannot resume a session.";
  const attempt = db.prepare("SELECT resume_cursor FROM attempts WHERE id = ?").get(task.attemptId);
  if (!attempt || typeof attempt.resume_cursor !== "string" || attempt.resume_cursor === "") return "It recorded no session to resume.";
  if (!fs.statSync(task.worktreePath, { throwIfNoEntry: false })?.isDirectory()) return "The task's copy of the project is no longer there.";
  return null;
}
