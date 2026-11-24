import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { startBotbench, type Botbench } from "./botbench.ts";
import { expect, messageBox, pictures, sendChat, SHOTS, signIn } from "./helpers.ts";
import { signInAtHome, startTask, test as seededTest } from "./home-seed.ts";
import { choose, GROUPS, openSettingsGroup, type Group } from "./settings-helpers.ts";

// The pictures of the built product kept in docs/design/built/final: every screen of the shell at the five sizes the
// design names, to be read by eye after a change to the shell. Run with
//   BOTBENCH_SHOTS=docs/design/built/final npx playwright test --config e2e/playwright.config.ts --project pictures
// and skipped without BOTBENCH_SHOTS. No model turn: the work is put in the store through the engine (home-seed.ts),
// the task at work is a recorded turn held where it stands, and the chat's request is a recorded chat turn
// (serve-replayed-chat.ts). The paired-workbench conversation is pictured by its own journey (paired.e2e.ts, `built`).

base.skip(!SHOTS, "BOTBENCH_SHOTS names no folder for the pictures");

seededTest("pictures: Home, Work, a task in each state, a run with its plan waiting, New chat or task and Settings", async ({ page, botbench, seeded }) => {
  seededTest.setTimeout(600_000);
  await signInAtHome(page, botbench);
  const at = (hash: string): string => `${botbench.base}/${hash}`;
  const title = (): Promise<unknown> => expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const working = await startTask(page, botbench, seeded.repo, "Add a greeting to the README");

  await pictures(page, "home", at("#/"), () => expect(page.getByTestId("headline")).toBeVisible());
  await pictures(page, "work", at("#/work"), () => expect(page.getByTestId("work-row").first()).toBeVisible());
  await pictures(page, "task-ready-for-review", at(`#/tasks/${seeded.ids.result}`), () => expect(page.getByTestId("verification-heading")).toBeVisible());
  await pictures(page, "task-working", at(`#/tasks/${working}`), () => expect(page.getByTestId("working")).toBeVisible());
  await pictures(page, "task-stopped", at(`#/tasks/${seeded.ids.failure}`), () => expect(page.getByTestId("what-happened")).toBeVisible());
  await pictures(page, "task-approval-waiting", at(`#/tasks/${seeded.ids.approval}`), () => expect(page.getByTestId("approval-card")).toHaveAttribute("data-settled", ""));
  await pictures(page, "run-plan-waiting", at(`#/runs/${seeded.ids.plan}`), async () => (await title(), await expect(page.getByTestId("plan-task-text").first()).toBeVisible()));
  await pictures(page, "new", at("#/new"), () => expect(messageBox(page)).toBeEnabled());
  for (const group of Object.keys(GROUPS) as Group[]) {
    // Agents and models is pictured once each agent's check has come back.
    await pictures(page, `settings-${group}`, at(`#/settings/${group}`), async () => (await expect(page.getByRole("heading", { level: 1, name: GROUPS[group] })).toBeVisible(), await expect(page.getByText("Checking", { exact: true })).toHaveCount(0)));
  }
});

const chatTest = base.extend<{ botbench: Botbench }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-chat.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

chatTest("pictures: sign-in, and Chat with an approval waiting", async ({ page, botbench }) => {
  chatTest.setTimeout(300_000);
  await page.goto(botbench.base);
  await pictures(page, "sign-in", botbench.base, () => expect(page.getByLabel("Login token")).toBeVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, botbench);
  await openSettingsGroup(page, "permissions");
  await choose(page, "Web access", "Ask");
  await expect(page.getByTestId("web-access-saved")).toHaveText("Saved.");
  await page.goto(`${botbench.base}/#/turn`);
  await expect(messageBox(page)).toBeEnabled();
  await sendChat(page, "Fetch https://example.com and tell me its title.");
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 30_000 });
  await pictures(page, "chat-approval-waiting", page.url(), () => expect(page.getByTestId("approval-card")).toHaveAttribute("data-settled", ""));
});
