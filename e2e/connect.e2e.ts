import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { startBotbench, tempDir } from "./botbench.ts";
import { checkDesign, expect, SHOTS, test } from "./helpers.ts";

// Connect from Settings with the real Claude Code, pointed at an empty configuration directory so it reports itself
// signed out and the owner's own sign-in is never touched. The sheet shows the link the real CLI printed. The sign-in
// is not completed (a test cannot sign in to a vendor): its success is proven in test/drivers/connect.test.ts.

/** Processes of this account whose environment names `dir`: Claude Code's sign-in and anything it started. macOS `ps -E`. */
function processesUsing(dir: string): string[] {
  const out = execFileSync("ps", ["-Eww", "-x", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((line) => line.includes(dir) && line.includes("auth login"));
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

test("a signed-out Claude Code shows Connect; the sheet shows the real sign-in link and a place for the page's code; Cancel leaves it signed out with nothing running", async ({ page }) => {
  const empty = tempDir("botbench-e2e-claude-config-");
  const botbench = await startBotbench({ env: { CLAUDE_CONFIG_DIR: empty } });
  try {
    await page.goto(botbench.base);
    await page.getByLabel("Login token").fill(botbench.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("driver-state")).toHaveText(/^Claude Code: /);
    await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    const agent = page.getByTestId("agent-claude-code");
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out");
    await expect(agent.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
    await checkDesign(page, "settings, Claude Code signed out, with Connect");
    await shot(page, "u26-settings-connect.png");

    await agent.getByRole("button", { name: "Connect Claude Code" }).click();
    const sheet = page.getByTestId("connect-sheet");
    await expect(sheet.getByRole("heading", { name: "Connect Claude Code" })).toBeVisible();
    await expect(sheet.getByTestId("connect-waiting")).toBeVisible({ timeout: 30_000 });
    const open = sheet.getByRole("link", { name: "Open sign-in page" });
    await expect(open).toHaveClass(/ds-button--primary/);
    await expect(open).toHaveAttribute("target", "_blank");
    const href = new URL((await open.getAttribute("href"))!);
    expect(href.origin).toBe("https://claude.com");
    expect(href.pathname).toBe("/cai/oauth/authorize");
    expect(href.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    await expect(sheet).toContainText("Open the sign-in page at claude.com");
    await expect(sheet.getByLabel("Code from the sign-in page")).toBeEditable();
    await expect(sheet.getByRole("button", { name: "Send code" })).toBeDisabled();
    await expect(sheet.getByRole("status").filter({ hasText: "Waiting for you to sign in" })).toBeVisible();
    expect(processesUsing(empty).length, "the real sign-in runs").toBeGreaterThan(0);
    await checkDesign(page, "connect sheet, waiting for the sign-in");
    await shot(page, "u26-connect-sheet.png");

    await sheet.getByRole("button", { name: "Cancel connecting" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out");
    await expect(agent.getByRole("button", { name: "Connect Claude Code" })).toBeVisible();
    await expect.poll(() => processesUsing(empty), { message: "no sign-in process is left", timeout: 5000 }).toEqual([]);
  } finally {
    const { leftover } = await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
    expect(leftover).toEqual([]);
  }
});
