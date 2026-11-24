import fs from "node:fs";
import path from "node:path";
import { checkoutState, initRepo, worktreeCount, write } from "../test/support/repo.ts";
import type { Page } from "@playwright/test";
import { allowCommands, askCancelRun, checkDesign, checkRebuilt, chooseRepository, closeContext, copyShot, expect, filledButtons, messageBox, nav, offersCancelRun, openRow, openRunId, openWork, RUN_TASK_STATE, runSteps, runTaskRows, SHOTS, signIn, test, watchRequests, checkWords, workRows, workState } from "./helpers.ts";

// Runs and the plan gate in the real client, at a phone's size, against a real Botbench process, a real temporary
// repository and, for the test marked LIVE, the owner's Claude Code as the planner on its cheapest model.

/** A real repository beside the test's Botbench home, with the owner part-way through their own work. */
function sourceRepo(botbenchHome: string): string {
  const repo = path.join(path.dirname(botbenchHome), "sample-repo");
  initRepo(repo);
  write(repo, "README.md", "# Sample\nthe owner is half-way through this line\n");
  return repo;
}

/**
 * Keep a full-page screenshot when BOTBENCH_SHOTS is set. For a full-page capture Chrome is resized, and it then leaves an
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

test("LIVE: start a run from a prompt, see the plan arrive without a reload, edit a title, delete a task, approve, see it build, and cancel it; every screen follows the design system", async ({ page, botbench }) => {
  const foreign = watchRequests(page, botbench);
  const repo = sourceRepo(botbench.home);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  // A mark on the page that a reload would wipe out.
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));

  // The navigation, the composer for a new run and the run's allowed list are drawn without a model: see "the navigation lists
  // the destinations…" below. Here the run is started from the Runs view, as an owner would.
  await openWork(page);
  await page.getByRole("link", { name: "New run" }).click();
  await expect(page.getByRole("button", { name: "Choose a Repository" })).toBeAttached();

  // The repository is checked as it is typed; its pre-approved commands are confirmed here, for this run.
  await chooseRepository(page, repo);
  await allowCommands(page, ["npm test"]);
  await openRow(page, "Allowed commands");
  await expect(page.getByTestId("preapproved-list").getByRole("listitem")).toHaveText([/npm test/]);
  await closeContext(page);
  const prompt = "Add three files: a.txt containing a, b.txt containing b, c.txt containing c. Plan exactly three tasks, one per file. Do not run any command and do not read more than the README.";
  await messageBox(page).fill(prompt);
  await shot(page, "u11-new-run.png");
  await page.getByRole("button", { name: "Send" }).click();

  // The run screen: its state in words, then the planner's transcript as it happens.
  // The run's one h1 is its title, the owner's own words; the bar and the tab name it by its number.
  const runId = await openRunId(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Add three files");
  await expect(page).toHaveTitle(`Run ${runId} \u2013 Botbench`);
  await expect(page.getByTestId("run-status")).toHaveText(/^(Queued|Planning)\./);
  await expect(page.getByTestId("run-repo")).toHaveText(repo);
  await expect(page.getByTestId("run-preapproved")).toContainText("npm test");
  await expect(page.locator('[data-event="user_prompt"]')).toContainText("a.txt containing a", { timeout: 60_000 });
  // The planning prompt is Botbench's, with the owner's words inside it: the row does not say the owner wrote it.
  await expect(page.locator('[data-event="user_prompt"] .ds-message__label')).toHaveText("Botbench, to Claude Code");
  // The run's stations, in order, each with its state in words: the run is at Plan, and nothing has been built.
  const stations = runSteps(page);
  await expect(stations.locator("[data-step=name]")).toHaveText(["Plan", "Build", "Decide"]);
  await expect(stations.nth(1)).toHaveAttribute("data-state", "not-started");
  await expect(stations.nth(2)).toHaveAttribute("data-state", "not-started");
  await checkRebuilt(page, "run, planning");
  // While the planner works there is no plan to approve, and nothing offers to.
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  expect(await offersCancelRun(page), "the run's menu offers Cancel run").toBe(true);

  // The planner is read-only: a command it wants to run asks the owner, and is declined here, as an owner could.
  const approve = page.getByRole("button", { name: /^Approve \d+ tasks?$/ });
  await expect(async () => {
    const pending = (await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] };
    for (const approval of pending.approvals) await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "No commands while planning." } });
    await expect(approve).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 240_000, intervals: [1_000] });
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "the plan arrived without a reload").toBe(true);
  await expect(page.getByTestId("run-status")).toHaveText(/^Plan ready for review\./);
  await expect(stations.nth(0)).toHaveAttribute("data-state", "waiting");
  await expect(stations.nth(0)).toHaveAttribute("aria-current", "step");
  await expect(stations.nth(0).locator("[data-step=words]")).toHaveText("Waiting for your approval");
  const plan = page.getByRole("list", { name: "Plan" });
  const rows = plan.locator(":scope > li");
  await expect(rows).toHaveCount(3);
  await expect(approve).toHaveText("Approve 3 tasks");
  // Every task shows its acceptance criteria.
  for (const row of await rows.all()) await expect(row.getByRole("listitem").first()).toBeVisible();
  // Approve is the screen's one filled button.
  expect(await filledButtons(page)).toEqual(["Approve 3 tasks"]);
  // How the plan was made is one tap away, folded, under the plan it produced.
  const made = page.getByTestId("plan-made");
  await expect(made.getByRole("button", { name: "How the plan was made" })).toHaveAttribute("aria-expanded", "false");
  await expect(made.locator('[data-event="user_prompt"]')).toBeHidden();
  await checkRebuilt(page, "run, plan awaiting approval");
  await copyShot(page, "run-plan-review");
  await shot(page, "u11-plan.png");

  // Edit the first task's title in its row.
  await rows.nth(0).getByRole("button", { name: /^Edit task 1/ }).click();
  const title = page.getByLabel("Task 1 title");
  await expect(title).toBeFocused();
  await expect(page.getByLabel("Task 1 acceptance criteria")).not.toHaveValue("");
  await checkRebuilt(page, "run, one task being edited");
  await title.fill("");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(rows.nth(0)).toContainText("Give the task a title.");
  await title.fill("Create a.txt <b>first</b>");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(rows.nth(0).getByTestId("plan-task-text")).toContainText("Create a.txt <b>first</b>");
  await expect(rows.nth(0).locator("b")).toHaveCount(0);
  await expect(approve).toHaveText("Approve 3 tasks");

  // Delete the third task: the main action's count follows, and the delete can be undone for a while.
  await rows.nth(2).getByRole("button", { name: /^Delete task 3/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(approve).toHaveText("Approve 2 tasks");
  await expect(page.getByRole("status").filter({ hasText: "Task 3 deleted from the plan." })).toBeVisible();
  await checkRebuilt(page, "run, after a delete");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows).toHaveCount(3);
  await expect(approve).toHaveText("Approve 3 tasks");
  await rows.nth(2).getByRole("button", { name: /^Delete task 3/ }).click();
  await expect(approve).toHaveText("Approve 2 tasks");

  // Cancelling asks first, and keeping the run changes nothing.
  const dialog = await askCancelRun(page);
  await expect(dialog).toContainText("Cancel this run?");
  await checkRebuilt(page, "run, cancel dialog");
  await dialog.getByRole("button", { name: "Keep run" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(approve).toHaveText("Approve 2 tasks");

  // Approve: the run says in plain words that it builds, one task at a time, and the owner can still cancel it.
  await approve.click();
  await expect(page.getByTestId("run-status")).toHaveText(/^Working\. Botbench builds the tasks one at a time/);
  const queued = runTaskRows(page);
  await expect(queued).toHaveCount(2);
  await expect(queued.nth(0)).toContainText("Create a.txt <b>first</b>");
  await expect(page.getByRole("button", { name: /Approve|Request changes|Edit|Delete|Add task|Undo/ })).toHaveCount(0);
  expect(await filledButtons(page)).toEqual([]);
  await expect(stations.nth(0)).toHaveAttribute("data-state", "done");
  await expect(stations.nth(1)).toHaveAttribute("data-state", /^(running|waiting)$/);
  await expect(stations.nth(1)).toHaveAttribute("aria-current", "step");
  await checkRebuilt(page, "run, approved and building");

  // Cancelled at once, so this test builds nothing: the turn that may have begun is stopped.
  await (await askCancelRun(page)).getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("run-status")).toHaveText(/^Cancelled\./);
  // The timeline has no state for a station that was cancelled, so a cancelled run shows none; its state is in words above.
  await expect(stations).toHaveCount(0);
  await expect(queued.locator(RUN_TASK_STATE).filter({ hasText: /^(Queued|Working)$/ })).toHaveCount(0, { timeout: 60_000 });

  // A task of the run says on its own screen where it stands.
  await queued.nth(1).getByRole("link").first().click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Cancelled\. The run was cancelled before this task started\.$/);
  await checkDesign(page, "task of a cancelled run");

  // Work knows it: the run, once, as Cancelled. Its tasks are on its own screen.
  await openWork(page);
  const listed = workRows(page);
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("Add three files");
  await expect(workState(listed)).toHaveText("Cancelled");
  await checkWords(page, "work, one run");
  await copyShot(page, "work");
  await shot(page, "u11-runs.png");

  // Nothing of the owner's was touched.
  expect(checkoutState(repo)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);
  expect(foreign).toEqual([]);
});

test("the navigation lists the destinations; New run opens the composer asking for a repository, and the run's allowed list starts empty and takes a command", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  await signIn(page, botbench);
  // Starting something new is a button in Work, not a destination.
  await expect(nav(page).getByRole("link")).toHaveText(["Home", "Work", "Chat"]);
  await openWork(page);
  await expect(page.getByTestId("work-none")).toHaveText("No work yet. Each chat, run and task you start is listed here.");
  await checkWords(page, "work, none yet");
  await page.getByRole("link", { name: "New run" }).click();
  await closeContext(page);
  await expect(page.getByRole("button", { name: "Send" })).toHaveAccessibleDescription("Choose a repository");
  await checkDesign(page, "composer, a new run with no repository");

  await chooseRepository(page, repo);
  const sheet = await openRow(page, "Allowed commands");
  await expect(sheet.getByRole("region", { name: "Allowed for this run" })).toBeVisible();
  await expect(page.getByTestId("preapproved-none")).toBeVisible();
  await page.getByLabel("Add a command").fill("npm test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("preapproved-list").getByRole("listitem")).toHaveText([/npm test/]);
  await closeContext(page);
  await messageBox(page).fill("Add a.txt containing a.");
  await expect(page.locator(".ds-button--primary")).toHaveCount(1);
  await checkDesign(page, "composer, a run filled in");
});

test("a spec file that does not exist is reported in words and nothing starts; a message and a spec file together are not sent", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/runs/new`);
  await chooseRepository(page, repo);
  await closeContext(page);
  const send = page.getByRole("button", { name: "Send" });

  // Neither a message nor a spec file: Send puts the cursor in the box, and nothing is sent.
  await send.click();
  await expect(messageBox(page)).toBeFocused();

  const missing = path.join(path.dirname(botbench.home), "no-such-spec.md");
  const sheet = await openRow(page, "Spec file");
  await sheet.getByLabel("Spec file path").fill(missing);
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
  await expect(sheet.locator('[data-row="spec"] .ds-context-list__value')).toHaveText("no-such-spec.md");
  await closeContext(page);
  await messageBox(page).fill("and a prompt as well");
  await expect(send).toBeDisabled();
  await expect(send).toHaveAccessibleDescription("Give a message or a spec file, not both.");

  await messageBox(page).fill("");
  await send.click();
  await expect(page.getByRole("alert")).toContainText(`The run was not started. The spec file ${missing} does not exist.`);
  await expect(page).toHaveURL(/#\/turn$/);
  await expect(send).toBeEnabled();
  await checkDesign(page, "composer, spec file refused");

  // Nothing started: no run is listed, and no planner was launched.
  await openWork(page);
  await expect(page.getByTestId("work-none")).toHaveText("No work yet. Each chat, run and task you start is listed here.");
  const runs = (await (await page.request.get(`${botbench.base}/api/runs`)).json()) as { runs: unknown[] };
  expect(runs.runs).toEqual([]);
  expect(worktreeCount(repo)).toBe(1);
});
