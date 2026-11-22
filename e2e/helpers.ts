import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { startBotbench, type Botbench } from "./botbench.ts";
import { bannedIn } from "./voice.ts";

// What every end-to-end test shares. Everything is real: a Botbench process, the built client, Chrome,
// and for the tests marked LIVE the owner's Claude Code on its cheapest model.

/** Set BOTBENCH_SHOTS to a directory to keep screenshots of the screens. */
export const SHOTS = process.env.BOTBENCH_SHOTS;

export const test = base.extend<{ botbench: Botbench }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench();
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

export async function signIn(page: Page, botbench: Botbench): Promise<void> {
  await page.goto(botbench.base);
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toContainText("signed in");
}

/** Open New task the way the client offers it: the Tasks destination, then that view's own action. */
export async function openNewTask(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("link", { name: "New task" }).click();
  await expect(page.getByRole("heading", { name: "New task", level: 1 })).toBeVisible();
}

/** Every request the page makes must go to Botbench itself. */
export function watchRequests(page: Page, botbench: Botbench): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`${botbench.base}/`) && !url.startsWith("data:")) foreign.push(url);
  });
  return foreign;
}

/** The design system's structural rules, as the one script it ships for the rendered page. */
const CHECK_DOM = fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "groundwork", "check-dom.js"), "utf8");

const APP_PREFIX = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "groundwork.config.json"), "utf8")) as { appPrefix: string }).appPrefix;

/** The system's light colours as the browser reports them, read from the vendored tokens: the only colours a screen may draw. */
const TOKENS = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "groundwork", "tokens.json"), "utf8")) as { color: Record<string, { $value: { hex: string } }>; radius: Record<string, { $value: unknown }> };
const PALETTE = Object.values(TOKENS.color).map(({ $value: { hex } }) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`);

/**
 * The design system, checked on the rendered page: its structural rules (one primary action per view, disclosure
 * limits, cards, badges, emoji, stock phrases, controls that use no system component) find nothing; the view has one h1, in its page header; every colour drawn is one of its tokens; there is no
 * gradient or blur, no shadow except on a dialog or a toast, and no corner off its radius scale; its two typefaces are loaded from Botbench and not
 * substituted; every control has a 44px pointer target; nothing scrolls sideways at phone width. Call it once the
 * screen has its data, and again with each dialog open: an open dialog is a view of its own.
 */
export async function checkDesign(page: Page, screen: string): Promise<void> {
  // The script's text is evaluated, not added as a script element, which Botbench's content security policy would refuse.
  await page.evaluate(CHECK_DOM);
  // The app's class prefix, as web/groundwork.config.json has it: the rule that a view's controls use the system needs it on a rendered page.
  const findings = await page.evaluate((appPrefix) => (globalThis as unknown as { gwCheckDom(root: Element, options: { appPrefix: string }): { rule: string; message: string; fix: string; snippet: string }[] }).gwCheckDom(document.documentElement, { appPrefix }), APP_PREFIX);
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
    // The view's headings outside an open dialog: the one h1, and the size each plain heading is drawn at.
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter((el) => el.getClientRects().length > 0 && el.closest("dialog") === null);
    const plain = (level: string): string[] => [...new Set(headings.filter((el) => el.tagName === level && el.className === "").map((el) => getComputedStyle(el).fontSize))];
    const mono = document.querySelector(".gw-app-header__name, .gw-sign-in__product, code, pre");
    const loaded = (family: string): boolean => [...document.fonts].some((f) => f.family.replace(/"/g, "") === family && f.status === "loaded");
    return {
      small,
      colours,
      decorations,
      radii,
      components: document.querySelectorAll('[class*="gw-"]').length,
      h1: headings.filter((el) => el.tagName === "H1").map((el) => `${getComputedStyle(el).fontSize} ${el.className === "" ? "plain" : String(el.className)}${el.closest(".gw-page-header, .gw-sign-in, .gw-not-found") === null ? " outside a page header" : ""}`),
      h2: plain("H2"),
      h3: plain("H3"),
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
  // One h1 a view: at 24px in the page header, or plain in the sign-in pattern, or the empty state's title in the not-found
  // pattern, which that component draws at its own size. Plain h2 and h3 are a step smaller each.
  expect(found.h1, `${screen}: the view's one h1, at the size of a title`).toEqual([expect.stringMatching(/^(24px (plain|gw-page-header__title)|\d+px gw-empty-state__title)$/)]);
  expect(found.h2.filter((size) => size !== "20px"), `${screen}: plain h2 headings are 20px`).toEqual([]);
  expect(found.h3.filter((size) => size !== "16px"), `${screen}: plain h3 headings are 16px`).toEqual([]);
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
  expect(found.sansLoaded, `${screen}: IBM Plex Sans is loaded from Botbench, not substituted`).toBe(true);
  expect(found.monoLoaded, `${screen}: IBM Plex Mono is loaded from Botbench, not substituted`).toBe(true);
  expect(found.overflow, `${screen}: no sideways scrolling at phone width`).toBe(0);
  await checkWords(page, screen);
}

