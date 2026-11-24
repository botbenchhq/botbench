import path from "node:path";
import type { Page } from "@playwright/test";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { askBeforeEveryCommand, checkDesign, checkWords, expect, filledButtons, goTo, openCanDo, openDetails, openWork, primaries, SHOTS, signIn, startTaskIn, tallShot, test, watchRequests, workRows, workState } from "./helpers.ts";
import type { Botbench } from "./botbench.ts";

// Approvals in the real client, at a phone's size: a real Botbench process, a real temporary repository,
// and the owner's Claude Code on its cheapest model asking for real to run the repository's script. A command kept
// inside the task's copy runs without a card by default, so these tests turn on Ask before every command first.

const MARKER_SCRIPT = '#!/bin/sh\necho ran > "$(dirname "$0")/marker.txt"\n';
const PROMPT = "Run the command `sh make-marker.sh` with your Bash tool, exactly once. Then reply with the single word: done";

/** A real repository beside the test's Botbench home, with a script that leaves a marker file where it lies. */
function scriptRepo(botbench: Botbench): string {
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
  return repo;
}

async function startTask(page: Page, repo: string): Promise<void> {
  await startTaskIn(page, repo, PROMPT);
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);
}

test("LIVE: a task that needs the repository's script shows one pending approval in the tray without a reload; the card opens from any screen, Allow resumes the task, and the changed file appears", async ({ page, botbench }) => {
  const foreign = watchRequests(page, botbench);
  const repo = scriptRepo(botbench);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  await askBeforeEveryCommand(page, botbench);
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));

  // The tray is on every screen and empty while nothing waits. It is not a control until something does.
  const tray = page.getByTestId("approval-tray");
  await expect(tray).toBeEmpty();
  await expect(tray.getByRole("link")).toHaveCount(0);
  // Work says the same: no link to a request while none waits.
  await openWork(page);
  await expect(page.getByTestId("needs-input")).toHaveCount(0);

  await startTask(page, repo);
  await expect(tray).toBeEmpty();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);

  // The request arrives by itself, as its card on the task's screen. The card is the one place that asks: the shell's
  // line about what waits links nowhere here, and only tells a screen reader, once, that the approval is on this screen.
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 120_000 });
  await expect(tray).toHaveText("An approval is waiting on this screen.");
  await expect(tray.getByRole("link")).toHaveCount(0);
  await expect(page.getByTestId("needs-input")).toHaveCount(0);
  // The task's own state says it too: a word in its bar, in the tone of what waits for the owner, and one sentence under its title.
  await expect(page.getByTestId("task-state")).toHaveText("Needs input");
  await expect(page.getByTestId("task-state")).toHaveClass(/text-attention/);
  await expect(page.getByTestId("task-status")).toHaveText("Needs input. Claude Code asked for permission and is paused until you allow or deny.");
  // The call itself waits in the activity as one line, the step that stands open; what it would run is whole on the card above.
  // The asking has no line of its own, and nothing is answered yet.
  const log = page.getByRole("log", { name: "Activity" });
  const asked = log.getByTestId("step-now");
  await expect(asked).toHaveCount(1);
  await expect(asked).toHaveAttribute("data-state", "waiting");
  await expect(asked).toContainText("Wants to run sh make-marker.sh");
  await expect(asked).toContainText("It waits for your answer, on the card above.");
  await expect(log.getByTestId("answer")).toHaveCount(0);
  await expect(log.getByTestId("working")).toHaveCount(0);
  // Haiku was asked for and Haiku answered: no model line.
  await expect(page.getByTestId("task-model")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "the card came without a reload").toBe(true);

  // On the other screens the shell says it, as a link to Home, and Work says which task waits.
  await openWork(page);
  await expect(page.getByTestId("needs-input")).toHaveText("1 approval is waiting. Open it.");
  await expect(workState(workRows(page, "Task 1 · "))).toHaveText("Needs input");
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await checkWords(page, "work, with one request waiting");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u7-tray.png") });
  // Chat says the same, with the same link. Back on Work, the same.
  await goTo(page, "Chat");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("needs-input")).toHaveText("1 approval is waiting. Open it.");
  await expect(page.getByTestId("needs-input")).toHaveAttribute("href", "#/");
  await goTo(page, "Work");
  await expect(tray).toHaveText("1 approval is waiting. Open it.");

  // The link is reachable by keyboard and opens Home, whose Needs you names the request; its Answer leads to the card, on its task's screen.
  const open = tray.getByRole("link");
  await open.focus();
  await page.keyboard.press("Enter");
  const need = page.getByTestId("first-need");
  await expect(need).toContainText("Claude Code asks to run sh make-marker.sh");
  // On Home the request is listed, so the shell's line is for a screen reader only.
  await expect(tray).toHaveText("An approval is waiting on this screen.");
  await need.getByRole("link", { name: "Answer" }).click();
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  // Arriving, the focus is on the screen's heading; the card is the first thing after the title.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(card.getByTestId("decision-signal")).toHaveText("Claude Code is paused");
  await expect(card.getByRole("heading")).toHaveText("Allow this command?");
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  expect(await card.getByTestId("approval-command").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"JetBrains Mono Variable"/);
  await expect(card.getByTestId("approval-directory")).toHaveText("The top folder of the task's copy");
  // The screen is this task's: the card names neither the task nor the step.
  await expect(card.getByTestId("approval-role")).toHaveCount(0);
  await expect(card.getByTestId("approval-task")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run the command `sh make-marker.sh` with…");
  // The agent's own reason is shown when the CLI passed one on, and no row stands empty when it did not.
  const reason = card.getByTestId("approval-reason");
  if ((await reason.count()) > 0) expect(((await reason.textContent()) ?? "").trim().length).toBeGreaterThan(0);

  // Exactly two answers: Decline, plainly secondary, then Allow, the one primary action of this view, in the same row. No standing permission.
  // The card's only other control is the way to a note; neither answer is behind it.
  await expect(card.getByTestId("decision-actions").getByRole("button")).toHaveText(["Decline", "Allow"]);
  await expect(card.getByRole("button")).toHaveText(["Decline", "Allow", "Add a note for Claude Code"]);
  await expect(card.getByText("Allow lets it run once. The next request asks again.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
  await expect.poll(() => primaries(page), { message: "one primary action on the screen" }).toEqual(["Allow"]);
  await expect(page.getByRole("button", { name: /always|standing|every time|remember|pre-?approve/i })).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  // Allow is named Allowing while its answer is sent, and stays the same button.
  const allow = card.getByRole("button", { name: /^Allow(ing)?$/ });
  const decline = card.getByRole("button", { name: "Decline", exact: true });
  // What would run is marked as somebody else's words, so the screen's own wording rules do not read it.
  await expect(card.getByTestId("approval-command")).toHaveAttribute("data-ds-content", "");
  // Allow is the filled button (the one primary action, above); Decline is not drawn as one.
  expect(await filledButtons(page), "Decline is not filled").not.toContain("Decline");
  const allowBox = (await allow.boundingBox())!;
  const declineBox = (await decline.boundingBox())!;
  expect(allowBox.y, "Allow and Decline share a row").toBe(declineBox.y);
  expect(declineBox.x, "Decline comes first in the row, Allow after it").toBeLessThan(allowBox.x);
  expect(allowBox.width, "Allow is the wider of the two").toBeGreaterThan(declineBox.width);
  expect(allowBox.height).toBeGreaterThanOrEqual(44);
  expect(declineBox.height).toBeGreaterThanOrEqual(44);
  // A note for the agent is one step away, after the answers, closed until it is asked for.
  await expect(card.getByRole("button", { name: "Add a note for Claude Code" })).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByLabel("What Claude Code should do instead")).toBeHidden();
  await checkDesign(page, "task, with an approval card");
  if (SHOTS) await tallShot(page, path.join(SHOTS, "u7-approval-card.png"));

  // Nothing has run while the card waited. The full path is in Details; the branch is named under the title.
  const details = await openDetails(page);
  await expect(details.getByTestId("task-repo")).toHaveText(repo);
  const branch = (await page.getByTestId("branch").textContent())!;
  const worktree = path.join(botbench.home, "worktrees", branch.split("/").at(-2)!, "task-1");
  expect(git(worktree, "status", "--porcelain")).toBe("");

  // Allow, from the keyboard. While the answer is on its way, Allow says so and keeps the focus, and only Decline is
  // unavailable. The answer is held here until that is seen. Then the card goes, the tray empties, and the task resumes and finishes.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/approvals\/\d+$/, async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  // A card's answers count only once it has settled, so a tap meant for an earlier card cannot answer this one.
  await expect(card).toHaveAttribute("data-settled", "");
  await allow.focus();
  await expect(allow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(allow).toHaveAttribute("aria-busy", "true");
  await expect(allow).toHaveText("Allowing");
  await expect(allow).toBeEnabled();
  await expect(allow).toBeFocused();
  await expect(decline).toBeDisabled();
  // A second press while it is sent sends nothing more.
  await page.keyboard.press("Enter");
  release();
  await expect(card).toHaveCount(0);
  await page.unroute(/\/api\/approvals\/\d+$/);
  await expect(tray).toBeEmpty();
  await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.", { timeout: 120_000 });
  // The review opens on its Review tab: the one changed file, with its counts. The activity, with the answer, is the tab beside it.
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("heading")).toHaveText("1 file changed");
  await expect(files.getByRole("button", { name: "marker.txt" })).toBeVisible();
  await expect(files).toContainText(/marker\.txt\s*added\s*\+1 line added\s*−0 lines removed/);
  await page.getByRole("tab", { name: /^Activity/ }).click();
  await expect(log.getByTestId("answer")).toHaveText(/^Allowed\.\s*You allowed it once\.$/);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(files).toBeVisible();
  expect(git(repo, "show", `${branch}:marker.txt`).trim()).toBe("ran");
  // One sentence, and what Claude Code may do here one tap away, every word of it kept.
  await expect(page.getByTestId("not-merged")).toHaveText("Nothing has been merged or pushed.");
  await expect(page.getByTestId("branch")).toHaveText(branch);
  if (SHOTS) await tallShot(page, path.join(SHOTS, "task-ready-for-review.png"));
  await expect((await openCanDo(page)).getByTestId("can-do-text")).toHaveText(
    "Claude Code may read and change files inside this task's copy of the project without asking. A shell command kept inside this copy runs without asking, apart from those the safety rules always ask you about; with Ask before every command on in Settings, every one waits for your answer first, unless you chose Always allow for it (see Permissions). Botbench sends you anything else it wants to do as well. The separate copy (a git worktree) keeps changes apart from your own files. A command you allow runs in Claude Code's sandbox: it cannot read your sign-ins, your keys or the rest of your home folder (apart from this repository's git data and your git settings), can change files only in this copy and a temporary folder, and reaches the internet only at hosts allowed for this repository in Botbench's settings file.",
  );
  await checkDesign(page, "task, finished after an approval");

  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "all of it without a reload").toBe(true);
  expect(foreign, "requests to anything but Botbench").toEqual([]);
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("LIVE: Decline, with a note, shows the declined result in the transcript; the script does not run and the task still finishes", async ({ page, botbench }) => {
  const repo = scriptRepo(botbench);
  await signIn(page, botbench);
  await askBeforeEveryCommand(page, botbench);
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
  await expect(page.getByTestId("approval-tray")).toBeEmpty();
  await startTask(page, repo);

  // The card appears in place on the task's own screen, without the tray being touched.
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  await expect(page.getByTestId("approval-tray")).toHaveText("An approval is waiting on this screen.");

  const note = "Not in this task <b>please</b>.";
  // The note is in a disclosure after the answers; the card's one Decline sends it. There is no second decline button.
  await card.getByRole("button", { name: "Add a note for Claude Code" }).click();
  await card.getByLabel("What Claude Code should do instead").fill(note);
  await expect(card.getByText("Decline sends it with your answer. Allow does not.")).toBeVisible();
  await checkDesign(page, "task, an approval card with the note open");
  await expect(card.getByRole("button")).toHaveText(["Decline", "Allow", "Add a note for Claude Code"]);
  await expect(card).toHaveAttribute("data-settled", "");
  await card.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("approval-tray")).toBeEmpty();

  // The activity says it was declined, with the note as text, and shows what the agent was told.
  const log = page.getByRole("log", { name: "Activity" });
  const resolved = log.getByTestId("answer");
  await expect(resolved).toHaveCount(1);
  await expect(resolved).toContainText("Denied. You denied it. It was not run.");
  // No line of its own for the asking: the call's step and the answer's line say it. The step did not end well, so its group stands open.
  await expect(log.getByTestId("step-now")).toHaveCount(0);
  const group = log.getByTestId("steps").filter({ hasText: "sh make-marker.sh" }).first();
  await expect(group).toContainText(/\d+ steps? ended/);
  await expect(group).toContainText("1 not run");
  await expect(group.getByRole("button", { name: /Hide steps/ })).toBeVisible();
  const refused = group.getByRole("listitem").filter({ hasText: "sh make-marker.sh" });
  await expect(refused).toContainText("Did not run sh make-marker.sh");
  await expect(refused.getByText("You denied this.")).toBeVisible();
  await expect(resolved).toContainText(`Your note: ${note}`);
  await expect(resolved.locator("b")).toHaveCount(0);
  await expect(refused.getByRole("group", { name: "What it printed" })).toContainText("The owner denied this request");
  // A build that changed no file ends as failed, saying so, for the owner to resume or discard (since builds that change nothing stop there).
  await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. Claude Code finished without changing any file\./, { timeout: 120_000 });
  await expect(page.getByTestId("task-state")).toHaveText("Failed");
  await expect(page.getByTestId("task-reason")).toHaveText("Claude Code finished without changing any file.");
  await checkDesign(page, "task, finished after a decline");

  const { branch } = (await (await page.request.get(`${botbench.base}/api/tasks/1`)).json()) as { branch: string };
  expect(git(repo, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean).sort()).toEqual(["README.md", "make-marker.sh"]);
  expect(git(path.join(botbench.home, "worktrees", branch.split("/").at(-2)!, "task-1"), "status", "--porcelain")).toBe("");
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);
});
