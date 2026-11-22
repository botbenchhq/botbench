import path from "node:path";
import { checkoutState, initRepo } from "../test/support/repo.ts";
import fs from "node:fs";
import { checkDesign, expect, SHOTS, signIn, test, watchRequests } from "./helpers.ts";
import { startSmelt } from "./smelt.ts";

// Choosing the model in the real client, at a phone's size, against a real Smelt process and the owner's Claude Code.
// The models named here are the cheapest the CLI lists. The Smelt these tests start is configured with "haiku".

const CONFIGURED = "haiku";
const CHEAP = "claude-haiku-4-5-20251001";
const UNKNOWN = "smelt-no-such-model-1";

test("LIVE: on the Turn screen the model is picked from the CLI's own list, a name the CLI does not know is reported in its words, the transcript names the model that answered, and the choice survives a reload", async ({ page, smelt }) => {
  const foreign = watchRequests(page, smelt);
  const turnsSent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/turns")) turnsSent.push(request.postData() ?? "");
  });
  await signIn(page, smelt);

  // The picker: the configured model is preselected, and the list is the one Claude Code reports.
  const picker = page.getByLabel("Model", { exact: true });
  await expect(picker).toHaveValue(CONFIGURED);
  await expect(page.getByTestId("model-source")).toHaveText("The list is what Claude Code reports on this Mac.");
  const options = await picker.locator("option").evaluateAll((all) => all.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? "" })));
  expect(options[0]!.value).toBe("");
  expect(options[0]!.text).toMatch(/^CLI default/);
  expect(options.at(-1)!.text).toBe("Other…");
  expect(options.map((o) => o.value)).toEqual(expect.arrayContaining([CONFIGURED, CHEAP, "sonnet"]));
  await expect(page.getByLabel("Model name")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(1);

  // "Other…" reveals a field for a name the list does not hold. A value that is no model name is not sent at all.
  await picker.selectOption({ label: "Other…" });
  const other = page.getByLabel("Model name");
  await expect(other).toBeVisible();
  await page.getByLabel("Prompt").fill("Reply with exactly the word: lynx");
  await other.fill("--dangerously-skip-permissions");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert")).toContainText("The prompt was not sent. A model name starts with a letter or a digit");
  await other.fill("");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert")).toContainText("The prompt was not sent. Enter a model name, or pick one from the list.");
  expect(turnsSent).toEqual([]);
  await expect(page.locator("[data-event]")).toHaveCount(0);
  await checkDesign(page, "turn, another model being named");

  // A name the CLI does not know goes to the CLI, and what the CLI says about it is shown in words.
  await other.fill(UNKNOWN);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="turn_ended"]')).toContainText(`Turn ended with an error: api_error: There's an issue with the selected model (${UNKNOWN}).`, { timeout: 60_000 });
  await expect(page.locator('[data-event="error"]')).toContainText("It may not exist or you may not have access to it.");
  await expect(page.locator('[data-event="text"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(JSON.parse(turnsSent[0]!)).toMatchObject({ model: UNKNOWN });
  // The session names the model it was started on; the screen does not claim that it answered.
  await expect(page.getByTestId("turn-model")).toHaveText(`Model: ${UNKNOWN} (session started, no completed turn)`);

  // Pick a cheap model from the list and send the prompt again: the conversation goes on, on that model.
  await picker.selectOption(CHEAP);
  await expect(page.getByLabel("Model name")).toHaveCount(0);
  await page.getByLabel("Prompt").fill("Reply with exactly the word: lynx");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-event="text"]').last()).toContainText(/lynx/i, { timeout: 120_000 });
  await expect(page.locator('[data-event="turn_ended"]').last()).toContainText("Turn completed.");
  await expect(page.locator('[data-event="session_started"]').last()).toHaveText(`Sessionstarted on ${CHEAP}`);
  await expect(page.getByTestId("turn-model")).toHaveText(`Model: ${CHEAP}`);
  expect(JSON.parse(turnsSent[1]!)).toMatchObject({ model: CHEAP });
  await expect(page.getByRole("button")).toHaveCount(1);
  await checkDesign(page, "turn, with the model that answered");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u25-turn-model.png") });

  // The choice is remembered by this browser: after a reload, and on the New task screen as well.
  await page.reload();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(CHEAP);
  await expect(page.getByTestId("turn-model")).toHaveText(`Model: ${CHEAP}`);
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "New task" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(CHEAP);

  // The CLI's own default can be chosen too, and is remembered the same way.
  await page.getByLabel("Model", { exact: true }).selectOption("");
  await page.reload();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
  expect(foreign, "requests to anything but Smelt").toEqual([]);
});

test("LIVE: on New task a model is picked, and the task screen names the model that was asked for and the one that answered", async ({ page, smelt }) => {
  const repo = path.join(path.dirname(smelt.home), "sample-repo");
  initRepo(repo);
  const before = checkoutState(repo);
  await signIn(page, smelt);
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "New task" }).click();

  const picker = page.getByLabel("Model", { exact: true });
  await expect(picker).toHaveValue(CONFIGURED);
  await expect(page.getByTestId("model-source")).toHaveText("The list is what Claude Code reports on this Mac.");
  await picker.selectOption(CHEAP);
  await page.getByLabel("Repository path").fill(repo);
  await expect(page.getByTestId("repo-state")).toHaveText("Usable git repository.");
  await page.getByLabel("Prompt").fill("Create a file named hello.txt containing exactly: hi");
  await expect(page.getByRole("button")).toHaveCount(1);
  await checkDesign(page, "new task, with a model picked");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u25-new-task-model.png"), fullPage: true });
  await page.getByRole("button", { name: "Start task" }).click();

  // Before anything has answered, the screen says what was asked for and no more.
  await expect(page.getByRole("heading", { name: /^Task \d+$/ })).toBeVisible();
  await expect(page.getByTestId("task-model")).toHaveText(new RegExp(`^Model: (no session yet|${CHEAP} \\(session started, no completed turn\\))\\. Requested: ${CHEAP}\\.$`));

  // This test is about the model, so any command the agent wants to run is declined, as an owner could.
  await expect(async () => {
    const pending = (await (await page.request.get(`${smelt.base}/api/approvals?status=pending`)).json()) as { approvals: { id: number }[] };
    for (const approval of pending.approvals) {
      await page.request.post(`${smelt.base}/api/approvals/${approval.id}`, { data: { decision: "decline", note: "Not needed for this task; just create the file." } });
    }
    await expect(page.getByTestId("task-status")).toHaveText(/^Built\./, { timeout: 2_000 });
  }).toPass({ timeout: 180_000, intervals: [1_000] });

  await expect(page.getByTestId("task-model")).toHaveText(`Model: ${CHEAP}. Requested: ${CHEAP}.`);
  await expect(page.locator('[data-event="session_started"]')).toHaveText(`Sessionstarted on ${CHEAP}`);
  const taskId = Number(/#\/tasks\/(\d+)$/.exec(page.url())![1]);
  expect(((await (await page.request.get(`${smelt.base}/api/tasks/${taskId}`)).json()) as { requestedModel: string | null }).requestedModel).toBe(CHEAP);
  await checkDesign(page, "task, with its model");
  expect(checkoutState(repo), "the owner's checkout is as it was").toEqual(before);
});

test("where Claude Code reports no list, the picker offers the configured models and says the list comes from configuration", async ({ page }) => {
  // A real machine state: no `claude` in any PATH folder, so the CLI cannot be asked and nothing of it runs.
  const withoutClaude = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "" && !fs.existsSync(path.join(dir, "claude"))).join(path.delimiter);
  const smelt = await startSmelt({ env: { PATH: withoutClaude }, settings: { drivers: { "claude-code": { model: "sonnet", models: ["opus", "sonnet"] } } } });
  try {
    await page.goto(smelt.base);
    await page.getByLabel("Login token").fill(smelt.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("driver-state")).toHaveText("Claude Code: not installed");
    await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "New task" }).click();
    const picker = page.getByLabel("Model", { exact: true });
    await expect(picker).toHaveValue("sonnet");
    await expect(page.getByTestId("model-source")).toHaveText("The list comes from Smelt's configuration: Claude Code reported none.");
    expect(await picker.locator("option").allTextContents()).toEqual(["CLI default", "opus", "sonnet", "Other…"]);
    await checkDesign(page, "new task, models from configuration");
  } finally {
    expect((await smelt.stop()).leftover).toEqual([]);
    fs.rmSync(path.dirname(smelt.home), { recursive: true, force: true });
  }
});
