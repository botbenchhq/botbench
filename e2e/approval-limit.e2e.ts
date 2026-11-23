import fs from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page } from "@playwright/test";
import { appendLog, expiredWords, repeatWords } from "../src/approvals/broker.ts";
import { createRun, storePlan } from "../src/engine/run.ts";
import { createTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, choose, chooseRepository, contextSheet, expect, openComposer, openFromSettings, openRow, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// A run's approval time limit in the real client: chosen in the composer's Add context sheet for a run, and shown on
// the run's screen when it has one. At 390×844 and 1280×800, light and dark, with the design check and nothing
// wider than the screen. No model turn: before Botbench starts, two runs are put in its real store through the engine
// itself, one with a limit and one without; what the limit does is tested in test/approvals/broker-expiry.test.ts.

const SIZES = { phone: { width: 390, height: 844 }, wide: { width: 1280, height: 800 } } as const;

interface Seeded {
  home: string;
  repo: string;
  limited: number;
  free: number;
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-limit-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const baseCommit = initRepo(repo, { "README.md": "# Sample\n" });
    const db = openStore(home);
    const limited = createRun(db, { repo, prompt: "Plan the billing export", baseCommit, approvalLimitMinutes: 15 });
    storePlan(db, limited.id, [{ title: "Write the exporter", criteria: ["It writes a CSV file"] }]);
    const free = createRun(db, { repo, prompt: "Plan the audit log", baseCommit });
    storePlan(db, free.id, [{ title: "Write the log", criteria: ["It appends one line per change"] }]);
    // One entry of each new rule on Permissions, as the broker writes them: an approval nobody answered in time, and a
    // request denied again because the owner had denied it before in the same task.
    const task = createTask(db, { repo, prompt: "Ship the exporter" });
    const at = new Date().toISOString();
    const attempt = Number(db.prepare("INSERT INTO attempts (driver, status, created_at, updated_at) VALUES ('claude-code', 'ended', ?, ?)").run(at, at).lastInsertRowid);
    const approval = Number(db.prepare("INSERT INTO approvals (task_id, attempt_id, role, tool, command, cwd, tool_call_id, status, created_at) VALUES (?, ?, 'implementer', 'Bash', 'git push origin main', '.', 'call-1', 'pending', ?)").run(task.id, attempt, at).lastInsertRowid);
    db.prepare("UPDATE approvals SET status = 'declined', resolved_at = ? WHERE id = ?").run(at, approval);
    const about = { taskId: task.id, attemptId: attempt, approvalId: approval, tool: "Bash", command: "git push origin main", cwd: "." };
    appendLog(db, { ...about, rule: "expired_unanswered", detail: expiredWords(15) });
    appendLog(db, { ...about, rule: "repeat_declined", detail: repeatWords(null) });
    db.close();
    await use({ home, repo, limited: limited.id, free: free.id });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
});

