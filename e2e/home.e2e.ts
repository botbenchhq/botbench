import { checkWords, expect } from "./helpers.ts";
import { appearance, ASKING, ASKS, checkLayout, MANY, shot, signInAtHome, startTask, test } from "./home-seed.ts";

// Home, the queue, in the real client against a real Botbench process, which serves it with its real content security
// policy. No model turn (e2e/home-seed.ts says how each state is reached). What is checked: Botbench opens on Home; the
// headline and every group are the server's counts and order; the first thing that needs the owner carries the screen's
// one primary action, and it leads to the request itself; the words (docs/product/voice.md); that nothing is refused
// by the policy; that controls are 40px high with a mouse and 44px on a phone, and nothing scrolls sideways.

const needs = (page: import("@playwright/test").Page) => page.getByTestId("needs-you");

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("Botbench opens on Home: the situation in words, what needs you whole and in the stated order with one primary action, then what is in progress, what waits and for what, and what was accepted", async ({ page, botbench, seeded, refused }) => {
    await signInAtHome(page, botbench);
    const working = await startTask(page, botbench, seeded.repo, "Add a greeting to the README");
    await expect(page.getByTestId("headline")).toHaveText("5 things need you, 1 is in progress");
    await expect(page).toHaveTitle("Home – Botbench");
    await expect(page.getByText("1 is waiting and goes on by itself. 2 completed in the last day. 12 in all.")).toBeVisible();

    // The navigation: Home first and marked as the screen shown, with the server's count of what needs the owner.
    const nav = page.getByRole("navigation", { name: "Screens" });
    await expect(nav.getByRole("link")).toHaveText([/^Home/, "Work", "Chat", "Settings"]);
    await expect(nav.getByRole("link", { name: /^Home/ })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByTestId("home-count")).toHaveText("5 waiting for you");

    // Needs you: all five, an approval holding an agent first, then the failure to recover, the plan, the results by wait.
    await expect(needs(page).getByRole("heading", { level: 2 })).toHaveText("Needs you 5");
    await expect(needs(page).getByText("In order: an approval holding an agent, a failure to recover, plans, then results. Oldest wait first.")).toBeVisible();
    const first = page.getByTestId("first-need");
    await expect(first).toContainText("Approval · Claude Code is paused until you answer");
    await expect(first.getByRole("heading")).toHaveText(ASKING);
    await expect(first).toContainText(`Claude Code asks to run ${ASKS}`);
    await expect(first).toContainText(`Task ${seeded.ids.approval} · billing-api · Manual`);
    await expect(needs(page).getByRole("listitem")).toHaveCount(4);
    const rows = needs(page).getByRole("listitem");
    await expect(rows.nth(0)).toContainText(/^Migrate the invoices tableFailed · Claude Code finished without changing any file\./);
    await expect(rows.nth(1)).toContainText("Plan the billing exportPlan · 4 tasks, nothing is built before you approve");
    // A result's line is the server's own sentence about its evidence.
    await expect(rows.nth(2)).toContainText(/^Cache the exchange rates for an hourResult · Evidence is current: the checks passed on commit [0-9a-f]{7}, the commit Accept keeps\./);
    await expect(rows.nth(3)).toContainText(/^Add a function that adds two numbersResult · /);
    await expect(needs(page).getByRole("link")).toHaveText(["Answer", /^See what failed/, /^Read the plan/, /^Review/, /^Review/]);
    // One primary action on the screen: the first item's. Every other is outlined.
    const filled = await page.getByRole("main").getByRole("link").evaluateAll((links) => links.filter((link) => getComputedStyle(link).backgroundColor === "rgb(124, 183, 255)").map((link) => link.textContent));
    expect(filled).toEqual(["Answer"]);
    // Amber is a small signal, never a band: no row or card of Needs you is filled with it.
    expect(await needs(page).locator("li, [data-slot=card]").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor).filter((colour) => colour === "rgb(46, 37, 19)"))).toEqual([]);

    // In progress: the task the builder is at work on. Waiting: the wait and its cause. Completed: accepted work only.
    const progress = page.getByTestId("in-progress");
    await expect(progress.getByRole("heading")).toHaveText("In progress 1");
    await expect(progress.getByRole("listitem")).toContainText(["Add a greeting to the READMEWorking · Claude Code · billing-api"]);
    await expect(progress.getByRole("link", { name: "Add a greeting to the README" })).toHaveAttribute("href", `#/tasks/${working}`);
    const waiting = page.getByTestId("waiting");
    await expect(waiting.getByRole("heading")).toHaveText("Waiting 1");
    // The time is tomorrow's, in this device's own form: the day is named, as it is not today.
    await expect(waiting.getByRole("listitem")).toHaveText([/^Tidy the changelogWaiting on usage limit · Claude Code · tries again on \w+ \w+ at \d{1,2}:30(\u00a0PM)?$/]);
    const completed = page.getByTestId("completed");
    await expect(completed.getByRole("heading")).toHaveText("Completed 2");
    await expect(completed.getByRole("listitem")).toContainText(["Bump the copyright yearAccepted", "Fix the login timeoutAccepted"]);
    // What ended any other way is not on Home and is never hidden: each kind is one quiet link to it in Work.
    await expect(completed.getByRole("link", { name: "1 rejected and 1 cancelled are in Work" })).toHaveAttribute("href", "#/work?state=ended");
    await expect(completed.getByRole("link", { name: "1 failure with nothing to resume is in Work" })).toHaveAttribute("href", "#/work?state=failed");
    await expect(page.getByRole("main")).not.toContainText("Rename the config loader");

    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"Inter Variable"/);
    await checkLayout(page, 32, "Home, 1440, dark");
    await checkWords(page, "Home");
    await shot(page, "home-1440-dark");
    await appearance(page, "light");
    await expect(page.getByTestId("headline")).toHaveText("5 things need you, 1 is in progress");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(245, 246, 247)");
    await shot(page, "home-1440-light");
    await appearance(page, "dark");

    // The primary action leads to the request itself: the task, with its approval card. Answered, it is gone from Home.
    await page.getByTestId("first-need").getByRole("link", { name: "Answer" }).click();
    await expect(page).toHaveURL(new RegExp(`#/tasks/${seeded.ids.approval}$`));
    const card = page.getByTestId("approval-card");
    await expect(card).toContainText(ASKS);
    await card.getByRole("button", { name: "Decline", exact: true }).click();
    await page.goto(`${botbench.base}/#/home`);
    await expect(page.getByTestId("first-need").getByRole("heading")).not.toHaveText(ASKING);
    await expect(page.getByRole("navigation", { name: "Screens" }).getByTestId("home-count")).not.toHaveText("5 waiting for you");
    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
  });

  test("at 1024px Home is two columns beside the navigation, and nothing scrolls sideways", async ({ page, botbench, refused }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await signInAtHome(page, botbench);
    await expect(page.getByTestId("headline")).toHaveText("5 things need you");
    const [waiting, completed] = [(await page.getByTestId("waiting").boundingBox())!, (await page.getByTestId("completed").boundingBox())!];
    expect(completed.x).toBeGreaterThan(waiting.x + waiting.width - 1);
    await checkLayout(page, 32, "Home, 1024");
    await page.setViewportSize({ width: 768, height: 1024 });
    const [one, other] = [(await page.getByTestId("waiting").boundingBox())!, (await page.getByTestId("completed").boundingBox())!];
    expect(other.y, "at 768px the groups are one column").toBeGreaterThan(one.y + one.height - 1);
    await shot(page, "home-768-dark");
    await checkLayout(page, 32, "Home, 768");
    expect(refused).toEqual([]);
  });

  test.describe("with sixty runs and tasks", () => {
    test.use({ size: "many" });

    test("Home stays legible: every item that needs you is listed, the lower groups are counted rows with their first two, and Show all leads to them in Work", async ({ page, botbench, seeded, refused }) => {
      await signInAtHome(page, botbench);
      await expect(page.getByTestId("headline")).toHaveText(`${MANY.needs} things need you, ${MANY.inProgress} are in progress`);
      await expect(page.getByText(`${MANY.waiting} are waiting and go on by themselves. ${MANY.completed} completed in the last day. 60 in all.`)).toBeVisible();
      // Needs you is never cut: the first lifted, the other six in the list, in the server's order.
      await expect(needs(page).getByRole("heading", { level: 3 })).toHaveText(seeded.needs[0]!);
      await expect(needs(page).getByRole("listitem")).toHaveCount(MANY.needs - 1);
      for (const [i, title] of seeded.needs.slice(1).entries()) await expect(needs(page).getByRole("listitem").nth(i)).toContainText(title);

      const progress = page.getByTestId("in-progress");
      await expect(progress.getByRole("heading")).toHaveText(`In progress ${MANY.inProgress}`);
      await expect(progress.getByRole("listitem")).toHaveCount(4);
      await expect(progress.getByRole("listitem").nth(0)).toHaveText(`${MANY.inProgress} Claude Code`);
      await expect(progress.getByRole("listitem").nth(1)).toHaveText(`${MANY.inProgress} payments`);
      // The one that has stood longest since its last move leads; the builder has taken up the first queued one meanwhile.
      await expect(progress.getByRole("listitem").nth(2)).toHaveText(/^Queued change \d+Longest · (Queued|Working) · Claude Code · payments/);
      const waiting = page.getByTestId("waiting");
      await expect(waiting.getByRole("listitem")).toHaveCount(2);
      await expect(waiting.getByRole("listitem").first()).toContainText(`Waiting on usage limit ${MANY.waiting}The first tries again on `);
      await expect(waiting.getByRole("link", { name: `Show all ${MANY.waiting} in Work` })).toHaveAttribute("href", "#/work?state=waiting");
      const completed = page.getByTestId("completed");
      await expect(completed.getByRole("listitem")).toHaveText([`${MANY.completed} accepted`]);
      await expect(completed.getByRole("link", { name: `${MANY.rejected} rejected and ${MANY.cancelled} cancelled are in Work` })).toBeVisible();
      // The three lower groups stand side by side at this width, as on the board.
      const tops = await Promise.all(["in-progress", "waiting", "completed"].map(async (id) => (await page.getByTestId(id).boundingBox())!.y));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2);
      await checkLayout(page, 32, "Home, sixty");
      await checkWords(page, "Home, sixty");
      await shot(page, "home-many-1440-dark");

      await progress.getByRole("link", { name: `Show all ${MANY.inProgress} in Work` }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Work");
      await expect(page.getByRole("group", { name: "State" }).getByRole("button", { pressed: true })).toHaveText(`In progress${MANY.inProgress}`);
      await expect(page.getByTestId("work-row")).toHaveCount(MANY.inProgress);
      expect(refused).toEqual([]);
    });
  });
});

