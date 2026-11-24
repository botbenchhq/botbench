import { checkLongContent, checkScreen, expect, messageBox } from "./helpers.ts";
import { LONG_REPO, LONG_TITLE, LONG_TOKEN, shot, signInAtHome, startTask, test } from "./home-seed.ts";

// Home, Work and New chat or task with content longer than its place: titles of over 120 characters, titles that are
// one unbroken token (a branch name, a path), and a repository with a long name. No model turn (e2e/home-seed.ts,
// `stressed`). What is checked at a phone's size and beside the navigation at 1280px and 1024px: nothing reaches past
// the screen, what does not fit is cut with an ellipsis and can still be read whole, and no control shrinks.

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
] as const;

test.use({ size: "stressed" });

test("on a phone, long titles and a long repository name stay inside Home and Work, cut short and still readable whole; Work's line about itself has a row of its own", async ({ page, botbench, seeded, refused }) => {
  await signInAtHome(page, botbench);
  await startTask(page, botbench, seeded.repo, `${LONG_TITLE}, at work`);
  await startTask(page, botbench, seeded.repo, `${LONG_TOKEN}-queued`);
  await expect(page.getByTestId("in-progress").getByRole("listitem")).toHaveCount(2);
  for (const id of ["needs-you", "in-progress", "waiting", "completed"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x + box.width, `${id} ends inside the screen`).toBeLessThanOrEqual(390);
  }
  // The first need's title and its repository are whole, wrapped inside the card.
  await expect(page.getByTestId("first-need")).toContainText(LONG_REPO);
  // A cut line under a title says the whole of itself on hover, as the title does.
  await expect(page.getByTestId("needs-you").getByRole("listitem").first().locator("p")).toHaveAttribute("title", new RegExp(`^Failed · .+ · ${LONG_REPO}`));
  await expect(page.getByTestId("in-progress").getByRole("listitem").first().locator("p")).toHaveAttribute("title", new RegExp(`· Claude Code · ${LONG_REPO}$`));
  // A row of Needs you gives its title the row: the wait ends the line under it, whole, and is not beside the title.
  const need = page.getByTestId("needs-you").getByRole("listitem").first();
  const [item, needTitle, wait] = [(await need.boundingBox())!, (await need.locator("[title]").first().boundingBox())!, (await need.locator("time:visible").boundingBox())!];
  expect(needTitle.width, "the title has the row").toBeGreaterThan(item.width * 0.7);
  expect(wait.y, "the wait is under the title").toBeGreaterThan(needTitle.y + needTitle.height - 2);
  expect(await need.locator("time:visible").evaluate((el) => el.parentElement!.scrollWidth - el.parentElement!.clientWidth), "the wait is whole").toBeLessThanOrEqual(1);
  await checkLongContent(page, "Home, long content, phone");
  await checkScreen(page, "Home, long content, phone", { floor: 44 });
  await shot(page, "home-long-390-dark", true);

  await page.goto(`${botbench.base}/#/work`);
  await expect(page.getByTestId("work-row")).toHaveCount(14);
  // The line about Work is under the heading at the screen's full width, not squeezed between the heading and New run.
  const [heading, about, main] = [(await page.getByRole("heading", { level: 1 }).boundingBox())!, (await page.getByTestId("work-about").boundingBox())!, (await page.getByRole("main").boundingBox())!];
  expect(about.y, "the line is under the heading").toBeGreaterThanOrEqual(heading.y + heading.height - 1);
  expect(about.width, "and as wide as the screen's column").toBeGreaterThan(main.width - 40);
  await checkLongContent(page, "Work, long content, phone");
  await checkScreen(page, "Work, long content, phone", { floor: 44 });
  await shot(page, "work-long-390-dark", true);
  expect(refused).toEqual([]);
});

