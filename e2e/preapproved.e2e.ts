import fs from "node:fs";
import path from "node:path";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, primaries, SHOTS, signIn, test as base, watchRequests, openNewTask } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Pre-approved commands in the real client, at a phone's size: a real Botbench process whose settings list commands
// for a real temporary repository, and the owner's Claude Code on its cheapest model running one of them for real.

const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';
const PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";
const HEADING = "Allowed for this task";

/** A Botbench whose settings name the commands its sample repository offers for pre-approval. The repository must exist before Botbench reads its settings. */
const test = base.extend<{ repo: string }>({
  repo: async ({}, use) => {
    const dir = tempDir("botbench-e2e-pre-");
    const repo = path.join(dir, "sample-repo");
    initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
    await use(repo);
  },
  botbench: async ({ repo }, use) => {
    const botbench: Botbench = await startBotbench({
      home: path.join(path.dirname(repo), "home"),
      settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { preapproved: ["npm test", "git status"] } } },
    });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

test("LIVE: New task lists the repository's configured commands; the owner removes one and adds another; the task runs the added command with no card and finishes, and its screen lists what was pre-approved", async ({ page, botbench, repo }) => {
  const foreign = watchRequests(page, botbench);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
  const tray = page.getByTestId("approval-tray");
  await openNewTask(page);

  // The field starts with the configured repository, the one Botbench knows of.
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await expect(page.getByRole("heading", { name: HEADING })).toBeVisible();
  const list = page.getByTestId("preapproved-list");
  await expect(list.getByRole("listitem")).toHaveText([/^npm test/, /^git status/]);
  expect(await list.evaluate((el) => [el.tagName, ...[...el.children].map((child) => child.tagName)])).toEqual(["UL", "LI", "LI"]);
  await expect(page.getByTestId("preapproved-about")).toContainText("Dangerous commands always ask");
  expect(await list.locator("code").first().evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?IBM Plex Mono"?,/);
  // Start task is still the one primary action.
  expect(await primaries(page)).toEqual(["Start task"]);
  await checkDesign(page, "new task, with the repository's pre-approved commands");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u9-new-task.png"), fullPage: true });

  // Remove one, add another. Enter in the field adds; it does not start the task.
  await page.getByRole("button", { name: "Remove npm test" }).click();
  await expect(list.getByRole("listitem")).toHaveText([/^git status/]);
  const add = page.getByLabel("Add a command");
  await add.fill("sh make-marker.sh && echo done");
  await add.press("Enter");
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveText([/^git status/, /^sh make-marker\.sh && echo done/]);
  await expect(add).toHaveValue("");

  // A command typed and not added is neither dropped nor granted: the task is not started until the owner says which.
  await page.getByLabel("Prompt").fill(PROMPT);
  await add.fill("sh make-marker.sh");
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("alert")).toContainText("The task was not started");
  await expect(page.getByRole("alert")).toContainText("Add the command you typed, or clear it");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(3);

  // The server refuses a chained entry in words, and nothing is started.
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("alert")).toContainText("The task was not started");
  await expect(page.getByRole("alert")).toContainText('"sh make-marker.sh && echo done" cannot be allowed in advance');
  expect(await (await page.request.get(`${botbench.base}/api/tasks`)).json()).toEqual({ tasks: [] });
  await checkDesign(page, "new task, an entry refused");
  await page.getByRole("button", { name: "Remove sh make-marker.sh && echo done" }).click();
  await expect(list.getByRole("listitem")).toHaveText([/^git status/, /^sh make-marker\.sh/]);
  expect(await primaries(page)).toEqual(["Start task"]);

  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("heading", { name: "Task 1" })).toBeVisible();
  // The task screen says in words what may run without asking, from the start.
  const granted = page.getByTestId("task-preapproved");
  await expect(granted.getByRole("listitem")).toHaveText(["git status", "sh make-marker.sh"]);
  expect(await granted.evaluate((el) => [el.tagName, ...[...el.children].map((child) => child.tagName)])).toEqual(["UL", "LI", "LI"]);

  // It finishes with nobody answering: no card, the tray never counts one.
  await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.", { timeout: 120_000 });
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(tray).toBeEmpty();
  const resolved = page.locator('[data-event="permission_resolved"]');
  await expect(resolved).toHaveCount(1);
  await expect(resolved).toContainText("Allowed for this task");
  await expect(resolved).toContainText("sh make-marker.sh");
  await expect(resolved).toContainText("allowed without asking you");
  // The action itself is one plain line, and what ran is one tap away, never raw arguments on the line.
  const ran = page.locator('[data-event="tool_call"]').filter({ hasText: "sh make-marker.sh" }).first();
  await expect(ran.locator(".ds-tool-call")).toHaveAttribute("data-state", "succeeded");
  await expect(ran.locator(".ds-tool-call__title")).toHaveText(/^Done\s*Ran\s*sh make-marker\.sh$/);
  await expect(ran.locator("summary").first()).not.toContainText("{");
  await expect(page.getByRole("log")).not.toContainText("You allowed");
  await expect(page.getByRole("log")).not.toContainText("needs your answer");
  const files = page.getByTestId("changed-files");
  await expect(files.locator("summary").filter({ hasText: "marker.txt" })).toHaveText(/marker\.txt.*added/);
  const branch = await page.getByTestId("branch").inputValue();
  expect(git(repo, "show", `${branch}:marker.txt`).trim()).toBe("ran");
  await expect(page.getByTestId("not-merged")).toContainText("The commands listed above, and those you chose Always allow for (see Permissions), run without asking; every other shell command waits for your answer first");
  await expect(page.getByRole("button", { name: /always|standing|every time|remember/i })).toHaveCount(0);
  await checkDesign(page, "task, finished on a pre-approved command");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u9-task.png"), fullPage: true });

  // The record: no approval was ever created, and the log names the rule and the grant.
  expect(await (await page.request.get(`${botbench.base}/api/approvals`)).json()).toEqual({ approvals: [] });
  const log = (await (await page.request.get(`${botbench.base}/api/action-log?taskId=1`)).json()) as { entries: { rule: string; grantId: number | null; command: string }[] };
  expect(log.entries.map((e) => [e.rule, e.grantId, e.command])).toEqual([["preapproved", 2, "sh make-marker.sh"]]);

  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "all of it without a reload").toBe(true);
  expect(foreign, "requests to anything but Botbench").toEqual([]);
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("a repository with nothing configured offers an empty list that says every command asks, and the offer follows the repository named", async ({ page, botbench, repo }) => {
  // A second repository, which the settings do not name.
  const other = path.join(botbench.home, "..", "other-repo");
  initRepo(other);
  await signIn(page, botbench);
  await openNewTask(page);
  await page.getByLabel("Repository path").fill(other);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await expect(page.getByRole("heading", { name: HEADING })).toBeVisible();
  await expect(page.getByTestId("preapproved-list")).toHaveCount(0);
  await expect(page.getByTestId("preapproved-none")).toHaveText("No command is listed, so every shell command asks.");
  await checkDesign(page, "new task, nothing pre-approved");

  // Changing the repository changes the offer: the configured one's list replaces the empty one, and the other way round.
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("preapproved-list").getByRole("listitem")).toHaveText([/^npm test/, /^git status/]);
  await page.getByLabel("Repository path").fill(path.join(repo, "missing"));
  await expect(page.getByTestId("repo-state")).toContainText("does not exist");
  await expect(page.getByRole("heading", { name: HEADING })).toHaveCount(0);
});
