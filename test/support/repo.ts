import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// Real temporary git repositories for the task tests, made with the real git.

// The tests' own git calls must not be steered by the caller's shell.
const CLEAN_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

/** Run the real git in `dir`. Optional locks are off so that looking at a repository never rewrites its index. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { env: { ...CLEAN_ENV, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

// Every temporary folder a test makes is removed when its test file ends, whatever happened in it. A test's own
// `t.after` hooks run first in, first out, so a fixture that removes its folder in the hook it adds first removes it
// before the server or engine added after it has closed, and that closing can write into the folder again (a
// `home/worktrees` made anew); and a test whose setup throws before it adds its hook leaves the folder with nothing to
// remove it. The file's own `after` hook runs after every test and every one of their hooks, so it catches both.
// node's test runner starts each test file with NODE_TEST_CONTEXT set (or runs it in-process under --test); outside
// it, as in a capture script or a Playwright worker, nothing is registered and the caller removes what it makes.
const UNDER_TEST_RUNNER = process.env.NODE_TEST_CONTEXT !== undefined || process.execArgv.includes("--test");
const madeHere = new Set<string>();
if (UNDER_TEST_RUNNER) {
  // Registered as this module loads, so on the file's root: registered from inside a test, it would run when that test ends.
  after(() => {
    for (const dir of madeHere) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
}

/** Have `dir`, a temporary folder a test made, removed when the test file ends (see above). Returns `dir`. */
export function removedAtEnd(dir: string): string {
  if (UNDER_TEST_RUNNER) madeHere.add(dir);
  return dir;
}

/** A temporary directory by its real path, which is what git and Claude Code report. Removed when the test file ends at the latest. */
export function tempDir(prefix: string): string {
  return removedAtEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

/** Commit everything in `dir` as the owner, whose identity is given here so nothing is needed from this machine's config. */
export function ownerCommit(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

/** A repository at `dir` on branch `main` with one commit holding `files`. Returns that commit. */
export function initRepo(dir: string, files: Record<string, string> = { "README.md": "# Sample\n" }): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  return ownerCommit(dir, "first commit");
}

/** What the owner would see in their checkout: the branch, the commit, every changed and untracked file, and the branches that exist. */
export function checkoutState(repo: string): { branch: string; head: string; status: string } {
  return { branch: git(repo, "symbolic-ref", "--short", "HEAD").trim(), head: git(repo, "rev-parse", "HEAD").trim(), status: git(repo, "status", "--porcelain", "--untracked-files=all") };
}

export const worktreeCount = (repo: string): number => git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
export const botbenchBranches = (repo: string): string[] => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/botbench/").split("\n").filter(Boolean);

/**
 * A real repository with one commit in which the real git stalls: its `.git/config` is a named pipe nobody writes to,
 * so git waits on opening it for as long as it is left to, as it does on a folder macOS will not let a service read.
 */
export function stalledRepo(dir: string): void {
  initRepo(dir);
  fs.rmSync(path.join(dir, ".git", "config"));
  execFileSync("mkfifo", [path.join(dir, ".git", "config")]);
}

/** The git processes running for the repository at `dir`, as `ps` lists them. */
export function gitProcesses(dir: string): string[] {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => /\bgit\b/.test(line) && line.includes(dir));
}

/** Let every git process waiting in a stalled repository go on and end: each is given the end of its config. Returns how many were waiting. */
export function releaseStalled(dir: string): number {
  const pipe = path.join(dir, ".git", "config");
  let released = 0;
  for (let quiet = 0; quiet < 3; ) {
    try {
      // Opening for writing succeeds only while a process is waiting to read.
      fs.closeSync(fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      released++;
      quiet = 0;
    } catch {
      quiet++;
    }
    execFileSync("sleep", ["0.1"]);
  }
  return released;
}
