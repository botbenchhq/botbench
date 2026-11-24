import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { checkoutState, git, initRepo, ownerCommit, write } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkDesign, expect, SHOTS, signIn, tallShot } from "./helpers.ts";

// "Bring up to date with main" on the task screen (#201), in the real client, against a real Botbench process whose
// Claude Code replays a turn recorded from a real session (e2e/serve-replayed-build.ts, the owner's approved exception),
// with a real temporary repository, a real setup command that makes the task's change, and a real check. No model turn:
// main moves by a real commit after the task is ready for review, and the merge is clean, so no agent is started again.
// The screen is checked at 390×844 and at 1280×800, light and dark, before and after.

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-update-main-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo, { "README.md": "# Sample\n" });
    await use(fs.realpathSync(repo));
  },
  botbench: async ({ dir, repo }, use) => {
    // The replayed builder goes on at once: the test needs the task built, not held.
    fs.writeFileSync(path.join(dir, "release-builder"), "");
    const botbench = await startBotbench({
      home: path.join(dir, "home"),
      entry: path.resolve(import.meta.dirname, "serve-replayed-build.ts"),
      settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { setup: ["printf 'hello\\n' > hello.txt"], checks: ["test -f hello.txt"] } } },
    });
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
      await expect(page.getByTestId("main-update")).toBeVisible();
      await checkDesign(page, `${name} at ${size.width}, ${colorScheme}`);
      if (SHOTS) await tallShot(page, path.join(SHOTS, `${name}-${size.width}-${colorScheme}.png`));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test("a ready task whose branch is behind main says so and offers Bring up to date with main; pressing it merges main into the branch, runs the checks again, and the task is ready for review again, up to date", async ({ page, botbench, repo }) => {
  test.setTimeout(180_000);
  await signIn(page, botbench);
  const started = await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt: "Add a greeting file" } });
  expect(started.status(), await started.text()).toBe(200);
  const { taskId } = (await started.json()) as { taskId: number };
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 60_000 });
  // A branch that holds everything on main has nothing unverified about main: the card is not drawn.
  const section = page.getByTestId("main-update");
  await expect(section).toHaveCount(0);

  // Main moves on in the owner's repository.
  write(repo, "README.md", "# Sample\n\nMain moved on.\n");
  const mainHead = ownerCommit(repo, "main moves on");
  const owner = checkoutState(repo);
  await page.reload();
  await expect(section.getByTestId("main-behind")).toHaveText("This branch is 1 commit behind main: main moved on since this task started.");
  await expect(section.getByTestId("main-choice")).toHaveText("Bring it up to date before you accept, so that what you accept is checked with what is on main now.");
  await expect(section.getByTestId("main-about")).toContainText("nothing already on the branch is rewritten, and nothing is pushed");
  const button = section.getByRole("button", { name: "Bring up to date with main" });
  await expect(button).toBeVisible();
  // Not the screen's primary action: Accept is.
  expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await everySize(page, "update-with-main-behind");

  await section.getByRole("button", { name: "Bring up to date with main" }).click();
  await expect(section.getByTestId("main-update-line")).toHaveText("Brought up to date with main: Botbench merged 1 commit with no conflict, then ran the checks again.", { timeout: 60_000 });
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);
  await expect(section.getByTestId("main-behind")).toHaveText("This branch holds everything on main.");
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("verification-heading")).toHaveText("1 of 1 check passed");
  // The task's changes are its own, measured from the main it merged, as a pull request shows them: main's README change is not among them.
  await expect(page.getByTestId("changed-files").locator("[data-slot=collapsible-trigger] code")).toHaveText(["hello.txt"]);
  await everySize(page, "update-with-main-done");

  // The branch holds main as a merge commit on top of the task's work; the owner's checkout is as it was.
  const task = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { branch: string; headCommit: string };
  expect(git(repo, "rev-parse", `${task.headCommit}^2`).trim()).toBe(mainHead);
  expect(git(repo, "rev-parse", task.branch).trim()).toBe(task.headCommit);
  expect(checkoutState(repo)).toEqual(owner);
});
