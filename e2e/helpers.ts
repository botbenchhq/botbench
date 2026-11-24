import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
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
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    expect(leftover, "no CLI process is left after Botbench stops").toEqual([]);
  },
});

export async function signIn(page: Page, botbench: Botbench): Promise<void> {
  await page.goto(botbench.base);
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(messageBox(page)).toBeEnabled();
}

/*
 * The composer on the home screen (Chat) starts everything: a chat with no repository, a task or a run in one. These
 * steps are the one place the tests drive it, so a change to the composer changes the tests here.
 */

/** The two destinations of the navigation: Chat (the home screen) and Work. */
export const nav = (page: Page): Locator => page.getByRole("navigation", { name: "Screens" });

/** The home screen, from the navigation. Its one h1, Chat, is for assistive technology only. */
/**
 * Turns on the owner's setting Ask before every command, as Settings saves it, so that an ordinary command of a Manual
 * task asks again. For the tests whose subject is the approval card itself: by default a command kept inside the task's
 * copy runs without one. Call it after signing in.
 */
export async function askBeforeEveryCommand(page: Page, botbench: Botbench): Promise<void> {
  const res = await page.request.put(`${botbench.base}/api/settings`, { data: { askEveryCommand: true } });
  expect(res.status(), await res.text()).toBe(200);
}

export async function openComposer(page: Page): Promise<void> {
  await nav(page).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeAttached();
  await expect(messageBox(page)).toBeVisible();
}