test.describe("at 390×844, on a phone", () => {
  test("Home is one column: the first thing that needs you with its action across the card, each other row a link of its own, and the navigation behind the menu button", async ({ page, botbench, seeded, refused }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await signInAtHome(page, botbench);
    await expect(page.getByTestId("headline")).toHaveText("5 things need you");
    const [card, answer] = [(await page.getByTestId("first-need").boundingBox())!, (await page.getByTestId("first-need").getByRole("link", { name: "Answer" }).boundingBox())!];
    expect(answer.height).toBeGreaterThanOrEqual(44);
    await shot(page, "home-390-dark");
    expect(answer.width, "the primary action spans most of the card").toBeGreaterThan(card.width * 0.5);
    // A row's action is the whole row under a finger: its link is named by what it does and what it is about.
    const plan = needs(page).getByRole("link", { name: "Read the plan: Plan the billing export" });
    const row = needs(page).getByRole("listitem").filter({ hasText: "Plan the billing export" });
    const target = await plan.evaluate((link) => parseFloat(getComputedStyle(link, "::after").height));
    expect(target).toBeGreaterThanOrEqual(44);
    expect(Math.abs(target - (await row.boundingBox())!.height)).toBeLessThan(2);
    await checkLayout(page, 44, "Home, 390");
    await checkWords(page, "Home, phone");
    await shot(page, "home-390-dark");
    await shot(page, "home-390-dark-full", true);

    await page.getByRole("button", { name: "Screens menu" }).click();
    await expect(page.getByRole("dialog").getByRole("link", { name: /^Home/ })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // A tap anywhere on the row is a tap on its link.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/runs/${seeded.ids.plan}$`));
    expect(refused).toEqual([]);
  });
});
