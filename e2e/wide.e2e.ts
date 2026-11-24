import fs from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page } from "@playwright/test";
import { createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { checkDesign, checkScreen, checkWords, expect, goTo, messageBox, signIn } from "./helpers.ts";
import { choice, choose, GROUPS } from "./settings-helpers.ts";
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
/** Work, from the navigation of whichever screen is shown: the run screen, rebuilt on shadcn/ui, has its own and no column. */
const toWork = (page: Page): Promise<void> => page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Work", exact: true }).click();
/** The run with its plan, from its row on Work: Work is the inventory itself, and has no column beside it. */
const toRun = async (page: Page): Promise<void> => {
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
  await page.getByTestId("work-row").getByRole("link").filter({ hasText: /Plan the billing export|billing/i }).first().click();
};

// A desktop: a mouse and a keyboard, no touch screen.
test.describe("at 1280×800, with a mouse", () => {
  test.use({ viewport: WIDE, hasTouch: false });

  test("arriving on a screen names the tab for it and puts focus on its heading, the page can be zoomed, and the message box says which key sends", async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    // Pinch zoom is the browser's to give: the page sets no limit on it.
    expect(await page.locator('meta[name="viewport"]').getAttribute("content")).toBe("width=device-width, initial-scale=1, viewport-fit=cover");
    await expect(page).toHaveTitle("New chat or task \u2013 Botbench");
    // A mouse and a keyboard: Enter sends, and the line under the box says so and describes the box.
    await expect(page.getByTestId("composer-keys")).toHaveText("Enter sends. Shift with Enter starts a new line.");
    await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toHaveAccessibleDescription(/Enter sends\. Shift with Enter starts a new line\./);

    // A task, opened from its row on Work: the tab is named by Botbench's own name for it, and focus leaves the row for the heading.
    await goTo(page, "Work");
    await page.getByTestId("work-row").getByRole("link").filter({ hasText: seeded.ready.title }).first().click();
    await expect(page).toHaveTitle(`Task ${seeded.ready.id} \u2013 Botbench`);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.goBack();
    await toRun(page);
    await expect(page).toHaveTitle(`Run ${seeded.planned.id} \u2013 Botbench`);
    // A run's heading is its title, the owner's own words; the tab has Botbench's name for it.
    await expect(page.getByRole("heading", { level: 1, name: seeded.planned.title })).toBeFocused();
    await page.goto(`${botbench.base}/#/work`);
    await expect(page).toHaveTitle("Work \u2013 Botbench");
    await expect(page.getByRole("heading", { level: 1, name: "Work" })).toBeFocused();
    // Back is a change of address like any other.
    await page.goBack();
    await expect(page).toHaveTitle(`Run ${seeded.planned.id} \u2013 Botbench`);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.goto(`${botbench.base}/#/no/such/screen`);
    await expect(page).toHaveTitle("No such screen \u2013 Botbench");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

    // With no chat, Chat is New chat or task: with a keyboard its heading passes focus on to the message box, where typing starts.
    await page.getByRole("navigation", { name: "Screens" }).first().getByRole("link", { name: "Chat" }).click();
    await expect(page).toHaveTitle("New chat or task \u2013 Botbench");
    await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeFocused();

    // Settings keeps its navigation in place when another group is chosen: the tab is named for the group and the group's heading takes focus.
    await page.goto(`${botbench.base}/#/settings`);
    await expect(page).toHaveTitle("Agents and models \u2013 Botbench");
    const sections = page.getByTestId("settings-nav");
    await sections.getByRole("link", { name: "Permissions and autonomy" }).click();
    await expect(page).toHaveTitle("Permissions and autonomy \u2013 Botbench");
    await expect(page.getByRole("heading", { level: 1, name: "Permissions and autonomy" })).toBeFocused();
    await sections.getByRole("link", { name: "Usage and limits" }).click();
    await expect(page).toHaveTitle("Usage and limits \u2013 Botbench");
    await expect(page.getByRole("heading", { level: 1, name: "Usage and limits" })).toBeFocused();
    await checkScreen(page, "settings, wide, a group arrived on with focus");

    // The first screen after a page load is left alone: nothing is focused for the reader.
    await page.goto(`${botbench.base}/#/work`);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Work" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Work" })).not.toBeFocused();
  });

  test("leaving a plan task with typed words asks first, and keeps them when the answer is to keep editing; a Settings choice says when it was saved", async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    await page.goto(`${botbench.base}/#/runs/${seeded.planned.id}`);
    const title = page.getByLabel("Task 1 title");
    // Opened and left as it was, the editor closes at once: there is nothing to lose.
    await page.locator('[data-edit="0"]').click();
    await expect(title).toHaveValue("Write the exporter");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(title).toHaveCount(0);
    await expect(page.getByTestId("discard-edit")).toHaveCount(0);

    // With typed words, Cancel and Escape ask; Keep editing returns to the words as typed.
    await page.locator('[data-edit="0"]').click();
    await title.fill("Write the importer");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const question = page.getByTestId("discard-edit");
    await expect(question).toContainText("Discard what you typed?");
    await expect(question).toContainText("Your changes to this task are not saved. The plan stays as it was.");
    await expect(question.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await checkScreen(page, "run, wide, the question before typed words are discarded", { floor: 32 });
    await checkWords(page, "run, wide, the question before typed words are discarded");
    // Keep editing returns to the words as typed, with focus back where it was.
    await question.getByRole("button", { name: "Keep editing" }).click();
    await expect(question).toHaveCount(0);
    await expect(title).toHaveValue("Write the importer");
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await title.focus();
    await page.keyboard.press("Escape");
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Keep editing" }).click();
    await expect(title).toBeFocused();

    // Leaving for another screen asks the same question. Kept: the run is still the screen, at its own address.
    await toWork(page);
    await expect(question).toContainText("Discard what you typed?");
    await question.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(new RegExp(`#/runs/${seeded.planned.id}$`));
    await expect(title).toHaveValue("Write the importer");
    // Discarded: the owner goes where they were going, and the plan is as it was.
    await toWork(page);
    await question.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/#\/work$/);
    await expect(page).toHaveTitle("Work \u2013 Botbench");
    await toRun(page);
    await expect(page.getByRole("list", { name: "Plan" })).toContainText("Write the exporter");
    // With nothing typed, leaving asks nothing.
    await page.locator('[data-edit="0"]').click();
    await toWork(page);
    await expect(page).toHaveURL(/#\/work$/);
    await expect(question).toHaveCount(0);

    // Cancel with typed words, then Discard changes: the row is back, with focus on its Edit button.
    await toRun(page);
    await page.locator('[data-edit="0"]').click();
    await title.fill("Write the importer");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await question.getByRole("button", { name: "Discard changes" }).click();
    await expect(title).toHaveCount(0);
    await expect(page.locator('[data-edit="0"]')).toBeFocused();

    // The run is cancelled in another window while a task holds typed words: the editor closes and the screen says why.
    await page.locator('[data-edit="0"]').click();
    await title.fill("Write the importer");
    const cancelled = await page.evaluate((id) => fetch(`/api/runs/${id}/cancel`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status), seeded.planned.id);
    expect(cancelled).toBe(200);
    await expect(title).toHaveCount(0, { timeout: 20_000 });
    await expect(question).toHaveCount(0);
    await expect(page.getByTestId("edit-closed")).toHaveText(/The plan changed in another window, so the task you were editing was closed\. What you typed was not saved\./);
    await checkScreen(page, "run, wide, an edit closed because the plan changed elsewhere", { floor: 32 });
    await checkWords(page, "run, wide, an edit closed because the plan changed elsewhere");

    // The control shows the choice before Botbench has kept it, so the row says when it has.
    await page.goto(`${botbench.base}/#/settings/permissions`);
    const every = choice(page, "Ask before every command");
    await expect(every).toHaveAttribute("data-value", "off");
    await expect(page.getByTestId("ask-every-saved")).toHaveCount(0);
    await choose(page, "Ask before every command", "On");
    await expect(page.getByTestId("ask-every-saved")).toHaveText("Saved.");
    await expect(every).toHaveAttribute("data-value", "on");
    await choose(page, "Ask before every command", "Off");
    await expect(page.getByTestId("ask-every-saved")).toHaveText("Saved.");
    await expect(every).toHaveAttribute("data-value", "off");
    await checkScreen(page, "settings, wide, a choice saved");
  });
});

