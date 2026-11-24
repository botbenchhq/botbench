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
    await expect(row.getByRole("cell").nth(4)).toHaveAttribute("title", LONG_REPO);
    await expect(row.getByRole("cell").nth(3)).toHaveAttribute("title", "Claude Code");
    await checkLongContent(page, "Work, long content, 1440");
    // The strip of filters scrolls inside itself, which clips what is drawn outside it: the ring is inside the button.
    const filter = page.getByRole("group", { name: "State" }).getByRole("button", { name: /^Waiting/ });
    await page.getByRole("searchbox", { name: "Search titles" }).focus();
    for (let i = 0; i < 12 && !(await filter.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    expect(await filter.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/inset/);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await checkLongContent(page, `Work, long content, ${size.width}`);
      await checkScreen(page, `Work, long content, ${size.width}`, { floor: 32 });
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
