import { checkScreen, checkWords, expect } from "./helpers.ts";
import { appearance, ASKING, MANY, shot, signInAtHome, startTask, test } from "./home-seed.ts";

// Work, the full inventory, in the real client against a real Botbench process with its real content security policy.
// No model turn (e2e/home-seed.ts). What is checked: every run and task is a row with its real state word; the search,
// the filters and their counts are the server's; a row's More menu does what it says (hiding a row, and showing it
// again); Show older reads the next page; the words, the policy, control heights and no sideways scroll.

const rows = (page: import("@playwright/test").Page) => page.getByTestId("work-row");
const open = async (page: import("@playwright/test").Page, base: string, address = "#/work"): Promise<void> => {
  await page.goto(`${base}/${address}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Work");
  await expect(page.getByTestId("work-shown")).toBeVisible();
};

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("Work lists every run and task with its real state, newest change first; search and the two filters narrow it, each counted; a row's More menu hides it and shows it again", async ({ page, botbench, seeded, refused }) => {
    await signInAtHome(page, botbench);
    await startTask(page, botbench, seeded.repo, "Add a greeting to the README");
    await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Work" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Work");
    await expect(page).toHaveTitle("Work – Botbench");
    await expect(page.getByTestId("work-about")).toHaveText("Every task, run and chat on this workbench. 12 in all, newest change first.");
    await expect(page.getByTestId("work-shown")).toHaveText("12 of 12 shown");
    await expect(page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Work" })).toHaveAttribute("aria-current", "page");

    // One row each, newest change first, with the product's own state words.
    await expect(rows(page)).toHaveCount(12);
    await expect(rows(page).first()).toContainText("Add a greeting to the README");
    const stateOf = (title: string) => rows(page).filter({ hasText: title }).getByTestId("work-state");
    await expect(stateOf("Add a greeting to the README")).toHaveText("Working");
    await expect(stateOf(ASKING)).toHaveText("Needs input");
    await expect(stateOf("Plan the billing export")).toHaveText("Plan ready for review");
    await expect(stateOf("Cache the exchange rates for an hour")).toHaveText("Ready for review");
    await expect(stateOf("Tidy the changelog")).toHaveText("Waiting on usage limit");
    await expect(stateOf("Fix the login timeout")).toHaveText("Accepted");
    await expect(stateOf("Rename the config loader")).toHaveText("Rejected");
    await expect(stateOf("Tidy module number 9")).toHaveText("Cancelled");
    // Both failed: the one that can be resumed waits for the owner, the other is an end. Each says Failed.
    await expect(stateOf("Migrate the invoices table")).toHaveText("Failed");
    await expect(stateOf("Generate the changelog from the release tags")).toHaveText("Failed");
    const plan = rows(page).filter({ hasText: "Plan the billing export" });
    await expect(plan.getByRole("cell")).toContainText(["Plan ready for review", "Plan the billing export", `Run ${seeded.ids.plan}`, "Claude Code"]);
    // The repository has no column: it is on the line under the title.
    // At this width the kind has its column, so the line is the repository alone.
    expect(await plan.getByTestId("work-kind-line").innerText()).toBe("billing-api");
    await expect(plan.getByRole("link", { name: "Plan the billing export" })).toHaveAttribute("href", `#/runs/${seeded.ids.plan}`);

    // Each filter says how many rows it would show, as the server counts them.
    const kind = page.getByRole("group", { name: "Kind" });
    const state = page.getByRole("group", { name: "State" });
    await expect(kind.getByRole("button")).toHaveText(["All12", "Tasks11", "Runs1", "Chats0"]);
    await expect(state.getByRole("button")).toHaveText(["Any state12", "Needs you5", "In progress1", "Waiting1", "Completed2", "Failed1", "Ended otherwise2"]);
    // The navigation's own controls are the small ones, 32px with a mouse; the screen's are 40px.
    await checkScreen(page, "Work, 1440, dark", { floor: 32 });
    await checkWords(page, "Work");
    await shot(page, "work-1440-dark");
    await appearance(page, "light");
    await expect(rows(page)).toHaveCount(12);
    await shot(page, "work-1440-light");
    await appearance(page, "dark");
    await expect(rows(page)).toHaveCount(12);

    // Failed is the failure nothing can resume. The one that can be resumed is under Needs you.
    await state.getByRole("button", { name: /^Failed/ }).click();
    await expect(rows(page)).toHaveText([/Generate the changelog from the release tags/]);
    await expect(page.getByTestId("work-shown")).toHaveText("1 of 1 shown");
    await state.getByRole("button", { name: /^Needs you/ }).click();
    await expect(rows(page)).toHaveCount(5);
    await kind.getByRole("button", { name: /^Runs/ }).click();
    await expect(rows(page)).toHaveText([/Plan the billing export/]);
    await expect(state.getByRole("button", { name: /^Needs you/ })).toHaveText("Needs you1");
    await kind.getByRole("button", { name: /^All/ }).click();
    await state.getByRole("button", { name: /^Any state/ }).click();

    // Search: words in a title, in any case. The counts on the filters follow it.
    await page.getByRole("searchbox", { name: "Search titles" }).fill("the CHANGELOG");
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("work-shown")).toHaveText("2 of 2 shown");
    await expect(state.getByRole("button", { name: /^Waiting/ })).toHaveText("Waiting1");
    await page.getByRole("searchbox", { name: "Search titles" }).fill("no title has these words");
    await expect(page.getByTestId("work-none")).toHaveText("Nothing matches. Clear the search or choose All and Any state to see everything.");
    await page.getByRole("searchbox", { name: "Search titles" }).fill("");
    await expect(rows(page)).toHaveCount(12);

    // A row's More menu: what is real for the row. Hide takes it out of the list and deletes nothing; Show hidden lists it.
    const cancelled = rows(page).filter({ hasText: "Tidy module number 9" });
    await cancelled.getByRole("button", { name: `More actions for task ${seeded.ids.cancelled}` }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([`Open task ${seeded.ids.cancelled}`, "Hide from the list"]);
    await checkScreen(page, "Work, a row's menu", { floor: 32 });
    await shot(page, "work-1440-dark-menu");
    await menu.getByRole("menuitem", { name: "Hide from the list" }).click();
    await expect(page.getByTestId("row-said")).toHaveText(`Hidden from the list: task ${seeded.ids.cancelled}. Nothing was deleted; Show hidden lists it.`);
    await expect(rows(page)).toHaveCount(11);
    await page.getByRole("button", { name: "Show hidden (1)" }).click();
    await expect(page.getByTestId("work-about")).toHaveText("Rows hidden from the list: 1. Hiding deletes nothing: each row's More menu can show it in the list again.");
    await expect(rows(page)).toHaveText([/Tidy module number 9/]);
    await rows(page).getByRole("button", { name: `More actions for task ${seeded.ids.cancelled}` }).click();
    await page.getByRole("menuitem", { name: "Show in the list" }).click();
    await expect(page.getByTestId("row-said")).toHaveText(`Back in the list: task ${seeded.ids.cancelled}.`);
    await page.getByRole("button", { name: "Back to the list" }).click();
    await expect(rows(page)).toHaveCount(12);
    // A run that can still be cancelled offers it, last, and asks first; Keep run changes nothing.
    await plan.getByRole("button", { name: `More actions for run ${seeded.ids.plan}` }).click();
    await expect(page.getByRole("menuitem")).toHaveText([`Open run ${seeded.ids.plan}`, "Hide from the list", `Cancel run ${seeded.ids.plan}`]);
    await page.getByRole("menuitem", { name: `Cancel run ${seeded.ids.plan}` }).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this run?" });
    await expect(dialog).toContainText("The plan of 4 tasks is dropped and nothing is built.");
    await checkWords(page, "Work, cancel a run");
    await dialog.getByRole("button", { name: "Keep run" }).click();
    await expect(stateOf("Plan the billing export")).toHaveText("Plan ready for review");
    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
  });

  test.describe("with sixty runs and tasks", () => {
    test.use({ size: "many" });

    test("Work shows the newest fifty and says what is older; Show older reads the rest, and a state from Home's link is chosen on arrival", async ({ page, botbench, refused }) => {
      await signInAtHome(page, botbench);
      await open(page, botbench.base);
      await expect(page.getByTestId("work-shown")).toHaveText("50 of 60 shown");
      await expect(rows(page)).toHaveCount(50);
      await expect(page.getByTestId("work-older")).toHaveText(/^10 more, back to \w+ \w+ at \d{1,2}:\d\d(\s?[AP]M)?$/);
      await page.getByRole("button", { name: "Show older" }).click();
      await expect(rows(page)).toHaveCount(60);
      await expect(page.getByTestId("work-shown")).toHaveText("60 of 60 shown");
      await expect(page.getByRole("button", { name: "Show older" })).toHaveCount(0);
      // No row is listed twice across the two pages.
      const titles = await rows(page).getByRole("link").allTextContents();
      expect(new Set(titles).size).toBe(60);

      await open(page, botbench.base, "#/work?state=ended");
      await expect(page.getByRole("group", { name: "State" }).getByRole("button", { pressed: true })).toHaveText(`Ended otherwise${MANY.rejected + MANY.cancelled}`);
      await expect(rows(page)).toHaveCount(MANY.rejected + MANY.cancelled);
      expect(refused).toEqual([]);
    });
  });
});

test.describe("at 390×844, on a phone", () => {
  test("Work is one column: each row its state's mark, its title and one line under it, the filters scrolling inside themselves, and the page never sideways", async ({ page, botbench, seeded, refused }) => {
    await signInAtHome(page, botbench);
    await open(page, botbench.base);
    await expect(rows(page)).toHaveCount(11);
    const row = rows(page).filter({ hasText: "Plan the billing export" });
    await expect(row.getByRole("link")).toContainText(`Plan ready for review · Run ${seeded.ids.plan} · billing-api · `);
    await checkScreen(page, "Work, 390", { floor: 44 });
    await checkWords(page, "Work, phone");
    await shot(page, "work-390-dark");
    await page.getByRole("group", { name: "State" }).getByRole("button", { name: /^Failed/ }).click();
    await expect(rows(page)).toHaveCount(1);
    expect(refused).toEqual([]);
  });
});
