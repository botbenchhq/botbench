import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { taskTitle } from "../web/src/components/task-status.ts";
import type { Left } from "../test/support/leave-pending.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { checkDesign, expect, openDetails, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The task screen at a phone's width (390px, the tests' viewport), with no model turn. Before Botbench starts, a real
// Botbench process is killed while a task waits on an approval (test/support/leave-pending.ts), and a second task's
// work is committed through the engine itself: a prose file and a code file, each with a line far wider than a phone.
// Then the real Botbench process shows them: the waiting card, the branch, and the two diffs.

const PROSE_LINE = `${"This paragraph of the notes is one long line, as prose in a markdown file usually is, ".repeat(4)}and a word longer than the screen: ${"x".repeat(120)}.`;
const CODE_LINE = `export const settings = { ${Array.from({ length: 12 }, (_, i) => `option${i}: "a value that keeps the line going"`).join(", ")} };`;

const test = base.extend<{ dir: string; seeded: { home: string; waiting: Left; built: { id: number; branch: string; prompt: string } }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-layout-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": "#!/bin/sh\necho ran > marker.txt\n" });
    // A Botbench that stopped where it stood while its task waited for the owner; its session can be resumed, so the next start keeps the card.
    const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "..", "test", "support", "leave-pending.ts"), JSON.stringify({ home, repo, cursor: "5d1c7a52-8f0e-4b8e-9a3e-2f6b1c0d4e7a", commands: ["sh make-marker.sh"] })], { encoding: "utf8" });
    const waiting = JSON.parse(run.stdout) as Left;
    const db = openStore(home);
    const prompt = "Implement src/settings-and-preferences-loader.ts so that it reads the notes";
    const task = createTask(db, { repo, prompt });
    const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, "notes.md", `# Notes\n\n${PROSE_LINE}\n`);
    write(worktree.path, "src/settings.ts", `${CODE_LINE}\n`);
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    db.close();
    await use({ home, waiting, built: { id: task.id, branch: worktree.branch, prompt } });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    await botbench.stop();
  },
});

/** Whether the page itself scrolls sideways at this width. */
const pageScrollsSideways = (page: import("@playwright/test").Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth);

test("at 390px a waiting approval card comes right after the title; the branch is shown by name beside its copy button; a prose diff wraps and a code diff scrolls inside itself, and the page never scrolls sideways", async ({ page, botbench, seeded }) => {
  expect(page.viewportSize()?.width).toBe(390);
  await signIn(page, botbench);

  // The task waiting on an approval: the card is the first thing after the page's header, which holds only the title and its lines.
  await page.goto(`${botbench.base}/#/tasks/${seeded.waiting.taskId}`);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  const after = await page.evaluate(() => {
    const header = document.querySelector("header.ds-page-header");
    const next = header?.nextElementSibling;
    return { next: next?.getAttribute("data-testid") ?? next?.tagName ?? null, before: header?.previousElementSibling?.tagName ?? null, headings: header === null || header === undefined ? [] : [...header.querySelectorAll("h1")].map((h) => h.textContent) };
  });
  expect(after.next).toBe("approval-card");
  expect(after.before, "nothing is drawn before the header in the page").toBeNull();
  expect(after.headings).toEqual([taskTitle(seeded.waiting.taskId, "Run the command `sh make-marker.sh` with your Bash tool, exactly once.")]);
  // Above the card, on screen: the header and nothing else.
  const cardTop = (await card.boundingBox())!.y;
  const headerBottom = await page.locator("header.ds-page-header").evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
  expect(cardTop).toBeGreaterThanOrEqual(headerBottom);
  expect(await pageScrollsSideways(page)).toBe(false);
  // While the task is worked on, its branch is in Details: by name, as text, beside the button that copies it.
  const details = await openDetails(page);
  await expect(details.getByTestId("branch")).toHaveText(seeded.waiting.branch);
  await expect(details.getByTestId("branch")).toBeVisible();
  await expect(details.getByRole("button", { name: "Copy branch name" })).toBeVisible();
  await checkDesign(page, "task, an approval waiting, at 390px");

  // The task ready for review: its title is cut at a word boundary after 40 characters, never to one word.
  await page.goto(`${botbench.base}/#/tasks/${seeded.built.id}`);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("Implement src/settings-and-preferences-loader.ts…");
  const branch = page.getByTestId("branch");
  await expect(branch).toHaveText(seeded.built.branch);
  await expect(branch).toBeVisible();
  const copy = page.getByRole("button", { name: "Copy branch name" });
  await expect(copy).toBeVisible();
  // Beside it: on the same line, or just under it when the name fills the line.
  const [named, button] = [(await branch.boundingBox())!, (await copy.boundingBox())!];
  expect(Math.abs(named.y - button.y) < button.height + named.height).toBe(true);
  expect(await pageScrollsSideways(page)).toBe(false);

  const files = page.getByTestId("changed-files");
  for (const file of ["notes.md", "src/settings.ts"]) await files.locator("summary", { hasText: file }).click();
  const prose = page.getByRole("group", { name: "Changes in notes.md" });
  const code = page.getByRole("group", { name: "Changes in src/settings.ts" });
  await expect(prose.getByText(PROSE_LINE.slice(0, 40))).toBeVisible();
  await expect(code.getByText(CODE_LINE.slice(0, 40))).toBeVisible();

  // The prose wraps: nothing to scroll inside its diff, and its long line takes several lines of height.
  const proseBox = await prose.evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth }));
  expect(proseBox.scroll, "the prose diff does not scroll sideways").toBeLessThanOrEqual(proseBox.width);
  const wrapped = await prose.locator(".ds-diff__line--added .ds-diff__text").filter({ hasText: PROSE_LINE.slice(0, 40) }).evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(wrapped, "the long prose line is drawn on several lines").toBeGreaterThan(3);
  // The code keeps its lines whole and scrolls sideways inside its diff.
  const codeBox = await code.evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth, overflow: getComputedStyle(el).overflowX }));
  expect(codeBox.scroll, "the code diff is wider than its box").toBeGreaterThan(codeBox.width);
  expect(codeBox.overflow).toBe("auto");
  const codeLine = await code.locator(".ds-diff__line--added .ds-diff__text").filter({ hasText: CODE_LINE.slice(0, 40) }).evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(Math.round(codeLine), "the code line is one line").toBe(1);
  await code.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  expect(await code.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  // In neither case does the page scroll sideways.
  expect(await pageScrollsSideways(page)).toBe(false);
  await checkDesign(page, "task ready for review, prose and code diffs, at 390px");
});
