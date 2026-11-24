import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import type { Config } from "../src/config.ts";
import { decideTask } from "../src/engine/decision.ts";
import { createDeliveries } from "../src/engine/delivery.ts";
import { approvePlan, createRun, storePlan } from "../src/engine/run.ts";
import { moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { loadGhCapture, replayGitHub } from "../test/support/replay-github.ts";
import { git, initRepo, write } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkLayout, checkWords, expect, filledButtons, openRunMenu, signIn, SHOTS, watchRefused } from "./helpers.ts";

// The run screen rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), at a run's own address, in the real client against a
// real Botbench process with its real content security policy. No model turn. Before Botbench starts, runs are put in
// its real store through the engine itself, at the plan gate. The first two tests start Botbench with a Claude Code
// that replays a turn recorded from a real session and holds it (e2e/serve-replayed-build.ts, the owner's approved
// exception), so approving a plan really starts a build, which is then still under way while the test looks, and
// Request changes really starts the planner again. The third shows a run whose task was accepted and delivered through
// the engine, with the pull-request step replaying output captured once from the real gh (as e2e/delivery.e2e.ts does).

const PLAN = [
  { title: "Write the exporter", criteria: ["It writes a CSV file", "A comma inside a field is escaped"] },
  { title: "Add the export button", criteria: ["The button downloads the file the exporter wrote"] },
];

interface Seeded {
  home: string;
  repo: string;
  /** A manual run whose plan waits for the owner. */
  manual: number;
  /** A semi-autonomous run at the same gate. */
  semi: number;
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench; refused: string[] }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-run-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo-billing");
    const baseCommit = initRepo(repo, { "README.md": "# Billing\n" });
    const db = openStore(home);
    const atGate = (mode: "manual" | "semi", prompt: string): number => {
      const run = createRun(db, { repo, prompt, baseCommit, mode, preapproved: ["npm test"] });
      storePlan(db, run.id, PLAN);
      return run.id;
    };
    const manual = atGate("manual", "Plan the billing export");
    const semi = atGate("semi", "Plan the invoice reminders");
    db.close();
    await use({ home, repo: fs.realpathSync(repo), manual, semi });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({
      home: seeded.home,
      entry: path.resolve(import.meta.dirname, "serve-replayed-build.ts"),
      // The setup command makes each task's change, as a builder would; the replayed turn writes nothing.
      settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [seeded.repo]: { setup: ["printf 'hello\\n' > hello.txt"], checks: ["test -f hello.txt"] } } },
    });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
  refused: async ({ page }, use) => use(await watchRefused(page)),
});

const steps = (page: Page) => page.getByRole("list", { name: /^Steps of run \d+$/ }).getByRole("listitem");
const planRows = (page: Page) => page.getByRole("list", { name: "Plan" }).locator(":scope > li");
const taskRows = (page: Page) => page.getByTestId("run-tasks").locator(":scope > li");
const stored = async <T>(page: Page, botbench: Botbench, id: number): Promise<T> => (await (await page.request.get(`${botbench.base}/api/runs/${id}`)).json()) as T;

