import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createChat } from "../src/api/chat.ts";
import { createTurns } from "../src/api/turns.ts";
import { createBroker } from "../src/approvals/broker.ts";
import { ClaudeCodeDriver } from "../src/drivers/claude-code.ts";
import { openStore } from "../src/store/db.ts";
import { chatReplayDriver } from "../test/support/replay-chat.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkScreen, expect, messageBox, primaries, SCREEN_ONLY, sendChat, SHOTS, signIn } from "./helpers.ts";

// New chat or task, the chat and the decision surface, rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), in the real
// client against a real Botbench process with its real content security policy. No model turn: Claude Code, in a chat
// only, replays real chat turns that asked to fetch https://example.com (e2e/serve-replayed-chat.ts, the owner's
// approved exception); each recorded call is put to the real permission gate, so the request the screen shows, and
// Allow and Decline, are the real ones. With BOTBENCH_SHOTS set to docs/design/built, the pictures are kept there.

const test = base.extend<{ botbench: Botbench; refused: string[] }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-chat.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
  // Everything the browser refused or complained of while the test ran: a violation of the content security policy, a console error, a page error.
  refused: async ({ page }, use) => {
    const refused: string[] = [];
    await page.exposeFunction("botbenchRefused", (line: string) => void refused.push(line));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => void (window as unknown as { botbenchRefused(line: string): void }).botbenchRefused(`policy: ${event.violatedDirective} refused ${event.blockedURI}`));
    });
    page.on("console", (message) => {
      if (message.type() === "error" && message.location().url.endsWith("/api/session") && /status of 401/.test(message.text())) return;
      if (message.type() === "error" || /content security policy/i.test(message.text())) refused.push(`console ${message.type()}: ${message.text()} (${message.location().url})`);
    });
    page.on("pageerror", (error) => refused.push(`page error: ${error.message}`));
    await use(refused);
  },
});

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Web access set to Ask, as Settings saves it, so the chat's fetch waits for the owner. */
async function askForWeb(page: Page, botbench: Botbench): Promise<void> {
  const res = await page.request.put(`${botbench.base}/api/settings`, { data: { chatWebAccess: "ask" } });
  expect(res.status(), await res.text()).toBe(200);
}

