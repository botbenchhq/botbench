import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import type { Config } from "../src/config.ts";
import { decideTask } from "../src/engine/decision.ts";
import { createDeliveries } from "../src/engine/delivery.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { loadGhCapture, replayGitHub } from "../test/support/replay-github.ts";
import { git, initRepo, write } from "../test/support/repo.ts";
import { checkDesign, chooseRepository, closeContext, expect, openRow, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Pull requests in the real client, with no model turn. Before Botbench starts, a task is built, accepted and
// delivered through the engine itself: real git, a bare repository on disk as the remote (the repository's GitHub
// address is sent there by its own git settings), and the pull-request step replaying output captured once from the
// real gh (test/support/replay-github.ts, the owner's approved exception). Then the real Botbench process shows it.

const ADDRESS = "https://github.com/jon-lange/botbench-delivery-fixture.git";

const test = base.extend<{ dir: string; seeded: { home: string; taskId: number }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-delivery-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    initRepo(repo);
    const bare = path.join(dir, "remote.git");
    git(dir, "init", "--quiet", "--bare", bare);
    git(repo, "config", `url.${bare}.insteadOf`, ADDRESS);
    git(repo, "remote", "add", "origin", ADDRESS);
    const db = openStore(home);
    const task = createTask(db, { repo, prompt: "create hello.txt" });
    const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, "hello.txt", "hi\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    await decideTask(db, { taskId: task.id, decision: "accept" });
    const deliveries = createDeliveries({ db, config: { repositories: {} } as unknown as Config, github: replayGitHub().github, onTaskChange: () => {} });
    deliveries.deliver(task.id, { by: "owner" });
    await deliveries.close();
    db.close();
    await use({ home, taskId: task.id });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    await botbench.stop();
  },
});

test("Plan a run offers Keep the branch (chosen) or Open a pull request; a delivered task shows its pull request's number and a link that opens GitHub in a new tab", async ({ page, botbench, seeded, dir }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/runs/new`);
  await chooseRepository(page, path.join(dir, "repo"));
  const sheet = await openRow(page, "When accepted");
  await expect(sheet.getByRole("heading", { name: "When you accept a task" })).toBeVisible();
  await expect(sheet.getByRole("radio", { name: "Keep the branch" })).toBeChecked();
  await expect(sheet.getByRole("radio", { name: "Open a pull request" })).not.toBeChecked();
  await sheet.getByRole("radio", { name: "Open a pull request" }).check();
  await checkDesign(page, "new run, with the delivery choice");
  await closeContext(page);
  await expect(page.getByTestId("composer-about")).toContainText("Each accepted task is then opened as a pull request.");

  const created = loadGhCapture().outputs.prCreate.result.stdout.trim();
  const number = /\/pull\/(\d+)$/.exec(created)![1];
  await page.goto(`${botbench.base}/#/tasks/${seeded.taskId}`);
  await expect(page.getByTestId("pull-request-state")).toHaveText(`The branch is on origin, and Botbench opened pull request #${number} into main. Nothing was merged.`);
  const link = page.getByRole("link", { name: `Pull request #${number} on GitHub (opens in a new tab)` });
  await expect(link).toHaveAttribute("href", created);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("not-merged")).toHaveText(/^Nothing has been merged\. The branch was pushed to origin/);
  await expect(page.getByRole("button", { name: "Open a pull request" })).toHaveCount(0);
  await checkDesign(page, "task, with its pull request");
});
