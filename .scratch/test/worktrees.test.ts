import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commitWork, createWorktree, describeWork, fileDiff, removeWorktree, sourceHead } from "../src/worktrees.ts";
import { gitProcesses, releaseStalled, stalledRepo } from "./support/repo.ts";
import { NO_PROCESS_LIST } from "./support/confined.ts";

// The tests' own git calls must not be steered by variables a test sets on purpose, or by the caller's shell.
const CLEAN_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

/** Run the real git in `dir`. Optional locks are off so that looking at a repository never rewrites its index. */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    env: { ...CLEAN_ENV, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
/** A commit made by the owner, with the owner's identity given here so the tests need nothing from this machine's config. */
const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"];
const ownerCommit = (dir: string, message: string, ...more: string[]): string => {
  git(dir, ...OWNER, "commit", "--quiet", "-m", message, ...more);
  return git(dir, "rev-parse", "HEAD").trim();
};
const write = (dir: string, file: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), "utf8");
const worktreeCount = (repo: string): number => git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
const head = (dir: string, ref = "HEAD"): string => git(dir, "rev-parse", ref).trim();

interface Scratch {
  dir: string;
  repo: string;
  home: string;
}
type T = { after(fn: () => void): void };

/** A temporary directory holding a real repository path and a Botbench home. Every test must leave the repository with no extra worktree. */
function scratch(t: T, init = true): Scratch {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "botbench-wt-test-"));
  const repo = path.join(dir, "source");
  const home = path.join(dir, "home");
  fs.mkdirSync(repo);
  if (init) git(repo, "init", "--quiet", "-b", "main");
  t.after(() => {
    try {
      if (fs.existsSync(path.join(repo, ".git"))) {
        assert.equal(worktreeCount(repo), 1, `leftover worktrees:\n${git(repo, "worktree", "list")}`);
        assert.deepEqual(fs.readdirSync(path.join(repo, ".git")).filter((n) => n === "worktrees").flatMap((n) => fs.readdirSync(path.join(repo, ".git", n))), []);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, repo, home };
}

/** A repository with one commit on `main`. */
function sourceRepo(t: T): Scratch & { base: string } {
  const s = scratch(t);
  write(s.repo, "README.md", "# Sample\n");
  write(s.repo, "src/app.txt", "one\ntwo\nthree\n");
  write(s.repo, "old.txt", "going\naway\n");
  write(s.repo, ".gitignore", "*.log\nignored/\n");
  git(s.repo, "add", "-A");
  const base = ownerCommit(s.repo, "first commit");
  return { ...s, base };
}

/** Everything about the owner's checkout that Botbench must leave alone. */
function ownerState(repo: string, files: string[]): Record<string, string> {
  const state: Record<string, string> = {
    status: git(repo, "status", "--porcelain", "--untracked-files=all"),
    stash: git(repo, "stash", "list"),
    headCommit: head(repo),
    index: fs.readFileSync(path.join(repo, ".git", "index")).toString("hex"),
    config: fs.readFileSync(path.join(repo, ".git", "config"), "utf8"),
  };
  try {
    state.branch = git(repo, "symbolic-ref", "HEAD");
  } catch {
    state.branch = "(detached)";
  }
  for (const f of files) state[`file:${f}`] = fs.existsSync(path.join(repo, f)) ? read(repo, f) : "(absent)";
  return state;
}

test("AE2: creating a worktree, committing in it and removing it leaves the owner's dirty checkout exactly as it was", async (t) => {
  const { repo, home, base } = sourceRepo(t);
  // A stash, then a modified tracked file, a staged new file and an untracked file, on a checked-out branch.
  write(repo, "README.md", "# Stashed edit\n");
  git(repo, ...OWNER, "stash", "push", "--quiet", "-m", "owner stash");
  write(repo, "src/app.txt", "one\ntwo\nthree\nowner edit\n");
  write(repo, "staged.txt", "staged by owner\n");
  git(repo, "add", "staged.txt");
  write(repo, "notes.txt", "untracked\n");
  const files = ["README.md", "src/app.txt", "staged.txt", "notes.txt", "old.txt"];
  const before = ownerState(repo, files);
  assert.equal(before.status, " M src/app.txt\nA  staged.txt\n?? notes.txt\n");
  assert.equal(before.branch, "refs/heads/main\n");
  assert.match(before.stash!, /owner stash/);

  const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });
  assert.equal(wt.path, path.join(home, "worktrees", "run1", "task1"));
  assert.equal(wt.branch, "botbench/run1/task1");
  assert.equal(wt.baseCommit, base);
  assert.deepEqual(ownerState(repo, files), before, "after create");
  // The worktree starts from the commit, without the owner's uncommitted changes.
  assert.equal(read(wt.path, "src/app.txt"), "one\ntwo\nthree\n");
  assert.equal(fs.existsSync(path.join(wt.path, "staged.txt")), false);
  assert.equal(fs.existsSync(path.join(wt.path, "notes.txt")), false);

  write(wt.path, "src/app.txt", "agent edit\n");
  write(wt.path, "staged.txt", "agent's own file with the same name\n");
  const done = await commitWork({ path: wt.path, message: "task work" });
  assert.equal(done.committed, true);
  assert.deepEqual(ownerState(repo, files), before, "after commit");

  const work = await describeWork({ path: wt.path, baseCommit: wt.baseCommit });
  assert.equal(work.files.length, 2);
  await fileDiff({ path: wt.path, baseCommit: wt.baseCommit, file: "src/app.txt" });
  assert.deepEqual(ownerState(repo, files), before, "after describe");

  await removeWorktree({ repo, path: wt.path, deleteBranch: false });
  assert.deepEqual(ownerState(repo, files), before, "after remove");
  assert.equal(git(repo, "branch", "--show-current"), "main\n");
  assert.equal(head(repo, "main"), base, "the owner's branch did not move");
  assert.equal(fs.existsSync(wt.path), false);
});