/**
 * The words on the screen, checked against docs/product/voice.md: every piece of text Botbench itself wrote, drawn or not
 * (a closed disclosure and a visually hidden label are one tap or one screen reader away), every accessible name and
 * the tab title hold none of the internal words that list bans. Text somebody else wrote (a prompt, the agent's reply,
 * a command, a path, a program's output) is marked `data-gw-content` where it is rendered and is not read here; nor is
 * an accessible name marked `data-gw-content-label`, which holds such text, nor what a sentence quotes, nor a path in it.
 * `checkDesign` calls it, so it runs on every screen and state the design check runs on.
 */
export async function checkWords(page: Page, screen: string): Promise<void> {
  const pieces = await page.evaluate(() => {
    const found: string[] = [document.title];
    const ours = (el: Element | null): boolean => el !== null && el.closest("[data-gw-content], script, style") === null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    // Text is read element by element, so words that sit side by side in two elements are not run together.
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text !== "" && ours(node.parentElement)) found.push(text);
    }
    for (const el of document.querySelectorAll("[aria-label], [title], [alt], [placeholder]")) {
      // A name that holds somebody else's words (the command a button removes, the title of the task it edits) is marked where it is written.
      if (!ours(el) || el.hasAttribute("data-gw-content-label")) continue;
      for (const name of ["aria-label", "title", "alt", "placeholder"]) {
        const value = el.getAttribute(name);
        if (value !== null && value.trim() !== "") found.push(value);
      }
    }
    return found;
  });
  const findings = pieces.flatMap((text) => bannedIn(text).map((term) => `"${term}" in: ${text.slice(0, 160)}`));
  expect(findings, `${screen}: internal words on the screen (docs/product/voice.md)`).toEqual([]);
}

/**
 * Keep a screenshot of the whole screen named `copy-<name>.png` when BOTBENCH_COPY_SHOTS is set to a directory: the
 * screens as the plain-language pass left them, for a reader to judge. The window is made as tall as the page for the
 * capture and put back after it, so the header and the tab bar, which stay in place while a page scrolls, are drawn
 * once, where they belong. Resizing leaves an inline size on a textarea that sizes itself; what the capture added is
 * taken off again, so the design check still sees the client's own page.
 */
export async function copyShot(page: Page, name: string): Promise<void> {
  const directory = process.env.BOTBENCH_COPY_SHOTS;
  if (!directory) return;
  await tallShot(page, path.join(directory, `copy-${name}.png`));
}

/** A screenshot of the whole screen at `file`, taken as `copyShot` takes it: the header and tab bar drawn once, where they belong. */
export async function tallShot(page: Page, file: string): Promise<void> {
  const size = page.viewportSize()!;
  await page.evaluate(() => document.querySelectorAll("[style]").forEach((el) => el.setAttribute("data-styled-before-shot", "")));
  // A screen that scrolls inside itself (the chat) is as tall as the window: its own scrolling part says how much more there is.
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll("*")].map((el) => (el.scrollHeight > el.clientHeight ? document.documentElement.clientHeight + el.scrollHeight - el.clientHeight : 0))));
  await page.setViewportSize({ width: size.width, height: Math.min(Math.max(height, size.height), 6000) });
  // Two frames, so the page is laid out and drawn at the new size before it is captured.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: file });
  await page.setViewportSize(size);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    document.querySelectorAll("[style]:not([data-styled-before-shot])").forEach((el) => el.removeAttribute("style"));
    document.querySelectorAll("[data-styled-before-shot]").forEach((el) => el.removeAttribute("data-styled-before-shot"));
  });
}

export { expect };
