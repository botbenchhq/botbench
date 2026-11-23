import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";
import { showWords, splitPlain } from "./shell.ts";

/*
 * Grants: what the owner has said may run without asking. A grant is narrow: one command, as its words,
 * for one role, in one source repository, from one directory of the worktree.
 *   preapproved  given when a run is started, for that run only; it allows the command and whatever follows it
 *   standing     given from a card after the owner allowed the same command often enough; it belongs to no run,
 *                allows the whole command and nothing longer, and stands until it is taken back
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
  /** The command as the words a shell hands the program. A pre-approved grant matches a request that begins with exactly these; a standing grant one that is exactly these. */
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
  if (typeof command !== "string") return "Each allowed command must be text.";
  if (command.trim() === "") return "An allowed command is empty.";
  if (command.length > MAX_ENTRY) return `An allowed command is too long: ${MAX_ENTRY} characters at most.`;
  const shown = JSON.stringify(command);
  const words = splitPlain(command);
  if (words === null) return `${shown} cannot be allowed in advance. ${NOT_PLAIN}`;
  const first = words[0]!;
  if (first === "") return `${shown} cannot be allowed in advance: it names no program.`;
  if (first.includes("=")) return `${shown} cannot be allowed in advance: it starts by setting a variable. List the command itself.`;
  if (first.startsWith("-")) return `${shown} cannot be allowed in advance: it starts with an option, not a program.`;
  if (words.length === 1 && RUNS_ANYTHING.has(first.slice(first.lastIndexOf("/") + 1).toLowerCase())) return `${shown} alone is too broad to pre-approve: it runs whatever it is handed. List the whole command, such as "sh build.sh".`;
  // What is stored must read back as the same words, so that what the owner sees listed is what was granted.
  const back = splitPlain(showWords(words));
  if (back === null || back.length !== words.length || back.some((word, i) => word !== words[i])) return `${shown} cannot be allowed in advance: it mixes both kinds of quotes in one word.`;
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
 * The grant a request runs on, or null. Repository, role and directory must be the grant's own, for either kind.
 *   preapproved  the run must be the grant's, and the request's leading words must equal the grant's, word for
 *                word; further words may follow
 *   standing     the grant names no run, and the request's words must be the grant's and no more
 * A run's pre-approved grant is named before a standing one when both apply.
 * This is only the comparison: whether the command is plain, and whether the floor forbids it, is the gate's.
 */