test("modified, deleted, created and ignored files: the commit holds the work on the task branch and removal loses nothing", async (t) => {
  const { repo, home, base } = sourceRepo(t);
  const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });
  write(wt.path, "src/app.txt", "one\n2\nthree\n");
  fs.rmSync(path.join(wt.path, "old.txt"));
  write(wt.path, "new/deep/file.txt", "brand new\n");
  write(wt.path, "debug.log", "ignored by .gitignore\n");
  write(wt.path, "ignored/cache.bin", "ignored too\n");

  const done = await commitWork({ path: wt.path, message: "-m looks like a flag\n\nbody line" });
  assert.equal(done.committed, true);
  assert.ok(done.committed);
  assert.match(done.commit, /^[0-9a-f]{40}$/);
  assert.equal(head(repo, "refs/heads/botbench/run1/task1"), done.commit);
  assert.equal(head(repo, `${done.commit}^`), base);
  assert.equal(git(repo, "rev-list", "--count", `${base}..${done.commit}`), "1\n");
  assert.equal(git(repo, "ls-tree", "-r", "--name-only", done.commit), ".gitignore\nREADME.md\nnew/deep/file.txt\nsrc/app.txt\n");
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%B", done.commit), "Botbench <botbench@localhost>|Botbench <botbench@localhost>|-m looks like a flag\n\nbody line\n\n");
  assert.equal(git(wt.path, "status", "--porcelain"), "", "nothing is left uncommitted");

  // A clean tree is reported, not an error, and adds no commit.
  const again = await commitWork({ path: wt.path, message: "nothing here" });
  assert.deepEqual(again, { committed: false, reason: "nothing to commit" });
  assert.equal(head(repo, "refs/heads/botbench/run1/task1"), done.commit);

  await removeWorktree({ repo, path: wt.path, deleteBranch: false });
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(head(repo, "refs/heads/botbench/run1/task1"), done.commit, "the branch outlives the worktree");
  assert.equal(git(repo, "show", `${done.commit}:src/app.txt`), "one\n2\nthree\n");
  assert.equal(git(repo, "show", `${done.commit}:new/deep/file.txt`), "brand new\n");
  assert.throws(() => git(repo, "cat-file", "-e", `${done.commit}:old.txt`));
  assert.equal(head(repo, "main"), base);
});

