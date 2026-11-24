import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, choose, chooseRepository, closeContext, expect, messageBox, openComposer, openRow, openRunId, SHOTS, signIn, tallShot, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The milestone "Two vendors on one job", yes or no, in the real client at a phone's size: a real Botbench process, a real
// temporary repository, the owner's Claude Code planning and building on its cheapest model, and the owner's Codex
// reviewing the diff read-only on its cheapest model. The review must be on the task before the owner decides. When
// Codex has concerns the refine loop adds rounds (e2e/refine.e2e.ts); this test reads the first review.

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-review-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo);
    await use(repo);
  },
  botbench: async ({ dir }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" }, codex: {} } } });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

/** Deny every request an agent makes while `until` has not passed: the planner reads, and the task needs no command. */
async function denyWhile(page: Page, botbench: Botbench, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    for (const approval of ((await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] }).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Read files, or write the file with your Write tool; run no command." } });
    }
    await until();
  }).toPass({ timeout: 300_000, intervals: [1_000] });
}

test("MILESTONE two vendors on one job: Claude Code builds a task, Codex reviews its diff read-only, the review is on the task before the decision, and the owner accepts", async ({ page, botbench, repo }) => {
  test.setTimeout(900_000);
  const foreign = watchRequests(page, botbench);
  await signIn(page, botbench);

  // New run, with Review set to Codex on its cheapest model.
  await openComposer(page);
  await chooseRepository(page, repo);
  await choose(page, "What to do", "Plan a run");
  const sheet = await openRow(page, "Review");
  await expect(sheet.getByRole("radio", { name: "Off" })).toBeChecked();
  // Each reviewer's own default comes first; a model of its list is typed under Other model….
  await sheet.locator('input[name="review"][value="codex ?other"]').check();
  await sheet.getByLabel("Codex model name").fill("gpt-6-luna");
  await checkDesign(page, "new run, review by Codex");
  await shot(page, "review-new-run.png");
  await closeContext(page);
  await messageBox(page).fill("Plan exactly one task: create hello.txt holding the single word hi. Do not run any command; the README is all there is to read.");
  await page.getByRole("button", { name: "Send" }).click();
  const runId = await openRunId(page);
  expect(((await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { reviewer: unknown }).reviewer).toEqual({ agent: "codex", model: "gpt-6-luna" });

  // Claude Code plans; the owner approves one task.
  await denyWhile(page, botbench, async () => {
    const run = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { status: string };
    expect(run.status).toBe("awaiting_plan_approval");
  });
  const { planVersion } = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { planVersion: number };
  const plan = [{ title: "Create hello.txt holding the word hi", criteria: ["hello.txt holds the single word hi"] }];
  expect((await page.request.patch(`${botbench.base}/api/runs/${runId}/plan`, { data: { planVersion, tasks: plan } })).status()).toBe(200);
  await page.getByRole("button", { name: "Approve 1 task" }).click();

  // Claude Code builds it, then Codex reviews it.
  await denyWhile(page, botbench, () => expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./, { timeout: 1_000 }));
  await page.getByTestId("run-tasks").getByRole("link").first().click();
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  const taskId = Number(/Task (\d+)/.exec((await page.getByTestId("task-name").textContent()) ?? "")![1]);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);

  // Codex's review is on the task, in the verification card under the checks, before any decision: who reviewed and
  // what came of it, and its own words one tap away.
  const section = page.getByTestId("verification");
  await expect(section.getByTestId("review-by")).toHaveText(/^Codex, gpt-6-luna/);
  await expect(section.getByTestId("review-outcome")).toHaveText(/\S/);
  await expect(section).toContainText("A model's opinion, not a check.");
  await expect(section.getByTestId("not-reviewed")).toHaveCount(0);
  await expect(page.getByTestId("review-text").first()).toBeHidden();
  await checkDesign(page, "task, ready for review, with Codex's review");
  await shot(page, "review-task.png");
  await section.getByTestId("review-detail").click();
  await expect(section.getByRole("heading", { name: "Review 1", level: 3 })).toBeVisible();
  await expect(page.getByTestId("review-problem")).toHaveCount(0);
  await expect(page.getByTestId("review-verdict").first()).toHaveText(/^(Verdict: looks right|Verdict: concerns|No verdict in the asked form), in /);
  // Under the verdict: what the reviewer says it checked, or the plain note that it did not say.
  await expect(page.getByTestId("review-checked").or(page.getByTestId("review-no-account")).first()).toBeVisible();
  await expect(page.getByTestId("review-text").first()).toBeVisible();
  await expect(page.getByTestId("review-text").first()).toContainText(/Verdict/i);
  await checkDesign(page, "task, Codex's review opened");
  const task = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { decision: unknown; review: { outcome: string; agent: string; endedAt: string; attemptId: number; checked: string[] } };
  expect(task.decision).toBeNull();
  expect([task.review.agent, task.review.outcome]).toEqual(["codex", "reviewed"]);
  // With no tap, beside the reviewer's name: what it says it checked, when it said.
  if (task.review.checked.length > 0) await expect(section).toContainText("Codex says it checked:");
  const attempt = (await (await page.request.get(`${botbench.base}/api/attempts/${task.review.attemptId}/events`)).json()) as { events: { type: string }[] };
  expect(attempt.events.map((event) => event.type)).toContain("usage");

  // The owner decides.
  // This repository has no checks set up: the review is a model's opinion, not a check, so the accept is one without verification.
  // At a phone's width the decision's buttons are at the foot of the window.
  await page.getByTestId("foot-actions").getByRole("button", { name: "Accept without verification" }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Accepted without verification: no checks ran on it\. /);
  const decided = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { decision: { decidedAt: string } };
  expect(task.review.endedAt < decided.decision.decidedAt, "the review was in before the decision").toBe(true);
  await checkDesign(page, "task, accepted, with Codex's review");
  expect(foreign).toEqual([]);
});
