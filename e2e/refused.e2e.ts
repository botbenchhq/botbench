import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { createBroker } from "../src/approvals/broker.ts";
import { autoAccept, modeRefusals } from "../src/engine/modes.ts";
import { approvePlan, createRun, storePlan } from "../src/engine/run.ts";
import { moveTask } from "../src/engine/task.ts";
import { openStore } from "../src/store/db.ts";
import { commitWork, createWorktree } from "../src/worktrees.ts";
import { initRepo, write } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, tallShot } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Refused commands on the task screen (#198), with no model turn. Before Botbench starts, the task of a fully
// autonomous run is given its builder's requests through Botbench's real permission broker, as the CLI's hook would put
// requests it never reported (so they cannot be tied to a checked call): six here-documents of a python script, each
// thousands of characters, and one short command, all refused without asking. The task is put at Ready for review with
// the reason the mode itself gives (`autoAccept`). Then the real Botbench process shows it: the one-line status counts
// the refusals, and Refused without asking lists each by its first line, the rest of it one tap away.

const SCRIPT = Array.from({ length: 120 }, (_, i) => `print("line ${i} of a script the agent wanted to run, long enough to fill a phone's screen several times over")`).join("\n");
const HEREDOCS = Array.from({ length: 6 }, (_, i) => `sudo python3 - <<'EOF'\n# attempt ${i + 1}\n${SCRIPT}\nEOF`);
const SHORT = "sudo ls /var/root";

const test = base.extend<{ dir: string; seeded: { home: string; taskId: number }; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-refused-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  seeded: async ({ dir }, use) => {
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const base = initRepo(repo);
    const db = openStore(home);
    const run = createRun(db, { repo, prompt: "Add a greeting file", baseCommit: base, mode: "full", reviewer: null });
    const plan = storePlan(db, run.id, [{ title: "Add a greeting file", criteria: ["hello.txt holds the word hi"] }]);
    const task = approvePlan(db, run.id, plan.planVersion, null, "mode").tasks[0]!;
    const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${task.id}` });
    // The builder's attempt, as a driver records one when it starts.
    const at = new Date().toISOString();
    const attemptId = Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', NULL, NULL, 'ended', NULL, ?, ?)").run(at, at).lastInsertRowid);
    moveTask(db, task.id, "building", { worktree, attemptId });
    const broker = createBroker({ db, home, onChange: () => {} });
    for (const [i, command] of [...HEREDOCS, SHORT].entries()) {
      const answer = await broker.request({ taskId: task.id, attemptId, role: "implementer", tool: "Bash", command, input: { command }, reason: null, toolCallId: `toolu_unreported_${i}` });
      if (answer.decision !== "decline" || answer.refused == null) throw new Error(`Botbench did not refuse ${command.slice(0, 40)}`);
    }
    await broker.close();
    write(worktree.path, "hello.txt", "hi\n");
    const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
    if (!committed.committed) throw new Error("nothing was committed");
    const verdict = autoAccept({ checks: "passed", review: "none", refusals: modeRefusals(db, task.id) });
    if (verdict.accept) throw new Error("the mode accepted a task whose builder was refused sudo");
    moveTask(db, task.id, "awaiting_decision", { headCommit: committed.commit, checks: "passed", reason: verdict.why });
    db.close();
    await use({ home, taskId: task.id });
  },
  botbench: async ({ seeded }, use) => {
    const botbench = await startBotbench({ home: seeded.home });
    await use(botbench);
    await botbench.stop();
  },
});

/** Whether the page itself scrolls sideways at this width. */
const pageScrollsSideways = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth);

test("seven refused commands, six of them here-documents of thousands of characters: the status stays one short line that counts them, and the list shows each by its first line with the rest one tap away, at 390 and 1280, light and dark", async ({ page, botbench, seeded }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/tasks/${seeded.taskId}`);
  const status = page.getByTestId("task-status");
  const said = "Ready for review. Botbench committed the work to the task's branch. Accept it to keep the branch, or reject it. It needs your review: 7 commands refused during this task. Each is listed under Refused without asking.";
  await expect(status).toHaveText(said);

  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const where = `at ${size.width}, ${colorScheme}`;
      await page.setViewportSize(size);
      // The appearance is the owner's choice in Settings, kept in the browser (web/src/app/appearance.ts).
      await page.evaluate((mode) => window.localStorage.setItem("botbench.appearance", mode), colorScheme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(status).toContainText("7 commands refused");
      // The same short status, none of a script's text in it, and as tall as its own words make it: a few lines on a
      // phone, three at most on a desktop beside the list of chats and work.
      await expect(status).toHaveText(said);
      const lineHeight = await status.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
      expect((await status.boundingBox())!.height, `the status ${where}`).toBeLessThanOrEqual(lineHeight * (size.width < 600 ? 6 : 3) + 1);

      const list = page.getByTestId("refused");
      await expect(list.getByRole("heading", { name: "Refused without asking" })).toBeVisible();
      await expect(list).toContainText("Botbench refused these 7 requests during this task without asking you. Each shows its first line; open one to see all of it.");
      const rows = list.getByTestId("refused-command");
      await expect(rows).toHaveCount(7);
      // A here-document is its first line, folded, with how many lines it has; the short command is shown whole.
      for (let i = 0; i < 6; i++) {
        await expect(rows.nth(i).locator("summary")).toHaveText(`sudo python3 - <<'EOF'${HEREDOCS[i]!.split("\n").length} lines`);
        await expect(rows.nth(i).getByTestId("refused-full")).toBeHidden();
      }
      await expect(rows.nth(6)).toHaveText(SHORT);
      expect(await pageScrollsSideways(page), `the page scrolls sideways ${where}`).toBe(false);
      await checkDesign(page, `refused commands ${where}`);
      if (SHOTS) await list.screenshot({ path: path.join(SHOTS, `refused-list-${size.width}-${colorScheme}.png`) });

      // Opened, the whole of it is there, and it scrolls inside itself, never the page.
      await rows.nth(2).locator("summary").click();
      const full = rows.nth(2).getByTestId("refused-full");
      await expect(full).toBeVisible();
      expect(await full.textContent()).toBe(HEREDOCS[2]);
      expect(await pageScrollsSideways(page), `the page scrolls sideways with a command open ${where}`).toBe(false);
      await checkDesign(page, `a refused command opened ${where}`);
      if (SHOTS) await tallShot(page, path.join(SHOTS, `refused-${size.width}-${colorScheme}.png`));
      await rows.nth(2).locator("summary").click();
      await expect(full).toBeHidden();
    }
  }
});
