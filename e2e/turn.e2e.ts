import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { checkDesign, checkWords, copyShot, expect, SHOTS, signIn, test, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

const reply = (page: Page) => page.locator('[data-event="text"]');

test("LIVE: sign in, send a prompt, and the real reply appears without a reload; both screens follow the design system", async ({ page, botbench }) => {
  const foreign = watchRequests(page, botbench);
  await page.goto(botbench.base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await checkDesign(page, "sign-in");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u4-sign-in.png") });
  await copyShot(page, "sign-in");

  // The keyboard alone is enough: the field has focus and Enter submits.
  await expect(page.getByLabel("Login token")).toBeFocused();
  await page.keyboard.type(botbench.token);
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("driver-state")).toHaveText(/^Claude Code \d+\.\d+\.\d+ · signed in · subscription$/);
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("stream-banner")).toHaveCount(0);
  await checkDesign(page, "turn, empty");

  // A mark on the page that a reload would wipe out.
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
  const prompt = "Reply with exactly the word: marmot";
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  // The one button is Stop while the turn runs.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);
  await expect(reply(page)).toContainText(/marmot/i, { timeout: 120_000 });
  await expect(page.locator('[data-event="turn_ended"]').locator("summary")).toHaveText(/^Worked for (\d+m )?\d+s$/);
  // No line says the reply completed, and no token count is on a main line: the count is under the quiet "Worked for" row.
  expect(await page.getByRole("log").innerText(), "what is drawn in the transcript").not.toMatch(/completed|tokens/i);
  await expect(page.locator('[data-event="usage"]')).toBeHidden();
  await page.locator('[data-event="turn_ended"] summary').click();
  await expect(page.locator('[data-event="usage"]')).toHaveText(/^Tokens: \d+ in, \d+ out$/);
  // The model is named as Claude Code itself names it, with the exact id one tap away.
  await expect(page.getByTestId("turn-model")).toHaveText(/^Model: Haiku [\d.]+$/);
  const session = page.locator('[data-event="session_started"]');
  await expect(session.locator("summary")).toHaveText(/^ModelHaiku [\d.]+$/);
  await session.locator("summary").click();
  await expect(session).toContainText(/Model id: claude-haiku-/);
  await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("");
  // The transcript is in order: prompt, reply, end.
  expect(await page.locator("[data-event]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-event")).filter((k) => ["user_prompt", "text", "turn_ended"].includes(k!)))).toEqual(["user_prompt", "text", "turn_ended"]);
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);

  await checkDesign(page, "turn, with a transcript");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u4-turn.png") });

  // New chat begins again: the transcript is put away on this device, also after a reload, and the next prompt starts afresh.
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.locator("[data-event]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No messages yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await checkDesign(page, "chat, after New chat");
  await page.reload();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.locator("[data-event]")).toHaveCount(0);
  expect(foreign, "requests to anything but Botbench").toEqual([]);
});

test("LIVE: a chat reply that used a tool shows what the agent did as one plain line, with the detail one tap away and the raw arguments a level deeper", async ({ page, botbench }) => {
  // A real file in the folder a chat works in, for the agent to read.
  fs.writeFileSync(path.join(botbench.home, "scratch", "notes.txt"), "The word is heron.\n");
  await signIn(page, botbench);
  await page.getByLabel("Prompt").fill("Use your Read tool exactly once to read the file notes.txt in the current directory. Then reply with only the word that file names.");
  await page.getByRole("button", { name: "Send" }).click();
  // The action is in the transcript as soon as it is made: nothing the agent did is hidden.
  const action = page.locator('[data-event="tool_call"]').first();
  const line = action.locator("summary").first();
  await expect(line).toContainText("notes.txt", { timeout: 120_000 });
  await expect(page.locator('[data-event="turn_ended"]')).toBeVisible({ timeout: 120_000 });
  await expect(action).toHaveAttribute("data-state", "done");
  await expect(line).toHaveText(/^Read\s*notes\.txt$/);
  await expect(reply(page).last()).toContainText(/heron/i);
  await expect(page.locator('[data-event="turn_ended"] summary')).toHaveText(/^Worked for (\d+m )?\d+s$/);
  // It returned without failing and waits for nothing, so it is folded; one tap shows the whole path and what it returned.
  const result = action.locator('[data-event="tool_result"]');
  await expect(action.locator("details").first()).not.toHaveAttribute("open");
  await expect(result).toBeHidden();
  await line.click();
  await expect(action.locator("pre").first()).toContainText(path.join("scratch", "notes.txt"));
  await expect(result).toContainText("Output");
  await expect(result).toContainText("The word is heron.");
  // The raw arguments are a level deeper, under their own summary.
  const technical = action.locator("details details");
  await expect(technical.locator("summary")).toHaveText("Technical details");
  await expect(technical.locator("pre")).toBeHidden();
  await technical.locator("summary").click();
  await expect(technical).toContainText("Tool: Read");
  await expect(technical.locator("pre")).toContainText('"file_path"');
  await checkDesign(page, "chat, a tool row open to its technical details");
  await technical.locator("summary").click();
  await copyShot(page, "chat-tool");
});

