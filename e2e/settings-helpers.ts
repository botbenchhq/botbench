import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, goTo, SHOTS } from "./helpers.ts";

// What the tests of Settings, the paired-workbench conversation and sign-in share. The check of a screen itself is
// `checkScreen` (helpers.ts), as for every screen.

/** The six groups of Settings, by the word their address ends in and the name the navigation gives them. */
export const GROUPS = {
  agents: "Agents and models",
  environments: "Execution environments",
  identity: "Workbench identity",
  permissions: "Permissions and autonomy",
  usage: "Usage and limits",
  connections: "Connections and peers",
} as const;
export type Group = keyof typeof GROUPS;

/** Open one group of Settings at its own address, and wait for its heading. */
export async function openGroup(page: Page, botbench: { base: string }, group: Group): Promise<void> {
  await page.goto(`${botbench.base}/#/settings/${group}`);
  await expect(page.getByRole("heading", { level: 1, name: GROUPS[group] })).toBeVisible();
}

/** Open Settings as a person does from the navigation, then one of its groups: under 1024px through the list of groups, from 1024px through the settings navigation. */
export async function openSettingsGroup(page: Page, group: Group): Promise<void> {
  await goTo(page, "Settings");
  await expect(page.getByTestId("settings")).toBeVisible();
  const from = (await page.getByTestId("settings-groups").count()) > 0 ? page.getByTestId("settings-groups") : page.getByTestId("settings-nav");
  await from.getByRole("link", { name: new RegExp(`^${GROUPS[group]}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: GROUPS[group] })).toBeVisible();
}

/** A choice of two or three drawn as segments (On and Off; Allow, Ask and Off), by its name. Its `data-value` is the choice as stored. */
export const choice = (within: Page | Locator, name: string): Locator => within.getByRole("radiogroup", { name, exact: true });

/** Choose one segment of such a choice. */
export async function choose(within: Page | Locator, name: string, option: string): Promise<void> {
  await choice(within, name).getByRole("radio", { name: option, exact: true }).check();
}

/** A picture of the screen at `<BOTBENCH_SHOTS>/<name>.png` when that folder is named. */
export async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/**
 * Sign in with the login token, then open `address`. Signing in ends with the page loading again (so a phone's password
 * manager offers to keep the token): the address is opened only once that load has ended, or the two would race and
 * the address could be lost.
 */
export async function signInTo(page: Page, botbench: { base: string; token: string }, address: string): Promise<void> {
  await page.goto(botbench.base);
  await page.getByLabel("Login token").fill(botbench.token);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const loadedAgain = page.waitForEvent("load");
  await page.getByRole("button", { name: "Sign in" }).click();
  await loadedAgain;
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await page.goto(`${botbench.base}/${address}`);
}
