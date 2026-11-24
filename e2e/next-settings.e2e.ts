import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { appendLog } from "../src/approvals/broker.ts";
import { insertStanding, realRepo } from "../src/approvals/grants.ts";
import type { DriverEvent } from "../src/drivers/events.ts";
import { captureNote } from "../src/engine/memory.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { initRepo } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { checkScreen, expect, watchRefused } from "./helpers.ts";
import { choice, choose, GROUPS, openGroup, shot, signInTo, type Group } from "./settings-helpers.ts";

// Settings rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), in its six groups, in the real client against a real
// Botbench process, which serves it with its real content security policy. No model turn: before Botbench starts, its
// real store is given a task, two commands that are always allowed with their log rows as the broker writes them, two
// notes in memory as a chat stores them, and one reply's usage from a recorded Claude Code session; its settings file
// names a real temporary repository with setup and check commands. The agents shown are this machine's own, as their
// real checks report them.

interface Seeded {
  home: string;
  repo: string;
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench; refused: string[] }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-settings-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "billing-api");
    initRepo(repo, { "README.md": "# Billing\n" });
    const db = openStore(home);
    const task = createTask(db, { repo, prompt: "Paginate the export endpoint" });
    for (const words of [["npm", "test"], ["npm", "run", "lint"]]) {
      const grantId = insertStanding(db, { role: "implementer", repo: realRepo(repo), cwd: ".", words, taskId: task.id });
      appendLog(db, { taskId: task.id, runId: task.runId, attemptId: null, grantId, rule: "standing_granted", tool: "Bash", command: words.join(" "), cwd: "." });
    }
    captureNote(db, home, "the billing tests need the fake clock, never real time");
    captureNote(db, home, "pull request titles start with the issue number");
    // One reply's usage, from a recorded Claude Code session, for the task above.
    const recording = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "test", "recordings", "planner-plans.json"), "utf8")) as { turns: { events: DriverEvent[] }[] };
    const usage = recording.turns.flatMap((turn) => turn.events).find((event) => event.type === "usage")!;
    const at = new Date().toISOString();
    const attempt = Number(db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES ('claude-code', 'claude-haiku-5-5', 'ended', ?, ?)").run(at, at).lastInsertRowid);
    moveTask(db, task.id, "building", { attemptId: attempt });
    moveTask(db, task.id, "failed", { reason: "Stopped for this test." });
    db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attempt, at, usage.type, JSON.stringify(usage));
    db.close();
    await use({ home, repo: fs.realpathSync(repo) });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, settings: { drivers: { "claude-code": { model: "haiku" } }, workbench: undefined, repositories: { [seeded.repo]: { setup: ["npm ci"], checks: ["npm run typecheck", "npm test"], preapproved: ["npm test"] } } } });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
  refused: async ({ page }, use) => {
    await use(await watchRefused(page));
  },
});

const settings = (page: Page) => page.getByTestId("settings");
const settingsNav = (page: Page) => page.getByTestId("settings-nav");

/** Pictures of the group in view, for docs/design/built: dark, then light, then dark again. */
async function shots(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  await shot(page, `${name}-1440-dark`);
  if (!process.env.BOTBENCH_SHOTS) return;
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
  await page.reload();
  await ready();
  await shot(page, `${name}-1440-light`);
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
  await page.reload();
  await ready();
}

