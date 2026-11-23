import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createPeers, type Peers } from "../../src/engine/peers.ts";
import { createTask, getTask, moveTask, type Task } from "../../src/engine/task.ts";
import type { GitHub, ListedPullRequest } from "../../src/github.ts";
import { chooseWorkbench } from "../../src/workbench.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import type { Config } from "../../src/config.ts";
import { replayIssues } from "./replay-issue.ts";
import { PEERS_ADDRESS } from "./replay-peers.ts";
import { git, initRepo, ownerCommit, write } from "./repo.ts";

/*
 * The scene for checking a task together with another workbench's pull request, made of real things: a real repository
 * whose remote is named by the GitHub address of the owner's repository and sent by its git settings to a real bare
 * repository (`url.<bare>.insteadOf`), a second workbench ("bob") that cloned that remote, committed and pushed its
 * task branch there, and a real task of this workbench ("alice") in its own worktree, committed and ready for review.
 *
 * What is not captured from GitHub: the one open pull request of bob's branch. The only output captured from the real
 * gh (test/recordings/gh-peers.json) lists no open pull request, and recordings are never changed, so the list gh
 * would give is written here as the parsed value `ListedPullRequest`, as test/peers.test.ts does for the same rule. The
 * rest of the view (the head commit of the branch, which workbench it is) is read by the real code from the real remote.
 */

export const PEER_BRANCH = "botbench/bob/run-1/task-1";

export interface Scene {
  dir: string;
  home: string;
  repo: string;
  bare: string;
  /** bob's clone of the remote, where bob's commits are made and pushed from. */
  peer: string;
  /** The open pull requests gh would list now; a test may change them. */
  prs: ListedPullRequest[];
  github: GitHub;
}

/** The repository with `files`, its bare remote, and bob's clone with bob's branch pushed holding `peerFiles`. */
export function makeScene(dir: string, files: Record<string, string>, peerFiles: Record<string, string>, o: { pullRequest?: number } = {}): Scene {
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, files);
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", bare);
  git(repo, "config", `url.${bare}.insteadOf`, PEERS_ADDRESS);
  git(repo, "remote", "add", "origin", PEERS_ADDRESS);
  git(repo, "push", "--quiet", bare, "main:refs/heads/main");
  const peer = path.join(dir, "bob");
  git(dir, "clone", "--quiet", "--branch", "main", bare, peer);
  git(peer, "checkout", "--quiet", "-b", PEER_BRANCH);
  peerCommit({ peer } as Scene, peerFiles, "bob's work");
  const number = o.pullRequest ?? 7;
  const prs: ListedPullRequest[] = [{ number, url: `https://github.com/jon-lange/botbench/pull/${number}`, title: "Bob's change", state: "OPEN", headRefName: PEER_BRANCH, closes: [], files: Object.keys(peerFiles) }];
  const github: GitHub = { ...replayIssues().github, openPullRequests: async () => prs };
  return { dir, home, repo, bare, peer, prs, github };
}

/** bob commits `files` on bob's branch and pushes it, as bob's workbench would. Answers the new head. */
export function peerCommit(scene: Pick<Scene, "peer">, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) write(scene.peer, file, content);
  const head = ownerCommit(scene.peer, message);
  git(scene.peer, "push", "--quiet", "origin", `HEAD:refs/heads/${PEER_BRANCH}`);
  return head;
}

/** The real view of the remote, read again at every ask. */
export const scenePeers = (db: DatabaseSync, scene: Scene, config: Config): Peers => createPeers({ db, config, github: scene.github, freshMs: 0 });

/** A task of this workbench (alice), its work in `files` committed by Botbench in its own copy, and ready for review. */
export async function readyTask(db: DatabaseSync, scene: Scene, files: Record<string, string>, prompt = "Change the greeting"): Promise<Task> {
  chooseWorkbench(db, "alice", "owner");
  const task = createTask(db, { repo: scene.repo, prompt });
  const worktree = await createWorktree({ repo: scene.repo, home: scene.home, run: `run-${task.runId}`, task: `task-${task.id}`, workbench: "alice" });
  for (const [file, content] of Object.entries(files)) write(worktree.path, file, content);
  const made = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  if (!made.committed) throw new Error("the task's work was not committed");
  moveTask(db, task.id, "building", { worktree });
  moveTask(db, task.id, "verifying", { headCommit: made.commit });
  moveTask(db, task.id, "awaiting_decision", { checks: "passed" });
  return getTask(db, task.id)!;
}

/** Everything of the owner's repository a check together must leave as it was: branches, worktrees, refs, its checkout and FETCH_HEAD. */
export function repoState(repo: string): string {
  return [git(repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(repo, "worktree", "list", "--porcelain"), git(repo, "status", "--porcelain", "--untracked-files=all"), String(fs.existsSync(path.join(repo, ".git", "FETCH_HEAD")))].join("\n");
}

/** What the bare remote holds: every ref and where it points. */
export const remoteState = (bare: string): string => git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
