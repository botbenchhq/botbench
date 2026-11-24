import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createBroker } from "../src/approvals/broker.ts";
import { decideTask } from "../src/engine/decision.ts";
import { approvePlan, cancelRun, createRun, storePlan } from "../src/engine/run.ts";
import { insertEvidence, nextRound, startCommandList } from "../src/engine/stations.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { askCancelRun, checkScreen, expect, SHOTS, signIn, watchRefused } from "./helpers.ts";

// The task screen and the run screen with content as long as real work makes it, at every width the shell has a layout
// for, in the real client against a real Botbench process. No model turn: before Botbench starts, the tasks and runs are
// put in its real store through the engine itself (as e2e/next-review.e2e.ts and e2e/run.e2e.ts do), with their work
// committed to real branches in a real temporary repository. What is long: titles (one of 190 characters, one a single
// token with no place to break), the branch (a run and task name at the 64 characters a worktree allows), fourteen
// changed files at deep paths with lines of 400 characters, a check command and its output, a failure's reason, and a
// plan of twelve tasks whose criteria are sentences. What is checked at each width: nothing is drawn past the edge of
// the screen and the page does not scroll sideways (a diff or a command scrolls inside its own box), no control is
// under its floor, no text is under 12px, and no line of text is cut short without a mark that it was.

const LONG_TITLE = "Rework the nightly billing export so that every invoice line carries its tax jurisdiction, its currency and its rounding rule, and the exporter retries a failed upload three times before it gives up";
const TOKEN = "RoundingRuleForInvoiceLinesInTheEuropeanUnionValueAddedTaxJurisdictionExporterFactoryBuilderRegistry";
const TOKEN_TITLE = `Rename ${TOKEN}_${TOKEN} everywhere`;
const DEEP = "src/modules/billing/exporters/jurisdictions/european-union/value-added-tax";
const LONG_LINE = `export const roundingRule = { ${Array.from({ length: 24 }, (_, i) => `jurisdiction${i}: "half-even"`).join(", ")} };`;
const CHECK = `node --experimental-strip-types scripts/verify-the-billing-export.ts --jurisdictions european-union,united-kingdom,switzerland --currencies EUR,GBP,CHF --fail-on-rounding-difference && grep -q half-even ${DEEP}/rounding-rules-for-invoice-lines-1.ts`;
const OUTPUT = `${Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - the exporter writes invoice line ${i + 1} with its jurisdiction, its currency and its rounding rule, and a comma inside a field is escaped as the specification says`).join("\n")}\n/${"very-long-path-segment/".repeat(12)}report.json\n`;
const REASON = `Claude Code stopped with an error after 14 steps: the command "${CHECK}" could not be run in the task's copy of the project, because the folder ${DEEP}/rounding-rules does not exist there. What it wrote up to then is committed to the task's branch and kept in the task's copy.`;
const PLAN = Array.from({ length: 12 }, (_, i) => ({
  title: i === 3 ? `Rename ${TOKEN} in the exporter` : `Task ${i + 1}: carry the tax jurisdiction, the currency and the rounding rule on every invoice line the exporter writes for region ${i + 1}`,
  criteria: [
    `Every invoice line written for region ${i + 1} names its jurisdiction, and a line with no jurisdiction fails the export with a message that names the invoice and the line`,
    `The file ${DEEP}/rounding-rules-for-invoice-lines-${i + 1}.ts exports the rule, and \`${CHECK.slice(0, 90)}\` passes`,
    "A comma inside a field is escaped",
  ],
}));

