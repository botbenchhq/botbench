import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { confinementProblem, SANDBOX_EXEC, seatbeltProfile, startHostProxy, unreadablePaths, type Confinement } from "../confinement.ts";
import { execFileSync } from "node:child_process";
import { buildChildEnv } from "../drivers/launch.ts";
import { containerExecArgv, stopLeftovers, type TaskContainer } from "../execution.ts";
import { now, transaction } from "../store/db.ts";

/*
 * The commands Botbench itself runs in a task's worktree: the repository's setup commands before its builder starts
 * (unit 12), and its check commands once the builder's work is committed (unit 13). They are the owner's configured
 * commands, not an agent's, so they do not pass through the permission gate; what they print and how they ended is
 * stored as evidence on the task, append-only. A check runs the project's own code as the agent left it: the agent
 * may have changed what it runs.
 *
 * Each runs as `/bin/sh -c <command>` in the worktree, in a process group of its own, with no input and a time limit.
 * When the limit passes, or Botbench stops the command (a cancel, a shutdown), the whole group is killed; when the
 * command ends by itself, whatever it left running in its group is killed too, so nothing it started outlives it. A
 * process that leaves the group on purpose (`setsid`, a daemon) is not followed.
 *
 * Each runs confined (U27), under macOS's sandbox-exec with a profile made for it (src/confinement.ts), and so does
 * everything it starts, a process that left its group included:
 * - it cannot read the places src/confinement.ts lists (vendor sign-ins, the Keychain, keys, cloud and registry
 *   credentials), nor Botbench's data folder apart from the worktree, which lies inside it; the rest of the home folder
 *   stays readable;
 * - it cannot start an app through LaunchServices or send Apple Events, which would run a program outside the sandbox;
 * - it can write the worktree and a temporary folder of its own, made for it and removed after it, which TMPDIR names,
 *   and nothing else, so a tool that keeps a cache in the home folder has to be pointed at TMPDIR;
 * - it reaches no address that is not this Mac's own, unless the repository allows hosts: it is then pointed at
 *   Botbench's proxy with the usual proxy variables, which opens a tunnel to an allowed host name and to nothing else;
 *   it may listen and connect on this Mac's own addresses, and use Unix sockets in the worktree and its temporary
 *   folder, so a project's tests can start servers;
 * - it gets the environment a CLI gets (src/drivers/launch.ts): the allowlisted variables, no provider key, and no
 *   GIT_* variable, so nothing inherited points git at another repository.
 * Where it cannot be confined it is not run, and has failed. For a repository whose commands run in a container
 * (src/execution.ts, ADR 0009), it runs through `docker exec` in the task's container instead (`runInContainer`).
 *
 * A command run for a task is tracked (U15): its row in `command_processes` is written before it starts, gets its
 * process group and start time once it runs, and is closed in the same write that stores its evidence. A row left open
 * is a command a stopped Botbench left running; the next start stops it (engine/recover.ts).
 */

/** One command as Botbench runs it: the owner's text and its time limit. */
export interface StationCommand {
  command: string;
  limitMs: number;
}

/** The time a setup command gets when the owner gave it none: 10 minutes. */
export const DEFAULT_LIMIT_MS = 600_000;
/** The most of a command's output that is kept: its end, which is where a failure is usually explained. */
export const MAX_OUTPUT_CHARS = 200_000;
/** After a command's own process ends, how long its output pipes get to close before Botbench stops reading them. */
const DRAIN_MS = 2000;

/**
 * How a command ended. `skipped` and `not_run` are a machine check's only (engine/machine-checks.ts): it had nothing to
 * run (the change touches no file its placeholder names), or Botbench could not run it here, with why in its output.
 */
export type CommandOutcome = "passed" | "failed" | "timed_out" | "stopped" | "skipped" | "not_run";

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

