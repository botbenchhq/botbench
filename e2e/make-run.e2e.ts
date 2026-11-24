import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { startBotbench, type Botbench } from "./botbench.ts";
import { checkDesign, expect, messageBox, openComposer, sendChat, signIn, startTaskIn } from "./helpers.ts";

// "Make this a run" in the real client, against a real Botbench process whose Claude Code replays turns recorded from
// real sessions (e2e/serve-replayed-make-run.ts, the owner's approved exception). Two journeys, each: type a note, press
// Make this a run, see the composer on Plan a run with the note in it, and no run stored. Everything else (the refusals,
// the address, the opening state, the hand-off, the run Send makes) is proven by unit and real-SQLite tests
// (test/make-run.test.ts, test/route.test.ts, test/engine/run-source.test.ts, test/api/run-sources.test.ts). Each new
// screen is checked at a phone's width and a desktop's, in light and in dark (checkDesign, with the screen words).

const test = base.extend<{ botbench: Botbench }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-make-run.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

/** Check the screen as it is now at 390px and 1280px, in light and in dark, and leave it at a phone's width in dark. */
async function everyLook(page: Page, screen: string): Promise<void> {
  // Drawn at rest: the pointer left where the last press was would hover whatever the other width puts there.
  await page.mouse.move(0, 0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
      await checkDesign(page, `${screen}, ${width}px, ${mode}`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
}

const runs = async (page: Page, botbench: Botbench): Promise<unknown[]> => ((await (await page.request.get(`${botbench.base}/api/runs`)).json()) as { runs: unknown[] }).runs;

test("a task ready for review: the note opens Plan a run with it, and no run exists yet", async ({ page, botbench }) => {
  test.setTimeout(120_000);
  const repo = path.join(path.dirname(botbench.home), "calc-repo");
  initRepo(repo, { "calc.py": "def add(a, b):\n    return a - b\n" });
  await signIn(page, botbench);
  await startTaskIn(page, repo, "Fix add in calc.py so it returns the sum.");
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 90_000 });

  const section = page.getByTestId("make-run-section");
  await section.getByLabel("Note for the run", { exact: true }).fill("Now add a subtract function next to add.");
  // The note's field and its button are the rebuilt screen's own, as the note box beside them.
  await expect(section.getByTestId("make-run-note")).toHaveAttribute("data-slot", "textarea");
  await expect(section.getByTestId("make-run")).toHaveAttribute("data-slot", "button");
  await everyLook(page, "task ready for review, Make this a run");
  await section.getByRole("button", { name: "Make this a run" }).click();

  await expect(page).toHaveURL(/#\/turn\?start=run&from=task-\d+$/);
  await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe what to plan");
  await expect(messageBox(page)).toHaveValue("Now add a subtract function next to add.");
  await expect(page.getByTestId("run-source-line")).toHaveText(/^From task \d+$/);
  expect(await runs(page, botbench)).toEqual([]);
  await everyLook(page, "composer opened from a task");
  // Crossing 1024px leaves the screen as it was: the note is still in the box.
  await expect(messageBox(page)).toHaveValue("Now add a subtract function next to add.");
});

test("a chat: the note opens Plan a run with it, and no run exists yet", async ({ page, botbench }) => {
  test.setTimeout(120_000);
  await signIn(page, botbench);
  await openComposer(page);
  // Make this a run is offered once the chat has a message, while the reply may still be running: no wait on it.
  await sendChat(page, "Fetch https://example.com and tell me its title.");
  await page.getByTestId("make-run-chat").getByRole("button", { name: "Make this a run" }).click();

  const dialog = page.getByTestId("make-run-dialog");
  await dialog.getByLabel("Note for the run", { exact: true }).fill("Add the page's title to the README.");
  await everyLook(page, "chat, Make this a run");
  await dialog.getByRole("button", { name: "Make this a run" }).click();

  await expect(page).toHaveURL(/#\/turn\?start=run&from=chat-\d+$/);
  await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe what to plan");
  await expect(messageBox(page)).toHaveValue("Add the page's title to the README.");
  await expect(page.getByTestId("run-source-line")).toHaveText("From a chat");
  expect(await runs(page, botbench)).toEqual([]);
  await everyLook(page, "composer opened from a chat");
  // Crossing 1024px leaves the screen as it was: the note is still in the box.
  await expect(messageBox(page)).toHaveValue("Add the page's title to the README.");
});
