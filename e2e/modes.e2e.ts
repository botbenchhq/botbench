import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, choose, chooseRepository, closeContext, expect, messageBox, openComposer, openRow, SHOTS, signIn, tallShot, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// LIVE. The modes, yes or no, in the real client at a phone's size: a real Botbench process, a real temporary
// repository with one check, and the owner's Claude Code planning and building on its cheapest model.
//   Semi-autonomous: a task that must run a harmless command reaches Ready for review, and no approval card is ever shown.
//   Fully autonomous: building starts with no plan approval, the check passes, and the task ends accepted without the owner.
// Everything the engine decides on the way (each refusal, each reason, the store's rules) is tested without a model in
// test/engine/modes.test.ts, test/approvals/modes.test.ts and test/api/modes.test.ts.

const test = base.extend<{ dir: string; repo: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-modes-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo);
    await use(repo);
  },
  botbench: async ({ dir, repo }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { checks: ["test -f hello.txt"] } } } });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

/** Fails the test the moment anything is put to the owner, while `until` has not passed. */
async function neverAsked(page: Page, botbench: Botbench, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    const pending = (await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { command: string }[] };
    if (pending.approvals.length > 0) throw new Error(`The owner was asked: ${pending.approvals.map((a) => a.command).join(", ")}`);
    await expect(page.getByTestId("approval-card")).toHaveCount(0, { timeout: 1 });
    await until();
  }).toPass({ timeout: 600_000, intervals: [1_000] });
  expect(((await (await page.request.get(`${botbench.base}/api/approvals`)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
}

const runIdOf = async (page: Page): Promise<number> => {
  await expect(page.getByRole("heading", { name: /^Run \d+$/, level: 1 })).toBeVisible();
  return Number(/Run (\d+)/.exec((await page.getByRole("heading", { level: 1 }).textContent()) ?? "")![1]);
};

test("LIVE modes: semi-autonomous runs a task's command without an approval card; fully autonomous builds without plan approval and accepts the task whose check passed", async ({ page, botbench, repo }) => {
  test.setTimeout(1_500_000);
  const foreign = watchRequests(page, botbench);
  await signIn(page, botbench);

  // Settings: the default mode is Manual until the owner picks another, which a new run then starts with.
  await page.goto(`${botbench.base}/#/settings`);
  const defaults = page.getByTestId("default-mode-picker");
  await expect(defaults.getByRole("radio", { name: "Manual" })).toBeChecked();
  await defaults.getByRole("radio", { name: "Semi-autonomous" }).check();
  await expect.poll(async () => ((await (await page.request.get(`${botbench.base}/api/settings`)).json()) as { defaultMode: string }).defaultMode).toBe("semi");
  await checkDesign(page, "settings, default mode");

  // Semi-autonomous: the owner approves a plan whose one task must run a command.
  await openComposer(page);
  await chooseRepository(page, repo);
  await choose(page, "What to do", "Plan a run");
  const sheet = await openRow(page, "Mode");
  const modes = page.getByTestId("run-mode-picker");
  await expect(modes.getByRole("radio", { name: "Semi-autonomous" })).toBeChecked();
  await expect(modes.getByText("Accepts work without you")).toBeVisible();
  await checkDesign(page, "new run, mode");
  await shot(page, "modes-new-run.png");
  await sheet.getByRole("button", { name: "Close Add context" }).click();
  await messageBox(page).fill("Plan exactly one task: run `ls` once, then create hello.txt holding the single word hi. The README is all there is to read.");
  await page.getByRole("button", { name: "Send" }).click();
  const semi = await runIdOf(page);
  await expect(page.getByTestId("run-mode")).toHaveText(/^Semi-autonomous: /);
  await neverAsked(page, botbench, async () => {
    expect(((await (await page.request.get(`${botbench.base}/api/runs/${semi}`)).json()) as { status: string }).status).toBe("awaiting_plan_approval");
  });
  const { planVersion } = (await (await page.request.get(`${botbench.base}/api/runs/${semi}`)).json()) as { planVersion: number };
  const plan = [{ title: "Run ls with your Bash tool once, then create hello.txt holding the word hi", criteria: ["ls was run once with the Bash tool", "hello.txt holds the single word hi"] }];
  expect((await page.request.patch(`${botbench.base}/api/runs/${semi}/plan`, { data: { planVersion, tasks: plan } })).status()).toBe(200);
  await page.getByRole("button", { name: "Approve 1 task" }).click();
  await neverAsked(page, botbench, () => expect(page.getByTestId("run-status")).toHaveText(/^Ready for review\./, { timeout: 1_000 }));
  await page.getByTestId("run-tasks").getByRole("link").first().click();
  const semiTask = Number(/Task (\d+)/.exec((await page.getByTestId("task-name").textContent()) ?? "")![1]);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./);
  await expect(page.getByTestId("task-mode")).toHaveText(/^Semi-autonomous: /);
  const log = (await (await page.request.get(`${botbench.base}/api/action-log?taskId=${semiTask}`)).json()) as { entries: { rule: string; command: string }[] };
  expect(log.entries.filter((entry) => entry.rule === "mode_allowed").length, "the command ran, and is in the log under the mode's rule").toBeGreaterThan(0);
  expect(log.entries.filter((entry) => entry.rule === "asked_owner")).toEqual([]);
  await checkDesign(page, "task, semi-autonomous, ready for review");
  await shot(page, "modes-semi-task.png");

  // Fully autonomous: nothing waits for the owner, and the task whose check passed is accepted without them.
  await openComposer(page);
  await choose(page, "Mode", "Fully autonomous");
  await closeContext(page);
  await expect(page.getByText("Building starts on the plan without your approval.")).toBeVisible();
  await messageBox(page).fill("Plan exactly one task, no more: create hello.txt at the top of the repository holding the single word hi. The README is all there is to read.");
  await page.getByRole("button", { name: "Send" }).click();
  const full = await runIdOf(page);
  await expect(page.getByTestId("run-mode")).toHaveText(/^Fully autonomous: /);
  await neverAsked(page, botbench, () => expect(page.getByTestId("run-status")).toHaveText(/^(Done|Ready for review)\./, { timeout: 1_000 }));
  const run = (await (await page.request.get(`${botbench.base}/api/runs/${full}`)).json()) as { status: string; tasks: { id: number; status: string; checks: string; reason: string | null; decision: { decidedBy: string; branch: string } | null }[] };
  expect(run.tasks.map((task) => [task.status, task.checks, task.decision?.decidedBy, task.decision?.branch, task.reason])).toEqual(run.tasks.map(() => ["accepted", "passed", "mode", "kept", null]));
  expect(run.status).toBe("done");
  await expect(page.getByTestId("run-status")).toHaveText(/^Done\. Every task that was built is decided: this run is fully autonomous/);
  await checkDesign(page, "run, fully autonomous, done");
  await page.getByTestId("run-tasks").getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Accepted without you", level: 2 })).toBeVisible();
  await expect(page.getByTestId("decided-by")).toHaveText("Accepted without you, as this run is fully autonomous: every check passed, this run has no reviewer, and nothing an agent asked for was refused.");
  await expect(page.getByTestId("not-merged")).toContainText("Nothing has been merged or pushed.");
  await checkDesign(page, "task, accepted without the owner");
  await shot(page, "modes-full-task.png");

  // Activity says the mode accepted it.
  await page.goto(`${botbench.base}/#/trust`);
  await expect(page.getByText("Accepted without you: fully autonomous").first()).toBeVisible();
  await checkDesign(page, "permissions, activity with the mode's accept");
  expect(foreign).toEqual([]);
});
