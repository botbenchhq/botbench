import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { appendLog } from "../src/approvals/broker.ts";
import { insertStanding, realRepo } from "../src/approvals/grants.ts";
import { createTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { checkoutState, initRepo } from "../test/support/repo.ts";
import { MONO_FAMILY, SECONDARY_LOOK, SHOTS, askBeforeEveryCommand, checkDesign, copyShot, expect, nav, openCanDo, openFromSettings, primaries, signIn, startTaskIn, test as base, watchRequests } from "./helpers.ts";
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
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

async function startTask(page: Page, repo: string, prompt: string, id: number): Promise<void> {
  await startTaskIn(page, repo, prompt);
  await expect(page.getByTestId("task-name")).toHaveText(new RegExp(`^Task ${id} · `));
}

const shape = (list: Locator): Promise<string[]> => list.evaluate((el) => [el.tagName, ...new Set([...el.children].map((child) => child.tagName))]);
const api = async <B>(page: Page, botbench: Botbench, route: string): Promise<B> => (await (await page.request.get(`${botbench.base}${route}`)).json()) as B;

/** Wait for the card of approval `id`, which replaces the one before it, and for it to settle, after which a press counts. */
async function cardOf(page: Page, id: number): Promise<Locator> {
  const card = page.getByTestId("approval-card");
  await expect(card).toHaveAttribute("data-approval-id", String(id), { timeout: 120_000 });
  await expect(card).toHaveAttribute("data-settled", "");
  return card;
}

test("Permissions starts empty in words, with nothing to tap and nothing in the tray", async ({ page, botbench }) => {
  await signIn(page, botbench);
  // Permissions is a screen of its own, reached from Settings, with a link back. With nothing granted and nothing logged it says so in words.
  await expect(nav(page).getByRole("link")).toHaveText(["Home", "Work", "Chat"]);
  await openFromSettings(page, "Permissions");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Always allowed", "Check a command", "Activity"]);
  await expect(page.getByRole("banner").getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "#/settings");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(0);
  await expect(page.getByTestId("grants-none")).toHaveText("Nothing is always allowed. After you have allowed the same command once, its request offers Always allow.");
  await expect(page.getByTestId("log-none")).toHaveText("Nothing has been asked, allowed or run yet.");
  await expect(page.getByTestId("grant-list")).toHaveCount(0);
  await expect(page.getByTestId("action-log")).toHaveCount(0);
  // The one control is the command check's, which changes nothing; with no repository known its picker says so.
  await expect(page.getByRole("button")).toHaveText(["Check"]);
  await expect(page.getByTestId("check-repository")).toBeDisabled();
  await expect(page.getByTestId("check-repository")).toHaveText("No repository yet");
  await expect(page.getByTestId("approval-tray")).toBeEmpty();
  await checkDesign(page, "trust, empty");
});

test("Check a command answers for each mode in words, the rule behind each named, and changes nothing, at a phone's width and a desktop's, light and dark", async ({ page }) => {
  // A repository named in the settings file, which offers `npm test` as an allowed command for each task.
  const dir = tempDir("botbench-e2e-check-");
  const repo = path.join(dir, "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { preapproved: ["npm test"] } } } });
  try {
    const foreign = watchRequests(page, botbench);
    await signIn(page, botbench);
    await openFromSettings(page, "Permissions");
    const picker = page.getByTestId("check-repository");
    await expect(picker).toBeEnabled();
    await expect(picker).toHaveValue(fs.realpathSync(repo));
    const box = page.getByTestId("check-command");
    const result = page.getByTestId("check-result");
    const run = async (command: string): Promise<void> => {
      await box.fill(command);
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(result).toBeVisible();
    };

    await run("git push");
    await expect(result.getByRole("listitem")).toHaveText([
      "ManualAsks you. On the always-ask list: it sends commits to another computer. Rule: git-push",
      "Semi-autonomousAsks you. On the always-ask list: it sends commits to another computer. Rule: git-push",
      "Fully autonomousRefused: a fully autonomous run asks you nothing, so what would ask is not run. On the always-ask list: it sends commits to another computer. Rule: git-push",
    ]);
    expect(await primaries(page), "the check is no primary action").toEqual([]);
    await checkDesign(page, "trust, a command that asks, dark");

    // A new command clears the old answer until it is checked.
    await box.fill("npm test");
    await expect(result).toHaveCount(0);
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(result.getByRole("listitem")).toHaveText(Array(3).fill(/Runs without asking: this repository's settings offer npm test as an allowed command for each task\.$/));

    // A command of two lines is checked as it would run, line break and all: its second line is on the always-ask list.
    await run("true\ngit push");
    await expect(box).toHaveValue("true\ngit push");
    await expect(result.getByRole("listitem")).toHaveText(Array(3).fill(/Rule: git-push$/));

    // An empty command is refused in words, with no answer.
    await box.fill("");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Give a command to check.");
    await expect(result).toHaveCount(0);
    // The reason is about the command it was given: typing another clears it, and the box is no longer marked.
    await box.fill("ls");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(box).not.toHaveAttribute("aria-invalid", "true");

    // Light, at a phone's width and a desktop's.
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await run("git push");
    await checkDesign(page, "trust, a command that asks, light");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(result).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `nothing runs off the side at ${width}px`).toBe(true);
      await checkDesign(page, `trust, a command that asks, light, ${width}px`);
    }
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
    // Loaded again at a phone's width, then widened, as the light pass does.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await run("ls src");
    await expect(result.getByRole("listitem")).toHaveText(Array(3).fill(/Runs without asking: it runs kept in the task's copy, and the safety rules do not name it\.$/));
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(result).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `nothing runs off the side at ${width}px, dark`).toBe(true);
      await checkDesign(page, `trust, a command that runs, dark, ${width}px`);
    }

    // Nothing was asked, logged or granted.
    expect(await (await page.request.get(`${botbench.base}/api/approvals`)).json()).toEqual({ approvals: [] });
    expect(await (await page.request.get(`${botbench.base}/api/action-log`)).json()).toEqual({ entries: [] });
    expect(await (await page.request.get(`${botbench.base}/api/grants`)).json()).toMatchObject({ grants: [] });
    expect(foreign, "requests to anything but Botbench").toEqual([]);
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Take back stays focused and busy while it is sent, and the focus then goes to the row that took its place, or to the heading when none is left", async ({ page }) => {
  // No model turn: three commands are always allowed before Botbench starts, each written with its log row as the broker writes one.
  const dir = tempDir("botbench-e2e-take-back-");
  const repo = path.join(dir, "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  const home = path.join(dir, "home");
  const db = openStore(home);
  const task = createTask(db, { repo, prompt: "Tidy the README" });
  for (const words of [["npm", "test"], ["npm", "run", "lint"], ["make", "build"]]) {
    const grantId = insertStanding(db, { role: "implementer", repo: realRepo(repo), cwd: ".", words, taskId: task.id });
    appendLog(db, { taskId: task.id, runId: task.runId, attemptId: null, grantId, rule: "standing_granted", tool: "Bash", command: words.join(" "), cwd: "." });
  }
  db.close();
  const botbench = await startBotbench({ home });
  try {
    await signIn(page, botbench);
    await openFromSettings(page, "Permissions");
    const rows = page.getByTestId("grant-list").getByRole("listitem");
    await expect(rows.getByTestId("grant-command")).toHaveText(["npm test", "npm run lint", "make build"]);

    // While the request is held, the pressed button says Taking back and still names its command, is busy, stays enabled and keeps the focus the closing dialog gave back to it.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/grants\/\d+\/revoke$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.getByRole("button", { name: "Take back npm run lint" }).click();
    await page.getByTestId("take-back-confirm").getByRole("button", { name: "Take it back" }).click();
    const taking = rows.nth(1).getByRole("button", { name: "Taking back npm run lint", exact: true });
    await expect(taking).toHaveAttribute("aria-busy", "true");
    await expect(taking).toHaveText("Taking back npm run lint");
    await expect(taking).toBeEnabled();
    await expect(taking).toBeFocused();
    // A second press is ignored: no dialog opens.
    await taking.press("Enter");
    await expect(page.getByTestId("take-back-confirm")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Take back npm test" })).toBeDisabled();
    await checkDesign(page, "trust, taking back");
    await expect(taking).toBeFocused();

    // Until the list is read again the row stays, and its button stays busy: the request is held here to see it.
    let read = (): void => {};
    const reading = new Promise<void>((resolve) => (read = resolve));
    await page.route(/\/api\/grants$/, async (route) => {
      await reading;
      await route.continue();
    });
    const asked = page.waitForRequest(/\/api\/grants$/);
    release();
    await asked;
    await expect(rows).toHaveCount(3);
    await expect(taking).toHaveAttribute("aria-busy", "true");
    await taking.press("Enter");
    await expect(page.getByTestId("take-back-confirm")).toHaveCount(0);
    read();
    // The row is gone, and the focus is on the row that took its place.
    await expect(rows.getByTestId("grant-command")).toHaveText(["npm test", "make build"]);
    await page.unroute(/\/api\/grants$/);
    await page.unroute(/\/api\/grants\/\d+\/revoke$/);
    await expect(page.getByRole("button", { name: "Take back make build" })).toBeFocused();
    // The last row gone: the row before it.
    await page.getByRole("button", { name: "Take back make build" }).click();
    await page.getByTestId("take-back-confirm").getByRole("button", { name: "Take it back" }).click();
    await expect(rows.getByTestId("grant-command")).toHaveText(["npm test"]);
    await expect(page.getByRole("button", { name: "Take back npm test" })).toBeFocused();
    // None left: the section's heading.
    await page.getByRole("button", { name: "Take back npm test" }).click();
    await page.getByTestId("take-back-confirm").getByRole("button", { name: "Take it back" }).click();
    await expect(page.getByTestId("grants-none")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Always allowed" })).toBeFocused();
    await checkDesign(page, "trust, nothing left after Take back");
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LIVE: a card for a command allowed before offers standing permission with its scope, as a secondary step that must be confirmed; granted, the command runs with no card; Trust lists the grant and the log, and Take back, once confirmed, removes it; a card for `git push` never offers", async ({ page, botbench, repo }) => {
  const foreign = watchRequests(page, botbench);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  // A command kept inside the task's copy runs without a card by default; standing permission is earned on cards.
  await askBeforeEveryCommand(page, botbench);
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
  const tray = page.getByTestId("approval-tray");

  // The empty Permissions screen is drawn without a model: see "Permissions starts empty in words" above.

  // The first card for the command: nothing was allowed before, so it offers nothing.
  await startTask(page, repo, SCRIPT_PROMPT, 1);
  const first = await cardOf(page, 1);
  await expect(first.getByTestId("approval-command")).toHaveText(COMMAND);
  await expect(first.getByTestId("standing-offer")).toHaveCount(0);
  await expect(first.getByRole("button")).toHaveText(["Allow", "Decline"]);
  await first.getByRole("button", { name: "Allow", exact: true }).click();

  // The second card: the same command was allowed once, which is the configured number. It offers, set apart above the answers, which end the card.
  const card = await cardOf(page, 2);
  await expect(card.getByTestId("approval-command")).toHaveText(COMMAND);
  const offer = card.getByTestId("standing-offer");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("You have allowed this command once.");
  // What the button would cover is said before it is tapped.
  await expect(offer).toContainText("Always allow would cover this exact command, in the Build step, from this folder, in this repository. You confirm it first.");
  await expect(card.getByRole("button")).toHaveText(["Always allow…", "Allow", "Decline"]);
  await expect.poll(() => primaries(page), { message: "Allow stays the one primary action" }).toEqual(["Allow"]);
  const look = (el: Element): { background: string; text: string; border: string } => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, text: style.color, border: style.borderTopColor };
  };
  const open = offer.getByRole("button", { name: "Always allow…" });
  expect(await open.evaluate(look), "the offer is drawn as a secondary control").toEqual(SECONDARY_LOOK);
  const allowBox = (await card.getByRole("button", { name: "Allow", exact: true }).boundingBox())!;
  const openBox = (await open.boundingBox())!;
  expect(allowBox.y - (openBox.y + openBox.height), "the offer is set apart, above Allow").toBeGreaterThanOrEqual(24);
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
  expect(await primaries(page), "the confirmation is not a second primary action").toEqual(["Allow"]);
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
  await expect(card.getByRole("button")).toHaveText(["Always allow…", "Allow", "Decline"]);
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
  await expect(await openCanDo(page)).toContainText("with Ask before every command on in Settings, every one waits for your answer first, unless you chose Always allow for it (see Permissions)");
  expect((await api<{ approvals: { status: string }[] }>(page, botbench, "/api/approvals")).approvals.map((a) => a.status)).toEqual(["allowed", "allowed"]);
  const branch = (await page.getByTestId("branch").textContent())!;
  expect(fs.readFileSync(path.join(botbench.home, "worktrees", branch.split("/").at(-2)!, "task-1", "marker.txt"), "utf8")).toBe("ran\nran\nran\n");
  await checkDesign(page, "task, finished on a standing permission");

  // A command on the safety floor: allowed once, its second card still offers nothing.
  await startTask(page, repo, PUSH_PROMPT, 2);
  const push = await cardOf(page, 3);
  await expect(push.getByTestId("approval-command")).toHaveText("git push");
  await expect(push.getByTestId("standing-offer")).toHaveCount(0);
  await push.getByRole("button", { name: "Allow", exact: true }).click();
  const again = await cardOf(page, 4);
  await expect(again.getByTestId("approval-command")).toHaveText("git push");
  await expect(again.getByTestId("standing-offer")).toHaveCount(0);
  await expect(again.getByRole("button")).toHaveText(["Allow", "Decline"]);
  await expect(page.getByRole("button", { name: /stop asking|standing|always|every time|remember/i })).toHaveCount(0);
  expect((await api<{ approvals: Record<string, unknown>[] }>(page, botbench, "/api/approvals?status=pending")).approvals.map((a) => [a.command, "standingOffer" in a])).toEqual([["git push", false]]);
  await checkDesign(page, "task, a card for a command on the safety floor");
  await again.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  // Nothing was pushed or changed, so the task ends as failed, saying so.
  await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. Claude Code finished without changing any file\./, { timeout: 120_000 });

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
  await expect(page.getByRole("button")).toHaveText(["Take back", "Check"]);
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
