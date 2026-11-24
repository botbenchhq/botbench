import path from "node:path";
import type { Page } from "@playwright/test";
import { checkoutState, git, initRepo } from "../test/support/repo.ts";
import { askBeforeEveryCommand, checkDesign, checkWords, expect, goTo, MONO_FAMILY, nav, openCanDo, openDetails, openWork, primaries, PRIMARY_LOOK, SECONDARY_LOOK, SHOTS, signIn, startTaskIn, tallShot, test, token, watchRequests, workRows, workState } from "./helpers.ts";
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
  // Work, a rebuilt screen, says the same in its own bar: no link to a request while none waits.
  await openWork(page);
  await expect(page.getByRole("link", { name: /^Needs input: task/ })).toHaveCount(0);

  await startTask(page, repo);
  await expect(tray).toBeEmpty();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);

  // The request arrives by itself, as its card on the task's screen. The card is the one place that says so: the header's
  // tray is not drawn here, and only tells a screen reader, once, that the approval is on this screen.
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 120_000 });
  await expect(tray).toHaveText("An approval is waiting on this screen.");
  await expect(tray.getByRole("link")).toHaveCount(0);
  await expect(page.locator(".ds-app-header__tray")).toHaveCount(0);
  await expect(page.getByTestId("task-status")).toHaveCount(0);
  await expect(page.locator('[data-event="permission_request"]')).toHaveCount(0);
  await expect(page.getByText(/until you answer|until you allow or deny/)).toHaveCount(0);
  // The call itself waits in the transcript as one line, in the approval tone: the status set's Needs input, with its paused icon. Its details are one tap away.
  const asked = page.locator('[data-event="tool_call"]').filter({ hasText: "sh make-marker.sh" }).first().locator(".ds-tool-call");
  await expect(asked).toHaveAttribute("data-state", "awaiting-approval");
  await expect(asked.locator(".ds-tool-call__status")).toHaveText("Needs input");
  await expect(asked.locator(".ds-tool-call__title")).toHaveText(/^Needs input\s*Wants to run\s*sh make-marker\.sh$/);
  await expect(asked.locator("details").first()).not.toHaveAttribute("open");
  await asked.locator("summary").first().click();
  await expect(asked.locator(".ds-tool-call__body pre").first()).toHaveText("sh make-marker.sh");
  await asked.locator("summary").first().click();
  await expect(asked.locator("details").first()).not.toHaveAttribute("open");
  // Haiku was asked for and Haiku answered: no model line.
  await expect(page.getByTestId("task-model")).toHaveCount(0);
  expect(await asked.locator(".ds-tool-call__status").evaluate((el) => getComputedStyle(el).color)).toBe(token("approval"));
  expect(await asked.locator(".ds-tool-call__status").evaluate((el) => getComputedStyle(el, "::before").maskImage), "the paused icon of Needs input").toContain("circle-pause");
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "the card came without a reload").toBe(true);

  // On the other screens the tray says it, and Work says which task waits.
  await openWork(page);
  await expect(page.getByRole("link", { name: "Needs input: task 1" })).toBeVisible();
  await expect(workState(workRows(page, "Task 1 · "))).toHaveText("Needs input");
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await checkWords(page, "work, with one request waiting");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u7-tray.png") });
  // Chat is a rebuilt screen: the request is named at its top, as a link to the task that waits. Back on Work, the tray.
  await goTo(page, "Chat");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Needs input: task 1" })).toBeVisible();
  await goTo(page, "Work");
  await expect(tray).toHaveText("1 approval is waiting. Open it.");

  // The tray is reachable by keyboard and opens the oldest pending card, on its task's screen.
  const open = tray.getByRole("link");
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card.getByRole("heading")).toHaveText("Claude Code asks to run a command");
  await expect(card.getByTestId("approval-command")).toHaveText("sh make-marker.sh");
  expect(await card.getByTestId("approval-command").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(MONO_FAMILY);
  await expect(card.getByTestId("approval-directory")).toHaveText("The top folder of the task's copy");
  // The screen is this task's: the card names neither the task nor the step.
  await expect(card.getByTestId("approval-role")).toHaveCount(0);
  await expect(card.getByTestId("approval-task")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run the command `sh make-marker.sh` with…");
  // The agent's own reason is shown when the CLI passed one on, and no row stands empty when it did not.
  const reason = card.getByTestId("approval-reason");
  if ((await reason.count()) > 0) expect(((await reason.textContent()) ?? "").trim().length).toBeGreaterThan(0);

  // Exactly two controls: Allow, the one primary action of this view, and Decline, plainly secondary, at the far end of the same row. No standing permission.
  // The design system's Approval draws them, with its labels, and marks both as never hidden.
  await expect(card.getByRole("button")).toHaveText(["Allow", "Decline"]);
  await expect(card.locator(".ds-approval__actions [data-ds-critical]")).toHaveCount(2);
  await expect(card.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
  await expect.poll(() => primaries(page), { message: "one primary action on the screen" }).toEqual(["Allow"]);
  await expect(page.getByRole("button", { name: /always|standing|every time|remember|pre-?approve/i })).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  // Allow is named Allowing while its answer is sent, and stays the same button.
  const allow = card.getByRole("button", { name: /^Allow(ing)?$/ });
  const decline = card.getByRole("button", { name: "Decline", exact: true });
  // What would run is marked as somebody else's words, so the screen's own wording rules do not read it.
  await expect(card.getByTestId("approval-command")).toHaveAttribute("data-ds-content", "");
  const look = (el: Element): { background: string; text: string; border: string } => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, text: style.color, border: style.borderTopColor };
  };
  expect(await allow.evaluate(look)).toEqual(PRIMARY_LOOK);
  expect(await decline.evaluate(look)).toEqual(SECONDARY_LOOK);
  const allowBox = (await allow.boundingBox())!;
  const declineBox = (await decline.boundingBox())!;
  expect(allowBox.y, "Allow and Decline share a row").toBe(declineBox.y);
  expect(declineBox.x - (allowBox.x + allowBox.width), "Decline is at the far end of the row, well away from Allow").toBeGreaterThanOrEqual(44);
  expect(allowBox.height).toBeGreaterThanOrEqual(44);
  expect(declineBox.height).toBeGreaterThanOrEqual(44);
  // A note for the agent is one step away, before the answers, closed until it is asked for, and neither answer hides in it.
  await expect(card.locator("summary")).toHaveText("Add a note for Claude Code");
  await expect(card.getByLabel("What Claude Code should do instead")).toBeHidden();
  await expect(card.locator("details button")).toHaveCount(0);
  await checkDesign(page, "task, with an approval card");
  if (SHOTS) await tallShot(page, path.join(SHOTS, "u7-approval-card.png"));

  // Nothing has run while the card waited. The full path and, while the task is worked on, its branch are in Details.
  const details = await openDetails(page);
  await expect(details.getByTestId("task-repo")).toHaveText(repo);
  const branch = (await details.getByTestId("branch").textContent())!;
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
  await expect(page.locator('[data-event="permission_resolved"]')).toContainText("You allowed");
  await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.", { timeout: 120_000 });
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("listitem")).toHaveCount(1);
  await expect(files.locator("summary").filter({ hasText: "marker.txt" })).toHaveText(/marker\.txt.*added.*\+1 line added.*−0 lines removed/);
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
  // The note is in a disclosure before the answers; the card's one Decline sends it. There is no second decline button.
  await card.getByText("Add a note for Claude Code").click();
  await card.getByLabel("What Claude Code should do instead").fill(note);
  await checkDesign(page, "task, an approval card with the note open");
  await expect(card.getByRole("button")).toHaveText(["Allow", "Decline"]);
  await expect(card).toHaveAttribute("data-settled", "");
  await card.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("approval-tray")).toBeEmpty();

  // The transcript says it was declined, with the note as text, and shows what the agent was told.
  const resolved = page.locator('[data-event="permission_resolved"]');
  await expect(resolved).toContainText("You denied it");
  // No row of its own for the asking: the call's line and the answer's row say it.
  await expect(page.locator('[data-event="permission_request"]')).toHaveCount(0);
  const refused = page.locator('[data-event="tool_call"]').filter({ hasText: "sh make-marker.sh" }).first().locator(".ds-tool-call");
  await expect(refused).toHaveAttribute("data-state", "declined");
  await expect(refused.locator(".ds-tool-call__title")).toHaveText(/^Denied\s*Did not run\s*sh make-marker\.sh$/);
  await expect(refused.locator(".ds-tool-call__note")).toHaveText("You denied this.");
  expect(await refused.locator(".ds-tool-call__status").evaluate((el) => getComputedStyle(el, "::before").maskImage), "a denied call's icon").toContain("ban");
  await expect(resolved).toContainText(`Your note: ${note}`);
  await expect(resolved.locator("b")).toHaveCount(0);
  await expect(page.locator('[data-event="tool_result"]').filter({ hasText: "The owner denied this request" })).toContainText("What Claude Code was told");
  // A build that changed no file ends as failed, saying so, for the owner to resume or discard (since builds that change nothing stop there).
  await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. Claude Code finished without changing any file\./, { timeout: 120_000 });
  await expect(page.locator('[data-event="turn_ended"]').locator("summary")).toHaveText(/^Worked for (\d+m )?\d+s$/);
  await checkDesign(page, "task, finished after a decline");

  const { branch } = (await (await page.request.get(`${botbench.base}/api/tasks/1`)).json()) as { branch: string };
  expect(git(repo, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean).sort()).toEqual(["README.md", "make-marker.sh"]);
  expect(git(path.join(botbench.home, "worktrees", branch.split("/").at(-2)!, "task-1"), "status", "--porcelain")).toBe("");
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);
});
