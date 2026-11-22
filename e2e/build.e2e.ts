import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { checkoutState, initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, tallShot, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Building a run in the real client, at a phone's size, against a real Botbench process whose settings give the
// repository setup commands, a real temporary repository and, for the test marked LIVE, the owner's Claude Code as
// planner and builder on its cheapest model.

/** A temporary directory, and a real Botbench started in it whose settings give the repository setup commands. Stopped before the directory goes. */
const test = base.extend<{ dir: string; botbenchFor: (repo: string, setup: string[]) => Promise<Botbench> }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-build-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  botbenchFor: async ({ dir }, use) => {
    const started: Botbench[] = [];
    await use(async (repo, setup) => {
      const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { setup } } } });
      started.push(botbench);
      return botbench;
    });
    for (const botbench of started) {
      const { leftover } = await botbench.stop();
      expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
    }
  },
});

/** Decline, until stopped, every request a builder makes: the tasks here need no command. */
function declineBuilders(page: Page, botbench: Botbench): () => Promise<void> {
  let going = true;
  const loop = (async () => {
    while (going) {
      const pending = (await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number; taskId: number | null }[] };
      for (const approval of pending.approvals) {
        if (approval.taskId !== null) await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Write the file with your Write tool; run no command." } });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  return async () => {
    going = false;
    await loop.catch(() => {});
  };
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

/** Start a run on the run screen, decline what its planner asks, and set its plan to `tasks` as the owner can over the API. */
async function plannedRun(page: Page, botbench: Botbench, repo: string, tasks: { title: string; criteria: string[] }[]): Promise<number> {
  await page.goto(`${botbench.base}/#/runs/new`);
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await page.getByLabel("Prompt").fill("Plan exactly two tasks: create one.txt, and create two.txt. Do not run any command; the README is all there is to read.");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: /^Run \d+$/, level: 1 })).toBeVisible();
  const runId = Number(/Run (\d+)/.exec((await page.getByRole("heading", { level: 1 }).textContent()) ?? "")![1]);
  let version = -1;
  await expect(async () => {
    for (const approval of ((await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] }).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Read files instead." } });
    }
    const run = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { status: string; planVersion: number };
    expect(run.status).toBe("awaiting_plan_approval");
    version = run.planVersion;
  }).toPass({ timeout: 240_000, intervals: [1_000] });
  expect((await page.request.patch(`${botbench.base}/api/runs/${runId}/plan`, { data: { planVersion: version, tasks } })).status()).toBe(200);
  await expect(page.getByRole("button", { name: `Approve ${tasks.length} tasks` })).toBeVisible();
  return runId;
}

