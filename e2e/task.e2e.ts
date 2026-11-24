import fs from "node:fs";
import path from "node:path";
import { checkoutState, git, gitProcesses, initRepo, releaseStalled, stalledRepo, write } from "../test/support/repo.ts";
import { checkDesign, checkWords, closeContext, contextSheet, copyShot, expect, filledButtons, goTo, messageBox, nav, openCanDo, openDetails, openNewTask, openRow, openWork, SCREENS, SHOTS, signIn, startTaskIn, test, watchRequests, workRows, workState } from "./helpers.ts";
import type { Page } from "@playwright/test";

/** The Folder path field of the Repository view, with Another folder chosen. */
async function folderField(page: Page) {
  const sheet = await openRow(page, "Repository");
  await sheet.getByRole("radio", { name: "Another folder…" }).check();
  return sheet.getByLabel("Folder path");
}
import { startBotbench, tempDir } from "./botbench.ts";

// Tasks in the real client, at a phone's size, against a real Botbench process and real temporary repositories.

/** A real repository beside the test's Botbench home, with the owner part-way through their own work. */
function sourceRepo(botbenchHome: string): string {
  const repo = path.join(path.dirname(botbenchHome), "sample-repo");
  initRepo(repo);
  write(repo, "README.md", "# Sample\nthe owner is half-way through this line\n");
  return repo;
}

