import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLessonBranch, parseTaskBranch, workbenchProblem } from "./workbench.ts";

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

/**
 * Every task branch starts with this. New ones are `botbench/<workbench>/<run>/<task>`; the forms from before
 * workbenches had names (`botbench/<run>/<task>`) and from before the rename from Smelt (`smelt/<run>/<task>`) still
 * work for the tasks that have them, and no new branch gets either (src/workbench.ts).
 */
export const BRANCH_PREFIX = "botbench/";
const AUTHOR_NAME = "Botbench";
const AUTHOR_EMAIL = "botbench@localhost";
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

const GITHUB_TOKEN_ENV = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

/**
 * The caller's environment without any GIT_* variable, so nothing inherited can point git at another repository, index
 * or config. Botbench's own git calls run with it, and so do the setup commands Botbench runs in a worktree.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // A GitHub token in the environment is never handed on: git's credential helper and `gh` use the sign-in they keep.
    if (!name.startsWith("GIT_") && !GITHUB_TOKEN_ENV.has(name.toUpperCase())) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

class GitError extends Error {
  stderr: string;
  /** What git printed on its standard output before it failed. */
  stdout = "";
  constructor(message: string, stderr: string, cause: unknown) {
    super(message, { cause });
    this.stderr = stderr;
  }
}

/** The time git gets to answer a question about a repository: where its top is, what a name points at. These read a few small files. */
const GIT_CHECK_LIMIT_MS = 5_000;
/** The time git gets for work that grows with the repository: making a worktree, staging, committing, comparing, removing. */
const GIT_WORK_LIMIT_MS = 120_000;
const MAX_OUTPUT = 256 * 1024 * 1024;

/** Git did not finish in its time and was stopped. The message is for the owner as it is. */
class GitTimeout extends Error {}
/** A git that was stopped for taking too long is reported as that, never as a repository that is wrong in some other way. */
const unlessTimeout = (err: unknown): void => {
  if (err instanceof GitTimeout) throw err;
};

/** Whether `p` is on a drive macOS mounts under /Volumes: by its real location, or through a link on the way that points there. */
function onMountedVolume(p: string): boolean {
  const mounted = (q: string): boolean => q.startsWith("/Volumes/");
  if (mounted(realPath(p))) return true;
  // The real location cannot be read when the drive itself is closed to this process; a link's own target still can.
  for (let at = path.resolve(p); at !== path.dirname(at); at = path.dirname(at)) {
    try {
      if (mounted(path.resolve(path.dirname(at), fs.readlinkSync(at)))) return true;
    } catch {
      // Not a link.
    }
  }
  return false;
}

function timeoutWords(dir: string, limitMs: number): string {
  const base = `The folder ${dir} could not be read in time: git did not answer within ${limitMs / 1000} seconds and was stopped.`;
  if (process.platform !== "darwin" || !onMountedVolume(dir)) return base;
  return `${base} The folder is on a drive under /Volumes, and macOS may be blocking a background service from reading an external drive. Allow access for the program that runs Botbench in System Settings → Privacy & Security → Files and Folders, or use a repository on the internal disk.`;
}

/**
 * Run git in `dir` with an argument array (no shell) and return what it printed. Git runs in its own process group and
 * gets `limitMs` to finish; after that the whole group is killed, so neither it nor a program it started is left running.
 * `env` adds variables of Botbench's own choosing, such as GIT_INDEX_FILE, to the cleaned environment.
 */
function git(dir: string, args: string[], limitMs = GIT_WORK_LIMIT_MS, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...SAFE, ...args], { env: { ...gitEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let stopped: Error | null = null;
    const stop = (why: Error): void => {
      if (stopped) return;
      stopped = why;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => stop(new GitTimeout(timeoutWords(dir, limitMs))), limitMs);
    const collect = (chunk: string, to: "out" | "err"): void => {
      if (to === "out") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT) stop(new GitError(`git ${args[0]} in ${dir} printed more than Botbench reads and was stopped.`, "", null));
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, "out"));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, "err"));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new GitError(`git ${args[0]} could not be started in ${dir}: ${err.message}`, err.message, err));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stopped) reject(stopped);
      else if (code === 0) resolve(stdout);
      else {
        const failed = new GitError(`git ${args[0]} failed in ${dir}: ${stderr.trim() || (signal ? `stopped by ${signal}` : `exit code ${code}`)}`, stderr.trim(), null);
        failed.stdout = stdout;
        reject(failed);
      }
    });
  });
}
const succeeds = (dir: string, args: string[]): Promise<boolean> =>
  git(dir, args, GIT_CHECK_LIMIT_MS).then(() => true, (err: unknown) => {
    unlessTimeout(err);
    return false;
  });

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
export async function sourceHead(repo: string): Promise<string> {
  if (!fs.existsSync(repo)) throw new Error(`Repository path ${repo} does not exist.`);
  if (!isDirectory(repo)) throw new Error(`Repository path ${repo} is not a directory.`);
  let top: string;
  try {
    top = (await git(repo, ["rev-parse", "--show-toplevel"], GIT_CHECK_LIMIT_MS)).trimEnd();
  } catch (err) {
    unlessTimeout(err);
    throw new Error(`${repo} is not a git repository with a working folder (${err instanceof GitError ? err.stderr : String(err)}).`, { cause: err });
  }
  if (realPath(top) !== realPath(repo)) throw new Error(`${repo} is a folder inside the git repository ${top}, not its top level. Give the repository's top level.`);
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_CHECK_LIMIT_MS)).trim();
  } catch (err) {
    unlessTimeout(err);
    throw new Error(`The git repository ${repo} has no commits yet. Make a first commit, then try again.`, { cause: err });
  }
}

/**
 * Create a worktree for one task at `<home>/worktrees/<run>/<task>`, on a new branch `botbench/<workbench>/<run>/<task>`
 * that starts at `commit` (a run's base commit), or at the commit the repository's HEAD points at when none is given.
 * Without a workbench the branch has the form made before workbenches had names, `botbench/<run>/<task>`: only tests of
 * such older tasks leave it out. Nothing in the repository's own working folder, index or current branch is written.
 */
