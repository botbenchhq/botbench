import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { storeChecks } from "../test/support/checks.ts";
import { git, initRepo, write } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkLayout, checkWords, expect, SHOTS, signIn, watchRefused } from "./helpers.ts";

// The review of a task on its screen rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), at the task's own address, in the real
// client against a real Botbench process, which serves it with its real content security policy. No model turn: before
// Botbench starts, three tasks are put in its real store through the engine itself, each with its work committed to its
// real branch in a real temporary repository, and their checks stored as the engine stores them (test/support/checks.ts).
// The old design checks (checkDesign) do not apply to this screen: it is not drawn with the design system's classes.
// What is checked in their place: the words (docs/product/voice.md), that the page loads nothing the policy refuses,
// that every control is at least 40px high with a mouse and 44px on a phone, and that nothing scrolls sideways.

const CHECK = "grep -q 'a + b' calc.py";

interface Seeded {
  home: string;
  repo: string;
  /** Its checks passed on the commit its branch holds. */
  current: { id: number; title: string; commit: string; branch: string };
  /** Its checks passed on the commit it started from, not the one its branch holds. */
  outOfDate: { id: number; base: string; commit: string };
  /** In a repository with no checks. */
  unchecked: { id: number };
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench; refused: string[] }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-next-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo-refine");
    const plain = path.join(dir, "plain");
    const files = { "calc.py": "def add(a, b):\n    return a - b\n" };
    const baseCommit = initRepo(repo, files);
    initRepo(plain, files);
    const db = openStore(home);
    const build = async (where: string, prompt: string): Promise<{ id: number; commit: string; branch: string }> => {
      const task = createTask(db, { repo: where, prompt });
      const worktree = await createWorktree({ repo: where, home, run: `run-${task.runId}`, task: `task-${task.id}` });
      moveTask(db, task.id, "building", { worktree });
      write(worktree.path, "calc.py", "def add(a, b):\n    return a + b\n");
      const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
      if (!committed.committed) throw new Error("nothing was committed");
      return { id: task.id, commit: committed.commit, branch: git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD").trim() };
    };
    const title = "Add a function that adds two numbers";
    const current = await build(repo, title);
    storeChecks(db, current.id, current.commit, "passed", CHECK);
    moveTask(db, current.id, "awaiting_decision", { headCommit: current.commit, checks: "passed" });
    const outOfDate = await build(repo, "Make add return the sum");
    storeChecks(db, outOfDate.id, baseCommit, "passed", CHECK);
    moveTask(db, outOfDate.id, "awaiting_decision", { headCommit: outOfDate.commit, checks: "passed" });
    const unchecked = await build(plain, "Fix add in the plain repository");
    moveTask(db, unchecked.id, "awaiting_decision", { headCommit: unchecked.commit, checks: "none" });
    db.close();
    await use({ home, repo: fs.realpathSync(repo), current: { ...current, title }, outOfDate: { id: outOfDate.id, base: baseCommit, commit: outOfDate.commit }, unchecked: { id: unchecked.id } });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [seeded.repo]: { checks: [CHECK] } } } });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
  // Everything the browser refused or complained of while the test ran (helpers.ts, `watchRefused`).
  refused: async ({ page }, use) => use(await watchRefused(page)),
});

const short = (commit: string): string => commit.slice(0, 7);
const open = (page: Page, botbench: Botbench, id: number): Promise<unknown> => page.goto(`${botbench.base}/#/tasks/${id}`);
const actions = (page: Page) => page.getByTestId("decision-actions").getByRole("button");

