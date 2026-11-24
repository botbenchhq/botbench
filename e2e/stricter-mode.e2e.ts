import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createRun, storePlan } from "../src/engine/run.ts";
import { openStore } from "../src/store/db.ts";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, checkScreen, checkWords, choose, closeContext, contextSheet, expect, messageBox, openComposer, openRow, openRunMenu, SHOTS, signIn, tallShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Making a run's mode stricter from its screen's menu, and the composer opening on the mode last chosen for a repository, at a
// phone's and a wide screen's size, in the light and the dark theme. No model turn: before Botbench starts, runs are put
// in its real store through the engine itself, at the plan gate, where nothing starts a planner or a builder, and the
// real Botbench process shows them. The engine's side (the next request asks, the next result waits for the owner) is
// tested with the real broker in test/engine/stricter-mode.test.ts.

interface Seeded {
  home: string;
  /** A repository with a check command, and one with none. */
  checked: string;
  unchecked: string;
  full: number;
  semi: number;
  manual: number;
  cancelled: number;
}

const PLAN = [{ title: "Write the exporter", criteria: ["It writes a CSV file"] }];

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = fs.realpathSync(tempDir("botbench-e2e-stricter-"));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const checked = path.join(dir, "code", "with-checks");
    const unchecked = path.join(dir, "code", "no-checks");
    const baseCommit = initRepo(checked);
    initRepo(unchecked);
    const db = openStore(home);
    const atGate = (mode: "manual" | "semi" | "full"): number => {
      const run = createRun(db, { repo: checked, prompt: `Plan the billing export, ${mode}`, baseCommit, mode });
      storePlan(db, run.id, PLAN);
      return run.id;
    };
    const full = atGate("full");
    const semi = atGate("semi");
    const manual = atGate("manual");
    const cancelled = atGate("full");
    db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(cancelled);
    db.close();
    await use({ home, checked, unchecked, full, semi, manual, cancelled });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [seeded.checked]: { checks: ["true"] }, [seeded.unchecked]: {} } } });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await tallShot(page, path.join(SHOTS, name));
}

const runs = async (page: Page, botbench: Botbench): Promise<number> => ((await (await page.request.get(`${botbench.base}/api/runs`)).json()) as { runs: unknown[] }).runs.length;

