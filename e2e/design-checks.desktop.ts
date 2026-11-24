import fs from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page } from "@playwright/test";
import { createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { checkDesign, closeContext, contextSheet, expect, messageBox, openContext, SHOTS, signIn, tallShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The design checks at a desktop's size, 1280x800, in dark and in light: every main screen (Chat, Work, a task, a run,
// Settings and each of its sections, the composer and its Add context sheet) with seeded data. This file is the only
// one the desktop project of e2e/playwright.config.ts runs, and the phone project does not run it (it is not a
// *.e2e.ts file), so no test runs twice. No model turn: before Botbench starts, a run and a task are put in its real
// store through the engine itself (the task's work is committed to its real branch), and the real Botbench process
// shows them. Screenshots are kept under BOTBENCH_SHOTS as `desktop-<screen>-<mode>.png`, beside the phone ones.

interface Seeded {
  home: string;
  repo: string;
  task: number;
  run: number;
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-design-desktop-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const baseCommit = initRepo(repo, { "README.md": "# Sample\n" });
    const db = openStore(home);
    const task = createTask(db, { repo, prompt: "Fix the login timeout" });
    const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, "src/login.ts", "export const timeout = 30;\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    const run = createRun(db, { repo, prompt: "Plan the billing export", baseCommit });
    storePlan(db, run.id, [{ title: "Write the exporter", criteria: ["It writes a CSV file"] }]);
    db.close();
    await use({ home, repo: fs.realpathSync(repo), task: task.id, run: run.id });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    expect((await botbench.stop()).leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

test.use({ viewport: { width: 1280, height: 800 } });

/** Open `hash`, wait for `ready`, and judge the screen. */
async function screen(page: Page, botbench: Botbench, o: { hash: string; name: string; ready: (page: Page) => Locator; mode: string }): Promise<void> {
  await page.goto(`${botbench.base}/${o.hash}`);
  await expect(o.ready(page)).toBeVisible();
  await checkDesign(page, `${o.name}, desktop, ${o.mode}`);
  if (SHOTS) await tallShot(page, path.join(SHOTS, `desktop-${o.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${o.mode}.png`));
}

for (const mode of ["dark", "light"] as const) {
  test(`every main screen passes the design checks at 1280x800 in ${mode}`, async ({ page, botbench, seeded }) => {
    await signIn(page, botbench);
    // Match device, with the device set to the mode under test: the page is drawn in it from the first paint.
    await page.emulateMedia({ colorScheme: mode });
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "auto"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "auto");

    const heading = (name: string) => (p: Page) => p.getByRole("heading", { name, level: 1 });
    await screen(page, botbench, { hash: "#/", name: "Chat", ready: () => messageBox(page), mode });
    await screen(page, botbench, { hash: "#/work", name: "Work", ready: heading("Work"), mode });
    await screen(page, botbench, { hash: `#/tasks/${seeded.task}`, name: "task, ready for review", ready: (p) => p.getByTestId("task-status"), mode });
    await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);
    // The run screen is rebuilt on shadcn/ui (ADR 0012) and is not drawn with the design system's classes: its checks, in dark and in light, are e2e/run.e2e.ts's.
    await screen(page, botbench, { hash: "#/settings", name: "Settings, Agents", ready: (p) => p.getByRole("region", { name: "Agents" }), mode });
    await screen(page, botbench, { hash: "#/settings/appearance", name: "Settings, Appearance", ready: (p) => p.getByTestId("settings-section").getByRole("group", { name: "Appearance" }), mode });
    await screen(page, botbench, { hash: "#/settings/notifications", name: "Settings, Notifications", ready: (p) => p.getByTestId("notifications"), mode });
    await screen(page, botbench, { hash: "#/settings/devices", name: "Settings, Signed-in devices", ready: (p) => p.getByTestId("device").first(), mode });
    await screen(page, botbench, { hash: "#/settings/workbench", name: "Settings, This workbench", ready: (p) => p.getByTestId("workbench-name"), mode });
    // From 1024px Permissions and Usage are sections of the two-pane Settings, at their own addresses.
    await screen(page, botbench, { hash: "#/trust", name: "Settings, Permissions", ready: (p) => p.getByRole("region", { name: "Permissions" }), mode });
    await screen(page, botbench, { hash: "#/usage", name: "Settings, Usage", ready: (p) => p.getByRole("region", { name: "Usage" }), mode });

    // The composer, for a run, and its Add context sheet: an open dialog is a view of its own. With no repository
    // remembered the sheet opens by itself on its Repository view; it is closed first, so the composer is judged alone.
    await page.goto(`${botbench.base}/#/turn?start=run`);
    await expect(messageBox(page)).toBeVisible();
    if (await contextSheet(page).evaluate((d: HTMLDialogElement) => d.open)) await closeContext(page);
    await checkDesign(page, `composer, new run, desktop, ${mode}`);
    if (SHOTS) await tallShot(page, path.join(SHOTS, `desktop-composer-new-run-${mode}.png`));
    await openContext(page);
    await expect(contextSheet(page).getByRole("heading", { name: "Add context" })).toBeVisible();
    await checkDesign(page, `composer, Add context, desktop, ${mode}`);
    if (SHOTS) await tallShot(page, path.join(SHOTS, `desktop-composer-add-context-${mode}.png`));
  });
}