/** Nothing on the page, and no element given, is wider than its box: no text runs out of it. */
async function fits(page: Page, screen: string, inside: Locator[] = []): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${screen}: no sideways scrolling`).toBe(0);
  for (const el of inside) expect(await el.evaluate((node) => node.scrollWidth - node.clientWidth), `${screen}: nothing runs out of its box`).toBeLessThanOrEqual(0);
}

for (const [size, viewport] of Object.entries(SIZES)) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`at ${viewport.width}×${viewport.height}, ${scheme}`, () => {
      test.use({ viewport, colorScheme: scheme });

      test(`a run started with an approval time limit says so on its screen, and one without says nothing of it (${size}, ${scheme})`, async ({ page, botbench, seeded }) => {
        await signIn(page, botbench);
        await page.goto(`${botbench.base}/#/runs/${seeded.limited}`);
        const limit = page.getByTestId("run-approval-limit");
        await expect(limit).toHaveText("15 minutes. A request nobody answers within 15 minutes is denied.");
        await expect(page.locator(".ds-key-value__label", { hasText: /^Approval time limit$/ })).toBeVisible();
        await checkDesign(page, `run with an approval time limit, ${size}, ${scheme}`);
        await fits(page, `run with an approval time limit, ${size}, ${scheme}`, [limit]);

        await page.goto(`${botbench.base}/#/runs/${seeded.free}`);
        await expect(page.getByTestId("run-mode")).toBeVisible();
        await expect(limit).toHaveText("Off. Requests wait for your answer, however long that takes.");
        await checkDesign(page, `run with no approval time limit, ${size}, ${scheme}`);
        await fits(page, `run with no approval time limit, ${size}, ${scheme}`, [limit]);
      });

      test(`Permissions names an approval nobody answered in time, and a request denied again, in plain words (${size}, ${scheme})`, async ({ page, botbench }) => {
        // Opened from Settings at a phone's width, then widened, as e2e/trust.e2e.ts does: from 1024px Settings is two
        // panes and its list of links is not shown.
        await page.setViewportSize(SIZES.phone);
        await signIn(page, botbench);
        await openFromSettings(page, "Permissions");
        await page.setViewportSize(viewport);
        await expect(page.getByRole("heading", { name: "Permissions", level: 1 })).toBeVisible();
        const expired = page.getByText("Denied by Botbench: nobody answered in time", { exact: true });
        const repeated = page.getByText("Denied without asking: you denied it before in this task", { exact: true });
        await expect(expired).toBeVisible();
        await expect(repeated).toBeVisible();
        await checkDesign(page, `permissions with the new rules, ${size}, ${scheme}`);
        await fits(page, `permissions with the new rules, ${size}, ${scheme}`, [expired, repeated]);
      });

      test(`the composer offers an approval time limit for a run, off unless chosen, in plain words (${size}, ${scheme})`, async ({ page, botbench, seeded }) => {
        await signIn(page, botbench);
        await openComposer(page);
        await chooseRepository(page, seeded.repo);
        // A task on its own has no such row.
        await choose(page, "What to do", "One task");
        await expect(contextSheet(page).locator(".ds-context-list__label", { hasText: /^Approval time limit$/ })).toHaveCount(0);
        await choose(page, "What to do", "Plan a run");
        const row = contextSheet(page).locator(".ds-context-list__button", { has: page.locator(".ds-context-list__label", { hasText: /^Approval time limit$/ }) });
        await expect(row.locator(".ds-context-list__value")).toHaveText("Off");
        await fits(page, `composer rows, ${size}, ${scheme}`, [row]);

        const sheet = await openRow(page, "Approval time limit");
        await expect(sheet.getByRole("heading", { name: "Approval time limit" })).toBeVisible();
        await expect(sheet.getByText(/^If nobody answers a request of this run in this time, Botbench denies it/)).toBeVisible();
        const options = sheet.getByRole("radio");
        await expect(options).toHaveCount(5);
        await expect(sheet.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
        for (const name of ["15 minutes", "1 hour", "4 hours", "1 day"]) await expect(sheet.getByRole("radio", { name, exact: true })).not.toBeChecked();
        await expect(sheet.getByText("Requests wait for your answer, however long that takes.")).toBeVisible();
        await expect(sheet.getByText("A request nobody answers within 1 hour is denied.")).toBeVisible();
        await checkDesign(page, `composer, approval time limit, ${size}, ${scheme}`);
        await fits(page, `composer, approval time limit, ${size}, ${scheme}`, [sheet.locator(".ds-sheet__body")]);

        // Chosen, it goes back to the rows, which say it.
        await sheet.getByRole("radio", { name: "1 hour", exact: true }).click();
        await expect(sheet.getByRole("heading", { name: "Add context" })).toBeVisible();
        await expect(row.locator(".ds-context-list__value")).toHaveText("1 hour");
        await checkDesign(page, `composer rows with a limit, ${size}, ${scheme}`);
      });
    });
  }
}