/** A picture of the screen at `<BOTBENCH_SHOTS>/<name>.png` when BOTBENCH_SHOTS names a folder (docs/design/built). */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("the rebuilt review shows the task's real title, checks and diff under the real content security policy, in dark and in light, and Accept accepts it", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    const policy = (await page.request.get(botbench.base)).headers()["content-security-policy"]!;
    // The policy is the server's own, unchanged by this screen: nothing inline is allowed but the one hashed script.
    expect(policy).toMatch(/^default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/);

    await open(page, botbench, seeded.current.id);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(seeded.current.title);
    await expect(page).toHaveTitle(`Task ${seeded.current.id} – Botbench`);
    await expect(page.getByTestId("task-state")).toHaveText("Ready for review");
    await expect(page.getByTestId("branch")).toHaveText(seeded.current.branch);
    await expect(page.getByTestId("commit")).toHaveText(short(seeded.current.commit));
    // The navigation holds the screens that exist, and names the open task.
    await expect(page.getByRole("navigation", { name: "Screens" }).getByRole("link")).toHaveText(["Chat", "Work", "Settings"]);
    await expect(page.getByRole("link", { name: seeded.current.title })).toHaveAttribute("aria-current", "page");

    // An overlay the library places itself (the whole commit, on hover or focus) is placed under the same policy: beneath its trigger.
    await page.getByTestId("commit").hover();
    await expect(page.getByTestId("commit-whole")).toHaveText(seeded.current.commit);
    const [trigger, tip] = [(await page.getByTestId("commit").boundingBox())!, (await page.getByTestId("commit-whole").boundingBox())!];
    expect(tip.y).toBeGreaterThan(trigger.y + trigger.height - 1);
    expect(Math.abs(tip.x + tip.width / 2 - (trigger.x + trigger.width / 2))).toBeLessThan(8);
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("commit-whole")).toHaveCount(0);

    // The checks as the API reports them, and the server's own sentence about the evidence.
    const verification = page.getByTestId("verification");
    await expect(verification.getByTestId("verification-heading")).toHaveText("1 of 1 check passed");
    await expect(verification.getByTestId("evidence-words")).toHaveText(`Evidence is current: the checks passed on commit ${short(seeded.current.commit)}, the commit Accept keeps.`);
    await expect(verification).toContainText(CHECK);
    await expect(verification).toContainText(`Botbench ran it on commit ${short(seeded.current.commit)}.`);
    await expect(verification.getByTestId("not-reviewed")).toHaveText("Not reviewed: this run has no reviewer.");
    await verification.getByRole("button", { name: `Output of ${CHECK}` }).click();
    await expect(verification.getByRole("group", { name: `Output of ${CHECK}` })).toHaveText("ok");

    // The changed file with its real diff, from the API.
    const files = page.getByRole("tabpanel").getByTestId("changed-files");
    await expect(files.getByRole("heading")).toHaveText("1 file changed");
    await expect(files.getByTestId("diff").locator("[data-line=removed]")).toHaveText("2−    return a - b");
    await expect(files.getByTestId("diff").locator("[data-line=added]")).toHaveText("2+    return a + b");
    await expect(files.getByTestId("diff").locator("[data-line=context]")).toHaveText("1 def add(a, b):");

    // The decision: what accepting will do, and Accept as the one filled button.
    const decision = page.getByTestId("decision");
    await expect(decision.getByRole("heading")).toHaveText("Your decision");
    await expect(decision.getByTestId("accepting-will").getByRole("listitem")).toHaveText(["Keep the branch on this Mac, for you to merge yourself", "Remove the task's copy of the project", "Push or merge nothing"]);
    await expect(actions(page)).toHaveText(["Reject", "Accept"]);
    const filled = await actions(page).evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor !== "rgba(0, 0, 0, 0)"));
    expect(filled).toEqual([false, true]);

    // The theme is the approved direction's, in the appearance the owner chose: dark by default.
    const colours = (): Promise<string[]> => page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector("[data-testid=decision]")!).backgroundColor, getComputedStyle(document.querySelector("[data-testid=decision-actions] button:last-child")!).backgroundColor]);
    expect(await colours()).toEqual(["rgb(17, 19, 22)", "rgb(32, 36, 43)", "rgb(124, 183, 255)"]);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"Inter Variable"/);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=diff]")!).fontFamily)).toMatch(/^"JetBrains Mono Variable"/);
    await checkLayout(page, 32, "review, 1440, dark");
    await checkWords(page, "review, rebuilt");
    await shot(page, "review-1440-dark");

    // Light, chosen as Settings stores it, applied before the first paint by the page's own script.
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
    await page.reload();
    await expect(page.getByTestId("verification-heading")).toHaveText("1 of 1 check passed");
    await expect(page.locator("[data-testid=diff] [data-line=added]")).toBeVisible();
    expect(await colours()).toEqual(["rgb(245, 246, 247)", "rgb(255, 255, 255)", "rgb(33, 91, 184)"]);
    await shot(page, "review-1440-light");
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
    await page.reload();
    await expect(page.getByTestId("verification-heading")).toBeVisible();

    // Reject asks first, with the focus on the button that changes nothing; Escape closes it and nothing is sent.
    await actions(page).filter({ hasText: "Reject" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Reject this task?" });
    await expect(dialog.getByRole("radio", { name: "Keep the branch" })).toBeChecked();
    await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Reject"]);
    await checkLayout(page, 32, "review, the Reject dialog");
    await checkWords(page, "review, the Reject dialog");
    await shot(page, "review-1440-dark-reject");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("task-state")).toHaveText("Ready for review");

    // Accept, through the real decision API: the branch is kept at the commit that was checked, and the copy is gone.
    await page.getByTestId("decision-note").fill("Reads right");
    await actions(page).filter({ hasText: "Accept" }).click();
    await expect(decision.getByTestId("decision-result")).toContainText("Accepted");
    await expect(page.getByTestId("task-state")).toHaveText("Accepted");
    await expect(decision.getByRole("heading")).toBeFocused();
    await expect(decision.getByTestId("decided-branch")).toHaveText(seeded.current.branch);
    const stored = (await (await page.request.get(`${botbench.base}/api/tasks/${seeded.current.id}`)).json()) as { status: string; decision: { decision: string; note: string; checks: string; checksCommit: string } };
    expect(stored).toMatchObject({ status: "accepted", decision: { decision: "accept", note: "Reads right", checks: "passed", checksCommit: seeded.current.commit } });
    expect(git(seeded.repo, "rev-parse", seeded.current.branch).trim()).toBe(seeded.current.commit);
    expect(fs.existsSync(path.join(seeded.home, "worktrees", `run-${seeded.current.id}`, `task-${seeded.current.id}`))).toBe(false);
    await checkWords(page, "review, rebuilt, accepted");

    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
    // And the record above would have held one: a style element written into the page now is refused, and is recorded.
    await page.evaluate(() => document.head.append(Object.assign(document.createElement("style"), { textContent: "body{}" })));
    await expect.poll(() => refused.some((line) => line.startsWith("policy: style-src-elem refused inline"))).toBe(true);
  });

  test("checks that are out of date take Accept away and offer Run checks again, which runs the real check on the commit the branch holds", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    await open(page, botbench, seeded.outOfDate.id);
    const words = page.getByTestId("verification").getByTestId("evidence-words");
    await expect(words).toHaveText(`The checks are out of date: they ran on commit ${short(seeded.outOfDate.base)}, and the branch is now at commit ${short(seeded.outOfDate.commit)}. Run checks again to check the commit you would accept.`);
    // No Accept in any wording, and no filled button: Run checks again is never the view's primary action.
    await expect(actions(page)).toHaveText(["Reject", "Run checks again"]);
    await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    expect(await actions(page).evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor))).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    await expect(page.getByTestId("task-status")).toHaveText("Ready for review. Its checks are out of date, so it cannot be accepted until they are run again; you can still reject it.");
    // A check that passed on another commit keeps its word and is not drawn as a success.
    const passed = page.getByTestId("verification").getByText("Passed", { exact: true });
    expect(await passed.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(173, 180, 190)");
    await checkWords(page, "review, rebuilt, out of date");
    await shot(page, "review-1440-dark-out-of-date");

    await actions(page).filter({ hasText: "Run checks again" }).click();
    await expect(words).toHaveText(`Evidence is current: the checks passed on commit ${short(seeded.outOfDate.commit)}, the commit Accept keeps.`, { timeout: 60_000 });
    await expect(actions(page)).toHaveText(["Reject", "Accept"]);
    expect(refused).toEqual([]);
  });
});

