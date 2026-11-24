import type { Confinement } from "../confinement.ts";
import type { TaskContainer } from "../execution.ts";
import { now } from "../store/db.ts";
import { describeCommits } from "../worktrees.ts";
import { insertEvidence, runCommand, type CommandProfile, type CommandRun, type StationCommand, type Tracked } from "./stations.ts";

/*
 * Checks that need the real machine (#201). A builder's commands run in its CLI's sandbox, and a check's in Botbench's
 * (engine/stations.ts); neither can start headless Chrome or a sandbox of its own, so a task's new browser tests and
 * the tests that start sandbox-exec reached the owner's decision unrun. A repository's settings may list such commands
 * beside its checks ("machineChecks", src/config.ts). Botbench runs them itself, after the checks and before the review,
 * outside any builder's turn, as part of the same round of check evidence: a failure goes back to the builder as a round
 * of fixes for a failing check (engine/check-fix.ts), as a check's does.
 *
 * Each is the owner's own command, never an agent's: nothing an agent wrote is run unless the owner's command runs it,
 * as with any check (the agent may have changed the code it runs). Each names what it needs, and gets that and nothing
 * more:
 * - "chrome": a check's sandbox, with the rules Chrome needs to start added (src/confinement.ts, `chromeRules`): it may
 *   write and use Unix sockets only in its own lock folders in the user's temporary folder. Everything else of a check
 *   holds: no reading of the sign-in and credential folders, writes only to the task's copy and its temporary folder,
 *   no network but this Mac's own addresses and the repository's allowed hosts.
 * - "nested-sandbox": no sandbox. Measured on macOS 27.2: sandbox-exec inside a sandbox fails ("sandbox_apply: Operation
 *   not permitted") as soon as the outer profile denies anything at all, so a command that starts sandbox-exec cannot
 *   be held by one. It runs with the owner's own rights, with a check's environment (no provider key, no GIT_*
 *   variable), its own temporary folder, its process group and time limit. Botbench does not run it for a task whose run
 *   read outside text (a GitHub issue, a peer's message), where what the agent wrote may have been steered by somebody
 *   else; the task says so.
 * A machine check is not run where it cannot be (a repository whose commands run in a container, a computer that is not
 * a Mac): its evidence says `not_run` and why, the task's checks are not marked passed, and the builder is not sent it.
 *
 * `{files}` in a command is the files this change touches that match the check's "files" patterns, read by Botbench
 * from the task's commits (never from anything the agent says), each quoted for the shell and starting with ./ so none
 * reads as an option. With none, the check is `skipped`, saying so. Approach from Paperclip's AGENTS.md ("Report gaps":
 * what could not be run is said, with why, and a failed or interrupted attempt is never a pass) and its `pnpm verify`,
 * which selects the tests a change touches from the files changed since the merge base.
 */

export const MACHINE_NEEDS = ["chrome", "nested-sandbox"] as const;
export type MachineNeed = (typeof MACHINE_NEEDS)[number];

/** A machine check as Botbench runs it: the owner's command and time limit, what it needs, and its file patterns. */
export interface MachineCheck extends StationCommand {
  machine: { needs: MachineNeed[]; files: string[] };
}

/** The placeholder for the files a change touches that match a machine check's patterns. */
export const FILES_PLACEHOLDER = "{files}";
const MAX_TIMEOUT_SECONDS = 86_400;
const FILE_RULE = 'must be a list of file patterns inside the repository, such as ["e2e/*.e2e.ts"]: relative to its top folder, without ".." or a leading "/"; * stands for any part of one name, ** for any folders.';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a pattern of "files" cannot be used, or null. */
function patternProblem(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern === "" || pattern.length > 1000) return FILE_RULE;
  if (pattern.startsWith("/") || pattern.includes("\\") || /[\0-\x1f\x7f?[\]{}]/.test(pattern)) return FILE_RULE;
  if (pattern.split("/").some((part) => part === "" || part === "." || part === "..")) return FILE_RULE;
  return null;
}

/** What is wrong with a repository's "machineChecks", as the end of a sentence about the setting, or null. */
export function machineChecksProblem(list: unknown): string | null {
  const shape = `must be a list of entries such as { "command": "npm run e2e -- ${FILES_PLACEHOLDER}", "needs": ["chrome"], "files": ["e2e/*.e2e.ts"] }.`;
  if (!Array.isArray(list)) return shape;
  for (const entry of list as unknown[]) {
    if (!isObject(entry)) return shape;
    const unknown = Object.keys(entry).find((key) => !["command", "needs", "files", "timeoutSeconds"].includes(key));
    if (unknown !== undefined) return `has an entry with the unknown setting "${unknown}"; an entry holds "command", "needs", and if you like "files" and "timeoutSeconds".`;
    if (typeof entry.command !== "string" || entry.command.trim() === "") return 'has an entry with no "command": the command as text.';
    const needs = entry.needs;
    if (!Array.isArray(needs) || needs.length === 0 || !needs.every((need) => (MACHINE_NEEDS as readonly unknown[]).includes(need)) || new Set(needs).size !== needs.length) {
      return `has an entry whose "needs" is not a list of what it needs beyond a check: ${MACHINE_NEEDS.map((n) => `"${n}"`).join(" or ")}, each once. "nested-sandbox" runs the command outside any sandbox, with your own rights.`;
    }
    const files = entry.files;
    if (files !== undefined) {
      if (!Array.isArray(files) || files.length === 0) return `has an entry whose "files" ${FILE_RULE}`;
      const bad = (files as unknown[]).find((pattern) => patternProblem(pattern) !== null);
      if (bad !== undefined) return `has an entry whose "files" holds ${JSON.stringify(bad)}, which cannot be used. It ${FILE_RULE}`;
    }
    const placed = entry.command.includes(FILES_PLACEHOLDER);
    if (placed && files === undefined) return `has the command ${JSON.stringify(entry.command)}, which holds ${FILES_PLACEHOLDER} but no "files" to fill it from.`;
    if (!placed && files !== undefined) return `has the command ${JSON.stringify(entry.command)}, which has "files" but no ${FILES_PLACEHOLDER} to put them in.`;
    const limit = entry.timeoutSeconds;
    if (limit !== undefined && !(typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= MAX_TIMEOUT_SECONDS)) return `has an entry whose "timeoutSeconds" is not a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}.`;
  }
  return null;
}