export function matchGrant(request: GrantRequest, grants: readonly Grant[]): Grant | null {
  const here = grants.filter((grant) => grant.role === request.role && grant.repo === request.repo && grant.cwd === request.cwd && grant.words.length > 0);
  const begins = (grant: Grant): boolean => grant.words.length <= request.words.length && grant.words.every((word, i) => word === request.words[i]);
  return (
    here.find((grant) => grant.kind === "preapproved" && grant.runId !== null && grant.runId === request.runId && begins(grant)) ??
    here.find((grant) => grant.kind === "standing" && grant.runId === null && grant.words.length === request.words.length && begins(grant) && standingProblem(grant.words) === null) ??
    null
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
export function insertPreapproved(db: DatabaseSync, o: { role: string; repo: string; runId: number; /** The task whose start created them; null for a planned run's, which exist before its tasks. */ taskId: number | null; commands: readonly string[] }): void {
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

/*
 * Standing permissions. Nothing here keeps a count: how often the owner allowed something is read, each time it
 * is needed, from the approvals and the action log, which are only ever added to.
 */

/** What approvals are counted by: who asked, in which repository, from which directory, and what for. */
export interface ApprovalKey {
  role: string;
  /** The source repository's real path: the same for every task's worktree of it. */
  repo: string;
  /** Relative to the worktree's top. */
  cwd: string;
  tool: string;
  /** A shell command as its words; null for any other tool, which is counted by its name alone. */
  words: readonly string[] | null;
}

const sameWords = (a: readonly string[] | null, b: readonly string[]): boolean => a !== null && a.length === b.length && a.every((word, i) => word === b[i]);

/**
 * How many requests with this key the owner allowed, since a standing permission for it was last taken back.
 * Counted are approvals that ended allowed and whose allowing by the owner is in the log. A decline, a request
 * that ended unanswered, and a run on a pre-approved or standing grant are none of these.
 */
export function approvalCount(db: DatabaseSync, key: ApprovalKey): number {
  // A directory nobody reported is not known to be the same one twice.
  if (key.cwd === "") return 0;
  const since =
    key.words === null
      ? 0
      : Number(
          db
            .prepare("SELECT COALESCE(MAX(l.id), 0) AS id FROM action_log l JOIN grants g ON g.id = l.grant_id WHERE l.rule = 'standing_revoked' AND g.kind = 'standing' AND g.role = ? AND g.repo_path = ? AND g.cwd = ? AND g.words = ?")
            .get(key.role, key.repo, key.cwd, JSON.stringify(key.words))!.id,
        );
  // The repository is compared as the task stored it when it was started, never resolved again.
  const rows = db
    .prepare(
      "SELECT a.command AS command FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.status = 'allowed' AND a.escalation = 0 AND a.role = ? AND a.tool = ? AND a.cwd = ? AND t.repo_path = ? AND EXISTS (SELECT 1 FROM action_log l WHERE l.approval_id = a.id AND l.rule = 'owner_allowed' AND l.id > ?)",
    )
    .all(key.role, key.tool, key.cwd, key.repo, since);
  return rows.filter((row) => key.words === null || sameWords(splitPlain(String(row.command)), key.words)).length;
}

const programName = (word: string): string => word.slice(word.lastIndexOf("/") + 1).toLowerCase();
/** Programs that run whatever command follows them: a standing permission for one would be for the command behind it. */
const WRAPPERS = new Set(["env", "xargs", "exec", "command", "builtin", "nohup", "time", "nice", "timeout", "sudo", "doas", "su", "eval", "watch", "caffeinate", "script", "expect", "parallel", "find"]);
/** Programs whose job is to send to, or act on, another machine or account, or to change what starts on this one. */
const REACHES_OUT = new Set(["curl", "wget", "scp", "sftp", "ftp", "rsync", "ssh", "nc", "ncat", "netcat", "telnet", "socat", "gh", "hub", "glab", "aws", "gcloud", "az", "docker", "podman", "kubectl", "helm", "terraform", "open", "osascript", "crontab", "launchctl", "mail", "sendmail"]);
/** Programs that take the code to run as an argument. Named with a file (`sh build.sh`, `node build.js`) they can have standing permission. */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "python", "python2", "python3", "node", "deno", "bun", "perl", "ruby", "php", "lua", "awk", "gawk", "sed", "jq", "tclsh", "osascript"]);
const INLINE_CODE = /^(-[A-Za-z]*[cCeEpP][A-Za-z]*|--eval|--print|--exec|--command|--execute)(=.*)?$/;
/** Words after a package tool that publish or sign in. */
const PUBLISHES = new Set(["publish", "push", "login", "adduser", "deploy", "release", "upload"]);

/**
 * Why a command cannot be given standing permission, in words; null when it can. On top of the rules for a
 * pre-approved entry: a standing permission lasts beyond its task and is given from a card, so commands that leave
 * the machine, run a command or code handed to them on the command line, or hold a `~` (which a shell may or may
 * not rewrite, depending on quotes this reading has dropped) are never eligible. This is a list of known forms,
 * not of everything harmful; what it misses still needs the owner's own repeated approvals and confirmation.
 */
export function standingProblem(words: readonly string[]): string | null {
  const problem = entryProblem(showWords(words));
  if (problem !== null) return problem;
  if (words.some((word) => word.includes("~"))) return "It holds a ~, which a shell may read as your home directory or as itself.";
  const program = programName(words[0]!);
  if (WRAPPERS.has(program)) return `${program} runs whatever command it is handed.`;
  if (REACHES_OUT.has(program)) return `${program} reaches beyond this machine or changes what runs on it, so it asks every time.`;
  if (INTERPRETERS.has(program) && (program === "awk" || program === "gawk" || program === "sed" || program === "jq" || words.slice(1).some((word) => INLINE_CODE.test(word)))) return `${program} is handed its code on the command line.`;
  if (words.slice(1).some((word) => PUBLISHES.has(word.toLowerCase()))) return "It publishes, pushes, deploys or signs in.";
  return null;
}

/** A standing grant stands when it was not taken back and the log says the owner gave it. */
const STANDS =
  "g.kind = 'standing' AND g.run_id IS NULL AND NOT EXISTS (SELECT 1 FROM grant_revocations r WHERE r.grant_id = g.id) AND EXISTS (SELECT 1 FROM action_log l WHERE l.grant_id = g.id AND l.rule = 'standing_granted')";

/** The standing grants in force for a role in a repository, read afresh each time: one taken back is gone from the next request on. */
export function standingGrants(db: DatabaseSync, o: { role: string; repo: string }): Grant[] {
  return db.prepare(`SELECT g.* FROM grants g WHERE ${STANDS} AND g.role = ? AND g.repo_path = ? ORDER BY g.id`).all(o.role, o.repo).map(toGrant);
}

/** A standing permission as the owner sees it listed. */
export interface StandingGrant {
  id: number;
  role: string;
  repo: string;
  cwd: string;
  /** The command, as one line that splits into the granted words. */
  command: string;
  /** The task whose card it was given from. */
  taskId: number | null;
  grantedAt: string;
  /** How many commands ran on it, and when the last one did: read from the action log. */
  timesUsed: number;
  lastUsedAt: string | null;
}

/** Every standing permission in force, oldest first. */
export function listStanding(db: DatabaseSync): StandingGrant[] {
  return db
    .prepare(
      `SELECT g.*, (SELECT count(*) FROM action_log l WHERE l.grant_id = g.id AND l.rule = 'standing') AS times_used, (SELECT l.ts FROM action_log l WHERE l.grant_id = g.id AND l.rule = 'standing' ORDER BY l.id DESC LIMIT 1) AS last_used_at FROM grants g WHERE ${STANDS} ORDER BY g.id`,
    )
    .all()
    .map((row) => {
      const grant = toGrant(row);
      return { id: grant.id, role: grant.role, repo: grant.repo, cwd: grant.cwd, command: showWords(grant.words), taskId: grant.taskId, grantedAt: grant.createdAt, timesUsed: Number(row.times_used), lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : null };
    });
}

/** Store a standing grant and return its id. Call it inside the transaction that answers the card it was given from and logs both. */
export function insertStanding(db: DatabaseSync, o: { role: string; repo: string; cwd: string; words: readonly string[]; taskId: number }): number {
  const problem = standingProblem(o.words);
  if (problem !== null) throw new Error(problem);
  return Number(db.prepare("INSERT INTO grants (kind, role, repo_path, cwd, words, run_id, task_id, created_at) VALUES ('standing', ?, ?, ?, ?, NULL, ?, ?)").run(o.role, o.repo, o.cwd, JSON.stringify(o.words), o.taskId, now()).lastInsertRowid);
}

/** A standing grant by its id, in force or not, and whether it was taken back; null for any other id. */
export function findStanding(db: DatabaseSync, id: number): { grant: Grant; revoked: boolean } | null {
  const row = db.prepare("SELECT g.*, EXISTS (SELECT 1 FROM grant_revocations r WHERE r.grant_id = g.id) AS revoked FROM grants g WHERE g.id = ? AND g.kind = 'standing'").get(id);
  return row ? { grant: toGrant(row), revoked: Number(row.revoked) === 1 } : null;
}

/** Take a standing grant back. The grant's row stays; this adds the row that ends it. Call it inside the transaction that logs it. */
export function insertRevocation(db: DatabaseSync, grantId: number): void {
  db.prepare("INSERT INTO grant_revocations (grant_id, revoked_at) VALUES (?, ?)").run(grantId, now());
}