export async function createWorktree(o: { repo: string; home: string; run: string; task: string; commit?: string; workbench?: string }): Promise<Worktree> {
  if (o.workbench !== undefined && workbenchProblem(o.workbench) !== null) throw new Error(`Invalid workbench name ${JSON.stringify(o.workbench)}: ${workbenchProblem(o.workbench)}`);
  if (!SLUG.test(o.run)) throw new Error(`Invalid run id ${JSON.stringify(o.run)}: use 1 to 64 letters, digits, "-" or "_", starting with a letter or digit.`);
  if (!SLUG.test(o.task)) throw new Error(`Invalid task id ${JSON.stringify(o.task)}: use 1 to 64 letters, digits, "-" or "_", starting with a letter or digit.`);
  if (o.commit !== undefined) checkBase(o.commit);
  const repo = path.resolve(o.repo);
  const head = await sourceHead(repo);
  let baseCommit = head;
  if (o.commit !== undefined && o.commit !== head) {
    // The commit must still be one of the repository's: a run's base commit that was since removed builds nothing.
    const found = await git(repo, ["rev-parse", "--verify", "--quiet", `${o.commit}^{commit}`], GIT_CHECK_LIMIT_MS).catch((err: unknown) => {
      unlessTimeout(err);
      throw new Error(`The commit ${o.commit} the run was planned from is no longer in the repository ${repo}.`, { cause: err });
    });
    baseCommit = found.trim();
  }
  const runDir = path.join(path.resolve(o.home), "worktrees", o.run);
  const dir = path.join(runDir, o.task);
  if (isInside(realPath(dir), realPath(repo))) throw new Error(`The folder for the task's copy, ${dir}, would be inside the repository ${repo}. Botbench's home must be somewhere else.`);
  if (fs.existsSync(dir)) throw new Error(`The folder for the task's copy, ${dir}, already exists.`);

  // A name already in use, by an earlier run or anything else, is left alone: the new branch gets the next free name.
  const wanted = `${BRANCH_PREFIX}${o.workbench === undefined ? "" : `${o.workbench}/`}${o.run}/${o.task}`;
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
 * The shared git folder of the source repository `repo`, by its real path: what an agent's commands in one of its copies
 * may read and not write (U27). Asked of the repository the task was started on, never of the copy, whose `.git` file an
 * agent can rewrite.
 */
export async function sharedGitDir(repo: string): Promise<string> {
  const found = (await git(path.resolve(repo), ["rev-parse", "--path-format=absolute", "--git-common-dir"], GIT_CHECK_LIMIT_MS)).trim();
  if (found === "") throw new Error(`git did not say where the shared git folder of ${repo} is.`);
  return realPath(found);
}

/**
 * Check `dir` is the top of a linked worktree on a Botbench task branch, and return that branch and the repository's shared git folder.
 * The owner's own checkout is never one, so nothing here can commit in it or remove it.
 */
async function taskWorktree(dir: string): Promise<{ branch: string; commonDir: string }> {
  const notOurs = (why: string, cause?: unknown): Error => new Error(`${dir} is not a copy Botbench made (a git worktree): ${why}.`, { cause });
  if (!isDirectory(dir)) throw notOurs("no such folder");
  let lines: string[];
  try {
    lines = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], GIT_CHECK_LIMIT_MS)).trimEnd().split("\n");
  } catch (err) {
    unlessTimeout(err);
    throw notOurs("it is not in a git repository", err);
  }
  const [gitDir, commonDir, top] = lines;
  if (!gitDir || !commonDir || !top) throw notOurs("git did not describe it");
  if (realPath(gitDir) === realPath(commonDir)) throw notOurs("it is a repository's main checkout");
  if (realPath(top) !== realPath(dir)) throw notOurs("it is a folder inside a copy, not the copy itself");
  // What a task wrote in its worktree is not trusted. A git folder that lives inside the worktree, or one that is not
  // the repository's own entry for a linked worktree, could carry a config whose filters are commands; git would run them.
  if (isInside(realPath(commonDir), realPath(dir)) || isInside(realPath(gitDir), realPath(dir))) throw notOurs("its git folder is inside the copy itself");
  if (path.dirname(realPath(gitDir)) !== path.join(realPath(commonDir), "worktrees")) throw notOurs("its git folder is not one of the repository's git worktree entries");
  let branch: string;
  try {
    branch = (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_CHECK_LIMIT_MS)).trim();
  } catch (err) {
    unlessTimeout(err);
    throw new Error(`The copy at ${dir} is not on a branch, so it is not on its Botbench task branch.`, { cause: err });
  }
  if (!isTaskBranch(branch)) throw new Error(`The copy at ${dir} is on branch ${branch}, not on its Botbench task branch.`);
  return { branch, commonDir: realPath(commonDir) };
}