const QUESTION = "Fetch https://example.com and tell me its title.";

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("New chat or task says what Send will start for each intent; a chat's fetch stands where it was asked with its decision in the pane at the right, as elevated risk, and Allow continues it", async ({ page, botbench, refused }) => {
    test.setTimeout(120_000);
    await signIn(page, botbench);
    await askForWeb(page, botbench);

    // The four intents, in the product's words, and the one sentence under the composer.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("What do you want to do?");
    await expect(page.getByTestId("intents").getByRole("radio")).toHaveCount(4);
    await expect(page.getByRole("radio", { name: "Ask a question" })).toBeChecked();
    const about = page.getByTestId("composer-about");
    await expect(about).toContainText("Send asks Claude Code.");
    await expect(page.getByTestId("composer-chips").getByRole("button")).toHaveAccessibleName(/^Agent and model: /);
    await expect(page.getByTestId("composer-keys")).toHaveText("Enter sends. Shift with Enter starts a new line.");
    expect(await primaries(page)).toEqual(["Send"]);
    await checkScreen(page, "new chat or task", { floor: 40, within: SCREEN_ONLY });
    await shot(page, "new-chat-1440-dark");

    // A task needs a repository: the chip asks for one, the sentence says nothing starts, and Send says why.
    await page.getByTestId("intent-task").click();
    await expect(page.getByRole("radio", { name: "Start one task" })).toBeChecked();
    await expect(about).toContainText("Send starts nothing yet.");
    await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe the task");
    await expect(page.getByTestId("repository-chip")).toHaveAccessibleName("Choose a repository");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByTestId("intent-run").click();
    await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe what to plan");
    // The chip opens the Add context sheet on its setting: a dialog at this width.
    await page.getByTestId("repository-chip").click();
    const sheet = page.getByTestId("context-sheet");
    await expect(sheet.getByRole("heading", { name: "Repository" })).toBeVisible();
    await checkScreen(page, "add context, repository, as a dialog", { floor: 40, within: SCREEN_ONLY });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.getByTestId("intent-question").click();
    await expect(about).toContainText("Send asks Claude Code.");

    // Light, as Settings → Appearance sets it.
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
    await page.reload();
    await expect(about).toBeVisible();
    await shot(page, "new-chat-1440-light");
    await page.evaluate(() => window.localStorage.removeItem("botbench.appearance"));
    await page.reload();

    // Enter sends, and the chat takes the screen.
    await messageBox(page).fill(QUESTION);
    await messageBox(page).press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(QUESTION);
    const log = page.getByRole("log", { name: "Transcript" });
    const asked = log.getByTestId("approval-asked");
    await expect(asked).toBeVisible({ timeout: 30_000 });
    await expect(asked).toContainText("Claude Code asks to use WebFetch");
    await expect(asked).toContainText("It is paused until you allow or decline.");

    // The decision, in the pane at the right: elevated risk, the consequence before the buttons, Decline then Allow.
    const pane = page.getByRole("complementary", { name: "This chat" });
    const card = pane.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-level", "risk");
    await expect(card.getByTestId("decision-signal")).toHaveText("Leaves this Mac");
    await expect(card.getByTestId("approval-line")).toHaveText("Wants to fetch https://example.com");
    await expect(card.getByTestId("decision-consequence")).toContainText("Botbench cannot take it back.");
    await expect(card.getByTestId("decision-actions").getByRole("button")).toHaveText(["Decline", "Allow"]);
    await expect(card.getByTestId("decision-queue")).toHaveCount(0);
    await expect(pane.getByTestId("chat-facts")).toContainText("Claude Code");
    await expect(card).toHaveAttribute("data-settled", "");
    await checkScreen(page, "chat, a request waits", { floor: 40, within: SCREEN_ONLY });
    await shot(page, "chat-approval-1440-dark");
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
    await page.reload();
    await expect(page.getByTestId("approval-card")).toHaveAttribute("data-settled", "");
    await shot(page, "chat-approval-1440-light");
    await page.evaluate(() => window.localStorage.removeItem("botbench.appearance"));
    await page.reload();

    // No single key answers: A and Enter on the page allow nothing.
    await expect(page.getByTestId("approval-card")).toHaveAttribute("data-settled", "");
    await page.locator("body").press("a");
    await page.locator("body").press("Enter");
    await expect(page.getByTestId("approval-card")).toBeVisible();
    await page.getByTestId("approval-card").getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("approval-card")).toHaveCount(0);
    await expect(log.locator('[data-event="text"]').last()).toContainText("Example Domain", { timeout: 30_000 });
    await expect(page.getByTestId("approval-asked")).toHaveCount(0);
    await shot(page, "chat-1440-dark");

    // New chat or task, from the navigation: no chat on the screen, and the intents again.
    await page.getByRole("link", { name: "New chat or task" }).click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("What do you want to do?");
    // Sent from there, the chat is at Chat's own address, so a reload shows it. (The replay's second turn is the declined one.)
    await sendChat(page, QUESTION);
    await expect(page).toHaveURL(/#\/turn$/);
    await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 30_000 });
    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
  });
});

