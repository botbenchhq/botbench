import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { checkDesign, checkWords, copyShot, expect, nav, SHOTS, signIn, tempShot, test, watchRequests } from "./helpers.ts";
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

  await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeEnabled();
  // When all is well the header says nothing about the agent.
  await expect(page.getByTestId("driver-state")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add context" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("stream-banner")).toHaveCount(0);
  await checkDesign(page, "turn, empty");

  // A mark on the page that a reload would wipe out.
  await page.evaluate(() => ((window as unknown as { botbenchLoadedOnce: boolean }).botbenchLoadedOnce = true));
  const prompt = "Reply with exactly the word: marmot";
  await page.getByLabel("Message Claude Code").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  // The one button is Stop while the turn runs.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);
  await expect(reply(page)).toContainText(/marmot/i, { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  // A reply with no step of its own has no row after it: no line says it completed, how long it took or what it counted
  // (Usage keeps the counts).
  await expect(page.locator('[data-event="turn_ended"]')).toHaveCount(0);
  expect(await page.getByRole("log").innerText(), "what is drawn in the transcript").not.toMatch(/completed|tokens|worked for/i);
  // The model is named once, in the chip: the model that answered is the one asked for, so the transcript has no row for it.
  await expect(page.getByTestId("turn-model")).toHaveCount(0);
  await expect(page.locator('[data-event="session_started"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toBeAttached();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByLabel("Message Claude Code")).toHaveValue("");
  // The transcript is in order: prompt, reply.
  expect(await page.locator("[data-event]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-event")).filter((k) => ["user_prompt", "text", "turn_ended"].includes(k!)))).toEqual(["user_prompt", "text"]);
  expect(await page.evaluate(() => (window as unknown as { botbenchLoadedOnce?: boolean }).botbenchLoadedOnce)).toBe(true);

  await checkDesign(page, "turn, with a transcript");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u4-turn.png") });

  // New chat begins again: the transcript is put away on this device, also after a reload, and the next prompt starts afresh.
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.locator("[data-event]")).toHaveCount(0);
  // An empty chat shows nothing above the box, and New chat, a quiet icon in the header, goes until there is something to put away.
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveCount(0);
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
  await page.getByLabel("Message Claude Code").fill("Use your Read tool exactly once to read the file notes.txt in the current directory. Then reply with only the word that file names.");
  await page.getByRole("button", { name: "Send" }).click();
  // The action is in the transcript as soon as it is made: nothing the agent did is hidden. It is the design system's
  // tool call, as a transcript row, whose state the stylesheet draws from data-state: running, then succeeded.
  const action = page.locator('[data-event="tool_call"]').first();
  const call = action.locator(".ds-tool-call.ds-tool-call--row");
  const line = action.locator("summary").first();
  await expect(line).toContainText("notes.txt", { timeout: 120_000 });
  await expect(call).toHaveAttribute("data-state", /^(running|succeeded)$/);
  await expect(page.locator('[data-event="turn_ended"]')).toBeVisible({ timeout: 120_000 });
  await expect(call).toHaveAttribute("data-state", "succeeded");
  // The state in words first, then the one plain line; the time it took, from the stored times of the call and its result.
  await expect(call.locator(".ds-tool-call__status")).toHaveText("Done");
  await expect(call.locator(".ds-tool-call__title")).toHaveText(/^Done\s*Read\s*notes\.txt$/);
  await expect(call.locator(".ds-tool-call__target")).toHaveText("notes.txt");
  await expect(call.locator(".ds-tool-call__duration")).toHaveText(/^\d+ ms$|^\d+(\.\d)? s$|^\d+ min( \d+ s)?$/);
  await expect(reply(page).last()).toContainText(/heron/i);
  // The agent's text is a finished message: Claude Code sends each reply whole, so nothing is drawn as streaming.
  await expect(reply(page).last()).toHaveAttribute("data-state", "done");
  await expect(page.locator('[data-event="turn_ended"] summary')).toHaveText(/^Worked for (\d+m )?\d+s$/);
  // It returned without failing and waits for nothing, so it is folded; one tap shows the whole path and what it returned.
  const result = action.locator('[data-event="tool_result"]');
  await expect(call.locator("details").first()).not.toHaveAttribute("open");
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

test("LIVE: three tool calls in a row are one step group: a line that counts them in plain words and says how long the reply took, folded once the reply is in, with every call a row one tap away", async ({ page, botbench }) => {
  for (const [name, word] of [["a.txt", "otter"], ["b.txt", "badger"], ["c.txt", "stoat"]]) fs.writeFileSync(path.join(botbench.home, "scratch", name!), `The word is ${word}.\n`);
  await signIn(page, botbench);
  await page.getByLabel("Message Claude Code").fill("Use your Read tool three times, on a.txt, b.txt and c.txt in the current directory, before you write anything. Then reply with only the three words those files name.");
  await page.getByRole("button", { name: "Send" }).click();
  const group = page.locator("details.ds-step-group");
  // The reply's time ends the group's own line once the reply is in: there is no second row for it after the answer.
  await expect(group.getByTestId("worked-for")).toBeAttached({ timeout: 120_000 });
  await expect(group).toHaveCount(1);
  await expect(page.locator('[data-event="turn_ended"]')).toHaveCount(0);
  // The summary counts what was done, from the calls themselves, then the time the reply took.
  await expect(group.locator(".ds-step-group__title")).toHaveText("Read 3 files");
  await expect(group.getByTestId("worked-for")).toHaveText(/^Worked for (\d+m )?\d+s$/);
  // Every call went well and the reply is in: the group is folded to its line. The calls are one tap away.
  await expect(group).not.toHaveAttribute("open");
  await expect(reply(page).last()).toContainText(/otter/i);
  await checkDesign(page, "chat, a finished reply with its step group folded");
  await tempShot(page, "home-reply-group-closed");
  await group.locator("summary").first().click();
  await expect(group).toHaveAttribute("open");
  // The tokens of the reply follow the calls, inside the group.
  await expect(group.locator('[data-event="usage"]')).toHaveText(/^Tokens: \d+ in, \d+ out$/);
  const steps = group.locator('.ds-step-group__steps > [data-event="tool_call"]');
  await expect(steps).toHaveCount(3);
  for (const step of await steps.all()) await expect(step.locator(".ds-tool-call")).toHaveAttribute("data-state", "succeeded");
  // In the open group a step that succeeded shows only its check: the word is cut from view and kept for a screen reader.
  const status = steps.first().locator(".ds-tool-call__status");
  await expect(status).toHaveText("Done");
  expect(await status.evaluate((el) => el.getBoundingClientRect().width), "only the check is drawn").toBeLessThanOrEqual(16);
  await tempShot(page, "home-reply-group-open");
  // A step's detail is the second level, with its raw arguments inside it, under their own words: there is no third.
  await steps.first().locator("summary").first().click();
  await expect(steps.first()).toContainText("Technical details");
  await expect(steps.first().locator("details details")).toHaveCount(0);
  await expect(steps.first()).toContainText('"file_path"');
  await checkDesign(page, "chat, a step group with a step open");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "chat-step-group.png"), fullPage: true });
});