interface Seeded {
  home: string;
  repo: string;
  tasks: Record<"current" | "stale" | "differs" | "failed" | "stopped" | "accepted" | "rejected" | "refused", number>;
  runs: Record<"gate" | "done" | "cancelled", number>;
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench; refused: string[] }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-stress-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repository-of-the-billing-service-with-a-long-name");
    const baseCommit = initRepo(repo, { "README.md": "# Billing\n" });
    const db = openStore(home);
    const long = (id: number): string => `task-${id}-carry-the-jurisdiction-on-every-invoice-line-written`.slice(0, 64);
    const built = async (taskId: number, runId: number | null, files = 14): Promise<string> => {
      const worktree = await createWorktree({ repo, home, run: `run-${runId ?? taskId}-rework-the-nightly-billing-export-jurisdictions`.slice(0, 64), task: long(taskId) });
      moveTask(db, taskId, "building", { worktree });
      for (let i = 1; i <= files; i++) write(worktree.path, `${DEEP}/rounding-rules-for-invoice-lines-${i}.ts`, `// Rounding for region ${i}\n${LONG_LINE}\n${"export const more = 1;\n".repeat(i === 1 ? 60 : 2)}`);
      write(worktree.path, "README.md", "# Billing\n\nEvery invoice line carries its jurisdiction.\n");
      const committed = await commitWork({ path: worktree.path, message: `Botbench task ${taskId}` });
      if (!committed.committed) throw new Error("nothing was committed");
      return committed.commit;
    };
    const checked = (taskId: number, commit: string, outcome: "passed" | "failed" = "passed"): void => {
      const round = nextRound(db, taskId, "check");
      startCommandList(db, taskId, "check", round, 2);
      const run = { outcome, exitCode: outcome === "passed" ? 0 : 1, signal: null, truncated: false, limitMs: 600_000, startedAt: "2026-11-23T10:00:00.000Z", endedAt: "2026-11-23T10:02:11.000Z", durationMs: 131_000 };
      insertEvidence(db, taskId, "check", 1, { ...run, command: CHECK, output: OUTPUT }, round, null, commit);
      insertEvidence(db, taskId, "check", 2, { ...run, outcome: "passed", exitCode: 0, command: "npm test", output: "ok\n" }, round, null, commit);
    };
    const review = async (prompt: string, state: "current" | "stale" | "differs"): Promise<number> => {
      const task = createTask(db, { repo, prompt });
      const commit = await built(task.id, task.runId);
      checked(task.id, state === "stale" ? baseCommit : commit);
      const moved = moveTask(db, task.id, "awaiting_decision", { headCommit: commit, checks: "passed" });
      if (state === "differs") write(moved.worktreePath!, `${DEEP}/a-file-the-checks-left-behind-with-a-long-name.log`, "left\n");
      return task.id;
    };
    const current = await review(LONG_TITLE, "current");
    const stale = await review(TOKEN_TITLE, "stale");
    const differs = await review(`${LONG_TITLE} (the copy differs)`, "differs");

    const failedTask = createTask(db, { repo, prompt: LONG_TITLE });
    await built(failedTask.id, failedTask.runId, 2);
    moveTask(db, failedTask.id, "failed", { reason: REASON });
    const stoppedTask = createTask(db, { repo, prompt: TOKEN_TITLE });
    await built(stoppedTask.id, stoppedTask.runId, 2);
    moveTask(db, stoppedTask.id, "interrupted", { reason: "You stopped it. What its agent wrote up to then is committed to the task's branch and kept in the task's copy of the project." });

    const accepted = await review(LONG_TITLE, "current");
    await decideTask(db, { taskId: accepted, decision: "accept", note: `Good. ${"The rounding rule reads well and the retries are bounded. ".repeat(7)}`.slice(0, 480) });
    const rejected = await review(TOKEN_TITLE, "current");
    await decideTask(db, { taskId: rejected, decision: "reject", branch: "keep", note: `${TOKEN} is not the name we agreed on; ${"rename it and send it again. ".repeat(8)}`.slice(0, 480) });

    // A fully autonomous run's task whose builder was refused commands without asking (as e2e/refused.e2e.ts puts them).
    const full = createRun(db, { repo, prompt: LONG_TITLE, baseCommit, mode: "full", reviewer: null });
    const fullTask = approvePlan(db, full.id, storePlan(db, full.id, PLAN.slice(0, 1)).planVersion, null, "mode").tasks[0]!;
    const at = new Date().toISOString();
    const attemptId = Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', NULL, NULL, 'ended', NULL, ?, ?)").run(at, at).lastInsertRowid);
    const worktree = await createWorktree({ repo, home, run: `run-${full.id}`, task: `task-${fullTask.id}` });
    moveTask(db, fullTask.id, "building", { worktree, attemptId });
    const broker = createBroker({ db, home, onChange: () => {} });
    for (const [i, command] of [`sudo ${CHECK}`, `sudo rm -rf /${"very-long-path-segment/".repeat(12)}`, `sudo ${TOKEN}${TOKEN} --now`].entries()) {
      const answer = await broker.request({ taskId: fullTask.id, attemptId, role: "implementer", tool: "Bash", command, input: { command }, reason: null, toolCallId: `toolu_unreported_${i}` });
      if (answer.decision !== "decline") throw new Error(`Botbench did not refuse ${command.slice(0, 40)}`);
    }
    await broker.close();
    write(worktree.path, `${DEEP}/rounding-rules-for-invoice-lines-1.ts`, `${LONG_LINE}\n`);
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${fullTask.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    checked(fullTask.id, committed.commit);
    moveTask(db, fullTask.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed", reason: "Its agent was refused 3 commands without asking, so the run did not accept it for you." });

    // Runs: one whose long plan waits, one that ended with every task decided, one cancelled at its plan.
    const gate = createRun(db, { repo, prompt: LONG_TITLE, baseCommit, mode: "manual", preapproved: [CHECK.split(" && ")[0]!, "npm test", `sh ${DEEP}/scripts/prepare-the-fixtures.sh`] });
    storePlan(db, gate.id, PLAN);
    const done = createRun(db, { repo, prompt: TOKEN_TITLE, baseCommit });
    storePlan(db, done.id, PLAN.slice(2, 5));
    for (const task of approvePlan(db, done.id, 1).tasks) {
      const commit = await built(task.id, done.id, 1);
      moveTask(db, task.id, "awaiting_decision", { headCommit: commit, checks: "none" });
      await decideTask(db, { taskId: task.id, decision: "accept", withoutVerification: true });
    }
    const cancelled = createRun(db, { repo, prompt: LONG_TITLE, baseCommit, mode: "semi" });
    storePlan(db, cancelled.id, PLAN.slice(0, 4));
    cancelRun(db, cancelled.id);
    db.close();
    await use({ home, repo: fs.realpathSync(repo), tasks: { current, stale, differs, failed: failedTask.id, stopped: stoppedTask.id, accepted, rejected, refused: fullTask.id }, runs: { gate: gate.id, done: done.id, cancelled: cancelled.id } });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [seeded.repo]: { checks: [CHECK, "npm test"] } } } });
    await use(botbench);
    await botbench.stop();
  },
  refused: async ({ page }, use) => use(await watchRefused(page)),
});

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `stress-${name}.png`), fullPage });
}