test("on a phone the intents, the composer and the sentence fit one column; the decision stands above the message box, the note opens by touch, and Decline sends it", async ({ page, botbench, refused }) => {
  test.setTimeout(120_000);
  await signIn(page, botbench);
  await askForWeb(page, botbench);
  await expect(page.getByTestId("intents").getByRole("radio")).toHaveCount(4);
  await checkScreen(page, "new chat or task, phone", { floor: 40, within: SCREEN_ONLY });
  await shot(page, "new-chat-390-dark");
  // Add context is a sheet from the bottom here.
  await page.getByRole("button", { name: "Add context" }).tap();
  const sheet = page.getByTestId("context-sheet");
  await expect(sheet.getByRole("heading", { name: "Add context" })).toBeVisible();
  await expect(sheet).toHaveAttribute("data-side", "bottom");
  await checkScreen(page, "add context, phone", { floor: 40, within: SCREEN_ONLY });
  await sheet.getByRole("button", { name: "Close Add context" }).tap();

  // The replay's first chat turn is the one that was allowed; the second the one that was declined.
  await sendChat(page, QUESTION);
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-settled", "", { timeout: 30_000 });
  await page.getByTestId("approval-card").getByRole("button", { name: "Allow", exact: true }).tap();
  await expect(page.getByRole("log", { name: "Transcript" }).locator('[data-event="text"]').last()).toContainText("Example Domain", { timeout: 30_000 });
  await sendChat(page, QUESTION);
  const card = page.getByTestId("approval-card");
  await expect(card).toHaveAttribute("data-settled", "", { timeout: 30_000 });
  await expect(page.getByRole("complementary", { name: "This chat" })).toHaveCount(0);
  // The decision is above the message box, on the screen without scrolling.
  await expect(card).toBeInViewport();
  const order = await page.evaluate(() => document.querySelector('[data-testid="approval-card"]')!.getBoundingClientRect().bottom <= document.querySelector('[data-testid="composer"]')!.getBoundingClientRect().top);
  expect(order, "the decision stands above the message box").toBe(true);
  // Make this a run closes the transcript, under a line of its own at its right end: it is not the head of the card under it.
  const makeRun = await page.evaluate(() => {
    const [row, card] = [document.querySelector('[data-testid="make-run-chat"]')!, document.querySelector('[data-testid="approval-card"]')!.getBoundingClientRect()];
    const button = row.querySelector("button")!.getBoundingClientRect();
    return { ruled: parseFloat(getComputedStyle(row).borderTopWidth) >= 1, atTheRight: button.right >= row.getBoundingClientRect().right - 1, apart: card.top - button.bottom >= 16 || button.bottom <= 0 };
  });
  expect(makeRun, "Make this a run is the transcript's last line, apart from the approval card").toEqual({ ruled: true, atTheRight: true, apart: true });
  await checkScreen(page, "chat, a request waits, phone", { floor: 40, within: SCREEN_ONLY });
  await shot(page, "chat-approval-390-dark");
  const note = card.getByRole("button", { name: "Add a note for Claude Code" });
  await expect(note).toHaveAttribute("aria-expanded", "false");
  await note.tap();
  await expect(note).toHaveAttribute("aria-expanded", "true");
  await card.getByLabel("What Claude Code should do instead").fill("Do not fetch it. Answer from what you already know.");
  await card.getByRole("button", { name: "Decline", exact: true }).tap();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("log", { name: "Transcript" }).locator('[data-event="tool_call"]').filter({ hasText: "example.com" }).last().locator(".ds-tool-call__note")).toHaveText("You denied this.", { timeout: 30_000 });
  // This chat, behind its button on a phone.
  await page.getByRole("button", { name: "This chat" }).tap();
  await expect(page.getByTestId("chat-facts-sheet").getByTestId("chat-facts")).toContainText("Claude Code");
  expect(refused).toEqual([]);
});

// Several agents' answers compared. No model turn: before Botbench starts, one message is asked of Codex, Grok and
// Antigravity through the chat itself (src/api/chat.ts), each replaying a session captured from its real CLI; the
// Botbench process then started has a Codex that replays the real Codex's comparison (e2e/serve-replayed-compare.ts).
const ASKED = "Name one more primary colour, in one word, and say in one short sentence why it is primary.";
const compared = base.extend<{ seeded: { home: string; dir: string; conversation: number[] }; botbench: Botbench }>({
  seeded: async ({}, use) => {
    const dir = tempDir("botbench-e2e-compare-");
    const home = path.join(dir, "home");
    const db = openStore(home);
    const claude = new ClaudeCodeDriver();
    const broker = createBroker({ db, home, onChange: () => {} });
    await broker.listen();
    const turns = createTurns({ db, home, driver: claude, broker, onEvent: () => {} });
    const chat = createChat({ db, home, turns, claude, agents: { codex: chatReplayDriver("codex"), grok: chatReplayDriver("grok"), antigravity: chatReplayDriver("antigravity") }, onEvent: () => {} });
    const asked = await chat.send({ message: ASKED, conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }, { agent: "grok", model: "grok-4.7-build-fast" }, { agent: "antigravity", model: "gemini-3.8-flash-low" }] });
    while (asked.some((reply) => chat.turnRunning(reply.attemptId))) await new Promise((resolve) => setTimeout(resolve, 20));
    await chat.close();
    await turns.close();
    await broker.close();
    db.close();
    await use({ home, dir, conversation: asked.map((reply) => reply.attemptId) });
    fs.rmSync(dir, { recursive: true, force: true });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, entry: path.resolve(import.meta.dirname, "serve-replayed-compare.ts") });
    await use(botbench);
    await botbench.stop();
  },
});

const openCompared = async (page: Page, botbench: Botbench, conversation: number[]): Promise<void> => {
  await signIn(page, botbench);
  await page.evaluate((ids) => window.localStorage.setItem("botbench.conversation", JSON.stringify(ids)), conversation);
  await page.reload();
  await expect(page.getByTestId("compare-card").first()).toBeVisible();
};

