import path from "node:path";
import type { Page } from "@playwright/test";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, test, watchRequests } from "./helpers.ts";
import type { Smelt } from "./smelt.ts";

// Approvals in the real client, at a phone's size: a real Smelt process, a real temporary repository,
// and the owner's Claude Code on its cheapest model asking for real to run the repository's script.

const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';
const PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";
const NONE_WAITING = "No approvals are waiting.";
/** A secondary button of the design system: the raised surface, the text colour, the plain border. */
const SECONDARY_LOOK = { background: "rgb(255, 255, 255)", text: "rgb(23, 23, 23)", border: "rgb(229, 229, 229)" };

/** A real repository beside the test's Smelt home, with a script that leaves a marker file where it lies. */
function scriptRepo(smelt: Smelt): string {
  const repo = path.join(path.dirname(smelt.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  return repo;
}

async function startTask(page: Page, repo: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Screens" });
  await nav.getByRole("link", { name: "New task" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await page.getByLabel("Prompt").fill(PROMPT);
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("heading", { name: "Task 1" })).toBeVisible();
}

test("LIVE: a task that needs the repository's script shows one pending approval in the tray without a reload; the card opens from any screen, Allow resumes the task, and the changed file appears", async ({ page, smelt }) => {
  const foreign = watchRequests(page, smelt);
  const repo = scriptRepo(smelt);
  const before = checkoutState(repo);
  await signIn(page, smelt);
  await page.evaluate(() => ((window as unknown as { smeltLoadedOnce: boolean }).smeltLoadedOnce = true));

  // The tray is on every screen and says in words that nothing waits. It is not a control until something does.
  const tray = page.getByTestId("approval-tray");
  const nav = page.getByRole("navigation", { name: "Screens" });
  await expect(tray).toHaveText(NONE_WAITING);
  await expect(tray.getByRole("link")).toHaveCount(0);
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(tray).toHaveText(NONE_WAITING);
  await checkDesign(page, "tasks, tray with nothing waiting");

  await startTask(page, repo);
  await expect(tray).toHaveText(NONE_WAITING);
  await expect(page.getByTestId("approval-card")).toHaveCount(0);

  // The request arrives by itself: the tray counts it in words and the task says what it is waiting for.
  await expect(tray).toHaveText("1 approval is waiting. Open it.", { timeout: 120_000 });
  await expect(page.getByTestId("task-status")).toHaveText("Waiting for your answer. Claude Code asked for permission and is paused until you allow or decline.");
  await expect(page.locator('[data-event="permission_request"]')).toContainText("sh make-marker.sh");
  expect(await page.evaluate(() => (window as unknown as { smeltLoadedOnce?: boolean }).smeltLoadedOnce), "the card came without a reload").toBe(true);

  // On the other screens the tray says the same, and the list says which task waits.
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(tray).toHaveText("1 approval is waiting. Open it.");
  await expect(page.getByTestId("task-list").getByRole("link")).toHaveText(/Waiting on you.*Task 1 · /);
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await checkDesign(page, "tasks, tray with one waiting");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u7-tray.png") });
  await nav.getByRole("link", { name: "Turn" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(tray).toHaveText("1 approval is waiting. Open it.");

  // The tray is reachable by keyboard and opens the oldest pending card, on its task's screen.
  const open = tray.getByRole("link");
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Task 1" })).toBeVisible();
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card.getByRole("heading")).toHaveText("Claude Code asks to run a command");
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  expect(await card.getByTestId("approval-command").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?IBM Plex Mono"?,/);
  await expect(card.getByTestId("approval-directory")).toHaveText("The top of the task's worktree");
  await expect(card.getByTestId("approval-role")).toHaveText("implementer");
  await expect(card.getByTestId("approval-task")).toHaveText("Task 1 · Run the command `sh make-marker.sh` with your Bash tool, exa…");
  // The agent's own reason is shown when the CLI passed one on, and no row stands empty when it did not.
  const reason = card.getByTestId("approval-reason");
  if ((await reason.count()) > 0) expect(((await reason.textContent()) ?? "").trim().length).toBeGreaterThan(0);

  // Exactly two controls: Allow, the one primary action of this view, and Decline, plainly secondary, at the far end of the same row. No standing permission.
  await expect(card.getByRole("button")).toHaveText(["Allow", "Decline"]);
  // A card's buttons take a moment to come alive, so a tap meant for an earlier card cannot answer this one. Until then they are drawn as unavailable.
  await expect(card.getByRole("button", { name: "Allow" })).toBeEnabled();
  const primaries = await page.getByRole("button").evaluateAll((buttons) => buttons.filter((b) => getComputedStyle(b).backgroundColor === "rgb(26, 26, 26)").map((b) => b.textContent));
  expect(primaries, "one primary action on the screen").toEqual(["Allow"]);
  await expect(page.getByRole("button", { name: /always|standing|every time|remember|pre-?approve/i })).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  const allow = card.getByRole("button", { name: "Allow" });
  const decline = card.getByRole("button", { name: "Decline" });
  const look = (el: Element): { background: string; text: string; border: string } => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, text: style.color, border: style.borderTopColor };
  };
  expect(await allow.evaluate(look)).toEqual({ background: "rgb(26, 26, 26)", text: "rgb(250, 250, 249)", border: "rgb(26, 26, 26)" });
  expect(await decline.evaluate(look)).toEqual(SECONDARY_LOOK);
  const allowBox = (await allow.boundingBox())!;
  const declineBox = (await decline.boundingBox())!;
  expect(allowBox.y, "Allow and Decline share a row").toBe(declineBox.y);
  expect(declineBox.x - (allowBox.x + allowBox.width), "Decline is at the far end of the row, well away from Allow").toBeGreaterThanOrEqual(44);
  expect(allowBox.height).toBeGreaterThanOrEqual(44);
  expect(declineBox.height).toBeGreaterThanOrEqual(44);
  // A note for the agent is one step away, closed until it is asked for, and neither answer hides in it.
  await expect(card.locator("summary")).toHaveText("Decline with a note");
  await expect(card.getByLabel("Note to the agent")).toBeHidden();
  await checkDesign(page, "task, with an approval card");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u7-approval-card.png"), fullPage: true });

  // Nothing has run while the card waited.
  const branch = await page.getByTestId("branch").inputValue();
  const worktree = path.join(smelt.home, "worktrees", branch.split("/")[1]!, "task-1");
  expect(git(worktree, "status", "--porcelain")).toBe("");

  // Allow, from the keyboard. The card goes, the tray empties, and the task resumes and finishes.
  // A card's buttons take a moment to come alive, so a tap meant for an earlier card cannot answer this one.
  await expect(allow).toBeEnabled();
  await allow.focus();
  await expect(allow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  await expect(tray).toHaveText(NONE_WAITING);
  await expect(page.locator('[data-event="permission_resolved"]')).toContainText("You allowed");
  await expect(page.getByTestId("task-status")).toHaveText("Built. Smelt committed the work to the task's branch. Accepting or rejecting it arrives in a later version.", { timeout: 120_000 });
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("listitem")).toHaveCount(1);
  await expect(files.locator("summary").filter({ hasText: "marker.txt" })).toHaveText(/marker\.txt.*added.*\+1 line added.*−0 lines removed/);
  expect(git(repo, "show", `${branch}:marker.txt`).trim()).toBe("ran");
  await expect(page.getByTestId("not-merged")).toHaveText(
    "Nothing has been merged or pushed. Claude Code may read and change files inside this task's worktree without asking. Every shell command waits for your answer first, unless you gave it standing permission (see Trust), and Smelt sends you anything else it wants to do as well. A worktree keeps changes apart; it is not a sandbox: a command you allow runs with your account's rights.",
  );
  await checkDesign(page, "task, finished after an approval");

  expect(await page.evaluate(() => (window as unknown as { smeltLoadedOnce?: boolean }).smeltLoadedOnce), "all of it without a reload").toBe(true);
  expect(foreign, "requests to anything but Smelt").toEqual([]);
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("LIVE: Decline, with a note, shows the declined result in the transcript; the script does not run and the task still finishes", async ({ page, smelt }) => {
  const repo = scriptRepo(smelt);
  await signIn(page, smelt);
  await page.evaluate(() => ((window as unknown as { smeltLoadedOnce: boolean }).smeltLoadedOnce = true));
  await expect(page.getByTestId("approval-tray")).toHaveText(NONE_WAITING);
  await startTask(page, repo);

  // The card appears in place on the task's own screen, without the tray being touched.
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  await expect(page.getByTestId("approval-tray")).toHaveText("1 approval is waiting. Open it.");

  const note = "Not in this task <b>please</b>.";
  // Declining with a note is its own step: the disclosure holds the note and the button that sends it.
  await card.getByText("Decline with a note").click();
  await card.getByLabel("Note to the agent").fill(note);
  await checkDesign(page, "task, an approval card with the note open");
  await expect(card.getByRole("button")).toHaveText(["Allow", "Decline", "Decline and send note"]);
  await card.getByRole("button", { name: "Decline and send note" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("approval-tray")).toHaveText(NONE_WAITING);

  // The transcript says it was declined, with the note as text, and shows what the agent was told.
  const resolved = page.locator('[data-event="permission_resolved"]');
  await expect(resolved).toContainText("You declined");
  await expect(resolved).toContainText(`Your note: ${note}`);
  await expect(resolved.locator("b")).toHaveCount(0);
  await expect(page.locator('[data-event="tool_result"]').filter({ hasText: "The owner declined this request" })).toContainText("Tool error");
  await expect(page.getByTestId("task-status")).toHaveText("Built. No file was changed, so nothing was committed.", { timeout: 120_000 });
  await expect(page.getByTestId("no-changes")).toBeVisible();
  await expect(page.locator('[data-event="turn_ended"]')).toContainText("Turn completed.");
  await checkDesign(page, "task, finished after a decline");

  const branch = await page.getByTestId("branch").inputValue();
  expect(git(repo, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean).sort()).toEqual(["README.md", "make-marker.sh"]);
  expect(git(path.join(smelt.home, "worktrees", branch.split("/")[1]!, "task-1"), "status", "--porcelain")).toBe("");
  expect(await page.evaluate(() => (window as unknown as { smeltLoadedOnce?: boolean }).smeltLoadedOnce)).toBe(true);
});
