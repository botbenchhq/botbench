import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** A temporary directory by its real path, which is what git and Claude Code report. */
export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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
export const smeltBranches = (repo: string): string[] => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/smelt/").split("\n").filter(Boolean);
