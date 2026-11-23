import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { checkoutState, initRepo } from "../test/support/repo.ts";
import { MONO_FAMILY, SECONDARY_LOOK, SHOTS, checkDesign, copyShot, expect, nav, openCanDo, openFromSettings, primaries, signIn, startTaskIn, test as base, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Standing permissions in the real client, at a phone's size: a real Botbench process whose settings offer standing
// permission after one approval, a real temporary repository, and the owner's Claude Code on its cheapest model
// asking for real. Two turns: one earns, grants and uses a standing permission; one asks for a command on the floor.

const MARKER_SCRIPT = '#!/bin/sh\necho ran >> "$(dirname "$0")/marker.txt"\n';
const COMMAND = "sh make-marker.sh";
const SCRIPT_PROMPT = `Run the command \`${COMMAND}\` with your Bash tool three times, one call at a time: wait for each result before you make the next call, and never put two in one command. Then reply with the single word: done`;
const PUSH_PROMPT = "Run the command `git push` with your Bash tool two times, one call at a time. It is expected to fail or be refused the first time: make the second call anyway, exactly the same. Do not try any other command. Then reply with the single word: done";
const BUILT = "Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.";

const test = base.extend<{ repo: string }>({
  repo: async ({}, use) => {
    const repo = path.join(tempDir("botbench-e2e-trust-"), "sample-repo");
    initRepo(repo, { "README.md": "# Sample\n", "make-marker.sh": MARKER_SCRIPT });
    await use(repo);
  },
  botbench: async ({ repo }, use) => {
    const botbench: Botbench = await startBotbench({ home: path.join(path.dirname(repo), "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, autonomy: { offerStandingAfter: 1 } } });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

async function startTask(page: Page, repo: string, prompt: string, id: number): Promise<void> {
  await startTaskIn(page, repo, prompt);
  await expect(page.getByTestId("task-name")).toHaveText(new RegExp(`^Task ${id} · `));
}

const shape = (list: Locator): Promise<string[]> => list.evaluate((el) => [el.tagName, ...new Set([...el.children].map((child) => child.tagName))]);
const api = async <B>(page: Page, botbench: Botbench, route: string): Promise<B> => (await (await page.request.get(`${botbench.base}${route}`)).json()) as B;

/** Wait for the card of approval `id`, which replaces the one before it, and for its buttons to come alive. */
async function cardOf(page: Page, id: number): Promise<Locator> {
  const card = page.getByTestId("approval-card");
  await expect(card).toHaveAttribute("data-approval-id", String(id), { timeout: 120_000 });
  await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
  return card;
}

test("Permissions starts empty in words, with nothing to tap and nothing in the tray", async ({ page, botbench }) => {
  await signIn(page, botbench);
  // Permissions is a screen of its own, reached from Settings, with a link back. With nothing granted and nothing logged it says so in words.
  await expect(nav(page).getByRole("link")).toHaveText(["Chat", "Work"]);
  await openFromSettings(page, "Permissions");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Always allowed", "Activity"]);
  await expect(page.getByRole("banner").getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "#/settings");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(0);
  await expect(page.getByTestId("grants-none")).toHaveText("Nothing is always allowed. After you have allowed the same command once, its request offers Always allow.");
  await expect(page.getByTestId("log-none")).toHaveText("Nothing has been asked, allowed or run yet.");
  await expect(page.getByTestId("grant-list")).toHaveCount(0);
  await expect(page.getByTestId("action-log")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("approval-tray")).toBeEmpty();
  await checkDesign(page, "trust, empty");
});

test("LIVE: a card for a command allowed before offers standing permission with its scope, as a secondary step that must be confirmed; granted, the command runs with no card; Trust lists the grant and the log, and Take back, once confirmed, removes it; a card for `git push` never offers", async ({ page, botbench, repo }) => {
  const foreign = watchRequests(page, botbench);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
  const tray = page.getByTestId("approval-tray");

  // The empty Permissions screen is drawn without a model: see "Permissions starts empty in words" above.

  // The first card for the command: nothing was allowed before, so it offers nothing.
  await startTask(page, repo, SCRIPT_PROMPT, 1);
  const first = await cardOf(page, 1);
  await expect(first.getByTestId("approval-command")).toHaveText(COMMAND);
  await expect(first.getByTestId("standing-offer")).toHaveCount(0);
  await expect(first.getByRole("button")).toHaveText(["Allow once", "Deny"]);
  await first.getByRole("button", { name: "Allow once", exact: true }).click();

  // The second card: the same command was allowed once, which is the configured number. It offers, below Allow.
  const card = await cardOf(page, 2);
  await expect(card.getByTestId("approval-command")).toHaveText(COMMAND);
  const offer = card.getByTestId("standing-offer");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("You have allowed this command once.");
  // What the button would cover is said before it is tapped.
  await expect(offer).toContainText("Always allow would cover this exact command, in the Build step, from this folder, in this repository. You confirm it first.");
  await expect(card.getByRole("button")).toHaveText(["Allow once", "Deny", "Always allow…"]);
  // The button has just come alive, and its colour takes the system's transition time to settle: the check waits for it.
  await expect.poll(() => primaries(page), { message: "Allow stays the one primary action" }).toEqual(["Allow once"]);
  const look = (el: Element): { background: string; text: string; border: string } => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, text: style.color, border: style.borderTopColor };
  };
  const open = offer.getByRole("button", { name: "Always allow…" });
  expect(await open.evaluate(look), "the offer is drawn as a secondary control").toEqual(SECONDARY_LOOK);
  const allowBox = (await card.getByRole("button", { name: "Allow once", exact: true }).boundingBox())!;
  const openBox = (await open.boundingBox())!;
  expect(openBox.y - (allowBox.y + allowBox.height), "the offer is set apart, below Allow").toBeGreaterThanOrEqual(24);
  await expect(card.getByTestId("standing-confirm")).toHaveCount(0);
  await checkDesign(page, "task, a card that offers standing permission");
  await copyShot(page, "approval-always-allow");

  // Opening the offer grants nothing: it states the scope in words and asks for a confirmation.
  await open.click();
  const confirm = card.getByTestId("standing-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("heading")).toHaveText(`Always allow ${COMMAND} in this project?`);
  await expect(confirm).toContainText("Botbench runs exactly this command without asking you");
  await expect(confirm).toContainText("A different argument still asks, and dangerous commands always ask.");
  await expect(confirm).toContainText("You can take it back on the Permissions screen.");
  await expect(confirm.getByTestId("standing-command")).toHaveText(COMMAND);
  expect(await confirm.getByTestId("standing-command").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(MONO_FAMILY);
  await expect(confirm.getByTestId("standing-repo")).toHaveText(repo);
  await expect(confirm.getByTestId("standing-directory")).toHaveText("The top folder of the task's copy");
  await expect(confirm.getByTestId("standing-role")).toHaveText("Build");
  await expect(confirm.getByRole("button")).toHaveText(["Always allow", "Cancel"]);
  // Focus starts on the button that changes nothing, so Enter cannot grant by accident.
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await primaries(page), "the confirmation is not a second primary action").toEqual(["Allow once"]);
  expect(await api(page, botbench, "/api/grants")).toEqual({ grants: [], offerStandingAfter: 1 });
  await checkDesign(page, "task, the standing permission confirmation");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u10-offer.png"), fullPage: true });

  // Escape closes it and grants nothing.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect(await api(page, botbench, "/api/grants")).toEqual({ grants: [], offerStandingAfter: 1 });
  await open.click();
  await expect(confirm).toBeVisible();

  // Cancel closes it and still grants nothing; the card waits as before.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveText(["Allow once", "Deny", "Always allow…"]);
  expect(await api(page, botbench, "/api/grants")).toEqual({ grants: [], offerStandingAfter: 1 });
  // The card is on this screen: the tray is not drawn, and only tells a screen reader, once, that the approval is here.
  await expect(tray).toHaveText("An approval is waiting on this screen.");

  // Confirming grants it and allows this request. The third run needs no card, and the transcript says why it ran.
  await open.click();
  await card.getByRole("button", { name: "Always allow", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(page.getByTestId("task-status")).toHaveText(BUILT, { timeout: 120_000 });
  await expect(tray).toBeEmpty();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  const resolved = page.locator('[data-event="permission_resolved"]');
  await expect(resolved).toHaveCount(3);
  await expect(resolved.nth(0)).toContainText("You allowed");
  await expect(resolved.nth(1)).toContainText("You allowed");
  await expect(resolved.nth(2)).toContainText("Always allowed");
  await expect(resolved.nth(2)).toContainText("allowed without asking you: you chose Always allow for this command");
  await expect(resolved.nth(2)).not.toContainText("You allowed");
  await expect(page.locator('[data-event="permission_request"]')).toHaveCount(0);
  await expect(await openCanDo(page)).toContainText("Every shell command waits for your answer first, unless you chose Always allow for it (see Permissions)");
  expect((await api<{ approvals: { status: string }[] }>(page, botbench, "/api/approvals")).approvals.map((a) => a.status)).toEqual(["allowed", "allowed"]);
  const branch = await page.getByTestId("branch").inputValue();
  expect(fs.readFileSync(path.join(botbench.home, "worktrees", branch.split("/")[1]!, "task-1", "marker.txt"), "utf8")).toBe("ran\nran\nran\n");
  await checkDesign(page, "task, finished on a standing permission");

  // A command on the safety floor: allowed once, its second card still offers nothing.
  await startTask(page, repo, PUSH_PROMPT, 2);
  const push = await cardOf(page, 3);
  await expect(push.getByTestId("approval-command")).toHaveText("git push");
  await expect(push.getByTestId("standing-offer")).toHaveCount(0);
  await push.getByRole("button", { name: "Allow once", exact: true }).click();
  const again = await cardOf(page, 4);
  await expect(again.getByTestId("approval-command")).toHaveText("git push");
  await expect(again.getByTestId("standing-offer")).toHaveCount(0);
  await expect(again.getByRole("button")).toHaveText(["Allow once", "Deny"]);
  await expect(page.getByRole("button", { name: /stop asking|standing|always|every time|remember/i })).toHaveCount(0);
  expect((await api<{ approvals: Record<string, unknown>[] }>(page, botbench, "/api/approvals?status=pending")).approvals.map((a) => [a.command, "standingOffer" in a])).toEqual([["git push", false]]);
  await checkDesign(page, "task, a card for a command on the safety floor");
  await again.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 120_000 });

  // Trust: the one standing permission, its scope in words and how often it was used.
  await openFromSettings(page, "Permissions");
  const grants = page.getByTestId("grant-list");
  await expect(grants.getByRole("listitem")).toHaveCount(1);
  expect(await shape(grants)).toEqual(["UL", "LI"]);
  const grant = grants.getByRole("listitem");
  await expect(grant.getByTestId("grant-command")).toHaveText(COMMAND);
  expect(await grant.getByTestId("grant-command").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(MONO_FAMILY);
  await expect(grant).toContainText("Claude Code runs this without asking you during the Build step.");
  await expect(grant).toContainText("The top folder of a task's copy");
  await expect(grant).toContainText(repo);
  await expect(grant).toContainText("in task 1");
  await expect(grant).toContainText("Used once");
  await expect(page.getByTestId("grants-none")).toHaveCount(0);

  // The action log, newest first: what was asked, decided and run, by which rule in words, for which task.
  const log = page.getByTestId("action-log");
  expect(await shape(log)).toEqual(["UL", "LI"]);
  const entries = log.getByRole("listitem");
  await expect(entries).toHaveText([
    /You denied.*git push.*Task 2/s,
    /Asked you.*git push.*Always asks: git-push.*Task 2/s,
    /You allowed.*git push.*Task 2/s,
    /Asked you.*git push.*Always asks: git-push.*Task 2/s,
    /Ran without asking: always allowed.*sh make-marker\.sh.*Task 1/s,
    /You chose Always allow.*sh make-marker\.sh.*Task 1/s,
    /You allowed.*sh make-marker\.sh.*Task 1/s,
    /Asked you.*sh make-marker\.sh.*Task 1/s,
    /You allowed.*sh make-marker\.sh.*Task 1/s,
    /Asked you.*sh make-marker\.sh.*Task 1/s,
  ]);
  // Ten entries are one page: nothing older, so no control for it.
  await expect(page.getByRole("button", { name: "Show older activity" })).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveText(["Take back"]);
  expect(await primaries(page), "Trust has no primary action").toEqual([]);
  await checkDesign(page, "trust, with a standing permission and the log");
  await copyShot(page, "permissions");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u10-trust.png"), fullPage: true });

  // Take back asks first, in words; keeping it changes nothing.
  await grant.getByRole("button", { name: "Take back" }).click();
  const sure = grant.getByTestId("take-back-confirm");
  await expect(sure.getByRole("heading")).toHaveText("Stop always allowing this command?");
  await expect(sure).toContainText("The next time this command is asked for, Botbench asks you again.");
  await expect(sure).toContainText(COMMAND);
  // The button that changes nothing comes first and has the focus; neither is a primary action.
  await expect(sure.getByRole("button")).toHaveText(["Keep it", "Take it back"]);
  await expect(sure.getByRole("button", { name: "Keep it" })).toBeFocused();
  expect((await api<{ grants: unknown[] }>(page, botbench, "/api/grants")).grants.length).toBe(1);
  await checkDesign(page, "trust, the take back confirmation");
  await grant.getByRole("button", { name: "Keep it" }).click();
  await expect(sure).toHaveCount(0);
  await expect(grants.getByRole("listitem")).toHaveCount(1);
  expect((await api<{ grants: unknown[] }>(page, botbench, "/api/grants")).grants.length).toBe(1);

  // Confirmed: the grant leaves the list, the log says so first, and the older entry is one tap away.
  await grant.getByRole("button", { name: "Take back" }).click();
  await grant.getByRole("button", { name: "Take it back" }).click();
  await expect(page.getByTestId("grant-list")).toHaveCount(0);
  await expect(page.getByTestId("grants-none")).toBeVisible();
  expect(await api(page, botbench, "/api/grants")).toEqual({ grants: [], offerStandingAfter: 1 });
  await expect(entries).toHaveCount(10);
  await expect(entries.first()).toHaveText(/You took Always allow back.*sh make-marker\.sh/s);
  const older = page.getByRole("button", { name: "Show older activity" });
  await expect(older).toBeVisible();
  await older.click();
  await expect(entries).toHaveCount(11);
  await expect(entries.last()).toHaveText(/Asked you.*sh make-marker\.sh.*Task 1/s);
  await expect(older).toHaveCount(0);
  await checkDesign(page, "trust, after taking back");

  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "all of it without a reload").toBe(true);
  expect(foreign, "requests to anything but Botbench").toEqual([]);
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});
