import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkDesign, closeContext, contextSheet, expect, messageBox, openContext, openRow, sendChat, signIn, tempShot } from "./helpers.ts";

// A chat that reads a repository, at a phone's size, with no model turn: a real Botbench process whose Codex, Grok and
// Antigravity replay sessions captured from their real CLIs (e2e/serve-replayed-agents.ts, test/support/replay-chat.ts:
// the owner's approved exception), a real temporary git repository, and the built client in Chrome. The repository is
// attached from Add context (Let this chat read a repository), checked by the real server, and sent with the message.

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-chat-read-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "code", "docs-site");
    initRepo(repo, { "README.md": "# Docs site\n" });
    await use(repo);
  },
  botbench: async ({ dir }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), entry: path.resolve(import.meta.dirname, "serve-replayed-agents.ts") });
    await use(botbench);
    expect((await botbench.stop()).leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

const QUESTION = "Name one more primary colour, in one word, and say in one short sentence why it is primary.";

/** The context list's rows as they read: the setting, then its value. */
const rows = (page: Page) =>
  contextSheet(page)
    .locator("button[data-row]")
    .evaluateAll((buttons) => buttons.map((b) => `${b.querySelector('[data-testid="context-row-label"]')!.textContent} ${b.querySelector('[data-testid="context-row-value"]')!.textContent}`));

/** Choose the one agent a chat asks, in the Model row's view. */
async function askOnly(page: Page, name: string): Promise<void> {
  const sheet = await openRow(page, "Model");
  const radio = sheet.getByRole("radio", { name, exact: true });
  await expect(radio).toBeEnabled({ timeout: 60_000 });
  await radio.check();
  await closeContext(page);
}

test("a repository attached under Let this chat read a repository is checked, sent with the message and read by Codex; an agent that cannot read it is named; removed, none is sent", async ({ page, botbench, repo }) => {
  test.setTimeout(120_000);
  // Every chat message the page sends, as its body.
  const sent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") sent.push(request.postDataJSON() as Record<string, unknown>);
  });
  await signIn(page, botbench);
  await askOnly(page, "Codex");

  // A chat's rows: the repository a task or run starts in, the one to read, and the model.
  await openContext(page);
  expect(await rows(page)).toEqual(["Repository None (just chat)", "Read a repository None", "Model Codex"]);

  // Its own view, with the same check the Repository row has.
  const sheet = await openRow(page, "Read a repository");
  await expect(sheet.getByRole("heading", { name: "Let this chat read a repository" })).toBeVisible();
  await expect(sheet.getByTestId("read-hint")).toHaveText(/^The agents you ask can read its files and its history, and never change it: nothing in it is written, committed or pushed\. .*Codex.* read it; Claude Code is not given it: it works on a repository only as a task, chosen under Repository\.$/);
  await expect(sheet.getByRole("radio", { name: "None" })).toBeChecked();
  await sheet.getByRole("radio", { name: "Another folder…" }).check();
  await sheet.getByLabel("Folder path").fill(path.join(path.dirname(repo), "missing"));
  await expect(sheet.getByTestId("read-state")).not.toHaveText(/^(Checking\.|Usable git repository\.)$/, { timeout: 15_000 });
  await expect(sheet.getByLabel("Folder path")).toHaveAttribute("aria-invalid", "true");
  // Refused by the server: Send waits, saying why in the server's words.
  await closeContext(page);
  await messageBox(page).fill(QUESTION);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByTestId("composer-reason")).toHaveText(/ Choose another repository for the chat to read, or choose None\.$/);

  await openRow(page, "Read a repository");
  await sheet.getByLabel("Folder path").fill(repo);
  await expect(sheet.getByTestId("read-state")).toHaveText("Usable git repository.", { timeout: 15_000 });
  await checkDesign(page, "add context, let this chat read a repository");
  await tempShot(page, "chat-read-view");
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
  expect(await rows(page)).toEqual(["Repository None (just chat)", "Read a repository docs-site", "Model Codex"]);
  await closeContext(page);

  // Under the box: what is read, and that it is never changed. The box is still a chat's.
  await expect(page.getByTestId("read-line")).toHaveText("For the chat to read: docs-site. The agents you ask can read its files and its history, and never change it: nothing in it is written, committed or pushed.");
  await expect(page.getByTestId("composer-about")).toContainText("It can read docs-site, and never change it.");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  // An agent that cannot read a repository: Send waits, and says the repository is read only by the other agents.
  await askOnly(page, "Claude Code");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByTestId("composer-reason")).toHaveText("Claude Code works on a repository only as a task, in a separate copy, so a chat does not give it one. The repository is read only by the other agents: ask only them, or choose None for the repository to read.");
  await checkDesign(page, "chat, a repository to read and an agent that cannot read it");
  expect(sent).toEqual([]);
  await askOnly(page, "Codex");

  // Sent: the request carries the repository, and Codex's reply appears.
  await page.getByRole("button", { name: "Send" }).click();
  const log = page.getByRole("log", { name: "Transcript" });
  await expect(log.locator('[data-event="text"]').last()).toContainText("Blue.", { timeout: 30_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ prompt: QUESTION, agents: [{ agent: "codex" }], repository: repo });
  await checkDesign(page, "chat, a reply from Codex that read a repository");
  await tempShot(page, "chat-read-reply");

  // Removed: the next message carries no repository at all, and is answered.
  await openRow(page, "Read a repository");
  await sheet.getByRole("radio", { name: "None" }).click();
  await expect(sheet.getByRole("heading", { name: "Add context" })).toBeVisible();
  expect(await rows(page)).toEqual(["Repository None (just chat)", "Read a repository None", "Model Codex"]);
  await closeContext(page);
  await expect(page.getByTestId("read-line")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 30_000 });
  await sendChat(page, QUESTION);
  await expect(log.locator('[data-event="text"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(log.locator('[data-event="text"]').last()).toContainText("Blue.");
  expect(sent).toHaveLength(2);
  expect(sent[1]).not.toHaveProperty("repository");
});