/** A run that never started, with why in its output. */
export function notRun(o: { command: string; limitMs: number }, why: string): CommandRun {
  const at = now();
  return { command: o.command, outcome: "failed", exitCode: null, signal: null, output: `${why}\n`, truncated: false, limitMs: o.limitMs, startedAt: at, endedAt: at, durationMs: 0 };
}

/** The proxy variables, named both ways tools read them. */
const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * Run one command in the worktree `cwd`, confined, and resolve with how it went. Never rejects: a command that cannot
 * be started, or cannot be confined, has failed.
 */
/**
 * How a command is held. `check`: the profile above, for every setup and check command. The two others are for a
 * machine check the owner's settings list (engine/machine-checks.ts, #201): `chrome` is the check's profile with the
 * rules Chrome needs to start (src/confinement.ts, `chromeRules`); `unconfined` is no sandbox at all, for a command that
 * starts sandbox-exec itself, which macOS refuses inside any sandbox that denies anything. Such a command still gets a
 * check's environment, its own temporary folder, its process group and its time limit, and nothing else of a check.
 */
export type CommandProfile = "check" | "chrome" | "unconfined";

export async function runCommand(o: { command: string; cwd: string; limitMs: number; signal?: AbortSignal; confinement: Confinement; container?: TaskContainer; track?: Tracked; profile?: CommandProfile }): Promise<CommandRun> {
  const track = o.track;
  if (track === undefined) return runUntracked(o, () => {}, () => {});
  const at = now();
  const row = Number(track.db.prepare("INSERT INTO command_processes (task_id, kind, round, position, command, limit_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(track.taskId, track.kind, track.round, track.position, o.command, o.limitMs, at).lastInsertRowid);
  const result = await runUntracked(
    o,
    (tmp) => void track.db.prepare("UPDATE command_processes SET tmp_dir = ? WHERE id = ?").run(tmp, row),
    // Written once the process exists, so the time is no earlier than the process's own start.
    (pgid) => void track.db.prepare("UPDATE command_processes SET pgid = ?, spawned_at = ? WHERE id = ?").run(pgid, now(), row),
  );
  // Its evidence and the end of its row are one write: a start after a kill finds either both or neither.
  transaction(track.db, () => {
    insertEvidence(track.db, track.taskId, track.kind, track.position, result, track.round, track.needs ?? null);
    track.db.prepare("UPDATE command_processes SET pgid = NULL, ended_at = ? WHERE id = ?").run(now(), row);
  });
  return result;
}

/** Where a command run for a task is recorded: its task, its list, which time that list is run, and its place in it. */
export interface Tracked {
  db: DatabaseSync;
  taskId: number;
  kind: EvidenceKind;
  round: number;
  position: number;
  /** For a machine check: what it was allowed beyond a check, stored with its evidence. */
  needs?: string;
}

/** How one setup or check command is started: the program and its arguments, and its environment. */
export interface ConfinedStart {
  argv: string[];
  env: Record<string, string>;
}

/**
 * How a setup or check command is started: `/bin/sh -c <command>` under sandbox-exec, with the profile for its
 * `worktree` and its own temporary folder `tmp`, and Botbench's environment for it. `proxyPort` is Botbench's proxy
 * when the repository allows hosts. `npm run test:confined` (test/run-confined.ts) starts Botbench's own tests this way.
 * Throws when a path cannot be put in a profile.
 */
export function confinedStart(o: { command: string; worktree: string; dataDir: string; tmp: string; proxyPort: number | null; chrome?: { userTemp: string } }): ConfinedStart {
  const profile = seatbeltProfile({ worktree: o.worktree, unreadable: unreadablePaths({ dataDir: o.dataDir }), writable: [o.tmp], ...(o.chrome === undefined ? {} : { chrome: o.chrome }) });
  // The allowlist holds no GIT_* variable; the owner's own proxy settings are replaced, as the network is Botbench's to give.
  const env = buildChildEnv(process.env, { TMPDIR: o.tmp, GIT_TERMINAL_PROMPT: "0" });
  for (const name of [...PROXY_VARIABLES, "NO_PROXY", "no_proxy"]) delete env[name];
  if (o.proxyPort !== null) for (const name of PROXY_VARIABLES) env[name] = `http://127.0.0.1:${o.proxyPort}`;
  return { argv: [SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", o.command], env };
}

/**
 * How a machine check that may not be in a sandbox is started (`unconfined`): `/bin/sh -c <command>` with a check's
 * environment (no provider key, no GIT_* variable, its own TMPDIR) and no proxy, as nothing holds it to one.
 */
export function unconfinedStart(o: { command: string; tmp: string }): ConfinedStart {
  const env = buildChildEnv(process.env, { TMPDIR: o.tmp, GIT_TERMINAL_PROMPT: "0" });
  for (const name of [...PROXY_VARIABLES, "NO_PROXY", "no_proxy"]) delete env[name];
  return { argv: ["/bin/sh", "-c", o.command], env };
}

/** The user's own temporary folder as macOS names it, by its real path: where Chrome makes its lock folder, whatever TMPDIR says. */
export function userTempDir(): string {
  const named = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 5000 }).trim();
  if (!path.isAbsolute(named)) throw new Error("macOS did not name the user's temporary folder (getconf DARWIN_USER_TEMP_DIR).");
  return fs.realpathSync(named);
}

/**
 * A setup or check command of a repository whose commands run in a container (src/execution.ts): `docker exec` in the
 * task's container, not sandbox-exec, with no shell on this Mac between. The docker program gets Botbench's own
 * environment, which never reaches the container. When the command has ended, however it ended, whatever it left
 * running in the container is stopped, as its process group is on this Mac. A task that may reach hosts has no
 * container (the container reaches no network), so such a command is not run.
 */
async function runInContainer(o: { command: string; cwd: string; limitMs: number; signal?: AbortSignal; confinement: Confinement; container: TaskContainer }, onSpawn: (pgid: number) => void): Promise<CommandRun> {
  if (o.confinement.allowedHosts.length > 0) return notRun(o, "Botbench did not run this command: it runs in a container, which reaches no network, and this task may reach hosts.");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  try {
    return await spawnCommand({ ...o, argv: containerExecArgv(o.container, o.command), env, onSpawn });
  } finally {
    await stopLeftovers(o.container);
  }
}

async function runUntracked(o: { command: string; cwd: string; limitMs: number; signal?: AbortSignal; confinement: Confinement; container?: TaskContainer; profile?: CommandProfile }, onTmp: (dir: string) => void, onSpawn: (pgid: number) => void): Promise<CommandRun> {
  if (o.container !== undefined) return runInContainer({ ...o, container: o.container }, onSpawn);
  const profile = o.profile ?? "check";
  const problem = confinementProblem();
  if (problem !== null) return notRun(o, `Botbench did not run this command. ${problem}`);
  let tmp: string;
  let start: ConfinedStart;
  let proxy: Awaited<ReturnType<typeof startHostProxy>> | null = null;
  try {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-command-")));
  } catch (err) {
    return notRun(o, `Botbench did not run this command: it could not make the command's temporary folder (${err instanceof Error ? err.message : String(err)}).`);
  }
  onTmp(tmp);
  try {
    if (profile === "unconfined") start = unconfinedStart({ command: o.command, tmp });
    else {
      if (o.confinement.allowedHosts.length > 0) proxy = await startHostProxy(o.confinement.allowedHosts);
      start = confinedStart({ command: o.command, worktree: fs.realpathSync(o.cwd), dataDir: o.confinement.dataDir, tmp, proxyPort: proxy?.port ?? null, ...(profile === "chrome" ? { chrome: { userTemp: userTempDir() } } : {}) });
    }
  } catch (err) {
    await proxy?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    return notRun(o, `Botbench did not run this command: it could not confine it (${err instanceof Error ? err.message : String(err)}).`);
  }
  try {
    return await spawnCommand({ ...o, argv: start.argv, env: start.env, onSpawn });
  } finally {
    await proxy?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Run `argv` in `cwd` in a process group of its own and resolve with how it went. Never rejects. */
function spawnCommand(o: { command: string; argv: string[]; env: Record<string, string>; cwd: string; limitMs: number; signal?: AbortSignal; onSpawn: (pgid: number) => void }): Promise<CommandRun> {
  const startedAt = now();
  const began = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    let outcome: CommandOutcome | null = null;
    let finished = false;
    /** Set once the command's own process has ended: how it ended is then known, and no limit or stop can change it. */
    let exited = false;
    const add = (chunk: string): void => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(output.length - MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };
    const child = spawn(o.argv[0]!, o.argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid !== undefined) o.onSpawn(child.pid);
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
      if (outcome !== null || finished || exited) return;
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
      add(`Botbench could not start the command: ${err.message}\n`);
      finish(null, null);
    });
    child.on("exit", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
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
  /** Which time its list was run on the task, from 1: a list stopped by a restart is run again from the start as the next. */
  round: number;
  /** The command's place in its list, from 1. */
  position: number;
  command: string;
  /** For a machine check: what it was allowed beyond a check ("chrome", "nested-sandbox"); null otherwise. */
  needs: string | null;
}

const int = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** A task's evidence, in the order it was recorded. */
export function taskEvidence(db: DatabaseSync, taskId: number): Evidence[] {
  return db.prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY id").all(taskId).map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    kind: String(row.kind) as EvidenceKind,
    round: Number(row.round),
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
    needs: typeof row.needs === "string" ? row.needs : null,
  }));
}