test("LIVE: approve a plan and watch both tasks go Queued, Working, Ready for review without a reload, with each task's setup command shown as evidence", async ({ page, dir, botbenchFor }) => {
  test.setTimeout(480_000);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const before = checkoutState(repo);
  const botbench = await botbenchFor(repo, ["echo preparing the copy"]);
  {
    const foreign = watchRequests(page, botbench);
    await signIn(page, botbench);
    await plannedRun(page, botbench, repo, [
      { title: "Create one.txt holding the word one", criteria: ["one.txt holds the word one"] },
      { title: "Create two.txt holding the word two", criteria: ["two.txt holds the word two"] },
    ]);
    await expect(page.getByText("Approving starts building the tasks, one at a time, in this order.")).toBeVisible();
    await expect(page.getByText(/next version/)).toHaveCount(0);
    await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));

    // Every state each row's badge shows, in order, as the page draws it.
    await page.evaluate(() => {
      const seen: string[][] = [[], []];
      (window as unknown as { seen: string[][] }).seen = seen;
      const look = (): void => {
        document.querySelectorAll('[data-testid="run-tasks"] > li').forEach((row, i) => {
          const word = row.querySelector(".ds-badge")?.textContent ?? "";
          if (seen[i] && word !== "" && seen[i]!.at(-1) !== word) seen[i]!.push(word);
        });
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const stopDeclining = declineBuilders(page, botbench);
    await page.getByRole("button", { name: "Approve 2 tasks" }).click();

    const rows = page.getByTestId("run-tasks").locator(":scope > li");
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId("run-status")).toHaveText(/^(Working|Needs input)\. /);
    // The first is built while the second waits its turn.
    await expect(rows.nth(0).locator(".ds-badge")).toHaveText(/^(Working|Needs input)$/, { timeout: 60_000 });
    await expect(rows.nth(1).locator(".ds-badge")).toHaveText("Queued");
    await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();
    await checkDesign(page, "run, building");
    await shot(page, "u12-run-building.png");
    // The task being built is one tap away, with its transcript live.
    await expect(rows.nth(0).getByRole("link")).toHaveAttribute("href", /#\/tasks\/\d+$/);

    await expect(rows.nth(1).locator(".ds-badge")).toHaveText("Ready for review", { timeout: 240_000 });
    await expect(rows.nth(0).locator(".ds-badge")).toHaveText("Ready for review");
    await expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./);
    await stopDeclining();
    const seen = await page.evaluate(() => (window as unknown as { seen: string[][] }).seen);
    // A builder's request, declined above, shows as Needs input on its row while it waits.
    const states = (row: string[]): string[] => row.filter((word) => word !== "Needs input").filter((word, i, all) => word !== all[i - 1]);
    expect(states(seen[1]!)).toEqual(["Queued", "Working", "Ready for review"]);
    expect(states(seen[0]!).filter((word) => word !== "Queued")).toEqual(["Working", "Ready for review"]);
    expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "no reload").toBe(true);

    // Each task's setup command is evidence on its row: the command, its result in words, how long it took, and its output one tap away.
    for (const row of await rows.all()) {
      const check = row.locator(".ds-check-list__item");
      await expect(check).toHaveCount(1);
      await expect(check.locator(".ds-check-list__name")).toHaveText("echo preparing the copy");
      await expect(check.locator(".ds-check-list__result")).toHaveText("Passed");
      await expect(check.locator(".ds-check-list__duration time")).toHaveAttribute("datetime", /^PT/);
      await expect(check.locator(".ds-check-list__log")).toBeHidden();
      await check.locator(".ds-check-list__toggle").click();
      await expect(check.locator(".ds-check-list__log")).toHaveText(/preparing the copy/);
    }
    await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
    await checkDesign(page, "run, built, setup output open");

    // A built task's own screen shows the same evidence.
    await rows.nth(0).getByRole("link").click();
    await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);
    await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
    await expect(page.locator(".ds-check-list__item .ds-check-list__result")).toHaveText("Passed");
    await checkDesign(page, "task of a run, built");
    expect(checkoutState(repo)).toEqual(before);
    expect(foreign).toEqual([]);
  }
});

test("LIVE (planner only): cancel a run while it builds: the dialog says what is kept, the setup at work is stopped, and every task says it was cancelled", async ({ page, dir, botbenchFor }) => {
  const repo = path.join(dir, "repo");
  initRepo(repo);
  // The setup command takes long enough that the run is still building when the owner cancels it. No agent starts.
  const botbench = await botbenchFor(repo, ["sleep 60"]);
  {
    await signIn(page, botbench);
    const runId = await plannedRun(page, botbench, repo, [
      { title: "Create one.txt holding the word one", criteria: ["one.txt holds the word one"] },
      { title: "Create two.txt holding the word two", criteria: ["two.txt holds the word two"] },
    ]);
    await page.getByRole("button", { name: "Approve 2 tasks" }).click();
    const rows = page.getByTestId("run-tasks").locator(":scope > li");
    await expect(rows.nth(0).locator(".ds-badge")).toHaveText("Working");
    await expect(rows.nth(0)).toContainText("Preparing a separate copy of the project");
    await checkDesign(page, "run, setting up");

    await page.getByRole("button", { name: "Cancel run" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Cancel this run?");
    await expect(dialog).toContainText("Tasks that have finished keep their branches");
    await checkDesign(page, "run, cancel while building");
    await dialog.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText(/^Cancelled\./);
    for (const row of await rows.all()) await expect(row.locator(".ds-badge")).toHaveText("Cancelled", { timeout: 15_000 });
    await expect(rows.nth(0).locator(".ds-check-list__result")).toHaveText(/^Stopped/);
    await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
    await checkDesign(page, "run, cancelled while building");
    const attempts = (await (await page.request.get(`${botbench.base}/api/runs/${runId}`)).json()) as { tasks: { attemptId: number | null }[] };
    expect(attempts.tasks.map((task) => task.attemptId)).toEqual([null, null]);
    await rows.nth(1).getByRole("link").click();
    await expect(page.getByTestId("task-status")).toHaveText(/^Cancelled\. The run was cancelled before this task started\./);
    await checkDesign(page, "task cancelled before it started");
  }
});
