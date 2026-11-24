import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { startBotbench, tempDir } from "./botbench.ts";
import { expect, SHOTS, test } from "./helpers.ts";
import { checkNext, openSettingsGroup } from "./settings-helpers.ts";

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
    await openSettingsGroup(page, "agents");
    const agent = page.getByTestId("agent-claude-code");
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out");
    await expect(agent.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
    await checkNext(page, "settings, Claude Code signed out, with Connect");
    await shot(page, "u26-settings-connect.png");

    await agent.getByRole("button", { name: "Connect Claude Code" }).click();
    const sheet = page.getByTestId("connect-sheet");
    await expect(sheet.getByRole("heading", { name: "Connect Claude Code" })).toBeVisible();
    await expect(sheet.getByTestId("connect-waiting")).toBeVisible({ timeout: 30_000 });
    const open = sheet.getByRole("link", { name: "Open sign-in page" });
    // The sheet's one filled button.
    expect(await open.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
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
    await checkNext(page, "connect sheet, waiting for the sign-in");
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

// Antigravity's sign-in is one Botbench keeps in its own profile (src/drivers/antigravity.ts): the real `agy acp
// --login`, for the new data folder's profile, under a sandbox that refuses the Keychain. Not completed here either.
test("Antigravity, not connected in a new data folder, shows Connect; the sheet shows Google's real sign-in link, says it is for Botbench alone, and takes the page's code or address; Cancel leaves nothing running", async ({ page }) => {
  const botbench = await startBotbench();
  const profile = path.join(fs.realpathSync(botbench.home), "antigravity");
  const running = (): string[] => {
    const out = execFileSync("ps", ["-ww", "-x", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter((line) => line.includes(`--gemini-dir ${profile}`));
  };
  try {
    await page.goto(botbench.base);
    await page.getByLabel("Login token").fill(botbench.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await openSettingsGroup(page, "agents");
    const agent = page.getByTestId("agent-antigravity");
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out", { timeout: 30_000 });
    await agent.getByRole("button", { name: "Connect Antigravity" }).click();
    const sheet = page.getByTestId("connect-sheet");
    await expect(sheet.getByTestId("connect-waiting")).toBeVisible({ timeout: 30_000 });
    const href = new URL((await sheet.getByRole("link", { name: "Open sign-in page" }).getAttribute("href"))!);
    expect(href.origin).toBe("https://accounts.google.com");
    expect(href.searchParams.get("redirect_uri")).toBe("https://antigravity.google/oauth-callback");
    await expect(sheet).toContainText("This is a sign-in for Botbench alone: Antigravity in a terminal or its app keeps its own.");
    await expect(sheet).toContainText("Copy it, or the page's whole address, and paste it here.");
    await expect(sheet.getByLabel("Code from the sign-in page")).toBeEditable();
    expect(running().length, "the real sign-in runs, for Botbench's profile").toBeGreaterThan(0);
    await checkNext(page, "connect sheet, Antigravity, waiting for the sign-in");
    await shot(page, "connect-antigravity-sheet.png");
    await sheet.getByRole("button", { name: "Cancel connecting" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(agent.getByTestId("agent-state")).toHaveText("Signed out");
    await expect.poll(running, { message: "no sign-in process is left", timeout: 5000 }).toEqual([]);
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  }
});
