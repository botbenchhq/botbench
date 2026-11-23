import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, tallShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// AE4 on the task screen (#153, U21), yes or no, in the real client: a real Botbench process, a real temporary
// repository, the owner's Claude Code building on Haiku and the owner's Codex on its cheapest model, each on its own
// sign-in. A task is started on Claude Code; once its first file is in the task's copy, the owner presses "Move to
// Codex" on the task's screen; the task ends Ready for review with the hand-off line and one transcript in which both
// agents' sessions are named. The screen is checked at 390×844 and at 1280×800, light and dark. Live model turns:
// run with `npx playwright test -c e2e/playwright.config.ts e2e/handoff.e2e.ts` on a Mac where both CLIs are signed in.

const CODEX_MODEL = process.env.CODEX_LIVE_MODEL ?? "gpt-6-luna";
// A node one-liner, not `sleep`: Claude Code's harness refuses a foreground `sleep` (see test/live/handoff.live.test.ts).
const PROMPT = "Work in this order. First create the file one.txt containing the word one. Then run the shell command `node -e 'setTimeout(() => {}, 45000)'` in the foreground and wait for it to finish. Then create the file two.txt containing the word two. Change nothing else.";

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-handoff-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo);
    await use(fs.realpathSync(repo));
  },
  botbench: async ({ dir }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" }, codex: { model: CODEX_MODEL } } } });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

/** The task screen at a phone's size and a desktop's, light and dark, each through the design checks. */
async function everySize(page: Page, name: string): Promise<void> {
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize(size);
      // The appearance is the owner's choice in Settings, kept in the browser (web/src/app/appearance.ts); dark by default.
      await page.evaluate((mode) => window.localStorage.setItem("botbench.appearance", mode), colorScheme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(page.getByTestId("task-status")).toBeVisible();
      await checkDesign(page, `${name} at ${size.width}, ${colorScheme}`);
      if (SHOTS) await tallShot(page, path.join(SHOTS, `${name}-${size.width}-${colorScheme}.png`));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test("LIVE AE4: a task building on Claude Code is moved to Codex from its screen and ends Ready for review, with the hand-off line and both agents in one transcript", async ({ page, botbench, repo }) => {
  test.setTimeout(900_000);
  await signIn(page, botbench);
  const started = await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt: PROMPT, agent: "claude-code", model: "haiku" } });
  expect(started.status(), await started.text()).toBe(200);
  const { taskId } = (await started.json()) as { taskId: number };
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);

  // Mid-build: Claude Code wrote one.txt, and the screen offers Codex.
  const worktree = path.join(botbench.home, "worktrees");
  await expect.poll(() => fs.existsSync(worktree) && fs.readdirSync(worktree, { recursive: true }).some((f) => String(f).endsWith("one.txt")), { timeout: 300_000 }).toBe(true);
  const move = page.getByTestId("task-move");
  await expect(move.getByRole("heading", { name: "Move to another agent" })).toBeVisible({ timeout: 60_000 });
  await expect(move.getByRole("button", { name: "Claude Code" })).toHaveCount(0);
  await everySize(page, "handoff-offered");
  await move.getByRole("button", { name: "Move to Codex" }).click();

  // Codex takes it over and finishes; the screen says what happened.
  await expect(page.getByTestId("handoff-line")).toHaveText(["Moved from Claude Code to Codex: you chose to move it."], { timeout: 120_000 });
  await expect(page.getByTestId("task-status")).toContainText("Ready for review", { timeout: 600_000 });
  await expect(page.getByTestId("task-move")).toHaveCount(0);
  // The model Claude Code was asked to use is not set against the model Codex answered on.
  await expect(page.getByTestId("task-model")).toHaveCount(0);
  const transcript = page.getByRole("region", { name: "Transcript" });
  await expect(transcript).toContainText("Claude Code");
  await expect(transcript).toContainText("Codex");
  const task = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { builder: string; files: { path: string }[] | null; handoffs: unknown[] };
  expect(task.builder).toBe("codex");
  expect(task.handoffs).toHaveLength(1);
  expect((task.files ?? []).map((f) => f.path).sort()).toEqual(["one.txt", "two.txt"]);
  await everySize(page, "handoff-done");
});