test.describe("at 1440×900, with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false });

  test("Settings is six groups beside its navigation, each showing what the server holds; a choice is saved as it is made; the old addresses open the new groups", async ({ page, botbench, seeded, refused }) => {
    await signInTo(page, botbench, "#/settings");
    // With no group named, Agents and models is open, and the navigation says so.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agents and models");
    await expect(page).toHaveTitle("Agents and models – Botbench");
    await expect(settingsNav(page).getByRole("listitem")).toHaveText(Object.values(GROUPS));
    await expect(settingsNav(page).locator("[aria-current=page]")).toHaveText("Agents and models");
    await expect(settingsNav(page).getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "#/");

    // Agents and models: each agent as its own check reports it, its state as a word, and one action at most.
    const listed = ((await (await page.request.get(`${botbench.base}/api/agents`)).json()) as { agents: { agent: string; problem: string | null }[] }).agents;
    for (const found of listed) await expect(page.getByTestId(`agent-${found.agent}`).getByTestId("agent-state")).toHaveText(/^(Available|Signed out|Not installed|Unsupported version|Unavailable)$/, { timeout: 30_000 });
    await expect(page.getByTestId("agents-summary")).toHaveText(`${listed.filter((a) => a.problem === null).length} of ${listed.length} agents can take work now.`);
    for (const found of listed) expect(await page.getByTestId(`agent-${found.agent}`).getByRole("button").count(), `${found.agent} has one action at most`).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("fallback-list")).toBeEnabled();
    await checkScreen(page, "settings, agents and models");
    await shots(page, "settings-agents", async () => void (await expect(page.getByTestId("agent-claude-code").getByTestId("agent-state")).not.toHaveText("Checking", { timeout: 30_000 })));

    // Execution environments: the repository of the settings file, where its commands run, and its setup and checks.
    await settingsNav(page).getByRole("link", { name: "Execution environments" }).click();
    await expect(page).toHaveURL(/#\/settings\/environments$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const environment = page.getByTestId("execution");
    await expect(environment).toHaveCount(1);
    await expect(environment.getByRole("heading")).toHaveText("billing-api");
    await expect(environment).toContainText(seeded.repo);
    await expect(environment.getByTestId("execution-kind")).toHaveText("On this Mac");
    await expect(environment.getByTestId("execution-setup").locator("code")).toHaveText(["npm ci"]);
    await expect(environment.getByTestId("execution-checks").locator("code")).toHaveText(["npm run typecheck", "npm test"]);
    await expect(page.getByTestId("watch-settings")).toContainText("No repository is watched.");
    await checkScreen(page, "settings, execution environments");
    await shots(page, "settings-environments", () => expect(page.getByTestId("execution")).toBeVisible());

    // Workbench identity: the name is saved with Save name, and says Saved.
    await settingsNav(page).getByRole("link", { name: "Workbench identity" }).click();
    const name = page.getByLabel("Workbench name");
    await expect(name).not.toHaveValue("");
    await name.fill("studio-mac");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByTestId("workbench-saved")).toHaveText("Saved.");
    expect(((await (await page.request.get(`${botbench.base}/api/settings`)).json()) as { workbench: { name: string } }).workbench.name).toBe("studio-mac");
    await expect(page.getByTestId("version")).toHaveText(/^Botbench \d+\.\d+\.\d+/);
    await expect(page.getByTestId("memory-notes").getByRole("listitem")).toHaveCount(2);
    await expect(page.getByLabel("Appearance", { exact: true })).toHaveValue("dark");
    await checkScreen(page, "settings, workbench identity");
    await shots(page, "settings-identity", () => expect(page.getByTestId("memory-notes")).toBeVisible());

    // Permissions and autonomy: the three modes as cards with their one line; web access is saved as it is chosen.
    await settingsNav(page).getByRole("link", { name: "Permissions and autonomy" }).click();
    const modes = page.getByTestId("default-mode-picker");
    await expect(modes.getByRole("radio")).toHaveCount(3);
    await expect(modes.getByRole("radio", { name: "Manual" })).toBeChecked();
    await expect(modes.getByRole("radio", { name: "Manual" })).toHaveAccessibleDescription("You approve the plan and decide on each result.");
    await expect(choice(page, "Web access")).toHaveAttribute("data-value", "allow");
    await choose(page, "Web access", "Ask");
    await expect(page.getByTestId("web-access-saved")).toHaveText("Saved.");
    expect(((await (await page.request.get(`${botbench.base}/api/settings`)).json()) as { chatWebAccess: string }).chatWebAccess).toBe("ask");
    await expect(choice(page, "Ask before every command")).toHaveAttribute("data-value", "off");
    await expect(page.getByTestId("grant-list").getByTestId("grant-command")).toHaveText(["npm test", "npm run lint"]);
    // Activity is a table, newest first.
    await expect(page.getByTestId("action-log").getByRole("columnheader")).toHaveText(["What happened", "Command or action", "Task and time"]);
    await expect(page.getByTestId("activity-entry")).toHaveText([/^Memory.*remember note-2/s, /^Memory.*remember note-1/s, /You chose Always allow.*npm run lint.*Task 1/s, /You chose Always allow.*npm test.*Task 1/s]);
    // The longer explanation is behind a button, closed until asked for.
    await expect(page.getByText("A run started from a GitHub issue always asks.")).toBeHidden();
    await page.getByRole("button", { name: "More about this: Web access" }).click();
    await expect(page.getByText("A run started from a GitHub issue always asks.")).toBeVisible();
    await page.getByRole("button", { name: "More about this: Web access" }).click();
    await checkScreen(page, "settings, permissions and autonomy");
    await shots(page, "settings-permissions", () => expect(page.getByTestId("grant-list")).toBeVisible());

    // Usage and limits: the stored reply, in numbers that carry their unit, and what happens at a usage limit.
    await settingsNav(page).getByRole("link", { name: "Usage and limits" }).click();
    await expect(page.getByTestId("usage-week")).toContainText("1 reply");
    await expect(page.getByTestId("usage-run")).toContainText("Paginate the export endpoint");
    const limit = page.getByTestId("usage-limit");
    await expect(limit.getByRole("heading", { level: 3 })).toHaveText(["Wait for it to reset", "Switch to the next agent"]);
    await expect(limit.getByTestId("usage-order")).toHaveText(/^The list now: /);
    await expect(limit.getByRole("link", { name: "Change the order" })).toHaveAttribute("href", "#/settings/agents");
    await expect(settings(page)).not.toContainText("$");
    await checkScreen(page, "settings, usage and limits");
    await shots(page, "settings-usage", () => expect(page.getByTestId("usage-week")).toBeVisible());

    // Connections and peers: pairing is off in this settings file, and says so; this device is listed.
    await settingsNav(page).getByRole("link", { name: "Connections and peers" }).click();
    await expect(page.getByTestId("pairing-off")).toContainText("Pairing is off");
    await expect(page.getByTestId("devices").getByTestId("device")).toHaveCount(1);
    await expect(page.getByTestId("devices").getByTestId("device")).toContainText("This device");
    await expect(page.getByTestId("devices").getByRole("button", { name: "Add a device" })).toBeVisible();
    await expect(page.getByTestId("notifications-state")).not.toHaveText("Checking");
    await checkScreen(page, "settings, connections and peers");
    await shots(page, "settings-connections", () => expect(page.getByTestId("device")).toBeVisible());

    // The addresses Settings had before its six groups open the group that now holds what they showed.
    for (const [old, group] of [["#/trust", "permissions"], ["#/usage", "usage"], ["#/settings/paired", "connections"], ["#/settings/devices", "connections"], ["#/settings/notifications", "connections"], ["#/settings/appearance", "identity"], ["#/settings/workbench", "identity"]] as const) {
      await page.goto(`${botbench.base}/${old}`);
      await expect(page, old).toHaveURL(new RegExp(`#/settings/${group}$`));
      await expect(page.getByRole("heading", { level: 1 }), old).toHaveText(GROUPS[group as Group]);
    }
    expect(refused, "nothing was refused by the content security policy, and the console holds no error").toEqual([]);
  });
});