/**
 * Stage everything in the worktree (changed, deleted and new files, except ignored ones) and commit it to the task branch
 * as Botbench. The owner's git identity is neither read nor needed, and no hook runs.
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

/** What changed from `base` to `head`, file by file, ordered by path, as git in `dir` reads it. */
async function changes(dir: string, base: string, head: string): Promise<FileChange[]> {
  const [names, counts] = await Promise.all([
    git(dir, [...DIFF, "--name-status", "-z", base, head]),
    git(dir, [...DIFF, "--numstat", "-z", base, head]),
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
  return files;
}

/** The task's branch, where it started, where it is now, and what changed in between, file by file. */
export async function describeWork(o: { path: string; baseCommit: string }): Promise<Work> {
  checkBase(o.baseCommit);
  const dir = path.resolve(o.path);
  const { branch } = await taskWorktree(dir);
  const headCommit = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { branch, baseCommit: o.baseCommit, headCommit, files: await changes(dir, o.baseCommit, headCommit) };
}

/**
 * What a decided task's work changed, read from the repository itself once its copy is gone: from its base commit to
 * the commit Botbench made, which the kept branch holds. Only those two commits are read; nothing is written.
 */
export async function describeCommits(o: { repo: string; baseCommit: string; headCommit: string }): Promise<FileChange[]> {
  checkBase(o.baseCommit);
  checkBase(o.headCommit);
  return changes(path.resolve(o.repo), o.baseCommit, o.headCommit);
}

/** One file's unified diff between two commits, read from the repository itself: for a decided task whose branch was kept. */
export async function commitsFileDiff(o: { repo: string; baseCommit: string; headCommit: string; file: string }): Promise<string> {
  checkBase(o.baseCommit);
  checkBase(o.headCommit);
  if (o.file === "" || o.file.includes("\0")) throw new Error(`Invalid file name ${JSON.stringify(o.file)}.`);
  return git(path.resolve(o.repo), [...DIFF, "--full-index", "--src-prefix=a/", "--dst-prefix=b/", o.baseCommit, o.headCommit, "--", o.file]);
}

/** The whole unified diff of a task's work, from the base commit to the commit Botbench made; empty when nothing changed. */
export async function commitsDiff(o: { path: string; baseCommit: string; headCommit: string }): Promise<string> {
  checkBase(o.baseCommit);
  checkBase(o.headCommit);
  return git(path.resolve(o.path), [...DIFF, "--src-prefix=a/", "--dst-prefix=b/", o.baseCommit, o.headCommit]);
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
 * The files in a task's worktree that are not on its branch: changed or deleted tracked files, and untracked files.
 * Files git ignores are not among them. Paths are relative to the worktree, in git's order.
 */
export async function leftoverFiles(dir: string): Promise<string[]> {
  const top = path.resolve(dir);
  await taskWorktree(top);
  const out = await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  return out.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
}

/**
 * Remove a task's worktree. Refused while it has uncommitted changes, so work is never lost, unless `removeLeftovers`
 * says the owner saw them and agreed they may go. Ignored files go with the folder either way. The branch, and so the
 * committed work, stays unless `deleteBranch` is true.
 */
export async function removeWorktree(o: { repo: string; path: string; deleteBranch: boolean; removeLeftovers?: boolean }): Promise<void> {
  const repo = path.resolve(o.repo);
  const dir = path.resolve(o.path);
  const { branch, commonDir } = await taskWorktree(dir);
  let repoCommon: string;
  try {
    repoCommon = realPath((await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], GIT_CHECK_LIMIT_MS)).trimEnd());
  } catch (err) {
    unlessTimeout(err);
    throw new Error(`${repo} is not a git repository.`, { cause: err });
  }
  if (repoCommon !== commonDir) throw new Error(`The copy at ${dir} does not belong to the repository ${repo}.`);
  const uncommitted = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (uncommitted !== "" && o.removeLeftovers !== true) throw new Error(`The copy at ${dir} has uncommitted changes, so it was not removed. Commit the work first.`);

  // Without --force, git itself also refuses if anything changed since the check above.
  await git(repo, ["worktree", "remove", ...(o.removeLeftovers === true ? ["--force"] : []), dir]);
  await git(repo, ["worktree", "prune"]);
  if (o.deleteBranch) await git(repo, ["branch", "--quiet", "-D", branch]);
  removeIfEmpty(path.dirname(dir));
}

/**
 * Forget one task worktree of `repo` whose folder is already gone: git's record of that path only. Other worktrees whose
 * folders are missing for now (on a drive that is not mounted) keep theirs, so nothing repository-wide is pruned.
 */
export async function forgetMissingWorktree(o: { repo: string; path: string }): Promise<void> {
  const dir = path.resolve(o.path);
  if (fs.existsSync(dir)) throw new Error(`The copy at ${dir} is still there, so it was not forgotten.`);
  const listed = (await git(path.resolve(o.repo), ["worktree", "list", "--porcelain", "-z"], GIT_CHECK_LIMIT_MS)).split("\0").some((line) => line === `worktree ${dir}` || line === `worktree ${realPath(dir)}`);
  if (listed) await git(path.resolve(o.repo), ["worktree", "remove", "--force", dir]);
}

/** The folders of `repo`'s checkout and worktrees that have `branch` checked out. */
export async function branchCheckedOutAt(repo: string, branch: string): Promise<string[]> {
  const fields = (await git(path.resolve(repo), ["worktree", "list", "--porcelain", "-z"], GIT_CHECK_LIMIT_MS)).split("\0");
  const at: string[] = [];
  let current = "";
  for (const field of fields) {
    if (field.startsWith("worktree ")) current = field.slice("worktree ".length);
    else if (field === `branch refs/heads/${branch}`) at.push(current);
  }
  return at;
}

/** A branch in one of the task branch forms, and nothing else (src/workbench.ts). */
const isTaskBranch = (branch: string): boolean => parseTaskBranch(branch) !== null;

/** The Botbench task branches `repo` has now, read in one step: a list asks once per repository, not once per row. */
export async function taskBranches(repo: string): Promise<Set<string>> {
  const refs = (await git(path.resolve(repo), ["for-each-ref", "--format=%(refname)", "refs/heads/"], GIT_CHECK_LIMIT_MS)).split("\n");
  return new Set(refs.map((ref) => ref.slice("refs/heads/".length)).filter((name) => name !== "" && isTaskBranch(name)));
}

/** The commit a Botbench task branch points at, or null when the branch is not there. */
export async function branchCommit(repo: string, branch: string): Promise<string | null> {
  if (!isTaskBranch(branch)) throw new Error(`${branch} is not a Botbench task branch.`);
  const dir = path.resolve(repo);
  if (!(await succeeds(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))) return null;
  return (await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], GIT_CHECK_LIMIT_MS)).trim();
}

