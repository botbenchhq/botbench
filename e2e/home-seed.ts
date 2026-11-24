import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test as base, type Page } from "@playwright/test";
import { decideTask } from "../src/engine/decision.ts";
import { createRun, storePlan } from "../src/engine/run.ts";
import { CHANGED_NOTHING, createTask, moveTask, type Task } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { storeChecks } from "../test/support/checks.ts";
import type { Left } from "../test/support/leave-pending.ts";
import { git, initRepo, write } from "../test/support/repo.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";
import { expect, SHOTS, watchRefused } from "./helpers.ts";

// What the Home and Work tests share (e2e/home.e2e.ts, e2e/work.e2e.ts). No model turn anywhere: before Botbench
// starts, runs and tasks are put in its real store through the engine itself, in real temporary repositories, each in
// the state a screen must show, and an approval is left waiting by a Botbench that stopped where it stood
// (test/support/leave-pending.ts). Botbench is then started with a builder that replays a recorded Claude Code turn
// and holds it (e2e/serve-replayed-build.ts), so a task started through the API is really at work while the test looks.

export const CHECK = "test -f README.md";
/** What the approval left waiting asks to run, and the title its task has (test/support/leave-pending.ts). */
export const ASKS = "sh other.sh";
export const ASKING = "Run the command `sh make-marker.sh` with your Bash tool, exactly once.";

