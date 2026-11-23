import fs from "node:fs";
import path from "node:path";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, choose, closeContext, contextSheet, expect, messageBox, openContext, openRow, openWork, primaries, SHOTS, signIn, test, tempShot } from "./helpers.ts";
import { startBotbench, tempDir } from "./botbench.ts";

// The composer on the home screen, at a phone's size, with no model turn: a real Botbench process, real temporary
// repositories it knows of from its settings file, and the built client in Chrome.

/** The context list's rows as they read: the setting, then its value. */
const rows = (page: import("@playwright/test").Page) =>
  contextSheet(page)
    .locator(".ds-context-list__button")
    .evaluateAll((buttons) => buttons.map((b) => `${b.querySelector(".ds-context-list__label")!.textContent} ${b.querySelector(".ds-context-list__value")!.textContent}`));

async function withKnownRepository(run: (botbench: Awaited<ReturnType<typeof startBotbench>>, repo: string) => Promise<void>): Promise<void> {
  const dir = fs.realpathSync(tempDir("botbench-e2e-composer-"));
  const repo = path.join(dir, "code", "clients", "northwind-logistics", "services", "shipment-tracking-api");
  initRepo(repo);
  const botbench = await startBotbench({ home: path.join(dir, "home"), settings: { drivers: { "claude-code": { model: "haiku" } }, repositories: { [repo]: { preapproved: ["npm test"] } } } });
  try {
    await run(botbench, repo);
  } finally {
    expect((await botbench.stop()).leftover).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the composer is one box with no label above it; Add context's rows follow what is chosen, each row changes its setting, and the choices are remembered after a reload", async ({ page }) => {
  await withKnownRepository(async (botbench, repo) => {
    await signIn(page, botbench);
    const box = messageBox(page);
    // No visible label: the box is named for assistive technology, and its placeholder says the same.
    await expect(box).toHaveAttribute("aria-label", "Message Claude Code");
    await expect(box).toHaveAttribute("placeholder", "Message Claude Code");
    await expect(page.locator("form.ds-composer label")).toHaveCount(0);
    // One row under the text: Add context, the one model chip, and Send (Dictate only where the Mac can transcribe).
    const bar = page.locator(".ds-composer__bar");
    await expect(bar.locator("> *").first()).toHaveAccessibleName("Add context");
    await expect(bar.locator(".ds-composer__chip")).toHaveCount(1);
    await expect(bar.locator(".ds-composer__chip")).toHaveAccessibleName(/^Agent and model: .+ Claude Code$/);
    await expect(bar.locator(".ds-composer__chip")).not.toContainText("Reading the models");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await checkDesign(page, "composer, empty");
    expect(await primaries(page)).toEqual(["Send"]);
    await tempShot(page, "composer-empty");

    // A chat: the repository, one for it to read, and the model, nothing else.
    const sheet = await openContext(page);
    expect(await rows(page)).toEqual(["Repository None (just chat)", "Read a repository None", expect.stringMatching(/^Model .+/)]);
    await checkDesign(page, "add context, a chat");
    await tempShot(page, "sheet-open");

    // The repositories Botbench knows of, each by its short name with its path, None first and Another folder last.
    await openRow(page, "Repository");
    await expect(sheet.getByRole("heading", { name: "Repository" })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "None (just chat)" })).toBeFocused();
    await expect(sheet.getByRole("radio")).toHaveCount(3);
    await expect(sheet.getByRole("radio", { name: "shipment-tracking-api" })).toHaveAccessibleDescription(repo);
    await checkDesign(page, "add context, repository");
    await tempShot(page, "sheet-repository");
    // A tapped option goes back to the rows at once, with the focus on the row that was pressed.
    await sheet.getByRole("radio", { name: "shipment-tracking-api" }).click();
    await expect(sheet.getByRole("heading", { name: "Add context" })).toBeVisible();
    await expect(sheet.locator('[data-row="repository"]')).toBeFocused();
    // Codex is offered as the builder only where the installed Codex can build (the server's check of the agents): the
    // Builder row follows what to do then.
    const codexBuilds = await page.evaluate(async () => ((await (await fetch("/api/agents")).json()) as { agents: { agent: string; roles: string[] }[] }).agents.some((a) => a.agent === "codex" && a.roles.includes("builder")));
    const builderRow = codexBuilds ? ["Builder Claude Code"] : [];
    // A task in a repository: what to do, its mode (always Manual for a task on its own), its commands and the model.
    await expect.poll(() => rows(page)).toEqual(["Repository shipment-tracking-api", "What to do One task", ...builderRow, "Mode Manual", "Allowed commands 1 command", expect.stringMatching(/^Model .+/)]);
    if (codexBuilds) {
      // Codex can be chosen to build; the sentence under the box names who builds, and Claude Code is the choice again after.
      await choose(page, "Builder", "Codex");
      await expect.poll(() => rows(page)).toContain("Builder Codex");
      await closeContext(page);
      await expect(page.getByTestId("composer-about")).toContainText("Codex works on a new branch");
      await tempShot(page, "composer-builder-codex");
      await openContext(page);
      await choose(page, "Builder", "Claude Code");
      await expect.poll(() => rows(page)).toContain("Builder Claude Code");
    }

    // A task on its own cannot take another mode, and says so.
    await openRow(page, "Mode");
    await expect(sheet.getByRole("radio", { name: "Manual" })).toBeChecked();
    await expect(sheet.getByRole("radio", { name: "Fully autonomous" })).toBeDisabled();
    await expect(sheet.getByText("A single task always runs in Manual. Plan a run to choose another mode.")).toBeVisible();
    await checkDesign(page, "add context, mode of a task");

    // A run adds its spec file, review, and what happens when a task is accepted.
    await choose(page, "What to do", "Plan a run");
    await expect.poll(() => rows(page)).toEqual(["Repository shipment-tracking-api", "What to do Plan a run", ...builderRow, "Spec file None", "Mode Manual", "Tasks Several", expect.stringMatching(/^Review /), "When accepted Keep the branch", "Allowed commands 1 command", expect.stringMatching(/^Models .+/)]);
    await openRow(page, "Mode");
    await sheet.getByRole("radio", { name: "Fully autonomous" }).check();
    await expect(sheet.getByRole("radio", { name: "Fully autonomous" })).toHaveAccessibleDescription(/^Accepts work without you /);
    await checkDesign(page, "add context, mode with its warning");
    await tempShot(page, "sheet-mode-warning");
    await sheet.getByRole("button", { name: "Back to Add context" }).click();
    await expect(sheet.locator(".ds-context-list__value--warning")).toHaveText("Fully autonomous");
    // Fully autonomous keeps the run to one task unless the owner says otherwise; the choice is offered in every mode.
    await expect.poll(() => rows(page)).toContain("Tasks One task");
    await openRow(page, "Tasks");
    await expect(sheet.getByRole("radio", { name: "Keep it to one task" })).toBeChecked();
    await checkDesign(page, "add context, how many tasks");
    await sheet.getByRole("button", { name: "Back to Add context" }).click();
    await choose(page, "When accepted", "Open a pull request");
    await openRow(page, "Allowed commands");
    await expect(sheet.getByTestId("preapproved-list").getByRole("listitem")).toHaveText([/npm test/]);
    await checkDesign(page, "add context, allowed commands");
    await openRow(page, "Models");
    await expect(sheet.getByRole("checkbox", { name: "Build the tasks with the same model" })).toBeChecked();
    await checkDesign(page, "add context, models of a run");
    await closeContext(page);
    await expect(box).toHaveAttribute("aria-label", "Describe what to plan");
    await expect(page.getByTestId("composer-about")).toContainText("Building starts on the plan without your approval.");
    // This repository has no check commands, so a fully autonomous run cannot start: Send says why before it is pressed.
    await box.fill("Plan the work");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByTestId("composer-reason")).toHaveText(/^Fully autonomous needs a check command for this repository\./);
    await box.fill("");

    // Remembered on this device: after a reload the next run is type and send.
    await page.reload();
    await expect(box).toHaveAttribute("aria-label", "Describe what to plan");
    await openContext(page);
    // Fully autonomous is not remembered: the mode is Settings' default again (Manual), as a new visit should start.
    await expect.poll(() => rows(page)).toEqual(["Repository shipment-tracking-api", "What to do Plan a run", ...builderRow, "Spec file None", "Mode Manual", "Tasks Several", expect.stringMatching(/^Review /), "When accepted Open a pull request", "Allowed commands 1 command", expect.stringMatching(/^Models .+/)]);
    // Escape closes the sheet and gives the focus back to Add context.
    await page.keyboard.press("Escape");
    await expect(contextSheet(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Add context" })).toBeFocused();
  });
});

