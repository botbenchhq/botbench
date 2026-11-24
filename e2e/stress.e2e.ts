import fs from "node:fs";
import path from "node:path";
import { test as base, type Browser, type Page } from "@playwright/test";
import { appendLog } from "../src/approvals/broker.ts";
import { insertStanding, realRepo } from "../src/approvals/grants.ts";
import { captureNote } from "../src/engine/memory.ts";
import { createRun, storePlan } from "../src/engine/run.ts";
import { createTask, moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { git, initRepo, write } from "../test/support/repo.ts";
import { pairThem, sharedRepository, until, workbench, type Workbench } from "../test/support/two-workbenches.ts";
import { LOGIN_TOKEN_FILE } from "../src/api/auth.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { fit, picture, WIDTHS, type Fit } from "./fit.ts";
import { checkScreen, expect } from "./helpers.ts";
import { GROUPS, signInTo } from "./settings-helpers.ts";

// The shell, Settings, the paired-workbench conversation and the not-found screen with content that strains them: a
// workbench name as long as one may be, a task whose title runs to 170 characters with a word that cannot break, twelve
// repositories at long paths with long commands, thirty commands that are always allowed, long notes, a long message
// from a paired workbench with a long name, and 1, 9, 37 and 120 things waiting on Home's mark. Looked at from a
// phone's width to 1440px, either side of each width the shell changes at, with a finger and with a mouse, dark and
// light. No model turn: everything is put in Botbench's real store through the engine itself before it starts, and the
// two paired workbenches are two real processes that pair and send through their owners' routes.

const NAME = "jons-macbook-pro-16-inch-works";
const UNBROKEN = "internationalisation_of_the_billing_export_endpoint_with_cursor_based_pagination_and_retries";
const TITLE = `Refactor the ${UNBROKEN} module so that every invoice line is rounded once, in the currency of the customer, and never twice on the way out`;
const LONG_COMMAND = ["npm", "run", "test:integration", "--", "--reporter=verbose", `--testNamePattern=${UNBROKEN}`, "--config=packages/billing-export/vitest.integration.config.ts"];

interface Seeded {
  home: string;
  repos: string[];
  taskId: number;
}

/** `count` more plans that wait for the owner's approval, each one more thing on Home's mark. */
function plans(home: string, repo: string, count: number, from: number): void {
  const db = openStore(home);
  for (let i = 0; i < count; i++) {
    const run = createRun(db, { repo, prompt: `Plan ${from + i}: move the ${UNBROKEN} to the new provider, one service at a time, without a day of double billing`, baseCommit: git(repo, "rev-parse", "HEAD").trim() });
    storePlan(db, run.id, [{ title: "Step 1", criteria: ["Step 1 is done"] }]);
  }
  db.close();
}

const test = base.extend<{ dir: string; seeded: Seeded; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-stress-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repos = Array.from({ length: 12 }, (_, i) => path.join(dir, "a-monorepo-with-a-very-long-folder-name-for-the-payments-platform", "services-and-packages", `billing-export-api-gateway-and-reconciliation-worker-${i + 1}`));
    for (const repo of repos) {
      fs.mkdirSync(path.dirname(repo), { recursive: true });
      initRepo(repo, { "README.md": "# Billing\n" });
    }
    const repo = repos[0]!;
    const db = openStore(home);
    // One task that is ready for review, with the long title: the one thing that needs the owner at first.
    const task = createTask(db, { repo, prompt: TITLE });
    const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
    moveTask(db, task.id, "building", { worktree });
    write(worktree.path, "src/rounding.ts", "export const places = 2;\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "none" });
    for (let i = 0; i < 30; i++) {
      const words = [...LONG_COMMAND, `--shard=${i + 1}/30`];
      const grantId = insertStanding(db, { role: "implementer", repo: realRepo(repo), cwd: "packages/billing-export/src/reconciliation/workers", words, taskId: task.id });
      appendLog(db, { taskId: task.id, runId: task.runId, attemptId: null, grantId, rule: "standing_granted", tool: "Bash", command: words.join(" "), cwd: "packages/billing-export/src/reconciliation/workers" });
    }
    for (let i = 0; i < 6; i++) captureNote(db, home, `Note ${i + 1}: the billing tests need the fake clock, never real time, and the ${UNBROKEN} fixture must be loaded before any test that reads an invoice. `.repeat(4).trim());
    db.close();
    await use({ home, repos: repos.map((r) => fs.realpathSync(r)), taskId: task.id });
  },
  botbench: async ({ seeded }, use) => {
    const repositories = Object.fromEntries(
      seeded.repos.map((repo, i) => [repo, { setup: ["npm ci --prefer-offline --no-audit --no-fund --ignore-scripts --registry=https://registry.npmjs.org/", `node scripts/prepare-the-${UNBROKEN}-fixtures.mjs --shard=${i + 1}`], checks: ["npm run typecheck --workspaces --if-present", LONG_COMMAND.join(" ")], preapproved: i === 0 ? Array.from({ length: 20 }, (_, n) => `${LONG_COMMAND.join(" ")} --shard=${n + 1}/20`) : ["npm test"] }]),
    );
    const botbench = await startBotbench({ home: seeded.home, settings: { drivers: { "claude-code": { model: "haiku" } }, workbench: NAME, repositories } });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
});

/** A signed-in page of its own kind: under a finger, or with a mouse. */
async function device(browser: Browser, at: { base: string; token: string }, touch: boolean): Promise<Page> {
  const page = await (await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: touch })).newPage();
  await signInTo(page, at, "#/settings");
  return page;
}

