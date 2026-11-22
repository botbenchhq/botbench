import fs from "node:fs";
import path from "node:path";
import { checkoutState, initRepo, worktreeCount, write } from "../test/support/repo.ts";
import type { Page } from "@playwright/test";
import { checkDesign, copyShot, expect, SHOTS, signIn, test, watchRequests } from "./helpers.ts";

// Runs and the plan gate in the real client, at a phone's size, against a real Smelt process, a real temporary
// repository and, for the test marked LIVE, the owner's Claude Code as the planner on its cheapest model.

/** A real repository beside the test's Smelt home, with the owner part-way through their own work. */
function sourceRepo(smeltHome: string): string {
  const repo = path.join(path.dirname(smeltHome), "sample-repo");
  initRepo(repo);
  write(repo, "README.md", "# Sample\nthe owner is half-way through this line\n");
  return repo;
}

/**
 * Keep a full-page screenshot when SMELT_SHOTS is set. For a full-page capture Chrome is resized, and it then leaves an
 * inline size on a textarea that sizes itself to its content; that is the capture's doing and not the client's, so
 * what the capture added is taken off again before the design check looks for inline styles.
 */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.querySelectorAll("[style]").forEach((el) => el.setAttribute("data-styled-before-shot", "")));
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  await page.evaluate(() => {
    document.querySelectorAll("[style]:not([data-styled-before-shot])").forEach((el) => el.removeAttribute("style"));
    document.querySelectorAll("[data-styled-before-shot]").forEach((el) => el.removeAttribute("data-styled-before-shot"));
  });
}