test("two tasks get two worktrees and two branches from the same base commit", async (t) => {
  const { repo, home, base } = sourceRepo(t);
  const a = await createWorktree({ repo, home, run: "run1", task: "task-a" });
  const b = await createWorktree({ repo, home, run: "run1", task: "task_b" });
  assert.notEqual(a.path, b.path);
  assert.deepEqual([a.branch, b.branch], ["botbench/run1/task-a", "botbench/run1/task_b"]);
  assert.deepEqual([a.baseCommit, b.baseCommit], [base, base]);
  assert.equal(worktreeCount(repo), 3);
  assert.equal(git(a.path, "branch", "--show-current"), "botbench/run1/task-a\n");
  assert.equal(git(b.path, "branch", "--show-current"), "botbench/run1/task_b\n");

  write(a.path, "only-a.txt", "a\n");
  const done = await commitWork({ path: a.path, message: "a's work" });
  assert.ok(done.committed);
  assert.equal(head(repo, a.branch), done.commit);
  assert.equal(head(repo, b.branch), base, "one task's commit does not move the other's branch");
  assert.equal(fs.existsSync(path.join(b.path, "only-a.txt")), false);

  // The same task again while its worktree still exists is refused, not overwritten.
  await assert.rejects(createWorktree({ repo, home, run: "run1", task: "task-a" }), /already exists/);
  assert.equal(read(a.path, "only-a.txt"), "a\n");

  await removeWorktree({ repo, path: a.path, deleteBranch: true });
  await removeWorktree({ repo, path: b.path, deleteBranch: true });
  assert.equal(git(repo, "branch", "--list", "botbench/*"), "", "deleteBranch removes the task branches");
  assert.equal(git(repo, "branch", "--show-current"), "main\n");
  assert.equal(fs.existsSync(path.join(home, "worktrees", "run1")), false, "the empty run directory is tidied away");
});

test("a branch name taken by an earlier run gets a new name; the old branch keeps its commit", async (t) => {
  const { dir, repo, home } = sourceRepo(t);
  const first = await createWorktree({ repo, home, run: "run1", task: "task1" });
  write(first.path, "first.txt", "from the earlier run\n");
  const done = await commitWork({ path: first.path, message: "earlier run" });
  assert.ok(done.committed);
  await removeWorktree({ repo, path: first.path, deleteBranch: false });

  write(repo, "README.md", "# Moved on\n");
  git(repo, "add", "README.md");
  const newer = ownerCommit(repo, "owner moves on");

  const second = await createWorktree({ repo, home, run: "run1", task: "task1" });
  assert.equal(second.branch, "botbench/run1/task1-2");
  assert.equal(second.baseCommit, newer);
  assert.equal(head(second.path), newer);
  assert.equal(fs.existsSync(path.join(second.path, "first.txt")), false, "the old branch was not reused");
  assert.equal(head(repo, "refs/heads/botbench/run1/task1"), done.commit, "the old branch was not reset");

  // A second Botbench home meets both existing names.
  const third = await createWorktree({ repo, home: path.join(dir, "other-home"), run: "run1", task: "task1" });
  assert.equal(third.branch, "botbench/run1/task1-3");

  await removeWorktree({ repo, path: second.path, deleteBranch: true });
  await removeWorktree({ repo, path: third.path, deleteBranch: true });
  assert.equal(git(repo, "branch", "--list", "botbench/*").trim(), "botbench/run1/task1");
  assert.equal(head(repo, "refs/heads/botbench/run1/task1"), done.commit, "deleting the newer branches leaves the old one alone");
});

