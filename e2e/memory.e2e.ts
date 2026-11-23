import fs from "node:fs";
import path from "node:path";
import { captureNote, memoryFolder } from "../src/engine/memory.ts";
import { openStore } from "../src/store/db.ts";
import { startBotbench, tempDir } from "./botbench.ts";
import { checkDesign, expect, signIn, test } from "./helpers.ts";

// Settings → Memory in the real client at a phone's size, against a real Botbench process. No model turn is started:
// the two notes are saved before it starts, through the store's own capture (src/engine/memory.ts), as an owner's
// "Remember:" chat message saves them. Everything after that is the screen and the real routes.

test("Settings → Memory lists the notes; an edit is saved, one made on a note that changed since the screen read it is refused in plain words and overwrites nothing, and Forget removes the note", async ({ page }) => {
  const home = tempDir("botbench-e2e-memory-");
  const db = openStore(home);
  captureNote(db, home, "the staging database is read-only");
  captureNote(db, home, "in this repository always run the linter before committing");
  db.close();
  const botbench = await startBotbench({ home });
  try {
    await signIn(page, botbench);
    await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
    const memory = page.getByTestId("memory-settings");
    await expect(memory.getByRole("heading", { name: "Memory" })).toBeVisible();
    const rows = memory.getByTestId("memory-notes").getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("in this repository always run the linter before committing");
    await memory.scrollIntoViewIfNeeded();
    await checkDesign(page, "settings, memory");

    // An edit, saved.
    await memory.getByRole("button", { name: "Edit note 2: the staging database is read-only" }).click();
    const input = memory.getByTestId("memory-note-text");
    await expect(input).toBeFocused();
    await checkDesign(page, "settings, memory, editing a note");
    await input.fill("the staging database is read-only on weekdays");
    await memory.getByRole("button", { name: "Save note" }).click();
    await expect(rows.nth(1)).toContainText("the staging database is read-only on weekdays");
    await expect(rows.nth(1)).toContainText(/Edited /);
    await expect(memory.getByRole("button", { name: "Edit note 2: the staging database is read-only on weekdays" })).toBeFocused();

    // A stale edit: the screen read the note, then another tab changed it.
    await memory.getByRole("button", { name: /^Edit note 1: / }).click();
    const listed = (await (await page.request.get(`${botbench.base}/api/memory`)).json()) as { notes: { id: number; hash: string; text: string }[] };
    const first = listed.notes[0]!;
    const other = await page.request.put(`${botbench.base}/api/memory/${first.id}`, { data: { text: "run npm run lint before committing", hash: first.hash } });
    expect(other.status()).toBe(200);
    const file = path.join(memoryFolder(home), `note-${first.id}.md`);
    const before = fs.readFileSync(file, "utf8");
    await input.fill("never mind the linter");
    await memory.getByRole("button", { name: "Save note" }).click();
    await expect(memory.getByRole("alert")).toHaveText(/^This note changed since you opened it, so your edit was not saved\. Botbench shows the note as it is now: look at it, then try again\.$/);
    await expect(memory.getByText("The note now: run npm run lint before committing")).toBeVisible();
    await expect(input).toHaveValue("never mind the linter");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    await checkDesign(page, "settings, memory, an edit refused as stale");
    await memory.getByRole("button", { name: "Cancel" }).click();
    await expect(rows.first()).toContainText("run npm run lint before committing");

    // Forget, after a question.
    await memory.getByRole("button", { name: "Forget note 1: run npm run lint before committing" }).click();
    const dialog = page.getByTestId(`memory-forget-${first.id}`);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Botbench removes it from memory and keeps no copy there. Agents are no longer given it. Chats and runs that already had it keep their words.");
    await checkDesign(page, "settings, memory, forget this note?");
    await dialog.getByRole("button", { name: "Forget" }).click();
    await expect(rows).toHaveCount(1);
    expect(fs.existsSync(file)).toBe(false);
    for (const name of fs.readdirSync(memoryFolder(home))) expect(fs.readFileSync(path.join(memoryFolder(home), name), "utf8")).not.toContain("npm run lint");

    await memory.getByRole("button", { name: /^Forget note 1: / }).click();
    await page.getByTestId(/^memory-forget-/).getByRole("button", { name: "Forget" }).click();
    await expect(memory.getByText("No notes yet")).toBeVisible();
    await checkDesign(page, "settings, memory, no notes");
  } finally {
    await botbench.stop();
  }
});