test("LIVE: start a task in a repository, watch its transcript, expand the changed file's diff and see the branch, without a reload; the new screens follow the design system", async ({ page, context, botbench }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const foreign = watchRequests(page, botbench);
  const repo = sourceRepo(botbench.home);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  // A mark on the page that a reload would wipe out.
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));

  // The empty Tasks view and the composer are drawn without a model: see "the navigation reaches Tasks…" below.
  const prompt = "Create a file named hello.txt containing exactly: hi";
  await startTaskIn(page, repo, prompt);

  // The task screen: the state in words, then the activity as it happens.
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  await expect(page.getByTestId("task-status")).toHaveText(/^(Queued|Working)\./);
  // The repository by its name, and its full path in Details; the branch is named under the title.
  await expect(page.getByTestId("task-name")).toHaveText(`Task 1 · ${path.basename(repo)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create a file named hello.txt containing…");
  await expect((await openDetails(page)).getByTestId("task-repo")).toHaveText(repo);
  const log = page.getByRole("log", { name: "Activity" });
  await expect(log.getByTestId("prompt")).toContainText(prompt, { timeout: 60_000 });
  await expect(page.getByTestId("task-status")).toHaveText("Working. Claude Code is working in a separate copy of the project.");
  await expect(page.getByTestId("task-state")).toHaveText("Working");
  await expect(page.getByTestId("changed-files")).toHaveCount(0);
  await expect(page.getByTestId("branch")).toHaveText(/^botbench\/[a-z0-9-]+\/run-\d+\/task-\d+$/);
  // The agent's steps arrive in the activity as they happen: one that runs or waits stands open, and those that are
  // over fold under a line that counts them. Each step's own line is read once the task is built, below.
  await expect(log.getByTestId("step-now").or(log.getByTestId("steps")).first()).toBeVisible({ timeout: 120_000 });

  // The model sometimes also wants to run a command (to look around, or to check its work). Since unit 7 that
  // pauses for the owner. This test is about the edit, so any such request is declined, as an owner could.
  const built = "Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it.";
  await expect(async () => {
    const pending = (await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] };
    for (const approval of pending.approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Not needed for this task; just create the file." } });
    }
    await expect(page.getByTestId("task-status")).toHaveText(built, { timeout: 2_000 });
  }).toPass({ timeout: 180_000, intervals: [1_000] });
  await expect(page.getByTestId("task-state")).toHaveText("Ready for review");

  // The review opens on its Review tab: the changed file with its line counts, and its diff.
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("heading")).toHaveText("1 file changed");
  await expect(files).toContainText(/hello\.txt\s*added\s*\+1 line added\s*−0 lines removed/);
  // Each file is a disclosure: its button is the control and carries its expanded state. The first file's is open.
  const file = files.getByRole("button", { name: "hello.txt" });
  const diff = page.getByTestId("diff");
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await expect(diff).toBeVisible();
  // The keyboard alone closes it, and opens it again.
  await file.focus();
  await page.keyboard.press("Enter");
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await expect(diff).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("group", { name: "Changes in hello.txt" })).toBeVisible();
  await expect(diff.locator("[data-line=hunk]").first()).toContainText("@@");
  await expect(diff.locator("[data-line=added] [data-text]")).toHaveText("hi");
  expect(await diff.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"JetBrains Mono Variable"/);
  // hello.txt is prose: its diff wraps to the screen's width instead of scrolling inside its block, and the page itself
  // never scrolls sideways. That a code file's long line scrolls inside its block is checked with a code file, in
  // task-layout.e2e.ts.
  await expect(diff).toHaveAttribute("data-prose", "true");
  expect(await diff.locator("[data-line=added] [data-text]").first().evaluate((el) => getComputedStyle(el).whiteSpace), "a prose diff's lines wrap").toBe("pre-wrap");
  expect(await diff.evaluate((el) => el.scrollWidth - el.clientWidth), "a prose diff does not scroll sideways inside its block").toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "the page does not scroll sideways").toBe(0);
  // Lines are told apart by their sign, not by colour alone: the line's number, then its sign, then its text.
  await expect(diff.locator("[data-line=added]").first().locator("span").nth(1)).toHaveText("+");

  // The branch, by name, with a copy control that copies it.
  const branch = (await page.getByTestId("branch").textContent())!;
  expect(git(repo, "show", `${branch}:hello.txt`).trim()).toBe("hi");
  await page.getByRole("button", { name: "Copy branch name" }).click();
  await expect(page.getByTestId("branch-copy-state")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(branch);
  await expect(page.getByTestId("not-merged")).toHaveText("Nothing has been merged or pushed.");
  await expect((await openCanDo(page)).getByTestId("can-do-text")).toHaveText(
    "Claude Code may read and change files inside this task's copy of the project without asking. A shell command kept inside this copy runs without asking, apart from those the safety rules always ask you about; with Ask before every command on in Settings, every one waits for your answer first, unless you chose Always allow for it (see Permissions). Botbench sends you anything else it wants to do as well. The separate copy (a git worktree) keeps changes apart from your own files. A command you allow runs in Claude Code's sandbox: it cannot read your sign-ins, your keys or the rest of your home folder (apart from this repository's git data and your git settings), can change files only in this copy and a temporary folder, and reaches the internet only at hosts allowed for this repository in Botbench's settings file.",
  );
  // This repository has no checks set up, so the accept there is says so, and is not drawn as the screen's primary
  // action; nothing claims to merge, push, approve or stop.
  await expect(page.getByTestId("evidence-words")).toHaveText("No checks are set up for this repository, so nothing verified this work. You can accept it without verification.");
  // The decision stays in reach at the foot of the window: Reject, then the accept there is, neither filled.
  expect(await filledButtons(page), "no button is drawn as the primary action").toEqual([]);
  await expect(page.getByTestId("foot-line")).toHaveText("No checks ran on this work.");
  await expect(page.getByTestId("foot-actions").getByRole("button")).toHaveText(["Reject", "Accept without verification"]);
  await expect(page.getByRole("button", { name: /accept|reject/i })).toHaveText(["Reject", "Accept without verification"]);
  await expect(page.getByRole("button", { name: /merge|push|approve|stop/i })).toHaveCount(0);

  await checkDesign(page, "task, finished with a diff open");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u6-task.png"), fullPage: true });

  // The activity is the tab beside the review. No working note is left once the turn is over.
  await page.getByRole("tab", { name: /^Activity/ }).click();
  await expect(log.getByTestId("prompt")).toContainText(prompt);
  await expect(log.getByTestId("working")).toHaveCount(0);
  await expect(log.getByTestId("step-now")).toHaveCount(0);
  await expect(log.getByRole("status")).toHaveCount(0);
  // The steps are over, folded under lines that count them; one tap shows each. Every step is one plain line taken
  // from the real tool and its arguments; raw arguments are never the line.
  const show = log.getByRole("button", { name: /Show steps/ });
  while ((await show.count()) > 0) await show.first().click();
  const wrote = log.getByTestId("steps").getByRole("listitem").filter({ hasText: "hello.txt" }).first();
  await expect(wrote).toContainText(/(Wrote|Could not write|Edited|Could not edit|Ran|Did not run)\s+\S/);
  await expect(wrote).not.toContainText("{");
  // One tap on a step shows what is behind its line: what it printed.
  const behind = wrote.getByRole("button");
  if ((await behind.getAttribute("aria-expanded")) !== "true") await behind.click();
  await expect(wrote.getByRole("group", { name: "What it printed" })).toBeVisible();
  await checkDesign(page, "task, finished with a step open");
  await copyShot(page, "task-finished-tool-open");

  // Back on the review, collapsing the file works too.
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(diff).toBeVisible();
  await file.click();
  await expect(page.getByTestId("diff")).toHaveCount(0);

  // Work shows the task with its state in words, and leads back to it.
  await openWork(page);
  const rows = workRows(page).getByRole("link");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Ready for review");
  await expect(rows.first()).toContainText(prompt);
  await checkWords(page, "work, with one task");
  await copyShot(page, "work");
  await rows.first().click();
  await expect(page.getByTestId("branch")).toHaveText(branch);
  await page.getByRole("tab", { name: /^Activity/ }).click();
  await expect(log.getByTestId("prompt")).toContainText(prompt);

  // The turn screen is still there and still works as the first screen. Its composer opens on what was used last: a
  // task in this repository.
  await goTo(page, "Chat");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Describe the task" })).toBeEnabled();

  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "all of it without a reload").toBe(true);
  expect(foreign, "requests to anything but Botbench").toEqual([]);
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("the navigation is Home, Work and Chat, and Work says there is nothing yet; Tasks leads there; New task opens the composer asking for a repository, and a path is checked as it is typed", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  await signIn(page, botbench);
  // The navigation lists the destinations, and gets to each.
  await expect(nav(page).getByRole("link")).toHaveText(SCREENS);
  await expect(nav(page).locator('[aria-current="page"]')).toHaveText("Chat");
  await openWork(page);
  await expect(page.getByTestId("work-none")).toHaveText("No work yet. Each chat, run and task you start is listed here.");
  await checkWords(page, "work, none yet");
  // The old addresses of the lists lead to Work.
  for (const old of ["#/tasks", "#/runs"]) {
    await page.evaluate((to) => (window.location.hash = to), old);
    await expect(page).toHaveURL(/#\/work$/);
    await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
  }
  await openNewTask(page);
  // New task opens New chat or task with Start one task chosen.
  await expect(page.getByRole("radio", { name: "Start one task" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Send" })).toHaveAccessibleDescription("Choose a repository");

  // The path is checked as it is typed, and the answer is in words.
  const field = await folderField(page);
  await expect(page.getByTestId("repo-state")).toHaveText("Enter the full path of a git repository on this Mac.");
  await field.fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await checkDesign(page, "add context, a folder typed");
  await closeContext(page);
  await messageBox(page).fill("Create a file named hello.txt containing exactly: hi");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await checkDesign(page, "composer, a task filled in");
});

test("a repository path that cannot be used is reported in words, and Send starts nothing", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  const plain = tempDir("botbench-e2e-plain-");
  try {
    await signIn(page, botbench);
    const starts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") starts.push(request.url());
    });
    await openNewTask(page);
    await messageBox(page).fill("Create hello.txt");
    const state = page.getByTestId("repo-state");
    const field = await folderField(page);

    await field.fill("sample-repo");
    await expect(state).toContainText("Give the full path, starting with /.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill(path.join(plain, "missing"));
    await expect(state).toContainText("does not exist");
    await field.fill(plain);
    await expect(state).toContainText("is not a git repository");
    await checkDesign(page, "add context, path refused");

    // Send waits, and says why; the required chip asks for the repository.
    await closeContext(page);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription(/is not a git repository/);
    await expect(page.getByRole("button", { name: "Choose a Repository" })).toBeVisible();

    // A usable path with no prompt starts nothing either: Send puts the cursor in the box.
    await page.getByRole("button", { name: "Choose a Repository" }).click();
    await field.fill(repo);
    await expect(state).toHaveText("Usable git repository.");
    await expect(field).toHaveAttribute("aria-invalid", "false");
    await closeContext(page);
    await messageBox(page).fill("   ");
    await send.click();
    await expect(messageBox(page)).toBeFocused();

    expect(starts, "no task was asked for").toEqual([]);
    expect(await (await page.request.get(`${botbench.base}/api/tasks`)).json()).toEqual({ tasks: [] });
    expect(fs.existsSync(path.join(botbench.home, "worktrees"))).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("the repository Botbench knows of is offered by name, with its path, and once chosen is remembered for the next task", async ({ page }) => {
  const dir = fs.realpathSync(tempDir("botbench-e2e-known-"));
  const repo = path.join(dir, "services", "shipment-tracking-api");
  initRepo(repo);
  const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: {} } } });
  try {
    await signIn(page, botbench);
    await openNewTask(page);
    await page.getByRole("button", { name: "Choose a Repository" }).click();
    const sheet = contextSheet(page);
    await sheet.getByRole("radio", { name: "shipment-tracking-api" }).click();
    await closeContext(page);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await checkDesign(page, "composer, the known repository chosen");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "ui-new-task.png"), fullPage: true });
    await page.reload();
    await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe the task");
  } finally {
    const { leftover } = await botbench.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(leftover).toEqual([]);
  }
});

test("an address that names no screen says so in words, and a long one stays inside the screen", async ({ page, botbench }) => {
  await signIn(page, botbench);
  const address = `/${"nowhere".repeat(40)}`;
  await page.goto(`${botbench.base}/#${address}`);
  await expect(page.getByRole("alert")).toContainText(`There is no screen at ${address}.`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`There is no screen at ${address}.`);
  await expect(page.getByRole("navigation", { name: "Screens" }).locator('[aria-current="page"]')).toHaveCount(0);
  await checkDesign(page, "no such screen");
});

