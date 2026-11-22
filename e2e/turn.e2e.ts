import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { startSmelt, tempDir, type Smelt } from "./smelt.ts";

// Everything here is real: a Smelt process, the built client, Chrome, and for
// the tests marked LIVE the owner's Claude Code on its cheapest model.

/** Set SMELT_SHOTS to a directory to keep screenshots of both screens. */
const SHOTS = process.env.SMELT_SHOTS;

const test = base.extend<{ smelt: Smelt }>({
  smelt: async ({}, use) => {
    const smelt = await startSmelt();
    await use(smelt);
    const { leftover } = await smelt.stop();
    expect(leftover, "no CLI process is left after Smelt stops").toEqual([]);
    fs.rmSync(path.dirname(smelt.home), { recursive: true, force: true });
  },
});

async function signIn(page: Page, smelt: Smelt): Promise<void> {
  await page.goto(smelt.base);
  await page.getByLabel("Login token").fill(smelt.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toContainText("signed in");
}

/** Every request the page makes must go to Smelt itself. */
function watchRequests(page: Page, smelt: Smelt): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`${smelt.base}/`) && !url.startsWith("data:")) foreign.push(url);
  });
  return foreign;
}

const DESIGN_COLOURS = ["rgb(26, 26, 26)", "rgb(250, 250, 249)", "rgb(23, 23, 23)", "rgb(229, 229, 229)", "rgb(115, 115, 115)"];

/** DESIGN.md, checked on the rendered page: its five colours only, Geist, no gradients or shadows, 44px targets. */
async function checkDesign(page: Page, screen: string): Promise<void> {
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

const reply = (page: Page) => page.locator('[data-event="text"]');

test("LIVE: sign in, send a prompt, and the real reply appears without a reload; both screens follow DESIGN.md", async ({ page, smelt }) => {
  const foreign = watchRequests(page, smelt);
  await page.goto(smelt.base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await checkDesign(page, "sign-in");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u4-sign-in.png") });

  // The keyboard alone is enough: the field has focus and Enter submits.
  await expect(page.getByLabel("Login token")).toBeFocused();
  await page.keyboard.type(smelt.token);
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("driver-state")).toHaveText(/^Claude Code \d+\.\d+\.\d+ · signed in · subscription$/);
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("stream-banner")).toHaveCount(0);
  await checkDesign(page, "turn, empty");

  // A mark on the page that a reload would wipe out.
  await page.evaluate(() => ((window as unknown as { smeltLoadedOnce: boolean }).smeltLoadedOnce = true));
  const prompt = "Reply with exactly the word: marmot";
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  // The one button is Stop while the turn runs.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);
  await expect(reply(page)).toContainText(/marmot/i, { timeout: 120_000 });
  await expect(page.locator('[data-event="turn_ended"]')).toContainText("Turn completed.");
  await expect(page.locator('[data-event="usage"]')).toContainText(/\d+ in, \d+ out/);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("");
  // The transcript is in order: prompt, reply, end.
  expect(await page.locator("[data-event]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-event")).filter((k) => ["user_prompt", "text", "turn_ended"].includes(k!)))).toEqual(["user_prompt", "text", "turn_ended"]);
  expect(await page.evaluate(() => (window as unknown as { smeltLoadedOnce?: boolean }).smeltLoadedOnce)).toBe(true);

  await checkDesign(page, "turn, with a transcript");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u4-turn.png") });
  expect(foreign, "requests to anything but Smelt").toEqual([]);
});