/** Store one command's result on a task. */
export function insertEvidence(db: DatabaseSync, taskId: number, kind: EvidenceKind, position: number, run: CommandRun, round = 1, needs: string | null = null): void {
  db.prepare("INSERT INTO evidence (task_id, kind, round, position, command, outcome, exit_code, signal, output, output_truncated, limit_ms, started_at, ended_at, duration_ms, needs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    taskId, kind, round, position, run.command, run.outcome, run.exitCode, run.signal, run.output, run.truncated ? 1 : 0, run.limitMs, run.startedAt, run.endedAt, run.durationMs, needs,
  );
}

/** The round the next run of a task's list of `kind` commands is: one after the last that was begun, or 1. */
export function nextRound(db: DatabaseSync, taskId: number, kind: EvidenceKind): number {
  const row = db.prepare("SELECT max(round) AS n FROM (SELECT round FROM evidence WHERE task_id = ? AND kind = ? UNION ALL SELECT round FROM command_processes WHERE task_id = ? AND kind = ? UNION ALL SELECT round FROM command_lists WHERE task_id = ? AND kind = ?)").get(taskId, kind, taskId, kind, taskId, kind);
  return (typeof row?.n === "number" ? row.n : 0) + 1;
}

/** One time a list of commands was run on a task, and how many commands the list held when it started. */
export interface CommandList {
  kind: EvidenceKind;
  round: number;
  total: number;
}

/** Record, before its first command starts, that a round of a list begins and how many commands it holds. */
export function startCommandList(db: DatabaseSync, taskId: number, kind: EvidenceKind, round: number, total: number): void {
  db.prepare("INSERT INTO command_lists (task_id, kind, round, total, started_at) VALUES (?, ?, ?, ?, ?)").run(taskId, kind, round, total, now());
}

/** Each round of each list run on a task, in order, with its size. A round run before sizes were recorded is not here. */
export function commandLists(db: DatabaseSync, taskId: number): CommandList[] {
  return db.prepare("SELECT kind, round, total FROM command_lists WHERE task_id = ? ORDER BY kind, round").all(taskId).map((row) => ({ kind: String(row.kind) as EvidenceKind, round: Number(row.round), total: Number(row.total) }));
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
