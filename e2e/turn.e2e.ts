import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { checkDesign, expect, SHOTS, signIn, test, watchRequests } from "./helpers.ts";
import { startSmelt, tempDir, type Smelt } from "./smelt.ts";

const reply = (page: Page) => page.locator('[data-event="text"]');

test("LIVE: sign in, send a prompt, and the real reply appears without a reload; both screens follow the design system", async ({ page, smelt }) => {
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
  // The alert names its tone in a word, then says what happened and what to do.
  await expect(page.getByRole("alert")).toHaveText("ErrorWrong token. Check it and try again.");
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