test.describe("at 1280×800", () => {
  test.use({ viewport: WIDE });

  test("no screen has a column of chats and work beside it: Work is the inventory, and a task or a run opened from it takes the window, named in the navigation", async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    await goTo(page, "Work");
    await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
    await expect(column(page)).toHaveCount(0);
    // The task that is ready, from its row: its screen has the navigation at the left, which names the open task.
    await page.getByTestId("work-row").getByRole("link").filter({ hasText: seeded.ready.title }).first().click();
    await expect(page).toHaveURL(new RegExp(`#/tasks/${seeded.ready.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: seeded.ready.title })).toBeVisible();
    await expect(column(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: seeded.ready.title })).toHaveAttribute("aria-current", "page");
    await checkDesign(page, "task, wide, opened from Work");
    // The run, the same way.
    await page.goBack();
    await toRun(page);
    await expect(page.getByRole("heading", { level: 1, name: seeded.planned.title })).toBeVisible();
    await expect(column(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: seeded.planned.title })).toHaveAttribute("aria-current", "page");
    await checkScreen(page, "run, wide, opened from Work", { floor: 32 });
    // Home, Chat and Settings have none either.
    for (const [screen, heading] of [["Home", "Home"], ["Chat", null], ["Settings", "Agents and models"]] as const) {
      await page.evaluate((to) => (window.location.hash = to), screen === "Home" ? "#/" : screen === "Chat" ? "#/turn" : "#/settings");
      if (heading !== null) await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeAttached();
      else await expect(messageBox(page)).toBeVisible();
      await expect(column(page)).toHaveCount(0);
    }
  });

  test("Settings is its navigation beside one group: the six groups on the left, only the chosen one on the right, Agents and models when none is chosen; each group at its own address, its heading focused on arrival; the old addresses open the new groups", async ({ page, botbench }) => {
    await signIn(page, botbench);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents and models", level: 1 })).toBeVisible();
    const sections = page.getByTestId("settings-nav").getByRole("listitem").getByRole("link");
    const shown = page.getByTestId("settings");
    await expect(sections).toHaveText(Object.values(GROUPS));
    await expect(sections.nth(0)).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-testid="settings-nav"] [aria-current]')).toHaveCount(1);
    await expect(page.getByTestId("settings-nav").getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "#/");
    await expect(shown.getByTestId("agent-claude-code")).toBeVisible();
    await expect(shown.getByTestId("fallback-list")).toBeVisible();
    // Only the chosen group: the others are not on the screen, nor is the phone's list of groups.
    await expect(page.getByTestId("devices")).toHaveCount(0);
    await expect(page.getByTestId("settings-groups")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Chats and work" })).toHaveCount(0);
    await checkScreen(page, "settings, wide, Agents and models");

    await sections.filter({ hasText: "Execution environments" }).click();
    await expect(page).toHaveURL(/#\/settings\/environments$/);
    await expect(shown.getByTestId("execution-settings")).toBeVisible();
    await expect(shown.getByTestId("watch-settings")).toBeVisible();
    await expect(shown.getByTestId("agent-claude-code")).toHaveCount(0);
    await expect(sections.nth(1)).toHaveAttribute("aria-current", "page");
    await checkScreen(page, "settings, wide, Execution environments");

    await sections.filter({ hasText: "Workbench identity" }).click();
    await expect(page).toHaveURL(/#\/settings\/identity$/);
    await expect(shown.getByLabel("Appearance", { exact: true })).toBeVisible();
    await expect(shown.getByTestId("workbench-name")).toBeVisible();
    await expect(shown.getByTestId("update-settings")).toBeVisible();
    await expect(shown.getByTestId("memory-settings")).toBeVisible();
    await checkScreen(page, "settings, wide, Workbench identity");

    await sections.filter({ hasText: "Permissions and autonomy" }).click();
    await expect(page).toHaveURL(/#\/settings\/permissions$/);
    await expect(shown.getByTestId("default-mode-picker")).toBeVisible();
    await expect(shown.getByTestId("ask-every-command")).toBeVisible();
    await expect(shown.getByTestId("chat-web-access")).toBeVisible();
    await expect(shown.getByRole("heading", { name: "Always allowed" })).toBeVisible();
    await expect(shown.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(sections.nth(3)).toHaveAttribute("aria-current", "page");
    await checkScreen(page, "settings, wide, Permissions and autonomy");

    await sections.filter({ hasText: "Usage and limits" }).click();
    await expect(page).toHaveURL(/#\/settings\/usage$/);
    await expect(shown.getByTestId("usage-empty")).toBeVisible();
    await expect(shown.getByTestId("usage-limit")).toBeVisible();
    await checkScreen(page, "settings, wide, Usage and limits");

    await sections.filter({ hasText: "Connections and peers" }).click();
    await expect(page).toHaveURL(/#\/settings\/connections$/);
    await expect(shown.getByTestId("paired-workbench")).toBeVisible();
    await expect(shown.getByTestId("notifications")).toBeVisible();
    await expect(shown.getByTestId("device")).toHaveCount(1);
    await expect(shown.getByTestId("device")).toContainText("This device");
    await expect(shown.getByRole("button", { name: "Sign out" })).toBeVisible();
    await checkScreen(page, "settings, wide, Connections and peers");

    // The address that opens Settings at its agents, from the home screen's link: the group's heading takes the focus.
    await page.evaluate(() => (window.location.hash = "#/settings/agents"));
    await expect(page.getByRole("heading", { name: "Agents and models", level: 1 })).toBeFocused();
    await expect(sections.nth(0)).toHaveAttribute("aria-current", "page");
    // The addresses Permissions and Usage had, and the old sections', open the groups that hold them now.
    for (const [old, at, n] of [["#/trust", "permissions", 3], ["#/usage", "usage", 4], ["#/settings/devices", "connections", 5], ["#/settings/appearance", "identity", 2]] as const) {
      await page.goto(`${botbench.base}/${old}`);
      await expect(page).toHaveURL(new RegExp(`#/settings/${at}$`));
      await expect(sections.nth(n)).toHaveAttribute("aria-current", "page");
    }
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: PHONE });

  test("no column of chats and work and no settings navigation: the screens are as before, and Settings is the list of its six groups, each a screen of its own", async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    await expect(page.getByTestId("work-column")).toHaveCount(0);
    await expect(page.locator(".ds-split-panel")).toHaveCount(0);
    // A touch screen: Enter starts a new line there, so no line says that it sends.
    await expect(page.getByTestId("composer-keys")).toHaveCount(0);
    await checkDesign(page, "chat, phone, no column");
    await page.evaluate((id) => (window.location.hash = `#/tasks/${id}`), seeded.ready.id);
    await expect(page.getByRole("heading", { level: 1, name: seeded.ready.title })).toBeVisible();
    await expect(page.getByTestId("work-column")).toHaveCount(0);
    await checkDesign(page, "task, phone, no column");

    await goTo(page, "Settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page.getByTestId("settings-nav")).toHaveCount(0);
    // The six groups, each a row that opens it, in the order the navigation has them from 1024px.
    const groups = page.getByTestId("settings-groups").getByRole("link");
    await expect(groups).toHaveText(Object.values(GROUPS).map((name) => new RegExp(`^${name}`)));
    await checkScreen(page, "settings, phone, the list of groups");

    await groups.filter({ hasText: "Permissions and autonomy" }).click();
    await expect(page).toHaveURL(/#\/settings\/permissions$/);
    await expect(page.getByRole("heading", { name: "Permissions and autonomy", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Where this is" }).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings");
    await checkScreen(page, "permissions, phone, its own screen");
    await page.evaluate(() => (window.location.hash = "#/settings/agents"));
    await expect(page.getByRole("heading", { name: "Agents and models", level: 1 })).toBeFocused();
  });
});