/**
 * Delete a Botbench task branch, and only while it still points at `commit`: git compares and deletes in one step, so
 * work somebody added to it, even a moment ago, is never deleted. A branch checked out anywhere is not deleted. A
 * branch that is already gone is fine.
 */
export async function deleteTaskBranch(o: { repo: string; branch: string; commit: string }): Promise<void> {
  checkBase(o.commit);
  const at = await branchCommit(o.repo, o.branch);
  if (at === null) return;
  if (at !== o.commit) throw new Error(`The branch ${o.branch} has commits Botbench did not make, so it was not deleted.`);
  const out = await branchCheckedOutAt(o.repo, o.branch);
  if (out.length > 0) throw new Error(`The branch ${o.branch} is checked out at ${out.join(", ")}, so it was not deleted.`);
  await git(path.resolve(o.repo), ["update-ref", "-d", `refs/heads/${o.branch}`, o.commit]);
}

/*
 * Pushing an accepted task's branch (delivery). Only a branch with Botbench's own prefix, only the commit recorded for
 * it, only to a ref of the same name, never by force, and never anything else: no tags, no submodules, no other ref.
 */

/** The time git gets to talk to a remote: asking what a branch points at there, or pushing one. */
const GIT_NETWORK_LIMIT_MS = 120_000;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A remote's name as the settings may give it: plain, never one that could read as an option or a path. */
export const remoteNameProblem = (name: unknown): string | null => (typeof name === "string" && REMOTE_NAME.test(name) && !name.includes("..") ? null : "A remote's name is letters, digits, \".\", \"_\" and \"-\", such as \"origin\".");
function checkRemote(name: string): void {
  const problem = remoteNameProblem(name);
  if (problem !== null) throw new Error(`${JSON.stringify(name)} is not a remote name Botbench uses. ${problem}`);
}
/** Only branches Botbench made itself under its current name are ever pushed. */
function checkPushable(branch: string): void {
  if (parseTaskBranch(branch)?.prefix !== "botbench") throw new Error(`${branch} is not a branch Botbench made (its name starts with ${BRANCH_PREFIX}), so it is never pushed.`);
}

/**
 * The address of `remote` in `repo`: as the repository's settings write it (`configured`), and as git uses it to fetch
 * and to push once its rewrite rules are applied (`fetch`, `push`). Null when the repository has no remote of that name. Either may
 * hold credentials the owner wrote into it: never show or store one without taking them out.
 */
export async function remoteAddress(repo: string, remote: string): Promise<{ configured: string; fetch: string; push: string } | null> {
  checkRemote(remote);
  const dir = path.resolve(repo);
  let configured: string;
  try {
    configured = (await git(dir, ["config", "--get", `remote.${remote}.url`], GIT_CHECK_LIMIT_MS)).trim();
  } catch (err) {
    unlessTimeout(err);
    return null;
  }
  if (configured === "") return null;
  const fetch = (await git(dir, ["remote", "get-url", remote], GIT_CHECK_LIMIT_MS)).trim();
  const pushes = (await git(dir, ["remote", "get-url", "--push", "--all", remote], GIT_CHECK_LIMIT_MS)).split("\n").map((line) => line.trim()).filter(Boolean);
  // More than one push address would push to each: shown as one string that cannot equal the fetch address.
  return { configured, fetch, push: pushes.join(" and ") };
}

/** The commit a Botbench task branch points at on `remote`, asked of the remote itself; null when the remote has no such branch. */
export async function remoteBranchCommit(repo: string, remote: string, branch: string): Promise<string | null> {
  checkRemote(remote);
  checkPushable(branch);
  const out = await git(path.resolve(repo), ["ls-remote", "--refs", remote, `refs/heads/${branch}`], GIT_NETWORK_LIMIT_MS);
  const line = out.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return line === undefined ? null : line.split("\t")[0]!;
}

/** The time git gets to list a remote's task branches for the view of other workbenches' work, which never waits long. */
const GIT_LIST_LIMIT_MS = 20_000;

/**
 * The task branches on `remote`, asked of the remote itself, read only:
 * `git ls-remote --heads --refs <remote> refs/heads/botbench/*`. Only names in one of the task branch forms are kept
 * (src/workbench.ts); each is outside text from whoever pushed it, and was checked against that pattern here.
 */