test("LIVE: a dropped event stream shows a banner, recovers, and the next reply still arrives; a reload shows the transcript again", async ({ page, smelt }) => {
  await signIn(page, smelt);
  await page.getByLabel("Prompt").fill("Reply with exactly the word: otter");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(reply(page)).toContainText(/otter/i, { timeout: 120_000 });
  await expect(page.getByTestId("stream-banner")).toHaveCount(0);

  // Freeze the Smelt process: the stream goes silent, as it does when a network path dies without closing
  // the connection. The client notices the missing heartbeats, says so, and keeps trying.
  smelt.freeze();
  await expect(page.getByTestId("stream-banner")).toHaveText("Live updates are disconnected. Reconnecting.", { timeout: 60_000 });
  await expect(page.locator("[data-event]").first()).toBeVisible();
  smelt.thaw();
  await expect(page.getByTestId("stream-banner")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);

  // The recovered stream delivers a new turn, continued in the same session: it knows the first word.
  await page.getByLabel("Prompt").fill("Which word did I ask you for? Reply with only that word, twice.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(reply(page)).toHaveCount(2, { timeout: 120_000 });
  await expect(reply(page).nth(1)).toContainText(/otter/i);
  await expect(page.locator('[data-event="turn_ended"]')).toHaveCount(2);
  // Nothing arrived twice across the drop.
  await expect(page.locator('[data-event="user_prompt"]')).toHaveCount(2);

  // A client that arrives late gets the stored transcript.
  const before = await page.locator("[data-event]").allTextContents();
  await page.reload();
  await expect(page.locator('[data-event="turn_ended"]')).toHaveCount(2);
  expect(await page.locator("[data-event]").allTextContents()).toEqual(before);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("LIVE: Stop ends a running turn, and prompt text is shown as text, never as markup", async ({ page, smelt }) => {
  await signIn(page, smelt);
  const prompt = 'Write a 1500 word essay about rivers. <img src=x onerror="window.smeltXss=1"><b id="injected">bold</b>';
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="session_started"]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator('[data-event="turn_ended"]')).toHaveText(/Turn stopped before it finished\./, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);

  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);
  await expect(page.locator("#injected, [role=log] img, [role=log] b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { smeltXss?: number }).smeltXss)).toBeUndefined();
});

test("with Claude Code signed out, the screen says so and offers no send control", async ({ page }) => {
  // The real CLI, pointed at an empty configuration directory, reports itself signed out.
  const empty = tempDir("smelt-e2e-claude-config-");
  const smelt = await startSmelt({ env: { CLAUDE_CONFIG_DIR: empty } });
  try {
    await page.goto(smelt.base);
    await page.getByLabel("Login token").fill(smelt.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: signed out");
    await expect(page.getByTestId("driver-problem")).toContainText("Claude Code is signed out. Run `claude auth login` in a terminal.");
    await expect(page.getByTestId("driver-problem")).toContainText("Prompts cannot be sent until this is fixed.");
    await expect(page.getByRole("button", { name: /send|stop/i })).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator("form")).toHaveCount(0);
    await checkDesign(page, "turn, signed out");
    // The one control left asks the CLI again, for real.
    const probed = page.waitForResponse((r) => r.url().endsWith("/api/driver") && r.status() === 200);
    await page.getByRole("button", { name: "Check again" }).click();
    await probed;
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: signed out");
    await expect(page.getByRole("textbox")).toHaveCount(0);
  } finally {
    expect((await smelt.stop()).leftover).toEqual([]);
    fs.rmSync(path.dirname(smelt.home), { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a wrong token shows an error and stays on sign-in", async ({ page, smelt }) => {
  await page.goto(smelt.base);
  await page.getByLabel("Login token").fill("not-the-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong token. Check it and try again.");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Login token")).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await checkDesign(page, "sign-in, with an error");
  // No session came of it: the API still refuses this browser.
  expect((await page.request.get(`${smelt.base}/api/session`)).status()).toBe(401);
  expect((await page.request.get(`${smelt.base}/api/driver`)).status()).toBe(401);
  // The right token still works afterwards.
  await page.getByLabel("Login token").fill(smelt.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toContainText("Claude Code");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("when Smelt restarts, the stream banner shows and the client returns to sign-in, since sessions do not outlive the process", async ({ page }) => {
  const first = await startSmelt();
  let second: Smelt | undefined;
  try {
    await signIn(page, first);
    expect((await first.stop()).leftover).toEqual([]);
    await expect(page.getByTestId("stream-banner")).toBeVisible();
    second = await startSmelt({ home: first.home, port: first.port });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Your session ended");
    await page.getByLabel("Login token").fill(second.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("driver-state")).toContainText("signed in");
    await expect(page.getByTestId("stream-banner")).toHaveCount(0);
  } finally {
    await second?.stop();
    fs.rmSync(path.dirname(first.home), { recursive: true, force: true });
  }
});