/** Work, the list of runs and of tasks started on their own, from the navigation. */
export async function openWork(page: Page): Promise<void> {
  await nav(page).getByRole("link", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
}

/** Permissions or Usage, reached from Settings (the header's gear), as the client offers them. */
export async function openFromSettings(page: Page, screen: "Permissions" | "Usage"): Promise<void> {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-links").getByRole("link", { name: new RegExp(`^${screen}`) }).click();
  await expect(page.getByRole("heading", { name: screen, level: 1 })).toBeVisible();
}

/**
 * New task: the composer with One task chosen, at the address New task always had. With no repository remembered the
 * Add context sheet opens on its Repository view, since the owner came to work in one; that view is closed here, so a
 * test starts from the composer as it was.
 */
export async function openNewTask(page: Page): Promise<void> {
  await page.evaluate(() => (window.location.hash = "#/turn?start=task"));
  await expect(messageBox(page)).toBeVisible();
  const sheet = contextSheet(page);
  if (await sheet.evaluate((d: HTMLDialogElement) => d.open)) await closeContext(page);
}

/** The task screen's Details: the repository's full path and, while the task is worked on, its branch. Opened, and returned. */
export async function openDetails(page: Page): Promise<Locator> {
  const details = page.getByTestId("task-details");
  if (!(await details.evaluate((d: HTMLDetailsElement) => d.open))) await details.locator("summary").click();
  return details;
}

/** The task screen's disclosure of what Claude Code may do in the task's copy. Opened, and returned. */
export async function openCanDo(page: Page): Promise<Locator> {
  const details = page.getByTestId("can-do");
  if (!(await details.evaluate((d: HTMLDetailsElement) => d.open))) await details.locator("summary").click();
  return details;
}

/** The composer's message box, whatever it is named for (a chat, a task, a run). */
export const messageBox = (page: Page): Locator => page.locator("form.ds-composer textarea");
/** The Add context sheet, in whichever of its views. */
export const contextSheet = (page: Page): Locator => page.locator("dialog.ds-sheet");

/** Open the Add context sheet on its rows, from wherever it is. */
export async function openContext(page: Page): Promise<Locator> {
  const sheet = contextSheet(page);
  if (!(await sheet.evaluate((d: HTMLDialogElement) => d.open))) await page.getByRole("button", { name: "Add context" }).click();
  const back = sheet.getByRole("button", { name: "Back to Add context" });
  if (await back.isVisible()) await back.click();
  await expect(sheet.getByRole("heading", { name: "Add context" })).toBeVisible();
  return sheet;
}

/** Open one row's view in the sheet: `row` is the row's name, as "Repository" or "Mode". */
export async function openRow(page: Page, row: string): Promise<Locator> {
  const sheet = await openContext(page);
  await sheet.locator(".ds-context-list__button", { has: page.locator(".ds-context-list__label", { hasText: new RegExp(`^${row}$`) }) }).click();
  await expect(sheet.getByRole("button", { name: "Back to Add context" })).toBeVisible();
  return sheet;
}

export async function closeContext(page: Page): Promise<void> {
  const sheet = contextSheet(page);
  if (await sheet.evaluate((d: HTMLDialogElement) => d.open)) await sheet.getByRole("button", { name: "Close Add context" }).click();
  await expect(sheet).toBeHidden();
}

/** Back to the rows: a tapped option goes back by itself, unless it opens a field or carries a warning, or was already chosen. */
export async function backToRows(sheet: Locator): Promise<void> {
  await expect(sheet.getByRole("heading", { name: "Add context" }).or(sheet.getByRole("button", { name: "Back to Add context" }))).toBeVisible();
  const back = sheet.getByRole("button", { name: "Back to Add context" });
  if (await back.isVisible()) await back.click();
  await expect(sheet.getByRole("heading", { name: "Add context" })).toBeVisible();
}

/** Choose an option in one row's view, by its name, and go back to the rows. */
export async function choose(page: Page, row: string, option: string): Promise<void> {
  const sheet = await openRow(page, row);
  await sheet.getByRole("radio", { name: option, exact: true }).click();
  await backToRows(sheet);
}

/** Choose the repository at `path` by typing it as Another folder, and wait until Botbench calls it usable. */
export async function chooseRepository(page: Page, path: string): Promise<void> {
  const sheet = await openRow(page, "Repository");
  await sheet.getByRole("radio", { name: "Another folder…" }).check();
  await sheet.getByLabel("Folder path").fill(path);
  await expect(sheet.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
}

/** Add commands to Allowed commands, which lists what the repository's settings offer. */
export async function allowCommands(page: Page, commands: readonly string[]): Promise<void> {
  const sheet = await openRow(page, "Allowed commands");
  for (const command of commands) {
    await sheet.getByLabel("Add a command").fill(command);
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
  }
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
}

/** Send what the box holds and wait for the task's or run's own screen. */
async function sendAndOpen(page: Page, prompt: string, to: RegExp): Promise<void> {
  await closeContext(page);
  await messageBox(page).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(to);
}

/** Start one task in `repo` through the composer, from the home screen, and open its screen. */
export async function startTaskIn(page: Page, repo: string, prompt: string, options: { commands?: readonly string[] } = {}): Promise<void> {
  await openComposer(page);
  await chooseRepository(page, repo);
  await choose(page, "What to do", "One task");
  if (options.commands) await allowCommands(page, options.commands);
  await sendAndOpen(page, prompt, /#\/tasks\/\d+$/);
}

/** Plan a run in `repo` through the composer, from the home screen, with the settings given, and open its screen. */
export async function startRunIn(page: Page, repo: string, prompt: string, options: { mode?: "Manual" | "Semi-autonomous" | "Fully autonomous"; review?: string; delivery?: "Keep the branch" | "Open a pull request"; commands?: readonly string[] } = {}): Promise<void> {
  await openComposer(page);
  await chooseRepository(page, repo);
  await choose(page, "What to do", "Plan a run");
  if (options.mode) await choose(page, "Mode", options.mode);
  if (options.review) {
    const sheet = await openRow(page, "Review");
    // The reviewer and model as the option's value: the agent and the model id, apart by a space.
    // A click, not check(): choosing an option goes back to the rows by itself, so the radio may be gone before check()
    // could read it. The row says what was chosen.
    await sheet.locator(`input[name="review"][value="${options.review}"]`).click();
    await backToRows(sheet);
  }
  if (options.delivery) await choose(page, "When accepted", options.delivery);
  if (options.commands) await allowCommands(page, options.commands);
  await sendAndOpen(page, prompt, /#\/runs\/\d+$/);
}

/** Send a chat message from the home screen, with no repository. */
export async function sendChat(page: Page, text: string): Promise<void> {
  await messageBox(page).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
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
const CHECK_DOM = fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "design-system", "check-dom.js"), "utf8");

const APP_PREFIX = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "design-system.config.json"), "utf8")) as { appPrefix: string }).appPrefix;

/**
 * The Botbench theme's tokens, as the vendored copy has them: the light values, and the dark ones under the system's extension.
 * The client shows the theme's default mode, dark, unless the owner chose Light or Match device in Settings: a screen is
 * judged by the colours of the mode it is drawn in.
 */
