import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { startBotbench, type Botbench } from "./botbench.ts";
import { checkDesign, expect, messageBox, openComposer, sendChat, signIn } from "./helpers.ts";

// A chat's Claude Code asking for approval, in the real client at a phone's size, against a real Botbench process whose
// Claude Code, in a chat only, replays real chat turns that asked to fetch https://example.com (e2e/serve-replayed-chat.ts,
// the owner's approved exception). No model turn: the first chat turn is the one the owner allowed, the next the one
// the owner denied. The owner picks Ask for "Web access in chat" in Settings, as a person would.

const test = base.extend<{ botbench: Botbench }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-chat.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

test("with Ask, a chat's fetch waits as a card in the chat, Allow once continues and the answer arrives without a reload; a denied one says so in one line", async ({ page, botbench }) => {
  test.setTimeout(120_000);
  await signIn(page, botbench);

  // Settings: web access in chat is Allow until the owner picks Ask.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const web = page.getByLabel("Web access in chat");
  await expect(web).toHaveValue("allow");
  await web.selectOption("ask");
  await checkDesign(page, "settings, web access in chat");
  await page.reload();
  await expect(page.getByLabel("Web access in chat")).toHaveValue("ask");
  await openComposer(page);
  await expect(messageBox(page)).toBeEnabled();

  await sendChat(page, "Fetch https://example.com and tell me its title.");
  const log = page.getByRole("log", { name: "Transcript" });
  const card = log.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  // In the transcript, right after the call that asked.
  const asked = log.locator('li[data-event="permission_request"]');
  await expect(asked.getByTestId("approval-card")).toBeVisible();
  await expect(asked.locator("xpath=preceding-sibling::li[1]")).toContainText("Wants to fetch");
  await expect(card.getByTestId("approval-line")).toHaveText("Wants to fetch https://example.com");
  await expect(card.getByRole("button")).toHaveText(["Allow once", "Deny"]);
  await expect(card.getByText("Deny and say what to do instead")).toBeVisible();
  await expect(card.getByTestId("approval-directory")).toHaveCount(0);
  await expect(card.getByTestId("standing-offer")).toHaveCount(0);
  await expect(page.getByTestId("approval-tray")).toHaveText("An approval is waiting on this screen.");
  await expect(log.getByRole("status")).toHaveText("Claude Code is waiting for your answer.");
  await checkDesign(page, "chat, an approval card in the transcript");

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card).toHaveCount(0);
  await expect(log.locator('[data-event="text"]').last()).toContainText("Example Domain", { timeout: 30_000 });
  await expect(page.getByTestId("approval-tray")).toBeEmpty();

  // The next turn is denied: one plain line, and what Claude Code was told behind Technical details, closed.
  await sendChat(page, "Fetch https://example.com and tell me its title.");
  const second = log.getByTestId("approval-card");
  await expect(second).toBeVisible({ timeout: 30_000 });
  await second.getByText("Deny and say what to do instead").click();
  await second.getByLabel("What Claude Code should do instead").fill("Do not fetch it. Answer from what you already know.");
  await second.getByRole("button", { name: "Deny and send" }).click();
  await expect(second).toHaveCount(0);
  const denied = log.locator('[data-event="tool_call"]').filter({ hasText: "example.com" }).last().locator(".ds-tool-call");
  await expect(denied).toHaveAttribute("data-state", "declined", { timeout: 30_000 });
  await expect(denied.locator(".ds-tool-call__note")).toHaveText("You denied this.");
  const told = denied.locator('[data-event="tool_result"]');
  await expect(told).toContainText("What Claude Code was told");
  await expect(told).toBeHidden();
  await expect(log.locator('[data-event="text"]').last()).toContainText("Example Domain", { timeout: 30_000 });
  await checkDesign(page, "chat, a denied fetch");
});