async function appearance(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.evaluate((to) => window.localStorage.setItem("botbench.appearance", to), mode);
  await page.reload();
}

/** What `found` holds against the screen, as lines; none when it fits. */
const lines = (where: string, found: Fit): string[] => [...(found.sideways === 0 ? [] : [`${where}: scrolls sideways by ${found.sideways}px`]), ...[...found.past, ...found.clipped, ...found.overlapping, ...found.faint].map((line) => `${where}: ${line}`)];

/** The screens this file holds to account, by address, each with what it shows once it has read its data. */
function screens(page: Page, seeded: Seeded): { name: string; at: string; ready: () => Promise<unknown>; mine: boolean }[] {
  const group = (key: keyof typeof GROUPS, ready: () => Promise<unknown>) => ({ name: `settings-${key}`, at: `#/settings/${key}`, ready: async () => (await expect(page.getByRole("heading", { level: 1, name: GROUPS[key] })).toBeVisible(), await ready()), mine: true });
  return [
    // Under 1024px, the list of the six groups under the summary; from 1024px, the first group.
    { name: "settings", at: "#/settings", ready: () => expect(page.getByTestId("settings-groups").or(page.getByTestId("settings-nav"))).toBeVisible(), mine: true },
    group("agents", () => expect(page.getByTestId("agent-claude-code").getByTestId("agent-state")).not.toHaveText("Checking", { timeout: 30_000 })),
    group("environments", () => expect(page.getByTestId("execution")).toHaveCount(12)),
    group("identity", () => expect(page.getByTestId("memory-notes").getByRole("listitem")).toHaveCount(6)),
    group("permissions", () => expect(page.getByTestId("grant-list").getByTestId("grant-command")).toHaveCount(30)),
    group("usage", () => expect(page.getByTestId("usage-limit")).toBeVisible()),
    group("connections", () => expect(page.getByTestId("device").first()).toBeVisible()),
    { name: "not-found", at: `#/${UNBROKEN}/${UNBROKEN}`, ready: () => expect(page.getByTestId("not-found")).toBeVisible(), mine: true },
    // Another screen's own content is not this file's to judge: only the shell around it is measured there.
    { name: "task", at: `#/tasks/${seeded.taskId}`, ready: () => expect(page.getByRole("heading", { level: 1 })).toContainText("Refactor the"), mine: false },
    { name: "home", at: "#/", ready: () => expect(page.getByTestId("headline")).toBeVisible(), mine: false },
    { name: "work", at: "#/work", ready: () => expect(page.getByTestId("work-shown")).toBeVisible(), mine: false },
  ];
}

const EXPLORE = process.env.BOTBENCH_EXPLORE === "1";