type Colour = { hex: string };
const THEME = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "design-system", "themes", "botbench.tokens.json"), "utf8")) as {
  color: Record<string, { $value: Colour; $extensions?: { "design-system"?: { dark?: Colour } } }>;
  radius: Record<string, { $value: { value: number; unit: string } }>;
  text: Record<string, { $value: { value: number; unit: string } }>;
  font: Record<string, { $value: string[] }>;
  "border-width": { DEFAULT: { $value: { value: number; unit: string } } };
};
/** The browser-bar colour of each mode, as the theme gives it. */
export const THEME_COLOR = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "design-system", "themes", "botbench.json"), "utf8")) as { themeColor: Record<Mode, string> }).themeColor;
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;

export type Mode = "light" | "dark";

/**
 * A colour token as the browser reports it in `mode`, dark unless said: for assertions on a colour a component draws,
 * such as the primary button's background.
 */
export function token(name: string, mode: Mode = "dark"): string {
  const entry = THEME.color[name];
  if (entry === undefined) throw new Error(`The Botbench theme has no colour token "${name}".`);
  return rgb(mode === "light" ? entry.$value.hex : (entry.$extensions?.["design-system"]?.dark?.hex ?? entry.$value.hex));
}

/** The mode the page is drawn in, from the root's data-theme as the theme reads it: none or "dark" is dark, "auto" follows the device. */
export const pageMode = (page: Page): Promise<Mode> =>
  page.evaluate(() => {
    const theme = document.documentElement.getAttribute("data-theme");
    return theme === "light" || (theme === "auto" && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  });

// The colours of each mode: a light value drawn on the dark page is off the palette, and a dark one on the light page.
const PALETTE: Record<Mode, string[]> = { dark: Object.keys(THEME.color).map((name) => token(name, "dark")), light: Object.keys(THEME.color).map((name) => token(name, "light")) };
// A corner on the scale.
const RADII = Object.values(THEME.radius).map(({ $value }) => `${$value.value}${$value.unit}`);
/** A type size of the theme, as the browser reports it. */
const TEXT = (name: string): string => `${THEME.text[name]!.$value.value}${THEME.text[name]!.$value.unit}`;
/** The first family of a font token: the one the theme names first, which the browser reports first. */
const FIRST_FAMILY = (name: string): string => THEME.font[name]!.$value[0]!;
/** A computed font-family that starts with the theme's mono typeface: for code, commands, paths and diffs. */
export const MONO_FAMILY = new RegExp(`^"?${FIRST_FAMILY("mono")}"?(,|$)`);

/** The badge's status set, as the vendored catalogue has it: one icon and one tone for each state. */
const STATUS_SET = (
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "web", "vendor", "design-system", "components.json"), "utf8")) as { components: { name: string; statusSet?: { state: string; icon: string; tone: string }[] }[] }
).components.find((c) => c.name === "badge")!.statusSet!;

/**
 * Every badge on the screen, checked against the status set: a state the set names takes its icon and tone, and any
 * badge with the same words as another on the screen has the same icon and tone, so one state never looks two ways.
 */
export async function checkStatuses(page: Page, screen: string): Promise<void> {
  const badges = await page.locator(".ds-badge").evaluateAll((els) =>
    els.map((el) => ({
      words: (el.textContent ?? "").trim().replace(/:$/, ""),
      tone: [...el.classList].find((c) => c.startsWith("ds-badge--"))?.slice("ds-badge--".length) ?? "neutral",
      icon: el.querySelector("use")?.getAttribute("href")?.split("#ds-icon-")[1] ?? null,
    })),
  );
  const named: Record<string, string> = { "Checks passed": "Check passed", "Checks failed": "Check failed" };
  for (const badge of badges) {
    const state = STATUS_SET.find((entry) => entry.state === (named[badge.words] ?? badge.words));
    if (state !== undefined) expect({ words: badge.words, icon: badge.icon, tone: badge.tone }, `${screen}: the status set's look for ${state.state}`).toEqual({ words: badge.words, icon: state.icon, tone: state.tone });
    expect(badge.icon, `${screen}: the badge "${badge.words}" has its icon beside its words`).not.toBeNull();
    const same = badges.find((other) => other.words === badge.words);
    expect({ icon: badge.icon, tone: badge.tone }, `${screen}: every "${badge.words}" badge looks the same`).toEqual({ icon: same!.icon, tone: same!.tone });
  }
}

