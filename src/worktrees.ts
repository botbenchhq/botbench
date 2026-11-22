import { spawn } from "node:child_process";
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

const BRANCH_PREFIX = "botbench/";
/** Task branches made before the product was renamed from Smelt; their tasks still work, and no new branch gets this prefix. */
const OLD_BRANCH_PREFIX = "smelt/";
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

/**
 * The caller's environment without any GIT_* variable, so nothing inherited can point git at another repository, index
 * or config. Botbench's own git calls run with it, and so do the setup commands Botbench runs in a worktree.
 */
export function gitEnv(): NodeJS.ProcessEnv {
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
 */
function git(dir: string, args: string[], limitMs = GIT_WORK_LIMIT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...SAFE, ...args], { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
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
      else reject(new GitError(`git ${args[0]} failed in ${dir}: ${stderr.trim() || (signal ? `stopped by ${signal}` : `exit code ${code}`)}`, stderr.trim(), null));
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
 * Create a worktree for one task at `<home>/worktrees/<run>/<task>`, on a new branch `botbench/<run>/<task>` that starts at
 * `commit` (a run's base commit), or at the commit the repository's HEAD points at when none is given. Nothing in the
 * repository's own working folder, index or current branch is written.
 */
export async function createWorktree(o: { repo: string; home: string; run: string; task: string; commit?: string }): Promise<Worktree> {
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
  if (!branch.startsWith(BRANCH_PREFIX) && !branch.startsWith(OLD_BRANCH_PREFIX)) throw new Error(`The copy at ${dir} is on branch ${branch}, not on its Botbench task branch.`);
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

const isTaskBranch = (branch: string): boolean => (branch.startsWith(BRANCH_PREFIX) || branch.startsWith(OLD_BRANCH_PREFIX)) && !branch.includes("..") && !/[\s~^:?*[\\]/.test(branch);

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
