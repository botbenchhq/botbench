import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test as base, type Browser, type Page } from "@playwright/test";
import { createRun, storePlan } from "../src/engine/run.ts";
import { openStore } from "../src/store/db.ts";
import { git, initRepo } from "../test/support/repo.ts";
import { pairThem, workbench, type Workbench } from "../test/support/two-workbenches.ts";
import { startBotbench, type Botbench } from "./botbench.ts";
import { closeContext, expect, messageBox, openRow, sendChat } from "./helpers.ts";
import { seeder, tomorrowAfternoon } from "./home-seed.ts";
import { choose as chooseSetting } from "./settings-helpers.ts";

// The pictures and clips the README and the website show, taken from the real client served by a real Botbench:
//   npm run media
// writes them into docs/images and docs/media, and is skipped without BOTBENCH_MEDIA. No model turn: the work on Home
// is put in the store through the engine (home-seed.ts), a build is the recorded Claude Code turn that fixes `add` in
// calc.py and its review the recorded Codex review of that fix (serve-replayed-media.ts), the repository's check really
// runs, the chat's request is a recorded chat turn, and the two paired workbenches are two real processes whose owners
// type their own messages. Nothing on a picture is drawn or edited; a clip is the screen's own frames, each shown for as
// long as it was on screen. What may be seen: the workbench names studio-mac and office-mac and the folder
// /private/tmp/studio, never this Mac's name, a home folder or the login token (sign-in happens before a clip starts).

const OUT = process.env.BOTBENCH_MEDIA;
base.skip(!OUT, "BOTBENCH_MEDIA names no folder for the pictures and clips");
base.describe.configure({ mode: "serial" });

/** Every repository and data folder is under this one, so a path a screen shows names neither this Mac nor its owner. */
const ROOT = "/tmp/studio";
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true };
const CHECK = "python3 -B -m unittest -q";
const FILES = {
  "README.md": "# Billing API\n",
  "calc.py": "def add(a, b):\n    return a - b\n",
  "test_calc.py": "import unittest\nfrom calc import add\n\n\nclass AddTest(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(add(1900, 1500), 3400)\n",
};
const RUN = "Invoice totals come out too low: a review found that add in calc.py returns a - b. Fix it.";
const TASK = "A review found that add in calc.py returns a - b. Fix it.";
const QUESTION = "Is the billing API still sending amounts in cents? My invoice change reads them, and I want to match what you are building.";
const ANSWER = "Yes, cents until the next release. I will tell you before that changes.";
type Mode = "dark" | "light";

const image = (name: string): string => path.join(OUT!, "images", name);
const media = (name: string): string => path.join(OUT!, "media", name);
const pause = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms);

/** Written into ROOT when this file makes it: only a folder that holds it is ever removed. */
const MARK = ".botbench-media";

function freshRoot(): string {
  if (fs.existsSync(ROOT) && !fs.existsSync(path.join(ROOT, MARK))) throw new Error(`${ROOT} exists and was not made by e2e/media.shots.ts. Move it away, then run npm run media again.`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, MARK), "");
  for (const dir of ["images/peers", "media"]) fs.mkdirSync(path.join(OUT!, dir), { recursive: true });
  return fs.realpathSync(ROOT);
}

/** A page signed in to `at`, in the appearance named. The token is typed before any picture or clip. */
async function signedIn(browser: Browser, at: string, token: string, look: object, mode: Mode = "dark"): Promise<Page> {
  const page = await (await browser.newContext(look)).newPage();
  await page.goto(at);
  await page.evaluate((m) => window.localStorage.setItem("botbench.appearance", m), mode);
  await page.getByLabel("Login token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("headline")).toBeVisible();
  return page;
}

/** The screen as it stands, once it is drawn and nothing on it moves. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  // Only what ends: a mark that turns while an agent works never does.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {}))));
  await pause(page, 500);
}

/** A picture of `at` in each appearance asked for: `<name>.png` in dark, `<name>-light.png` in light. `ready` is what the screen shows once it has read its data. */
async function picture(page: Page, file: string, at: string, ready: () => Promise<unknown>, modes: readonly Mode[] = ["dark"]): Promise<void> {
  for (const mode of modes) {
    await page.goto(at);
    await page.evaluate((m) => window.localStorage.setItem("botbench.appearance", m), mode);
    await page.reload();
    await ready();
    await settle(page);
    await page.screenshot({ path: mode === "dark" ? file : file.replace(/\.png$/, "-light.png") });
  }
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "dark"));
}