test.describe("at 390×844, on a phone", () => {
  test("work no check ran on is offered as Accept without verification, outlined, in one column that does not scroll sideways", async ({ page, botbench, seeded, refused }) => {
    await signIn(page, botbench);
    await open(page, botbench, seeded.unchecked.id);
    await expect(page.getByTestId("verification-heading")).toHaveText("No checks are set up for this repository");
    await expect(page.getByTestId("verification").getByTestId("evidence-words")).toHaveText("No checks are set up for this repository, so nothing verified this work. You can accept it without verification.");
    // Under 1024px the decision stays in reach at the foot of the window, and its panel is a sheet, one tap away.
    const foot = page.getByTestId("foot-actions").getByRole("button");
    await expect(foot).toHaveText(["Reject", "Accept without verification"]);
    await expect(page.getByTestId("foot-line")).toHaveText("No checks ran on this work.");
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    expect(await foot.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor))).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    await expect(page.locator("[data-testid=diff] [data-line=added]")).toBeVisible();
    await checkLayout(page, 44, "review, 390");
    await checkWords(page, "review, rebuilt, phone");
    await shot(page, "review-390-dark");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "review-390-dark-full.png"), fullPage: true });

    // The navigation is the bar at the foot, and the decision's panel opens as a sheet with the same buttons.
    await expect(page.getByRole("navigation", { name: "Screens" }).getByRole("link")).toHaveText(["Chat", "Work", "Settings"]);
    await expect(page.getByRole("button", { name: "Screens menu" })).toBeHidden();
    await page.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "Decision" });
    await expect(sheet.getByTestId("accepting-will").getByRole("listitem")).toHaveCount(3);
    await expect(actions(page)).toHaveText(["Reject", "Accept without verification"]);
    await checkLayout(page, 44, "review, 390, the decision sheet");
    await shot(page, "review-390-dark-sheet");

    await actions(page).filter({ hasText: "Accept without verification" }).click();
    await expect(page.getByTestId("decision-result")).toContainText("Accepted without verification");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-state")).toHaveText("Accepted");
    await expect(page.getByTestId("task-status")).toHaveText(/^Accepted without verification: no checks ran on it\. /);
    expect(refused).toEqual([]);
  });
});