for (const size of [{ width: 1440, height: 900, touch: false }, { width: 390, height: 844, touch: true }]) {
  test.describe(`sign-in at ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.touch ? 2 : 1, hasTouch: size.touch });

    test("Sign in takes the whole window with no navigation, its field has the focus on arrival, the page can be zoomed, and a code is the other way in", async ({ page, botbench, refused }) => {
      await page.goto(botbench.base);
      await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
      await expect(page).toHaveTitle("Sign in – Botbench");
      await expect(page.getByLabel("Login token")).toBeFocused();
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expect(page.getByRole("button")).toHaveText(["Sign in"]);
      // Pinch zoom stays allowed: the page's viewport sets no limit on scaling.
      expect(await page.locator('meta[name="viewport"]').getAttribute("content")).not.toMatch(/user-scalable|maximum-scale/);
      await checkScreen(page, "sign-in");
      await shot(page, `sign-in-${size.width}-dark`);
      if (!size.touch && process.env.BOTBENCH_SHOTS) {
        await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "light"));
        await page.reload();
        await expect(page.getByLabel("Login token")).toBeFocused();
        await shot(page, "sign-in-1440-light");
        await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
        await page.reload();
      }
      // The other way in: a one-time code, whose field takes the focus when it is chosen.
      await page.getByRole("radio", { name: "Code" }).check();
      await expect(page.getByRole("textbox", { name: "One-time code" })).toBeFocused();
      await expect(page.getByText("Settings → Connections and peers → Add a device")).toBeVisible();
      await page.getByRole("radio", { name: "Token" }).check();
      await page.getByLabel("Login token").fill(botbench.token);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
      expect((await page.request.get(`${botbench.base}/api/session`)).status()).toBe(200);
      expect(refused).toEqual([]);
    });
  });
}

test.describe("at 390×844, on a phone", () => {
  test("Settings is a list of its six groups under a summary; a group is a screen of its own with the way back; Take back asks first and removes the command", async ({ page, botbench, refused }) => {
    await signInTo(page, botbench, "#/settings");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
    await expect(page.getByTestId("settings-nav")).toHaveCount(0);
    const groups = page.getByTestId("settings-groups").getByRole("link");
    await expect(groups).toHaveCount(6);
    for (const [i, name] of Object.values(GROUPS).entries()) await expect(groups.nth(i)).toContainText(name);
    // Each row says what the server holds now.
    await expect(page.getByTestId("settings-summary").getByRole("heading")).toHaveText(/^\d of \d agents available$/, { timeout: 30_000 });
    await expect(groups.nth(1)).toContainText("Setup and checks for 1 repository");
    await expect(groups.nth(3)).toContainText("Manual by default · Web access: Allow");
    await checkScreen(page, "settings, the list of groups, phone");
    await shot(page, "settings-390-dark");

    await groups.nth(3).click();
    await expect(page).toHaveURL(/#\/settings\/permissions$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Permissions and autonomy");
    await expect(page.getByRole("navigation", { name: "Where this is" }).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings");
    await expect(page.getByTestId("grant-list").getByTestId("grant-command")).toHaveText(["npm test", "npm run lint"]);
    await checkScreen(page, "settings, permissions and autonomy, phone");
    await shot(page, "settings-permissions-390-dark");

    // Take back asks first, with the focus on the button that changes nothing; confirmed, the command leaves the list.
    await page.getByRole("button", { name: "Take back npm run lint" }).click();
    const sure = page.getByTestId("take-back-confirm");
    await expect(sure.getByRole("heading")).toHaveText("Stop always allowing this command?");
    await expect(sure.getByRole("button")).toHaveText(["Keep it", "Take it back"]);
    await expect(sure.getByRole("button", { name: "Keep it" })).toBeFocused();
    await checkScreen(page, "settings, the take back confirmation, phone");
    await sure.getByRole("button", { name: "Take it back" }).click();
    await expect(page.getByTestId("grant-list").getByTestId("grant-command")).toHaveText(["npm test"]);
    expect(((await (await page.request.get(`${botbench.base}/api/grants`)).json()) as { grants: unknown[] }).grants).toHaveLength(1);

    for (const group of ["agents", "environments", "identity", "usage", "connections"] as const) {
      await openGroup(page, botbench, group);
      if (group === "agents") await expect(page.getByTestId("agent-claude-code").getByTestId("agent-state")).not.toHaveText("Checking", { timeout: 30_000 });
      if (group === "usage") await expect(page.getByTestId("usage-week")).toBeVisible();
      if (group === "connections") await expect(page.getByTestId("device")).toBeVisible();
      if (group === "identity") await expect(page.getByTestId("memory-notes")).toBeVisible();
      if (group === "environments") await expect(page.getByTestId("execution")).toBeVisible();
      await checkScreen(page, `settings, ${group}, phone`);
      await shot(page, `settings-${group}-390-dark`);
    }
    // The way back to the list.
    await page.getByRole("navigation", { name: "Where this is" }).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-groups")).toBeVisible();
    expect(refused).toEqual([]);
  });
});