export async function remoteTaskBranches(repo: string, remote: string, limitMs = GIT_LIST_LIMIT_MS): Promise<{ branch: string; commit: string }[]> {
  checkRemote(remote);
  const out = await git(path.resolve(repo), ["ls-remote", "--heads", "--refs", remote, `refs/heads/${BRANCH_PREFIX}*`], limitMs);
  const found: { branch: string; commit: string }[] = [];
  for (const line of out.split("\n")) {
    const [commit, ref] = line.split("\t");
    if (commit === undefined || ref === undefined || !COMMIT_ID.test(commit) || !ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (parseTaskBranch(branch)?.prefix === "botbench") found.push({ branch, commit });
  }
  return found;
}

/** Why a push was refused, in git's own words from its `--porcelain` lines; null when it says nothing of the kind. */
function pushRefusal(stdout: string): string | null {
  const refused = stdout.split("\n").find((line) => line.startsWith("!"));
  return refused === undefined ? null : refused.split("\t").slice(2).join(" ").trim() || "refused";
}

/**
 * Push `commit`, the commit recorded for the Botbench task branch `branch`, to the branch of the same name on `remote`:
 * `git push --porcelain --no-verify --no-follow-tags --recurse-submodules=no --no-signed <remote> <commit>:refs/heads/<branch>`.
 * Never by force: a remote branch with other commits refuses it. The local branch must still point at `commit`.
 */
export async function pushTaskBranch(o: { repo: string; remote: string; branch: string; commit: string }): Promise<void> {
  checkRemote(o.remote);
  checkPushable(o.branch);
  checkBase(o.commit);
  const at = await branchCommit(o.repo, o.branch);
  if (at !== o.commit) throw new Error(at === null ? `The branch ${o.branch} is not in the repository any more, so it was not pushed.` : `The branch ${o.branch} has moved since it was recorded, so it was not pushed.`);
  await pushRef(o.repo, o.branch, ["--no-follow-tags", o.remote, `${o.commit}:refs/heads/${o.branch}`]);
}

/** `git push --porcelain --no-verify --recurse-submodules=no --no-signed <args>`, with a refusal said in the remote's own words. */
async function pushRef(repo: string, branch: string, args: string[]): Promise<void> {
  try {
    await git(path.resolve(repo), ["push", "--porcelain", "--no-verify", "--recurse-submodules=no", "--no-signed", ...args], GIT_NETWORK_LIMIT_MS);
  } catch (err) {
    const refusal = err instanceof GitError ? pushRefusal(err.stdout) : null;
    if (refusal !== null) {
      // What the remote itself said (branch protection, a hook's reason), from its "remote:" lines.
      const said = (err as GitError).stderr.split("\n").filter((line) => line.startsWith("remote:")).map((line) => line.slice("remote:".length).trim()).filter(Boolean).join(" ").slice(0, 600);
      throw new Error(`The remote refused the branch ${branch}: ${refusal}.${said === "" ? "" : ` It said: ${said}`}`, { cause: err });
    }
    throw err;
  }
}

/*
 * Checking a task together with another workbench's pull request (engine/combined.ts). The work is done in a temporary
 * copy of its own under Botbench's data folder, never in the repository:
 * - the copy is a clone of the repository that borrows its objects (`--shared`), so nothing in the repository is written,
 *   not a ref, not an object, not FETCH_HEAD; the clone has no hard link into it either;
 * - the other workbench's head is fetched read only from the remote's address into the copy alone; nothing is pushed;
 * - the merge is made there, on a scratch branch at the task's commit, by Botbench's own identity, with no hook.
 * The scratch branch lives only in the copy, so removing the copy removes it.
 */

/** Where the temporary copies for checking together are made: one folder under the data folder, beside the worktrees. */
export const combinedRoot = (home: string): string => path.join(path.resolve(home), "combined");
const SCRATCH_BRANCH = "botbench-check-together";
const PEER_REF = "refs/botbench/peer";

/** What merging the other workbench's head into the task's commit came to, and the commit that head was. */
export type CombinedMerge = { peerCommit: string; merged: true } | { peerCommit: string; merged: false; conflicts: string[] };

/**
 * Make the temporary copy at `dir`, a new folder under `combinedRoot(home)`: clone `repo` into it, fetch `peerBranch`
 * (another workbench's task branch) from `fetchUrl`, start the scratch branch at `taskCommit` and merge that head into
 * it. Answers the head fetched and whether it merged, with the files in conflict when not. Throws when any step fails
 * for another reason; the caller removes the copy either way (`removeCombinedCopy`).
 */
export async function prepareCombinedCopy(o: { repo: string; home: string; dir: string; fetchUrl: string; peerBranch: string; taskCommit: string }): Promise<CombinedMerge> {
  checkBase(o.taskCommit);
  if (parseTaskBranch(o.peerBranch)?.prefix !== "botbench") throw new Error(`${o.peerBranch} is not a Botbench task branch, so it is not fetched.`);
  const root = combinedRoot(o.home);
  const dir = path.resolve(o.dir);
  if (path.dirname(dir) !== root) throw new Error(`${dir} is not a folder for checking together.`);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists.`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  await git(root, ["clone", "--quiet", "--shared", "--no-checkout", "--", path.resolve(o.repo), dir]);
  // By the address, so the copy has no remote of its own; `--` keeps it from ever being read as an option.
  const peerCommit = await fetchPeerHead(dir, o.fetchUrl, o.peerBranch);
  const identity = ["-c", `user.name=${AUTHOR_NAME}`, "-c", `user.email=${AUTHOR_EMAIL}`, "-c", "commit.gpgsign=false"];
  await git(dir, ["checkout", "--quiet", "--force", "-B", SCRATCH_BRANCH, o.taskCommit]);
  try {
    await git(dir, [...identity, "merge", "--quiet", "--no-ff", "--no-edit", "--no-verify", "-m", `Check together with ${o.peerBranch}`, PEER_REF]);
    return { peerCommit, merged: true };
  } catch (err) {
    unlessTimeout(err);
    const conflicts = (await git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"], GIT_CHECK_LIMIT_MS)).split("\0").filter(Boolean).sort();
    if (conflicts.length === 0) throw err;
    return { peerCommit, merged: false, conflicts };
  }
}

/**
 * Fetch `peerBranch` from `fetchUrl` into `dir`, a temporary copy made for it, as `refs/botbench/peer`, and answer the
 * commit fetched. Only that one branch, from the address of the repository's own remote; never forced (the ref is new
 * in a new copy, so an existing one is never overwritten); no tags, no submodules, no FETCH_HEAD.
 */
async function fetchPeerHead(dir: string, fetchUrl: string, peerBranch: string): Promise<string> {
  await git(dir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", fetchUrl, `refs/heads/${peerBranch}:${PEER_REF}`], GIT_NETWORK_LIMIT_MS);
  const peerCommit = (await git(dir, ["rev-parse", "--verify", "--quiet", `${PEER_REF}^{commit}`], GIT_CHECK_LIMIT_MS)).trim();
  if (!COMMIT_ID.test(peerCommit)) throw new Error(`The head of ${peerBranch} could not be read after it was fetched.`);
  return peerCommit;
}

/**
 * The files another workbench's branch changes, read by git from its commits rather than taken from GitHub's list:
 * in a temporary copy at `dir` (as for `prepareCombinedCopy`, removed by the caller), `peerBranch` is fetched from
 * `fetchUrl`, and the files are those that differ between it and where it parted from `baseCommit` (the task's base),
 * `git diff --name-only <merge-base> <peer head>`. Only paths are read: nothing of the other workbench's commit messages
 * or file contents leaves git. Answers the head fetched with them.
 */
export async function peerChangedFiles(o: { repo: string; home: string; dir: string; fetchUrl: string; peerBranch: string; baseCommit: string }): Promise<{ peerCommit: string; files: string[] }> {
  checkBase(o.baseCommit);
  if (parseTaskBranch(o.peerBranch)?.prefix !== "botbench") throw new Error(`${o.peerBranch} is not a Botbench task branch, so it is not fetched.`);
  const root = combinedRoot(o.home);
  const dir = path.resolve(o.dir);
  if (path.dirname(dir) !== root) throw new Error(`${dir} is not a folder for checking together.`);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists.`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  await git(root, ["clone", "--quiet", "--shared", "--no-checkout", "--", path.resolve(o.repo), dir]);
  const peerCommit = await fetchPeerHead(dir, o.fetchUrl, o.peerBranch);
  const parted = (await git(dir, ["merge-base", "--", o.baseCommit, peerCommit], GIT_CHECK_LIMIT_MS)).trim();
  if (!COMMIT_ID.test(parted)) throw new Error(`${o.peerBranch} shares no history with this task's base.`);
  const files = (await git(dir, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", parted, peerCommit, "--"], GIT_CHECK_LIMIT_MS)).split("\0").filter(Boolean).sort();
  return { peerCommit, files };
}

/** Remove a temporary copy for checking together, and its scratch branch with it. A copy that is already gone is fine. */
export function removeCombinedCopy(home: string, dir: string): void {
  const at = path.resolve(dir);
  if (path.dirname(at) !== combinedRoot(home)) throw new Error(`${at} is not a folder for checking together, so it was not removed.`);
  fs.rmSync(at, { recursive: true, force: true });
}

/** At start: remove every temporary copy a Botbench that stopped while checking together left, by what is on disk. */
export function clearCombinedCopies(home: string): void {
  fs.rmSync(combinedRoot(home), { recursive: true, force: true });
}

/*
 * Claiming an issue (Peers P3, engine/claims.ts): a branch pushed early that holds one commit Botbench makes itself,
 * with no parent and no files, so nothing of the repository's content or of the owner's unpushed commits leaves with it.
 */

/** Make a claim's commit in `repo`: the empty tree, no parent, Botbench as its author, `message` as its message. No ref is written. */
export async function makeClaimCommit(repo: string, message: string): Promise<string> {
  if (message.trim() === "") throw new Error("A commit message is required.");
  const dir = path.resolve(repo);
  const tree = (await git(dir, ["hash-object", "-t", "tree", "-w", "/dev/null"], GIT_CHECK_LIMIT_MS)).trim();
  const commit = (await git(dir, ["-c", `user.name=${AUTHOR_NAME}`, "-c", `user.email=${AUTHOR_EMAIL}`, "commit-tree", "--no-gpg-sign", `-m${message}`, tree], GIT_CHECK_LIMIT_MS)).trim();
  checkBase(commit);
  return commit;
}

/**
 * The message of `commit` when it is a claim commit this repository holds, as `makeClaimCommit` makes one: the empty
 * tree, no parent, Botbench as author. Null for any other commit, or one this repository does not have. Read only.
 */
export async function claimCommitMessage(repo: string, commit: string): Promise<string | null> {
  if (!COMMIT_ID.test(commit)) return null;
  const dir = path.resolve(repo);
  let text: string;
  try {
    text = await git(dir, ["cat-file", "commit", commit], GIT_CHECK_LIMIT_MS);
  } catch (err) {
    unlessTimeout(err);
    return null;
  }
  const empty = (await git(dir, ["hash-object", "-t", "tree", "/dev/null"], GIT_CHECK_LIMIT_MS)).trim();
  const [head = "", ...body] = text.split("\n\n");
  const lines = head.split("\n");
  const ok = lines[0] === `tree ${empty}` && !lines.some((l) => l.startsWith("parent ")) && lines.some((l) => l.startsWith(`author ${AUTHOR_NAME} <${AUTHOR_EMAIL}> `));
  return ok ? body.join("\n\n") : null;
}

/**
 * Push `commit` to a new branch `branch` on `remote`: `git push … <remote> <commit>:refs/heads/<branch>`. Never by
 * force: a branch of that name already there, with any other commit, refuses it. Only a branch in Botbench's own form.
 */
export async function pushNewBranch(o: { repo: string; remote: string; branch: string; commit: string }): Promise<void> {
  checkRemote(o.remote);
  checkPushable(o.branch);
  checkBase(o.commit);
  await pushRef(o.repo, o.branch, ["--no-follow-tags", o.remote, `${o.commit}:refs/heads/${o.branch}`]);
}

/**
 * Create every branch of `branches` on `remote` at `commit`, all or none:
 * `git push --porcelain --atomic … <remote> <commit>:refs/heads/<a> <commit>:refs/heads/<b>`. Never by force. This is
 * a compare-and-set on the remote: for a branch git did not see there, it asks the remote to create it only if it does
 * not exist, and the remote checks that as it takes the push, so of two pushes that race for one name exactly one is
 * taken. A branch already there, at any commit, refuses it, since `commit` (a claim's, with no parent) cannot be a
 * fast-forward of anything; with `--atomic`, that refusal leaves the others uncreated too. Only branches in
 * Botbench's own form.
 */
export async function pushNewBranches(o: { repo: string; remote: string; branches: readonly string[]; commit: string }): Promise<void> {
  checkRemote(o.remote);
  if (o.branches.length === 0) throw new Error("No branch to push.");
  for (const branch of o.branches) checkPushable(branch);
  checkBase(o.commit);
  await pushRef(o.repo, o.branches.join(" and "), ["--atomic", "--no-follow-tags", o.remote, ...o.branches.map((b) => `${o.commit}:refs/heads/${b}`)]);
}

/**
 * Delete every branch of `branches` on `remote`, all or none, and only while each still points at `commit`: one
 * `--force-with-lease=refs/heads/<branch>:<commit>` for each (see `deleteRemoteBranchAt`) and `--atomic`.
 */
export async function deleteRemoteBranchesAt(o: { repo: string; remote: string; branches: readonly string[]; commit: string }): Promise<void> {
  checkRemote(o.remote);
  if (o.branches.length === 0) throw new Error("No branch to delete.");
  for (const branch of o.branches) checkPushable(branch);
  checkBase(o.commit);
  await pushRef(o.repo, o.branches.join(" and "), ["--atomic", ...o.branches.map((b) => `--force-with-lease=refs/heads/${b}:${o.commit}`), o.remote, ...o.branches.map((b) => `:refs/heads/${b}`)]);
}

/**
 * Create the branch `create` on `remote` at `commit` and delete each branch of `remove` there, all or none, and the
 * deletes only while each still points at `commit`: `git push --atomic --force-with-lease=refs/heads/<old>:<commit> …
 * <remote> <commit>:refs/heads/<new> :refs/heads/<old> …`. Never by force: a lease names one branch to delete and forces
 * nothing (see `deleteRemoteBranchAt`), and the new branch is pushed under git's usual rule, so a branch of that name
 * already there refuses all of it. Only branches in Botbench's own form.
 */
export async function replaceRemoteBranchesAt(o: { repo: string; remote: string; create: string; remove: readonly string[]; commit: string }): Promise<void> {
  checkRemote(o.remote);
  for (const branch of [o.create, ...o.remove]) checkPushable(branch);
  checkBase(o.commit);
  await pushRef(o.repo, o.create, ["--atomic", "--no-follow-tags", ...o.remove.map((b) => `--force-with-lease=refs/heads/${b}:${o.commit}`), o.remote, `${o.commit}:refs/heads/${o.create}`, ...o.remove.map((b) => `:refs/heads/${b}`)]);
}

/**
 * Delete the branch `branch` on `remote`, and only while it still points at `commit`. A delete needs no force; the
 * `--force-with-lease=<ref>:<commit>` here forces nothing: it is git's compare-and-delete, which makes git refuse unless
 * the remote branch is at exactly `commit` when the remote takes the request, so a branch somebody moved, even a moment
 * ago, is never deleted. Only a branch in Botbench's own form.
 */
export async function deleteRemoteBranchAt(o: { repo: string; remote: string; branch: string; commit: string }): Promise<void> {
  checkRemote(o.remote);
  checkPushable(o.branch);
  checkBase(o.commit);
  await pushRef(o.repo, o.branch, [`--force-with-lease=refs/heads/${o.branch}:${o.commit}`, o.remote, `:refs/heads/${o.branch}`]);
}

/**
 * Point git's links between `repo` and its task worktrees at where the worktrees are now, after the data folder that
 * holds them was moved: the repository's record of each worktree, and each worktree's own `.git` file. Nothing else in
 * the repository is written.
 */
export async function repairWorktrees(repo: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await git(path.resolve(repo), ["worktree", "repair", ...paths.map((p) => path.resolve(p))]);
}

/** Where a run's planner works: one folder per run under the Botbench home, beside where that run's task worktrees go. */
export const planningDir = (home: string, run: string): string => path.join(path.resolve(home), "worktrees", run, "planner");

/**
 * Create the worktree a run's planner reads in, at `<home>/worktrees/<run>/planner`: a detached checkout of `commit`,
 * on no branch, so nothing a planner did could ever be on one. Nothing in the repository's own working folder, index
 * or current branch is written. A folder left there by a Botbench that stopped while planning is removed first.
 */
export async function createPlanningWorktree(o: { repo: string; home: string; run: string; commit: string }): Promise<string> {
  if (!SLUG.test(o.run)) throw new Error(`Invalid run id ${JSON.stringify(o.run)}: use 1 to 64 letters, digits, "-" or "_", starting with a letter or digit.`);
  if (!COMMIT_ID.test(o.commit)) throw new Error(`${JSON.stringify(o.commit)} is not a commit id.`);
  const repo = path.resolve(o.repo);
  await sourceHead(repo);
  const dir = planningDir(o.home, o.run);
  if (isInside(realPath(dir), realPath(repo))) throw new Error(`The planning folder ${dir} would be inside the repository ${repo}. Botbench's home must be somewhere else.`);
  await removePlanningWorktree({ repo, home: o.home, run: o.run });
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    await git(repo, ["worktree", "add", "--quiet", "--detach", dir, o.commit]);
  } catch (err) {
    removeIfEmpty(path.dirname(dir));
    throw err;
  }
  return dir;
}

/**
 * Remove a run's planning worktree, whatever is in it: a planner's worktree holds no work to keep. Only the folder
 * Botbench itself names for that run under its home is ever removed, so this cannot reach the owner's checkout.
 * A folder that is not there is fine; git's own record of it is pruned either way.
 */
export async function removePlanningWorktree(o: { repo: string; home: string; run: string }): Promise<void> {
  if (!SLUG.test(o.run)) throw new Error(`Invalid run id ${JSON.stringify(o.run)}.`);
  const repo = path.resolve(o.repo);
  const dir = planningDir(o.home, o.run);
  if (isInside(realPath(dir), realPath(repo))) throw new Error(`The planning folder ${dir} is inside the repository ${repo}; it was not removed.`);
  if (fs.existsSync(dir)) {
    // Git removes its own record with the folder. If the folder is not a worktree git knows, it is removed as a folder.
    await git(repo, ["worktree", "remove", "--force", dir]).catch((err: unknown) => unlessTimeout(err));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await git(repo, ["worktree", "prune"]).catch((err: unknown) => unlessTimeout(err));
  removeIfEmpty(path.dirname(dir));
}

/*
 * Lesson branches (engine/learnings.ts). A rejected task's learning is committed on a branch of its own,
 * `botbench-lesson/<workbench>/task-<id>` (src/workbench.ts), with git's plumbing alone: a temporary index named by
 * GIT_INDEX_FILE, hash-object, update-index, write-tree, commit-tree and update-ref. Nothing is checked out, no
 * worktree is made, and the repository's own index, working folder and current branch are never read from or written
 * to. Nothing is pushed or merged: the owner reviews the branch and merges it like any change.
 */

/** File modes a learning may be: a plain file, or one marked as a program. A link (120000) or a submodule is not a file. */
export const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
/** A path a lesson commit may write: folders and a file name of letters, digits, ".", "_" and "-", never "." or "..". */
const LESSON_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** One entry of a folder in a commit's tree. */
export interface TreeEntry {
  /** Its name in the folder. */
  name: string;
  mode: string;
  type: string;
  oid: string;
  /** Bytes, for a file; null for anything else. */
  size: number | null;
}

/** The commit a lesson branch points at, or null when the branch is not there. */
export async function lessonBranchCommit(repo: string, branch: string): Promise<string | null> {
  if (!isLessonBranch(branch)) throw new Error(`${branch} is not a Botbench lesson branch.`);
  const dir = path.resolve(repo);
  if (!(await succeeds(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))) return null;
  return (await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], GIT_CHECK_LIMIT_MS)).trim();
}

/** The entries `git ls-tree -z -l` prints for `pathspec` in `commit`, with their paths in full. */
async function lsTree(repo: string, commit: string, pathspec: string): Promise<(TreeEntry & { path: string })[]> {
  const out = await git(path.resolve(repo), ["ls-tree", "-z", "-l", "--full-tree", commit, "--", pathspec]);
  const entries: (TreeEntry & { path: string })[] = [];
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", type = "", oid = "", size = "-"] = record.slice(0, tab).split(/ +/);
    const at = record.slice(tab + 1);
    entries.push({ path: at, name: at.slice(at.lastIndexOf("/") + 1), mode, type, oid, size: type === "blob" && /^\d+$/.test(size) ? Number(size) : null });
  }
  return entries;
}