/**
 * What long content breaks, read from the drawn page: an element whose box ends past the right edge of the screen and is
 * not inside a box that scrolls or clips sideways, and a line of text cut short by its box with nothing to say so (no
 * ellipsis, no scrolling, no wrapping).
 */
async function contentFits(page: Page, screen: string): Promise<void> {
  const found = await page.evaluate(() => {
    const contained = (el: Element): boolean => {
      for (let up = el.parentElement; up !== null && up !== document.body; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== "visible" && up.getBoundingClientRect().right <= window.innerWidth + 1) return true;
      }
      return false;
    };
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    const past: string[] = [];
    const cut: string[] = [];
    for (const el of document.querySelectorAll("main *, aside *, [role=dialog] *, [role=alertdialog] *, [data-testid=foot] *")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height <= 1) continue;
      const style = getComputedStyle(el);
      if (box.right > window.innerWidth + 1 && style.position !== "fixed" && !contained(el)) past.push(name(el));
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX === "hidden" && style.textOverflow !== "ellipsis" && !(el as HTMLElement).classList.contains("sr-only") && [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "")) cut.push(name(el));
    }
    return { past: past.slice(0, 8), cut: cut.slice(0, 8), sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect.soft(found, screen).toEqual({ past: [], cut: [], sideways: 0 });
}

/** With the page scrolled to its end, the content's last line is above what stays at the foot of a small screen (the decision, the navigation). */
async function endIsInReach(page: Page, screen: string): Promise<void> {
  const hidden = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const main = document.querySelector("main")!;
    const end = main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom);
    const over = [...document.querySelectorAll("[data-testid=foot], nav[aria-label=Screens]")].reduce<number>((top, el) => Math.min(top, el.getBoundingClientRect().top), window.innerHeight);
    return Math.max(0, Math.round(end - over));
  });
  expect.soft(hidden, `${screen}: the end of the content is not under what stays at the foot`).toBe(0);
}