test("a task address that names no task says so in words", async ({ page, botbench }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/tasks/4242`);
  await expect(page.getByRole("alert")).toHaveText("There is no task 4242.");
  await expect(page.getByTestId("changed-files")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("a task that cannot be built shows that it failed and why, as it happens, and lists as failed", async ({ page }) => {
  // Botbench's home inside the repository itself, the one place a worktree must never go: the task is real and fails at
  // its first step, before Claude Code is started.
  const repo = tempDir("botbench-e2e-inside-");
  initRepo(repo);
  const botbench = await startBotbench({ home: path.join(repo, "home") });
  try {
    await signIn(page, botbench);
    await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
    await startTaskIn(page, repo, "Create hello.txt\nand a second line");

    await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);
    await expect(page.getByTestId("task-status")).toContainText("Failed. The task's copy of the project could not be created");
    await expect(page.getByTestId("task-status")).toContainText("inside the repository");
    // What the task was asked is still shown; there is no transcript, no file list and no branch to show.
    await expect(page.getByTestId("task-prompt")).toHaveText("Create hello.txt\nand a second line");
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByTestId("changed-files")).toHaveCount(0);
    await expect(page.getByTestId("branch")).toHaveCount(0);
    // Nothing was left and nothing can be resumed: no Resume, no Discard, only the way to the task's details.
    await expect(page.getByRole("button")).toHaveText(["Details"]);
    await checkDesign(page, "task, failed");

    await openWork(page);
    await expect(workRows(page).getByRole("link")).toHaveText([/^Create hello\.txt.*Failed · Task 1 · /]);
    await expect(workState(workRows(page))).toHaveText("Failed");
    await expect(workRows(page)).not.toContainText("second line");
    expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  } finally {
    const { leftover } = await botbench.stop();
    fs.rmSync(repo, { recursive: true, force: true });
    expect(leftover).toEqual([]);
  }
});

test("a repository git cannot read in time: the screen leaves Checking and says why, Send starts nothing, and a newer path replaces the older check", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  const stalled = path.join(path.dirname(botbench.home), "stalled-repo");
  stalledRepo(stalled);
  try {
    await signIn(page, botbench);
    const starts: string[] = [];
    const dropped: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") starts.push(request.url());
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/repos/check") dropped.push(url.searchParams.get("path") ?? "");
    });
    await openNewTask(page);
    await messageBox(page).fill("Create hello.txt");
    const state = page.getByTestId("repo-state");
    const field = await folderField(page);

    await field.fill(stalled);
    await expect(state).toHaveText("Checking.");
    await expect(state).toContainText("could not be read in time", { timeout: 9000 });
    await expect(state).toContainText(stalled);
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await checkDesign(page, "add context, path not read in time");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "the reason wraps inside the screen").toBe(0);

    await closeContext(page);
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send" })).toHaveAccessibleDescription(/could not be read in time/);
    await expect(page.getByTestId("task-name")).toHaveCount(0);
    await page.getByRole("button", { name: "Choose a Repository" }).click();

    // A path typed while an older one is still being checked takes its place: the older request is given up.
    await field.fill("");
    await field.fill(stalled);
    await expect.poll(() => gitProcesses(stalled).length, "the check of the stalled path is under way").toBeGreaterThan(0);
    await field.fill(repo);
    await expect(state).toHaveText("Usable git repository.");
    expect(dropped, "the older check was given up").toEqual([stalled]);
    await expect.poll(() => gitProcesses(stalled), { timeout: 9000, message: "no git process is left for the folder" }).toEqual([]);
    await expect(state).toHaveText("Usable git repository.");

    expect(starts, "no task was asked for").toEqual([]);
    expect(await (await page.request.get(`${botbench.base}/api/tasks`)).json()).toEqual({ tasks: [] });
  } finally {
    releaseStalled(stalled);
  }
});

test("a check Botbench does not answer ends at the client's own time limit, in words", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  await signIn(page, botbench);
  await openNewTask(page);
  const state = page.getByTestId("repo-state");
  const field = await folderField(page);
  botbench.freeze();
  try {
    await field.fill(repo);
    await expect(state).toHaveText("Checking.");
    await expect(state).toHaveText("The path could not be checked: Botbench did not answer within 10 seconds.", { timeout: 14_000 });
  } finally {
    botbench.thaw();
  }
  // Once Botbench answers again, the next path typed is checked as usual.
  await field.fill(`${repo}/`);
  await expect(state).toHaveText("Usable git repository.");
});
