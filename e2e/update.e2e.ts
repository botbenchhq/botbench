import fs from "node:fs";
import path from "node:path";
import { test as base, type Page } from "@playwright/test";
import { commitAndTag, bumpVersion, notesFor, smallRepo, startReleaseServer, type ReleaseServer } from "../test/support/releases.ts";
import { git } from "../test/support/repo.ts";
import { expect, pageMode, signIn, tempShot } from "./helpers.ts";
import { checkNext } from "./settings-helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

// Settings' Version row (issue #116) in the real client, at a phone's size and at a desktop's, light and dark: a real
// Botbench process started through e2e/serve-with-releases.ts, which looks for releases at a real HTTP server serving
// GitHub's captured latest-release answer (test/support/releases.ts) and fetches them from a real git repository with
// real tags. The installation it would update is a clone in a temporary folder, never this checkout; Update now is
// pressed only once that clone has a change of its own, so the update is refused and nothing is installed.

const test = base.extend<{ dir: string; releases: ReleaseServer; install: string; botbench: Botbench }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-update-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  releases: async ({}, use) => {
    const releases = await startReleaseServer();
    await use(releases);
    await releases.close();
  },
  install: async ({ dir, releases }, use) => {
    const remote = path.join(dir, "github");
    smallRepo(remote, "0.1.0");
    const install = path.join(dir, "install");
    git(dir, "clone", "--quiet", remote, install);
    bumpVersion(remote, "0.2.0");
    commitAndTag(remote, "chore(main): release 0.2.0", "v0.2.0");
    releases.publish({ tag: "v0.2.0", notes: notesFor("0.2.0", "update Botbench from Settings") });
    await use(install);
  },
  botbench: async ({ dir, releases, install }, use) => {
    const botbench = await startBotbench({ home: path.join(dir, "home"), entry: path.resolve(import.meta.dirname, "serve-with-releases.ts"), env: { BOTBENCH_TEST_INSTALL: install, BOTBENCH_TEST_RELEASES: releases.url, BOTBENCH_TEST_GIT: path.join(dir, "github") } });
    await use(botbench);
    await botbench.stop();
  },
});

async function inMode(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.evaluate((m) => window.localStorage.setItem("botbench.appearance", m), mode);
  await page.reload();
  await expect.poll(() => pageMode(page)).toBe(mode);
}

for (const size of [{ name: "phone", width: 390, height: 844, address: "#/settings/identity" }, { name: "desktop", width: 1280, height: 900, address: "#/settings/workbench" }] as const) {
  test(`Settings shows the version, the release to update to with its notes, and when to update (${size.name})`, async ({ page, botbench, install }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page, botbench);
    await page.goto(`${botbench.base}/${size.address}`);
    const group = page.getByTestId("update-settings");
    // The desktop's address is the one Settings had before its groups: it opens Workbench identity, where the version now is.
    await expect(page).toHaveURL(/#\/settings\/identity$/);
    const row = group.getByTestId("version-row");
    await expect(row.getByRole("heading")).toHaveText("Botbench 0.1.0");
    await expect(row.getByTestId("version-about")).toHaveText("Update available: 0.2.0 — update Botbench from Settings");
    // The notes are the repository's words: shown as text, marked as such.
    await expect(row.locator("[data-ds-content]")).toHaveText("update Botbench from Settings");
    await expect(row.getByRole("button", { name: "Update now" })).toBeVisible();
    await expect(group.getByLabel("Updates", { exact: true })).toHaveValue("tap");
    for (const mode of ["light", "dark"] as const) {
      await inMode(page, mode);
      await group.scrollIntoViewIfNeeded();
      await expect(row.getByRole("button", { name: "Update now" })).toBeVisible();
      await checkNext(page, `Settings, Version with an update available (${size.name}, ${mode})`);
      await tempShot(page, `update-${size.name}-${mode}`);
    }

    // An installation with a change of its own is never updated. Choosing Automatically starts the update at once,
    // which refuses and says why; the choice is kept across a reload. Back on a tap, Update now refuses the same way.
    const before = git(install, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(install, "README.md"), "a change of the owner's\n");
    const failed = group.getByTestId("update-failed");
    const refusal = "has changes that are not committed, so it was not updated. Commit or remove them, then update again.";
    await group.getByLabel("Updates", { exact: true }).selectOption("auto");
    await page.reload();
    await expect(group.getByLabel("Updates", { exact: true })).toHaveValue("auto");
    await expect(failed).toContainText(refusal);
    await group.getByLabel("Updates", { exact: true }).selectOption("tap");
    await expect(group.getByLabel("Updates", { exact: true })).toHaveValue("tap");
    await page.reload();
    await row.getByRole("button", { name: "Update now" }).click();
    await expect(failed).toContainText(refusal);
    // Offered again once it has answered, and drawn at rest (not in the pressed button's fade).
    await expect(row.getByRole("button", { name: "Update now" })).toBeEnabled();
    await page.mouse.move(0, 0);
    await checkNext(page, `Settings, Version after a refused update (${size.name}, dark)`);
    await tempShot(page, `update-${size.name}-refused`);
    expect(git(install, "rev-parse", "HEAD").trim()).toBe(before);
  });
}
