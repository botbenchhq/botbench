import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { createTask, moveTask } from "../src/engine/task.ts";
import type { DriverEvent } from "../src/drivers/events.ts";
import { openStore } from "../src/store/db.ts";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, openFromSettings, signIn, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// The Usage screen at a phone's size, against a real Botbench process. No model turn is started. The turns it shows were
// stored the way the driver stores them: the usage events are the ones a real Claude Code run produced (the recording
// test/recordings/planner-plans.json, from Claude Code 2.1.322), written to the real database before Botbench starts, for a task
// of a run and for a chat.

const test = base.extend<{ dir: string }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-usage-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

async function open(page: import("@playwright/test").Page, botbench: Botbench): Promise<void> {
  await signIn(page, botbench);
  // Usage is reached from Settings, and leads back to it.
  await openFromSettings(page, "Usage");
  await expect(page.getByRole("banner").getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "#/settings");
}

test("with no replies stored, Usage says so in words", async ({ page, dir }) => {
  const botbench = await startBotbench({ home: path.join(dir, "home") });
  try {
    const foreign = watchRequests(page, botbench);
    await open(page, botbench);
    await expect(page.getByTestId("usage-empty").getByRole("heading", { name: "No usage yet" })).toBeVisible();
    await expect(page.getByTestId("usage-week")).toHaveCount(0);
    await checkDesign(page, "usage, empty");
    expect(foreign).toEqual([]);
  } finally {
    await botbench.stop();
  }
});

test("with replies stored, Usage shows this week, each agent and model, and each run, from the stored numbers", async ({ page, dir }) => {
  const recording = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "test", "recordings", "planner-plans.json"), "utf8")) as { turns: { events: DriverEvent[] }[] };
  const usage = recording.turns.flatMap((turn) => turn.events).filter((event): event is Extract<DriverEvent, { type: "usage" }> => event.type === "usage");
  expect(usage.length).toBeGreaterThanOrEqual(2);
  const [first, second] = usage as [(typeof usage)[number], (typeof usage)[number]];

  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const db = openStore(home);
  const at = new Date().toISOString();
  const attempt = (model: string): number => Number(db.prepare("INSERT INTO attempts (driver, model, status, created_at, updated_at) VALUES ('claude-code', ?, 'ended', ?, ?)").run(model, at, at).lastInsertRowid);
  const store = (attemptId: number, event: DriverEvent): void => void db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, ?, ?)").run(attemptId, at, event.type, JSON.stringify(event));
  // A task that ended in failure, so Botbench starts nothing for it, and a chat that belongs to no run.
  const task = createTask(db, { repo, prompt: "Add a retry to the sync job" });
  const built = attempt("claude-haiku-5-5");
  moveTask(db, task.id, "building", { attemptId: built });
  moveTask(db, task.id, "failed", { reason: "Stopped for this test." });
  store(built, first);
  store(attempt("claude-haiku-5-5"), second);
  db.close();

  const botbench = await startBotbench({ home });
  try {
    const foreign = watchRequests(page, botbench);
    await open(page, botbench);
    const grouped = (n: number): string => n.toLocaleString("en-US");
    const input = (u: typeof first): number => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

    await expect(page.getByTestId("usage-empty")).toHaveCount(0);
    await expect(page.getByTestId("usage-week")).toContainText("2 replies");
    await expect(page.getByTestId("usage-week")).toContainText(`${grouped(input(first) + input(second))} tokens`);
    await expect(page.getByTestId("usage-week")).toContainText(`${grouped(first.outputTokens + second.outputTokens)} tokens`);
    const week = page.getByTestId("usage-agents-week");
    await expect(week.getByTestId("usage-agent")).toHaveCount(1);
    await expect(week.getByTestId("usage-agent").first()).toContainText("Claude Code");
    await expect(week.getByTestId("usage-model").first()).toContainText("2 replies");
    // The run list: the task's run, with the numbers of its own reply only; the chat reply is in no run.
    const runs = page.getByTestId("usage-run");
    await expect(runs).toHaveCount(1);
    await expect(runs.first()).toContainText("Add a retry to the sync job");
    await expect(runs.first()).toContainText("1 reply");
    await expect(runs.first()).toContainText(`${grouped(input(first))} tokens`);
    await expect(page.getByTestId("usage-runs-count")).toHaveText("1 run used an agent.");
    await expect(page.locator("main")).not.toContainText("$");
    await checkDesign(page, "usage, with replies");
    expect(foreign).toEqual([]);
  } finally {
    await botbench.stop();
  }
});
