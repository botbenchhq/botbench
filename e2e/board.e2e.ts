import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { botbenchBranches, checkoutState, initRepo, worktreeCount } from "../test/support/repo.ts";
import { askBeforeEveryCommand, checkDesign, checkWords, expect, nav, openDetails, openFromSettings, openWork, pageMode, SHOTS, signIn, tallShot, test, THEME_COLOR, token, watchRequests, workRows, workState, workStateFilter } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Work as the runs board (its own tests are e2e/work.e2e.ts and e2e/home.e2e.ts), Settings and the appearance choice in the real client, at a phone's size: a real Botbench process,
// real temporary repositories, and, for the tests marked LIVE, the owner's Claude Code on its cheapest model. A run's
// plan comes from a real planner turn; a failed task comes from a repository whose real setup command fails.

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

const openBoard = openWork;

async function openSettings(page: Page): Promise<void> {
  // Settings is the header's action, on every signed-in screen: the tab bar keeps to the app's main destinations.
  await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

/** Sign in where Claude Code cannot be used: the Chat screen then says why instead of offering a prompt. */
async function signInAnyway(page: Page, botbench: Botbench): Promise<void> {
  await page.goto(`${botbench.base}/#/turn`);
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toHaveText(/^Claude Code: /);
}

test("with no runs and no tasks, Home and Work say so in words, and each has its one way to start something", async ({ page, botbench }) => {
  const foreign = watchRequests(page, botbench);
  await signIn(page, botbench);
  await nav(page).getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveTitle("Home \u2013 Botbench");
  const empty = page.getByTestId("home-empty");
  await expect(empty.getByRole("heading", { name: "No work yet" })).toBeVisible();
  await expect(empty).toContainText("A task or a run you start from Chat is listed here while it is in progress, and comes to the top when it needs you");
  await expect(empty.getByRole("link")).toHaveText(["New chat or task"]);
  await expect(empty.getByRole("link", { name: "New chat or task" })).toHaveAttribute("href", "#/turn");
  await checkWords(page, "Home, empty");
  await shot(page, "u16-board-empty.png");
  await openBoard(page);
  await expect(page.getByTestId("work-none")).toHaveText("No work yet. Each chat, run and task you start is listed here.");
  await expect(workRows(page)).toHaveCount(0);
  await checkWords(page, "Work, empty");
  await page.getByRole("link", { name: "New run" }).click();
  await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeAttached();
  // New run came to work in a repository: the sheet opens on Repository, and Send waits for one.
  await expect(page.locator("dialog.ds-sheet").getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose a Repository" })).toBeAttached();
  expect(foreign).toEqual([]);
});

test("with Claude Code signed out, Chat says why, and Settings shows the agent signed out", async ({ page }) => {
  // The real CLI, pointed at an empty configuration directory, reports itself signed out.
  const empty = tempDir("botbench-e2e-claude-config-");
  const botbench = await startBotbench({ env: { CLAUDE_CONFIG_DIR: empty } });
  try {
    await signInAnyway(page, botbench);
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: signed out");
    await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    const agent = page.getByTestId("agent-claude-code");
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out");
    await expect(agent).toContainText("Claude Code is signed out. Run `claude auth login` in a terminal.");
    await checkDesign(page, "settings, Claude Code signed out");
  } finally {
    const { leftover } = await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
    expect(leftover).toEqual([]);
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
  // A Codex with `codex app-server` builds as well as reviews (src/drivers/codex.ts), and Settings says so.
  if (codex.problem === null) await expect(codexRow).toContainText("Builds a task or a run's tasks when you choose it under Builder, and reviews a run's tasks when you choose it for a run; it does not plan.");
  // Grok and Antigravity, each with the state its own probe reports.
  for (const key of ["grok", "antigravity"]) await expect(page.getByTestId(`agent-${key}`).getByTestId("agent-state")).toHaveText(/^(Available|Signed out|Not installed|Unsupported version|Unavailable)$/);
  await expect(page.getByText("Gemini CLI")).toHaveCount(0);
  // Settings is no tab: the tab bar keeps its three destinations. Its first rows lead to Permissions and Usage.
  await expect(page.locator(".ds-tab-bar__item")).toHaveText(["Home", "Work", "Chat"]);
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

test("LIVE: Work counts runs by state and moves them live, without a reload, and the State filter narrows the list", async ({ page, botbench }) => {
  test.setTimeout(300_000);
  const foreign = watchRequests(page, botbench);
  const repo = path.join(path.dirname(botbench.home), "board-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await openBoard(page);
  await expect(page.getByTestId("work-none")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { botbenchSamePage: boolean }).botbenchSamePage = true));

  // Two runs: the first is planned now by Claude Code; the second waits for it, one planner at a time.
  const start = async (prompt: string): Promise<number> => ((await (await page.request.post(`${botbench.base}/api/runs`, { data: { repo, prompt, preapproved: [] } })).json()) as { runId: number }).runId;
  const planned = await start("Add a file hello.txt that holds the word hi. Make it one task. Do not run any command.");
  const cancelled = await start("Add a file bye.txt that holds the word bye.");
  await expect(workRows(page)).toHaveCount(2);
  await expect(workStateFilter(page, /^In progress/)).toHaveText("In progress2");

  // Cancelling the queued one ends it, live.
  await page.request.post(`${botbench.base}/api/runs/${cancelled}/cancel`, { data: {} });
  await expect(workStateFilter(page, /^Ended otherwise/)).toHaveText("Ended otherwise1");
  await expect(workStateFilter(page, /^In progress/)).toHaveText("In progress1");

  // The planner's plan, or a request it makes, needs the owner: the run moves to Needs you, live.
  await expect(workStateFilter(page, /^Needs you/)).toHaveText("Needs you1", { timeout: 180_000 });
  await expect(workStateFilter(page, /^In progress/)).toHaveText("In progress0");

  await workStateFilter(page, /^Needs you/).click();
  await expect(workRows(page)).toHaveCount(1);
  await expect(workRows(page).getByRole("link")).toHaveAttribute("href", `#/runs/${planned}`);
  await expect(workState(workRows(page))).toHaveText(/^(Plan ready for review|Needs input)$/);
  await checkWords(page, "Work, needs you");
  await shot(page, "u16-board-needs-you.png");

  await workStateFilter(page, /^In progress/).click();
  await expect(workRows(page)).toHaveCount(0);
  await expect(page.getByTestId("work-none")).toHaveText("Nothing matches. Clear the search or choose All and Any state to see everything.");

  await workStateFilter(page, /^Ended otherwise/).click();
  await expect(workRows(page)).toHaveCount(1);
  await expect(workRows(page).getByRole("link")).toHaveAttribute("href", `#/runs/${cancelled}`);
  await expect(workState(workRows(page))).toHaveText("Cancelled");
  await checkWords(page, "Work, ended otherwise");
  await shot(page, "u16-board-finished.png");

  expect(await page.evaluate(() => (window as unknown as { botbenchSamePage?: boolean }).botbenchSamePage), "everything came without a reload").toBe(true);
  expect(foreign).toEqual([]);
});

test("Discard: a task whose setup failed keeps its copy and branch until the owner discards them; the dialog names the files that are not on the branch, and Work lists the task as failed", async ({ page }) => {
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
    await expect(page.getByTestId("branch").first()).toHaveText(task.branch);
    // What is kept, and Discard, are in the task's pane: a sheet at a phone's width, opened from the foot. Discard is quiet, never filled.
    const open = page.getByRole("button", { name: "What is kept" });
    await open.click();
    const discard = page.getByRole("button", { name: "Discard…" });
    await expect(discard).toBeVisible();
    expect(await discard.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
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
    await expect(page.getByTestId("what-happened")).toContainText("What it left was discarded.");
    await expect(page.getByTestId("discarded")).toHaveText("Discarded. Nothing of this task is left: its copy of the project and its branch are gone, with the work on them. Nothing was merged or pushed.");
    await expect(page.getByRole("button", { name: "Discard…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("branch")).toHaveCount(0);
    await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. /);
    await checkDesign(page, "task, failed, discarded");
    expect(botbenchBranches(repo)).toEqual([]);
    expect(worktreeCount(repo)).toBe(1);
    expect(checkoutState(repo)).toEqual(before);

    // The Activity list says what the owner did.
    await openFromSettings(page, "Permissions");
    await expect(page.getByText("You discarded")).toBeVisible();

    // A stand-alone task is a run of one: it is a row of Work, with its real state, under the Failed filter.
    await openBoard(page);
    await workStateFilter(page, /^Failed/).click();
    await expect(workRows(page).getByRole("link")).toHaveAttribute("href", `#/tasks/${taskId}`);
    await expect(workState(workRows(page))).toHaveText("Failed");
    await checkWords(page, "Work, a stand-alone task that failed");
    await shot(page, "work.png");
  } finally {
    const { leftover } = await botbench.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(leftover).toEqual([]);
  }
});

test("in light mode, sign-in and Settings are drawn in the light colours", async ({ page, botbench }) => {
  // The owner chose Light on this device before: the choice is on the device, so it holds before sign-in too.
  await page.goto(`${botbench.base}/#/turn`);
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

test("LIVE: in light mode, a chat with a tool call, an approval card, a task ready for review and Work are drawn in the light colours", async ({ page, botbench }) => {
  test.setTimeout(420_000);
  const repo = path.join(path.dirname(botbench.home), "light-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  fs.writeFileSync(path.join(botbench.home, "scratch", "notes.txt"), "The word is heron.\n");
  // The owner chose Light on this device before: the choice is on the device, so it holds before sign-in too.
  await page.goto(`${botbench.base}/#/turn`);
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

  // A command kept inside the task's copy runs without a card by default: this card needs Ask before every command.
  await askBeforeEveryCommand(page, botbench);
  const taskId = ((await (await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt: "Run the command `echo hi > hello.txt` with your Bash tool, exactly once. Then reply with the single word: done", preapproved: [] } })).json()) as { taskId: number }).taskId;
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await checkDesign(page, "approval card, light");
  await shot(page, "u16-light-approval.png");
  await openBoard(page);
  await expect(workState(workRows(page, "echo hi"))).toHaveText("Needs input");
  await checkWords(page, "Work, a task waiting on an approval, light");
  await shot(page, "u16-light-board.png");
  await page.goto(`${botbench.base}/#/tasks/${taskId}`);
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-settled", "");
  await page.getByTestId("approval-card").getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 120_000 });
  await checkDesign(page, "task ready for review, light");
  await shot(page, "u16-light-ready.png");
});
