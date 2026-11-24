import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { checkDesign, expect, messageBox, signIn } from "./helpers.ts";
import { checkNext } from "./settings-helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Crossing the 1024px width, where a screen gains or loses the column of chats and work beside it (issue #156): from
// 1280×800 down to 390×844 and back, in light and in dark. Each screen keeps its one h1, and what the owner typed in a
// message box and did not send is still there, because the screen is not mounted again: the Chat composer, and the note
// box of a task that is ready for review. Permissions, a section of the two-pane Settings when wide and a screen of its
// own when narrow, draws its own h1 after narrowing and Settings' after widening; it has no box to type in. No model
// turn: before Botbench starts, the task is put in its real store through the engine itself, its work committed to its
// real branch, and the real Botbench process shows it.

const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Fix the login timeout";

const test = base.extend<{ dir: string; seeded: { home: string; taskId: number }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-breakpoint-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    initRepo(repo, { "README.md": "# Sample\n" });
    const db = openStore(home);
    const ready = createTask(db, { repo, prompt: TITLE });
    const worktree = await createWorktree({ repo, home, run: `run-${ready.runId}`, task: `task-${ready.id}` });
    moveTask(db, ready.id, "building", { worktree });
    write(worktree.path, "src/login.ts", "export const timeout = 30;\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${ready.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, ready.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    db.close();
    await use({ home, taskId: ready.id });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
});

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });

/** Narrow to a phone's width and widen back, checking after each crossing what `still` checks. */
async function across(page: Page, still: (width: number) => Promise<void>): Promise<void> {
  await page.setViewportSize(PHONE);
  await still(PHONE.width);
  await page.setViewportSize(WIDE);
  await still(WIDE.width);
}

for (const appearance of ["light", "dark"] as const) {
  test(`${appearance}: from 1280 to 390 and back, Chat keeps its h1 and the unsent message, a task keeps its h1 and the unsent note, and Permissions draws its own h1 at each width`, async ({ page, botbench, seeded }) => {
    await page.setViewportSize(WIDE);
    await page.goto(botbench.base);
    await page.evaluate((choice) => window.localStorage.setItem("botbench.appearance", choice), appearance);
    await page.reload();
    await signIn(page, botbench);
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);

    // Chat, with the column beside it: a message typed and not sent stays through both crossings.
    const message = "Draft that is not sent yet: rename the timeout setting";
    await expect(page.getByRole("region", { name: "Chats and work" })).toBeVisible();
    await messageBox(page).fill(message);
    await expect(h1(page)).toHaveText("Chat");
    await across(page, async (width) => {
      await expect(h1(page)).toHaveCount(1);
      await expect(h1(page)).toHaveText("Chat");
      await expect(messageBox(page)).toHaveValue(message);
      await expect(page.getByRole("region", { name: "Chats and work" })).toHaveCount(width >= 1024 ? 1 : 0);
    });
    await checkDesign(page, `chat, ${appearance}, wide again after a phone's width`);

    // A task that is ready for review: its title is its h1, and a note typed in its box and not sent stays.
    await page.goto(`${botbench.base}/#/tasks/${seeded.taskId}`);
    await expect(h1(page)).toHaveText(TITLE);
    const note = page.getByTestId("task-note").getByLabel("Your note");
    const typed = "Also keep the old timeout as a fallback";
    await note.fill(typed);
    await across(page, async () => {
      await expect(h1(page)).toHaveCount(1);
      await expect(h1(page)).toHaveText(TITLE);
      await expect(note).toHaveValue(typed);
      await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);
    });
    await page.setViewportSize(PHONE);
    await checkDesign(page, `task, ready for review, ${appearance}, at a phone's width after a wide one`);
    await page.setViewportSize(WIDE);

    // Permissions and autonomy: beside the settings navigation when wide, a screen of its own when narrow, with its
    // one h1 either way. Its old address opens it.
    await page.goto(`${botbench.base}/#/trust`);
    await expect(h1(page)).toHaveText("Permissions and autonomy");
    await expect(page.getByTestId("settings-nav").locator("[aria-current=page]")).toHaveText("Permissions and autonomy");
    await page.setViewportSize(PHONE);
    await expect(h1(page)).toHaveCount(1);
    await expect(h1(page)).toHaveText("Permissions and autonomy");
    await expect(h1(page)).toBeInViewport();
    await expect(page.getByTestId("settings-nav")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Always allowed", level: 2 })).toBeVisible();
    await checkNext(page, `permissions, ${appearance}, at a phone's width after a wide one`);
    await page.setViewportSize(WIDE);
    await expect(h1(page)).toHaveCount(1);
    await expect(h1(page)).toHaveText("Permissions and autonomy");
    await expect(page.getByTestId("settings-nav").locator("[aria-current=page]")).toHaveText("Permissions and autonomy");
  });
}
