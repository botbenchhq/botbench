import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { checkWords, expect, SHOTS } from "./helpers.ts";

// What the tests of Settings, the paired-workbench conversation and sign-in share, now that those screens are built on
// shadcn/ui and Tailwind 4 (ADR 0012). The old design checks (checkDesign) read the design system's classes, which these
// screens do not use; `checkNext` stands in their place.

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

/** Open Settings as a person does from an old screen's header, then one of its groups: at a phone's width through the list of groups, from 1024px through the settings navigation. */
export async function openSettingsGroup(page: Page, group: Group): Promise<void> {
  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
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

/**
 * Everything the browser refused or complained of from now on: a violation of the content security policy (the page's
 * own event, and Chrome's console line for one), any console error, any page error, any failed request. Call it before
 * the first page load.
 */
export async function watchRefused(page: Page): Promise<string[]> {
  const refused: string[] = [];
  await page.exposeFunction("botbenchRefused", (line: string) => void refused.push(line));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => void (window as unknown as { botbenchRefused(line: string): void }).botbenchRefused(`policy: ${event.violatedDirective} refused ${event.blockedURI} (${event.sourceFile ?? "inline"}:${event.lineNumber})`));
  });
  page.on("console", (message) => {
    // Before signing in, the client asks whether it has a session and is told it has none: Chrome prints that 401.
    if (message.type() === "error" && message.location().url.endsWith("/api/session") && /status of 401/.test(message.text())) return;
    // An agent Botbench cannot run a sign-in for has no sign-in to read: its card asks, is told 404, and draws no Connect.
    if (message.type() === "error" && /\/api\/agents\/[a-z-]+\/connect$/.test(message.location().url) && /status of 404/.test(message.text())) return;
    if (message.type() === "error" || /content security policy/i.test(message.text())) refused.push(`console ${message.type()}: ${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => refused.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => {
    // A request the page itself ends when a screen goes (live updates, a read no longer wanted) is not a refusal.
    if (request.failure()?.errorText !== "net::ERR_ABORTED") refused.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  return refused;
}

/**
 * What stands in for the old design checks on a rebuilt screen: nothing scrolls sideways, no text is under 12px, no
 * control is lower than a small control (32px with a mouse, 44px under a finger), and the words pass
 * docs/product/voice.md.
 */
export async function checkNext(page: Page, screen: string): Promise<void> {
  // A dialog or a sheet that is still arriving is drawn smaller than it will be: measured once it has arrived.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const found = await page.evaluate(() => {
    const least = window.matchMedia("(pointer: coarse)").matches ? 44 : 32;
    const low: string[] = [];
    for (const el of document.querySelectorAll("button, input, select, textarea, [role=radio], [role=tab], a[href]")) {
      const box = el.getBoundingClientRect();
      // Not drawn, a link inside a sentence, or a tick box, which is drawn small beside its label. The shell's own
      // navigation is checked where the shell is (e2e/next-review.e2e.ts), not on every screen inside it.
      if (box.height === 0 || getComputedStyle(el).display === "inline" || el.getAttribute("aria-hidden") === "true" || (el as HTMLInputElement).type === "checkbox" || el.closest('[data-slot="sidebar"]') !== null) continue;
      // A control drawn smaller carries its pointer target on a pseudo-element.
      const target = getComputedStyle(el, "::after");
      const height = Math.max(box.height, target.content !== "none" && target.position === "absolute" ? parseFloat(target.height) || 0 : 0);
      if (height < least) low.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" is ${Math.round(height)}px high`);
    }
    const small = [...document.querySelectorAll("body *")].filter((el) => el.getClientRects().length > 0 && el.childElementCount === 0 && (el.textContent ?? "").trim() !== "" && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => `${getComputedStyle(el).fontSize}: ${(el.textContent ?? "").trim().slice(0, 30)}`);
    return { low, small, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(found, screen).toEqual({ low: [], small: [], sideways: 0 });
  await checkWords(page, screen);
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
