import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { git, initRepo } from "../test/support/repo.ts";
import { startBotbench, type Botbench } from "./botbench.ts";
import { checkLayout, checkWords, expect, SHOTS, signIn, startTaskIn, watchRefused } from "./helpers.ts";

// A task's screen rebuilt on shadcn/ui and Tailwind 4 (ADR 0012) while the task works, once the owner stops it, and
// once it has failed, in the real client against a real Botbench process whose Claude Code replays a turn recorded from
// a real session (e2e/serve-replayed-build.ts, the owner's approved exception). No model turn: the builder's first turn
// is held once its prompt is recorded, so the task is working while the test looks and presses Stop; resumed with a
// note, the recorded turn plays, changes no file, and the task fails, which is the failure the recovery screen is for.
// Stop, Resume with a note and Discard go through the real routes; the engine's side of them is in
// test/engine/stop.test.ts and test/api/resume.test.ts.

const test = base.extend<{ botbench: Botbench; refused: string[] }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-build.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
  refused: async ({ page }, use) => use(await watchRefused(page)),
});

const PROMPT = "Add a greeting file";
const NOTE = "Name the file hello.txt this time.";
const STOPPED = "You stopped it. What its agent wrote up to then is committed to the task's branch and kept in the task's copy of the project.";

/** A picture of the screen at `<BOTBENCH_SHOTS>/<name>.png` when BOTBENCH_SHOTS names a folder (docs/design/built). */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function light(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
  await page.reload();
  await expect(page.getByTestId("task-state")).toBeVisible();
  await shot(page, name);
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
  await page.reload();
  await expect(page.getByTestId("task-state")).toBeVisible();
}

const status = async (page: Page, botbench: Botbench): Promise<string> => ((await (await page.request.get(`${botbench.base}/api/tasks/1`)).json()) as { status: string }).status;

async function start(page: Page, botbench: Botbench): Promise<string> {
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await startTaskIn(page, repo, PROMPT);
  await expect(page.getByTestId("task-state")).toHaveText("Working");
  return repo;
}

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("a working task shows its activity, a clock and a note box; Stop stops its agent and keeps the work; Resume with a note sends the note first; a failed task offers Resume, and Discard asks first", async ({ page, botbench, refused }) => {
    test.setTimeout(120_000);
    const repo = await start(page, botbench);

    // Working: where it stands in the server's sentence, what the owner sent, a clock that moves, and the note box.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PROMPT);
    await expect(page.getByTestId("task-name")).toHaveText("Task 1 · sample-repo");
    await expect(page.getByTestId("task-status")).toHaveText("Working. Claude Code is working in a separate copy of the project.");
    const log = page.getByRole("log", { name: "Activity" });
    await expect(log.getByTestId("prompt")).toHaveText(`You: ${PROMPT}`);
    await expect(log.getByTestId("working")).toHaveText("Claude Code is working.");
    const clock = page.getByTestId("clock").first();
    const before = await clock.textContent();
    await expect.poll(() => clock.textContent(), { timeout: 5000 }).not.toBe(before);
    await expect(page.getByTestId("task-note").getByRole("heading", { name: "Note for Claude Code" })).toBeVisible();
    // The pane: the stages with the one it is at, and Stop with what it does.
    const pane = page.getByRole("complementary", { name: "Details" });
    await expect(pane.getByTestId("progress").getByRole("listitem")).toHaveText(["Work, now", "Checks", "Your decision"]);
    await expect(pane.getByTestId("task-stop")).toContainText("Stops Claude Code now. What it wrote is kept in the task's copy, and you can resume it.");
    await expect(page.getByRole("button", { name: /^(Accept|Resume)/ })).toHaveCount(0);
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "three");
    await checkLayout(page, 32, "task, working, 1440");
    await checkWords(page, "task, working");
    await shot(page, "task-working-1440-dark");
    await light(page, "task-working-1440-light");

    // Stop: the task is Stopped, with the owner's stop as its reason, and its copy and branch kept.
    await pane.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("Stopped", { timeout: 30_000 });
    await expect(page.getByTestId("task-reason")).toHaveText(STOPPED);
    await expect(page.getByTestId("task-status")).toHaveText(`Stopped. ${STOPPED}`);
    const recovery = page.getByRole("complementary", { name: "Recovery" });
    await expect(recovery.getByTestId("resume-note")).toHaveText("Resume starts Claude Code again in the task's copy of the project, with the files as they were left, and asks it to carry on where it stopped.");
    await expect(recovery.getByRole("button")).toHaveText(["Resume", "Inspect what happened", "Discard…"]);
    await page.mouse.move(0, 0);
    // Polled: a button the pointer has just left is still fading back.
    await expect.poll(() => recovery.getByRole("button").evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor !== "rgba(0, 0, 0, 0)"))).toEqual([true, false, false]);
    await expect(recovery.getByTestId("kept")).toContainText("botbench/");
    expect(git(repo, "branch", "--list", "botbench/*").trim()).not.toBe("");
    await expect(page.getByTestId("task-stop")).toHaveCount(0);
    await checkLayout(page, 32, "task, stopped, 1440");
    await checkWords(page, "task, stopped");
    await shot(page, "task-stopped-1440-dark");

    // Resume with a note: the agent's first message of the resumed work is Botbench's own, then the note.
    await recovery.getByLabel("Note for Claude Code (optional)").fill(NOTE);
    await recovery.getByRole("button", { name: "Resume" }).click();
    await expect.poll(() => status(page, botbench), { timeout: 30_000 }).toBe("failed");
    await expect(page.getByTestId("task-state")).toHaveText("Failed");
    const prompts = page.getByRole("log", { name: "Activity" }).getByTestId("prompt");
    // The activity shows the session the task names now; the one that was stopped is kept, and the screen says so.
    await expect(prompts).toHaveCount(1);
    // The stopped agent had reported no session to take up (its turn was held at the prompt), so the new one is given
    // the task again, then the note, marked as the owner's instruction for the work from here.
    await expect(prompts).toHaveText(`You: ${PROMPT}\n\n[From Botbench] The owner resumed this task with a note. It is the owner's own instruction for the work from here, and comes first where it differs from what was asked before:\n\n${NOTE}`, { useInnerText: true });
    await expect(page.getByTestId("earlier-sessions")).toBeVisible();

    // Failed, recovery first: what happened in the server's sentence, Resume as the one filled button, Discard apart.
    await expect(page.getByTestId("task-reason")).toHaveText("Claude Code finished without changing any file.");
    await expect(page.getByTestId("what-happened")).toContainText("Nothing is lost: what it left is kept, and it can be resumed from where it stopped.");
    await expect(recovery.getByTestId("resume-note")).toHaveText("Resume starts Claude Code again in the same session, in the task's copy of the project, tells it that it changed no file, and asks it to do the task now.");
    await expect(page.getByTestId("not-verified")).toContainText("No checks ran on this work, and no reviewer read it.");
    await checkLayout(page, 32, "task, failed, 1440");
    await checkWords(page, "task, failed");
    await shot(page, "task-failed-1440-dark");
    await light(page, "task-failed-1440-light");

    // Inspect takes the reader to the activity. Discard asks first, with the focus on the button that changes nothing.
    await recovery.getByRole("button", { name: "Inspect what happened" }).click();
    await expect(page.getByRole("log", { name: "Activity" })).toBeInViewport();
    await recovery.getByRole("button", { name: "Discard…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Discard what this task left?" });
    await expect(dialog.getByRole("button")).toHaveText(["Keep them", "Discard"]);
    await checkWords(page, "task, the Discard dialog");
    await dialog.getByRole("button", { name: "Keep them" }).click();
    await expect(dialog).toHaveCount(0);
    expect(git(repo, "branch", "--list", "botbench/*").trim()).not.toBe("");
    await recovery.getByRole("button", { name: "Discard…" }).click();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("discarded")).toContainText("Discarded. Nothing of this task is left");
    expect(git(repo, "branch", "--list", "botbench/*").trim()).toBe("");
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);

    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
  });
});