for (const [size, viewport] of [["390", { width: 390, height: 844 }], ["1280", { width: 1280, height: 800 }]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`at ${size}px, ${theme}`, () => {
      test.use({ viewport, colorScheme: theme });

      test("a running run offers only the stricter modes, labels the current one, and shows the owner's change in its history; a manual or finished run offers none", async ({ page, botbench, seeded }) => {
        await signIn(page, botbench);
        await page.goto(`${botbench.base}/#/runs/${seeded.full}`);
        // The choice is in the run's own menu, which says the mode the run is in now, and opens as a dialog.
        const floor = size === "390" ? 44 : 32;
        const menu = await openRunMenu(page);
        await expect(menu.getByRole("menuitem")).toHaveText([/^Make the mode stricter\s*Now fully autonomous$/, "Cancel run"]);
        await menu.getByRole("menuitem", { name: /^Make the mode stricter/ }).click();
        const offer = page.getByTestId("mode-change");
        await expect(offer.getByRole("heading", { name: "Make the mode stricter", level: 2 })).toBeVisible();
        await expect(offer.getByRole("radio")).toHaveCount(3);
        await expect(offer.getByRole("radio", { name: "Fully autonomous" })).toBeChecked();
        await expect(offer.getByRole("radio", { name: "Fully autonomous" })).toHaveAccessibleDescription(/Current mode/);
        await expect(offer.getByRole("radio", { name: "Semi-autonomous" })).not.toBeChecked();
        await expect(offer.getByRole("radio", { name: "Manual" })).not.toBeChecked();
        await expect(offer.getByText("never looser")).toBeVisible();
        await expect(offer.getByRole("button", { name: "Change mode" })).toBeDisabled();
        await checkScreen(page, `run, stricter mode offered, ${size} ${theme}`, { floor: floor });
        await checkWords(page, `run, stricter mode offered, ${size} ${theme}`);
        await shot(page, `stricter-mode-offered-${size}-${theme}.png`);

        // Nothing changes until the owner presses the button.
        await offer.getByRole("radio", { name: "Manual" }).click();
        await expect(offer.getByRole("radio", { name: "Manual" })).toBeChecked();
        expect(((await (await page.request.get(`${botbench.base}/api/runs/${seeded.full}`)).json()) as { mode: string }).mode).toBe("full");
        await offer.getByRole("button", { name: "Change to Manual" }).click();
        await expect(page.getByTestId("run-mode")).toHaveText(/^Manual: /);
        await expect(page.getByTestId("run-mode-changes")).toContainText("You changed the mode from fully autonomous to manual.");
        await expect(page.getByTestId("mode-change")).toHaveCount(0);
        expect(((await (await page.request.get(`${botbench.base}/api/runs/${seeded.full}`)).json()) as { mode: string }).mode).toBe("manual");
        // A manual run has no stricter mode: its menu holds Cancel run alone.
        await expect((await openRunMenu(page)).getByRole("menuitem")).toHaveText(["Cancel run"]);
        await page.keyboard.press("Escape");
        await checkScreen(page, `run, made manual, ${size} ${theme}`, { floor: floor });
        await checkWords(page, `run, made manual, ${size} ${theme}`);
        await shot(page, `stricter-mode-changed-${size}-${theme}.png`);

        // Semi-autonomous: Manual alone is offered.
        await page.goto(`${botbench.base}/#/runs/${seeded.semi}`);
        await (await openRunMenu(page)).getByRole("menuitem", { name: /^Make the mode stricter/ }).click();
        await expect(page.getByTestId("mode-change").getByRole("radio")).toHaveCount(2);
        await expect(page.getByTestId("mode-change").getByRole("radio", { name: "Semi-autonomous" })).toBeChecked();
        await expect(page.getByTestId("mode-change").getByRole("radio", { name: "Fully autonomous" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("mode-change")).toHaveCount(0);
        // Manual: the menu offers no stricter mode. Finished: the run has no menu at all.
        await page.goto(`${botbench.base}/#/runs/${seeded.manual}`);
        await expect(page.getByTestId("run-mode")).toHaveText(/^Manual: /);
        await expect((await openRunMenu(page)).getByRole("menuitem")).toHaveText(["Cancel run"]);
        await page.keyboard.press("Escape");
        await page.goto(`${botbench.base}/#/runs/${seeded.cancelled}`);
        await expect(page.getByTestId("run-mode")).toHaveText(/^Fully autonomous: /);
        await expect(page.getByTestId("run-menu")).toHaveCount(0);
        await expect(page.getByTestId("mode-change")).toHaveCount(0);
      });

      test("the composer opens on the run planned last, with its mode shown before Send; a remembered Fully autonomous on a repository with no check command falls back to Semi-autonomous and says why; another repository gets the Settings default", async ({ page, botbench, seeded }) => {
        await signIn(page, botbench);
        await openComposer(page);
        await choose(page, "Repository", "no-checks");
        await choose(page, "What to do", "Plan a run");
        await choose(page, "When accepted", "Open a pull request");
        // Chosen on this visit, Fully autonomous is not changed behind the owner's back: Send says why it cannot go.
        await choose(page, "Mode", "Fully autonomous");
        await closeContext(page);
        await expect(page.getByTestId("composer-mode")).toHaveText("Mode: Fully autonomous.");
        await messageBox(page).fill("Add a CSV export");
        await expect(page.getByTestId("composer-reason")).toHaveText(/^Fully autonomous needs a check command for this repository\./);

        // Back later: Plan a run in the same repository with the same choices, the mode falling back in plain words.
        await page.reload();
        await expect(messageBox(page)).toBeVisible();
        await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe what to plan");
        await expect(page.getByTestId("composer-mode")).toHaveText("Mode: Semi-autonomous. Fully autonomous, your last choice for this repository, needs a check command, and this repository has none, so this run starts Semi-autonomous.");
        await openRow(page, "When accepted");
        await expect(contextSheet(page).getByRole("radio", { name: "Open a pull request" })).toBeChecked();
        await closeContext(page);
        await messageBox(page).fill("Add a CSV export");
        await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
        expect(await runs(page, botbench), "nothing was sent").toBe(4);
        await checkDesign(page, `composer, remembered mode fell back, ${size} ${theme}`);
        await shot(page, `stricter-mode-composer-${size}-${theme}.png`);

        // Another repository: the Settings default (Manual), not the mode remembered for the first.
        await choose(page, "Repository", "with-checks");
        await closeContext(page);
        await expect(page.getByTestId("composer-mode")).toHaveText("Mode: Manual.");
        expect(await runs(page, botbench), "still nothing was sent").toBe(4);

        // A Fully autonomous that can start here is back as it was on reopen, and goes out as full only when Send is pressed.
        await choose(page, "Mode", "Fully autonomous");
        await closeContext(page);
        await page.reload();
        await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe what to plan");
        await expect(page.getByTestId("composer-mode")).toHaveText("Mode: Fully autonomous.");
        await messageBox(page).fill("Add a CSV export");
        await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
        expect(await runs(page, botbench), "opening the composer sent nothing").toBe(4);
        // The request Send makes is read and then not let through, so no planner starts in a test with no model turn.
        const sent: unknown[] = [];
        await page.route("**/api/runs", (route) => {
          if (route.request().method() !== "POST") return route.continue();
          sent.push(route.request().postDataJSON());
          return route.abort();
        });
        await page.getByRole("button", { name: "Send" }).click();
        await expect.poll(() => sent.length).toBe(1);
        expect(sent[0]).toMatchObject({ repo: seeded.checked, prompt: "Add a CSV export", mode: "full", delivery: "pull_request" });
        expect(await runs(page, botbench)).toBe(4);
      });
    });
  }
}