/** A picture of the screen at `<BOTBENCH_SHOTS>/<name>.png` when that folder is named. */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("a plan that waits is cards edited in place with the decision in the inspector; Approve starts the build, the tasks are rows in the product's words, and Cancel run asks first and then cancels", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    await page.goto(`${botbench.base}/#/runs/${seeded.manual}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan the billing export");
    await expect(page).toHaveTitle(`Run ${seeded.manual} – Botbench`);
    await expect(page.getByTestId("run-state")).toHaveText("Plan ready for review");
    await expect(page.getByTestId("run-status")).toHaveText(/^Plan ready for review\. Edit the tasks if you need to, then approve the plan\./);
    await expect(page.getByRole("link", { name: "Plan the billing export" })).toHaveAttribute("aria-current", "page");
    // Three real steps, the run at the first, which waits for the owner.
    await expect(steps(page).locator("[data-step=name]")).toHaveText(["Plan", "Build", "Decide"]);
    await expect(steps(page).nth(0)).toHaveAttribute("aria-current", "step");
    await expect(steps(page).nth(0).locator("[data-step=words]")).toHaveText("Waiting for your approval");
    await expect(steps(page).nth(1)).toHaveAttribute("data-state", "not-started");

    // The plan is the content: each task a card with its title and its acceptance criteria.
    await expect(planRows(page)).toHaveCount(2);
    await expect(planRows(page).nth(0).getByTestId("plan-task-text")).toContainText("Write the exporter");
    await expect(page.getByRole("list", { name: "Acceptance criteria of task 1" }).getByRole("listitem")).toHaveText(PLAN[0]!.criteria);

    // The decision stands in the inspector, right of the plan, with Approve as the screen's one filled button.
    const decision = page.getByTestId("plan-decision");
    await expect(decision.getByRole("heading")).toHaveText("Approve this plan?");
    const actions = decision.getByRole("button");
    await expect(actions).toHaveText(["Approve 2 tasks", "Request changes"]);
    const [card, plan] = [(await decision.boundingBox())!, (await page.getByRole("list", { name: "Plan" }).boundingBox())!];
    expect(card.x).toBeGreaterThan(plan.x + plan.width);
    expect(await filledButtons(page)).toEqual(["Approve 2 tasks"]);
    expect(await decision.getByRole("button", { name: "Approve 2 tasks" }).evaluate((button) => getComputedStyle(button).backgroundColor)).toBe("rgb(124, 183, 255)");
    // What the run was started with is under it, in the product's words.
    await expect(page.getByTestId("run-mode")).toHaveText(/^Manual: you approve the plan and decide on each result\./);
    await expect(page.getByTestId("run-repo")).toHaveText(seeded.repo);
    await expect(page.getByTestId("run-delivery")).toHaveText("Its branch is kept on this Mac");
    await expect(page.getByTestId("run-approval-limit")).toHaveText("Off. Requests wait for your answer, however long that takes.");
    await expect(page.getByTestId("run-preapproved").getByRole("listitem")).toHaveText(["npm test"]);
    await checkLayout(page, 32, "run, plan waiting, 1440, dark");
    await checkWords(page, "run, plan waiting");
    await shot(page, "run-plan-1440-dark");

    // Light, as Settings stores it.
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
    await page.reload();
    await expect(planRows(page)).toHaveCount(2);
    expect(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector("[data-testid=plan-decision]")!).backgroundColor])).toEqual(["rgb(245, 246, 247)", "rgb(255, 255, 255)"]);
    await shot(page, "run-plan-1440-light");
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
    await page.reload();
    await expect(planRows(page)).toHaveCount(2);

    // Edit a task in place: the card becomes its editor, and what is saved is the plan the server holds.
    await planRows(page).nth(0).getByRole("button", { name: /^Edit task 1/ }).click();
    const title = page.getByLabel("Task 1 title");
    await expect(title).toBeFocused();
    await expect(page.getByLabel("Task 1 acceptance criteria")).toHaveValue(PLAN[0]!.criteria.join("\n"));
    // A decision while a task is open is refused in words: the task is not part of the plan yet.
    await actions.filter({ hasText: "Approve" }).click();
    await expect(decision.getByRole("alert")).toHaveText("Save or cancel the task you are editing first: it is not part of the plan yet.");
    await title.fill("");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(planRows(page).nth(0)).toContainText("Give the task a title.");
    await checkLayout(page, 32, "run, a task being edited");
    await title.fill("Write the CSV exporter <b>first</b>");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(planRows(page).nth(0).getByTestId("plan-task-text")).toContainText("Write the CSV exporter <b>first</b>");
    await expect(planRows(page).nth(0).locator("b")).toHaveCount(0);
    await expect(planRows(page).nth(0).getByRole("button", { name: /^Edit task 1/ })).toBeFocused();
    expect((await stored<{ plan: { title: string }[] }>(page, botbench, seeded.manual)).plan[0]!.title).toBe("Write the CSV exporter <b>first</b>");

    // Add a task, then delete it: the count on Approve follows, and the delete can be undone for a while.
    await page.getByRole("button", { name: "Add task" }).click();
    await page.getByLabel("New task title").fill("Write the release note");
    await page.getByLabel("New task acceptance criteria").fill("It names the export");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(actions.filter({ hasText: "Approve" })).toHaveText("Approve 3 tasks");
    await planRows(page).nth(2).getByRole("button", { name: /^Delete task 3/ }).click();
    await expect(actions.filter({ hasText: "Approve" })).toHaveText("Approve 2 tasks");
    await expect(page.getByRole("status").filter({ hasText: "Task 3 deleted from the plan." })).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(planRows(page)).toHaveCount(3);
    await planRows(page).nth(2).getByRole("button", { name: /^Delete task 3/ }).click();
    await expect(planRows(page)).toHaveCount(2);

    // Request changes needs its feedback, and says so.
    await actions.filter({ hasText: "Request changes" }).click();
    await expect(decision.getByRole("alert")).toHaveText("Changes were not requested. Say what the planner should change.");
    await expect(page.getByLabel("Feedback for the planner")).toBeVisible();

    // The run's controls are a menu. A manual run has no stricter mode, so the menu holds Cancel run alone.
    const menu = await openRunMenu(page);
    await expect(menu.getByRole("menuitem")).toHaveText(["Cancel run"]);
    await shot(page, "run-plan-1440-dark-menu");
    await page.keyboard.press("Escape");

    // Approve: the build really starts (the replayed builder holds its first turn), without a reload.
    await actions.filter({ hasText: "Approve" }).click();
    await expect(page.getByTestId("run-status")).toHaveText(/^Working\. Botbench builds the tasks one at a time/);
    await expect(page.getByTestId("run-state")).toHaveText("Working");
    await expect(page.getByTestId("plan-decision")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Approve|Request changes|Edit task|Delete task|Add task|Undo/ })).toHaveCount(0);
    await expect(steps(page).nth(0)).toHaveAttribute("data-state", "done");
    await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");
    await expect(steps(page).nth(1).locator("[data-step=words]")).toHaveText("Working · 0 of 2 tasks finished");
    await expect(taskRows(page)).toHaveCount(2);
    await expect(taskRows(page).nth(0).getByTestId("run-task-state")).toHaveText("Working", { timeout: 30_000 });
    await expect(taskRows(page).nth(0).getByTestId("run-task-branch")).toHaveText("Claude Code is working; open it to watch", { timeout: 30_000 });
    await expect(taskRows(page).nth(1).getByTestId("run-task-state")).toHaveText("Queued");
    await expect(taskRows(page).nth(1).getByTestId("run-task-branch")).toHaveText("Starts when the tasks before it have finished");
    const { tasks } = await stored<{ tasks: { id: number }[] }>(page, botbench, seeded.manual);
    await expect(taskRows(page).nth(0).getByRole("link")).toHaveAttribute("href", `#/tasks/${tasks[0]!.id}`);
    // Nothing on the screen is filled as a primary action now: there is nothing to decide.
    expect(await filledButtons(page)).toEqual([]);
    await checkLayout(page, 32, "run, building");
    await checkWords(page, "run, building");
    await shot(page, "run-building-1440-dark");

    // Cancel run asks first, in the product's words, with the focus on the button that changes nothing.
    await (await openRunMenu(page)).getByRole("menuitem", { name: "Cancel run" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this run?" });
    await expect(dialog).toContainText("Tasks that have finished keep their branches. The task being built is stopped, and what it did so far is committed to its branch. Tasks that have not started are not built. A cancelled run cannot be started again.");
    await expect(dialog.getByRole("button")).toHaveText(["Keep run", "Cancel run"]);
    await expect(dialog.getByRole("button", { name: "Keep run" })).toBeFocused();
    await checkLayout(page, 32, "run, the cancel dialog");
    await checkWords(page, "run, the cancel dialog");
    await shot(page, "run-cancel-1440-dark");
    await dialog.getByRole("button", { name: "Keep run" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("run-state")).toHaveText("Working");

    await (await openRunMenu(page)).getByRole("menuitem", { name: "Cancel run" }).click();
    await dialog.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Cancelled. Tasks that had finished keep their branches; the task being built was stopped and what it did is committed; the rest were not built.");
    await expect(page.getByTestId("run-state")).toHaveText("Cancelled");
    for (const row of await taskRows(page).all()) await expect(row.getByTestId("run-task-state")).toHaveText("Cancelled", { timeout: 30_000 });
    // A run that has ended has no controls and no steps: its state in words says what happened.
    await expect(page.getByTestId("run-menu")).toHaveCount(0);
    await expect(steps(page)).toHaveCount(0);
    expect((await stored<{ status: string }>(page, botbench, seeded.manual)).status).toBe("cancelled");
    await checkLayout(page, 32, "run, cancelled");
    await checkWords(page, "run, cancelled");
    await shot(page, "run-cancelled-1440-dark");

    // A row is a link to its task.
    await taskRows(page).nth(1).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`#/tasks/${tasks[1]!.id}$`));

    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
  });
});