test.describe("at 390×844, on a phone", () => {
  test("a working task keeps Stop and its details in reach at the foot, over the navigation bar; stopped, the foot holds the note and Resume; and the same screen is one, two and three panes as the window widens", async ({ page, botbench, refused }) => {
    test.setTimeout(120_000);
    await start(page, botbench);
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "one");
    await expect(page.getByRole("navigation", { name: "Screens" }).getByRole("link")).toHaveText(["Chat", "Work", "Settings"]);
    const foot = page.getByTestId("foot");
    await expect(foot.getByRole("button")).toHaveText(["Stop", "Details"]);
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await checkLayout(page, 44, "task, working, 390");
    await checkWords(page, "task, working, phone");
    await shot(page, "task-working-390-dark");

    // The pane is a sheet: the stages, and Stop with what it does.
    await foot.getByRole("button", { name: "Details" }).click();
    const sheet = page.getByRole("dialog", { name: "Details" });
    await expect(sheet.getByTestId("progress")).toBeVisible();
    await expect(sheet.getByTestId("task-stop")).toContainText("Stops Claude Code now.");
    await checkLayout(page, 44, "task, working, 390, the sheet");
    await shot(page, "task-working-390-dark-sheet");
    await page.keyboard.press("Escape");

    await foot.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("Stopped", { timeout: 30_000 });
    await expect(foot.getByLabel("Note for Claude Code (optional)")).toBeVisible();
    await expect(foot.getByRole("button")).toHaveText(["Resume", "Details"]);
    await checkLayout(page, 44, "task, stopped, 390");
    await checkWords(page, "task, stopped, phone");
    await shot(page, "task-stopped-390-dark");

    // 768: one pane, the navigation behind the menu button in the bar, the pane still a sheet.
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByRole("navigation", { name: "Screens" })).toHaveCount(0);
    await page.getByRole("button", { name: "Screens menu" }).click();
    await expect(page.getByRole("dialog").getByRole("navigation", { name: "Screens" }).getByRole("link")).toHaveText(["Chat", "Work", "Settings"]);
    await expect(page.getByRole("dialog").getByRole("link", { name: PROMPT })).toHaveAttribute("aria-current", "page");
    await shot(page, "task-stopped-768-dark-menu");
    await page.keyboard.press("Escape");
    await expect(foot.getByRole("button")).toHaveText(["Resume", "Details"]);
    await checkLayout(page, 44, "task, stopped, 768");
    await shot(page, "task-stopped-768-dark");

    // 1024: two panes and a rail of icons, each named; the pane is in view, and nothing stays at the foot.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "two");
    await expect(page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Work" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Screens" }).getByText("Work")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Recovery" }).getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(foot).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await shot(page, "task-stopped-1024-dark");

    // 1280: three panes, the navigation with its labels and the workbench at its foot.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "three");
    await expect(page.getByRole("navigation", { name: "Screens" }).getByText("Work")).toBeVisible();
    await expect(page.getByTestId("workbench")).toContainText(/\d+ agents? available/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await shot(page, "task-stopped-1280-dark");
    expect(refused).toEqual([]);
  });
});
