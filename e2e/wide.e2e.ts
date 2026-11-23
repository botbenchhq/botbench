import fs from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page } from "@playwright/test";
import { createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { checkDesign, expect, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { escapeRegExp } from "../test/support/regexp.ts";

// The column of chats and work beside a wide screen, and the two-pane Settings, at 1280×800; and the same screens at
// 390×844, where neither is drawn. No model turn: before Botbench starts, runs and tasks are put in its real store
// through the engine itself (a task's work is committed to its real branch), and the real Botbench process shows them.

const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** Enough failed tasks that the column scrolls inside itself at 800px tall. */
const FILLERS = 24;

interface Seeded {
  home: string;
  /** Ready for review: its work is committed on its branch. */
  ready: { id: number; title: string };
  /** A run whose plan waits for the owner. */
  planned: { id: number; title: string };
  /** The newest row of all. */
  newest: { id: number; title: string };
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-wide-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const baseCommit = initRepo(repo, { "README.md": "# Sample\n" });
    const db = openStore(home);
    for (let i = 1; i <= FILLERS; i++) moveTask(db, createTask(db, { repo, prompt: `Tidy module number ${i}` }).id, "failed", { reason: "Its setup command failed." });
    const readyTitle = "Fix the login timeout";
    const ready = createTask(db, { repo, prompt: readyTitle });
    const worktree = await createWorktree({ repo, home, run: `run-${ready.runId}`, task: `task-${ready.id}` });
    moveTask(db, ready.id, "building", { worktree });
    write(worktree.path, "src/login.ts", "export const timeout = 30;\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${ready.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, ready.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    // Each later row is written at a later millisecond, so newest first has one order (rows written in the same
    // millisecond tie, and a tie keeps the board's group order).
    const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
    await later();
    const plannedTitle = "Plan the billing export";
    const run = createRun(db, { repo, prompt: plannedTitle, baseCommit });
    storePlan(db, run.id, [{ title: "Write the exporter", criteria: ["It writes a CSV file"] }]);
    await later();
    const newestTitle = "Cancel the old cron job";
    const newest = createTask(db, { repo, prompt: newestTitle });
    moveTask(db, newest.id, "cancelled", { reason: "Cancelled by the owner." });
    db.close();
    await use({ home, ready: { id: ready.id, title: readyTitle }, planned: { id: run.id, title: plannedTitle }, newest: { id: newest.id, title: newestTitle } });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
});

const column = (page: Page): Locator => page.getByRole("region", { name: "Chats and work" });
const search = (page: Page): Locator => column(page).getByLabel("Search chats and work");
const count = (page: Page): Locator => column(page).getByTestId("work-column-count");
const rows = (page: Page): Locator => column(page).locator(".ds-list__link");
const ALL = FILLERS + 3;

test.describe("at 1280×800", () => {
  test.use({ viewport: WIDE });

  test("every screen but Settings has the column of chats and work, newest first with their states in words; its search filters by title as you type, counts in words, says when nothing matches and clears; opening a row keeps the column, its search and its scroll position, and marks the row current", async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    // Chat, the home screen, with the column beside it.
    await expect(rows(page)).toHaveCount(ALL);
    await expect(count(page)).toHaveText(`1 run and ${ALL - 1} tasks`);
    await expect(rows(page).first()).toContainText(seeded.newest.title);
    await expect(rows(page).first()).toContainText(`Cancelled · Task ${seeded.newest.id}`);
    await expect(rows(page).nth(1)).toContainText(seeded.planned.title);
    await expect(rows(page).nth(1)).toContainText(`Plan ready for review · Run ${seeded.planned.id}`);
    await expect(rows(page).nth(2)).toContainText(seeded.ready.title);
    await expect(rows(page).nth(2)).toContainText(`Ready for review · Task ${seeded.ready.id}`);
    await expect(rows(page).nth(3)).toContainText("Failed");
    await expect(rows(page).nth(2)).toHaveAttribute("href", `#/tasks/${seeded.ready.id}`);
    await expect(rows(page).nth(1)).toHaveAttribute("href", `#/runs/${seeded.planned.id}`);
    // No chat was had here, so none is listed (test/work-list.test.ts lists chats with the work).
    await expect(column(page).locator('a[href^="#/chats/"]')).toHaveCount(0);
    await expect(page.locator('.ds-list__link[aria-current="true"]')).toHaveCount(0);
    await checkDesign(page, "chat, wide, with the column of chats and work");

    // Typing filters by title, in any case, and the count says how many of how many.
    await search(page).pressSequentially("LOGIN");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText(seeded.ready.title);
    await expect(count(page)).toHaveText(`1 of ${ALL} match "LOGIN"`);
    await checkDesign(page, "chat, wide, the column searched");
    await search(page).fill("no such title");
    await expect(rows(page)).toHaveCount(0);
    await expect(column(page).locator("ul")).toHaveCount(0);
    await expect(column(page).getByTestId("work-column-empty")).toHaveText("No title has those words. Clear the search to see them all.");
    await expect(count(page)).toHaveText(`None of ${ALL} match "no such title"`);
    await checkDesign(page, "chat, wide, the column searched with no match");
    // Clear the search: every row comes back, and the field keeps the focus.
    await column(page).getByRole("button", { name: "Clear the search" }).click();
    await expect(search(page)).toHaveValue("");
    await expect(search(page)).toBeFocused();
    await expect(rows(page)).toHaveCount(ALL);
    await expect(count(page)).toHaveText(`1 run and ${ALL - 1} tasks`);

    // Search, scroll the column, then open a row: only the screen beside the column changes.
    await search(page).fill("module");
    await expect(rows(page)).toHaveCount(FILLERS);
    const scroller = column(page);
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    expect(scrolled, "the column scrolls inside itself").toBeGreaterThan(0);
    await scroller.evaluate((el) => ((el as HTMLElement & { kept?: boolean }).kept = true));
    const last = rows(page).last();
    const lastHref = (await last.getAttribute("href"))!;
    await last.click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(lastHref)}$`));
    await expect(page.getByRole("heading", { level: 1, name: /Tidy module number/ })).toBeVisible();
    await expect(last).toHaveAttribute("aria-current", "true");
    await expect(page.locator('.ds-list__link[aria-current="true"]')).toHaveCount(1);
    expect(await scroller.evaluate((el) => (el as HTMLElement & { kept?: boolean }).kept), "the column is the same element: it was not drawn again").toBe(true);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
    await expect(search(page)).toHaveValue("module");
    await checkDesign(page, "task, wide, opened from the column");

    // Another row: the run opens beside the column, and the mark moves to it.
    await search(page).fill("billing");
    await rows(page).first().click();
    await expect(page.getByRole("heading", { level: 1, name: `Run ${seeded.planned.id}` })).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
    await expect(page.locator('.ds-list__link[aria-current="true"]')).toHaveCount(1);
    await checkDesign(page, "run, wide, opened from the column");

    // Work has the column too; Settings does not, and the search is still there after it.
    await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Work", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
    await expect(column(page)).toBeVisible();
    await checkDesign(page, "work, wide, with the column");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(column(page)).toHaveCount(0);
    await page.goBack();
    await expect(search(page)).toHaveValue("billing");
  });

  test("Settings is two panes: the sections on the left, only the chosen one on the right, Agents when none is chosen; #/settings/agents focuses its heading; Permissions and Usage open at their own addresses; the devices and the workbench show their controls", async ({ page, botbench }) => {
    await signIn(page, botbench);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    const sections = page.getByTestId("settings-sections").getByRole("link");
    const shown = page.getByTestId("settings-section");
    await expect(sections).toHaveText(["Agents", "Appearance", "Notifications", "Signed-in devices", "This workbench", "Permissions", "Usage"]);
    await expect(sections.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(page.locator('[data-testid="settings-sections"] [aria-current]')).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Agents" })).toBeVisible();
    await expect(shown.getByTestId("agent-claude-code")).toBeVisible();
    // Only the chosen section: the others are not on the screen.
    await expect(page.getByRole("group", { name: "Appearance" })).toHaveCount(0);
    await expect(page.getByTestId("devices")).toHaveCount(0);
    await expect(page.getByTestId("settings-links")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Chats and work" })).toHaveCount(0);
    await checkDesign(page, "settings, wide, Agents");

    await sections.filter({ hasText: "Appearance" }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(shown.getByRole("group", { name: "Appearance" }).getByLabel("Mode")).toBeVisible();
    await expect(shown.getByTestId("agent-claude-code")).toHaveCount(0);
    await expect(sections.nth(1)).toHaveAttribute("aria-current", "true");
    await checkDesign(page, "settings, wide, Appearance");

    await sections.filter({ hasText: "Notifications" }).click();
    await expect(shown.getByTestId("notifications")).toBeVisible();

    await sections.filter({ hasText: "Signed-in devices" }).click();
    await expect(shown.getByTestId("device")).toHaveCount(1);
    await expect(shown.getByTestId("device")).toContainText("This device");
    await expect(shown.getByRole("button", { name: "Sign out" })).toBeVisible();
    await checkDesign(page, "settings, wide, Signed-in devices");

    await sections.filter({ hasText: "This workbench" }).click();
    await expect(page).toHaveURL(/#\/settings\/workbench$/);
    await expect(shown.getByRole("group", { name: "Runs" })).toBeVisible();
    await expect(shown.getByTestId("ask-every-command")).toBeVisible();
    await expect(shown.getByTestId("chat-web-access")).toBeVisible();
    await expect(shown.getByTestId("workbench-name")).toBeVisible();
    await expect(shown.getByTestId("memory-settings")).toBeVisible();
    await checkDesign(page, "settings, wide, This workbench");

    await sections.filter({ hasText: "Permissions" }).click();
    await expect(page).toHaveURL(/#\/trust$/);
    await expect(shown.getByRole("heading", { name: "Always allowed" })).toBeVisible();
    await expect(shown.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(sections.nth(5)).toHaveAttribute("aria-current", "true");
    await checkDesign(page, "settings, wide, Permissions");

    await sections.filter({ hasText: "Usage" }).click();
    await expect(page).toHaveURL(/#\/usage$/);
    await expect(shown.getByTestId("usage-empty")).toBeVisible();
    await checkDesign(page, "settings, wide, Usage");

    // The address that opens Settings at Agents, from the home screen's link: its heading takes the focus, as before.
    await page.evaluate(() => (window.location.hash = "#/settings/agents"));
    await expect(shown.getByRole("heading", { name: "Agents" })).toBeFocused();
    await expect(sections.nth(0)).toHaveAttribute("aria-current", "true");
    // Opened directly, Permissions is a section of Settings too.
    await page.goto(`${botbench.base}/#/trust`);
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(sections.nth(5)).toHaveAttribute("aria-current", "true");
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: PHONE });

  test("no column of chats and work and no section list: the screens and the one-column Settings, with its rows to Permissions and Usage, are as before", async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    await expect(page.getByTestId("work-column")).toHaveCount(0);
    await expect(page.locator(".ds-split-panel")).toHaveCount(0);
    await checkDesign(page, "chat, phone, no column");
    await page.evaluate((id) => (window.location.hash = `#/tasks/${id}`), seeded.ready.id);
    await expect(page.getByRole("heading", { level: 1, name: seeded.ready.title })).toBeVisible();
    await expect(page.getByTestId("work-column")).toHaveCount(0);
    await checkDesign(page, "task, phone, no column");

    await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page.getByTestId("settings-sections")).toHaveCount(0);
    await expect(page.getByTestId("settings-panes")).toHaveCount(0);
    await expect(page.getByTestId("settings-links").getByRole("link")).toHaveText([/^Permissions/, /^Usage/]);
    // Every group, one under the other, in the order it always had.
    await expect(page.locator("main .ds-settings-row__heading")).toHaveText(["Agents", "Runs", "Web", "Watched issues", "Where commands run", "Workbench", "Memory", "Appearance", "Notifications", "Signed-in devices"]);
    await checkDesign(page, "settings, phone, one column");

    await page.getByTestId("settings-links").getByRole("link", { name: /^Permissions/ }).click();
    await expect(page).toHaveURL(/#\/trust$/);
    await expect(page.getByRole("heading", { name: "Permissions", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings");
    await checkDesign(page, "permissions, phone, its own screen");
    await page.evaluate(() => (window.location.hash = "#/settings/agents"));
    await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();
  });
});