test.describe("with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("from 768px to 1440px long content stays inside Home and Work, a cut agent or repository can be read whole, and a filter's focus ring is drawn inside its strip", async ({ page, botbench, seeded, refused }) => {
    await signInAtHome(page, botbench);
    await startTask(page, botbench, seeded.repo, `${LONG_TITLE}, at work`);
    await page.goto(`${botbench.base}/#/work`);
    await expect(page.getByTestId("work-row")).toHaveCount(13);
    const row = page.getByTestId("work-row").first();
    await expect(row.getByRole("cell").nth(3)).toHaveAttribute("title", "Claude Code");
    await expect(row.getByRole("cell").nth(4)).toHaveAttribute("title", "Now");
    await checkLongContent(page, "Work, long content, 1440");
    // The strip of filters scrolls inside itself, which clips what is drawn outside it: the ring is inside the button.
    const filter = page.getByRole("group", { name: "State" }).getByRole("button", { name: /^Waiting/ });
    await page.getByRole("searchbox", { name: "Search titles" }).focus();
    for (let i = 0; i < 12 && !(await filter.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    expect(await filter.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/inset/);
    // The title is the column that takes what is left: at least 45% of the table at every width from 768px up. The
    // others give way for it: the kind is said under the title, and the state, never hidden or cut, has two lines.
    for (const size of [{ width: 1440, height: 900 }, ...SIZES]) {
      await page.setViewportSize(size);
      // The navigation folds to its rail at some widths, and the table follows it: measure once that has settled.
      await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))), new Promise((resolve) => setTimeout(resolve, 600))]));
      await page.waitForTimeout(300);
      const [table, title] = [(await page.getByTestId("work-table").boundingBox())!, (await page.getByRole("columnheader", { name: "Title" }).boundingBox())!];
      expect(title.width / table.width, `the title's share of the table at ${size.width}px`).toBeGreaterThanOrEqual(0.45);
      // Under 56rem of screen (the table is its card's border narrower) the kind has no column.
      const narrow = table.width + 2 < 896;
      await expect(page.getByRole("columnheader", { name: "Kind" })).toHaveCount(narrow ? 0 : 1);
      // The repository is under the title at every width, after the kind where the kind has no column, cut short and whole on hover.
      await expect(row.getByTestId("work-kind-line")).toHaveAttribute("title", LONG_REPO);
      expect(await row.getByTestId("work-kind-line").innerText()).toMatch(narrow ? new RegExp(`^Task \\d+ · ${LONG_REPO}$`) : new RegExp(`^${LONG_REPO}$`));
      await expect(page.getByRole("columnheader", { name: "Agent" })).toHaveCount(table.width + 2 >= 1104 ? 1 : 0);
      await expect(page.getByRole("columnheader", { name: "Repository" })).toHaveCount(0);
      const states = await page.getByTestId("work-state").evaluateAll((els) => els.map((el) => ({ word: el.textContent, cut: el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().width < 2 })));
      expect(states.filter((state) => state.cut), `no state is hidden or cut at ${size.width}px`).toEqual([]);
      expect(states.map((state) => state.word)).toContain("Waiting on usage limit");
      const last = (await row.locator("time").boundingBox())!;
      const more = (await row.getByRole("button", { name: /^More actions/ }).boundingBox())!;
      expect(more.x - (last.x + last.width), "Last change stays at the right, beside More").toBeLessThan(40);
      await checkLongContent(page, `Work, long content, ${size.width}`);
      await checkScreen(page, `Work, long content, ${size.width}`, { floor: 32 });
      await shot(page, `work-title-room-${size.width}`);
    }
    await page.goto(`${botbench.base}/#/home`);
    await expect(page.getByTestId("headline")).toBeVisible();
    for (const size of [{ width: 1440, height: 900 }, ...SIZES]) {
      await page.setViewportSize(size);
      await checkLongContent(page, `Home, long content, ${size.width}`);
      await checkScreen(page, `Home, long content, ${size.width}`, { floor: 32 });
    }

    // New chat or task: what is typed starts under the box's label, and a long unbroken word wraps inside the box.
    await page.goto(`${botbench.base}/#/turn`);
    await expect(messageBox(page)).toBeEnabled();
    await messageBox(page).fill(`${LONG_TOKEN} ${LONG_TITLE}`);
    const composer = page.getByTestId("composer");
    const [label, box] = [(await composer.locator("label[for=prompt]").boundingBox())!, (await messageBox(page).boundingBox())!];
    expect(Math.abs(box.x + (await messageBox(page).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))) - label.x), "the typed words start where the label does").toBeLessThan(1);
    expect(await messageBox(page).evaluate((el) => el.scrollWidth - el.clientWidth), "a long word wraps").toBe(0);
    // The box says it has focus with the ring every field has, not only a border's colour.
    await messageBox(page).press("Shift+Tab");
    await page.keyboard.press("Tab");
    expect(await composer.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
    await checkLongContent(page, "New chat or task, long content");
    expect(refused).toEqual([]);
  });
});