/** A "files" pattern as a regular expression over a path relative to the repository's top: `**` any folders, `*` any part of one name. */
export function patternExpression(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      // `**/` is any folders, none included; `**` at the end is anything.
      if (pattern[i + 2] === "/") {
        out += "(?:[^/]+/)*";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else out += c.replace(/[.+^${}()|[\]\\]/g, (x) => `\\${x}`);
  }
  return new RegExp(`^${out}$`);
}

/** A path as one word for /bin/sh, starting with ./ so that a name beginning with "-" is never read as an option. */
export const shellWord = (file: string): string => `'./${file.replace(/'/g, "'\\''")}'`;

/** The files of a change that a machine check's patterns name, in path order: added or changed, not deleted, and with no control character in their names. */
export function matchingFiles(changed: readonly { path: string; status: string }[], patterns: readonly string[]): string[] {
  const expressions = patterns.map(patternExpression);
  return changed.filter((file) => file.status !== "deleted" && !/[\0-\x1f\x7f]/.test(file.path) && expressions.some((e) => e.test(file.path))).map((file) => file.path).sort();
}

/** What a machine check needs, as stored with its evidence and shown on the task. */
export const needsWords = (needs: readonly MachineNeed[]): string => needs.join(",");

/** How a machine check is held: outside any sandbox when it starts one itself, else a check's sandbox with Chrome's rules. */
export const profileOf = (needs: readonly MachineNeed[]): CommandProfile => (needs.includes("nested-sandbox") ? "unconfined" : "chrome");

/** A machine check that was not started, with its outcome and why. */
function unstarted(command: string, limitMs: number, outcome: "skipped" | "not_run", why: string): CommandRun {
  const at = now();
  return { command, outcome, exitCode: null, signal: null, output: `${why}\n`, truncated: false, limitMs, startedAt: at, endedAt: at, durationMs: 0 };
}

/**
 * Run one machine check on a task's committed work, as position `track.position` of its round of check evidence, and
 * resolve with how it went. Its evidence is stored with what it needs. Never rejects.
 */
export async function runMachineCheck(o: {
  check: MachineCheck;
  task: { repo: string; baseCommit: string | null; headCommit: string | null; worktreePath: string };
  confinement: Confinement;
  container: TaskContainer | null;
  /** The task's run read outside text (engine/intake.ts): a check that runs with the owner's rights is not run. */
  outsideText: boolean;
  /** Why commands cannot be confined on this computer, or null. */
  unconfinable: string | null;
  track: Tracked;
  signal?: AbortSignal;
}): Promise<CommandRun> {
  const { check, track } = o;
  const needs = needsWords(check.machine.needs);
  const record = (run: CommandRun): CommandRun => {
    insertEvidence(track.db, track.taskId, track.kind, track.position, run, track.round, needs, track.commit ?? null);
    return run;
  };
  if (o.container !== null) return record(unstarted(check.command, check.limitMs, "not_run", "Botbench did not run this machine check: this repository's commands run in a container, which has no Chrome and cannot start a sandbox. Run it yourself on this Mac."));
  if (o.unconfinable !== null) return record(unstarted(check.command, check.limitMs, "not_run", `Botbench did not run this machine check. ${o.unconfinable}`));
  if (check.machine.needs.includes("nested-sandbox") && o.outsideText) {
    return record(unstarted(check.command, check.limitMs, "not_run", "Botbench did not run this machine check: it runs outside any sandbox, with your own rights, and this task's run read outside text (a GitHub issue or another workbench's message), so what the agent wrote may have been steered by somebody else. Read the change, then run it yourself."));
  }
  let command = check.command;
  if (check.machine.files.length > 0) {
    let changed: { path: string; status: string }[];
    try {
      if (o.task.baseCommit === null || o.task.headCommit === null) throw new Error("the task has no committed work");
      changed = await describeCommits({ repo: o.task.repo, baseCommit: o.task.baseCommit, headCommit: o.task.headCommit });
    } catch (err) {
      return record(unstarted(check.command, check.limitMs, "not_run", `Botbench did not run this machine check: it could not read which files this change touches (${err instanceof Error ? err.message : String(err)}).`));
    }
    const files = matchingFiles(changed, check.machine.files);
    if (files.length === 0) return record(unstarted(check.command, check.limitMs, "skipped", `Botbench did not run this machine check: this change touches no file that ${check.machine.files.join(" or ")} names, so there was nothing for it to run.`));
    command = check.command.split(FILES_PLACEHOLDER).join(files.map(shellWord).join(" "));
  }
  return runCommand({ command, cwd: o.task.worktreePath, limitMs: check.limitMs, confinement: o.confinement, profile: profileOf(check.machine.needs), track: { ...track, needs }, ...(o.signal ? { signal: o.signal } : {}) });
}
