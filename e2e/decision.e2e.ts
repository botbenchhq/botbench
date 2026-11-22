import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { botbenchBranches, checkoutState, git, initRepo, worktreeCount } from "../test/support/repo.ts";
import { SHOTS, checkDesign, expect, openFromSettings, signIn, startRunIn, startTaskIn, tallShot, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Decisions in the real client, at a phone's size: a real Botbench process, real temporary repositories, and the
// owner's Claude Code building tiny tasks on its cheapest model. One repository's check is a fixture script that leaves
// a report file behind in the task's copy after Botbench committed, and a cache in an ignored folder, as real test
// tools do. After Accept, the test merges the branch into the repository by hand with the command the screen gives.

const LEAVING_CHECK = '#!/bin/sh\necho "checked" > check-report.txt\nmkdir -p node_modules && echo cached > node_modules/cache.txt\necho "the report is in check-report.txt"\n';

const test = base.extend<{ dir: string; repos: { checked: string; plain: string; run: string }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-decision-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repos: async ({ dir }, use) => {
    const checked = path.join(dir, "checked-repo");
    const plain = path.join(dir, "plain-repo");
    const run = path.join(dir, "run-repo");
    initRepo(checked, { "README.md": "# Sample\n", ".gitignore": "node_modules/\n", "check.sh": LEAVING_CHECK });
    initRepo(plain);
    initRepo(run);
    await use({ checked, plain, run });
  },
  botbench: async ({ dir, repos }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repos.checked]: { checks: ["sh check.sh"] } } } });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

/** Decline every request a builder makes while `until` has not passed: the tasks here need no command. */
async function declineWhile(page: Page, botbench: Botbench, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    for (const approval of ((await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number; taskId: number | null }[] }).approvals) {
      if (approval.taskId !== null) await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Write the file with your Write tool; run no command." } });
    }
    await until();
  }).toPass({ timeout: 240_000, intervals: [1_000] });
}

/** Start a task from New task and wait on its screen until it is Ready for review. */
async function readyTask(page: Page, botbench: Botbench, repo: string): Promise<void> {
  await startTaskIn(page, repo, "Create the file hello.txt containing the single word hi, with your Write tool. Run no command.");
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  await declineWhile(page, botbench, () => expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 1_000 }));
}

