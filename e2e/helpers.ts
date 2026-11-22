import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { startSmelt, type Smelt } from "./smelt.ts";

// What every end-to-end test shares. Everything is real: a Smelt process, the built client, Chrome,
// and for the tests marked LIVE the owner's Claude Code on its cheapest model.

/** Set SMELT_SHOTS to a directory to keep screenshots of the screens. */
export const SHOTS = process.env.SMELT_SHOTS;

export const test = base.extend<{ smelt: Smelt }>({
  smelt: async ({}, use) => {
    const smelt = await startSmelt();
    await use(smelt);
    const { leftover } = await smelt.stop();
    expect(leftover, "no CLI process is left after Smelt stops").toEqual([]);
    fs.rmSync(path.dirname(smelt.home), { recursive: true, force: true });
  },
});

export async function signIn(page: Page, smelt: Smelt): Promise<void> {
  await page.goto(smelt.base);
  await page.getByLabel("Login token").fill(smelt.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toContainText("signed in");
}

/** Open New task the way the client offers it: the Tasks destination, then that view's own action. */
export async function openNewTask(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("link", { name: "New task" }).click();
  await expect(page.getByRole("heading", { name: "New task", level: 1 })).toBeVisible();
}

/** Every request the page makes must go to Smelt itself. */
export function watchRequests(page: Page, smelt: Smelt): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`${smelt.base}/`) && !url.startsWith("data:")) foreign.push(url);
  });
  return foreign;
}

/** The design system's structural rules, as the one script it ships for the rendered page. */
const CHECK_DOM = fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "groundwork", "check-dom.js"), "utf8");

