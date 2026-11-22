import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** One task's separate copy of the repository: where it is, the branch it is on, and the commit it started from. */
export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
}
export type CommitResult = { committed: true; commit: string } | { committed: false; reason: "nothing to commit" };
export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  /** Lines added and removed; both 0 for a binary file. */
  added: number;
  removed: number;
  binary: boolean;
}
export interface Work {
  branch: string;
  baseCommit: string;
  headCommit: string;
  /** Changes from the base commit to the branch head, ordered by path. Uncommitted changes are not included. */
  files: FileChange[];
}

const BRANCH_PREFIX = "smelt/";
const AUTHOR_NAME = "Smelt";
const AUTHOR_EMAIL = "smelt@localhost";
/** Ids become a directory name and part of a branch name, so they are kept to letters, digits, "-" and "_". */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Options given to every git call:
 * - hooks in the repository are the owner's and must not run on an agent's work, so no hook directory is used;
 * - no file-system monitor program is started;
 * - file names are names, never patterns.
 */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--literal-pathspecs"];

/** The caller's environment without any GIT_* variable, so nothing inherited can point git at another repository, index or config. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

class GitError extends Error {
  stderr: string;
  constructor(message: string, stderr: string, cause: unknown) {
    super(message, { cause });
    this.stderr = stderr;
  }
}

/** Run git in `dir` with an argument array (no shell) and return what it printed. */
function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", dir, ...SAFE, ...args], { env: gitEnv(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args[0]} failed in ${dir}: ${stderr.trim() || err.message}`, stderr.trim(), err));
      else resolve(stdout);
    });
  });
}
const succeeds = (dir: string, args: string[]): Promise<boolean> => git(dir, args).then(() => true, () => false);

/** The real location of a path whose last parts may not exist yet. */
function realPath(p: string): string {
  const missing: string[] = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...missing);
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.resolve(p);
      missing.unshift(path.basename(at));
      at = parent;
    }
  }
}
const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Check `repo` is the top folder of a git repository with at least one commit; returns the commit `HEAD` points at. */
async function sourceHead(repo: string): Promise<string> {
  if (!fs.existsSync(repo)) throw new Error(`Repository path ${repo} does not exist.`);
  if (!isDirectory(repo)) throw new Error(`Repository path ${repo} is not a directory.`);
  let top: string;
  try {
    top = (await git(repo, ["rev-parse", "--show-toplevel"])).trimEnd();
  } catch (err) {
    throw new Error(`${repo} is not a git repository with a working folder (${err instanceof GitError ? err.stderr : String(err)}).`, { cause: err });
  }
  if (realPath(top) !== realPath(repo)) throw new Error(`${repo} is a folder inside the git repository ${top}, not its top level. Give the repository's top level.`);
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
  } catch (err) {
    throw new Error(`The git repository ${repo} has no commits yet. Make a first commit, then try again.`, { cause: err });
  }
}

/**
 * Create a worktree for one task at `<home>/worktrees/<run>/<task>`, on a new branch `smelt/<run>/<task>` that starts at the
 * commit the repository's HEAD points at. Nothing in the repository's own working folder, index or current branch is written.
 */
export async function createWorktree(o: { repo: string; home: string; run: string; task: string }): Promise<Worktree> {
  if (!SLUG.test(o.run)) throw new Error(`Invalid run id ${JSON.stringify(o.run)}: use 1 to 64 letters, digits, "-" or "_", starting with a letter or digit.`);
  if (!SLUG.test(o.task)) throw new Error(`Invalid task id ${JSON.stringify(o.task)}: use 1 to 64 letters, digits, "-" or "_", starting with a letter or digit.`);
  const repo = path.resolve(o.repo);
  const baseCommit = await sourceHead(repo);
  const runDir = path.join(path.resolve(o.home), "worktrees", o.run);
  const dir = path.join(runDir, o.task);
  if (isInside(realPath(dir), realPath(repo))) throw new Error(`The worktree folder ${dir} would be inside the repository ${repo}. Smelt's home must be somewhere else.`);
  if (fs.existsSync(dir)) throw new Error(`The worktree folder ${dir} already exists.`);

  // A name already in use, by an earlier run or anything else, is left alone: the new branch gets the next free name.
  const wanted = `${BRANCH_PREFIX}${o.run}/${o.task}`;
  let branch = wanted;
  for (let n = 2; await succeeds(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); n++) branch = `${wanted}-${n}`;

  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  try {
    // `-b` (never `-B`) fails rather than resets if the name was taken in the meantime.
    await git(repo, ["worktree", "add", "--quiet", "-b", branch, dir, baseCommit]);
  } catch (err) {
    removeIfEmpty(runDir);
    throw err;
  }
  return { path: dir, branch, baseCommit };
}

function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty, or already gone: both are fine.
  }
}

/**
 * Check `dir` is the top of a linked worktree on a Smelt task branch, and return that branch and the repository's shared git folder.
 * The owner's own checkout is never one, so nothing here can commit in it or remove it.
 */
