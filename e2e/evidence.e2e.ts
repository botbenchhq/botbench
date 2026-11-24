import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { botbenchBranches, checkoutState, git, initRepo, ownerCommit, write } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkDesign, expect, SHOTS, signIn, tallShot } from "./helpers.ts";

// Evidence tied to the commit under review, on the task screen, in the real client at a phone's size, against a real
// Botbench process whose Claude Code replays a turn recorded from a real session (e2e/serve-replayed-build.ts, the
// owner's approved exception), with a real temporary repository, a real setup command that makes the task's change and
// real checks in the real sandbox. No model turn. The rules and their words are tested in test/engine/evidence.test.ts
// and test/api/evidence.test.ts; here, the two journeys that need the screen.

const test = base.extend<{ checks: string[]; dir: string; repo: string; botbench: Botbench }>({
  checks: [["test -f hello.txt"], { option: true }],
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-evidence-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  repo: async ({ dir }, use) => {
    const repo = path.join(dir, "repo");
    initRepo(repo, { "README.md": "# Sample\n" });
    await use(fs.realpathSync(repo));
  },
  botbench: async ({ dir, repo, checks }, use) => {
    // The replayed builder goes on at once: the test needs the task built, not held.
    fs.writeFileSync(path.join(dir, "release-builder"), "");
    const botbench = await startBotbench({
      home: path.join(dir, "home"),
      entry: path.resolve(import.meta.dirname, "serve-replayed-build.ts"),
      settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { setup: ["printf 'hello\\n' > hello.txt"], checks } } },
    });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

interface Described {
  branch: string;
  headCommit: string;
  evidenceState: { state: string; checkedCommit: string | null; headCommit: string | null } | null;
  decision: { checks: string | null; checksCommit: string | null; headCommit: string | null } | null;
}

/** Start a task over the API and open its screen, ready for review. */
async function readyTask(page: import("@playwright/test").Page, botbench: Botbench, repo: string): Promise<number> {
  const started = await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt: "Add a greeting file" } });
  expect(started.status(), await started.text()).toBe(200);
  const { taskId } = (await started.json()) as { taskId: number };
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 60_000 });
  return taskId;
}

const described = async (page: import("@playwright/test").Page, botbench: Botbench, id: number): Promise<Described> => (await (await page.request.get(`${botbench.base}/api/tasks/${id}`)).json()) as Described;

/** Which of a row's buttons are filled: only the view's one main action is. */
const filled = (row: import("@playwright/test").Locator): Promise<boolean[]> => row.getByRole("button").evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor !== "rgba(0, 0, 0, 0)"));