/** A clip of what a page shows from now on: a screenshot of every moment with the time it was taken. */
function film(page: Page, dir: string): { stop(): Promise<{ list: string; last: string }> } {
  fs.mkdirSync(dir, { recursive: true });
  const frames: { file: string; at: number }[] = [];
  let on = true;
  const loop = (async () => {
    for (let i = 0; on; i++) {
      const file = path.join(dir, `${String(i).padStart(5, "0")}.jpg`);
      const at = Date.now();
      await page.screenshot({ path: file, type: "jpeg", quality: 92 }).catch(() => {});
      if (fs.existsSync(file)) frames.push({ file, at });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  })();
  return {
    stop: async () => {
      on = false;
      await loop;
      const end = Date.now();
      // Each frame for as long as it was on screen: nothing is cut and nothing plays faster.
      const lines = frames.flatMap((f, i) => [`file '${f.file}'`, `duration ${(((frames[i + 1]?.at ?? end) - f.at) / 1000).toFixed(4)}`]);
      const list = path.join(dir, "frames.txt");
      fs.writeFileSync(list, [...lines, `file '${frames.at(-1)!.file}'`].join("\n"));
      return { list, last: frames.at(-1)!.file };
    },
  };
}

const ffmpeg = (...args: string[]): void => void execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const mp4 = (list: string, out: string, width: number): void => ffmpeg("-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=30,scale=${width}:-2`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "24", out);

interface Studio {
  botbench: Botbench;
  root: string;
  repo: string;
  /** The run whose plan waits, and the task that is ready for review. */
  ids: { run: number; ready: number };
  at(hash: string): string;
  /** Let the `n`th build (from 0) go on: it is held once its session has opened (serve-replayed-media.ts). */
  release(n: number): void;
}

/** What studio-mac holds before it starts, through the engine's own steps: work in each state, in one repository. */
async function seedStudio(home: string, repo: string, baseCommit: string): Promise<Studio["ids"]> {
  const db = openStore(home);
  const s = seeder(db, home, repo);
  await s.accepted("Fix the login timeout");
  await s.accepted("Cache the exchange rates for an hour");
  await s.rejected("Rename the config loader");
  await s.recoverable("Migrate the invoices table");
  await s.limited("Tidy the changelog", tomorrowAfternoon().toISOString());
  const ready = await s.ready("Add CSV export to billing");
  const run = createRun(db, { repo, prompt: RUN, baseCommit, reviewer: { agent: "codex", model: null } });
  storePlan(db, run.id, [{ title: "Make add in calc.py return the sum", criteria: ["add(a, b) in calc.py returns the sum of a and b", "The repository's tests pass"] }]);
  db.close();
  return { run: run.id, ready: ready.id };
}

const test = base.extend<{ studio: Studio }>({
  studio: async ({}, use) => {
    const root = freshRoot();
    const home = path.join(root, "botbench");
    const repo = path.join(root, "billing-api");
    const ids = await seedStudio(home, repo, initRepo(repo, FILES));
    const botbench = await startBotbench({ home, entry: path.resolve(import.meta.dirname, "serve-replayed-media.ts"), settings: { workbench: "studio-mac", drivers: { "claude-code": { model: "haiku" }, codex: {} }, repositories: { [repo]: { checks: [CHECK] } } } });
    await use({ botbench, root, repo, ids, at: (hash) => `${botbench.base}/${hash}`, release: (n) => fs.writeFileSync(path.join(root, `release-builder-${n}`), "") });
    await botbench.stop();
    fs.rmSync(ROOT, { recursive: true, force: true });
  },
});

/** Approve the run's plan as its owner does, and return its task's address once Claude Code is at work on it. */
async function approvePlan(page: Page, studio: Studio): Promise<string> {
  await page.getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByText("Claude Code is working; open it to watch")).toBeVisible();
  const run = (await (await page.request.get(studio.at(`api/runs/${studio.ids.run}`))).json()) as { tasks: { id: number }[] };
  return studio.at(`#/tasks/${run.tasks[0]!.id}`);
}

const readyForReview = (page: Page): Promise<void> => expect(page.getByRole("button", { name: "Accept", exact: true }).first()).toBeVisible({ timeout: 60_000 });

/** Two real pictures side by side on a plain ground, as one: the desktop's and, beside it, the phone's. Neither is changed. */
async function sideBySide(browser: Browser, root: string, desktop: string, phone: string, out: string, mode: Mode): Promise<void> {
  const [ground, edge] = mode === "dark" ? ["#08090b", "#2a2f38"] : ["#eceef1", "#c9ced6"];
  const html = path.join(root, `side-by-side-${mode}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:${ground}}img{position:absolute;display:block;border:1px solid ${edge};box-shadow:0 24px 60px rgba(0,0,0,.35)}.d{left:40px;top:60px;width:1180px;border-radius:14px}.p{right:40px;top:72px;width:330px;border-radius:28px}</style><img class="d" src="file://${desktop}"><img class="p" src="file://${phone}">`);
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 860 }, deviceScaleFactor: 2 })).newPage();
  await page.goto(`file://${html}`);
  await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: out });
  await page.context().close();
}

