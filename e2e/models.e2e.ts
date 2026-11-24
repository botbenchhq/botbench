import path from "node:path";
import { checkoutState, initRepo } from "../test/support/repo.ts";
import fs from "node:fs";
import { checkDesign, chooseRepository, closeContext, contextSheet, expect, messageBox, openComposer, openNewTask, openRow, primaries, SHOTS, signIn, test, watchRequests } from "./helpers.ts";
import type { Page } from "@playwright/test";
import { startBotbench } from "./botbench.ts";

// Choosing the model in the real client, at a phone's size, against a real Botbench process and the owner's Claude Code.
// The models named here are the cheapest the CLI lists. The Botbench these tests start is configured with "haiku".

const CONFIGURED = "haiku";
const CHEAP = "claude-haiku-4-5-20251001";
// The name Claude Code itself reports for that id. Botbench shows the name and keeps the id one tap away.
const NAME = "Haiku [\\d.]+";
// As long as a model name may be, and unbroken: the screen must wrap it wherever it shows it.
const UNKNOWN = `botbench-no-such-model-${"1".repeat(77)}`;

/** The model chip under the box, which opens Add context on the model's view. */
const chip = (page: Page) => page.getByTestId("agent-chip");
async function openModels(page: Page) {
  // While a repository is still to be chosen, the chip asks for it, and the model is a row of the sheet.
  if ((await chip(page).count()) > 0) await chip(page).click();
  else await openRow(page, "Model");
  const sheet = contextSheet(page);
  await expect(sheet.getByRole("heading", { name: "Model" })).toBeVisible();
  return sheet;
}
const chosenModel = (page: Page) => contextSheet(page).locator('input[name="model"]:checked');
async function pickModel(page: Page, value: string) {
  const sheet = await openModels(page);
  // A model after the first four is behind More models….
  const more = sheet.getByTestId("model-options").getByTestId("more-models");
  if ((await more.locator(`input[value="${value}"]`).count()) > 0 && !(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator("summary").click();
  await sheet.locator(`input[name="model"][value="${value}"]`).check();
  await closeContext(page);
}

test("in the composer the model is picked from the CLI's own list, a name that is no model name is not sent, and a long name does not widen the page", async ({ page, botbench }) => {
  const turnsSent: string[] = [];
  page.on("request", (request) => {
    // A chat message goes to the agents asked; with Claude Code alone, its one entry carries the model.
    if (request.method() === "POST" && request.url().endsWith("/api/chat")) turnsSent.push(JSON.stringify((JSON.parse(request.postData() ?? "{}") as { agents: unknown[] }).agents[0]));
  });
  await signIn(page, botbench);

  // The model chip under the box opens the model's view: the configured model is chosen, and the list is the one Claude Code reports.
  const sheet = await openModels(page);
  await expect(chosenModel(page)).toHaveValue(CONFIGURED);
  await expect(page.getByTestId("model-source")).toHaveText("The list is what Claude Code reports on this Mac.");
  const options = await sheet.locator('input[name="model"]').evaluateAll((all) => all.map((o) => ({ value: (o as HTMLInputElement).value, text: (o as HTMLInputElement).labels![0]!.textContent ?? "" })));
  // The CLI's own default first, named by the model it is, with a default tag.
  expect(options[0]!.value).toBe("");
  expect(options[0]!.text).toMatch(/ default$/);
  expect(options.at(-1)!.text).toBe("Other…");
  expect(options.map((o) => o.value)).toEqual(expect.arrayContaining([CONFIGURED, CHEAP, "sonnet"]));
  await expect(page.getByLabel("Model name")).toBeHidden();
  await checkDesign(page, "add context, model");

  // "Other…" reveals a field for a name the list does not hold. A value that is no model name is not sent at all.
  await sheet.getByRole("radio", { name: "Other…" }).check();
  const other = page.getByLabel("Model name");
  await expect(other).toBeVisible();
  await other.fill("--dangerously-skip-permissions");
  await closeContext(page);
  await messageBox(page).fill("Reply with exactly the word: lynx");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await expect(send).toHaveAccessibleDescription(/^Model: A model name starts with a letter or a digit/);
  await openModels(page);
  await other.fill("");
  await closeContext(page);
  await expect(send).toHaveAccessibleDescription("Model: Enter a model name, or pick one from the list.");
  expect(turnsSent).toEqual([]);
  await expect(page.locator("[data-event]")).toHaveCount(0);
  await checkDesign(page, "composer, another model being named");
  // A name as long as a model name may be, unbroken, is cut to the box in the chip, not drawn past the page.
  await openModels(page);
  await other.fill(UNKNOWN);
  await closeContext(page);

  await expect(chip(page)).toHaveAccessibleName(new RegExp(`^Agent and model: ${UNKNOWN} Claude Code$`));
  // The design system keeps a long value inside the chip (0.8.2): the page does not scroll sideways at 390px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "the page does not scroll sideways").toBe(0);
  await checkDesign(page, "composer, a model name of 100 characters being named");
  expect(turnsSent).toEqual([]);
});

test("LIVE: in the composer a name the CLI does not know is reported in its words, the transcript names the model that answered, and the choice survives a reload", async ({ page, botbench }) => {
  const foreign = watchRequests(page, botbench);
  const turnsSent: string[] = [];
  page.on("request", (request) => {
    // A chat message goes to the agents asked; with Claude Code alone, its one entry carries the model.
    if (request.method() === "POST" && request.url().endsWith("/api/chat")) turnsSent.push(JSON.stringify((JSON.parse(request.postData() ?? "{}") as { agents: unknown[] }).agents[0]));
  });
  await signIn(page, botbench);
  const sheet = await openModels(page);
  await expect(chosenModel(page)).toHaveValue(CONFIGURED);

  // A name the CLI does not know goes to the CLI, and what the CLI says about it is shown in words.
  await sheet.getByRole("radio", { name: "Other…" }).check();
  await page.getByLabel("Model name").fill(UNKNOWN);
  await closeContext(page);
  await messageBox(page).fill("Reply with exactly the word: lynx");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="turn_ended"]')).toContainText(`Ended with an error: api_error: There's an issue with the selected model (${UNKNOWN}).`, { timeout: 60_000 });
  await expect(page.locator('[data-event="error"]')).toContainText("It may not exist or you may not have access to it.");
  await expect(page.locator('[data-event="text"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(JSON.parse(turnsSent[0]!)).toMatchObject({ model: UNKNOWN });
  // The session echoes the model asked for, so the transcript adds no row for it.
  await expect(page.locator('[data-event="session_started"]')).toHaveCount(0);
  await checkDesign(page, "chat, a model name of 100 characters");

  // Pick a cheap model from the list and send the prompt again: the conversation goes on, on that model.
  await pickModel(page, CHEAP);
  await messageBox(page).fill("Reply with exactly the word: lynx");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="text"]').last()).toContainText(/lynx/i, { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  // A reply with no step of its own has no row after it.
  await expect(page.getByText(/^Worked for/)).toHaveCount(0);
  // The model that answered is the one asked for: it is named in the chip only, and the transcript has no row for it.
  await expect(page.locator('[data-event="session_started"]')).toHaveCount(0);
  await expect(chip(page)).toHaveAccessibleName(new RegExp(`^Agent and model: ${NAME} Claude Code$`));
  expect(JSON.parse(turnsSent[1]!)).toMatchObject({ model: CHEAP });
  // Send is the one primary action; New chat, which begins again, is a quiet icon in the header.
  expect(await primaries(page)).toEqual(["Send"]);
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  await checkDesign(page, "chat, with the model that answered");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u25-turn-model.png") });

  // The choice is remembered by this browser: after a reload, and for a new task as well.
  await page.reload();
  await openModels(page);
  await expect(chosenModel(page)).toHaveValue(CHEAP);
  await closeContext(page);
  await openNewTask(page);
  await openModels(page);
  await expect(chosenModel(page)).toHaveValue(CHEAP);

  // The CLI's own default can be chosen too, and is remembered the same way.
  await contextSheet(page).locator('input[name="model"][value=""]').check();
  await page.reload();
  await openModels(page);
  await expect(chosenModel(page)).toHaveValue("");
  expect(foreign, "requests to anything but Botbench").toEqual([]);
});

test("LIVE: for a task a model is picked and sent, and the task screen names a model only when the one that answered is not the one asked for", async ({ page, botbench }) => {
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo);
  const before = checkoutState(repo);
  await signIn(page, botbench);
  await openComposer(page);
  await openModels(page);
  await expect(chosenModel(page)).toHaveValue(CONFIGURED);
  await expect(page.getByTestId("model-source")).toHaveText("The list is what Claude Code reports on this Mac.");
  await closeContext(page);
  await pickModel(page, CHEAP);
  await chooseRepository(page, repo);
  await closeContext(page);
  await messageBox(page).fill("Create a file named hello.txt containing exactly: hi");
  // Send is drawn as the primary only while it is enabled, and it waits on the composer's own checks; primaries() reads
  // the page once, so it is read after Send is enabled. If Send stays disabled, the composer's reason is on the page.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(await primaries(page)).toEqual(["Send"]);
  await checkDesign(page, "composer, a task with a model picked");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u25-new-task-model.png"), fullPage: true });
  await page.getByRole("button", { name: "Send" }).click();
  // Before anything has answered, nothing is claimed about the model.
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  await expect(page.getByTestId("task-model")).toHaveCount(0);

  // This test is about the model, so any command the agent wants to run is declined, as an owner could.
  await expect(async () => {
    const pending = (await (await page.request.get(`${botbench.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] };
    for (const approval of pending.approvals) {
      await page.request.post(`${botbench.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Not needed for this task; just create the file." } });
    }
    await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 2_000 });
  }).toPass({ timeout: 180_000, intervals: [1_000] });

  // The model that answered is the one asked for: the screen has no model line, and the transcript no row for it.
  await expect(page.getByTestId("task-model")).toHaveCount(0);
  await expect(page.locator('[data-event="session_started"]')).toHaveCount(0);
  const taskId = Number(/#\/tasks\/(\d+)$/.exec(page.url())![1]);
  expect(((await (await page.request.get(`${botbench.base}/api/tasks/${taskId}`)).json()) as { requestedModel: string | null }).requestedModel).toBe(CHEAP);
  await checkDesign(page, "task, with its model");
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("where Claude Code reports no list, the picker offers the configured models and says the list comes from configuration", async ({ page }) => {
  // A real machine state: no `claude` in any PATH folder, so the CLI cannot be asked and nothing of it runs.
  const withoutClaude = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "" && !fs.existsSync(path.join(dir, "claude"))).join(path.delimiter);
  const botbench = await startBotbench({ env: { PATH: withoutClaude }, settings: { drivers: { "claude-code": { model: "sonnet", models: ["opus", "sonnet"] } } } });
  try {
    await page.goto(`${botbench.base}/#/turn`);
    await page.getByLabel("Login token").fill(botbench.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: not installed");
    await openNewTask(page);
    const sheet = await openModels(page);
    await expect(chosenModel(page)).toHaveValue("sonnet");
    await expect(page.getByTestId("model-source")).toHaveText("The list comes from Botbench's configuration: Claude Code reported none.");
    expect(await sheet.getByTestId("model-options").locator(".ds-radio__label").allTextContents()).toEqual(["Claude Code's default", "opus", "sonnet", "Other…"]);
    await checkDesign(page, "add context, models from configuration");
  } finally {
    const { leftover } = await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
    expect(leftover).toEqual([]);
  }
});
