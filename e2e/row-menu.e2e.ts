import fs from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page } from "@playwright/test";
import { createChat } from "../src/api/chat.ts";
import { createTurns } from "../src/api/turns.ts";
import { createBroker } from "../src/approvals/broker.ts";
import type { Config } from "../src/config.ts";
import { ClaudeCodeDriver } from "../src/drivers/claude-code.ts";
import { decideTask } from "../src/engine/decision.ts";
import { createDeliveries } from "../src/engine/delivery.ts";
import { createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { chatReplayDriver } from "../test/support/replay-chat.ts";
import { replayGitHub } from "../test/support/replay-github.ts";
import { botbenchBranches, git, initRepo, worktreeCount, write } from "../test/support/repo.ts";
import { checkDesign, expect, openWork, signIn } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Each row's More menu on Work, in the real client at a phone's size, with no model turn. Before Botbench starts, the
// rows are put in their states through the engine itself: a run at its plan (so it is still going and can be
// cancelled), a stand-alone task that failed with its copy and branch left, one accepted and delivered whose pull
// request was opened by the delivery step replaying output captured from the real gh, and a chat sent through the chat
// code to Codex replaying its real CLI (test/support/replay-github.ts, test/support/replay-chat.ts: the owner's approved
// exception). Then the real Botbench process shows them.

const ADDRESS = "https://github.com/jon-lange/botbench-delivery-fixture.git";

interface Seeded {
  home: string;
  repo: string;
  run: number;
  failed: { id: number; branch: string };
  delivered: { id: number; branch: string; number: number };
  chat: number;
}

async function built(db: ReturnType<typeof openStore>, home: string, repo: string, prompt: string) {
  const task = createTask(db, { repo, prompt });
  const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
  moveTask(db, task.id, "building", { worktree });
  write(worktree.path, `task-${task.id}.txt`, "hi\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  if (!committed.committed) throw new Error("nothing was committed");
  return { task, commit: committed.commit, branch: worktree.branch };
}

const test = base.extend<{ seeded: Seeded; botbench: Botbench }>({
  seeded: async ({}, use) => {
    const dir = tempDir("botbench-e2e-row-menu-");
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    initRepo(repo);
    const bare = path.join(dir, "remote.git");
    git(dir, "init", "--quiet", "--bare", bare);
    git(repo, "config", `url.${bare}.insteadOf`, ADDRESS);
    git(repo, "remote", "add", "origin", ADDRESS);
    const db = openStore(home);
    const run = createRun(db, { repo, prompt: "Plan a greeting file", baseCommit: git(repo, "rev-parse", "HEAD").trim() });
    storePlan(db, run.id, [{ title: "Add a greeting file", criteria: ["It exists"] }]);
    const failed = await built(db, home, repo, "create failed.txt");
    moveTask(db, failed.task.id, "failed", { reason: "it broke", headCommit: failed.commit });
    const delivered = await built(db, home, repo, "create hello.txt");
    moveTask(db, delivered.task.id, "awaiting_decision", { headCommit: delivered.commit, checks: "none" });
    await decideTask(db, { taskId: delivered.task.id, decision: "accept" });
    const deliveries = createDeliveries({ db, config: { repositories: {} } as unknown as Config, github: replayGitHub().github, onTaskChange: () => {} });
    deliveries.deliver(delivered.task.id, { by: "owner" });
    await deliveries.close();
    const pr = Number(db.prepare("SELECT number FROM deliveries WHERE task_id = ? AND step = 'opened'").get(delivered.task.id)!.number);
    // A chat of one message, to Codex replaying its real CLI.
    const claude = new ClaudeCodeDriver();
    const broker = createBroker({ db, home, onChange: () => {} });
    const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
    const chat = createChat({ db, home, turns, claude, agents: { codex: chatReplayDriver("codex", "chat") }, onEvent: () => {} });
    const [reply] = await chat.send({ message: "Name one primary colour.", conversation: [], agents: [{ agent: "codex", model: null }] });
    for (let i = 0; i < 500 && chat.turnRunning(reply!.attemptId); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await chat.close();
    await turns.close();
    await broker.close();
    db.close();
    await use({ home, repo, run: run.id, failed: { id: failed.task.id, branch: failed.branch }, delivered: { id: delivered.task.id, branch: delivered.branch, number: pr }, chat: reply!.attemptId });
    fs.rmSync(dir, { recursive: true, force: true });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
});

const group = (page: Page): Locator => page.getByTestId("board-group");
const showGroup = (page: Page, name: RegExp): Promise<void> => page.getByRole("group", { name: "Show" }).getByLabel(name).check();
const moreButton = (page: Page, row: string): Locator => page.getByRole("button", { name: `More actions for ${row}`, exact: true });
const menuOf = (page: Page, row: string): Locator => page.getByRole("menu", { name: `More actions for ${row}`, exact: true });
const items = (menu: Locator): Locator => menu.getByRole("menuitem");

test("a run still going and two finished tasks each offer only what is real for them; the keyboard follows the menu's model; a right-click, Shift+F10 and a long press open the same menu", async ({ page, botbench, seeded }) => {
  await signIn(page, botbench);
  await openWork(page);

  // The run at its plan needs you: Open, Hide, and last, below a divider, Cancel.
  await expect(page.getByRole("group", { name: "Show" }).getByLabel(/^Needs you/)).toBeChecked();
  const runRow = `run ${seeded.run}`;
  const runButton = moreButton(page, runRow);
  await expect(runButton).toBeVisible();
  await runButton.focus();
  await page.keyboard.press("Enter");
  const runMenu = menuOf(page, runRow);
  await expect(runMenu).toBeVisible();
  await expect(items(runMenu)).toHaveText([`Open run ${seeded.run}`, "Hide from the list", `Cancel run ${seeded.run}`]);
  await expect(items(runMenu).first()).toBeFocused();
  await expect(runMenu.locator("hr.ds-menu__divider")).toHaveCount(1);
  await expect(items(runMenu).last()).toHaveClass(/ds-menu__item--danger/);
  await checkDesign(page, "work, a run's More menu open");
  // Down, End, Home and a letter move; Escape closes it with focus back on the button.
  await page.keyboard.press("ArrowDown");
  await expect(items(runMenu).nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items(runMenu).last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items(runMenu).first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items(runMenu).last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items(runMenu).first()).toBeFocused();
  await page.keyboard.press("h");
  await expect(items(runMenu).nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(runMenu).toBeHidden();
  await expect(runButton).toBeFocused();
  // Space and Down on the button open it too, with focus on the first item; Tab closes it.
  await page.keyboard.press(" ");
  await expect(items(runMenu).first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(runMenu).toBeHidden();
  await expect(runButton).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items(runMenu).first()).toBeFocused();
  await page.keyboard.press("Escape");

  // Cancel from the menu asks first, in the run screen's own words; keeping the run changes nothing.
  await runButton.click();
  await items(runMenu).last().click();
  const cancel = page.getByTestId("cancel-run");
  await expect(cancel.getByRole("heading", { name: "Cancel this run?" })).toBeVisible();
  await expect(cancel).toContainText("The plan of 1 task is dropped and nothing is built.");
  await checkDesign(page, "work, Cancel's confirmation from the More menu");
  await cancel.getByRole("button", { name: "Keep run" }).click();
  await expect(cancel).toHaveCount(0);
  expect(((await (await page.request.get(`${botbench.base}/api/runs/${seeded.run}`)).json()) as { status: string }).status).toBe("awaiting_plan_approval");

  // Finished: the failed task with its branch and copy, and the delivered task with its branch and its open pull request.
  await showGroup(page, /^Finished/);
  const failedRow = `task ${seeded.failed.id}`;
  await moreButton(page, failedRow).click();
  await expect(items(menuOf(page, failedRow))).toHaveText([`Open task ${seeded.failed.id}`, "Copy branch name", "Hide from the list", `Discard task ${seeded.failed.id}`]);
  await page.keyboard.press("Escape");
  const deliveredRow = `task ${seeded.delivered.id}`;
  await moreButton(page, deliveredRow).click();
  const deliveredMenu = menuOf(page, deliveredRow);
  await expect(items(deliveredMenu)).toHaveText([`Open task ${seeded.delivered.id}`, "Copy branch name", `Open pull request #${seeded.delivered.number}`, "Hide from the list"]);
  await checkDesign(page, "work, a delivered task's More menu open");
  await page.keyboard.press("Escape");

  // A right-click on the row, Shift+F10 on its link and a long press open the same menu, in the same place.
  const rowLink = group(page).getByRole("link", { name: /create hello\.txt/ });
  await rowLink.click({ button: "right" });
  await expect(deliveredMenu).toBeVisible();
  await expect(items(deliveredMenu)).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(deliveredMenu).toBeHidden();
  await rowLink.focus();
  await page.keyboard.press("Shift+F10");
  await expect(deliveredMenu).toBeVisible();
  await expect(items(deliveredMenu).first()).toBeFocused();
  await page.keyboard.press("Escape");
  const box = (await rowLink.boundingBox())!;
  const at = { pointerType: "touch", isPrimary: true, clientX: box.x + 20, clientY: box.y + box.height / 2 };
  await rowLink.dispatchEvent("pointerdown", at);
  await page.waitForTimeout(700);
  await rowLink.dispatchEvent("pointerup", at);
  await expect(deliveredMenu).toBeVisible();
  await expect(page).toHaveURL(/#\/work$/);
  await page.keyboard.press("Escape");

  // Discard goes to the task's screen with its own confirmation open; keeping them deletes nothing.
  const branchesBefore = botbenchBranches(seeded.repo);
  await moreButton(page, failedRow).click();
  await items(menuOf(page, failedRow)).last().click();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${seeded.failed.id}$`));
  const discard = page.getByRole("alertdialog");
  await expect(discard.getByRole("heading", { name: "Discard what this task left?" })).toBeVisible();
  await discard.getByRole("button", { name: "Keep them" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(botbenchBranches(seeded.repo)).toEqual(branchesBefore);
});

test("a chat row offers only Rename and Hide; renaming shows the owner's name and clearing it brings the first message back; hiding and showing delete nothing", async ({ page, botbench, seeded }) => {
  await signIn(page, botbench);
  await openWork(page);
  await showGroup(page, /^Chats/);
  const chatRow = "chat Name one primary colour.";
  await expect(group(page).getByRole("link", { name: /Name one primary colour\./ })).toHaveAttribute("href", `#/chats/${seeded.chat}`);
  await expect(group(page)).toContainText("Chat · Codex");
  await moreButton(page, chatRow).click();
  await expect(items(menuOf(page, chatRow))).toHaveText(["Rename chat", "Hide from the list"]);
  await checkDesign(page, "work, a chat's More menu open");

  // Rename: the owner's name, trimmed; the chat's messages are as they were.
  const before = (await (await page.request.get(`${botbench.base}/api/attempts/${seeded.chat}/events`)).json()) as { events: unknown[] };
  await items(menuOf(page, chatRow)).first().click();
  const rename = page.getByTestId("rename-chat");
  await expect(rename.getByRole("heading", { name: "Rename the chat" })).toBeVisible();
  await checkDesign(page, "work, Rename the chat");
  await rename.getByLabel("Chat name").fill("  Colours for the logo  ");
  await rename.getByRole("button", { name: "Save name" }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.getByTestId("row-said")).toHaveText("The chat was renamed.");
  const renamedRow = "chat Colours for the logo";
  await expect(moreButton(page, renamedRow)).toBeVisible();
  // Cleared, the chat is named by its first message again.
  await moreButton(page, renamedRow).click();
  await items(menuOf(page, renamedRow)).first().click();
  await expect(rename.getByLabel("Chat name")).toHaveValue("Colours for the logo");
  await rename.getByLabel("Chat name").fill("");
  await rename.getByRole("button", { name: "Save name" }).click();
  await expect(moreButton(page, chatRow)).toBeVisible();
  expect(((await (await page.request.get(`${botbench.base}/api/attempts/${seeded.chat}/events`)).json()) as { events: unknown[] }).events).toEqual(before.events);

  // Hide: gone from the list and counted; among the hidden rows it offers Show in the list.
  const copies = worktreeCount(seeded.repo);
  await moreButton(page, chatRow).click();
  await items(menuOf(page, chatRow)).last().click();
  await expect(page.getByTestId("row-said")).toContainText("Nothing was deleted");
  await expect(moreButton(page, chatRow)).toHaveCount(0);
  await page.getByRole("button", { name: "Show hidden (1)" }).click();
  await expect(page.getByTestId("hidden-view")).toContainText("Rows hidden from the list (1).");
  await showGroup(page, /^Chats/);
  await moreButton(page, chatRow).click();
  await expect(items(menuOf(page, chatRow))).toHaveText(["Rename chat", "Show in the list"]);
  await checkDesign(page, "work, the hidden rows with a chat's More menu open");
  await items(menuOf(page, chatRow)).last().click();
  await page.getByRole("button", { name: "Back to the list" }).click();
  await showGroup(page, /^Chats/);
  await expect(moreButton(page, chatRow)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Show hidden/ })).toHaveCount(0);
  expect(worktreeCount(seeded.repo)).toBe(copies);

  // The row opens the chat on Chat.
  await group(page).getByRole("link", { name: /Name one primary colour\./ }).click();
  await expect(page).toHaveURL(/#\/turn$/);
  await expect(page.getByRole("region", { name: "Transcript" })).toContainText("Name one primary colour.");
});
