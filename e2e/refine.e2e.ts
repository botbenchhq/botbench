import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, choose, chooseRepository, closeContext, expect, messageBox, openComposer, openRow, openRunId, SHOTS, signIn, tallShot, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The refine loop, yes or no, in the real client at a phone's size: a real Botbench process, a real temporary
// repository with one check, the owner's Claude Code building on its cheapest model, and the owner's Codex reviewing on
// its cheapest model. The repository holds a defect the task's criteria rule out (add subtracts) and the task asks only
// for a docstring, so the first build plausibly leaves it and Codex has something to raise; Claude Code is then given Codex's review and fixes it, the check runs
// again, and Codex looks again. A live model may still answer otherwise, so what is asserted is that the loop's states
// and records appear for whatever verdicts came back, and, when Codex raised concerns, that a round of fixes followed.

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-refine-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    // The defect is in the repository already: the task only asks for a docstring, and its criteria rule the defect out.
    initRepo(repo, { "README.md": "# Calculator\n", "calc.py": "def add(a, b):\n    return a - b\n" });
    await use(fs.realpathSync(repo));
  },
  botbench: async ({ dir, repo }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" }, codex: {} }, repositories: { [repo]: { checks: ["grep -q 'a + b' calc.py"] } } } });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

/** Deny every request an agent makes while `until` has not passed: the task needs no command. */
async function denyWhile(page: Page, botbench: Botbench, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    for (const approval of ((await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] }).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Read files, or write the file with your Write or Edit tool; run no command." } });
    }
    await until();
  }).toPass({ timeout: 600_000, intervals: [1_000] });
}

interface TaskBody {
  status: string;
  reviewOutcome: string;
  reviewRounds: number;
  refineRounds: number;
  reviewLine: string | null;
  reviews: { round: number; verdict: string | null; outcome: string }[];
  refinements: { round: number; outcome: string; changed: boolean }[];
  evidence: { kind: string; round: number; outcome: string }[];
}

test("LIVE the refine loop: Codex raises a defect in Claude Code's first build, Claude Code is given the review and fixes it, the check runs again, Codex looks again, and the task shows the rounds and the outcome", async ({ page, botbench, repo }) => {
  test.setTimeout(1_200_000);
  const foreign = watchRequests(page, botbench);
  await signIn(page, botbench);

  // New run, with Review by Codex; the cap is said beside it.
  await openComposer(page);
  await chooseRepository(page, repo);
  await choose(page, "What to do", "Plan a run");
  const sheet = await openRow(page, "Review");
  // Each reviewer's own default comes first; a model of its list is typed under Other model….
  await sheet.locator('input[name="review"][value="codex ?other"]').check();
  await sheet.getByLabel("Codex model name").fill("gpt-6-luna");
  await expect(sheet.getByTestId("review-rounds-cap")).toHaveText("Up to 2 rounds of fixes.");
  await checkDesign(page, "new run, review by Codex, with the cap on rounds of fixes");
  await closeContext(page);
  await messageBox(page).fill("Plan exactly one task: add a docstring to add in calc.py. Do not run any command; read calc.py only.");
  await page.getByRole("button", { name: "Send" }).click();
  const runId = await openRunId(page);
  expect(((await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { maxRefineRounds: number }).maxRefineRounds).toBe(2);

  // The owner sets the plan: a first draft that subtracts, against a criterion that asks for the sum.
  await denyWhile(page, botbench, async () => {
    const run = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { status: string };
    expect(run.status).toBe("awaiting_plan_approval");
  });
  const { planVersion } = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { planVersion: number };
  // The title has the first pass leave the body as it is and lets the round after the review fix it; a criterion rules the body out.
  const plan = [{ title: "Add a one-line docstring to add in calc.py; in this first pass leave its body as it is, then fix what the review finds", criteria: ["add in calc.py has a one-line docstring", "add(a, b) returns the sum of a and b"] }];
  expect((await page.request.patch(`${botbench.base}/api/runs/${runId}/plan`, { data: { planVersion, tasks: plan } })).status()).toBe(200);
  await page.getByRole("button", { name: "Approve 1 task" }).click();

  // Built, checked, reviewed, perhaps fixed and reviewed again, until it is Ready for review.
  await denyWhile(page, botbench, () => expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./, { timeout: 1_000 }));
  await page.getByTestId("run-tasks").getByRole("link").first().click();
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  const taskId = Number(/Task (\d+)/.exec((await page.getByTestId("task-name").textContent()) ?? "")![1]);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);
  const task = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as TaskBody;
  test.info().annotations.push({ type: "loop", description: JSON.stringify({ outcome: task.reviewOutcome, reviews: task.reviews.map((r) => r.verdict ?? r.outcome), fixes: task.refinements.map((r) => `${r.outcome}${r.changed ? ", changed" : ", unchanged"}`), line: task.reviewLine, checks: task.evidence.filter((row) => row.kind === "check").map((row) => `${row.round}:${row.outcome}`) }) });

  // The records: one review per round, a round of fixes after each review with concerns while rounds were left.
  expect(task.reviewRounds).toBe(task.reviews.length);
  expect(task.refineRounds).toBe(task.refinements.length);
  expect(["satisfied", "unaccounted", "unresolved", "failed"]).toContain(task.reviewOutcome);
  expect(task.reviews.length).toBeGreaterThanOrEqual(1);
  expect(task.reviews.length).toBeLessThanOrEqual(3);
  if (task.reviews[0]!.outcome === "reviewed" && task.reviews[0]!.verdict !== "looks_right") {
    expect(task.refinements.length, "Codex had concerns, so Claude Code was given its review").toBeGreaterThanOrEqual(1);
    if (task.refinements[0]!.changed) expect(Math.max(...task.evidence.filter((row) => row.kind === "check").map((row) => row.round)), "the check ran again on the fixed work").toBeGreaterThanOrEqual(2);
  }

  // The screen: the outcome line, each review and each round of fixes, with the reviewer's and the builder's words one tap away.
  const section = page.getByTestId("review");
  await expect(section.getByRole("heading", { name: "Codex's review", level: 2 })).toBeVisible();
  await expect(page.getByTestId("review-outcome")).toHaveText(task.reviewLine!);
  await expect(page.getByTestId("review-round")).toHaveCount(task.reviews.length);
  await expect(page.getByTestId("fixes-round")).toHaveCount(task.refinements.length);
  await expect(section.getByRole("heading", { name: "Review 1", level: 3 })).toBeVisible();
  await checkDesign(page, "task, ready for review, with the rounds of review and fixes");
  await shot(page, "refine-task.png");
  if (task.refinements.length > 0 && task.refinements[0]!.outcome === "finished") {
    await page.getByTestId("fixes-detail").first().locator("summary").click();
    await expect(page.getByTestId("fixes-text").first()).toBeVisible();
    await checkDesign(page, "task, a round of fixes opened");
  }
  expect(foreign).toEqual([]);
});
