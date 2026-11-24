import path from "node:path";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { askBeforeEveryCommand, checkDesign, expect, messageBox, openWork, SHOTS, signIn, startTaskIn, test, workRows, workState } from "./helpers.ts";

// An approval across a restart, in the real client at a phone's size: a real Botbench process that is stopped and
// started again on the same data, and the owner's Claude Code on its cheapest model asking for real.

const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';
const PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";
const PARKED_CARD = "Asked before Botbench restarted. Claude Code is stopped; your answer starts it again where it left off, and counts only if it asks for exactly this again.";

test("LIVE: a task waits on an approval, Botbench is restarted, and after a reload, still signed in, the card is still there and says it predates the restart; Allow resumes the task, which finishes with its changed file and exactly one approval", async ({ page, botbench }) => {
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  const before = checkoutState(repo);
  await signIn(page, botbench);
  // A command kept inside the task's copy runs without a card by default: the card to park needs Ask before every command.
  await askBeforeEveryCommand(page, botbench);

  await startTaskIn(page, repo, PROMPT);
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);

  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  // A card asked in this run of Botbench says nothing about a restart.
  await expect(card.getByTestId("approval-parked")).toHaveCount(0);
  const branch = (await page.getByTestId("branch").textContent())!;
  const worktree = path.join(botbench.home, "worktrees", branch.split("/").at(-2)!, "task-1");

  // Botbench stops and starts again. The device stays signed in across the restart, so the owner only reloads.
  await botbench.restart();
  await page.goto(`${botbench.base}/#/turn`);
  // The composer remembers the repository, so its box may read "Describe the task" rather than "Message Claude Code".
  await expect(messageBox(page)).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  const tray = page.getByTestId("approval-tray");
  await expect(tray).toHaveText("1 approval is waiting. Open it.");
  await openWork(page);
  await expect(workState(workRows(page, "Task 1 · "))).toHaveText("Needs input");
  // On Work, as on the other screens, the line about what waits leads to Home, whose Needs you names the request; its Answer leads to the task.
  await page.getByTestId("needs-input").click();
  await page.getByTestId("first-need").getByRole("link", { name: "Answer" }).click();
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);

  // The same card, and it says in words that it was asked before the restart and what answering does.
  await expect(card).toBeVisible();
  await expect(card.getByTestId("decision-signal")).toHaveText("Claude Code is stopped");
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  await expect(card.getByTestId("approval-directory")).toHaveText("The top folder of the task's copy");
  await expect(card.getByTestId("approval-parked")).toHaveText(PARKED_CARD);
  // The task's own state says the same, in a word and in one sentence.
  await expect(page.getByTestId("task-state")).toHaveText("Needs input");
  await expect(page.getByTestId("task-status")).toHaveText("Needs input. Claude Code asked for permission before Botbench restarted and is stopped. Your answer starts it again where it left off.");
  // No answer beyond the two the card always had; its only other control is the way to a note.
  await expect(card.getByTestId("decision-actions").getByRole("button")).toHaveText(["Decline", "Allow"]);
  await expect(card.getByRole("button")).toHaveText(["Decline", "Allow", "Add a note for Claude Code"]);
  await expect(page.getByRole("button", { name: /resume|retry|restart/i })).toHaveCount(0);
  await checkDesign(page, "task, with a card from before a restart");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u8-parked-card.png"), fullPage: true });
  expect(git(worktree, "status", "--porcelain"), "nothing ran while Botbench was down or since").toBe("");

  const allow = card.getByRole("button", { name: "Allow", exact: true });
  await expect(card).toHaveAttribute("data-settled", "");
  await allow.click();
  await expect(card).toHaveCount(0);
  await expect(tray).toBeEmpty();
  await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.", { timeout: 150_000 });
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("heading")).toHaveText("1 file changed");
  await expect(files.getByRole("button", { name: "marker.txt" })).toBeVisible();
  await expect(files).toContainText(/marker\.txt\s*added\s*\+1 line added\s*−0 lines removed/);
  expect(git(repo, "show", `${branch}:marker.txt`).trim()).toBe("ran");
  // No second card was ever raised: one approval exists, and it is the one that was allowed.
  await expect(card).toHaveCount(0);
  const approvals = await page.evaluate(async () => ((await (await fetch("/api/approvals")).json()) as { approvals: { status: string; command: string }[] }).approvals);
  expect(approvals.map((a) => [a.command, a.status])).toEqual([["sh make-marker.sh", "allowed"]]);
  // The answer is in the activity, the tab beside the review.
  await page.getByRole("tab", { name: /^Activity/ }).click();
  await expect(page.getByRole("log", { name: "Activity" }).getByTestId("answer")).toContainText("You allowed it once.");
  await checkDesign(page, "task, finished after a restart");
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});
