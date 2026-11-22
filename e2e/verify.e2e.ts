import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { SHOTS, checkDesign, expect, openWork, signIn, startTaskIn, tallShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The verify station in the real client, at a phone's size: a real Botbench process whose settings give two real
// temporary repositories check commands, and the owner's Claude Code building one tiny task in each, on its cheapest
// model. The checks are fixture scripts committed in the repositories, which read what the agent wrote.

const CHECK_SCRIPT = '#!/bin/sh\nsleep 2\necho "checking hello.txt for $1"\ngrep -q "$1" hello.txt && echo "found it" || { echo "hello.txt does not hold $1" >&2; exit 1; }\n';

const test = base.extend<{ dir: string; botbench: Botbench; repos: { failing: string; passing: string; unchecked: string } }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-verify-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repos: async ({ dir }, use) => {
    const failing = path.join(dir, "failing-repo");
    const passing = path.join(dir, "passing-repo");
    const unchecked = path.join(dir, "unchecked-repo");
    for (const repo of [failing, passing, unchecked]) initRepo(repo, { "README.md": "# Sample\n", "check.sh": CHECK_SCRIPT });
    await use({ failing, passing, unchecked });
  },
  botbench: async ({ dir, repos }, use) => {
    const botbench = await startBotbench({
      home: path.join(dir, "home"),
      settings: {
        drivers: { "claude-code": { model: "haiku" } },
        repositories: {
          [repos.failing]: { checks: ["sh check.sh hi", { command: "sh check.sh goodbye", timeoutSeconds: 60 }] },
          [repos.passing]: { checks: ["sh check.sh hi"] },
        },
      },
    });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

/** Start a task in `repo` from New task, decline whatever its agent asks, and wait on its screen until it is Ready for review. */
async function buildTask(page: Page, botbench: Botbench, repo: string, o: { checking: boolean } = { checking: true }): Promise<void> {
  await startTaskIn(page, repo, "Create the file hello.txt containing the single word hi, with your Write tool. Run no command.");
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  // The checks take two seconds each, so the screen is seen saying Checking while they run.
  await expect(async () => {
    for (const approval of ((await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] }).approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Write the file with your Write tool; run no command." } });
    }
    await expect(page.getByTestId("task-status")).toHaveText(o.checking ? /^Checking\./ : /^Ready for review\./, { timeout: 1_000 });
  }).toPass({ timeout: 150_000, intervals: [500] });
  if (o.checking) await checkDesign(page, "task, checking");
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 60_000 });
}

test("LIVE: a task whose check fails says so in words with an icon, opens the failing output, and is still ready for review; a task whose checks pass says that; a repository with no checks says so and shows no pass", async ({ page, botbench, repos }) => {
  test.setTimeout(420_000);
  await signIn(page, botbench);

  await buildTask(page, botbench, repos.failing);
  const result = page.getByTestId("checks-result");
  await expect(result).toHaveText("Checks failed: 1 of 2 checks did not pass.");
  await expect(result.locator("svg")).toHaveCount(1);
  await expect(page.getByText("Checks run this repository's own commands on the agent's work, on this Mac, in a sandbox: they cannot read the sign-in, key and credential folders Botbench keeps them from or Botbench's own files, can change files only in this task's copy and a temporary folder, and reach the internet only at hosts allowed for this repository in Botbench's settings file. They can still read the rest of your home folder. The agent may have changed the code they run, so read the output, not only the result.")).toBeVisible();
  const items = page.getByTestId("checks").locator(".ds-check-list__item");
  await expect(items).toHaveCount(2);
  // The failed check comes first; its result is words, and its output opens.
  await expect(items.nth(0).locator(".ds-check-list__name")).toHaveText("sh check.sh goodbye");
  await expect(items.nth(0).locator(".ds-check-list__result")).toHaveText("Failed, exit code 1");
  await expect(items.nth(1).locator(".ds-check-list__result")).toHaveText("Passed");
  await expect(page.getByTestId("checks").locator(".ds-check-list__summary")).toHaveText("1 of 2 checks passed. 1 failed.");
  await items.nth(0).locator(".ds-check-list__toggle").click();
  await expect(items.nth(0).locator(".ds-check-list__log")).toHaveText(/checking hello.txt for goodbye\s+hello.txt does not hold goodbye/);
  await checkDesign(page, "task, checks failed, output open");
  await shot(page, "u13-checks-failed.png");

  await buildTask(page, botbench, repos.passing);
  await expect(page.getByTestId("checks-result")).toHaveText("Checks passed: 1 of 1 check passed.");
  await expect(page.getByTestId("checks").locator(".ds-check-list__result")).toHaveText("Passed");
  await checkDesign(page, "task, checks passed");
  await shot(page, "u13-checks-passed.png");

  // A repository with no check commands: the task says so plainly, and nothing reads as a pass.
  await buildTask(page, botbench, repos.unchecked, { checking: false });
  await expect(page.getByTestId("checks-result")).toHaveText("No checks are set up for this repository.");
  await expect(page.getByTestId("checks")).toHaveCount(0);
  await expect(page.getByText(/Checks passed|Passed/)).toHaveCount(0);
  await checkDesign(page, "task, no checks set up");

  // Work says the same in words.
  await openWork(page);
  const listed = page.getByTestId("board-group").getByRole("listitem");
  await expect(listed).toHaveCount(3);
  await expect(listed.nth(0)).toContainText("No checks set up");
  await expect(listed.nth(1)).toContainText("Checks passed");
  await expect(listed.nth(2)).toContainText("Checks failed");
  await checkDesign(page, "work, with checks");
});