test("a copy that differs from its commit, then checks that are about an older commit, take Accept away and say why; Run checks again checks the commit the branch holds, and the task is then accepted on it", async ({ page, botbench, repo }) => {
  test.setTimeout(180_000);
  await signIn(page, botbench);
  const taskId = await readyTask(page, botbench, repo);
  const first = await described(page, botbench, taskId);
  const owner = checkoutState(repo);
  // At a phone's width the decision's buttons stay at the foot of the window; the evidence is the verification card's.
  const decide = page.getByTestId("verification");
  const actions = page.getByTestId("foot-actions");

  // Current: the server's sentence names the commit, and Accept is the one filled button.
  await expect(decide.getByTestId("evidence-words")).toHaveText(`Evidence is current: the checks passed on commit ${first.headCommit.slice(0, 7)}, the commit Accept keeps.`);
  await expect(actions.getByRole("button")).toHaveText(["Reject", "Accept"]);
  expect(await filled(actions)).toEqual([false, true]);
  await checkDesign(page, "task, evidence current");

  // A file appears in the task's copy that is not in the commit and that git does not ignore: the copy differs, the
  // file is listed, and there is neither an Accept nor checks to run again, only Reject.
  const copy = fs.readdirSync(path.join(botbench.home, "worktrees")).map((run) => path.join(botbench.home, "worktrees", run, `task-${taskId}`)).find((dir) => fs.existsSync(dir))!;
  write(copy, "mine.txt", "the owner's own work\n");
  await page.reload();
  await expect(decide.getByTestId("evidence-words")).toHaveText(new RegExp(`^The task's copy has 1 file that differs from commit ${first.headCommit.slice(0, 7)}: mine\\.txt \\(not on the branch\\)\\.`));
  await expect(decide.getByTestId("evidence-files").getByRole("listitem")).toHaveText(["mine.txtNot on the branch"]);
  await expect(actions.getByRole("button")).toHaveText(["Reject"]);
  await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Its copy holds files that are not in the commit on its branch, so it cannot be accepted as it is; you can still reject it.");
  await checkDesign(page, "task, copy differs from the commit");
  if (SHOTS) await tallShot(page, path.join(SHOTS, "evidence-differs.png"));

  // The owner commits it on the task's branch, in its copy: the checks are now about an older commit.
  const later = ownerCommit(copy, "the owner's commit");
  await page.reload();
  await expect(decide.getByTestId("evidence-words")).toHaveText(`The checks are out of date: they ran on commit ${first.headCommit.slice(0, 7)}, and the branch is now at commit ${later.slice(0, 7)}. Run checks again to check the commit you would accept.`);
  await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Its checks are out of date, so it cannot be accepted until they are run again; you can still reject it.");
  // No Accept, in any wording: Run checks again and Reject are what there is.
  await expect(actions.getByRole("button")).toHaveText(["Reject", "Run checks again"]);
  await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
  expect(await filled(actions)).toEqual([false, false]);
  await checkDesign(page, "task, evidence out of date");
  if (SHOTS) await tallShot(page, path.join(SHOTS, "evidence-out-of-date.png"));

  await actions.getByRole("button", { name: "Run checks again" }).click();
  await expect(decide.getByTestId("evidence-words")).toHaveText(`Evidence is current: the checks passed on commit ${later.slice(0, 7)}, the commit Accept keeps.`, { timeout: 60_000 });
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\. Botbench committed the work/);
  await expect(actions.getByRole("button")).toHaveText(["Reject", "Accept"]);
  await expect(page.getByTestId("verification-heading")).toHaveText("1 of 1 check passed");
  expect((await described(page, botbench, taskId)).evidenceState).toMatchObject({ state: "current", checkedCommit: later, headCommit: later });
  await checkDesign(page, "task, evidence current again");

  await actions.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Accepted\. /);
  await expect(page.getByTestId("task-state")).toHaveText("Accepted");
  // The evidence line was about a decision still to make: it goes with the buttons.
  await expect(decide.getByTestId("evidence-words")).toHaveCount(0);
  await expect(actions).toHaveCount(0);
  const accepted = await described(page, botbench, taskId);
  expect(accepted.decision).toMatchObject({ checks: "passed", checksCommit: later, headCommit: later });
  expect(git(repo, "rev-parse", accepted.branch).trim()).toBe(later);
  expect(botbenchBranches(repo)).toEqual([accepted.branch]);
  expect(checkoutState(repo)).toEqual(owner);
  await checkDesign(page, "task, accepted after the checks ran again");
});

test.describe("a repository with no checks", () => {
  test.use({ checks: [] });

  test("work no check ran on is offered as Accept without verification, not as the primary action, and is shown and logged as accepted without verification", async ({ page, botbench, repo }) => {
    test.setTimeout(180_000);
    await signIn(page, botbench);
    const taskId = await readyTask(page, botbench, repo);
    const decide = page.getByTestId("verification");
    const actions = page.getByTestId("foot-actions");
    await expect(decide.getByTestId("verification-heading")).toHaveText("No checks are set up for this repository");
    await expect(decide.getByTestId("evidence-words")).toHaveText("No checks are set up for this repository, so nothing verified this work. You can accept it without verification.");
    await expect(actions.getByRole("button")).toHaveText(["Reject", "Accept without verification"]);
    // Never plain Accept, and never the look of the screen's main action.
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    expect(await filled(actions)).toEqual([false, false]);
    await checkDesign(page, "task, no checks, ready for review");
    if (SHOTS) await tallShot(page, path.join(SHOTS, "evidence-no-checks.png"));

    await actions.getByRole("button", { name: "Accept without verification" }).click();
    await expect(page.getByTestId("task-status")).toHaveText(/^Accepted without verification: no checks ran on it\. /);
    // Said as that in the decision's pane, and not drawn as a success.
    await page.getByRole("button", { name: "The decision" }).click();
    const badge = page.getByTestId("decision-result").getByText("Accepted without verification", { exact: true });
    await expect(badge).toBeVisible();
    expect(await badge.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    await checkDesign(page, "task, accepted without verification");
    const accepted = await described(page, botbench, taskId);
    expect(accepted.decision).toMatchObject({ checks: "none", checksCommit: null });
    const log = ((await (await page.request.get(`${botbench.base}/api/action-log?taskId=${taskId}`)).json()) as { entries: { rule: string; detail: string | null }[] }).entries.filter((entry) => entry.rule === "owner_accepted");
    expect(log).toHaveLength(1);
    expect(log[0]!.detail).toContain("Accepted without verification: no checks are set up for this repository, so nothing verified this work.");
  });
});