test("New task and New run open the composer with their kind chosen and the sheet on Repository; with no repository yet the required chip asks for one and Send says why it is disabled; the old addresses lead there too", async ({ page }) => {
  await withKnownRepository(async (botbench) => {
    await signIn(page, botbench);
    const starts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /^\/api\/(tasks|runs|turns)$/.test(new URL(request.url()).pathname)) starts.push(request.url());
    });
    await openWork(page);
    await page.getByRole("link", { name: "New run" }).click();
    await expect(page).toHaveURL(/#\/turn$/);
    // The owner came to start work in a repository: the sheet opens on its view.
    const sheet = contextSheet(page);
    await expect(sheet.getByRole("heading", { name: "Repository" })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "Another folder…" })).toBeVisible();
    await closeContext(page);
    const chip = page.getByRole("button", { name: "Choose a Repository" });
    const send = page.getByRole("button", { name: "Send" });
    await expect(chip).toBeVisible();
    await expect(page.locator(".ds-composer__chip")).toHaveCount(1);
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription("Choose a repository");
    await expect(chip).toHaveAccessibleDescription("Choose a repository");
    await messageBox(page).fill("Add a changelog");
    await checkDesign(page, "composer, a repository is required");
    await tempShot(page, "composer-required");

    // The chip opens the sheet straight on the repository.
    await chip.click();
    await expect(sheet.getByRole("heading", { name: "Repository" })).toBeVisible();
    await sheet.getByRole("radio", { name: "Another folder…" }).check();
    await sheet.getByLabel("Folder path").fill("relative/path");
    await expect(sheet.getByTestId("repo-state")).toContainText("Give the full path, starting with /.");
    await expect(sheet.getByLabel("Folder path")).toHaveAttribute("aria-invalid", "true");
    await checkDesign(page, "add context, a folder that cannot be used");
    await closeContext(page);
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription(/Give the full path, starting with \//);
    // None is a choice: a chat needs no repository.
    await page.getByRole("button", { name: "Choose a Repository" }).click();
    await sheet.getByRole("radio", { name: "None (just chat)" }).click();
    await closeContext(page);
    await expect(send).toBeEnabled();
    await expect(messageBox(page)).toHaveAttribute("aria-label", "Message Claude Code");
    expect(starts, "nothing was started").toEqual([]);

    // The addresses of the old forms open the composer, with their kind.
    await page.evaluate(() => localStorage.removeItem("botbench.composer"));
    await page.goto(`${botbench.base}/#/tasks/new`);
    await expect(page).toHaveURL(/#\/turn$/);
    await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe the task");
    await expect(page.getByRole("button", { name: "Send" })).toHaveAccessibleDescription("Choose a repository");
    await page.goto(`${botbench.base}/#/runs/new`);
    await expect(page).toHaveURL(/#\/turn$/);
    await expect(messageBox(page)).toHaveAttribute("aria-label", "Describe what to plan");
    await expect(page.getByRole("button", { name: "Send" })).toHaveAccessibleDescription("Choose a repository");

    // On the home screen itself, with no repository, Send is a chat and nothing is required, whatever kind was used last.
    await page.reload();
    await expect(page).toHaveURL(/#\/turn$/);
    await expect(contextSheet(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Choose a Repository" })).toHaveCount(0);
    await messageBox(page).fill("Hello");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});
