import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { botbenchBranches, checkoutState, git, initRepo, worktreeCount } from "../test/support/repo.ts";
import { RUN_TASK_STATE, SHOTS, checkDesign, checkRebuilt, expect, openFromSettings, openRunId, signIn, startRunIn, startTaskIn, tallShot, watchRequests } from "./helpers.ts";
import { checkNext } from "./settings-helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Decisions in the real client, at a phone's size: a real Botbench process, real temporary repositories, and the
// owner's Claude Code building tiny tasks on its cheapest model. One repository's check is a fixture script that leaves
// a report file behind in the task's copy after Botbench committed, and a cache in an ignored folder, as real test
// tools do. The report is not ignored by git, so the task's copy differs from the commit and Accept is not offered
// (src/engine/evidence.ts) until the file is gone; the ignored cache stops nothing, and is named. After Accept, the test
// merges the branch into the repository by hand with the command the screen gives.

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

test("LIVE: a task whose check left a file git does not ignore is not offered Accept, and the screen lists the file; once it is gone Accept keeps the branch and removes the copy, and the screen gives the branch and the merge command, which merges by hand; Reject asks whether to keep the branch and deletes it on discard", async ({ page, context, botbench, repos }) => {
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
  // The design system's review decision: a section titled by its heading, the checks', the review's and the evidence's
  // line, the note, then the actions. The check left a file git does not ignore, so the copy differs from the commit:
  // the server's sentence says so, the file is listed, and there is no Accept to press, only Reject.
  const decide = page.getByRole("region", { name: "Your decision" });
  await expect(decide).toHaveClass(/ds-review-decision/);
  await expect(decide.locator(".ds-review-decision__source")).toHaveText(["Checks", "Review", "Evidence"]);
  await expect(decide.getByTestId("decision-checks")).toHaveText(/^Checks passed /);
  await expect(decide.getByTestId("decision-review")).toHaveText("Not reviewed: this run has no reviewer.");
  await expect(decide.getByTestId("evidence-words")).toHaveText(/^The task's copy has 1 file that differs from commit [0-9a-f]{7}: check-report\.txt \(not on the branch\)\./);
  await expect(decide.getByTestId("evidence-files").getByRole("listitem")).toHaveText([/check-report\.txt/]);
  // The ignored cache stops nothing, and is named apart.
  await expect(decide.getByTestId("evidence-ignored")).toHaveText("Git ignores 1 entry in the task's copy: node_modules/. It is not on the branch, does not count against the evidence, and is removed with the copy.");
  await expect(decide.getByLabel("Note (optional)")).toBeVisible();
  const actions = decide.locator(".ds-review-decision__actions");
  await expect(actions.getByRole("button")).toHaveText(["Reject"]);
  await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\. Its copy holds files that are not in the commit on its branch/);
  await checkDesign(page, "task, ready for review, with a file the checks left");
  await shot(page, "u14-ready.png");
  expect(fs.existsSync(path.join(copy, "check-report.txt"))).toBe(true);

  // The owner looks at the file and removes it from the copy: the checks are then about exactly what the branch holds.
  fs.rmSync(path.join(copy, "check-report.txt"));
  await page.reload();
  await expect(decide.getByTestId("evidence-words")).toHaveText(/^Evidence is current: the checks passed on commit [0-9a-f]{7}, the commit Accept keeps\.$/);
  // Accept first, the one primary action, and Reject, plain, at the far end. Both are marked as never hidden.
  await expect(actions.getByRole("button")).toHaveText(["Accept", "Reject"]);
  await expect(actions.locator("[data-ds-critical]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Accept" })).toHaveClass(/ds-button--primary/);
  await expect(page.getByRole("button", { name: "Reject" })).not.toHaveClass(/ds-button--primary/);
  const field = (await decide.getByLabel("Note (optional)").boundingBox())!;
  expect(field.y, "the note comes before the actions").toBeLessThan((await actions.boundingBox())!.y);
  await checkDesign(page, "task, ready for review, evidence current");
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);

  // While the decision is sent (held here until that is seen), Accept says Accepting, is busy and keeps the focus, and only Reject is unavailable.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/tasks\/\d+\/accept$/, async (route) => {
    await held;
    await route.continue();
  });
  const accept = actions.getByRole("button", { name: "Accept" });
  await accept.click();
  const accepting = actions.getByRole("button", { name: "Accepting" });
  await expect(accepting).toHaveAttribute("aria-busy", "true");
  await expect(accepting).toBeEnabled();
  await expect(accepting).toBeFocused();
  await expect(actions.getByRole("button", { name: "Reject" })).toBeDisabled();
  release();
  // Decided: the result takes the place of the actions and the note, and the focus moves to the section's heading.
  await expect(page.getByTestId("task-status")).toHaveText(/^Accepted\. /);
  await page.unroute(/\/api\/tasks\/\d+\/accept$/);
  await expect(page.getByRole("button", { name: /^(Accept|Reject)$/ })).toHaveCount(0);
  await expect(decide.locator(".ds-review-decision__actions")).toHaveCount(0);
  await expect(decide.getByLabel("Note (optional)")).toHaveCount(0);
  await expect(decide.locator(".ds-review-decision__result .ds-badge").first()).toHaveText("Accepted");
  await expect(decide.getByRole("heading", { name: "Your decision" })).toBeFocused();
  // The evidence line was about a decision still to make: it goes with the buttons.
  await expect(decide.locator(".ds-review-decision__source")).toHaveText(["Checks", "Review"]);
  await expect(page.getByTestId("branch")).toHaveText(task.branch);
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
  expect(fs.existsSync(path.join(repos.checked, "node_modules")), "nor is the ignored cache").toBe(false);

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
  await expect(page.getByTestId("decision").locator(".ds-review-decision__result .ds-badge").first()).toHaveText("Rejected");
  await expect(page.getByRole("heading", { name: "Your decision" })).toBeFocused();
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
  await checkNext(page, "permissions, with decisions");
  expect(foreign).toEqual([]);
});

