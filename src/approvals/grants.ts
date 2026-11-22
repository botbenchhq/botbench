import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import { showWords, splitPlain } from "./shell.ts";

/*
 * Grants: what the owner has said may run without asking. A grant is narrow: one command, as its words,
 * for one role, in one source repository, from one directory of the worktree.
 *   preapproved  given when a run is started, for that run only (this unit)
 *   standing     earned by repeated approvals and kept until taken back (unit 10; nothing grants on it yet)
 * A grant never decides alone: the gate asks the safety floor first, and the floor wins.
 */

export type GrantKind = "preapproved" | "standing";

export interface Grant {
  id: number;
  kind: GrantKind;
  role: string;
  /** The source repository, by its real path: not the worktree. */
  repo: string;
  /** The directory the command runs in, relative to the top of the worktree; "." is the top. */
  cwd: string;
  /** The command as the words a shell hands the program. A request matches when it begins with exactly these. */
  words: string[];
  /** The run a pre-approved grant belongs to. */
  runId: number | null;
  /** The task whose start created it. */
  taskId: number | null;
  createdAt: string;
}

/** The longest entry the owner may list, and how many. */
export const MAX_ENTRY = 500;
export const MAX_ENTRIES = 50;
export { showWords };

/** Programs whose whole job is to run another command: listed bare, they would pre-approve everything. */
const RUNS_ANYTHING = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "xargs", "eval", "exec", "command", "builtin", "nohup", "time", "nice", "sudo", "doas", "su"]);

const NOT_PLAIN = "It must be one plain command: no `;`, `&&`, `||`, `|`, `&`, `>`, `<`, `$`, backticks, `*`, backslashes or line breaks.";

/** Why a command the owner listed cannot be a grant, in words; null when it can. */
export function entryProblem(command: unknown): string | null {
  if (typeof command !== "string") return "Each pre-approved command must be text.";
  if (command.trim() === "") return "A pre-approved command is empty.";
  if (command.length > MAX_ENTRY) return `A pre-approved command is too long: ${MAX_ENTRY} characters at most.`;
  const shown = JSON.stringify(command);
  const words = splitPlain(command);
  if (words === null) return `${shown} cannot be pre-approved. ${NOT_PLAIN}`;
  const first = words[0]!;
  if (first === "") return `${shown} cannot be pre-approved: it names no program.`;
  if (first.includes("=")) return `${shown} cannot be pre-approved: it starts by setting a variable. List the command itself.`;
  if (first.startsWith("-")) return `${shown} cannot be pre-approved: it starts with an option, not a program.`;
  if (words.length === 1 && RUNS_ANYTHING.has(first.slice(first.lastIndexOf("/") + 1).toLowerCase())) return `${shown} alone is too broad to pre-approve: it runs whatever it is handed. List the whole command, such as "sh build.sh".`;
  // What is stored must read back as the same words, so that what the owner sees listed is what was granted.
  const back = splitPlain(showWords(words));
  if (back === null || back.length !== words.length || back.some((word, i) => word !== words[i])) return `${shown} cannot be pre-approved: it mixes both kinds of quotes in one word.`;
  return null;
}

/** A repository's path with links followed, which is how a grant names it. A path that does not exist is kept as written. */
export function realRepo(repo: string): string {
  try {
    return fs.realpathSync(repo);
  } catch {
    return path.resolve(repo);
  }
}

export interface GrantRequest {
  role: string;
  /** The source repository's real path. */
  repo: string;
  runId: number | null;
  /** Relative to the worktree's top. */
  cwd: string;
  /** The request's command as a plain command's words. */
  words: readonly string[];
}

/**
 * The pre-approved grant a request runs on, or null. The request's leading words must equal the grant's, word
 * for word; further words may follow. Run, repository, role and directory must be the grant's own.
 * This is only the comparison: whether the command is plain, and whether the floor forbids it, is the gate's.
 */
export function matchGrant(request: GrantRequest, grants: readonly Grant[]): Grant | null {
  return (
    grants.find(
      (grant) =>
        grant.kind === "preapproved" &&
        grant.runId !== null &&
        grant.runId === request.runId &&
        grant.role === request.role &&
        grant.repo === request.repo &&
        grant.cwd === request.cwd &&
        grant.words.length > 0 &&
        grant.words.length <= request.words.length &&
        grant.words.every((word, i) => word === request.words[i]),
    ) ?? null
  );
}

function toGrant(row: Record<string, unknown>): Grant {
  const words: unknown = JSON.parse(String(row.words));
  return {
    id: Number(row.id),
    kind: String(row.kind) as GrantKind,
    role: String(row.role),
    repo: String(row.repo_path),
    cwd: String(row.cwd),
    // Words that do not read as a list of text grant nothing.
    words: Array.isArray(words) && words.every((word) => typeof word === "string") ? words : [],
    runId: typeof row.run_id === "number" ? row.run_id : null,
    taskId: typeof row.task_id === "number" ? row.task_id : null,
    createdAt: String(row.created_at),
  };
}

/** A run's pre-approved grants, in the order the owner listed them. */
export function runGrants(db: DatabaseSync, runId: number): Grant[] {
  return db.prepare("SELECT * FROM grants WHERE kind = 'preapproved' AND run_id = ? ORDER BY id").all(runId).map(toGrant);
}

/**
 * Store a run's pre-approved commands as grants at the top of the worktree. Throws on an entry that cannot be a
 * grant. Call it inside the transaction that writes the task, so neither exists without the other.
 * The same command listed twice is stored once.
 */
export function insertPreapproved(db: DatabaseSync, o: { role: string; repo: string; runId: number; taskId: number; commands: readonly string[] }): void {
  const seen = new Set<string>();
  const insert = db.prepare("INSERT INTO grants (kind, role, repo_path, cwd, words, run_id, task_id, created_at) VALUES ('preapproved', ?, ?, '.', ?, ?, ?, ?)");
  for (const command of o.commands) {
    const problem = entryProblem(command);
    if (problem !== null) throw new Error(problem);
    const words = JSON.stringify(splitPlain(command));
    if (seen.has(words)) continue;
    seen.add(words);
    insert.run(o.role, realRepo(o.repo), words, o.runId, o.taskId, now());
  }
}