/** The primary button's look and a secondary button's, from the theme's tokens, in the default mode. */
export const PRIMARY_LOOK = { background: token("accent"), text: token("on-accent"), border: token("accent") };
// A secondary control rests on the theme's `fill` (design system 0.9.0), with the faint border.
export const SECONDARY_LOOK = { background: token("fill"), text: token("on-surface"), border: token("border") };

/** The buttons drawn as the primary action: filled with the theme's accent colour in the mode the page is drawn in. */
export const primaries = async (page: Page): Promise<(string | null)[]> => {
  const accent = token("accent", await pageMode(page));
  return page.getByRole("button").evaluateAll((buttons, accent) => buttons.filter((b) => getComputedStyle(b).backgroundColor === accent).map((b) => b.textContent), accent);
};

/**
 * The design system, checked on the rendered page: its structural rules (one primary action per view, disclosure
 * limits, cards, badges, emoji, stock phrases, controls that use no system component) find nothing; the view has one h1, in its page header; every colour drawn is one of its tokens; there is no
 * gradient or blur, no shadow except on a dialog, a toast or a menu, and no corner off its radius scale; its typefaces are the theme's; every control has a 44px pointer target; nothing scrolls sideways at phone width. Call it once the
 * screen has its data, and again with each dialog open: an open dialog is a view of its own.
 */