test("pictures: Home, a task ready for review with its checks and Codex's review, Check a command, the agents, and a request waiting in a chat", async ({ browser, studio }) => {
  test.setTimeout(600_000);
  const { botbench } = studio;
  const page = await signedIn(browser, botbench.base, botbench.token, DESKTOP);
  const phone = await signedIn(browser, botbench.base, botbench.token, PHONE);
  const both = ["dark", "light"] as const;

  // The run's plan is approved, Claude Code fixes calc.py, the check runs and Codex reviews the fix.
  await page.goto(studio.at(`#/runs/${studio.ids.run}`));
  const task = await approvePlan(page, studio);
  studio.release(0);
  await page.goto(task);
  await readyForReview(page);

  await picture(page, image("ready-for-review-proof.png"), task, () => readyForReview(page), both);
  await picture(phone, image("ready-for-review.png"), task, () => readyForReview(phone));
  // The lead picture: Home on the Mac, and the same task on the phone.
  const parts = path.join(studio.root, "parts");
  fs.mkdirSync(parts);
  await picture(page, path.join(parts, "home.png"), studio.at("#/"), () => expect(page.getByTestId("headline")).toBeVisible(), both);
  await picture(phone, path.join(parts, "task.png"), task, () => readyForReview(phone), both);
  await sideBySide(browser, studio.root, path.join(parts, "home.png"), path.join(parts, "task.png"), image("hero-workbench.png"), "dark");
  await sideBySide(browser, studio.root, path.join(parts, "home-light.png"), path.join(parts, "task-light.png"), image("hero-workbench-light.png"), "light");

  // Settings: what a push would get in each mode, and the agents this workbench found.
  const checked = async (): Promise<void> => {
    await page.getByTestId("check-command").fill("git push origin main");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByTestId("check-result")).toBeVisible();
    await page.getByRole("heading", { name: "Check a command" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.move(900, 450);
    await page.mouse.wheel(0, -56);
  };
  await picture(page, image("permissions-check.png"), studio.at("#/settings/permissions"), checked, both);
  await picture(phone, image("agents-available.png"), studio.at("#/settings/agents"), async () => (await expect(phone.getByRole("heading", { level: 1, name: "Agents and models" })).toBeVisible(), await expect(phone.getByText("Checking", { exact: true })).toHaveCount(0)));

  // A chat whose request waits: with Web access set to Ask, Claude Code's recorded turn asks to fetch a page.
  await phone.goto(studio.at("#/settings/permissions"));
  await chooseSetting(phone, "Web access", "Ask");
  await expect(phone.getByTestId("web-access-saved")).toHaveText("Saved.");
  await phone.goto(studio.at("#/turn"));
  await expect(messageBox(phone)).toBeEnabled();
  await sendChat(phone, "Fetch https://example.com and tell me its title.");
  await expect(phone.getByTestId("approval-card")).toHaveAttribute("data-settled", "", { timeout: 30_000 });
  const latest = phone.getByRole("button", { name: /Jump to latest/ });
  if (await latest.isVisible()) await latest.click();
  await settle(phone);
  await phone.screenshot({ path: image("approval-card.png") });
});

test("the demo: a plan is approved, Claude Code builds, the check and Codex's review come back, and the task is accepted", async ({ browser, studio }) => {
  test.setTimeout(600_000);
  const { botbench } = studio;
  const page = await signedIn(browser, botbench.base, botbench.token, DESKTOP);
  await settle(page);
  const clip = film(page, path.join(studio.root, "demo-frames"));
  await pause(page, 2500);
  await page.getByRole("link", { name: "Read the plan" }).or(page.getByRole("button", { name: "Read the plan" })).first().click();
  await expect(page.getByRole("button", { name: /^Approve/ })).toBeVisible();
  await pause(page, 3500);
  await approvePlan(page, studio);
  await pause(page, 2000);
  await page.getByText("Claude Code is working; open it to watch").click();
  await expect(page.getByText("Claude Code is working.")).toBeVisible();
  await pause(page, 3500);
  studio.release(0);
  await readyForReview(page);
  await pause(page, 5000);
  // The thumbnail is this moment of the clip: the task ready for review.
  await page.screenshot({ path: media("botbench-demo-thumbnail.png") });
  await page.getByRole("button", { name: "Accept", exact: true }).first().click();
  await expect(page.getByText("Accepted").first()).toBeVisible();
  await pause(page, 3000);
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: /^Home/ }).first().click();
  await expect(page.getByTestId("headline")).toBeVisible();
  await pause(page, 3000);
  mp4((await clip.stop()).list, media("botbench-demo.mp4"), 1440);
});

