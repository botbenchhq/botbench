import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { ISSUE_NOT_FULL, issueWords } from "../web/src/app/composer.ts";
import { authorWords, hostsHint } from "../web/src/app/run-words.ts";
import { ISSUE_ADDRESS, ISSUE_NUMBER, loadIssueCapture } from "../test/support/replay-issue.ts";
import { parseIssueView } from "../src/github.ts";
import { git, initRepo } from "../test/support/repo.ts";
import { checkDesign, choose, chooseRepository, closeContext, contextSheet, expect, openRow, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Attaching a GitHub issue to a run in the real client, at a phone's size, with no model turn. A real Botbench process
// started through e2e/serve-replayed-gh.ts, whose gh answers are replayed from output captured once from the real gh
// for public issue cli/cli#15019 (test/support/replay-issue.ts, the owner's approved exception); a real temporary
// repository whose origin is that repository's address. Nothing is sent: the run is never started here.

const issue = parseIssueView(loadIssueCapture().outputs.issue.result.stdout, { host: "github.com", owner: "cli", name: "cli" }, ISSUE_NUMBER);

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-intake-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo);
    git(repo, "remote", "add", "origin", ISSUE_ADDRESS);
    await use(repo);
  },
  botbench: async ({ dir, repo }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), entry: path.resolve(import.meta.dirname, "serve-replayed-gh.ts"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { allowedHosts: ["registry.npmjs.org"], checks: ["true"] } } } });
    await use(botbench);
    await botbench.stop();
  },
});

test("an issue is looked up and shown as plain text, attached as the row's value, and a run from it cannot be fully autonomous, saying why", async ({ page, botbench, repo }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/runs/new`);
  await chooseRepository(page, repo);
  await choose(page, "Mode", "Fully autonomous");

  const sheet = await openRow(page, "From an issue");
  await expect(sheet.getByRole("heading", { name: "From an issue" })).toBeVisible();
  await sheet.getByLabel("Issue number or address").fill(`https://github.com/cli/cli/issues/${ISSUE_NUMBER}`);
  await sheet.getByRole("button", { name: "Look it up" }).click();
  const preview = sheet.getByTestId("issue-preview");
  await expect(preview.getByRole("heading", { name: issue.title })).toBeVisible();
  await expect(preview).toContainText(`#${ISSUE_NUMBER} of github.com/cli/cli`);
  await expect(preview).toContainText(issue.author!);
  await expect(preview).toContainText("Closed");
  // The text is folded, and shown as written: the issue's markdown is not drawn as headings, links or images.
  await expect(sheet.getByTestId("issue-body")).toBeHidden();
  await preview.getByText("What the issue says").click();
  await expect(sheet.getByTestId("issue-body")).toBeVisible();
  await expect(sheet.getByTestId("issue-body")).toContainText("### Describe the bug");
  expect(await preview.locator("img, a, h1, h2, h4").count()).toBe(0);
  // Who wrote it, by name; the replayed gh answer is gh issue view's, which does not say how the author relates to the
  // repository, so the sheet says GitHub did not say. The rules are said to be the same whoever wrote it.
  const written = authorWords(issue.author, null);
  await expect(sheet.getByTestId("issue-outside")).toHaveText(`${written.author}${written.text}`);
  await expect(sheet.getByTestId("issue-outside").locator("[data-ds-content]")).toHaveText(issue.author!);
  const hosts = sheet.getByLabel("Allow this repository's network hosts for this run");
  await expect(hosts).not.toBeChecked();
  await expect(sheet.locator("#issue-hosts-about")).toHaveText(hostsHint(["registry.npmjs.org"], false));
  await hosts.check();
  await expect(sheet.locator("#issue-hosts-about")).toHaveText(hostsHint(["registry.npmjs.org"], true));
  await expect(sheet.locator("#issue-hosts-about")).not.toContainText("no network");
  const allowed = authorWords(issue.author, null, ["registry.npmjs.org"]);
  await expect(sheet.getByTestId("issue-outside")).toHaveText(`${allowed.author}${allowed.text}`);
  await checkDesign(page, "the issue as read, with its network hosts allowed");
  await hosts.uncheck();
  await expect(sheet.locator("#issue-hosts-about")).toHaveText(hostsHint(["registry.npmjs.org"], false));
  await checkDesign(page, "the issue as read, before it is attached");

  await sheet.getByRole("button", { name: "Attach this issue" }).click();
  await expect(sheet.getByTestId("issue-attached")).toHaveText("Attached to this run.");
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
  const row = sheet.locator(".ds-context-list__button", { hasText: "From an issue" });
  await expect(row.locator(".ds-context-list__value")).toHaveText(issueWords({ number: ISSUE_NUMBER, title: issue.title }));

  // Fully autonomous was chosen before: Send is disabled now, saying why, and the Mode view cannot choose it.
  await closeContext(page);
  await expect(page.getByTestId("composer-reason")).toHaveText(ISSUE_NOT_FULL);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  const mode = await openRow(page, "Mode");
  await expect(mode.getByRole("radio", { name: "Fully autonomous" })).toBeDisabled();
  await expect(mode.getByText("Not for a run from an issue")).toBeVisible();
  await expect(mode.getByText(ISSUE_NOT_FULL)).toBeVisible();
  await checkDesign(page, "mode, with Fully autonomous closed for a run from an issue");
  await mode.getByRole("radio", { name: "Semi-autonomous", exact: true }).click();
  await closeContext(page);
  await expect(page.getByTestId("composer-reason")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(contextSheet(page)).toBeHidden();
});