export async function checkDesign(page: Page, screen: string): Promise<void> {
  // A screen rebuilt on shadcn/ui is not drawn in the design system's vocabulary: its own checks stand in (ADR 0012).
  if ((await page.evaluate(() => document.documentElement.getAttribute("data-ui"))) === "next") {
    const finger = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    return checkLayout(page, finger ? 44 : 32, screen);
  }
  // The script's text is evaluated, not added as a script element, which Botbench's content security policy would refuse.
  await page.evaluate(CHECK_DOM);
  // The app's class prefix, as web/design-system.config.json has it: the rule that a view's controls use the system needs it on a rendered page.
  const findings = await page.evaluate((appPrefix) => (globalThis as unknown as { dsCheckDom(root: Element, options: { appPrefix: string }): { rule: string; message: string; fix: string; snippet: string }[] }).dsCheckDom(document.documentElement, { appPrefix }), APP_PREFIX);
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
        // The system's one shadow is on its overlays: a dialog, a toast and a menu, which float over the page the same way.
        if (style.boxShadow !== "none" && el.tagName !== "DIALOG" && !el.classList.contains("ds-toast") && !el.classList.contains("ds-menu")) decorations.push(`box-shadow on ${describe(el)}${pseudo ?? ""}`);
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
    // The app header's name is in the interface font since the design system 0.8.3; the sign-in's product name, code and output are mono.
    const mono = document.querySelector(".ds-sign-in__product, code, pre");
    return {
      small,
      colours,
      decorations,
      radii,
      components: document.querySelectorAll('[class*="ds-"]').length,
      h1: headings.filter((el) => el.tagName === "H1").map((el) => `${getComputedStyle(el).fontSize} ${el.className === "" ? "plain" : String(el.className)}${el.closest(".ds-page-header--compact") === null ? "" : " compact"}${el.closest(".ds-page-header, .ds-sign-in, .ds-not-found") === null ? " outside a page header" : ""}`),
      h2: plain("H2"),
      h3: plain("H3"),
      // An empty style attribute sets nothing: a screenshot that hides the caret leaves one on the focused field.
      offSystem: [...document.querySelectorAll("[style]")].filter((el) => el.getAttribute("style")!.trim() !== "").map(describe),
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodySize: getComputedStyle(document.body).fontSize,
      monoFont: mono ? getComputedStyle(mono).fontFamily : "",
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(found.components, `${screen}: the screen is built from the design system's components`).toBeGreaterThan(2);
  // One h1 a view: at the theme's 2xl in the page header, or plain in the sign-in pattern, or the empty state's title in the not-found
  // pattern, which that component draws at its own size; at the theme's lg in the compact page header that heads the list pane of
  // the master-detail pattern (the two-pane Settings). Plain h2 and h3 are a step smaller each.
  expect(found.h1, `${screen}: the view's one h1, at the size of a title`).toEqual([expect.stringMatching(new RegExp(`^(${TEXT("2xl")} (plain|ds-page-header__title)|${TEXT("lg")} ds-page-header__title compact|\\d+px ds-empty-state__title)$`))]);
  expect(found.h2.filter((size) => size !== TEXT("xl")), `${screen}: plain h2 headings are the theme's xl`).toEqual([]);
  expect(found.h3.filter((size) => size !== TEXT("lg")), `${screen}: plain h3 headings are the theme's lg`).toEqual([]);
  expect(found.offSystem, `${screen}: inline styles`).toEqual([]);
  const mode = await pageMode(page);
  const offPalette = Object.entries(found.colours).filter(([colour]) => !PALETTE[mode].includes(colour) && colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent");
  expect(offPalette, `${screen}: colours that are not tokens of the design system in ${mode} mode`).toEqual([]);
  expect(Object.keys(found.colours).length, `${screen}: the check saw colours`).toBeGreaterThan(2);
  expect(found.decorations, `${screen}: gradients, blur, or a shadow on anything but a dialog, a toast or a menu`).toEqual([]);
  expect(Object.entries(found.radii).filter(([radius]) => radius !== "0px" && !RADII.includes(radius)), `${screen}: corners off the radius scale`).toEqual([]);
  expect(found.small, `${screen}: touch targets under 44px`).toEqual([]);
  // The theme's own typefaces, as its tokens name them: the platform's, which Botbench does not load or substitute.
  expect(found.bodyFont.split(",")[0]!.replace(/"/g, "").trim(), `${screen}: body font`).toBe(FIRST_FAMILY("ui"));
  expect(found.bodySize, `${screen}: body size`).toBe(TEXT("ui"));
  if (found.monoFont !== "") expect(found.monoFont.split(",")[0]!.replace(/"/g, "").trim(), `${screen}: mono font`).toBe(FIRST_FAMILY("mono"));
  expect(found.overflow, `${screen}: no sideways scrolling at phone width`).toBe(0);
  await checkStatuses(page, screen);
  await checkWords(page, screen);
}

/**
 * The words on the screen, checked against docs/product/voice.md: every piece of text Botbench itself wrote, drawn or not
 * (a closed disclosure and a visually hidden label are one tap or one screen reader away), every accessible name and
 * the tab title hold none of the internal words that list bans. Text somebody else wrote (a prompt, the agent's reply,
 * a command, a path, a program's output) is marked `data-ds-content` where it is rendered and is not read here; nor is
 * an accessible name marked `data-ds-content-label`, which holds such text, nor what a sentence quotes, nor a path in it.
 * `checkDesign` calls it, so it runs on every screen and state the design check runs on.
 */
export async function checkWords(page: Page, screen: string): Promise<void> {
  const pieces = await page.evaluate(() => {
    const found: string[] = [document.title];
    const ours = (el: Element | null): boolean => el !== null && el.closest("[data-ds-content], script, style") === null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    // Text is read element by element, so words that sit side by side in two elements are not run together.
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text !== "" && ours(node.parentElement)) found.push(text);
    }
    for (const el of document.querySelectorAll("[aria-label], [title], [alt], [placeholder]")) {
      // A name that holds somebody else's words (the command a button removes, the title of the task it edits) is marked where it is written.
      if (!ours(el) || el.hasAttribute("data-ds-content-label")) continue;
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

/** A screenshot of the window as a phone shows it, at `SHOTS/<name>.png` when BOTBENCH_SHOTS is set. */
export async function tempShot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  // Wait for the sheet's slide and the caret to settle, so the picture is of the state, not of a transition.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  // A dialog's slide is a transition of the top layer, which getAnimations does not always list: the system's slowest is 240ms.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/*
 * A screen rebuilt on shadcn/ui and Tailwind (ADR 0012) is not drawn with the design system's classes, so `checkDesign`
 * does not apply to it. What stands in its place: `checkWords`, `checkLayout`, and `watchRefused` for the content
 * security policy. `checkDesign` itself runs `checkLayout` in its place when the screen it is asked about is a rebuilt one.
 */

/** Nothing scrolls sideways, no control is under `floor` px high (40 with a mouse, drawn at 32 in a bar; 44 under a finger), and no text is under 12px. */
export async function checkLayout(page: Page, floor: number, screen: string): Promise<void> {
  // A dialog or a menu that is still growing into place is measured smaller than it is drawn: wait for it, with a limit.
  await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))), new Promise((resolve) => setTimeout(resolve, 600))]));
  const found = await page.evaluate((least) => {
    const low: string[] = [];
    // The parts of an old screen a rebuilt one still draws (.ds- components, which the design checks covered where they came from) are left out.
    const old = (el: Element): boolean => el.closest("[class*='ds-']") !== null;
    for (const el of document.querySelectorAll("button, input, textarea, summary, [role=radio], [role=tab], [role=menuitem], a[href]")) {
      const box = el.getBoundingClientRect();
      // Not drawn, a link inside a sentence, or the hidden input a drawn radio keeps for a form.
      if (box.height === 0 || getComputedStyle(el).display === "inline" || el.getAttribute("aria-hidden") === "true" || old(el)) continue;
      // A control drawn smaller carries its pointer target on a pseudo-element.
      const target = getComputedStyle(el, "::after");
      const height = Math.max(box.height, target.content !== "none" && target.position === "absolute" ? parseFloat(target.height) || 0 : 0);
      if (height < least) low.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" is ${Math.round(height)}px high`);
    }
    const small = [...document.querySelectorAll("body *")].filter((el) => !old(el) && el.getClientRects().length > 0 && el.childElementCount === 0 && (el.textContent ?? "").trim() !== "" && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => `${getComputedStyle(el).fontSize}: ${(el.textContent ?? "").trim().slice(0, 30)}`);
    return { low, small, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  }, floor);
  expect(found, screen).toEqual({ low: [], small: [], sideways: 0 });
}

/**
 * The least a rebuilt screen is held to in a journey whose states this repository's fast tests cannot produce: its
 * words (docs/product/voice.md), and nothing scrolling sideways. Where a state can be produced without a model,
 * `checkLayout` is run on it as well (e2e/run.e2e.ts).
 */
export async function checkRebuilt(page: Page, screen: string): Promise<void> {
  await checkWords(page, screen);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${screen}: no sideways scrolling`).toBe(0);
}

/**
 * Everything the browser refuses or complains of from now on, as lines: a violation of the content security policy
 * (the page's own event, and Chrome's console line for one), any console error, any failed request, any page error.
 * Call it before the page is opened; a test ends by expecting the list to be empty.
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
    if (message.type() === "error" || /content security policy/i.test(message.text())) refused.push(`console ${message.type()}: ${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => refused.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => {
    // The live-updates request is ended by the page itself when a screen goes: that is not a refusal.
    if (request.failure()?.errorText !== "net::ERR_ABORTED") refused.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  return refused;
}

/*
 * The run screen (web/src/screens2/run/). Its one h1 is the run's title, the owner's words, so a test reads the run's
 * number from the address; its controls (Make the mode stricter, Cancel run) are a menu in the bar.
 */

/** The run whose screen is open, by its number, once the address is a run's. */
export async function openRunId(page: Page): Promise<number> {
  await expect(page).toHaveURL(/#\/runs\/\d+$/);
  await expect(page.getByTestId("run-status")).toBeVisible();
  return Number(/#\/runs\/(\d+)$/.exec(page.url())![1]);
}

/** The rows of the run screen's tasks, and the state each shows in the product's own word. */
export const runTaskRows = (page: Page): Locator => page.getByTestId("run-tasks").locator(":scope > li");
export const RUN_TASK_STATE = "[data-testid=run-task-state]";

/** The run's three steps, in order: each a list item with its state as `data-state`, its name and its words. */
export const runSteps = (page: Page): Locator => page.getByRole("list", { name: /^Steps of run \d+$/ }).getByRole("listitem");

/** Open the run's menu, in the screen's bar, and return it. */
export async function openRunMenu(page: Page): Promise<Locator> {
  await page.getByTestId("run-menu").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Choose Cancel run from the run's menu: the question that follows is the test's to answer. */
export async function askCancelRun(page: Page): Promise<Locator> {
  await (await openRunMenu(page)).getByRole("menuitem", { name: "Cancel run" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Cancel this run?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Whether the run's menu offers Cancel run now: false also when the run has no menu left. */
export async function offersCancelRun(page: Page): Promise<boolean> {
  if ((await page.getByTestId("run-menu").count()) === 0) return false;
  const menu = await openRunMenu(page);
  const offered = (await menu.getByRole("menuitem", { name: "Cancel run" }).count()) > 0;
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  return offered;
}

/** The buttons drawn as the primary action on a rebuilt screen: filled with its theme's accent. */
export const filledButtons = (page: Page): Promise<(string | null)[]> =>
  page.getByRole("button").evaluateAll((buttons) => {
    const probe = document.createElement("span");
    probe.className = "bg-primary";
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return buttons.filter((button) => getComputedStyle(button).backgroundColor === accent).map((button) => button.textContent);
  });

export { expect };
