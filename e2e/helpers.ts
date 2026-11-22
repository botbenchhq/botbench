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

/** Every request the page makes must go to Smelt itself. */
export function watchRequests(page: Page, smelt: Smelt): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`${smelt.base}/`) && !url.startsWith("data:")) foreign.push(url);
  });
  return foreign;
}

const DESIGN_COLOURS = ["rgb(26, 26, 26)", "rgb(250, 250, 249)", "rgb(23, 23, 23)", "rgb(229, 229, 229)", "rgb(115, 115, 115)"];

/** DESIGN.md, checked on the rendered page: its five colours only, Geist, no gradients or shadows, 44px targets. */
export async function checkDesign(page: Page, screen: string): Promise<void> {
  const found = await page.evaluate(async () => {
    await document.fonts.ready;
    const colours: Record<string, string> = {};
    const decorations: string[] = [];
    const small: string[] = [];
    const describe = (el: Element): string => `<${el.tagName.toLowerCase()}${el.className ? ` class="${String(el.className)}"` : ""}>`;
    for (const el of document.querySelectorAll("*")) {
      for (const pseudo of [null, "::before", "::after", "::placeholder"]) {
        const style = getComputedStyle(el, pseudo);
        for (const property of ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "outlineColor", "textDecorationColor", "caretColor"] as const) {
          colours[style[property]] ??= `${property} of ${describe(el)}${pseudo ?? ""}`;
        }
        if (style.backgroundImage !== "none") decorations.push(`background-image ${style.backgroundImage} on ${describe(el)}`);
        if (style.boxShadow !== "none") decorations.push(`box-shadow on ${describe(el)}`);
        if (style.textShadow !== "none") decorations.push(`text-shadow on ${describe(el)}`);
        if (style.backdropFilter !== "none") decorations.push(`backdrop-filter on ${describe(el)}`);
      }
    }
    for (const el of document.querySelectorAll("button, input, textarea, a[href]")) {
      const box = el.getBoundingClientRect();
      if (box.height < 44 || box.width < 44) small.push(`${describe(el)} is ${box.width}x${box.height}`);
    }
    const radii = [...new Set([...document.querySelectorAll("*")].map((el) => getComputedStyle(el).borderTopLeftRadius))];
    const mono = document.querySelector('[role="log"], input, .font-mono');
    return {
      colours,
      decorations,
      small,
      radii,
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodySize: getComputedStyle(document.body).fontSize,
      monoFont: mono ? getComputedStyle(mono).fontFamily : "",
      geistLoaded: document.fonts.check('14px "Geist"') && [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Geist" && f.status === "loaded"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const offPalette = Object.entries(found.colours).filter(([colour]) => !DESIGN_COLOURS.includes(colour) && colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent");
  expect(offPalette, `${screen}: colours outside DESIGN.md`).toEqual([]);
  expect(Object.keys(found.colours).length, `${screen}: the check saw colours`).toBeGreaterThan(2);
  expect(found.decorations, `${screen}: gradients, shadows or blur`).toEqual([]);
  expect(found.small, `${screen}: touch targets under 44px`).toEqual([]);
  expect(found.radii.filter((r) => !["0px", "4px", "8px"].includes(r)), `${screen}: radii outside DESIGN.md`).toEqual([]);
  expect(found.bodyFont, `${screen}: body font`).toMatch(/^"?Geist"?,/);
  expect(found.bodySize).toBe("14px");
  expect(found.monoFont, `${screen}: mono font`).toMatch(/^"?Geist Mono"?,/);
  expect(found.geistLoaded, `${screen}: Geist is loaded from Smelt, not substituted`).toBe(true);
  expect(found.overflow, `${screen}: no sideways scrolling at phone width`).toBe(0);
}

export { expect };