/**
 * The entries of the folder `folder` (such as "docs/solutions") in `commit`'s tree, read from git's objects alone.
 * Empty when the folder is not there. Throws when a part of its path is there and is not a folder: a file or a link.
 */
export async function treeFolder(repo: string, commit: string, folder: string): Promise<TreeEntry[]> {
  checkBase(commit);
  if (!LESSON_PATH.test(folder)) throw new Error(`Invalid folder ${JSON.stringify(folder)}.`);
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const at = parts.slice(0, i).join("/");
    const [entry] = await lsTree(repo, commit, at);
    if (entry === undefined) return [];
    if (entry.type !== "tree") throw new Error(`${at} in the commit ${commit} is not a folder (it is a file or a link), so no note is kept there.`);
  }
  return (await lsTree(repo, commit, `${folder}/`)).map(({ path: _, ...entry }) => entry);
}

/** The bytes of the file object `oid`, as text, read from git's objects alone. */
export async function readBlob(repo: string, oid: string): Promise<string> {
  if (!COMMIT_ID.test(oid)) throw new Error(`${JSON.stringify(oid)} is not an object id.`);
  return git(path.resolve(repo), ["cat-file", "blob", oid]);
}

/**
 * Commit `text` as the file `file` (mode `mode`) on the lesson branch `branch`: one commit whose parent is `parent`,
 * holding `parent`'s tree with that one file added or replaced. The branch is moved to it only while it still points
 * at `expected` (null: only while it is not there), so a commit made on it meanwhile is never lost. A branch checked out
 * anywhere is not moved. The temporary index and the file's text are written to a folder of their own under the
 * system's temporary folder, removed whether the commit is made or not. Returns the new commit.
 */