test("LIVE: on a run's screen each built task is accepted or rejected from its row, and the run is done once the last is decided", async ({ page, botbench, repos }) => {
  test.setTimeout(600_000);
  await signIn(page, botbench);
  await startRunIn(page, repos.run, "Plan exactly two tasks: create one.txt, and create two.txt. Do not run any command; the README is all there is to read.");
  const runId = await openRunId(page);
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
  // Accept and Reject are on each row, and neither is the screen's primary action: it is repeated for each task. This
  // repository has no checks set up, so each row says so and its accept is the one without verification.
  for (const row of await rows.all()) {
    await expect(row.getByTestId("evidence-words")).toHaveText("No checks are set up for this repository, so nothing verified this work. You can accept it without verification.");
    await expect(row.getByRole("button", { name: /^Accept without verification task \d+$/ })).not.toHaveClass(/ds-button--primary/);
    await expect(row.getByRole("button", { name: /^Reject/ })).toBeVisible();
  }
  await checkRebuilt(page, "run, ready for review");
  await shot(page, "u14-run-ready.png");

  await rows.nth(0).getByRole("button", { name: /^Accept without verification/ }).click();
  // No check ran on it, so the row says the accept as what it was, and does not draw it as a success.
  await expect(rows.nth(0).locator(RUN_TASK_STATE)).toHaveText("Accepted without verification");
  await expect(rows.nth(0).locator(RUN_TASK_STATE)).toHaveAttribute("data-tone", "neutral");
  await expect(rows.nth(0).getByTestId("merge-command")).toHaveValue(`git merge ${branches[0]}`);
  await expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./);

  await rows.nth(1).getByRole("button", { name: /^Reject/ }).click();
  const asking = page.getByRole("alertdialog");
  await expect(asking.getByLabel("Keep the branch")).toBeChecked();
  await checkRebuilt(page, "run, reject a task");
  await asking.getByRole("button", { name: "Reject" }).click();
  await expect(rows.nth(1).locator(RUN_TASK_STATE)).toHaveText("Rejected");
  await expect(page.getByTestId("run-status")).toHaveText(/^Done\./);
  await checkRebuilt(page, "run, done");
  await shot(page, "u14-run-done.png");

  // Both branches are kept, both copies are gone.
  expect(botbenchBranches(repos.run).sort()).toEqual([...branches].sort());
  expect(worktreeCount(repos.run)).toBe(1);
});
