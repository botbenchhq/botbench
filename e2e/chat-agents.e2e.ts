import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createChat } from "../src/api/chat.ts";
import { createTurns } from "../src/api/turns.ts";
import { ClaudeCodeDriver } from "../src/drivers/claude-code.ts";
import { openStore } from "../src/store/db.ts";
import { chatReplayDriver } from "../test/support/replay-chat.ts";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, chooseRepository, closeContext, expect, messageBox, openRow, signIn, tallShot, tempShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Chat with any agent, or several at once, in the real client at a phone's size.
// 1. No model turn. Before Botbench starts, a chat is made through the chat itself (src/api/chat.ts) with Codex, Grok
//    and Antigravity replaying sessions captured from their real CLIs (test/support/replay-chat.ts, the owner's approved
//    exception): one message asked of all three, then Codex asked to compare their answers. The real Botbench process
//    shows it; the agent choice is drawn from each agent's real check on this Mac.
// 2. LIVE: Codex chosen for a chat, one cheap real turn, and its reply named as Codex's.

const SHOTS = process.env.BOTBENCH_SHOTS;
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
};
const QUESTION = "Name one more primary colour, in one word, and say in one short sentence why it is primary.";

const test = base.extend<{ dir: string; seeded: { home: string; conversation: number[] }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-chat-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const db = openStore(home);
    const claude = new ClaudeCodeDriver();
    const turns = createTurns({ db, home, driver: claude, onEvent: () => {} });
    const chat = createChat({ db, home, turns, claude, agents: { codex: chatReplayDriver("codex", ["chat", "compare"]), grok: chatReplayDriver("grok"), antigravity: chatReplayDriver("antigravity") }, onEvent: () => {} });
    const asked = await chat.send({ message: QUESTION, conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }, { agent: "grok", model: "grok-4.7-build-fast" }, { agent: "antigravity", model: "gemini-3.8-flash-low" }] });
    const wait = async (ids: number[]) => {
      while (ids.some((id) => chat.turnRunning(id))) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await wait(asked.map((r) => r.attemptId));
    const compared = await chat.send({ message: "", conversation: asked.map((r) => r.attemptId), agents: [{ agent: "codex", model: "gpt-6-luna" }], compare: asked[0]!.roundId! });
    await wait(compared.map((r) => r.attemptId));
    await chat.close();
    await turns.close();
    db.close();
    await use({ home, conversation: [...asked, ...compared].map((r) => r.attemptId) });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    await botbench.stop();
  },
});

test("the agent choice offers each agent with its state and Ask several; a chat three agents answered names each reply, and a comparison reads as one", async ({ page, botbench, seeded, dir }) => {
  test.setTimeout(240_000);
  await signIn(page, botbench);

  // The agent view: each agent from its own check, the one line about what the others cannot do, and Ask several.
  let sheet = await openRow(page, "Model");
  await expect(sheet.getByRole("heading", { name: "Agent and model" })).toBeVisible();
  await expect(sheet.getByTestId("agent-hint")).toHaveText("Codex, Grok and Antigravity answer from the conversation alone: they cannot read your files or change anything here. Botbench gives each the chat so far.");
  for (const name of ["Claude Code", "Codex", "Grok", "Antigravity"]) await expect(sheet.getByRole("radio", { name, exact: true })).toBeVisible({ timeout: 60_000 });
  await sheet.getByRole("radio", { name: "Ask several" }).check();
  await expect(sheet.getByTestId("several-about")).toHaveText("Your message and the chat so far, with what each agent wrote, go to every agent you tick.");
  await sheet.getByRole("checkbox", { name: /^Claude Code/ }).uncheck();
  await checkDesign(page, "chat, agent choice, ask several");
  await tempShot(page, "1-agent-view");
  await closeContext(page);
  await messageBox(page).fill("Hello");
  await expect(page.getByRole("button", { name: /^Send to \d agents$/ })).toBeVisible();
  await expect(page.getByTestId("asked-line")).toHaveText(/^Asks \d agents: each reply counts toward that agent's usage\.$/);

  // The chat made before Botbench started: the owner's message once, then each agent's reply named with its model.
  await page.evaluate((ids) => window.localStorage.setItem("botbench.conversation", JSON.stringify(ids)), seeded.conversation);
  await page.reload();
  const log = page.getByRole("log", { name: "Transcript" });
  await expect(log.locator('[data-event="text"]')).toHaveCount(4);
  await expect(log.locator('[data-event="user_prompt"]')).toHaveCount(2);
  await expect(log.locator('[data-event="user_prompt"]').first()).toContainText(QUESTION);
  await expect(log.locator('[data-event="user_prompt"]').first()).not.toContainText("[From Botbench");
  const labels = await log.locator('[data-event="text"] .ds-message__label').allInnerTexts();
  expect(labels.slice(0, 3).sort()).toEqual(["Antigravity · gemini-3.8-flash-low", "Codex · gpt-6-luna", "Grok · grok-4.7-build-fast"]);
  await expect(log.locator('[data-event="user_prompt"]').nth(1)).toHaveText(/Codex, compare the answers above: where they agree, where they differ, and which you would act on\./);
  await expect(log.locator('[data-event="text"]').last()).toContainText("All three name");
  await expect(log.locator('[data-event="text"]').last().locator(".ds-message__label")).toHaveText("Codex · gpt-6-luna");
  // The newest round is a comparison: nothing more to compare.
  await expect(page.getByTestId("compare-action")).toHaveCount(0);
  await checkDesign(page, "chat, three agents and a comparison");
  await shot(page, "2-three-agents-and-compare.png");

  // With a repository, the builder is Claude Code, and the view says why in one line.
  const repo = path.join(dir, "repo");
  initRepo(repo);
  await chooseRepository(page, repo);
  sheet = await openRow(page, "Model");
  await expect(sheet.getByTestId("builder-only")).toHaveText("Only Claude Code can work in a repository. Codex, Grok and Antigravity can be asked in a chat with no repository.");
  await expect(sheet.getByRole("radio", { name: "Codex" })).toHaveCount(0);
  await closeContext(page);
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Claude Code");
});

test("LIVE: Codex chosen for a chat answers, and its reply is named as Codex's", async ({ page, botbench }) => {
  test.setTimeout(240_000);
  await signIn(page, botbench);
  const sheet = await openRow(page, "Model");
  await sheet.getByRole("radio", { name: "Codex", exact: true }).check({ timeout: 60_000 });
  await sheet.getByTestId("model-codex-options").getByRole("radio", { name: /luna/i }).first().check();
  await closeContext(page);
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Codex");
  await page.getByLabel("Message Codex").fill("Reply with exactly the word: marmot");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.locator('[data-event="text"]');
  await expect(reply).toContainText(/marmot/i, { timeout: 180_000 });
  await expect(reply.locator(".ds-message__label")).toHaveText(/^Codex · /);
  await expect(page.locator('[data-event="user_prompt"]')).toHaveText(/Reply with exactly the word: marmot/);
  await expect(page.locator('[data-event="user_prompt"]')).not.toContainText("[From Botbench");
  await checkDesign(page, "chat with Codex");
});