test("LIVE: start a run from a prompt, see the plan arrive without a reload, edit a title, delete a task, approve, see it build, and cancel it; every screen follows the design system", async ({ page, smelt }) => {
  const foreign = watchRequests(page, smelt);
  const repo = sourceRepo(smelt.home);
  const before = checkoutState(repo);
  await signIn(page, smelt);
  // A mark on the page that a reload would wipe out.
  await page.evaluate(() => ((window as unknown as { smeltLoadedOnce: boolean }).smeltLoadedOnce = true));

  // The navigation lists the destinations; starting something new is a button in its list's view.
  const nav = page.getByRole("navigation", { name: "Screens" });
  await expect(nav.getByRole("link")).toHaveText(["Chat", "Runs", "Tasks", "Permissions"]);
  await nav.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText("Runs");
  await expect(page.getByTestId("run-list-state")).toHaveText("No runs yet");
  await checkDesign(page, "runs, none yet");
  await page.getByRole("link", { name: "New run" }).click();
  await expect(page.getByRole("heading", { name: "New run", level: 1 })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await checkDesign(page, "new run, empty");

  // The repository is checked as it is typed; its pre-approved commands are confirmed here, for this run.
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  const prompt = "Add three files: a.txt containing a, b.txt containing b, c.txt containing c. Plan exactly three tasks, one per file. Do not run any command and do not read more than the README.";
  await page.getByLabel("Prompt").fill(prompt);
  await expect(page.getByRole("heading", { name: "Allowed for this run" })).toBeVisible();
  await expect(page.getByTestId("preapproved-none")).toBeVisible();
  await page.getByLabel("Add a command").fill("npm test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("preapproved-list").getByRole("listitem")).toHaveText([/npm test/]);
  await expect(page.locator(".gw-button--primary")).toHaveCount(1);
  await checkDesign(page, "new run, filled in");
  await shot(page, "u11-new-run.png");
  await page.getByRole("button", { name: "Start run" }).click();

  // The run screen: its state in words, then the planner's transcript as it happens.
  await expect(page.getByRole("heading", { name: /^Run \d+$/, level: 1 })).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText(/^(Queued|Planning)\./);
  await expect(page.getByTestId("run-repo")).toHaveText(repo);
  await expect(page.getByTestId("run-preapproved")).toContainText("npm test");
  await expect(page.locator('[data-event="user_prompt"]')).toContainText("a.txt containing a", { timeout: 60_000 });
  // The planning prompt is Smelt's, with the owner's words inside it: the row does not say the owner wrote it.
  await expect(page.locator('[data-event="user_prompt"] .gw-message__label')).toHaveText("Smelt, to Claude Code");
  await checkDesign(page, "run, planning");
  // While the planner works there is no plan to approve, and nothing offers to.
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();

  // The planner is read-only: a command it wants to run asks the owner, and is declined here, as an owner could.
  const approve = page.getByRole("button", { name: /^Approve \d+ tasks?$/ });
  await expect(async () => {
    const pending = (await (await page.request.get(`${smelt.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] };
    for (const approval of pending.approvals) await page.request.post(`${smelt.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "No commands while planning." } });
    await expect(approve).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 240_000, intervals: [1_000] });
  expect(await page.evaluate(() => (window as unknown as { smeltLoadedOnce?: boolean }).smeltLoadedOnce), "the plan arrived without a reload").toBe(true);
  await expect(page.getByTestId("run-status")).toHaveText(/^Plan ready for review\./);
  const plan = page.getByRole("list", { name: "Plan" });
  const rows = plan.locator(":scope > li");
  await expect(rows).toHaveCount(3);
  await expect(approve).toHaveText("Approve 3 tasks");
  // Every task shows its acceptance criteria.
  for (const row of await rows.all()) await expect(row.getByRole("listitem").first()).toBeVisible();
  await expect(page.locator(".gw-button--primary")).toHaveCount(1);
  // How the plan was made is one tap away, folded, under the plan it produced.
  const made = page.locator("details").filter({ has: page.locator("summary", { hasText: "How the plan was made" }) }).first();
  await expect(made).not.toHaveAttribute("open");
  await expect(made.locator('[data-event="user_prompt"]')).toBeHidden();
  await checkDesign(page, "run, plan awaiting approval");
  await copyShot(page, "run-plan-review");
  await shot(page, "u11-plan.png");

  // Edit the first task's title in its row.
  await rows.nth(0).getByRole("button", { name: /^Edit task 1/ }).click();
  const title = page.getByLabel("Task 1 title");
  await expect(title).toBeFocused();
  await expect(page.getByLabel("Task 1 acceptance criteria")).not.toHaveValue("");
  await checkDesign(page, "run, one task being edited");
  await title.fill("");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(rows.nth(0)).toContainText("Give the task a title.");
  await title.fill("Create a.txt <b>first</b>");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(rows.nth(0).locator(".gw-editable-list__text")).toContainText("Create a.txt <b>first</b>");
  await expect(rows.nth(0).locator("b")).toHaveCount(0);
  await expect(approve).toHaveText("Approve 3 tasks");

  // Delete the third task: the main action's count follows, and the delete can be undone for a while.
  await rows.nth(2).getByRole("button", { name: /^Delete task 3/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(approve).toHaveText("Approve 2 tasks");
  await expect(page.getByRole("status").filter({ hasText: "Task 3 deleted from the plan." })).toBeVisible();
  await checkDesign(page, "run, after a delete");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows).toHaveCount(3);
  await expect(approve).toHaveText("Approve 3 tasks");
  await rows.nth(2).getByRole("button", { name: /^Delete task 3/ }).click();
  await expect(approve).toHaveText("Approve 2 tasks");

  // Cancelling asks first, and keeping the run changes nothing.
  await page.getByRole("button", { name: "Cancel run" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Cancel this run?");
  await checkDesign(page, "run, cancel dialog");
  await dialog.getByRole("button", { name: "Keep run" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(approve).toHaveText("Approve 2 tasks");

  // Approve: the run says in plain words that it builds, one task at a time, and the owner can still cancel it.
  await approve.click();
  await expect(page.getByTestId("run-status")).toHaveText(/^Working\. Smelt builds the tasks one at a time/);
  const queued = page.getByTestId("run-tasks").getByRole("listitem").filter({ has: page.locator(".gw-run-status") });
  await expect(queued).toHaveCount(2);
  await expect(queued.nth(0)).toContainText("Create a.txt <b>first</b>");
  await expect(page.getByRole("button", { name: /Approve|Request changes|Edit|Delete|Add task|Undo/ })).toHaveCount(0);
  await expect(page.locator(".gw-button--primary")).toHaveCount(0);
  await checkDesign(page, "run, approved and building");

  // Cancelled at once, so this test builds nothing: the turn that may have begun is stopped.
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("run-status")).toHaveText(/^Cancelled\./);
  await expect(queued.locator(".gw-badge").filter({ hasText: /^(Queued|Working)$/ })).toHaveCount(0, { timeout: 60_000 });

  // A task of the run says on its own screen where it stands.
  await queued.nth(1).getByRole("link").click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Cancelled\. The run was cancelled before this task started\.$/);
  await checkDesign(page, "task of a cancelled run");

  // The runs list and the tasks list both know it.
  await nav.getByRole("link", { name: "Runs", exact: true }).click();
  const listed = page.getByTestId("run-list").getByRole("listitem");
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("Add three files");
  await expect(listed).toContainText("Cancelled");
  await checkDesign(page, "runs, one run");
  await copyShot(page, "runs");
  await shot(page, "u11-runs.png");
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByTestId("task-list").getByRole("listitem")).toHaveCount(2);

  // Nothing of the owner's was touched.
  expect(checkoutState(repo)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { smeltLoadedOnce?: boolean }).smeltLoadedOnce)).toBe(true);
  expect(foreign).toEqual([]);
});

test("a spec file that does not exist is reported in words and nothing starts; a prompt and a spec file together are not sent", async ({ page, smelt }) => {
  const repo = sourceRepo(smelt.home);
  await signIn(page, smelt);
  await page.goto(`${smelt.base}/#/runs/new`);
  await expect(page.getByRole("heading", { name: "New run", level: 1 })).toBeVisible();
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");

  // Neither a prompt nor a spec file: said in words, and nothing is sent.
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("alert")).toHaveText(/The run was not started\. Give a prompt or the path of a spec file\./);

  const missing = path.join(path.dirname(smelt.home), "no-such-spec.md");
  await page.getByLabel("Spec file path").fill(missing);
  await page.getByLabel("Prompt").fill("and a prompt as well");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("alert")).toHaveText(/The run was not started\. Give a prompt or a spec file, not both\./);

  await page.getByLabel("Prompt").fill("");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("alert")).toContainText(`The run was not started. The spec file ${missing} does not exist.`);
  await expect(page.getByRole("heading", { name: "New run", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start run" })).toBeEnabled();
  await checkDesign(page, "new run, spec file refused");

  // Nothing started: no run is listed, and no planner was launched.
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByTestId("run-list-state")).toHaveText("No runs yet");
  const runs = (await (await page.request.get(`${smelt.base}/api/runs`)).json()) as { runs: unknown[] };
  expect(runs.runs).toEqual([]);
  expect(worktreeCount(repo)).toBe(1);
});
