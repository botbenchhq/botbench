import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import { gitEnv } from "../worktrees.ts";

/*
 * The commands Smelt itself runs in a task's worktree: the repository's setup commands before its builder starts
 * (unit 12), and its check commands once the builder's work is committed (unit 13). They are the owner's configured
 * commands, not an agent's, so they do not pass through the permission gate; what they print and how they ended is
 * stored as evidence on the task, append-only. A check runs the project's own code as the agent left it: the agent
 * may have changed what it runs.
 *
 * Each runs as `/bin/sh -c <command>` in the worktree, in a process group of its own, with the caller's environment
 * less every GIT_* variable (as for Smelt's own git calls), no input, and a time limit. When the limit passes, or Smelt
 * stops the command (a cancel, a shutdown), the whole group is killed; when the command ends by itself, whatever it left
 * running in its group is killed too, so nothing it started outlives it. A process that leaves the group on purpose
 * (`setsid`, a daemon) is not followed.
 */

/** One command as Smelt runs it: the owner's text and its time limit. */
export interface StationCommand {
  command: string;
  limitMs: number;
}

/** The time a setup command gets when the owner gave it none: 10 minutes. */
export const DEFAULT_LIMIT_MS = 600_000;
/** The most of a command's output that is kept: its end, which is where a failure is usually explained. */
export const MAX_OUTPUT_CHARS = 200_000;
/** After a command's own process ends, how long its output pipes get to close before Smelt stops reading them. */
const DRAIN_MS = 2000;

export type CommandOutcome = "passed" | "failed" | "timed_out" | "stopped";

export interface CommandRun {
  command: string;
  outcome: CommandOutcome;
  /** The exit code; null when it was killed. */
  exitCode: number | null;
  /** The signal that ended it, when one did. */
  signal: string | null;
  /** What it printed to its output and its error output, as one text in the order it came; its end when it was long. */
  output: string;
  /** True when the start of the output was cut to keep its end. */
  truncated: boolean;
  limitMs: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
};

/** Run one command in `cwd` and resolve with how it went. Never rejects: a command that cannot be started has failed. */
export function runCommand(o: { command: string; cwd: string; limitMs: number; signal?: AbortSignal }): Promise<CommandRun> {
  const startedAt = now();
  const began = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    let outcome: CommandOutcome | null = null;
    let finished = false;
    const add = (chunk: string): void => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(output.length - MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };
    const child = spawn("/bin/sh", ["-c", o.command], { cwd: o.cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drain);
      o.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const endedAt = now();
      resolve({ command: o.command, outcome: outcome ?? (exitCode === 0 ? "passed" : "failed"), exitCode: outcome === null ? exitCode : null, signal, output, truncated, limitMs: o.limitMs, startedAt, endedAt, durationMs: Date.now() - began });
    };
    const stop = (why: CommandOutcome): void => {
      if (outcome !== null || finished) return;
      outcome = why;
      killGroup(child.pid);
    };
    const onAbort = (): void => stop("stopped");
    const timer = setTimeout(() => stop("timed_out"), o.limitMs);
    let drain: NodeJS.Timeout | undefined;
    if (o.signal?.aborted) stop("stopped");
    o.signal?.addEventListener("abort", onAbort);
    child.stdout.setEncoding("utf8").on("data", add);
    child.stderr.setEncoding("utf8").on("data", add);
    child.on("error", (err) => {
      add(`Smelt could not start the command: ${err.message}\n`);
      finish(null, null);
    });
    child.on("exit", (code, signal) => {
      // What the command left running in its group goes with it; its pipes then close.
      killGroup(child.pid);
      drain = setTimeout(() => finish(code, signal), DRAIN_MS);
      child.once("close", () => finish(code, signal));
    });
  });
}

export type EvidenceKind = "setup" | "check";

/** One command's result, stored on a task. Rows are only ever added. */
export interface Evidence extends Omit<CommandRun, "command"> {
  id: number;
  taskId: number;
  kind: EvidenceKind;
  /** The command's place in its list, from 1. */
  position: number;
  command: string;
}

const int = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** A task's evidence, in the order it was recorded. */
export function taskEvidence(db: DatabaseSync, taskId: number): Evidence[] {
  return db.prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY id").all(taskId).map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    kind: String(row.kind) as EvidenceKind,
    position: Number(row.position),
    command: String(row.command),
    outcome: String(row.outcome) as CommandOutcome,
    exitCode: int(row.exit_code),
    signal: typeof row.signal === "string" ? row.signal : null,
    output: String(row.output),
    truncated: row.output_truncated === 1,
    limitMs: Number(row.limit_ms),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    durationMs: Number(row.duration_ms),
  }));
}

/** Store one command's result on a task. */
export function insertEvidence(db: DatabaseSync, taskId: number, kind: EvidenceKind, position: number, run: CommandRun): void {
  db.prepare("INSERT INTO evidence (task_id, kind, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    taskId, kind, position, run.command, run.outcome, run.exitCode, run.signal, run.output, run.truncated ? 1 : 0, run.limitMs, run.startedAt, run.endedAt, run.durationMs,
  );
}

const seconds = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} ${s === 1 ? "second" : "seconds"}` : `${Math.round(s / 60)} minutes`;
};

/** Why a command that did not pass ended a task, in words for the owner. `what` names the list it came from. */
export function commandProblem(what: string, run: CommandRun): string {
  const shown = run.command.length > 200 ? `${run.command.slice(0, 200)}…` : run.command;
  if (run.outcome === "timed_out") return `The ${what} command \`${shown}\` did not finish within ${seconds(run.limitMs)} and was stopped. Its output is on the task.`;
  if (run.outcome === "stopped") return `The ${what} command \`${shown}\` was stopped before it finished.`;
  return `The ${what} command \`${shown}\` failed with ${run.exitCode === null ? `signal ${run.signal ?? "unknown"}` : `exit code ${run.exitCode}`}. Its output is on the task, and no agent was started.`;
}