async function taskWorktree(dir: string): Promise<{ branch: string; commonDir: string }> {
  const notOurs = (why: string, cause?: unknown): Error => new Error(`${dir} is not a Smelt worktree: ${why}.`, { cause });
  if (!isDirectory(dir)) throw notOurs("no such folder");
  let lines: string[];
  try {
    lines = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"])).trimEnd().split("\n");
  } catch (err) {
    throw notOurs("it is not in a git repository", err);
  }
  const [gitDir, commonDir, top] = lines;
  if (!gitDir || !commonDir || !top) throw notOurs("git did not describe it");
  if (realPath(gitDir) === realPath(commonDir)) throw notOurs("it is a repository's main checkout");
  if (realPath(top) !== realPath(dir)) throw notOurs("it is a folder inside a worktree, not the worktree itself");
  let branch: string;
  try {
    branch = (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch (err) {
    throw new Error(`The worktree ${dir} is not on a branch, so it is not on its Smelt task branch.`, { cause: err });
  }
  if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`The worktree ${dir} is on branch ${branch}, not on its Smelt task branch.`);
  return { branch, commonDir: realPath(commonDir) };
}

/**
 * Stage everything in the worktree (changed, deleted and new files, except ignored ones) and commit it to the task branch
 * as Smelt. The owner's git identity is neither read nor needed, and no hook runs.
 */
export async function commitWork(o: { path: string; message: string }): Promise<CommitResult> {
  if (o.message.trim() === "") throw new Error("A commit message is required.");
  const dir = path.resolve(o.path);
  await taskWorktree(dir);
  await git(dir, ["add", "--all"]);
  const [staged, current] = await Promise.all([git(dir, ["write-tree"]), git(dir, ["rev-parse", "HEAD^{tree}"])]);
  if (staged.trim() === current.trim()) return { committed: false, reason: "nothing to commit" };
  await git(dir, [
    "-c", `user.name=${AUTHOR_NAME}`,
    "-c", `user.email=${AUTHOR_EMAIL}`,
    "commit", "--quiet", "--no-verify", "--no-gpg-sign", "--cleanup=whitespace", `--message=${o.message}`,
  ]);
  return { committed: true, commit: (await git(dir, ["rev-parse", "HEAD"])).trim() };
}

function checkBase(baseCommit: string): void {
  if (!COMMIT_ID.test(baseCommit)) throw new Error(`Invalid base commit ${JSON.stringify(baseCommit)}: give the full commit id.`);
}
/** Diffs are computed by git itself, whatever diff programs or display settings the owner has configured. */
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];

/** The task's branch, where it started, where it is now, and what changed in between, file by file. */
export async function describeWork(o: { path: string; baseCommit: string }): Promise<Work> {
  checkBase(o.baseCommit);
  const dir = path.resolve(o.path);
  const { branch } = await taskWorktree(dir);
  const headCommit = (await git(dir, ["rev-parse", "HEAD"])).trim();
  const [names, counts] = await Promise.all([
    git(dir, [...DIFF, "--name-status", "-z", o.baseCommit, headCommit]),
    git(dir, [...DIFF, "--numstat", "-z", o.baseCommit, headCommit]),
  ]);
  const status = new Map<string, FileChange["status"]>();
  const parts = names.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const letter = parts[i];
    const file = parts[i + 1];
    if (file === undefined) continue;
    status.set(file, letter === "A" ? "added" : letter === "D" ? "deleted" : "modified");
  }
  const files: FileChange[] = [];
  for (const entry of counts.split("\0")) {
    if (entry === "") continue;
    const [added = "", removed = "", ...rest] = entry.split("\t");
    const file = rest.join("\t");
    const binary = added === "-";
    files.push({ path: file, status: status.get(file) ?? "modified", added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
  }
  return { branch, baseCommit: o.baseCommit, headCommit, files };
}

/** One file's unified diff from the base commit to the branch head; empty when the file did not change. */
export async function fileDiff(o: { path: string; baseCommit: string; file: string }): Promise<string> {
  checkBase(o.baseCommit);
  if (o.file === "" || o.file.includes("\0")) throw new Error(`Invalid file name ${JSON.stringify(o.file)}.`);
  const dir = path.resolve(o.path);
  await taskWorktree(dir);
  return git(dir, [...DIFF, "--full-index", "--src-prefix=a/", "--dst-prefix=b/", o.baseCommit, "HEAD", "--", o.file]);
}

/**
 * Remove a task's worktree. Refused while it has uncommitted changes, so work is never lost. The branch, and so the
 * committed work, stays unless `deleteBranch` is true.
 */
export async function removeWorktree(o: { repo: string; path: string; deleteBranch: boolean }): Promise<void> {
  const repo = path.resolve(o.repo);
  const dir = path.resolve(o.path);
  const { branch, commonDir } = await taskWorktree(dir);
  let repoCommon: string;
  try {
    repoCommon = realPath((await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd());
  } catch (err) {
    throw new Error(`${repo} is not a git repository.`, { cause: err });
  }
  if (repoCommon !== commonDir) throw new Error(`The worktree ${dir} does not belong to the repository ${repo}.`);
  const changes = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (changes !== "") throw new Error(`The worktree ${dir} has uncommitted changes, so it was not removed. Commit the work first.`);

  // Without --force, git itself also refuses if anything changed since the check above.
  await git(repo, ["worktree", "remove", dir]);
  await git(repo, ["worktree", "prune"]);
  if (o.deleteBranch) await git(repo, ["branch", "--quiet", "-D", branch]);
  removeIfEmpty(path.dirname(dir));
}