export async function commitLessonFile(o: { repo: string; branch: string; parent: string; expected: string | null; file: string; mode: string; text: string; message: string }): Promise<string> {
  if (!isLessonBranch(o.branch)) throw new Error(`${o.branch} is not a Botbench lesson branch, so nothing is committed on it.`);
  checkBase(o.parent);
  if (o.expected !== null) checkBase(o.expected);
  if (!LESSON_PATH.test(o.file) || o.file.split("/").some((part) => part === "." || part === "..")) throw new Error(`Invalid file name ${JSON.stringify(o.file)}.`);
  if (!FILE_MODES.has(o.mode)) throw new Error(`Invalid file mode ${JSON.stringify(o.mode)}.`);
  if (o.message.trim() === "") throw new Error("A commit message is required.");
  const repo = path.resolve(o.repo);
  const out = await branchCheckedOutAt(repo, o.branch);
  if (out.length > 0) throw new Error(`The branch ${o.branch} is checked out at ${out.join(", ")}, so Botbench did not add to it. Switch that folder to another branch, then reject again.`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-lesson-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
    const blob = path.join(temporary, "file");
    fs.writeFileSync(blob, o.text, { flag: "wx", mode: 0o600 });
    await git(repo, ["read-tree", o.parent], GIT_WORK_LIMIT_MS, env);
    // No filter the repository names runs: the text is stored as it is.
    const oid = (await git(repo, ["hash-object", "-w", "--no-filters", "--", blob])).trim();
    await git(repo, ["update-index", "--add", "--cacheinfo", `${o.mode},${oid},${o.file}`], GIT_WORK_LIMIT_MS, env);
    const tree = (await git(repo, ["write-tree"], GIT_WORK_LIMIT_MS, env)).trim();
    const commit = (await git(repo, ["-c", `user.name=${AUTHOR_NAME}`, "-c", `user.email=${AUTHOR_EMAIL}`, "commit-tree", "--no-gpg-sign", "-p", o.parent, "-m", o.message, tree])).trim();
    await git(repo, ["update-ref", "-m", "Botbench: keep a lesson", `refs/heads/${o.branch}`, commit, o.expected ?? ""]);
    return commit;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
