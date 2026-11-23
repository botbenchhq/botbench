import fs from "node:fs";
import path from "node:path";
import { createChat } from "../src/api/chat.ts";
import { createBroker } from "../src/approvals/broker.ts";
import { createTurns } from "../src/api/turns.ts";
import { ClaudeCodeDriver } from "../src/drivers/claude-code.ts";
import { openStore } from "../src/store/db.ts";
import { chatReplayDriver } from "../test/support/replay-chat.ts";
import { checkDesign, expect, messageBox, nav, tempShot, test } from "./helpers.ts";
import { startBotbench } from "./botbench.ts";

// The first run of an installation, in the real client at a phone's size. No model turn. A fresh data folder, on a
// real machine state where Claude Code cannot be used: no `claude` in any PATH folder, so the home screen shows its two
// first-run lines, the agent's line links to Settings → Agents, and Send says why it cannot send, with one link. Then
// one chat is stored by the chat itself, Codex replaying a session captured from its real CLI (test/support/replay-chat.ts,
// the owner's approved exception), and the lines are gone, after a reload and after a restart.

test("a fresh installation's home screen shows the first-run lines, reaches Settings → Agents from them, and drops them for good once a chat is stored", async ({ page }) => {
  const withoutClaude = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "" && !fs.existsSync(path.join(dir, "claude"))).join(path.delimiter);
  const botbench = await startBotbench({ env: { PATH: withoutClaude } });
  try {
    await page.goto(botbench.base);
    await page.getByLabel("Login token").fill(botbench.token);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Two plain lines above the box, under the header's one line on what is wrong with the agent: three at most, and
    // nothing over the screen.
    const lines = page.getByTestId("first-run");
    await expect(lines.locator("p")).toHaveText(["Tap + to choose a repository, or just ask a question.", "Connect an agent in Settings → Agents."]);
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: not installed");
    await expect(page.locator("dialog[open], [role=dialog]:visible, [aria-modal=true]")).toHaveCount(0);
    const above = await page.locator("main").evaluate((main) => {
      const box = main.querySelector("form.ds-composer")!.getBoundingClientRect().top;
      return [...main.querySelectorAll("p")].filter((p) => p.getClientRects().length > 0 && p.getBoundingClientRect().bottom <= box).length;
    });
    expect(above, "lines above the message box").toBeLessThanOrEqual(3);

    // Send is disabled, and its reason names the problem and carries exactly one link, to connect an agent.
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    const reason = page.getByTestId("driver-problem");
    await expect(reason).toContainText("Claude Code is not installed");
    await expect(reason).toContainText("Nothing can be sent until this is fixed. Connect an agent in Settings → Agents.");
    await expect(reason.getByRole("link")).toHaveCount(1);
    await expect(reason.getByRole("link", { name: "Settings → Agents" })).toHaveAttribute("href", "#/settings/agents");
    await checkDesign(page, "chat, first run, Claude Code not installed");
    await tempShot(page, "first-run-home");

    // The agent's line leads to Settings, opened at its Agents section.
    await lines.getByRole("link", { name: "Settings → Agents" }).click();
    await expect(page).toHaveURL(/#\/settings\/agents$/);
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeAttached();
    const agents = page.getByRole("heading", { name: "Agents", level: 2 });
    await expect(agents).toBeInViewport();
    await expect(agents).toBeFocused();
    await expect(page.getByTestId("agent-claude-code").getByTestId("agent-state")).toHaveText("Not installed");
    await checkDesign(page, "settings, at Agents");

    // One chat stored, by the chat itself, while Botbench runs.
    const db = openStore(botbench.home);
    const claude = new ClaudeCodeDriver();
    const turns = createTurns({ db, home: botbench.home, driver: claude, broker: createBroker({ db, home: botbench.home, onChange: () => {} }), onEvent: () => {} });
    const chat = createChat({ db, home: botbench.home, turns, claude, agents: { codex: chatReplayDriver("codex") }, onEvent: () => {} });
    const [reply] = await chat.send({ message: "Name one primary colour.", conversation: [], agents: [{ agent: "codex", model: "gpt-6-luna" }] });
    await expect.poll(() => chat.turnRunning(reply!.attemptId)).toBe(false);
    await chat.close();
    await turns.close();
    db.close();

    // Back on Chat, with nothing in its transcript on this device, the lines are gone; the header still says what is wrong.
    // Each time, the screen's own question is waited for, so "gone" is not read before the answer came.
    const goneAfter = async (step: () => Promise<unknown>): Promise<void> => {
      const read = page.waitForResponse((r) => r.url().endsWith("/api/first-run"));
      await step();
      expect(await (await read).json()).toEqual({ firstRun: false });
      await expect(messageBox(page)).toBeVisible();
      await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: not installed");
      await expect(lines).toHaveCount(0);
    };
    await goneAfter(() => nav(page).getByRole("link", { name: "Chat", exact: true }).click());
    await checkDesign(page, "chat, after the first run");
    await goneAfter(() => page.reload());

    // And after a restart on the same data folder.
    await botbench.restart();
    await goneAfter(() => page.reload());
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  }
});
