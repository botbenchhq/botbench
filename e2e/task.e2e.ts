import fs from "node:fs";
import path from "node:path";
import { checkoutState, git, gitProcesses, initRepo, releaseStalled, stalledRepo, write } from "../test/support/repo.ts";
import { checkDesign, copyShot, expect, SHOTS, signIn, test, watchRequests, openNewTask } from "./helpers.ts";
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

  // The navigation lists the screens that exist, and gets to each.
  const nav = page.getByRole("navigation", { name: "Screens" });
  await expect(nav.getByRole("link")).toHaveText(["Chat", "Runs", "Tasks", "Permissions"]);
  await expect(nav.locator('[aria-current="page"]')).toHaveText("Chat");
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(page.getByTestId("task-list-state")).toHaveText("No tasks yet");
  await checkDesign(page, "tasks, none yet");
  await openNewTask(page);
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  // New task is an action of the Tasks view, not a destination: no destination is marked while it is open.
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.getByTestId("repo-state")).toHaveText("Enter the full path of a git repository on this Mac.");
  await checkDesign(page, "new task, empty");

  // The path is checked as it is typed, and the answer is in words.
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  const prompt = "Create a file named hello.txt containing exactly: hi";
  await page.getByLabel("Prompt").fill(prompt);
  await checkDesign(page, "new task, filled in");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u6-new-task.png"), fullPage: true });
  await page.getByRole("button", { name: "Start task" }).click();

  // The task screen: the state in words, then the transcript as it happens.
  await expect(page.getByRole("heading", { name: /^Task \d+$/ })).toBeVisible();
  await expect(page.getByTestId("task-status")).toHaveText(/^(Queued|Working)\./);
  await expect(page.getByTestId("task-repo")).toHaveText(repo);
  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt, { timeout: 60_000 });
  await expect(page.getByTestId("task-status")).toHaveText("Working. Claude Code is working in a separate copy of the project.");
  await expect(page.getByTestId("changed-files")).toHaveCount(0);
  await expect(page.getByTestId("branch")).toHaveValue(/^botbench\/run-\d+\/task-\d+$/);
  await expect(page.locator('[data-event="tool_call"]').first()).toContainText("hello.txt", { timeout: 120_000 });
  // Every action is one plain line taken from the real tool and its arguments; raw arguments are never the line.
  const wrote = page.locator('[data-event="tool_call"]').filter({ hasText: "hello.txt" }).first();
  await expect(wrote.locator("summary").first()).toHaveText(/^(Writing|Wrote|Wants to write|Did not write|Editing|Edited|Running|Ran|Wants to run|Did not run)\s*\S/);
  await expect(wrote.locator("summary").first()).not.toContainText("{");

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
  await expect(page.locator('[data-event="turn_ended"]').locator("summary")).toHaveText(/^Worked for (\d+m )?\d+s$/);
  // No working note is left once the turn is over.
  await expect(page.getByRole("log").getByRole("status")).toHaveCount(0);

  // The changed file with its line counts, expandable to its diff.
  const files = page.getByTestId("changed-files");
  await expect(files.getByRole("listitem")).toHaveCount(1);
  // Each file is a native disclosure: its summary is the control, and the browser carries its expanded state.
  const file = files.locator("summary").filter({ hasText: "hello.txt" });
  const disclosure = files.locator("details");
  await expect(file).toHaveText(/hello\.txt.*added.*\+1 line added.*−0 lines removed/);
  await expect(disclosure).not.toHaveAttribute("open");
  await expect(page.getByTestId("diff")).toHaveCount(0);
  // The keyboard alone opens it.
  await file.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("open");
  const diff = page.getByTestId("diff");
  await expect(diff).toContainText("+++ b/hello.txt");
  await expect(diff).toContainText("+hi");
  expect(await diff.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?IBM Plex Mono"?,/);
  // The diff scrolls inside its own block; the page itself never scrolls sideways.
  const scroller = page.getByTestId("diff-scroll");
  expect(await scroller.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth), "a long diff line scrolls inside its block").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // Lines are told apart by their sign, not by colour alone.
  expect(await diff.locator('[data-line="added"]').first().textContent()).toMatch(/^\+/);

  // The branch, by name, with a copy control that copies it.
  const branch = await page.getByTestId("branch").inputValue();
  expect(git(repo, "show", `${branch}:hello.txt`).trim()).toBe("hi");
  await page.getByRole("button", { name: "Copy branch name" }).click();
  await expect(page.getByTestId("branch-copy-state")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(branch);
  await expect(page.getByTestId("not-merged")).toHaveText(
    "Nothing has been merged or pushed. Claude Code may read and change files inside this task's copy of the project without asking. Every shell command waits for your answer first, unless you chose Always allow for it (see Permissions), and Botbench sends you anything else it wants to do as well. The separate copy (a git worktree) keeps changes apart from your own files; it is not a sandbox: a command you allow runs with your account's rights.",
  );
  // The screen's one primary action is Accept, beside Reject; nothing claims to merge, push, approve or stop.
  await expect(page.locator(".gw-button--primary")).toHaveText(["Accept"]);
  await expect(page.getByRole("button", { name: /accept|reject/i })).toHaveText(["Accept", "Reject"]);
  await expect(page.getByRole("button", { name: /merge|push|approve|stop/i })).toHaveCount(0);

  await checkDesign(page, "task, finished with a diff open");
  // One tap on an action shows what is behind its line.
  await file.click();
  await wrote.locator("summary").first().click();
  await expect(wrote.locator("details").first()).toHaveAttribute("open");
  await expect(wrote.locator("pre").first()).toContainText("hello.txt");
  await checkDesign(page, "task, finished with a tool row open");
  await copyShot(page, "task-finished-tool-open");
  await wrote.locator("summary").first().click();
  await file.click();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u6-task.png"), fullPage: true });

  // Collapsing works too.
  await file.click();
  await expect(page.getByTestId("diff")).toHaveCount(0);

  // The list shows the task, newest first, with its state in words, and leads back to it.
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  const rows = page.getByTestId("task-list").getByRole("link");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Ready for review");
  await expect(rows.first()).toContainText(prompt);
  await checkDesign(page, "tasks, with one");
  await copyShot(page, "tasks");
  await rows.first().click();
  await expect(page.getByTestId("branch")).toHaveValue(branch);
  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);

  // The turn screen is still there and still works as the first screen.
  await nav.getByRole("link", { name: "Chat" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("driver-state")).toContainText("signed in");

  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce), "all of it without a reload").toBe(true);
  expect(foreign, "requests to anything but Botbench").toEqual([]);
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("a repository path that cannot be used is reported in words, and Start task starts nothing", async ({ page, botbench }) => {
  const repo = sourceRepo(botbench.home);
  const plain = tempDir("botbench-e2e-plain-");
  try {
    await signIn(page, botbench);
    const starts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") starts.push(request.url());
    });
    await openNewTask(page);
    const state = page.getByTestId("repo-state");
    const field = page.getByLabel("Repository path");
    await page.getByLabel("Prompt").fill("Create hello.txt");

    await field.fill("sample-repo");
    await expect(state).toContainText("Give the full path, starting with /.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill(path.join(plain, "missing"));
    await expect(state).toContainText("does not exist");
    await field.fill(plain);
    await expect(state).toContainText("is not a git repository");
    await checkDesign(page, "new task, path refused");

    await page.getByRole("button", { name: "Start task" }).click();
    await expect(page.getByRole("alert")).toContainText("The task was not started");
    await expect(page.getByRole("alert")).toContainText("is not a git repository");
    await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Task \d+$/ })).toHaveCount(0);

    // A usable path with no prompt starts nothing either.
    await field.fill(repo);
    await expect(state).toHaveText("Usable git repository.");
    await expect(field).toHaveAttribute("aria-invalid", "false");
    await page.getByLabel("Prompt").fill("   ");
    await page.getByRole("button", { name: "Start task" }).click();
    await expect(page.getByRole("alert")).toContainText("Say what the task is.");

    expect(starts, "no task was asked for").toEqual([]);
    expect(await (await page.request.get(`${botbench.base}/api/tasks`)).json()).toEqual({ tasks: [] });
    expect(fs.existsSync(path.join(botbench.home, "worktrees"))).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
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
  await expect(page.getByRole("alert")).toHaveText("ErrorThere is no task 4242.");
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
    const nav = page.getByRole("navigation", { name: "Screens" });
    await openNewTask(page);
    await page.getByLabel("Repository path").fill(repo);
    await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
    await page.getByLabel("Prompt").fill("Create hello.txt\nand a second line");
    await page.getByRole("button", { name: "Start task" }).click();

    await expect(page.getByRole("heading", { name: "Task 1" })).toBeVisible();
    await expect(page.getByTestId("task-status")).toContainText("Failed. The task's copy of the project could not be created");
    await expect(page.getByTestId("task-status")).toContainText("inside the repository");
    // What the task was asked is still shown; there is no transcript, no file list and no branch to show.
    await expect(page.getByTestId("task-prompt")).toHaveText("Create hello.txt\nand a second line");
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByTestId("changed-files")).toHaveCount(0);
    await expect(page.getByTestId("branch")).toHaveCount(0);
    await expect(page.getByRole("button")).toHaveCount(0);
    await checkDesign(page, "task, failed");

    await nav.getByRole("link", { name: "Tasks", exact: true }).click();
    await expect(page.getByTestId("task-list").getByRole("link")).toHaveText(/Create hello\.txt.*Failed.*Task 1 · /);
    await expect(page.getByTestId("task-list")).not.toContainText("second line");
    expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a repository git cannot read in time: the screen leaves Checking and says why, Start task starts nothing, and a newer path replaces the older check", async ({ page, botbench }) => {
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
    const state = page.getByTestId("repo-state");
    const field = page.getByLabel("Repository path");
    await page.getByLabel("Prompt").fill("Create hello.txt");

    await field.fill(stalled);
    await expect(state).toHaveText("Checking.");
    await expect(state).toContainText("could not be read in time", { timeout: 9000 });
    await expect(state).toContainText(stalled);
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await checkDesign(page, "new task, path not read in time");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "the reason wraps inside the screen").toBe(0);

    await page.getByRole("button", { name: "Start task" }).click();
    await expect(page.getByRole("alert")).toContainText("The task was not started");
    await expect(page.getByRole("alert")).toContainText("could not be read in time");
    await expect(page.getByRole("heading", { name: /^Task \d+$/ })).toHaveCount(0);

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
  botbench.freeze();
  try {
    await page.getByLabel("Repository path").fill(repo);
    await expect(state).toHaveText("Checking.");
    await expect(state).toHaveText("The path could not be checked: Botbench did not answer within 10 seconds.", { timeout: 14_000 });
  } finally {
    botbench.thaw();
  }
  // Once Botbench answers again, the next path typed is checked as usual.
  await page.getByLabel("Repository path").fill(`${repo}/`);
  await expect(state).toHaveText("Usable git repository.");
});