export interface Seeded {
  home: string;
  repo: string;
  approval: Left;
  /** Titles, in the order Home must show what needs the owner. */
  needs: string[];
  ids: Record<string, number>;
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

/** The engine's own steps, for a store nothing else has open. */
export function seeder(db: DatabaseSync, home: string, repo: string) {
  const made = async (prompt: string): Promise<Task> => {
    await pause();
    return createTask(db, { repo, prompt });
  };
  const building = async (prompt: string): Promise<Task> => {
    const task = await made(prompt);
    const worktree = await createWorktree({ repo, home, run: `run-${task.runId}`, task: `task-${task.id}` });
    const at = new Date().toISOString();
    const attemptId = Number(db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES ('claude-code', 'haiku', 'ended', ?, ?)").run(at, at).lastInsertRowid);
    return moveTask(db, task.id, "building", { worktree, attemptId });
  };
  const ready = async (prompt: string): Promise<Task> => {
    const task = await building(prompt);
    write(task.worktreePath!, `task-${task.id}.txt`, "hi\n");
    const committed = await commitWork({ path: task.worktreePath!, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    storeChecks(db, task.id, committed.commit, "passed", CHECK);
    return moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed" });
  };
  return {
    ready,
    plan: async (prompt: string, tasks: number): Promise<number> => {
      await pause();
      const run = createRun(db, { repo, prompt, baseCommit: git(repo, "rev-parse", "HEAD").trim() });
      storePlan(db, run.id, Array.from({ length: tasks }, (_, i) => ({ title: `Step ${i + 1}`, criteria: [`Step ${i + 1} is done`] })));
      return run.id;
    },
    /** Its agent ended without changing a file: the one failure the owner can resume. */
    recoverable: async (prompt: string): Promise<Task> => moveTask(db, (await building(prompt)).id, "failed", { reason: `${CHANGED_NOTHING} Its last message is in the transcript.` }),
    limited: async (prompt: string, retryAt: string): Promise<Task> => moveTask(db, (await building(prompt)).id, "waiting_for_limit", { retryAt }),
    accepted: async (prompt: string): Promise<Task> => (await decideTask(db, { taskId: (await ready(prompt)).id, decision: "accept" })).task,
    rejected: async (prompt: string): Promise<Task> => (await decideTask(db, { taskId: (await ready(prompt)).id, decision: "reject", branch: "discard" })).task,
    cancelled: async (prompt: string): Promise<Task> => moveTask(db, (await made(prompt)).id, "cancelled"),
    failed: async (prompt: string): Promise<Task> => moveTask(db, (await made(prompt)).id, "failed", { reason: "The setup command ended with code 1." }),
  };
}

/** Tomorrow at 14:30 where the test runs: a usage limit that is not tried again while the test looks. */
export function tomorrowAfternoon(): Date {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(14, 30, 0, 0);
  return at;
}

/** An approval left waiting by a Botbench that stopped where it stood; its session can be resumed, so the next start keeps the request. */
function leaveApproval(home: string, repo: string): Left {
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "..", "test", "support", "leave-pending.ts"), JSON.stringify({ home, repo, cursor: "5d1c7a52-8f0e-4b8e-9a3e-2f6b1c0d4e7a", commands: [ASKS] })], { encoding: "utf8" });
  return JSON.parse(run.stdout) as Left;
}

/** A few of everything: what the boards V2Home and V2Work show. */
async function few(dir: string): Promise<Seeded> {
  const home = path.join(dir, "home");
  const repo = path.join(dir, "billing-api");
  initRepo(repo, { "README.md": "# Billing\n", "other.sh": "#!/bin/sh\necho other\n" });
  const approval = leaveApproval(home, repo);
  const db = openStore(home);
  const s = seeder(db, home, repo);
  const result = await s.ready("Cache the exchange rates for an hour");
  const plan = await s.plan("Plan the billing export", 4);
  const failure = await s.recoverable("Migrate the invoices table");
  const later = await s.ready("Add a function that adds two numbers");
  const limited = await s.limited("Tidy the changelog", tomorrowAfternoon().toISOString());
  const accepted = await s.accepted("Fix the login timeout");
  const second = await s.accepted("Bump the copyright year in every file header, the licence notice and the footer of the documentation site");
  const rejected = await s.rejected("Rename the config loader");
  const cancelled = await s.cancelled("Tidy module number 9");
  const failed = await s.failed("Generate the changelog from the release tags");
  db.close();
  return {
    home, repo: fs.realpathSync(repo), approval,
    needs: [ASKING, "Migrate the invoices table", "Plan the billing export", "Cache the exchange rates for an hour", "Add a function that adds two numbers"],
    ids: { approval: approval.taskId, result: result.id, plan, failure: failure.id, later: later.id, limited: limited.id, accepted: accepted.id, second: second.id, rejected: rejected.id, cancelled: cancelled.id, failed: failed.id },
  };
}

/** A title of over 120 characters, and one that is a single unbroken token, as a branch name or a path is. */
export const LONG_TITLE = "Rewrite the invoice reconciliation pipeline so that multi-currency ledgers are balanced per settlement day, and backfill every historic record since 2019";
export const LONG_TOKEN = "feature/BILLING-12345-rewrite-the-invoice-reconciliation-pipeline-for-multi-currency-ledgers/src/engine/reconciliation/settlement_day_balancer.test.ts";
/** A repository whose folder name is far longer than any column or chip that shows it. */
export const LONG_REPO = "billing-api-for-the-european-payments-platform-and-its-settlement-ledgers-monorepo";

/**
 * A few of everything, each with a title or a name longer than its place on the screen: what a layout must cut short or
 * wrap inside its card. One long title in each group of Home, so each kind of row is stretched.
 */
async function stressed(dir: string): Promise<Seeded> {
  const home = path.join(dir, "home");
  const repo = path.join(dir, LONG_REPO);
  initRepo(repo, { "README.md": "# Billing\n", "other.sh": "#!/bin/sh\necho other\n" });
  const approval = leaveApproval(home, repo);
  const db = openStore(home);
  const s = seeder(db, home, repo);
  const failure = await s.recoverable(`${LONG_TOKEN} fails on the first run`);
  const plan = await s.plan(`${LONG_TITLE}, as a plan`, 12);
  const result = await s.ready(`${LONG_TITLE}, as a result`);
  const later = await s.ready(LONG_TOKEN);
  const limited = await s.limited(`${LONG_TITLE}, waiting`, tomorrowAfternoon().toISOString());
  await s.limited(`${LONG_TOKEN}-waiting`, tomorrowAfternoon().toISOString());
  const accepted = await s.accepted(`${LONG_TITLE}, accepted`);
  const second = await s.accepted(`${LONG_TOKEN}-accepted`);
  const rejected = await s.rejected(`${LONG_TITLE}, rejected`);
  const cancelled = await s.cancelled(`${LONG_TOKEN}-cancelled`);
  const failed = await s.failed(`${LONG_TITLE}, failed`);
  db.close();
  return {
    home, repo: fs.realpathSync(repo), approval,
    needs: [ASKING, `${LONG_TOKEN} fails on the first run`, `${LONG_TITLE}, as a plan`, `${LONG_TITLE}, as a result`, LONG_TOKEN],
    ids: { approval: approval.taskId, result: result.id, plan, failure: failure.id, later: later.id, limited: limited.id, accepted: accepted.id, second: second.id, rejected: rejected.id, cancelled: cancelled.id, failed: failed.id },
  };
}

/** How many of each the sixty hold: what the board V2HomeFifty shows, and enough rows that Work has older ones to ask for. */
export const MANY = { needs: 7, inProgress: 18, waiting: 8, completed: 14, rejected: 2, cancelled: 10, failed: 1 };

async function many(dir: string, name = "payments"): Promise<Seeded> {
  const home = path.join(dir, "home");
  const repo = path.join(dir, name);
  initRepo(repo, { "README.md": "# Payments\n", "other.sh": "#!/bin/sh\necho other\n" });
  const approval = leaveApproval(home, repo);
  const db = openStore(home);
  const s = seeder(db, home, repo);
  const needs = [ASKING];
  needs.push((await s.recoverable("Migrate the invoices table")).prompt);
  for (const prompt of ["Plan the billing export", "Plan the move to the new payments provider"]) (await s.plan(prompt, 4), needs.push(prompt));
  for (const prompt of ["Cache the exchange rates for an hour", "Add a function that adds two numbers", "Validate the webhook signature"]) needs.push((await s.ready(prompt)).prompt);
  for (let i = 0; i < MANY.waiting; i++) await s.limited(`Wait for the limit, task ${i + 1}`, new Date(tomorrowAfternoon().getTime() + i * 60_000).toISOString());
  for (let i = 0; i < MANY.completed; i++) await s.accepted(`Accepted change ${i + 1}`);
  for (let i = 0; i < MANY.rejected; i++) await s.rejected(`Rejected change ${i + 1}`);
  for (let i = 0; i < MANY.cancelled; i++) await s.cancelled(`Cancelled change ${i + 1}`);
  await s.failed("Generate the changelog from the release tags");
  // Queued last: the builder takes up the first and is held there, and the rest wait their place behind it.
  for (let i = 0; i < MANY.inProgress; i++) {
    await pause();
    createTask(db, { repo, prompt: `Queued change ${i + 1}` });
  }
  db.close();
  return { home, repo: fs.realpathSync(repo), approval, needs, ids: { approval: approval.taskId } };
}

export const test = base.extend<{ /** "stressed" is a few of everything with long titles and a long repository name; "many-long" is the sixty in a repository with a long name. */
  size: "few" | "many" | "stressed" | "many-long"; dir: string; seeded: Seeded; botbench: Botbench; refused: string[] }>({
  size: ["few", { option: true }],
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-home-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir, size }, use) => use(await (size === "few" ? few(dir) : size === "stressed" ? stressed(dir) : many(dir, size === "many-long" ? LONG_REPO : undefined))),
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home, entry: path.resolve(import.meta.dirname, "serve-replayed-build.ts"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [seeded.repo]: { checks: [CHECK] } } } });
    await use(botbench);
    expect((await botbench.stop()).leftover).toEqual([]);
  },
  refused: async ({ page }, use) => use(await watchRefused(page)),
});

/** Sign in at the bare address, as a person opening Botbench does, and wait for the screen behind it. */
export async function signInAtHome(page: Page, botbench: Botbench): Promise<void> {
  await page.goto(botbench.base);
  await page.getByLabel("Login token").fill(botbench.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("headline")).toBeVisible();
}

/** A picture of the screen named `<name>.png` in the folder BOTBENCH_SHOTS names (docs/design/built, for the pictures kept with the code). */
export async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

/** Choose the appearance as Settings stores it, applied before the first paint by the page's own script. */
export async function appearance(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.evaluate((to) => window.localStorage.setItem("botbench.appearance", to), mode);
  await page.reload();
}

/** Start a task through the API, as the composer does; the replayed builder takes it up and is held, so it stays at work. */
export async function startTask(page: Page, botbench: Botbench, repo: string, prompt: string): Promise<number> {
  const res = await page.request.post(`${botbench.base}/api/tasks`, { data: { repo, prompt } });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { taskId: number }).taskId;
}
