import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { botbenchBranches, checkoutState, initRepo, worktreeCount } from "../test/support/repo.ts";
import { checkDesign, expect, nav, openDetails, openFromSettings, openWork, pageMode, SHOTS, signIn, tallShot, test, THEME_COLOR, token, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The runs board, Settings and the appearance choice in the real client, at a phone's size: a real Botbench process,
// real temporary repositories, and, for the tests marked LIVE, the owner's Claude Code on its cheapest model. A run's
// plan comes from a real planner turn; a failed task comes from a repository whose real setup command fails.

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

const selector = (page: Page) => page.getByRole("group", { name: "Show" });
const group = (page: Page) => page.getByTestId("board-group");

const openBoard = openWork;

async function openSettings(page: Page): Promise<void> {
  // Settings is the header's action, on every signed-in screen: the tab bar keeps to the app's main destinations.
  await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

/** Sign in where Claude Code cannot be used: the Chat screen then says why instead of offering a prompt. */
async function signInAnyway(page: Page, botbench: Botbench): Promise<void> {
  await page.goto(botbench.base);
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toHaveText(/^Claude Code: /);
}

const primaryControls = (page: Page) => page.locator("main .ds-button--primary");

test("with no runs and no tasks, the board is the first-run state, in words, with one primary action: New run", async ({ page, botbench }) => {
  const foreign = watchRequests(page, botbench);
  await signIn(page, botbench);
  await openBoard(page);
  const empty = page.getByTestId("board-empty");
  await expect(empty.getByRole("heading", { name: "No work yet" })).toBeVisible();
  await expect(empty).toContainText("A task you start from Chat, and a run with its plan of tasks, is listed here.");
  await expect(primaryControls(page)).toHaveCount(1);
  await expect(empty.getByRole("link", { name: "New run" })).toHaveClass(/ds-button--primary/);
  // An empty board shows no group selector: there is nothing to choose between.
  await expect(selector(page)).toHaveCount(0);
  await checkDesign(page, "board, empty");
  await shot(page, "u16-board-empty.png");
  await empty.getByRole("link", { name: "New run" }).click();
  await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeAttached();
  // New run came to work in a repository: the sheet opens on Repository, and Send waits for one.
  await expect(page.locator("dialog.ds-sheet").getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a Repository" })).toBeAttached();
  expect(foreign).toEqual([]);
});

test("with Claude Code signed out, the empty board says why and links to Settings, which shows the agent signed out", async ({ page }) => {
  // The real CLI, pointed at an empty configuration directory, reports itself signed out.
  const empty = tempDir("botbench-e2e-claude-config-");
  const botbench = await startBotbench({ env: { CLAUDE_CONFIG_DIR: empty } });
  try {
    await signInAnyway(page, botbench);
    await openBoard(page);
    const state = page.getByTestId("board-empty");
    await expect(state.getByRole("heading", { name: "Claude Code cannot be used yet" })).toBeVisible();
    await expect(state).toContainText("Claude Code is signed out. Run `claude auth login` in a terminal.");
    await expect(primaryControls(page)).toHaveCount(1);
    await expect(state.getByRole("link", { name: "Open settings" })).toHaveClass(/ds-button--primary/);
    await expect(page.getByRole("link", { name: "New run" })).toHaveCount(0);
    await checkDesign(page, "board, empty, Claude Code signed out");
    await shot(page, "u16-board-signed-out.png");
    await state.getByRole("link", { name: "Open settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    const agent = page.getByTestId("agent-claude-code");
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out");
    await expect(agent).toContainText("Claude Code is signed out. Run `claude auth login` in a terminal.");
    await checkDesign(page, "settings, Claude Code signed out");
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("Settings lists each agent Botbench has, as the real probe reports it, and no other", async ({ page, botbench }) => {
  await signIn(page, botbench);
  await openSettings(page);
  const probe = (await (await page.request.get(`${botbench.base}/api/driver`)).json()) as { version: string; signedIn: boolean; billing: string };
  expect(probe.signedIn, "this machine's Claude Code is signed in").toBe(true);
  // The agents the server really registers, as it lists them: one row each, and no other.
  const listed = ((await (await page.request.get(`${botbench.base}/api/agents`)).json()) as { agents: { agent: string; version: string | null; problem: string | null }[] }).agents;
  expect(listed.map((found) => found.agent), "Claude Code, the agent that builds, is listed").toContain("claude-code");
  const agents = page.getByRole("group", { name: "Agents" });
  await expect(agents.locator(".ds-settings-row")).toHaveCount(listed.length);
  for (const found of listed) await expect(agents.getByTestId(`agent-${found.agent}`)).toHaveCount(1);
  const agent = page.getByTestId("agent-claude-code");
  await expect(agent.getByTestId("agent-state")).toHaveText("Available");
  await expect(agent).toContainText(`Version ${probe.version}.`);
  await expect(agent).toContainText(probe.billing === "subscription" ? "Signed in with a subscription." : "Signed in.");
  // Codex, as its own probe reports it, and what it does here.
  const codex = listed.find((found) => found.agent === "codex")!;
  const codexRow = page.getByTestId("agent-codex");
  await expect(codexRow.getByTestId("agent-state")).toHaveText(codex.problem === null ? "Available" : /Signed out|Not installed|Unsupported version|Unavailable/);
  await expect(codexRow).toContainText(codex.problem ?? `Version ${codex.version}.`);
  if (codex.problem === null) await expect(codexRow).toContainText("Reviews a run's tasks when you choose it for a run; it cannot plan or build here.");
  // Grok and Antigravity, each with the state its own probe reports.
  for (const key of ["grok", "antigravity"]) await expect(page.getByTestId(`agent-${key}`).getByTestId("agent-state")).toHaveText(/^(Available|Signed out|Not installed|Unsupported version|Unavailable)$/);
  await expect(page.getByText("Gemini CLI")).toHaveCount(0);
  // Settings is no tab: the tab bar keeps its two destinations. Its first rows lead to Permissions and Usage.
  await expect(page.locator(".ds-tab-bar__item")).toHaveText(["Chat", "Work"]);
  await expect(page.locator('.ds-tab-bar__item[aria-current="page"]')).toHaveCount(0);
  await expect(page.getByTestId("settings-links").getByRole("link")).toHaveText([/^Permissions/, /^Usage/]);
  expect(await page.getByTestId("settings-links").locator("svg use").evaluateAll((uses) => uses.map((use) => use.getAttribute("href")!.split("#")[1])), "each row ends with a chevron").toEqual(["ds-icon-chevron-right", "ds-icon-chevron-right"]);
  await checkDesign(page, "settings");
  await shot(page, "u16-settings.png");
});

test("Appearance: Light changes the page, its browser bar and its logo (which follows the text colour), is remembered on this device and drawn before the client starts; Match device follows the device; Dark is the default", async ({ page, botbench }) => {
  await signIn(page, botbench);
  const root = page.locator("html");
  const bar = page.locator('meta[name="theme-color"]');
  const mark = page.getByRole("banner").locator("svg[aria-hidden=\"true\"]").first();
  const markFill = () => mark.evaluate((svg) => getComputedStyle(svg.querySelector("path")!).fill);
  const nameColour = () => page.locator(".ds-app-header__name").evaluate((a) => getComputedStyle(a).color);
  // The default: dark, said on the root, never left out: without the attribute the page's color-scheme stays light and
  // native controls and scrollbars would be drawn for a light page.
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await root.evaluate((el) => getComputedStyle(el).colorScheme)).toBe("dark");
  await expect(bar).toHaveAttribute("content", THEME_COLOR.dark);
  expect(await markFill(), "the mark is drawn in the text colour, dark").toBe(await nameColour());
  const darkFill = await markFill();
  // After a change of mode: the mark is in the text colour again, and it is no longer the dark mode's.
  const followsText = async () => (await markFill()) === (await nameColour()) && (await markFill()) !== darkFill;

  await openSettings(page);
  const mode = page.getByLabel("Mode");
  await expect(mode).toHaveValue("dark");
  await mode.selectOption("light");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAttribute("content", THEME_COLOR.light);
  await expect.poll(followsText, { message: "the mark is drawn in the light mode's text colour, not the dark mode's" }).toBe(true);
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(token("surface", "light"));
  expect(await root.evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");
  expect(await pageMode(page)).toBe("light");
  await checkDesign(page, "settings, light");
  await shot(page, "u16-settings-light.png");

  // Remembered on this device: after a reload the page is light before the client's script has run. The script is held
  // back here, so whatever is drawn meanwhile is the page's own first paint.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: "commit" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(bar).toHaveAttribute("content", THEME_COLOR.light);
  await expect(page.locator("#root")).toBeEmpty();
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor), "the first paint is light").toBe(token("surface", "light"));
  release();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByLabel("Mode")).toHaveValue("light");

  // Match device follows the device's own setting, and its changes while the page is open.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByLabel("Mode").selectOption("auto");
  await expect(root).toHaveAttribute("data-theme", "auto");
  await expect(bar).toHaveAttribute("content", THEME_COLOR.dark);
  await expect.poll(markFill, { message: "the mark follows the device back to dark" }).toBe(darkFill);
  expect(await pageMode(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(bar).toHaveAttribute("content", THEME_COLOR.light);
  await expect.poll(followsText, { message: "the mark follows the device to light" }).toBe(true);
  expect(await pageMode(page)).toBe("light");
  await checkDesign(page, "settings, match device, light");

  // Dark again: said on the root, and remembered too.
  await page.getByLabel("Mode").selectOption("dark");
  await expect(bar).toHaveAttribute("content", THEME_COLOR.dark);
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByLabel("Mode")).toHaveValue("dark");
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await root.evaluate((el) => getComputedStyle(el).colorScheme)).toBe("dark");
  await checkDesign(page, "settings, dark");
});

test("LIVE: the board puts runs in their groups and moves them live, without a reload, and the selector switches the group shown", async ({ page, botbench }) => {
  test.setTimeout(300_000);
  const foreign = watchRequests(page, botbench);
  const repo = path.join(path.dirname(botbench.home), "board-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await openBoard(page);
  await expect(page.getByTestId("board-empty")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { botbenchSamePage: boolean }).botbenchSamePage = true));

  // Two runs: the first is planned now by Claude Code; the second waits for it, one planner at a time.
  const start = async (prompt: string): Promise<number> => ((await (await page.request.post(`${botbench.base}/api/runs`, { data: { repo, prompt, preapproved: [] } })).json()) as { runId: number }).runId;
  const planned = await start("Add a file hello.txt that holds the word hi. Make it one task. Do not run any command.");
  const cancelled = await start("Add a file bye.txt that holds the word bye.");
  await expect(selector(page)).toBeVisible();
  await expect(selector(page).getByLabel(/^Running/)).toBeChecked();
  await expect(group(page).getByRole("link")).toHaveCount(2);
  await expect(selector(page)).toContainText("Running (2)");

  // Cancelling the queued one moves it to Finished, live.
  await page.request.post(`${botbench.base}/api/runs/${cancelled}/cancel`, { data: {} });
  await expect(selector(page)).toContainText("Finished (1)");
  await expect(selector(page)).toContainText("Running (1)");

  // The planner's plan, or a request it makes, needs the owner: the run moves to Needs you, live.
  await expect(selector(page)).toContainText("Needs you (1)", { timeout: 180_000 });
  await expect(selector(page)).toContainText("Running (0)");

  await selector(page).getByRole("radio", { name: /^Needs you/ }).check();
  await expect(selector(page).getByLabel(/^Needs you/)).toBeChecked();
  const row = group(page).getByRole("link");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("href", `#/runs/${planned}`);
  await expect(row.locator(".ds-badge")).toHaveText(/^(Plan ready for review|Needs input)$/);
  await checkDesign(page, "board, needs you");
  await shot(page, "u16-board-needs-you.png");

  await selector(page).getByRole("radio", { name: /^Running/ }).check();
  await expect(group(page).getByRole("link")).toHaveCount(0);
  await expect(group(page)).toHaveText("Nothing is running.");
  await checkDesign(page, "board, running, none");

  await selector(page).getByRole("radio", { name: /^Finished/ }).check();
  await expect(group(page).getByRole("link")).toHaveCount(1);
  await expect(group(page).getByRole("link")).toHaveAttribute("href", `#/runs/${cancelled}`);
  await expect(group(page).locator(".ds-badge")).toHaveText("Cancelled");
  await checkDesign(page, "board, finished");
  await shot(page, "u16-board-finished.png");

  expect(await page.evaluate(() => (window as unknown as { botbenchSamePage?: boolean }).botbenchSamePage), "everything came without a reload").toBe(true);
  expect(foreign).toEqual([]);
});

test("Discard: a task whose setup failed keeps its copy and branch until the owner discards them; the dialog names the files that are not on the branch, and the board lists the task as finished", async ({ page }) => {
  const dir = tempDir("botbench-e2e-discard-");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { setup: ["echo prepared > setup-output.txt; echo it broke; exit 1"] } } } });
  try {
    const before = checkoutState(repo);
    await signIn(page, botbench);
    const taskId = ((await (await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt: "Create hello.txt", preapproved: [] } })).json()) as { taskId: number }).taskId;
    await page.goto(`${botbench.base}/#/tasks/${taskId}`);
    await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. /);
    const task = (await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { branch: string };
    expect(botbenchBranches(repo)).toEqual([task.branch]);
    expect(worktreeCount(repo)).toBe(2);
    // The task is titled by its own words and its repository by name; the full path and the branch are in Details, closed.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create hello.txt");
    await expect(page.getByTestId("task-name")).toHaveText(`Task ${taskId} · repo`);
    await expect(page.getByTestId("task-details")).not.toHaveAttribute("open");
    await expect(page.getByTestId("task-repo")).toBeHidden();
    const details = await openDetails(page);
    await expect(details.getByTestId("task-repo")).toHaveText(repo);
    await expect(details.getByTestId("branch")).toHaveText(task.branch);
    await expect(page.getByTestId("branch")).toHaveCount(1);
    const discard = page.getByRole("button", { name: "Discard" });
    await expect(discard).toBeVisible();
    await expect(discard).not.toHaveClass(/ds-button--primary/);
    await checkDesign(page, "task, failed, with its copy and branch");
    await shot(page, "u16-task-discard.png");

    await discard.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByTestId("leftovers").getByRole("listitem")).toHaveText(["setup-output.txt"]);
    await expect(dialog).toContainText(task.branch);
    await checkDesign(page, "discard dialog");
    await shot(page, "u16-discard-dialog.png");
    await dialog.getByRole("button", { name: "Keep them" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(botbenchBranches(repo)).toEqual([task.branch]);

    await discard.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("discarded")).toHaveText("Discarded. Nothing of this task is left: its copy of the project and its branch are gone, with the work on them. Nothing was merged or pushed.");
    await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(page.getByTestId("branch")).toHaveCount(0);
    await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. /);
    await checkDesign(page, "task, failed, discarded");
    expect(botbenchBranches(repo)).toEqual([]);
    expect(worktreeCount(repo)).toBe(1);
    expect(checkoutState(repo)).toEqual(before);

    // The Activity list says what the owner did.
    await openFromSettings(page, "Permissions");
    await expect(page.getByText("You discarded")).toBeVisible();

    // A stand-alone task is a run of one: it is on the board, under Finished.
    await openBoard(page);
    await expect(selector(page).getByLabel(/^Finished/)).toBeChecked();
    await expect(group(page).getByRole("link")).toHaveAttribute("href", `#/tasks/${taskId}`);
    await expect(group(page).locator(".ds-badge")).toHaveText("Failed");
    await checkDesign(page, "board, a stand-alone task that failed");
    await shot(page, "work.png");
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in light mode, sign-in and Settings are drawn in the light colours", async ({ page, botbench }) => {
  // The owner chose Light on this device before: the choice is on the device, so it holds before sign-in too.
  await page.goto(botbench.base);
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Login token")).toBeVisible();
  await checkDesign(page, "sign-in, light");
  await shot(page, "u16-light-sign-in.png");
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeEnabled();
  await openSettings(page);
  await checkDesign(page, "settings, light");
  await shot(page, "u16-light-settings.png");
});

