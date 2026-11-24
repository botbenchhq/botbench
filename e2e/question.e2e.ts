import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { initRepo } from "../test/support/repo.ts";
import { loadQuestionRecording, NO_QUESTION_RECORDING } from "../test/support/replay-question.ts";
import { startBotbench, type Botbench } from "./botbench.ts";
import { checkDesign, expect, openWork, signIn, startTaskIn, workRows, workState } from "./helpers.ts";

// Claude Code's question to the owner, in the real client at a phone's size, against a real Botbench process whose Claude
// Code replays the real session in which it asked one (e2e/serve-replayed-question.ts, the owner's approved exception).
// No model turn. Skipped, saying why, until the owner has made the recording with test/support/capture-question.ts.

const test = base.extend<{ botbench: Botbench }>({
  botbench: async ({}, use) => {
    const botbench = await startBotbench({ entry: path.resolve(import.meta.dirname, "serve-replayed-question.ts") });
    await use(botbench);
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  },
});

// At file level, so that no Botbench is started for it: its replayed Claude Code needs the recording.
test.skip(NO_QUESTION_RECORDING !== false, NO_QUESTION_RECORDING || "");

test("a builder's question shows as a card titled 'Claude Code has a question' with its question, a button per choice and Something else with a field; answering it takes the card away and the task no longer needs input", async ({ page, botbench }) => {
  test.setTimeout(120_000);
  const recording = loadQuestionRecording();
  const asked = (recording.finding.input as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!;
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await startTaskIn(page, repo, "Greet me");
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);

  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(card.getByRole("heading", { name: "Claude Code has a question" })).toBeVisible();
  // The question and its choices are the agent's own words, as plain text, and the card says so in Botbench's.
  await expect(card.getByTestId("question-whose")).toHaveText("The question and its choices are Claude Code's own words. Your answer goes back to it as text, and allows nothing to run.");
  await expect(card.getByTestId("question-text")).toHaveText(asked.question);
  const choices = card.getByTestId("question-choice");
  await expect(choices).toHaveCount(asked.options.length);
  expect(asked.options.length).toBeGreaterThanOrEqual(2);
  expect(asked.options.length).toBeLessThanOrEqual(4);
  for (const [i, option] of asked.options.entries()) await expect(choices.nth(i)).toHaveText(`${String.fromCharCode(65 + i)}. ${option.label}`);
  await expect(card.locator("a, strong, em, code, b, i")).toHaveCount(0);
  await expect(card.getByLabel("Your answer", { exact: true })).toHaveCount(0);
  await checkDesign(page, "task, a question waiting");

  // Something else opens a field and its send button.
  await card.getByRole("button", { name: "Something else" }).click();
  const field = card.getByLabel("Your answer", { exact: true });
  await expect(field).toBeFocused();
  const send = card.getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await field.fill("Neither: say good morning");
  await expect(send).toBeEnabled();
  await checkDesign(page, "task, a question with the field for your own answer");

  // On Work, the task waits on you.
  await openWork(page);
  await expect(workState(workRows(page, "Task 1 · "))).toHaveText("Needs input");
  await page.goBack();

  // Answered with a choice: the card goes, and the task no longer needs input.
  // The choice the recording was answered with: the replay goes on only after exactly that answer.
  const chosen = asked.options.findIndex((option) => option.label === recording.answer);
  expect(chosen, "the recorded answer is one of the choices").toBeGreaterThanOrEqual(0);
  await page.getByTestId("question-choice").nth(chosen).click();
  await expect(page.getByTestId("question-card")).toHaveCount(0);
  await expect(page.getByRole("log", { name: "Activity" }).getByText(`Your answer: ${recording.answer}`)).toBeVisible({ timeout: 30_000 });
  await openWork(page);
  await expect(workState(workRows(page, "Task 1 · "))).not.toHaveText("Needs input", { timeout: 30_000 });
});