test("LIVE: words the owner or the agent wrote are never judged, and the same words in Botbench's own text are", async ({ page, botbench }) => {
  await signIn(page, botbench);
  // A prompt and a reply full of the words Botbench itself never shows.
  const words = "turn attempt worktree driver broker gate floor hook stream role grant blocked declined rate limit";
  await page.getByLabel("Prompt").fill(`Reply with exactly this line and nothing else: ${words}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(reply(page).last()).toContainText("broker gate floor hook", { timeout: 120_000 });
  await expect(page.locator('[data-event="turn_ended"]')).toBeVisible();
  await expect(page.locator('[data-event="user_prompt"]')).toContainText(words);
  await checkWords(page, "chat, a transcript that holds the banned words");
  // The same words in an interface label are caught: the check is not blind.
  await page.evaluate(() => {
    const label = document.createElement("p");
    label.id = "planted-for-the-check";
    label.textContent = "Turn completed.";
    document.querySelector("main")!.append(label);
  });
  await expect(checkWords(page, "chat, with an internal word planted in the interface")).rejects.toThrow(/internal words on the screen/);
  await page.evaluate(() => document.getElementById("planted-for-the-check")!.remove());
  await checkWords(page, "chat, after the planted word is gone");
});

test("LIVE: a dropped event stream shows a banner, recovers, and the next reply still arrives; a reload shows the transcript again", async ({ page, botbench }) => {
  await signIn(page, botbench);
  await page.getByLabel("Prompt").fill("Reply with exactly the word: otter");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(reply(page)).toContainText(/otter/i, { timeout: 120_000 });
  await expect(page.getByTestId("stream-banner")).toHaveCount(0);

  // Freeze the Botbench process: the stream goes silent, as it does when a network path dies without closing
  // the connection. The client notices the missing heartbeats, says so, and keeps trying.
  botbench.freeze();
  await expect(page.getByTestId("stream-banner")).toHaveText("Live updates are disconnected. Reconnecting.", { timeout: 60_000 });
  await expect(page.locator("[data-event]").first()).toBeVisible();
  botbench.thaw();
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

test("LIVE: Stop ends a running turn, and prompt text is shown as text, never as markup", async ({ page, botbench }) => {
  await signIn(page, botbench);
  const prompt = 'Write a 1500 word essay about rivers. <img src=x onerror="window.botbenchXss=1"><b id="injected">bold</b>';
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="session_started"]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator('[data-event="turn_ended"]')).toHaveText(/^StoppedStopped before it finished\./, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);

  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);
  await expect(page.locator("#injected, [role=log] img, [role=log] b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { botbenchXss?: number }).botbenchXss)).toBeUndefined();
});

test("with Claude Code signed out, the screen says so and offers no send control", async ({ page }) => {
  // The real CLI, pointed at an empty configuration directory, reports itself signed out.
  const empty = tempDir("botbench-e2e-claude-config-");
  const botbench = await startBotbench({ env: { CLAUDE_CONFIG_DIR: empty } });
  try {
    await page.goto(botbench.base);
    await page.getByLabel("Login token").fill(botbench.token);
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
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a wrong token shows an error and stays on sign-in", async ({ page, botbench }) => {
  await page.goto(botbench.base);
  await page.getByLabel("Login token").fill("not-the-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The alert names its tone in a word, then says what happened and what to do.
  await expect(page.getByRole("alert")).toHaveText("ErrorWrong token. Check it and try again.");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Login token")).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await checkDesign(page, "sign-in, with an error");
  // No session came of it: the API still refuses this browser.
  expect((await page.request.get(`${botbench.base}/api/session`)).status()).toBe(401);
  expect((await page.request.get(`${botbench.base}/api/driver`)).status()).toBe(401);
  // The right token still works afterwards.
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("driver-state")).toContainText("Claude Code");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("when Botbench restarts, the stream banner shows and the client returns to sign-in, since sessions do not outlive the process", async ({ page }) => {
  const first = await startBotbench();
  let second: Botbench | undefined;
  try {
    await signIn(page, first);
    expect((await first.stop()).leftover).toEqual([]);
    await expect(page.getByTestId("stream-banner")).toBeVisible();
    second = await startBotbench({ home: first.home, port: first.port });
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