test.describe("at 390×844, on a phone", () => {
  test("the plan's decision is a sticky area with the feedback field; the menu makes a semi-autonomous run manual; Request changes sends the plan back to the planner", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    await page.goto(`${botbench.base}/#/runs/${seeded.semi}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan the invoice reminders");
    await expect(planRows(page)).toHaveCount(2);

    // The decision stays at the foot of the window while the plan scrolls under it.
    const decision = page.getByTestId("plan-decision");
    const actions = decision.getByRole("button");
    await expect(actions).toHaveText(["Request changes", "Approve 2 tasks"]);
    const foot = async (): Promise<number> => {
      const box = (await decision.boundingBox())!;
      return Math.round(box.y + box.height);
    };
    expect(await foot()).toBe(844);
    await page.evaluate(() => window.scrollTo(0, 200));
    expect(await foot()).toBe(844);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByLabel("Feedback for the planner")).toHaveCount(0);
    await checkLayout(page, 44, "run, plan waiting, 390");
    await checkWords(page, "run, plan waiting, phone");
    await shot(page, "run-plan-390-dark");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "run-plan-390-dark-full.png"), fullPage: true });

    // The menu offers a stricter mode, as the server does for this run, and says which mode it is in now.
    const menu = await openRunMenu(page);
    await expect(menu.getByRole("menuitem")).toHaveText([/^Make the mode stricter\s*Now semi-autonomous$/, "Cancel run"]);
    await menu.getByRole("menuitem", { name: /^Make the mode stricter/ }).click();
    const offer = page.getByTestId("mode-change");
    await expect(offer.getByRole("heading", { name: "Make the mode stricter", level: 2 })).toBeVisible();
    await expect(offer.getByRole("radio")).toHaveCount(2);
    await expect(offer.getByRole("radio", { name: "Semi-autonomous" })).toBeChecked();
    await expect(offer.getByRole("radio", { name: "Semi-autonomous" })).toHaveAccessibleDescription(/Current mode/);
    await expect(offer.getByText("never looser")).toBeVisible();
    await expect(offer.getByRole("button", { name: "Change mode" })).toBeDisabled();
    await checkLayout(page, 44, "run, the stricter mode, 390");
    await checkWords(page, "run, the stricter mode");
    await shot(page, "run-stricter-390-dark");
    await offer.getByRole("radio", { name: "Manual" }).click();
    expect((await stored<{ mode: string }>(page, botbench, seeded.semi)).mode).toBe("semi");
    await offer.getByRole("button", { name: "Change to Manual" }).click();
    await expect(offer).toHaveCount(0);
    await expect(page.getByTestId("run-mode")).toHaveText(/^Manual: /);
    await expect(page.getByTestId("run-mode-changes")).toContainText("You changed the mode from semi-autonomous to manual.");
    expect((await stored<{ mode: string }>(page, botbench, seeded.semi)).mode).toBe("manual");
    // Manual now: the menu holds Cancel run alone.
    await expect((await openRunMenu(page)).getByRole("menuitem")).toHaveText(["Cancel run"]);
    await page.keyboard.press("Escape");

    // Request changes opens the feedback field in the sticky area, with the focus in it; sent with words, the planner starts again.
    await actions.filter({ hasText: "Request changes" }).click();
    const feedback = page.getByLabel("Feedback for the planner");
    await expect(feedback).toBeFocused();
    await actions.filter({ hasText: "Request changes" }).click();
    await expect(decision.getByRole("alert")).toHaveText("Changes were not requested. Say what the planner should change.");
    await feedback.fill("Split the exporter into reading and writing.");
    await checkLayout(page, 44, "run, feedback for the planner, 390");
    await shot(page, "run-feedback-390-dark");
    await actions.filter({ hasText: "Request changes" }).click();
    await expect(page.getByTestId("run-status")).toHaveText(/^(Queued|Planning)\./);
    await expect(page.getByTestId("plan-decision")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Planning", level: 2 })).toBeVisible();
    await expect(steps(page).nth(0)).toHaveAttribute("aria-current", "step", { timeout: 30_000 });
    await expect(steps(page).nth(0).locator("[data-step=words]")).toHaveText("Working");
    // The planner was sent the owner's feedback, by Botbench.
    await expect(page.locator('[data-event="user_prompt"]').last()).toContainText("Split the exporter into reading and writing.", { timeout: 30_000 });
    await checkLayout(page, 44, "run, planning again, 390");
    await checkWords(page, "run, planning again, phone");
    await shot(page, "run-planning-390-dark");

    // The run is cancelled from its menu, so the held planner is stopped.
    await (await openRunMenu(page)).getByRole("menuitem", { name: "Cancel run" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this run?" });
    await expect(dialog).toContainText("The planner is stopped and no plan is kept. Nothing was built.");
    await dialog.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Cancelled. Nothing was built, and no task was made from this run.");
    expect(refused).toEqual([]);
  });
});

test.describe("at 390×844, on a phone, through a build", () => {
  test("a task is built and checked, its row says Ready for review with its evidence and its decision, and accepting it from the row ends the run", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    await page.goto(`${botbench.base}/#/runs/${seeded.manual}`);
    // One task: the replayed builder has one recorded turn to play.
    await planRows(page).nth(1).getByRole("button", { name: /^Delete task 2/ }).click();
    const decision = page.getByTestId("plan-decision");
    await expect(decision.getByRole("button", { name: "Approve 1 task" })).toBeVisible();
    expect(await filledButtons(page)).toEqual(["Approve 1 task"]);
    await decision.getByRole("button", { name: "Approve 1 task" }).click();

    // Building: the setup command Botbench ran is on the row, and the builder's turn is under way.
    const row = taskRows(page).first();
    await expect(row.getByTestId("run-task-state")).toHaveText("Working", { timeout: 30_000 });
    await expect(row.getByTestId("run-task-branch")).toHaveText("Claude Code is working; open it to watch", { timeout: 30_000 });
    await expect(row).toContainText("1 of 1 setup command passed.");
    expect(await filledButtons(page)).toEqual([]);
    await checkLayout(page, 44, "run, building, 390");
    await checkWords(page, "run, building, phone");
    await shot(page, "run-building-390-dark");

    // The builder goes on; Botbench commits the work and runs the repository's check on it.
    fs.writeFileSync(path.join(path.dirname(seeded.home), "release-builder"), "");
    await expect(row.getByTestId("run-task-state")).toHaveText("Ready for review", { timeout: 60_000 });
    await expect(row.getByTestId("run-task-state")).toHaveAttribute("data-tone", "waits");
    await expect(page.getByTestId("run-status")).toHaveText("Ready for review. Every task has been built or has stopped; each says how it went. Accept or reject each task that is ready for review.");
    await expect(steps(page).locator("[data-step=words]")).toHaveText(["Done", "Done", "1 task ready for review"]);
    await expect(steps(page).nth(2)).toHaveAttribute("aria-current", "step");
    const { tasks } = await stored<{ tasks: { id: number; branch: string }[] }>(page, botbench, seeded.manual);
    await expect(row.getByTestId("run-task-branch")).toHaveText(tasks[0]!.branch);
    // The check Botbench ran is on the row with its result; Accept and Reject are there too, and neither is filled: the row repeats for each task.
    await expect(row).toContainText("1 of 1 check passed.");
    await expect(row.getByRole("button", { name: `Reject task ${tasks[0]!.id}` })).toBeVisible();
    expect(await filledButtons(page)).toEqual([]);
    // All its tasks are built, so the run can no longer be cancelled; a manual run has no stricter mode: no menu.
    await expect(page.getByTestId("run-menu")).toHaveCount(0);
    await checkLayout(page, 44, "run, ready for review, 390");
    await checkWords(page, "run, ready for review, phone");
    await shot(page, "run-ready-390-dark");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "run-ready-390-dark-full.png"), fullPage: true });

    // Accepted from its row, through the real decision API: the run is done.
    await row.getByRole("button", { name: `Accept task ${tasks[0]!.id}` }).click();
    await expect(row.getByTestId("run-task-state")).toHaveText("Accepted");
    await expect(row.getByTestId("run-task-state")).toHaveAttribute("data-tone", "success");
    await expect(page.getByTestId("run-status")).toHaveText("Done. Every task that was built has your decision. Nothing has been merged or pushed.");
    await expect(page.getByTestId("run-state")).toHaveText("Done");
    expect((await stored<{ status: string }>(page, botbench, seeded.manual)).status).toBe("done");
    await checkLayout(page, 44, "run, done, 390");
    await checkWords(page, "run, done, phone");
    await shot(page, "run-done-390-dark");
    expect(refused).toEqual([]);
  });
});