async function appearance(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.evaluate((mode) => window.localStorage.setItem("botbench.appearance", mode), mode);
  await page.reload();
}

test("a task with long content in each state it can end in keeps inside the screen at every width, in dark and in light", async ({ page, botbench, seeded, refused }) => {
  test.setTimeout(600_000);
  await signIn(page, botbench);
  for (const [name, id] of Object.entries(seeded.tasks)) {
    for (const size of WIDTHS) {
      await page.setViewportSize(size);
      await page.goto(`${botbench.base}/#/tasks/${id}`);
      await expect(page.getByTestId("task-state")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await contentFits(page, `task, ${name}, ${size.width}`);
      if (size.width < 1024) await endIsInReach(page, `task, ${name}, ${size.width}`);
      if (size.width < 1024) await shot(page, `end-task-${name}-${size.width}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      // The bar is one line: the task's name is cut short beside its state, not stacked over it.
      expect.soft(await page.getByRole("navigation", { name: "Where this is" }).evaluate((nav) => nav.getBoundingClientRect().height), `task, ${name}, ${size.width}: the bar is one line`).toBeLessThan(48);
      // The copy button stands beside the branch, however many lines the branch takes.
      if ((await page.getByTestId("branch").count()) > 0) {
        // Both boxes are read in one look at the page: read one after the other, a header that moves between the two (the task's sentence arriving) gave boxes from two layouts.
        const beside = await page.getByTestId("branch").evaluate((code) => {
          const branch = code.getBoundingClientRect();
          const copy = code.parentElement!.querySelector("button")!.getBoundingClientRect();
          const middle = copy.top + copy.height / 2;
          return { inItsLines: middle > branch.top && middle < branch.bottom, rightOfIt: copy.left >= branch.right - 1, insideTheScreen: copy.right <= window.innerWidth };
        });
        expect.soft(beside, `task, ${name}, ${size.width}: the copy button is beside the branch`).toEqual({ inItsLines: true, rightOfIt: true, insideTheScreen: true });
      }
      if ((await page.getByTestId("verification").count()) > 0) {
        // A check's mark is at the start of its command's first line, and every changed file's whole path can be read.
        const marks = await page.getByTestId("verification").locator("svg + code").evaluateAll((codes) => codes.map((code) => { const mark = code.previousElementSibling!.getBoundingClientRect(); const text = code.getBoundingClientRect(); return mark.right <= text.left && Math.abs(mark.top - text.top) < 8; }));
        expect.soft(marks, `task, ${name}, ${size.width}: each check's mark is beside its command`).toEqual(marks.map(() => true));
        expect.soft(marks.length).toBe(2);
        const paths = await page.getByTestId("changed-files").locator("button code").evaluateAll((codes) => codes.map((code) => { const box = code.getBoundingClientRect(); const card = code.closest("[data-testid=changed-files]")!.getBoundingClientRect(); return code.scrollWidth <= code.clientWidth + 1 || getComputedStyle(code).display === "inline" ? box.right <= card.right : false; }));
        expect.soft(paths, `task, ${name}, ${size.width}: each changed file's whole path is inside its card`).toEqual(paths.map(() => true));
      }
      await checkScreen(page, `task, ${name}, ${size.width}`, { floor: size.width === 390 ? 44 : 32 });
      await shot(page, `task-${name}-${size.width}-dark`, size.width === 390 || size.width === 1440);
      if (size.width === 390 || size.width === 1280) {
        await appearance(page, "light");
        await expect(page.getByTestId("task-state")).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, `task-${name}-${size.width}-light`, true);
        await appearance(page, "dark");
      }
    }
  }
  expect(refused).toEqual([]);
});