test("a path that is not a git repository, or a repository with no commits, is rejected and nothing is created", async (t) => {
  const plain = scratch(t, false);
  await assert.rejects(createWorktree({ repo: plain.repo, home: plain.home, run: "run1", task: "task1" }), /is not a git repository/);
  assert.equal(fs.existsSync(plain.home), false);

  await assert.rejects(createWorktree({ repo: path.join(plain.dir, "missing"), home: plain.home, run: "run1", task: "task1" }), /does not exist|is not a directory/);
  assert.equal(fs.existsSync(plain.home), false);

  const empty = scratch(t);
  await assert.rejects(createWorktree({ repo: empty.repo, home: empty.home, run: "run1", task: "task1" }), /has no commits/);
  assert.equal(fs.existsSync(empty.home), false);
  assert.equal(git(empty.repo, "branch", "--list"), "");

  // A folder inside a repository is not the repository.
  const s = sourceRepo(t);
  await assert.rejects(createWorktree({ repo: path.join(s.repo, "src"), home: s.home, run: "run1", task: "task1" }), /top level/);
  assert.equal(fs.existsSync(s.home), false);
});

test("run and task ids that are not simple slugs, and a home inside the repository, are rejected and nothing is created", async (t) => {
  const { repo, home } = sourceRepo(t);
  const before = git(repo, "for-each-ref");
  for (const bad of ["", "..", "../escape", "a/b", "-b", "--orphan", "a b", "a.lock", ".hidden", "x\ny", "a".repeat(65)]) {
    await assert.rejects(createWorktree({ repo, home, run: bad, task: "task1" }), /run id/, `run ${JSON.stringify(bad)}`);
    await assert.rejects(createWorktree({ repo, home, run: "run1", task: bad }), /task id/, `task ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.existsSync(home), false);
  await assert.rejects(createWorktree({ repo, home: path.join(repo, "botbench-home"), run: "run1", task: "task1" }), /inside the repository/);
  assert.equal(fs.existsSync(path.join(repo, "botbench-home")), false);
  assert.equal(git(repo, "for-each-ref"), before);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("removing a worktree with uncommitted changes is refused, and so is treating the owner's checkout as a worktree", async (t) => {
  const { repo, home } = sourceRepo(t);
  const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });

  write(wt.path, "untracked.txt", "not committed yet\n");
  await assert.rejects(removeWorktree({ repo, path: wt.path, deleteBranch: true }), /uncommitted changes/);
  assert.equal(read(wt.path, "untracked.txt"), "not committed yet\n");
  assert.equal(head(repo, wt.branch), wt.baseCommit, "the branch is still there");

  fs.rmSync(path.join(wt.path, "untracked.txt"));
  write(wt.path, "src/app.txt", "edited\n");
  await assert.rejects(removeWorktree({ repo, path: wt.path, deleteBranch: false }), /uncommitted changes/);
  assert.equal(read(wt.path, "src/app.txt"), "edited\n");

  git(wt.path, "add", "src/app.txt");
  await assert.rejects(removeWorktree({ repo, path: wt.path, deleteBranch: false }), /uncommitted changes/);
  assert.equal(worktreeCount(repo), 2);

  // The owner's checkout is never a Botbench worktree: no commit, no removal.
  write(repo, "owner.txt", "owner's untracked file\n");
  const before = ownerState(repo, ["owner.txt"]);
  await assert.rejects(commitWork({ path: repo, message: "must not happen" }), /not a copy Botbench made/);
  await assert.rejects(removeWorktree({ repo, path: repo, deleteBranch: true }), /not a copy Botbench made/);
  await assert.rejects(describeWork({ path: repo, baseCommit: wt.baseCommit }), /not a copy Botbench made/);
  assert.deepEqual(ownerState(repo, ["owner.txt"]), before);

  // A worktree that left its task branch could lose commits on removal, so that is refused too.
  git(wt.path, "checkout", "--quiet", "--detach");
  await assert.rejects(commitWork({ path: wt.path, message: "detached" }), /task branch/);
  await assert.rejects(removeWorktree({ repo, path: wt.path, deleteBranch: false }), /task branch/);
  assert.equal(read(wt.path, "src/app.txt"), "edited\n");
  git(wt.path, "checkout", "--quiet", wt.branch);

  const done = await commitWork({ path: wt.path, message: "now committed" });
  assert.ok(done.committed);
  await removeWorktree({ repo, path: wt.path, deleteBranch: false });
  assert.equal(git(repo, "show", `${wt.branch}:src/app.txt`), "edited\n");
});

test("the per-file summary and each file's unified diff are right for an added, a modified and a deleted file", async (t) => {
  const { repo, home, base } = sourceRepo(t);
  const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });

  const nothing = await describeWork({ path: wt.path, baseCommit: wt.baseCommit });
  assert.deepEqual(nothing, { branch: "botbench/run1/task1", baseCommit: base, headCommit: base, files: [] });

  write(wt.path, "src/app.txt", "one\n2\nthree\nfour\n");
  fs.rmSync(path.join(wt.path, "old.txt"));
  write(wt.path, "added.txt", "a\nb\nc\n");
  write(wt.path, "*.txt", "a file whose name is a pattern\n");
  write(wt.path, "blob.bin", "\u0000\u0001\u0002binary\u0000");
  const done = await commitWork({ path: wt.path, message: "three kinds of change" });
  assert.ok(done.committed);
  // Work not yet committed is not part of "base commit to branch head".
  write(wt.path, "later.txt", "after the commit\n");

  const work = await describeWork({ path: wt.path, baseCommit: wt.baseCommit });
  assert.deepEqual(work, {
    branch: "botbench/run1/task1",
    baseCommit: base,
    headCommit: done.commit,
    files: [
      { path: "*.txt", status: "added", added: 1, removed: 0, binary: false },
      { path: "added.txt", status: "added", added: 3, removed: 0, binary: false },
      { path: "blob.bin", status: "added", added: 0, removed: 0, binary: true },
      { path: "old.txt", status: "deleted", added: 0, removed: 2, binary: false },
      { path: "src/app.txt", status: "modified", added: 2, removed: 1, binary: false },
    ],
  });

  const diffOf = (file: string): Promise<string> => fileDiff({ path: wt.path, baseCommit: wt.baseCommit, file });
  const ZERO = "0".repeat(40);
  const blob = (content: string): string => execFileSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8", env: CLEAN_ENV }).trim();

  assert.equal(
    await diffOf("src/app.txt"),
    `diff --git a/src/app.txt b/src/app.txt\nindex ${blob("one\ntwo\nthree\n")}..${blob("one\n2\nthree\nfour\n")} 100644\n--- a/src/app.txt\n+++ b/src/app.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n`,
  );
  assert.equal(
    await diffOf("added.txt"),
    `diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex ${ZERO}..${blob("a\nb\nc\n")}\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n`,
  );
  assert.equal(
    await diffOf("old.txt"),
    `diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex ${blob("going\naway\n")}..${ZERO}\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-going\n-away\n`,
  );
  // A file name is a name, never a pattern: only that one file's diff comes back.
  const star = await diffOf("*.txt");
  assert.equal(star.match(/^diff --git /gm)?.length, 1);
  assert.match(star, /^\+a file whose name is a pattern$/m);
  assert.equal(await diffOf("README.md"), "", "an unchanged file has an empty diff");

  // Values that would be read as git options are refused.
  await assert.rejects(describeWork({ path: wt.path, baseCommit: "--output=/tmp/x" }), /base commit/);
  await assert.rejects(fileDiff({ path: wt.path, baseCommit: "HEAD", file: "added.txt" }), /base commit/);
  await assert.rejects(diffOf(""), /file/);

  const rest = await commitWork({ path: wt.path, message: "the rest" });
  assert.ok(rest.committed);
  const after = await describeWork({ path: wt.path, baseCommit: wt.baseCommit });
  assert.equal(after.headCommit, rest.commit);
  assert.equal(after.files.length, 6);
  await removeWorktree({ repo, path: wt.path, deleteBranch: true });
});

test("the owner's repository hooks do not run for Botbench, and the owner's user.name and user.email are neither needed nor changed", async (t) => {
  const { dir, repo, home } = sourceRepo(t);
  const marker = path.join(dir, "hook-ran");
  for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "prepare-commit-msg"]) {
    const file = path.join(repo, ".git", "hooks", hook);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho ${hook} >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  }
  // An owner who has set no usable identity in this repository.
  git(repo, "config", "user.name", "");
  git(repo, "config", "user.email", "");
  git(repo, "config", "user.useConfigOnly", "true");

  // First show both obstacles are real: the hook stops an ordinary commit, and without an identity git refuses to commit.
  assert.throws(() => git(repo, ...OWNER, "commit", "--quiet", "--allow-empty", "-m", "blocked by hook"));
  assert.match(fs.readFileSync(marker, "utf8"), /pre-commit/);
  fs.rmSync(marker);
  assert.throws(() => git(repo, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", "no identity"), /ident|user\.name|identity/i);
  const config = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");
  const base = head(repo);

  const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });
  write(wt.path, "work.txt", "work\n");
  const done = await commitWork({ path: wt.path, message: "hooks stay out of it" });
  assert.ok(done.committed);

  assert.equal(fs.existsSync(marker), false, "no hook ran");
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", done.commit), "Botbench <botbench@localhost>|Botbench <botbench@localhost>\n");
  assert.equal(fs.readFileSync(path.join(repo, ".git", "config"), "utf8"), config, "the repository's config is unchanged");
  assert.equal(git(repo, "config", "--local", "user.name"), "\n");
  assert.equal(head(repo), base);

  await removeWorktree({ repo, path: wt.path, deleteBranch: false });
  assert.equal(fs.existsSync(marker), false);
});

test("git variables inherited from the caller's environment do not redirect Botbench to another repository", async (t) => {
  const { repo, home, base } = sourceRepo(t);
  const decoy = sourceRepo(t);
  write(decoy.repo, "decoy.txt", "untracked in the decoy\n");
  const decoyBefore = ownerState(decoy.repo, ["decoy.txt"]);
  const decoyRefs = git(decoy.repo, "for-each-ref");
  const altIndex = path.join(decoy.dir, "alternate-index");

  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const;
  const saved = names.map((n) => process.env[n]);
  process.env.GIT_DIR = path.join(decoy.repo, ".git");
  process.env.GIT_WORK_TREE = decoy.repo;
  process.env.GIT_INDEX_FILE = altIndex;
  process.env.GIT_COMMON_DIR = path.join(decoy.repo, ".git");
  try {
    const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });
    assert.equal(wt.baseCommit, base);
    write(wt.path, "work.txt", "work\n");
    const done = await commitWork({ path: wt.path, message: "in the right repository" });
    assert.ok(done.committed);
    assert.equal((await describeWork({ path: wt.path, baseCommit: wt.baseCommit })).files.length, 1);
    await removeWorktree({ repo, path: wt.path, deleteBranch: false });
    assert.equal(head(repo, wt.branch), done.commit);
  } finally {
    names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
  }
  assert.deepEqual(ownerState(decoy.repo, ["decoy.txt"]), decoyBefore);
  assert.equal(git(decoy.repo, "for-each-ref"), decoyRefs);
  assert.equal(fs.existsSync(altIndex), false);
});

test("a source repository on a detached HEAD with a dirty index works and stays detached at the same commit", async (t) => {
  const { repo, home, base } = sourceRepo(t);
  write(repo, "second.txt", "second\n");
  git(repo, "add", "second.txt");
  const second = ownerCommit(repo, "second commit");
  git(repo, "checkout", "--quiet", "--detach", base);
  write(repo, "src/app.txt", "dirty\n");
  git(repo, "add", "src/app.txt");
  write(repo, "src/app.txt", "dirtier\n");
  const before = ownerState(repo, ["src/app.txt"]);
  assert.equal(before.branch, "(detached)");
  assert.equal(before.status, "MM src/app.txt\n");

  const wt = await createWorktree({ repo, home, run: "run1", task: "task1" });
  assert.equal(wt.baseCommit, base, "the base is the commit HEAD points at, not a branch tip");
  assert.equal(fs.existsSync(path.join(wt.path, "second.txt")), false);
  write(wt.path, "work.txt", "work\n");
  const done = await commitWork({ path: wt.path, message: "from a detached source" });
  assert.ok(done.committed);
  await removeWorktree({ repo, path: wt.path, deleteBranch: false });

  assert.deepEqual(ownerState(repo, ["src/app.txt"]), before);
  assert.equal(head(repo, "main"), second);
  assert.equal(head(repo, `${done.commit}^`), base);
});

test("a worktree whose git folder was repointed from inside is refused, so nothing a task wrote there can run a command when Botbench commits", async (t) => {
  const s = sourceRepo(t);
  const wt = await createWorktree({ repo: s.repo, home: s.home, run: "run-1", task: "task-1" });
  const realGitFile = read(wt.path, ".git");
  const marker = path.join(s.dir, "filter-ran.txt");

  // What an agent that may write below its worktree could build there: a git folder of its own that looks like a linked
  // worktree on a botbench/ branch, with a config whose clean filter is a command, and the worktree's .git file pointed at it.
  const evil = path.join(wt.path, "inner");
  fs.mkdirSync(evil);
  git(evil, "init", "--quiet", "-b", "botbench/inner");
  write(evil, "seed.txt", "seed\n");
  git(evil, "add", "-A");
  ownerCommit(evil, "seed");
  git(evil, "branch", "botbench/linked");
  git(evil, "config", "filter.run.clean", `sh -c 'echo ran > "${marker}"; cat'`);
  const linked = path.join(evil, ".git", "worktrees", "w");
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, "HEAD"), "ref: refs/heads/botbench/linked\n");
  fs.writeFileSync(path.join(linked, "commondir"), "../..\n");
  fs.writeFileSync(path.join(linked, "gitdir"), `${path.join(wt.path, ".git")}\n`);
  fs.writeFileSync(path.join(wt.path, ".git"), `gitdir: ${linked}\n`);
  write(wt.path, ".gitattributes", "* filter=run\n");
  write(wt.path, "payload.txt", "anything\n");

  await assert.rejects(commitWork({ path: wt.path, message: "work" }), /not a copy Botbench made/);
  await assert.rejects(describeWork({ path: wt.path, baseCommit: wt.baseCommit }), /not a copy Botbench made/);
  await assert.rejects(fileDiff({ path: wt.path, baseCommit: wt.baseCommit, file: "payload.txt" }), /not a copy Botbench made/);
  await assert.rejects(removeWorktree({ repo: s.repo, path: wt.path, deleteBranch: true }), /not a copy Botbench made/);
  assert.equal(fs.existsSync(marker), false, "the filter command did not run");

  // Put back as Botbench made it, the worktree is Botbench's again and is removed like any other.
  fs.writeFileSync(path.join(wt.path, ".git"), realGitFile);
  fs.rmSync(evil, { recursive: true, force: true });
  fs.rmSync(path.join(wt.path, ".gitattributes"));
  fs.rmSync(path.join(wt.path, "payload.txt"));
  await removeWorktree({ repo: s.repo, path: wt.path, deleteBranch: true });
});

test("a git process that does not answer is stopped at its time limit, and the error says the folder could not be read in time", { skip: NO_PROCESS_LIST, timeout: 20_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "botbench-wt-stall-"));
  const repo = path.join(dir, "source");
  t.after(() => {
    releaseStalled(repo);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  stalledRepo(repo);

  const started = Date.now();
  const outcome = await Promise.race([
    sourceHead(repo).then(() => "answered", (err: unknown) => err),
    new Promise((resolve) => setTimeout(() => resolve("still waiting after 8 seconds"), 8000).unref()),
  ]);
  assert.ok(outcome instanceof Error, `the check of a stalled repository: ${String(outcome)}`);
  assert.match(outcome.message, /could not be read in time/);
  assert.ok(outcome.message.includes(repo), "the error names the folder");
  assert.doesNotMatch(outcome.message, /Volumes|macOS/, "a folder on the internal disk gets no advice about external drives");
  assert.ok(Date.now() - started >= 4500, "the limit for a check is 5 seconds, not less");
  assert.deepEqual(gitProcesses(repo), [], "no git process is left for the folder");

  // The same limit holds when a task's worktree is asked for: nothing is created and nothing is left running.
  const home = path.join(dir, "home");
  await assert.rejects(createWorktree({ repo, home, run: "run-1", task: "task-1" }), /could not be read in time/);
  assert.equal(fs.existsSync(path.join(home, "worktrees")), false);
  assert.deepEqual(gitProcesses(repo), []);
});