// jon-lange is the owner the replayed gh recording (test/recordings/gh-delivery.json) was captured under, so it stays.
const ADDRESS = "https://github.com/jon-lange/botbench-delivery-fixture.git";

const delivered = base.extend<{ dir: string; seeded: { home: string; run: number; task: number }; botbench: Botbench; refused: string[] }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-run-done-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  // A run that chose pull requests, with one task built, accepted and delivered through the engine itself: real git, a
  // bare repository on disk as the remote, and the recorded gh. The recording names run 1 and task 1, so they come first.
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const baseCommit = initRepo(repo);
    const bare = path.join(dir, "remote.git");
    git(dir, "init", "--quiet", "--bare", bare);
    git(repo, "config", `url.${bare}.insteadOf`, ADDRESS);
    git(repo, "remote", "add", "origin", ADDRESS);
    const db = openStore(home);
    const run = createRun(db, { repo, prompt: "Add a greeting file", baseCommit, delivery: "pull_request" });
    storePlan(db, run.id, [{ title: "Create hello.txt", criteria: ["hello.txt holds the word hi"] }]);
    const { tasks } = approvePlan(db, run.id, 1);
    const task = tasks[0]!;
    const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${task.id}` });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, "hello.txt", "hi\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    await decideTask(db, { taskId: task.id, decision: "accept", withoutVerification: true });
    // The run chose pull requests, so the engine delivers its accepted task as it starts; closing waits for that.
    const deliveries = createDeliveries({ db, config: { repositories: {} } as unknown as Config, github: replayGitHub().github, onTaskChange: () => {} });
    await deliveries.close();
    db.close();
    await use({ home, run: run.id, task: task.id });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    await botbench.stop();
  },
  refused: async ({ page }, use) => use(await watchRefused(page)),
});

delivered.describe("at 768×1024", () => {
  delivered.use({ viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1, hasTouch: false });

  delivered("a run that has ended says how in one sentence, with its tasks' outcomes and the pull request it opened, and has no controls left", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    await page.goto(`${botbench.base}/#/runs/${seeded.run}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add a greeting file");
    await expect(page.getByTestId("run-state")).toHaveText("Done");
    await expect(page.getByTestId("run-status")).toHaveText("Done. Every task that was built has your decision. Nothing has been merged; the accepted tasks' branches were pushed for their pull requests.");
    await expect(steps(page).locator("[data-step=words]")).toHaveText(["Done", "Done", "Done · 1 of 1 task decided"]);
    await expect(taskRows(page)).toHaveCount(1);
    await expect(taskRows(page).getByTestId("run-task-state")).toHaveText("Accepted without verification");
    await expect(taskRows(page).getByRole("link").first()).toHaveAttribute("href", `#/tasks/${seeded.task}`);

    const created = loadGhCapture().outputs.prCreate.result.stdout.trim();
    const number = /\/pull\/(\d+)$/.exec(created)![1];
    await expect(page.getByTestId("run-task-pull-request")).toHaveText(`The branch is on origin, and Botbench opened pull request #${number} into main. Nothing was merged.`);
    await expect(page.getByTestId("run-delivery")).toHaveText("Botbench pushes its branch and opens a pull request");
    const link = page.getByTestId("run-pull-requests").getByRole("link", { name: `Pull request #${number} on GitHub (opens in a new tab)` });
    await expect(link).toHaveAttribute("href", created);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("run-menu")).toHaveCount(0);
    await checkLayout(page, 32, "run, done, 768");
    await checkWords(page, "run, done");
    await shot(page, "run-done-768-dark");
    expect(refused).toEqual([]);
  });
});