test("the first task on a phone: a repository, one task, Claude Code's work, the check, Accept", async ({ browser, studio }) => {
  test.setTimeout(600_000);
  const { botbench } = studio;
  const page = await signedIn(browser, botbench.base, botbench.token, { ...PHONE, deviceScaleFactor: 2 });
  await page.goto(studio.at("#/new"));
  await expect(messageBox(page)).toBeEnabled();
  await settle(page);
  const clip = film(page, path.join(studio.root, "phone-frames"));
  await pause(page, 1500);
  let sheet = await openRow(page, "Repository");
  await pause(page, 1200);
  await sheet.getByRole("radio", { name: "Another folder…" }).check();
  await sheet.getByLabel("Folder path").pressSequentially(studio.repo, { delay: 25 });
  await expect(sheet.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await pause(page, 1000);
  await sheet.getByRole("button", { name: "Back to Add context" }).click();
  await pause(page, 600);
  sheet = await openRow(page, "What to do");
  await pause(page, 800);
  await sheet.getByRole("radio", { name: "One task", exact: true }).click();
  await pause(page, 800);
  await closeContext(page);
  await messageBox(page).pressSequentially(TASK, { delay: 22 });
  await pause(page, 800);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/#\/tasks\/\d+$/);
  await expect(page.getByText("Claude Code is working.")).toBeVisible();
  await pause(page, 3500);
  studio.release(0);
  const accept = page.getByRole("button", { name: "Accept", exact: true }).first();
  await expect(accept).toBeVisible({ timeout: 60_000 });
  await pause(page, 2500);
  await page.screenshot({ path: media("first-task-phone-poster.jpg"), type: "jpeg", quality: 90 });
  for (let i = 0; i < 3; i++) (await page.mouse.wheel(0, 300), await pause(page, 900));
  await pause(page, 1200);
  await accept.click();
  await expect(page.getByText("Accepted").first()).toBeVisible();
  await pause(page, 3000);
  mp4((await clip.stop()).list, media("first-task-phone.mp4"), 780);
});

interface Pair {
  studio: Workbench;
  office: Workbench;
  root: string;
  token(w: Workbench): string;
}

/** studio-mac and office-mac: two Botbench processes, each with its own data folder and its own copy of one repository, paired through the owners' real routes. */
const paired = base.extend<{ pair: Pair }>({
  pair: async ({}, use) => {
    const root = freshRoot();
    const after: (() => unknown)[] = [];
    const t = { after: (fn: () => unknown) => void after.push(fn) };
    const remote = path.join(root, "billing-api.git");
    git(root, "init", "--quiet", "--bare", "-b", "main", remote);
    const studioRepo = path.join(root, "billing-api");
    initRepo(studioRepo, FILES);
    git(studioRepo, "remote", "add", "origin", remote);
    git(studioRepo, "push", "--quiet", "origin", "main");
    const officeRepo = path.join(root, "office", "billing-api");
    fs.mkdirSync(path.dirname(officeRepo));
    git(root, "clone", "--quiet", remote, officeRepo);
    // studio-mac has work of its own on Home, beside what office-mac sends.
    const db = openStore(path.join(root, "studio-mac-home"));
    await seeder(db, path.join(root, "studio-mac-home"), studioRepo).ready("Add CSV export to billing");
    db.close();
    const studio = await workbench(t, root, "studio-mac", studioRepo, { repositories: { [studioRepo]: {} } });
    const office = await workbench(t, root, "office-mac", officeRepo, { repositories: { [officeRepo]: {} } });
    await studio.start();
    await office.start();
    await pairThem(studio, office);
    await use({ studio, office, root, token: (w) => fs.readFileSync(path.join(w.home, "login-token"), "utf8").trim() });
    await studio.stop();
    await office.stop();
    for (const fn of after) await fn();
    fs.rmSync(ROOT, { recursive: true, force: true });
  },
});

/** office-mac's owner writes the question and presses Send. */
async function ask(page: Page, typed: boolean): Promise<void> {
  const section = page.getByTestId("paired-workbench");
  const box = section.getByLabel("A new question for studio-mac");
  await box.scrollIntoViewIfNeeded();
  if (typed) await box.pressSequentially(QUESTION, { delay: 18 });
  else await box.fill(QUESTION);
  if (typed) await pause(page, 900);
  await section.getByTestId("new-question").getByRole("button", { name: "Send", exact: true }).click();
  await expect(section.getByTestId("new-question-said")).toBeVisible();
}

paired("pictures: a question from the paired workbench on Home, the conversation, and the pairing in Settings", async ({ browser, pair }) => {
  paired.setTimeout(600_000);
  const { studio, office } = pair;
  const s = await signedIn(browser, studio.base, pair.token(studio), DESKTOP);
  const sPhone = await signedIn(browser, studio.base, pair.token(studio), PHONE);
  const o = await signedIn(browser, office.base, pair.token(office), DESKTOP);
  const oPhone = await signedIn(browser, office.base, pair.token(office), PHONE);

  await o.goto(`${office.base}/#/settings/paired`);
  await ask(o, false);
  const card = (page: Page) => page.getByTestId("peer-card");
  await picture(s, image("paired-question.png"), `${studio.base}/#/`, () => expect(card(s)).toBeVisible(), ["dark", "light"]);
  await picture(s, image("peers/peers-incoming-card-desktop.png"), `${studio.base}/#/`, () => expect(card(s)).toBeVisible());
  await picture(sPhone, image("peers/peers-incoming-card-phone.png"), `${studio.base}/#/`, () => expect(card(sPhone)).toBeVisible());
  await picture(s, image("peers/peers-paired-section-desktop.png"), `${studio.base}/#/settings/connections`, () => expect(s.getByTestId("paired-workbench").first()).toBeVisible());
  await picture(sPhone, image("peers/peers-paired-section-phone.png"), `${studio.base}/#/settings/connections`, () => expect(sPhone.getByTestId("paired-workbench").first()).toBeVisible());

  // studio-mac's owner answers; office-mac's owner opens the conversation.
  await s.goto(`${studio.base}/#/`);
  await card(s).getByRole("button", { name: "Answer it yourself" }).click();
  await card(s).getByLabel("Your answer").fill(ANSWER);
  await card(s).getByRole("button", { name: "Send", exact: true }).click();
  await expect(card(s)).toHaveCount(0);
  await o.goto(`${office.base}/#/`);
  await card(o).getByRole("link", { name: "Open the conversation" }).click();
  await expect(o.getByRole("heading", { level: 1, name: "Conversation with studio-mac" })).toBeVisible();
  const thread = o.url();
  await picture(o, image("peers/peers-thread-desktop.png"), thread, () => expect(card(o)).toBeVisible());
  await picture(oPhone, image("peers/peers-thread-phone.png"), thread, () => expect(card(oPhone)).toBeVisible());
});

paired("the paired question: office-mac asks, studio-mac answers, and the answer arrives, each owner on their own screen", async ({ browser, pair }) => {
  paired.setTimeout(600_000);
  const { studio, office } = pair;
  const look = { ...PHONE, deviceScaleFactor: 2 };
  const s = await signedIn(browser, studio.base, pair.token(studio), look);
  const o = await signedIn(browser, office.base, pair.token(office), look);
  await o.goto(`${office.base}/#/settings/paired`);
  await o.getByTestId("paired-workbench").getByLabel("A new question for studio-mac").scrollIntoViewIfNeeded();
  await settle(o);
  await settle(s);
  const left = film(o, path.join(pair.root, "office-frames"));
  const right = film(s, path.join(pair.root, "studio-frames"));
  await pause(o, 1500);
  await ask(o, true);
  const card = s.getByTestId("peer-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await pause(s, 3000);
  await card.getByRole("button", { name: "Answer it yourself" }).click();
  await card.getByLabel("Your answer").pressSequentially(ANSWER, { delay: 18 });
  await pause(s, 900);
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card).toHaveCount(0);
  await pause(s, 1200);
  await o.goto(`${office.base}/#/`);
  await expect(o.getByTestId("peer-card")).toBeVisible({ timeout: 30_000 });
  await pause(o, 2500);
  await o.getByTestId("peer-card").getByRole("link", { name: "Open the conversation" }).click();
  await expect(o.getByRole("heading", { level: 1, name: "Conversation with studio-mac" })).toBeVisible();
  await pause(o, 4000);
  const [a, b] = [await left.stop(), await right.stop()];
  // The two phones side by side, office-mac on the left: both clips began and ended together.
  ffmpeg("-f", "concat", "-safe", "0", "-i", a.list, "-f", "concat", "-safe", "0", "-i", b.list, "-filter_complex", "[0:v]fps=30,scale=600:-2,pad=iw+12:ih:0:0:color=0x08090B[a];[1:v]fps=30,scale=600:-2[b];[a][b]hstack=inputs=2:shortest=1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "25", media("paired-question.mp4"));
  ffmpeg("-sseof", "-1", "-i", media("paired-question.mp4"), "-frames:v", "1", "-update", "1", media("paired-question-poster.jpg"));
});