compared.describe("at 1440×900, with a mouse", () => {
  compared.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  compared("three agents' answers stand side by side as equal cards, each with its agent, model and how it ended; Ask Codex sends the comparison, which then reads as one reply", async ({ page, botbench, seeded }) => {
    compared.setTimeout(120_000);
    await openCompared(page, botbench, seeded.conversation);
    const cards = page.getByTestId("compare-card");
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-agent")))).toEqual(["codex", "grok", "antigravity"]);
    await expect(cards.locator("h3")).toHaveText(["Codex", "Grok", "Antigravity"]);
    await expect(cards.getByTestId("compare-model")).toHaveText(["gpt-6-luna", "grok-4.7-build-fast", "gemini-3.8-flash-low"]);
    for (const card of await cards.all()) {
      await expect(card.getByTestId("compare-answer")).not.toBeEmpty();
      await expect(card.getByTestId("compare-ended")).toHaveText(/^Answered( in .+)?\.$/);
    }
    // Equal cards, in one row.
    const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((box) => ({ top: Math.round(box.top), width: Math.round(box.width) })));
    expect(new Set(boxes.map((box) => box.top)).size, "one row").toBe(1);
    expect(Math.max(...boxes.map((box) => box.width)) - Math.min(...boxes.map((box) => box.width)), "equal widths").toBeLessThanOrEqual(1);
    await expect(page.getByTestId("compare-count")).toHaveText("3 of 3 answered.");
    await expect(page.getByTestId("compare")).toContainText("Each agent answered alone and has not read the others' answers to this message; they are not working together.");
    // The question stands once, above them; the answers are not said again in the transcript.
    const log = page.getByRole("log", { name: "Transcript" });
    await expect(log.locator('[data-event="user_prompt"]')).toHaveText([new RegExp(ASKED.slice(0, 30))]);
    await expect(log.locator('[data-event="text"]')).toHaveCount(0);
    // The one action, with a button for each agent that can answer. No summary of where they agree is drawn.
    const action = page.getByTestId("compare-action");
    await expect(action.getByRole("heading")).toHaveText("Ask one to compare the answers");
    await expect(action.getByRole("button", { name: "Ask Codex" })).toBeEnabled();
    await checkScreen(page, "chat, three answers side by side", { floor: 40, within: SCREEN_ONLY });
    await shot(page, "compare-1440-dark");
    await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
    await page.reload();
    await expect(cards).toHaveCount(3);
    await shot(page, "compare-1440-light");
    await page.evaluate(() => window.localStorage.removeItem("botbench.appearance"));
    await page.reload();

    await page.getByTestId("compare-action").getByRole("button", { name: "Ask Codex" }).click();
    // The comparison is a round of its own: the chat reads in order again, each reply named, the comparison last.
    await expect(log.locator('[data-event="user_prompt"]').last()).toHaveText(/Codex, compare the answers above: where they agree, where they differ, and which you would act on\./, { timeout: 30_000 });
    await expect(log.locator('[data-event="text"]').last()).toContainText("All three name", { timeout: 30_000 });
    await expect(page.getByTestId("compare-card")).toHaveCount(0);
    await expect(page.getByTestId("compare-action")).toHaveCount(0);
  });
});

compared("on a phone the answers are read one at a time behind a switch that names each agent", async ({ page, botbench, seeded }) => {
  await openCompared(page, botbench, seeded.conversation);
  const tabs = page.getByTestId("compare-switch").getByRole("tab");
  await expect(tabs).toHaveText(["Codex", "Grok", "Antigravity"]);
  await expect(page.getByTestId("compare-card")).toHaveCount(1);
  await expect(page.getByTestId("compare-card")).toHaveAttribute("data-agent", "codex");
  await tabs.nth(1).tap();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("compare-card")).toHaveAttribute("data-agent", "grok");
  await expect(page.getByTestId("compare-card").getByTestId("compare-model")).toHaveText("grok-4.7-build-fast");
  await expect(page.getByTestId("compare-action").getByRole("button", { name: "Ask Grok" })).toBeVisible();
  await checkScreen(page, "chat, three answers, one at a time", { floor: 40, within: SCREEN_ONLY });
  await page.getByTestId("compare-card").scrollIntoViewIfNeeded();
  await shot(page, "compare-390-dark");
});
