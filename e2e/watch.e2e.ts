import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { issueWords } from "../web/src/app/composer.ts";
import { watchAbout } from "../web/src/app/watch-words.ts";
import { capturedIssue, loadWatchCapture, WATCH_ADDRESS } from "../test/support/replay-watch.ts";
import { git, initRepo } from "../test/support/repo.ts";
import { checkDesign, closeContext, contextSheet, expect, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// An issue proposed on Work by the issue watch (issue #73), in the real client at a phone's size, with no model turn. A
// real Botbench process started through e2e/serve-replayed-watch.ts, whose gh answers are replayed from output captured
// once from the real gh for jon-lange/botbench (test/support/replay-watch.ts, the owner's approved exception); a real
// temporary repository whose origin is that repository's address, watched for the captured label. Nothing is sent: the
// run is never started here.

const issue = capturedIssue();
const label = loadWatchCapture().label;

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-watch-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo);
    git(repo, "remote", "add", "origin", WATCH_ADDRESS);
    await use(repo);
  },
  botbench: async ({ dir, repo }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), entry: path.resolve(import.meta.dirname, "serve-replayed-watch.ts"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { watch: { label } } } } });
    await use(botbench);
    await botbench.stop();
  },
});

test("a proposed issue shows on Work with its title and author as plain text; Start opens the composer with it attached; Dismiss removes it for good", async ({ page, botbench, repo }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/work`);
  const section = page.getByTestId("proposals");
  const row = section.getByTestId("proposal").filter({ hasText: `#${issue.number} by ` });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".ds-list__primary")).toHaveText(issue.title);
  await expect(row.locator(".ds-list__secondary [data-ds-content]")).toHaveText(issue.author!);
  // Who wrote it, as GitHub says they relate to the repository: the label alone is not trust.
  await expect(row.locator(".ds-list__secondary")).toContainText("GitHub says: owner of the repository");
  // Outside text is shown as written: nothing in it is drawn as a link, a heading or an image.
  expect(await row.locator("img, a, h1, h3, h4").count()).toBe(0);
  await expect(row.getByRole("button", { name: `Start a run from issue #${issue.number}` })).toBeVisible();
  await expect(row.getByRole("button", { name: `Dismiss issue #${issue.number}` })).toBeVisible();
  await checkDesign(page, "Work, with an issue to start");

  // Start: the composer, as a run in the issue's repository, with the From an issue row open on the issue, attached.
  await row.getByRole("button", { name: `Start a run from issue #${issue.number}` }).click();
  const sheet = contextSheet(page);
  await expect(sheet.getByRole("heading", { name: "From an issue" })).toBeVisible();
  await expect(sheet.getByTestId("issue-attached")).toHaveText("Attached to this run.");
  await expect(sheet.getByTestId("issue-preview").getByRole("heading", { name: issue.title })).toBeVisible();
  await checkDesign(page, "the composer, opened from Start with the issue attached");
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
  await expect(sheet.locator("button[data-row]", { hasText: "From an issue" }).locator('[data-testid="context-row-value"]')).toHaveText(issueWords({ number: issue.number, title: issue.title }));
  await expect(sheet.locator("button[data-row]", { hasText: /^Repository/ }).locator('[data-testid="context-row-value"]')).toHaveText(path.basename(repo));
  await closeContext(page);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  // Nothing was started: the issue is still proposed, and no run is listed.
  await page.goto(`${botbench.base}/#/work`);
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("board-empty")).toBeVisible();

  // Dismiss: it leaves Work, and stays gone after a reload and after Botbench starts again.
  await row.getByRole("button", { name: `Dismiss issue #${issue.number}` }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  await botbench.restart();
  // The browser's session is kept across the restart, as in e2e/restart.e2e.ts.
  await page.goto(`${botbench.base}/#/work`);
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  await expect(page.getByTestId("board-empty")).toBeVisible();
  await expect(row).toHaveCount(0);

  // Settings shows the watch, with the label's warning in plain words.
  // Right after the restart the first look may still be under way, before it has found the repository the remote names:
  // the page is read again until it has.
  await page.goto(`${botbench.base}/#/settings`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("watch")).toContainText(watchAbout({ label, intervalMinutes: 10, repository: "github.com/jon-lange/botbench" }), { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await checkDesign(page, "Settings, with a watched repository");
});