/** The system's light colours as the browser reports them, read from the vendored tokens: the only colours a screen may draw. */
const TOKENS = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "groundwork", "tokens.json"), "utf8")) as { color: Record<string, { $value: { hex: string } }>; radius: Record<string, { $value: unknown }> };
const PALETTE = Object.values(TOKENS.color).map(({ $value: { hex } }) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`);

/**
 * The design system, checked on the rendered page: its structural rules (one primary action per view, disclosure
 * limits, cards, badges, emoji, stock phrases) find nothing; every colour drawn is one of its tokens; there is no
 * gradient or blur, no shadow except on a dialog or a toast, and no corner off its radius scale; its two typefaces are loaded from Smelt and not
 * substituted; every control has a 44px pointer target; nothing scrolls sideways at phone width. Call it once the
 * screen has its data, and again with each dialog open: an open dialog is a view of its own.
 */
export async function checkDesign(page: Page, screen: string): Promise<void> {
  // The script's text is evaluated, not added as a script element, which Smelt's content security policy would refuse.
  await page.evaluate(CHECK_DOM);
  const findings = await page.evaluate(() => (globalThis as unknown as { gwCheckDom(): { rule: string; message: string; fix: string; snippet: string }[] }).gwCheckDom());
  expect(findings, `${screen}: findings of the design system's rendered check`).toEqual([]);

  const found = await page.evaluate(async () => {
    await document.fonts.ready;
    // A colour half-way through a transition is not a colour of the design: wait for the transitions under way to end.
    // The system's longest is 240ms, and one on an element that is no longer drawn never ends, so the wait has a limit.
    const transitions = document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => {}));
    await Promise.race([Promise.all(transitions), new Promise((resolve) => setTimeout(resolve, 500))]);
    const small: string[] = [];
    const colours: Record<string, string> = {};
    const decorations: string[] = [];
    const radii: Record<string, string> = {};
    const describe = (el: Element): string => `<${el.tagName.toLowerCase()}${el.className ? ` class="${String(el.className)}"` : ""}> ${(el.textContent ?? "").trim().slice(0, 40)}`;
    for (const el of document.querySelectorAll("body, body *")) {
      // Nothing of an element that is not drawn reaches the screen.
      if (el.getClientRects().length === 0) continue;
      for (const pseudo of [null, "::before", "::after", "::placeholder"]) {
        const style = getComputedStyle(el, pseudo);
        if (pseudo !== null && pseudo !== "::placeholder" && style.content === "none") continue;
        for (const property of ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "outlineColor", "textDecorationColor", "caretColor"] as const) {
          colours[style[property]] ??= `${property} of ${describe(el)}${pseudo ?? ""}`;
        }
        if (style.backgroundImage !== "none") decorations.push(`background-image ${style.backgroundImage} on ${describe(el)}${pseudo ?? ""}`);
        // The system's one shadow is on its overlays: a dialog, and a toast, which floats over the page the same way.
        if (style.boxShadow !== "none" && el.tagName !== "DIALOG" && !el.classList.contains("gw-toast")) decorations.push(`box-shadow on ${describe(el)}${pseudo ?? ""}`);
        if (style.textShadow !== "none") decorations.push(`text-shadow on ${describe(el)}`);
        if (style.backdropFilter !== "none" || style.filter !== "none") decorations.push(`filter on ${describe(el)}`);
        radii[style.borderTopLeftRadius] ??= `${describe(el)}${pseudo ?? ""}`;
      }
    }
    for (const el of document.querySelectorAll("button, input, textarea, select, summary, a[href]")) {
      // Not drawn at this width (the sidebar navigation on a phone), or inside a closed disclosure.
      if (el.getClientRects().length === 0) continue;
      const box = el.getBoundingClientRect();
      // A control drawn smaller than 44px carries its pointer target on a pseudo-element that is.
      const target = getComputedStyle(el, "::after");
      const extended = target.content !== "none" && target.position === "absolute";
      const width = Math.max(box.width, extended ? parseFloat(target.width) || 0 : 0);
      const height = Math.max(box.height, extended ? parseFloat(target.height) || 0 : 0);
      if (height < 44 || width < 44) small.push(`${describe(el)} is ${width}x${height}`);
    }
    const mono = document.querySelector(".gw-app-header__name, .gw-sign-in__product, code, pre");
    const loaded = (family: string): boolean => [...document.fonts].some((f) => f.family.replace(/"/g, "") === family && f.status === "loaded");
    return {
      small,
      colours,
      decorations,
      radii,
      components: document.querySelectorAll('[class*="gw-"]').length,
      offSystem: [...document.querySelectorAll("[style]")].map(describe),
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodySize: getComputedStyle(document.body).fontSize,
      monoFont: mono ? getComputedStyle(mono).fontFamily : "",
      sansLoaded: document.fonts.check('14px "IBM Plex Sans"') && loaded("IBM Plex Sans"),
      monoLoaded: loaded("IBM Plex Mono"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(found.components, `${screen}: the screen is built from the design system's components`).toBeGreaterThan(2);
  expect(found.offSystem, `${screen}: inline styles`).toEqual([]);
  const offPalette = Object.entries(found.colours).filter(([colour]) => !PALETTE.includes(colour) && colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent");
  expect(offPalette, `${screen}: colours that are not tokens of the design system`).toEqual([]);
  expect(Object.keys(found.colours).length, `${screen}: the check saw colours`).toBeGreaterThan(2);
  expect(found.decorations, `${screen}: gradients, blur, or a shadow on anything but a dialog or a toast`).toEqual([]);
  expect(Object.entries(found.radii).filter(([radius]) => !["0px", "4px", "8px", "9999px"].includes(radius)), `${screen}: corners off the radius scale`).toEqual([]);
  expect(found.small, `${screen}: touch targets under 44px`).toEqual([]);
  expect(found.bodyFont, `${screen}: body font`).toMatch(/^"?IBM Plex Sans"?,/);
  expect(found.bodySize).toBe("14px");
  expect(found.monoFont, `${screen}: mono font`).toMatch(/^"?IBM Plex Mono"?,/);
  expect(found.sansLoaded, `${screen}: IBM Plex Sans is loaded from Smelt, not substituted`).toBe(true);
  expect(found.monoLoaded, `${screen}: IBM Plex Mono is loaded from Smelt, not substituted`).toBe(true);
  expect(found.overflow, `${screen}: no sideways scrolling at phone width`).toBe(0);
}

export { expect };
