import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { chooseWorkbench } from "../src/workbench.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { PEERS_ADDRESS } from "../test/support/replay-peers.ts";
import { git, initRepo, write } from "../test/support/repo.ts";
import { checkDesign, chooseRepository, closeContext, expect, messageBox, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Named workbenches that see each other's work (Peers P1, P2) in the real client, at a phone's size, with no model
// turn. The shared remote is a real bare repository on disk; another installation ("bob") has pushed its task branch
// to it from its own clone, and this installation ("alice") has a task ready for review on its own named branch. The
// repository names the remote by the GitHub address of the owner's repository jon-lange/botbench, which its git
// settings send to the bare repository. Botbench is started through e2e/serve-replayed-gh.ts, whose list of open pull
// requests is replayed from output captured once from the real gh for that repository (test/support/replay-peers.ts,
// the owner's approved exception). That capture holds no open pull request: none from a named workbench could exist
// before this change, so another workbench's pull request on the Work screen, and the composer's warning for an issue
// it closes, are proven by the unit and API tests (test/peers*.test.ts, test/api/peers.test.ts), not here.

const test = base.extend<{ dir: string; seeded: { home: string; repo: string; taskId: number; branch: string }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-peers-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const bare = path.join(dir, "remote.git");
    const seed = path.join(dir, "seed");
    initRepo(seed);
    git(dir, "init", "--quiet", "--bare", "-b", "main", bare);
    git(seed, "push", "--quiet", bare, "main");
    // Bob's installation: its own clone, its task branch pushed.
    const bob = path.join(dir, "bob");
    git(dir, "clone", "--quiet", bare, bob);
    write(bob, "bob.txt", "bob's work\n");
    git(bob, "add", "bob.txt");
    git(bob, "-c", "user.name=Bob", "-c", "user.email=bob@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "bob's work");
    git(bob, "push", "--quiet", "origin", "HEAD:refs/heads/botbench/bob/run-1/task-1");
    // Alice's installation, this one: its own clone of the same remote, and a task ready for review on its named branch.
    const repo = path.join(dir, "alice");
    git(dir, "clone", "--quiet", bare, repo);
    git(repo, "config", `url.${bare}.insteadOf`, PEERS_ADDRESS);
    git(repo, "remote", "set-url", "origin", PEERS_ADDRESS);
    const home = path.join(dir, "home");
    const db = openStore(home);
    chooseWorkbench(db, "alice", "owner");
    const task = createTask(db, { repo, prompt: "create hello.txt" });
    const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}`, workbench: "alice" });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, "hello.txt", "hi\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    db.close();
    // This workbench's own branch is on the remote too: it is not listed as another's.
    git(repo, "push", "--quiet", bare, `refs/heads/${worktree.branch}`);
    await use({ home, repo, taskId: task.id, branch: worktree.branch });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, entry: path.resolve(import.meta.dirname, "serve-replayed-gh.ts"), settings: { drivers: { "claude-code": { model: "haiku" } } } });
    await use(botbench);
    await botbench.stop();
  },
});

test("Work shows another workbench's pushed branch; the composer stays free to send; Settings shows and saves this workbench's name", async ({ page, botbench, seeded }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/work`);
  const others = page.getByTestId("other-workbenches");
  await expect(others.getByRole("heading", { name: "Other workbenches" })).toBeVisible();
  const branch = others.getByTestId("peer-branch");
  await expect(branch).toHaveCount(1);
  await expect(branch).toContainText("botbench/bob/run-1/task-1");
  await expect(branch).toContainText("bob · Pushed, no pull request yet · alice");
  // This workbench's own branch is not listed.
  await expect(others).not.toContainText(seeded.branch);
  await checkDesign(page, "Work, with another workbench's branch");

  // The task's own branch carries this workbench's name.
  await page.goto(`${botbench.base}/#/tasks/${seeded.taskId}`);
  await expect(page.getByTestId("branch")).toHaveValue(/^botbench\/alice\/run-\d+\/task-\d+$/);
  await expect(page.getByTestId("peer-overlap")).toHaveCount(0);

  // Naming an issue no open pull request closes: no warning, and Send stays enabled.
  await page.goto(`${botbench.base}/#/turn`);
  await chooseRepository(page, seeded.repo);
  await closeContext(page);
  await messageBox(page).fill("Fix Issue #59");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(page.getByTestId("peer-warning")).toHaveCount(0);

  await page.goto(`${botbench.base}/#/settings`);
  const name = page.getByLabel("Workbench name");
  await expect(name).toHaveValue("alice");
  await expect(page.getByText("New task branches carry this name, such as botbench/alice/run-1/task-1")).toBeVisible();
  await checkDesign(page, "Settings, with the workbench name");
  await name.fill("Alice/x");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("alert")).toContainText("lowercase letters, digits and hyphens");
  await name.fill("alice-2");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByTestId("workbench-saved")).toHaveText("Saved.");
  await page.reload();
  await expect(page.getByLabel("Workbench name")).toHaveValue("alice-2");
});
