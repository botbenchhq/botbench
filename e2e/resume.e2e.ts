import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, tallShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Resume, in the real client at a phone's size, against a real Botbench process and the owner's Claude Code on its
// cheapest model. The task is stopped for real: Botbench is killed with SIGKILL during the builder's turn, the next start
// re-drives it once, and Botbench is killed again during that turn, so the start after it leaves the task stopped for
// the owner. Nothing about the stop is staged.

const test = base.extend<{ dir: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-resume-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  botbench: async ({ dir }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home") });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

const PLAN = [{ title: "Run sleep 20 with the Bash tool, then create done.txt holding the word done", criteria: ["The command sleep 20 was run with the Bash tool first", "done.txt holds the word done"] }];

const getJson = async <B>(page: Page, botbench: Botbench, route: string): Promise<B> => (await (await page.request.get(`${botbench.base}${route}`)).json()) as B;
type Attempts = { events: { payload: { type: string; text?: string } }[] };

/** Wait until the builder's attempt `n` (from 1) of the task has begun its turn and, with `command`, has started its sleep. */
async function turnUnderWay(page: Page, botbench: Botbench, taskId: number, n: number, command: boolean): Promise<void> {
  await expect(async () => {
    const task = await getJson<{ attemptId: number | null }>(page, botbench, `/api/tasks/${taskId}`);
    expect(task.attemptId).not.toBeNull();
    const events = (await getJson<Attempts>(page, botbench, `/api/attempts/${task.attemptId}/events`)).events.map((e) => e.payload);
    expect(events.some((e) => e.type === "session_started")).toBe(true);
    if (command) expect(events.some((e) => e.type === "tool_call" && JSON.stringify(e).includes("sleep 20"))).toBe(true);
    expect(task.attemptId! - firstAttempt.get(taskId)! + 1).toBe(n);
  }).toPass({ timeout: 150_000, intervals: [250] });
}
const firstAttempt = new Map<number, number>();

test("LIVE: a task stopped by two restarts shows Stopped with what happened and a Resume action on the run and task screens; Resume re-drives it and it finishes", async ({ page, dir, botbench }) => {
  test.setTimeout(600_000);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const before = checkoutState(repo);
  await signIn(page, botbench);

  // A run whose one task runs a command allowed for the run, so the builder is mid-turn for a while with nobody asked.
  const started = await page.request.post(`${botbench.base}/api/runs`, { data: { repo, prompt: "Plan one task: run sleep 20, then create done.txt holding the word done. Read nothing; the README is all there is.", preapproved: ["sleep 20"] } });
  expect(started.status()).toBe(200);
  const runId = ((await started.json()) as { runId: number }).runId;
  let version = -1;
  await expect(async () => {
    for (const approval of (await getJson<{ approvals: { id: number }[] }>(page, botbench, "/api/approvals?status=pending")).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Read nothing; plan from the prompt." } });
    }
    const run = await getJson<{ status: string; planVersion: number }>(page, botbench, `/api/runs/${runId}`);
    expect(run.status).toBe("awaiting_plan_approval");
    version = run.planVersion;
  }).toPass({ timeout: 240_000, intervals: [1_000] });
  expect((await page.request.patch(`${botbench.base}/api/runs/${runId}/plan`, { data: { planVersion: version, tasks: PLAN } })).status()).toBe(200);
  await page.goto(`${botbench.base}/#/runs/${runId}`);
  await page.getByRole("button", { name: "Approve 1 task" }).click();
  const row = page.getByTestId("run-tasks").locator(":scope > li").first();
  await expect(row.locator(".ds-badge")).toHaveText("Working", { timeout: 60_000 });
  const taskId = Number(/#\/tasks\/(\d+)$/.exec((await row.getByRole("link").getAttribute("href")) ?? "")![1]);

  // Killed during the turn; the next start re-drives it once; killed during that turn too.
  await expect(async () => {
    const task = await getJson<{ attemptId: number | null }>(page, botbench, `/api/tasks/${taskId}`);
    expect(task.attemptId).not.toBeNull();
    firstAttempt.set(taskId, task.attemptId!);
  }).toPass({ timeout: 120_000 });
  await turnUnderWay(page, botbench, taskId, 1, true);
  await botbench.kill();
  await botbench.restart();
  await signIn(page, botbench);
  await turnUnderWay(page, botbench, taskId, 2, false);
  await botbench.kill();
  await botbench.restart();
  await signIn(page, botbench);

  // The run screen: the task is Stopped, says what happened in plain words, and offers Resume.
  await page.goto(`${botbench.base}/#/runs/${runId}`);
  await expect(row.locator(".ds-badge")).toHaveText("Stopped");
  await expect(row).toContainText("Botbench stopped twice while this task was being built");
  const resume = row.getByRole("button", { name: `Resume task ${taskId}` });
  await expect(resume).toBeVisible();
  // With nothing ready for review the run has ended; Resume takes it up again.
  await expect(page.getByTestId("run-status")).toHaveText(/^Nothing to review\./);
  await checkDesign(page, "run, with a task stopped by restarts");
  if (SHOTS) await tallShot(page, path.join(SHOTS, "u15-run-stopped.png"));

  // Its own screen says the same and offers the same action.
  await row.getByRole("link").click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Stopped\. Botbench stopped twice while this task was being built/);
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await checkDesign(page, "task stopped by restarts");
  if (SHOTS) await tallShot(page, path.join(SHOTS, "u15-task-stopped.png"));
  await page.goBack();

  // Resume re-drives it, from the session it had reported, and it finishes without a reload.
  await resume.click();
  await expect(row.locator(".ds-badge")).toHaveText("Working");
  await expect(row.getByRole("button", { name: /^Resume/ })).toHaveCount(0);
  // Told it was stopped, the agent may look around before it carries on: the owner allows what it asks.
  await expect(async () => {
    for (const approval of (await getJson<{ approvals: { id: number }[] }>(page, botbench, "/api/approvals?status=pending")).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "allow" } });
    }
    await expect(row.locator(".ds-badge")).toHaveText("Ready for review", { timeout: 1_000 });
  }).toPass({ timeout: 240_000, intervals: [1_000] });
  await checkDesign(page, "run, resumed task ready for review");
  // Re-driven by a third attempt, and it finished the work. What it was told, and the refusals of Resume, are proven
  // a layer down (test/engine/recover.test.ts, test/api/resume.test.ts).
  const done = await getJson<{ branch: string; attemptId: number }>(page, botbench, `/api/tasks/${taskId}`);
  expect(git(repo, "show", `${done.branch}:done.txt`).trim()).toBe("done");
  expect(done.attemptId - firstAttempt.get(taskId)!).toBe(2);
  expect(checkoutState(repo)).toEqual(before);
});