test("LIVE: Accept a task whose check left files behind: the dialog lists them, the copy goes only once confirmed, and the screen gives the branch and the merge command, which merges by hand; Reject asks whether to keep the branch and deletes it on discard", async ({ page, context, botbench, repos }) => {
  test.setTimeout(480_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const foreign = watchRequests(page, botbench);
  const before = checkoutState(repos.checked);
  await signIn(page, botbench);

  await readyTask(page, botbench, repos.checked);
  const taskId = Number(/Task (\d+)/.exec((await page.getByTestId("task-name").textContent()) ?? "")![1]);
  const task = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { branch: string; leftovers: string[] };
  // The task's copy, wherever under its run Botbench made it.
  const copy = fs.readdirSync(path.join(botbench.home, "worktrees")).map((run) => path.join(botbench.home, "worktrees", run, `task-${taskId}`)).find((dir) => fs.existsSync(dir))!;
  expect(task.leftovers).toEqual(["check-report.txt"]);
  // One primary action: Accept. Reject is beside it.
  await expect(page.getByRole("button", { name: "Accept" })).toHaveClass(/ds-button--primary/);
  await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
  await checkDesign(page, "task, ready for review, with files the checks left");
  await shot(page, "u14-ready.png");

  // Accept asks first, naming the files the checks left, and not the ignored cache.
  await page.getByRole("button", { name: "Accept" }).click();
  // It removes files, so it is an alert dialog, with the button that changes nothing first.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("These files were left by the checks and are not on the branch");
  await expect(dialog.getByTestId("leftovers").getByRole("listitem")).toHaveText(["check-report.txt"]);
  await expect(dialog).not.toContainText("node_modules");
  await checkDesign(page, "accept, files the checks left");
  await shot(page, "u14-accept-leftovers.png");
  // Closing the dialog changes nothing.
  await dialog.getByRole("button", { name: "Keep the copy" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(fs.existsSync(path.join(copy, "check-report.txt"))).toBe(true);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);

  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Accept and remove them" }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Accepted\. /);
  await expect(page.getByRole("button", { name: /^(Accept|Reject)$/ })).toHaveCount(0);
  await expect(page.getByTestId("branch")).toHaveValue(task.branch);
  await expect(page.getByTestId("merge-command")).toHaveValue(`git merge ${task.branch}`);
  await expect(page.getByTestId("decision-repo")).toHaveText(repos.checked);
  await expect(page.getByTestId("not-merged")).toContainText("Nothing has been merged or pushed.");
  // The copy is gone, so the screen no longer speaks of one.
  await expect(page.getByTestId("not-merged")).not.toContainText("copy of the project without asking");
  await checkDesign(page, "task, accepted");
  await shot(page, "u14-accepted.png");

  await page.getByRole("button", { name: "Copy merge command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`git merge ${task.branch}`);
  await page.getByRole("button", { name: "Copy branch name" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(task.branch);

  // On disk: the branch is there, the copy is not, and the owner's checkout is as it was.
  expect(fs.existsSync(copy)).toBe(false);
  expect(worktreeCount(repos.checked)).toBe(1);
  expect(botbenchBranches(repos.checked)).toEqual([task.branch]);
  expect(checkoutState(repos.checked)).toEqual(before);
  // The owner merges by hand with the command the screen gave.
  const [, ...args] = (await page.getByTestId("merge-command").inputValue()).split(" ");
  git(repos.checked, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", ...args, "--no-edit");
  expect(fs.readFileSync(path.join(repos.checked, "hello.txt"), "utf8").trim()).toBe("hi");
  expect(fs.existsSync(path.join(repos.checked, "check-report.txt")), "what the check left is not on the branch").toBe(false);

  // Reject: the dialog asks whether to keep the branch; discard deletes it with the copy.
  await readyTask(page, botbench, repos.plain);
  const rejectedId = Number(/Task (\d+)/.exec((await page.getByTestId("task-name").textContent()) ?? "")![1]);
  const rejected = (await (await page.request.get(`${botbench.base}/api/tasks/${rejectedId}`)).json()) as { branch: string };
  expect(botbenchBranches(repos.plain)).toEqual([rejected.branch]);
  await page.getByRole("button", { name: "Reject" }).click();
  const asking = page.getByRole("alertdialog");
  await expect(asking).toContainText("Reject this task?");
  await expect(asking.getByLabel("Keep the branch")).toBeChecked();
  await checkDesign(page, "reject, keep or delete the branch");
  await asking.getByLabel("Delete the branch").check();
  await shot(page, "u14-reject.png");
  await asking.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Rejected\. /);
  await expect(page.getByTestId("task-status")).toContainText("branch was deleted");
  await expect(page.getByTestId("branch")).toHaveCount(0);
  await expect(page.getByTestId("merge-command")).toHaveCount(0);
  await checkDesign(page, "task, rejected, branch deleted");
  expect(botbenchBranches(repos.plain)).toEqual([]);
  expect(worktreeCount(repos.plain)).toBe(1);

  // The decisions are on the Activity list, in words.
  await openFromSettings(page, "Permissions");
  const log = page.getByTestId("action-log");
  await expect(log).toContainText("You rejected");
  await expect(log).toContainText("You accepted");
  await checkDesign(page, "permissions, with decisions");
  expect(foreign).toEqual([]);
});

test("LIVE: on a run's screen each built task is accepted or rejected from its row, and the run is done once the last is decided", async ({ page, botbench, repos }) => {
  test.setTimeout(600_000);
  await signIn(page, botbench);
  await startRunIn(page, repos.run, "Plan exactly two tasks: create one.txt, and create two.txt. Do not run any command; the README is all there is to read.");
  await expect(page.getByRole("heading", { name: /^Run \d+$/, level: 1 })).toBeVisible();
  const runId = Number(/Run (\d+)/.exec((await page.getByRole("heading", { level: 1 }).textContent()) ?? "")![1]);
  let version = -1;
  await expect(async () => {
    for (const approval of ((await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] }).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Read files instead." } });
    }
    const run = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { status: string; planVersion: number };
    expect(run.status).toBe("awaiting_plan_approval");
    version = run.planVersion;
  }).toPass({ timeout: 240_000, intervals: [1_000] });
  const plan = [
    { title: "Create one.txt holding the word one", criteria: ["one.txt holds the word one"] },
    { title: "Create two.txt holding the word two", criteria: ["two.txt holds the word two"] },
  ];
  expect((await page.request.patch(`${botbench.base}/api/runs/${runId}/plan`, { data: { planVersion: version, tasks: plan } })).status()).toBe(200);
  await page.getByRole("button", { name: "Approve 2 tasks" }).click();

  const rows = page.getByTestId("run-tasks").locator(":scope > li");
  await declineWhile(page, botbench, () => expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./, { timeout: 1_000 }));
  const branches = await Promise.all((await rows.all()).map(async (row) => (await row.getByTestId("run-task-branch").textContent()) ?? ""));
  expect(botbenchBranches(repos.run).sort()).toEqual([...branches].sort());
  // Accept and Reject are on each row, and neither is the screen's primary action: it is repeated for each task.
  for (const row of await rows.all()) {
    await expect(row.getByRole("button", { name: /^Accept/ })).not.toHaveClass(/ds-button--primary/);
    await expect(row.getByRole("button", { name: /^Reject/ })).toBeVisible();
  }
  await checkDesign(page, "run, ready for review");
  await shot(page, "u14-run-ready.png");

  await rows.nth(0).getByRole("button", { name: /^Accept/ }).click();
  await expect(rows.nth(0).locator(".ds-badge")).toHaveText("Accepted");
  await expect(rows.nth(0).getByTestId("merge-command")).toHaveValue(`git merge ${branches[0]}`);
  await expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./);

  await rows.nth(1).getByRole("button", { name: /^Reject/ }).click();
  const asking = page.getByRole("alertdialog");
  await expect(asking.getByLabel("Keep the branch")).toBeChecked();
  await checkDesign(page, "run, reject a task");
  await asking.getByRole("button", { name: "Reject" }).click();
  await expect(rows.nth(1).locator(".ds-badge")).toHaveText("Rejected");
  await expect(page.getByTestId("run-status")).toHaveText(/^Done\./);
  await checkDesign(page, "run, done");
  await shot(page, "u14-run-done.png");

  // Both branches are kept, both copies are gone.
  expect(botbenchBranches(repos.run).sort()).toEqual([...branches].sort());
  expect(worktreeCount(repos.run)).toBe(1);
});