test("a run with a long plan, one that is done and one that was cancelled keep inside the screen at every width", async ({ page, botbench, seeded, refused }) => {
  test.setTimeout(600_000);
  await signIn(page, botbench);
  for (const [name, id] of Object.entries(seeded.runs)) {
    for (const size of WIDTHS) {
      await page.setViewportSize(size);
      await page.goto(`${botbench.base}/#/runs/${id}`);
      await expect(page.getByTestId("run-state")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await contentFits(page, `run, ${name}, ${size.width}`);
      if (size.width < 1024) await endIsInReach(page, `run, ${name}, ${size.width}`);
      if (size.width < 1024) await shot(page, `end-run-${name}-${size.width}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      // From 768px the bar names the repository on the line of the run's number, cut short when it is long.
      if (size.width >= 768) {
        const [number, repo] = [(await page.getByRole("navigation", { name: "Where this is" }).getByText(`Run ${id}`, { exact: true }).boundingBox())!, (await page.getByTestId("run-bar-repo").boundingBox())!];
        expect.soft(Math.abs(number.y + number.height / 2 - (repo.y + repo.height / 2)), `run, ${name}, ${size.width}: the repository is on the bar's one line`).toBeLessThan(6);
      }
      await checkScreen(page, `run, ${name}, ${size.width}`, { floor: size.width === 390 ? 44 : 32 });
      await shot(page, `run-${name}-${size.width}-dark`, size.width === 390 || size.width === 1440);
      if (size.width === 390 || size.width === 1280) {
        await appearance(page, "light");
        await expect(page.getByTestId("run-state")).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, `run-${name}-${size.width}-light`, true);
        await appearance(page, "dark");
      }
    }
  }
  expect(refused).toEqual([]);
});

test("the sheets and dialogs of a task and a run hold long content inside the screen on a phone and at 1440", async ({ page, botbench, seeded, refused }) => {
  test.setTimeout(300_000);
  await signIn(page, botbench);
  for (const size of [WIDTHS[0], WIDTHS[4]]) {
    const phone = size.width === 390;
    await page.setViewportSize(size);
    const look = async (name: string): Promise<void> => {
      // A sheet or a dialog still growing into place is drawn half-way: wait for it, with a limit.
      await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))), new Promise((resolve) => setTimeout(resolve, 600))]));
      await shot(page, `${name.replaceAll(/[^a-z]+/g, "-")}-${size.width}-dark`);
      await contentFits(page, `${name}, ${size.width}`);
      // The radio buttons of the Reject dialog are 42px under a finger (web/src/ui/radio-group.tsx, another unit's): there, only the words and the width.
      await checkScreen(page, `${name}, ${size.width}`, { floor: phone ? 44 : 32, least: name === "task, the reject dialog" });
    };
    // Reject, from the review: on a phone the decision's sheet first.
    await page.goto(`${botbench.base}/#/tasks/${seeded.tasks.differs}`);
    await expect(page.getByTestId("task-state")).toBeVisible();
    if (phone) {
      await page.getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await look("task, the decision sheet");
      await page.keyboard.press("Escape");
    }
    await page.getByTestId(phone ? "foot" : "decision").getByRole("button", { name: "Reject" }).click();
    await expect(page.getByRole("alertdialog", { name: "Reject this task?" })).toBeVisible();
    await look("task, the reject dialog");
    await page.keyboard.press("Escape");
    // Discard, from a failed task: on a phone what is kept is a sheet.
    await page.goto(`${botbench.base}/#/tasks/${seeded.tasks.failed}`);
    await expect(page.getByTestId("task-state")).toBeVisible();
    if (phone) {
      await page.getByTestId("foot").getByRole("button", { name: "What is kept" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await look("task, the kept sheet");
    }
    await page.getByRole("button", { name: "Discard…" }).click();
    await expect(page.getByRole("alertdialog", { name: "Discard what this task left?" })).toBeVisible();
    await look("task, the discard dialog");
    await page.keyboard.press("Escape");
    // Cancel run, and a plan's task opened for editing.
    await page.goto(`${botbench.base}/#/runs/${seeded.runs.gate}`);
    await expect(page.getByTestId("run-state")).toBeVisible();
    await askCancelRun(page);
    await look("run, the cancel dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("list", { name: "Plan" }).locator(":scope > li").nth(3).getByRole("button").first().click();
    await look("run, a plan task being edited");
  }
  expect(refused).toEqual([]);
});