test("with long and many things, the shell, Settings and the not-found screen keep inside the window at every width, cut nothing off silently and stay readable in both appearances", async ({ browser, botbench, seeded }) => {
  test.setTimeout(600_000);
  const problems: string[] = [];
  const others: string[] = [];
  for (const touch of [true, false]) {
    const page = await device(browser, botbench, touch);
    for (const size of WIDTHS.filter((w) => w.touch === touch)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      for (const mode of size.width === 390 || size.width === 1440 || size.width === 1024 ? (["dark", "light"] as const) : (["dark"] as const)) {
        await appearance(page, mode);
        for (const screen of screens(page, seeded)) {
          await page.goto(`${botbench.base}/${screen.at}`);
          await screen.ready();
          const where = `${screen.name} at ${size.width} ${mode}`;
          const found = await fit(page, { contrast: true });
          if (screen.mine) {
            problems.push(...lines(where, found));
            if (!EXPLORE) await checkScreen(page, where);
          } else {
            // The shell's own parts on another's screen: the navigation, the top bar, the foot.
            others.push(...lines(where, found));
          }
          if ([390, 768, 1024, 1440].includes(size.width) && (mode === "dark" ? size.width !== 1440 : size.width === 1440 || size.width === 390)) await picture(page, `stress-${screen.name}-${size.width}-${mode}`);
          if (size.width < 768 && screen.mine) {
            // The bar at the foot never covers the end of the screen: scrolled as far as it goes, the last thing drawn in it is above the bar.
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            const under = await page.evaluate(() => {
              const bar = document.querySelector("[data-testid=bottom-bar]")!.getBoundingClientRect().top;
              const last = Math.max(...[...document.querySelectorAll("main *")].map((el) => el.getBoundingClientRect()).filter((box) => box.width > 1 && box.height > 1).map((box) => box.bottom));
              return Math.round(last - bar);
            });
            if (under > 0) problems.push(`${where}: the bar at the foot covers the last ${under}px of the screen`);
            if (mode === "dark" && size.width === 390) await picture(page, `stress-${screen.name}-390-dark-end`);
          }
        }
      }
      await appearance(page, "dark");
    }
    await page.context().close();
  }
  if (EXPLORE) console.log(JSON.stringify({ problems, others }, null, 1));
  expect(problems).toEqual([]);
});

const barMark = (page: Page) => page.getByTestId("bar-mark");