test("LIVE: in light mode, a chat with a tool call, an approval card, a task ready for review and the board are drawn in the light colours", async ({ page, botbench }) => {
  test.setTimeout(420_000);
  const repo = path.join(path.dirname(botbench.home), "light-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  fs.writeFileSync(path.join(botbench.home, "scratch", "notes.txt"), "The word is heron.\n");
  // The owner chose Light on this device before: the choice is on the device, so it holds before sign-in too.
  await page.goto(botbench.base);
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await signIn(page, botbench);

  await page.getByLabel("Message Claude Code").fill("Use your Read tool exactly once to read the file notes.txt in the current directory. Then reply with only the word that file names.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="turn_ended"]')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('[data-event="tool_call"]').first()).toContainText("notes.txt");
  await checkDesign(page, "chat with a tool call, light");
  await shot(page, "u16-light-chat.png");

  const taskId = ((await (await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt: "Run the command `echo hi > hello.txt` with your Bash tool, exactly once. Then reply with the single word: done", preapproved: [] } })).json()) as { taskId: number }).taskId;
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await checkDesign(page, "approval card, light");
  await shot(page, "u16-light-approval.png");
  await openBoard(page);
  await expect(selector(page).getByLabel(/^Needs you/)).toBeChecked();
  await expect(group(page).locator(".ds-badge")).toHaveText("Needs input");
  await checkDesign(page, "board, a task waiting on an approval, light");
  await shot(page, "u16-light-board.png");
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);
  await page.getByTestId("approval-card").getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 120_000 });
  await checkDesign(page, "task ready for review, light");
  await shot(page, "u16-light-ready.png");
});
