import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { startBotbench, type Botbench } from "./botbench.ts";
import { checkDesign, expect, signIn, startTaskIn } from "./helpers.ts";

// A note to a building task, in the real client at a phone's size, against a real Botbench process whose Claude Code
// replays turns recorded from real sessions (e2e/serve-replayed-build.ts, the owner's approved exception). No model
// turn: the builder's first turn is held until the test lets it go on, so the task is building while the box is used.

const test = base.extend<{ botbench: Botbench }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-build.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

const PROMPT = "Add a greeting file";
const FIRST = "Use British spelling.";
const SECOND = "Also say hello in the README, and keep it to one line.";
const LATE = "One more thing.";

test("on a building task the note box sends a note that waits, a second replaces it, and once the task is no longer building a note is refused; the delivered one is in the transcript as yours", async ({ page, botbench }) => {
  test.setTimeout(120_000);
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await startTaskIn(page, repo, PROMPT);
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);

  // Building: the box is empty and can be sent.
  const box = page.getByTestId("task-note");
  await expect(box.getByRole("heading", { name: "Note for Claude Code" })).toBeVisible();
  await expect(box.getByTestId("note-about")).toHaveText("Claude Code reads your note as your next message once it finishes what it is doing now, before Botbench commits and checks the work. One note waits at a time: a second note replaces the first until it is delivered.");
  const field = box.getByLabel("Your note", { exact: true });
  const sendButton = box.getByRole("button", { name: "Send note" });
  await expect(field).toHaveValue("");
  await expect(sendButton).toBeEnabled();
  await expect(box.getByTestId("note-waiting")).toHaveCount(0);
  await checkDesign(page, "task, building, with the note box");

  // A note waits for the turn to end.
  await field.fill(FIRST);
  await sendButton.click();
  await expect(box.getByTestId("note-waiting")).toHaveText("Your note is waiting. Claude Code gets it when it finishes what it is doing now.");
  await expect(box.getByTestId("note-text")).toHaveText(FIRST);
  await expect(field).toHaveValue("");
  await expect(box.getByTestId("note-replaced")).toHaveCount(0);

  // A second note replaces it.
  await field.fill(SECOND);
  await sendButton.click();
  await expect(box.getByTestId("note-replaced")).toHaveText("Your new note replaced the one that was waiting.");
  await expect(box.getByTestId("note-text")).toHaveText(SECOND);
  await checkDesign(page, "task, building, a note waiting that replaced another");
  // Not in the transcript while it waits.
  await expect(page.getByRole("log", { name: "Activity" }).getByText(SECOND)).toHaveCount(0);

  // The screen stops hearing about changes, as a phone that lost its connection would, and the builder goes on: the
  // note is delivered as its next message, the task's work is committed, and the task is no longer building.
  await page.route("**/api/stream**", (route) => route.abort());
  await page.reload();
  await expect(box.getByTestId("note-text")).toHaveText(SECOND);
  fs.writeFileSync(path.join(path.dirname(botbench.home), "release-builder"), "");
  await expect.poll(async () => ((await (await page.request.get(`${botbench.base}/api/tasks/1`)).json()) as { status: string }).status, { timeout: 30_000 }).toBe("failed");

  // A note sent now is refused, and the screen says why.
  await field.fill(LATE);
  await sendButton.click();
  await expect(page.getByTestId("note-refused")).toHaveText("The note was not sent. This task failed, so a note can no longer reach Claude Code.");
  // The screen reads the task again: the box goes, and the refusal stays.
  await expect(box.getByRole("button", { name: "Send note" })).toHaveCount(0);
  await expect(page.getByTestId("note-refused")).toBeVisible();
  await checkDesign(page, "task, a note refused once it was no longer building");

  // Back online: no box on a task that is not building, and the delivered note is the owner's message in the transcript.
  await page.unroute("**/api/stream**");
  await page.reload();
  await expect(page.getByTestId("task-status")).toHaveText(/^Failed\./);
  await expect(page.getByTestId("task-note")).toHaveCount(0);
  const log = page.getByRole("log", { name: "Activity" });
  const prompts = log.getByTestId("prompt");
  await expect(prompts).toHaveCount(2);
  await expect(prompts.nth(1)).toContainText("You");
  await expect(prompts.nth(1)).toContainText(SECOND);
  await expect(log.getByText(FIRST)).toHaveCount(0);
  await expect(log.getByText(LATE)).toHaveCount(0);
  await checkDesign(page, "task, failed, with the delivered note in the transcript");
});