test("LIVE: words the owner or the agent wrote are never judged, and the same words in Botbench's own text are", async ({ page, botbench }) => {
  await signIn(page, botbench);
  // A prompt and a reply full of the words Botbench itself never shows.
  const words = "turn attempt worktree driver broker gate floor hook stream role grant blocked declined rate limit";
  await page.getByLabel("Message Claude Code").fill(`Reply with exactly this line and nothing else: ${words}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(reply(page).last()).toContainText("broker gate floor hook", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
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
  await page.getByLabel("Message Claude Code").fill("Reply with exactly the word: otter");
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
  await page.getByLabel("Message Claude Code").fill("Which word did I ask you for? Reply with only that word, twice.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(reply(page)).toHaveCount(2, { timeout: 120_000 });
  await expect(reply(page).nth(1)).toContainText(/otter/i);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  // Nothing arrived twice across the drop.
  await expect(page.locator('[data-event="user_prompt"]')).toHaveCount(2);

  // A client that arrives late gets the stored transcript.
  const before = await page.locator("[data-event]").allTextContents();
  await page.reload();
  await expect(reply(page)).toHaveCount(2);
  expect(await page.locator("[data-event]").allTextContents()).toEqual(before);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("LIVE: Stop ends a running turn, and prompt text is shown as text, never as markup", async ({ page, botbench }) => {
  await signIn(page, botbench);
  const prompt = 'Write a 1500 word essay about rivers. <img src=x onerror="window.botbenchXss=1"><b id="injected">bold</b>';
  await page.getByLabel("Message Claude Code").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  // The reply is under way once Botbench has stored the prompt of its attempt. (The model is named only when the one that
  // answers is not the one asked for, so there is no model row to wait for.)
  await expect(page.locator('[data-event="user_prompt"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator('[data-event="turn_ended"]')).toHaveText(/^StoppedStopped before it finished\./, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);

  await expect(page.locator('[data-event="user_prompt"]')).toContainText(prompt);
  await expect(page.locator("#injected, [role=log] img, [role=log] b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { botbenchXss?: number }).botbenchXss)).toBeUndefined();
});

test("the chat box names the agent in its placeholder and for assistive technology, with no label drawn; the model is one chip that opens Add context; nothing idle shows in the header", async ({ page, botbench }) => {
  // The real Claude Code is asked whether it is signed in and which models it offers; no prompt is sent.
  await signIn(page, botbench);
  await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeEnabled();
  await expect(page.getByTestId("driver-state")).toHaveCount(0);
  const box = page.getByRole("textbox", { name: "Message Claude Code" });
  await expect(box).toHaveAttribute("placeholder", "Message Claude Code");
  await expect(page.locator("form.ds-composer label")).toHaveCount(0);
  await expect(page.getByText("Prompt", { exact: true })).toHaveCount(0);

  // The model is one chip under the box, showing the current choice; the list and its helper line are behind it, in the sheet.
  const chip = page.getByRole("button", { name: /^Model: / });
  await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
  await expect(page.getByText("The list is what Claude Code reports on this Mac.")).toBeHidden();
  // Nothing has arrived, so there is nothing to jump to: the block is in the page, hidden.
  await expect(page.locator(".ds-jump-to-latest")).toBeHidden();
  // With no approval waiting the header shows no approvals line, and Settings is an icon with a name.
  await expect(page.getByTestId("approval-tray")).toBeEmpty();
  await expect(page.getByText("No approvals are waiting.")).toHaveCount(0);
  const settings = page.getByRole("banner").getByRole("link", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings).toHaveText("");
  // An empty chat is the box and nothing above it: the view's one h1 is there for assistive technology only, and New chat
  // comes only once there is a chat to put away. The navigation is two destinations.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Chat"]);
  expect(await page.getByRole("heading", { level: 1 }).evaluate((el) => el.closest(".ds-visually-hidden") !== null), "the h1 is visually hidden").toBe(true);
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(page.getByTestId("composer-about")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await expect(nav(page).getByRole("link")).toHaveText(["Chat", "Work"]);
  await checkDesign(page, "chat, empty");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "ui-chat.png") });
  await tempShot(page, "home-empty");

  await chip.click();
  await expect(page.locator("dialog.ds-sheet").getByRole("heading", { name: "Model" })).toBeVisible();
  await expect(page.getByTestId("model-source")).toHaveText("The list is what Claude Code reports on this Mac.");
  await checkDesign(page, "chat, model open");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "ui-chat-model.png") });
});

test("with Claude Code signed out, the composer says why it cannot send, and Check again asks the agent again", async ({ page }) => {
  // The real CLI, pointed at an empty configuration directory, reports itself signed out.
  const empty = tempDir("botbench-e2e-claude-config-");
  const botbench = await startBotbench({ env: { CLAUDE_CONFIG_DIR: empty } });
  try {
    await page.goto(botbench.base);
    await page.getByLabel("Login token").fill(botbench.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: signed out");
    await expect(page.getByTestId("driver-problem")).toContainText("Claude Code is signed out. Run `claude auth login` in a terminal.");
    await expect(page.getByTestId("driver-problem")).toContainText("Nothing can be sent until this is fixed.");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription(/^Claude Code is signed out\./);
    await expect(page.getByRole("textbox")).toBeDisabled();
    await checkDesign(page, "chat, signed out");
    // Check again asks the CLI again, for real.
    const probed = page.waitForResponse((r) => r.url().endsWith("/api/driver") && r.status() === 200);
    await page.getByRole("button", { name: "Check again" }).click();
    await probed;
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: signed out");
    await expect(send).toBeDisabled();
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
  await expect(page.getByLabel("Message Claude Code")).toHaveCount(0);
  await checkDesign(page, "sign-in, with an error");
  // No session came of it: the API still refuses this browser.
  expect((await page.request.get(`${botbench.base}/api/session`)).status()).toBe(401);
  expect((await page.request.get(`${botbench.base}/api/driver`)).status()).toBe(401);
  // The right token still works afterwards.
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("when Botbench restarts, the stream banner shows and goes once it is back, and the device is still signed in, since sessions are kept across restarts", async ({ page }) => {
  const first = await startBotbench();
  let second: Botbench | undefined;
  try {
    await signIn(page, first);
    expect((await first.stop()).leftover).toEqual([]);
    await expect(page.getByTestId("stream-banner")).toBeVisible();
    second = await startBotbench({ home: first.home, port: first.port });
    await expect(page.getByTestId("stream-banner")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeEnabled();
  } finally {
    await second?.stop();
    fs.rmSync(path.dirname(first.home), { recursive: true, force: true });
  }
});