test("the shell with long and many things: the mark in the top bar, Home's count, the open task named in the rail, the menu, the bar at the foot and the order of the Tab key", async ({ browser, botbench, seeded }) => {
  test.setTimeout(300_000);
  const task = `${botbench.base}/#/tasks/${seeded.taskId}`;
  const phone = await device(browser, botbench, true);

  // ---- Under 1024px the navigation's pane, which carries the mark, is not in view: the top bar carries it, on every screen.
  for (const width of [390, 768, 1023]) {
    await phone.setViewportSize({ width, height: 844 });
    for (const [name, at] of [["Home", `${botbench.base}/#/`], ["a task", task], ["Settings", `${botbench.base}/#/settings`], ["a group of Settings", `${botbench.base}/#/settings/permissions`]] as const) {
      await phone.goto(at);
      const mark = barMark(phone);
      await expect(mark, `${name} at ${width}`).toBeVisible();
      await expect(mark).toHaveAttribute("href", "#/");
      await expect(mark).toHaveAccessibleName("Botbench");
      await expect(mark.locator("svg")).toBeVisible();
      await expect(phone.getByRole("heading", { level: 1 })).toBeVisible();
      // A finger's size, whole and inside the bar, whatever stands beside it: a long name is cut short, the mark is not squeezed.
      const found = await phone.evaluate(() => {
        const mark = document.querySelector("[data-testid=bar-mark]")!;
        const [box, drawing, bar] = [mark.getBoundingClientRect(), mark.querySelector("svg")!.getBoundingClientRect(), document.querySelector("[data-testid=top-bar]")!.getBoundingClientRect()];
        const next = mark.nextElementSibling!.getBoundingClientRect();
        return { width: box.width, height: box.height, drawing: drawing.width, inBar: box.top >= bar.top && box.bottom <= bar.bottom, clear: next.left >= drawing.right + 8, gutter: Math.round(drawing.left) };
      });
      expect(found, `${name} at ${width}`).toMatchObject({ width: 44, height: 44, drawing: 20, inBar: true, clear: true });
      // The mark stands at the screen's own gutter where it is first in the bar.
      if (width < 768) expect(found.gutter).toBe(16);
      expect(lines(`${name} at ${width}`, await fit(phone)).filter((line) => /top-bar|bar-mark/.test(line))).toEqual([]);
    }
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(task);
  await expect(phone.getByRole("heading", { level: 1 })).toBeVisible();
  await picture(phone, "shell-mark-task-390");
  await barMark(phone).click();
  await expect(phone.getByTestId("headline")).toBeVisible();
  await picture(phone, "shell-mark-home-390");
  // The bar at the foot keeps clear of the phone's home indicator, and the screen's own foot stands above it.
  expect(
    await phone.evaluate(() => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).some((rule) => rule.cssText.includes("padding-bottom: env(safe-area-inset-bottom)"))),
    "the bar at the foot is padded by the safe area",
  ).toBe(true);
  await expect(phone.getByTestId("bottom-bar")).toHaveClass(/pb-\[env\(safe-area-inset-bottom\)\]/);

  await phone.setViewportSize({ width: 768, height: 1024 });
  await phone.goto(`${botbench.base}/#/settings/permissions`);
  await expect(phone.getByRole("heading", { level: 1, name: "Permissions and autonomy" })).toBeVisible();
  // ---- The menu closes when a link is chosen, also the link of the screen already shown.
  await phone.getByRole("button", { name: "Screens menu" }).click();
  const menu = phone.getByRole("dialog");
  await expect(menu.getByTestId("workbench")).toContainText(NAME);
  expect(lines("the menu at 768", await fit(phone))).toEqual([]);
  await picture(phone, "shell-menu-768");
  await menu.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await phone.context().close();

  const desk = await device(browser, botbench, false);
  // ---- With a keyboard: a screen's heading has the focus on arrival, so Tab goes on into the screen; from the top of
  // the page the stops are the navigation, then the screen, then its pane, and each shows its ring whole.
  await desk.setViewportSize({ width: 1280, height: 800 });
  await desk.goto(`${botbench.base}/#/settings/permissions`);
  await expect(desk.getByRole("heading", { level: 1, name: "Permissions and autonomy" })).toBeFocused();
  await desk.goto(task);
  await expect(desk.getByRole("heading", { level: 1 })).toBeFocused();
  await desk.getByTestId("shell-side").getByRole("link").first().focus();
  const order: string[] = [];
  for (let i = 0; i < 16; i++) {
    await desk.keyboard.press("Tab");
    order.push(await desk.evaluate(() => (document.activeElement!.closest("[data-testid=shell-side]") ? "navigation" : document.activeElement!.closest("main") ? "screen" : document.activeElement!.closest("aside") ? "pane" : document.activeElement!.getAttribute("data-testid") ?? "bar")));
    // Every stop shows where the focus is, whole: its ring is not cut off by the pane it stands in.
    const ring = await desk.evaluate(() => {
      const el = document.activeElement!;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      let cut = false;
      for (let up = el.parentElement; up !== null; up = up.parentElement) {
        if (getComputedStyle(up).overflowY === "visible") continue;
        const outer = up.getBoundingClientRect();
        if (box.left - 3 < outer.left || box.right + 3 > outer.right) cut = true;
      }
      return { shown: style.boxShadow !== "none" || style.outlineStyle !== "none", cut, name: `${el.tagName.toLowerCase()} ${el.className.toString().slice(0, 200)} "${(el.textContent ?? "").trim().slice(0, 30)}"` };
    });
    // The shell's own stops are held to it here; a screen's own are that screen's tests'.
    if (order[i] === "navigation" || order[i] === "bar") expect(ring, `stop ${i + 1}, ${order[i]}: ${ring.name}`).toMatchObject({ shown: true, cut: false });
  }
  // A tab's panel is a stop of its own (ui/tabs.tsx): it shows a ring as every stop does.
  await desk.getByRole("tabpanel").first().focus();
  await desk.keyboard.press("Shift+Tab");
  await desk.keyboard.press("Tab");
  expect(await desk.getByRole("tabpanel").first().evaluate((panel) => document.activeElement === panel && getComputedStyle(panel).boxShadow !== "none")).toBe(true);
  expect(order[0]).toBe("navigation");
  expect(order).toContain("screen");
  expect(order.lastIndexOf("navigation")).toBeLessThan(order.indexOf("screen"));
  expect(order, "the stops go one way: the navigation, the bar, the screen, its pane").toEqual([...order].sort((a, b) => ["navigation", "bar", "screen", "pane"].indexOf(a) - ["navigation", "bar", "screen", "pane"].indexOf(b)));

  // ---- Every group of Settings starts at the same left edge: going from one to the next moves no heading.
  await desk.setViewportSize({ width: 1440, height: 900 });
  const edges: number[] = [];
  for (const key of Object.keys(GROUPS) as (keyof typeof GROUPS)[]) {
    await desk.goto(`${botbench.base}/#/settings/${key}`);
    const heading = desk.getByRole("heading", { level: 1, name: GROUPS[key] });
    await expect(heading).toBeVisible();
    edges.push(Math.round((await heading.boundingBox())!.x));
  }
  expect(new Set(edges).size, `the headings' left edges: ${edges.join(", ")}`).toBe(1);

  // ---- In the rail under a finger, the workbench's link is its initial alone, and still a finger's size.
  const rail = await device(browser, botbench, true);
  await rail.setViewportSize({ width: 1024, height: 768 });
  await rail.goto(`${botbench.base}/#/`);
  const avatar = (await rail.getByTestId("shell-side").getByTestId("workbench").getByRole("link").boundingBox())!;
  expect({ wide: avatar.width >= 44, high: avatar.height >= 44 }, "the workbench's link in the rail, under a finger").toEqual({ wide: true, high: true });
  await rail.context().close();

  // ---- The open task in the rail (1024 to 1279px) is a dot: it says its title on focus and on hover, inside the window.
  await desk.setViewportSize({ width: 1024, height: 768 });
  await desk.goto(task);
  const open = desk.getByTestId("shell-side").getByRole("link", { name: /^Refactor the/ });
  await expect(open).toHaveAttribute("aria-current", "page");
  await open.focus();
  const tip = desk.locator("[data-slot=tooltip-content]").filter({ hasText: "Refactor the" });
  await expect(tip).toBeVisible();
  // A word too long for the line is broken inside the name's box, not drawn past its side.
  expect(await tip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(lines("the open task's name at 1024", await fit(desk))).toEqual([]);
  const tipBox = (await tip.boundingBox())!;
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(1024);
  await picture(desk, "shell-open-tooltip-1024");
  await desk.keyboard.press("Escape");

  // ---- Home's count in the navigation with 1, 9, 37 and 120 things waiting: a number where there are words, a dot where there are none.
  let have = 1;
  for (const count of [1, 9, 37, 120]) {
    plans(seeded.home, seeded.repos[0]!, count - have, have);
    have = count;
    for (const width of [1440, 1280, 1279, 1024]) {
      await desk.setViewportSize({ width, height: 800 });
      await desk.goto(task);
      await desk.reload();
      await expect(desk.getByRole("heading", { level: 1 })).toContainText("Refactor the");
      const home = desk.getByTestId("shell-side").getByRole("link", { name: /^Home/ });
      await expect(home).toHaveAccessibleName(width >= 1280 ? `Home ${count} waiting for you` : `Home, ${count} waiting for you`);
      if (width >= 1280) {
        await expect(desk.getByTestId("home-count")).toHaveText(`${count} waiting for you`);
        // The number is inside its row, clear of the word.
        const inside = await home.evaluate((link) => {
          const [row, number, word] = [link.getBoundingClientRect(), link.querySelector("[data-testid=home-count]")!.getBoundingClientRect(), link.querySelector("span:not(.relative)")!.getBoundingClientRect()];
          return number.right <= row.right - 8 && number.left >= word.right + 8;
        });
        expect(inside, `${count} at ${width}`).toBe(true);
      }
      expect(lines(`the navigation with ${count} at ${width}`, await fit(desk)).filter((line) => !/main|aside/.test(line))).toEqual([]);
      if (width === 1280 || (width === 1024 && count === 120)) await picture(desk, `shell-count-${count}-${width}`);
    }
  }
  await desk.context().close();
});

const peers = base.extend<{ pair: { alice: Workbench; bob: Workbench } }>({
  pair: async ({}, use) => {
    const dir = tempDir("botbench-e2e-stress-peers-");
    const after: (() => unknown)[] = [];
    const t = { after: (fn: () => unknown) => void after.push(fn) };
    const { aliceRepo, bobRepo } = sharedRepository(dir);
    // Each name is as long as a workbench's may be: 30 characters.
    const a = await workbench(t, dir, "alices-macbook-pro-16-inch-lab", aliceRepo, { repositories: { [aliceRepo]: {} } });
    const b = await workbench(t, dir, "bobs-mac-mini-in-the-back-room", bobRepo, { repositories: { [bobRepo]: {} } });
    await a.start();
    await b.start();
    await use({ alice: a, bob: b });
    await a.stop();
    await b.stop();
    for (const fn of after) await fn();
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

peers("a paired workbench with a long name and a long message: the conversation and Settings keep inside the window at every width", async ({ browser, pair }) => {
  peers.setTimeout(300_000);
  const { alice, bob } = pair;
  const pairing = await pairThem(alice, bob);
  const text = `Which port does the ${UNBROKEN} service listen on, and does it still read https://example.invalid/${UNBROKEN}/${UNBROKEN}?\n\n${"It matters because the export retries against that address, and a wrong port means a day of failed invoices. ".repeat(12)}`;
  expect((await alice.api("POST", `/api/peers/pairings/${pairing}/messages`, { kind: "question", text })).status).toBe(200);
  await until("bob to hold alice's question", async () => (await bob.api("GET", `/api/peers/pairings/${pairing}/messages`)).body.messages?.length > 0);
  const problems: string[] = [];
  for (const touch of [true, false]) {
    const page = await device(browser, { base: bob.base, token: fs.readFileSync(path.join(bob.home, LOGIN_TOKEN_FILE), "utf8").trim() }, touch);
    await page.goto(`${bob.base}/#/`);
    await page.getByTestId("peer-card").getByRole("link", { name: "Open the conversation" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Conversation with ${alice.name}` })).toBeVisible();
    const thread = page.url();
    for (const size of WIDTHS.filter((w) => w.touch === touch)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      for (const mode of size.width === 390 || size.width === 1440 ? (["dark", "light"] as const) : (["dark"] as const)) {
        await appearance(page, mode);
        for (const [name, at, ready] of [
          ["conversation", thread, () => expect(page.getByTestId("peer-card").getByTestId("peer-card-text")).toContainText("Which port does the")],
          ["settings-connections-paired", `${bob.base}/#/settings/connections`, () => expect(page.getByTestId("pairing-words")).toHaveText("Paired")],
          ["settings-list-paired", `${bob.base}/#/settings`, () => expect(page.getByTestId("settings-groups").or(page.getByTestId("settings-nav"))).toBeVisible()],
        ] as const) {
          await page.goto(at);
          await ready();
          const where = `${name} at ${size.width} ${mode}`;
          // The bar is one line at every width: where it is, then its state beside it, clear of the bar's lower edge.
          if (name === "conversation") {
            const bar = await page.evaluate(() => {
              const [top, nav] = [document.querySelector("[data-testid=top-bar]")!.getBoundingClientRect(), document.querySelector("nav[aria-label='Where this is']")!];
              const mark = document.querySelector("[data-testid=bar-mark]")?.getBoundingClientRect();
              return { oneLine: nav.getBoundingClientRect().height < 48, clear: [...nav.children].every((part) => part.getBoundingClientRect().bottom <= top.bottom - 4), markLevel: mark === undefined || Math.abs(mark.top + mark.height / 2 - (top.top + top.height / 2)) <= 1 };
            });
            if (!bar.oneLine || !bar.clear || !bar.markLevel) problems.push(`${where}: the bar is not one line with its mark level: ${JSON.stringify(bar)}`);
          }
          problems.push(...lines(where, await fit(page, { contrast: true })));
          if (!EXPLORE) await checkScreen(page, where);
          if ((size.width === 390 && mode === "dark") || (size.width === 1440 && mode === "light") || size.width === 1024 || size.width === 768) await picture(page, `stress-${name}-${size.width}-${mode}`);
        }
      }
      await appearance(page, "dark");
    }
    await page.context().close();
  }
  if (EXPLORE) console.log(JSON.stringify({ problems }, null, 1));
  expect(problems).toEqual([]);
});
