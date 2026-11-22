import path from "node:path";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, test } from "./helpers.ts";

// An approval across a restart, in the real client at a phone's size: a real Smelt process that is stopped and
// started again on the same data, and the owner's Claude Code on its cheapest model asking for real.

const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';
const PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";
const PARKED_STATUS = "Waiting for your answer. Claude Code asked for permission before Smelt restarted and is stopped. Your answer starts it again where it stood.";
const PARKED_CARD = "Asked before Smelt restarted. Claude Code is stopped; your answer starts it again where it stood, and counts only if it asks for exactly this again.";

test("LIVE: a task waits on an approval, Smelt is restarted, and after signing in again the card is still there and says it predates the restart; Allow resumes the task, which finishes with its changed file and exactly one approval", async ({ page, smelt }) => {
  const repo = path.join(path.dirname(smelt.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  const before = checkoutState(repo);
  await signIn(page, smelt);

  const nav = page.getByRole("navigation", { name: "Screens" });
  await nav.getByRole("link", { name: "New task" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await page.getByLabel("Prompt").fill(PROMPT);
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("heading", { name: "Task 1" })).toBeVisible();

  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  // A card asked in this run of Smelt says nothing about a restart.
  await expect(card.getByTestId("approval-parked")).toHaveCount(0);
  const branch = (await page.getByTestId("branch").textContent())!;
  const worktree = path.join(smelt.home, "worktrees", branch.split("/")[1]!, "task-1");

  // Smelt stops and starts again. The session ended with the old process, so the owner signs in again.
  await smelt.restart();
  await signIn(page, smelt);
  const tray = page.getByTestId("approval-tray");
  await expect(tray).toHaveText("1 approval is waiting. Open it.");
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByTestId("task-list").getByRole("link")).toHaveText(/Task 1 · Waiting on you/);
  await tray.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Task 1" })).toBeVisible();

  // The same card, and it says in words that it was asked before the restart and what answering does.
  await expect(card).toBeVisible();
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  await expect(card.getByTestId("approval-directory")).toHaveText("The top of the task's worktree");
  await expect(card.getByTestId("approval-parked")).toHaveText(PARKED_CARD);
  await expect(page.getByTestId("task-status")).toHaveText(PARKED_STATUS);
  // No control beyond the two the card always had.
  await expect(card.getByRole("button")).toHaveText(["Allow", "Decline"]);
  await expect(page.getByRole("button", { name: /resume|retry|restart/i })).toHaveCount(0);
  await checkDesign(page, "task, with a card from before a restart");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u8-parked-card.png"), fullPage: true });
  expect(git(worktree, "status", "--porcelain"), "nothing ran while Smelt was down or since").toBe("");

  const allow = card.getByRole("button", { name: "Allow" });
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(card).toHaveCount(0);
  await expect(tray).toHaveText("No approvals are waiting.");
  await expect(page.getByTestId("task-status")).toHaveText("Built. Smelt committed the work to the task's branch. Accepting or rejecting it arrives in a later version.", { timeout: 150_000 });
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("listitem")).toHaveCount(1);
  await expect(files.getByRole("button", { name: /marker\.txt/ })).toHaveText(/marker\.txt.*added.*\+1.*−0/);
  expect(git(repo, "show", `${branch}:marker.txt`).trim()).toBe("ran");
  // No second card was ever raised: one approval exists, and it is the one that was allowed.
  await expect(card).toHaveCount(0);
  const approvals = await page.evaluate(async () => ((await (await fetch("/api/approvals")).json()) as { approvals: { status: string; command: string }[] }).approvals);
  expect(approvals.map((a) => [a.command, a.status])).toEqual([["sh make-marker.sh", "allowed"]]);
  await expect(page.locator('[data-event="permission_resolved"]')).toContainText("You allowed");
  await checkDesign(page, "task, finished after a restart");
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});
