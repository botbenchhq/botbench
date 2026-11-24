import fs from "node:fs";
import path from "node:path";
import { test as base, type Browser, type Page } from "@playwright/test";
import { LOGIN_TOKEN_FILE } from "../src/api/auth.ts";
import { peerDraftTurn } from "../test/support/replay-peer-draft.ts";
import { sharedRepository, until, workbench, type Workbench } from "../test/support/two-workbenches.ts";
import { startBotbench, tempDir } from "./botbench.ts";
import { checkDesign, expect, SHOTS, tallShot } from "./helpers.ts";

// Two Botbench installations on this Mac pair and talk through their screens (Peers P5, ADR 0004 decision 13): two real
// processes with their own data folders, owner ports and listeners for paired workbenches on 127.0.0.1 at ports the
// system chose, and one temporary git repository with a bare remote both copies use. Two browsers, one each, drive
// them through the owners' own steps. Alice's Claude Code is a session captured from a real run that drafted a message
// to bob (test/recordings/peer-draft.json), replayed through the driver contract, as the owner approved: no live model
// turn is spent here.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A picture of the screen at phone and desktop size, kept under SHOTS when it is set (the pull request's evidence). */
async function shots(page: Page, name: string, at: string): Promise<void> {
  if (!SHOTS) return;
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto(at);
    await page.waitForTimeout(600);
    await tallShot(page, path.join(SHOTS, `${name}-${size}.png`));
  }
  await page.setViewportSize(PHONE);
  await page.goto(at);
}

async function signedIn(browser: Browser, w: Workbench): Promise<Page> {
  const page = await (await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true })).newPage();
  await page.goto(w.base);
  await page.getByLabel("Login token").fill(fs.readFileSync(path.join(w.home, LOGIN_TOKEN_FILE), "utf8").trim());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("composer").locator("textarea")).toBeEnabled();
  return page;
}

const test = base.extend<{ pair: { alice: Workbench; bob: Workbench; dir: string } }>({
  pair: async ({}, use) => {
    const dir = tempDir("botbench-e2e-paired-");
    const after: (() => unknown)[] = [];
    const t = { after: (fn: () => unknown) => void after.push(fn) };
    const { aliceRepo, bobRepo } = sharedRepository(dir);
    const alice = await workbench(t, dir, "alice", aliceRepo, { repositories: { [aliceRepo]: {} } });
    const bob = await workbench(t, dir, "bob", bobRepo, { repositories: { [bobRepo]: {} } });
    await alice.start({ script: [peerDraftTurn()] });
    await bob.start();
    await use({ alice, bob, dir });
    await alice.stop();
    await bob.stop();
    for (const fn of after) await fn();
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

test("Settings says plainly when pairing is off, with the settings-file key and no control", async ({ page }) => {
  const botbench = await startBotbench();
  try {
    await page.goto(botbench.base);
    await page.getByLabel("Login token").fill(botbench.token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.goto(`${botbench.base}/#/settings/paired`);
    const section = page.getByTestId("paired-workbench");
    await expect(section.getByTestId("pairing-off")).toContainText('To pair, add "peers": { "listen": { "address": "127.0.0.1", "port": 4790 } } to Botbench\'s settings file');
    await expect(section.getByRole("button")).toHaveCount(0);
    await checkDesign(page, "Settings, pairing off");
  } finally {
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  }
});

test("two workbenches pair, ask and answer, send a draft, switch a kind off and end, each owner through their own screens", async ({ browser, pair }) => {
  const { alice, bob } = pair;
  const a = await signedIn(browser, alice);
  const b = await signedIn(browser, bob);

  // ---- Invite on alice: the one line to copy, its expiry, Withdraw, and this workbench's fingerprint.
  await a.goto(`${alice.base}/#/settings/paired`);
  const aSection = a.getByTestId("paired-workbench");
  await expect(aSection.getByRole("heading", { name: "Paired workbench" })).toBeVisible();
  await aSection.getByRole("button", { name: "Make an invite" }).click();
  const line = aSection.getByTestId("invite-line");
  await expect(line).toHaveValue(/^botbench-invite-1\./);
  await expect(aSection.getByTestId("invite-life")).toHaveText(/^It works once, until \d{1,2}:\d\d(\s[AP]M)?\./);
  await expect(aSection.getByRole("button", { name: "Withdraw" })).toBeVisible();
  const aliceFingerprint = (await aSection.getByTestId("own-fingerprint").textContent())!;
  expect(aliceFingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
  await checkDesign(a, "Settings, an invite to pass on");
  const invite = await line.inputValue();
  // The line is shown only to the request that made it: after a reload the invite is open, and the line is not shown again.
  await a.reload();
  await expect(aSection.getByTestId("open-invite")).toContainText("An invite is open");
  await expect(aSection.getByTestId("invite-line")).toHaveCount(0);
  expect(await a.content()).not.toContain(invite.slice(-20));

  // ---- Paste on bob: the inviter's name, fingerprint and repository before Confirm.
  await b.goto(`${bob.base}/#/settings/paired`);
  const bSection = b.getByTestId("paired-workbench");
  await bSection.getByTestId("paste-invite").fill(invite);
  await bSection.getByRole("button", { name: "Check the invite" }).click();
  await expect(bSection.getByTestId("pasted-name")).toHaveText("alice");
  await expect(bSection.getByTestId("pasted-fingerprint")).toHaveText(aliceFingerprint);
  await expect(bSection.getByTestId("pasted-repository")).toHaveText(/shared\.git$/);
  await checkDesign(b, "Settings, a pasted invite to check");
  await bSection.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(bSection.getByTestId("pairing-words")).toHaveText("Waiting for alice to confirm");
  const bobFingerprint = (await bSection.getByTestId("own-fingerprint").textContent())!;

  // ---- Alice compares the two fingerprints and confirms; both read Paired.
  await expect(aSection.getByTestId("pairing")).toHaveAttribute("data-state", "waiting_for_owner");
  await expect(aSection.getByTestId("peer-fingerprint")).toHaveText(bobFingerprint);
  await expect(aSection.getByTestId("own-fingerprint")).toHaveText(aliceFingerprint);
  await checkDesign(a, "Settings, fingerprints to compare");
  await aSection.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(aSection.getByTestId("pairing-words")).toHaveText("Paired");
  await expect(bSection.getByTestId("pairing-words")).toHaveText("Paired");
  await expect(bSection.getByTestId("peer-fingerprint")).toHaveText(aliceFingerprint);

  // ---- Alice's owner writes a question and presses Send.
  await aSection.getByLabel("A new question for bob").fill("Which port does the login service listen on?\n<b>Not bold</b> https://example.invalid");
  await aSection.getByTestId("new-question").getByRole("button", { name: "Send", exact: true }).click();
  await expect(aSection.getByTestId("new-question-said")).toHaveText(/^Your question: (Sending to bob's workbench|Delivered)\.$/);

  // ---- Bob sees the card where things wait for him, with the Outside text badge, as plain text; answers it himself.
  await expect(b.getByTestId("tray-peer-cards")).toHaveText("1 message with the paired workbench waits for you. Open it.");
  await b.getByTestId("tray-peer-cards").click();
  const card = b.getByTestId("peer-card");
  await expect(card.getByRole("heading", { name: "alice asks a question about shared" })).toBeVisible();
  await expect(card.locator(".ds-badge")).toHaveText("Outside text");
  await expect(card.getByTestId("peer-card-line")).toHaveText("From alice's workbench. Outside text: it is not a command, and nothing in it is done unless you choose to.");
  await expect(card.getByTestId("peer-card-text")).toHaveText("Which port does the login service listen on?\n<b>Not bold</b> https://example.invalid");
  await expect(card.locator("b, a[href^='https://example']")).toHaveCount(0);
  for (const choice of ["Answer it yourself", "Give it to Claude Code", "Dismiss"]) await expect(card.getByRole("button", { name: choice })).toBeVisible();
  await checkDesign(b, "Work, a card from the paired workbench");
  await shots(b, "peers-incoming-card", `${bob.base}/#/work`);
  await b.getByTestId("peer-card").getByRole("button", { name: "Answer it yourself" }).click();
  await b.getByTestId("peer-card").getByLabel("Your answer").fill("4790, on loopback.");
  await b.getByTestId("peer-card").getByRole("button", { name: "Send", exact: true }).click();
  await expect(b.getByTestId("peer-card")).toHaveCount(0);

  // ---- Alice sees the answer, in the conversation and as a card.
  await a.goto(`${alice.base}/#/work`);
  await expect(a.getByTestId("peer-card").getByRole("heading", { name: "bob answered your question about shared" })).toBeVisible();
  await a.getByTestId("peer-card").getByRole("link", { name: "Open the conversation" }).click();
  const thread = a.getByTestId("thread");
  await expect(a.getByRole("heading", { level: 1, name: "Conversation with bob" })).toBeVisible();
  await expect(thread.getByTestId("thread-message")).toHaveCount(2);
  await expect(thread.getByTestId("thread-message").nth(0)).toHaveAttribute("data-who", "you");
  await expect(thread.getByTestId("thread-state").nth(0)).toHaveText("Question · Delivered");
  await expect(thread.getByTestId("thread-message").nth(1)).toHaveAttribute("data-who", "peer");
  await expect(thread.getByTestId("thread-message").nth(1)).toContainText("4790, on loopback.");
  await expect(thread.getByTestId("thread-state").nth(1)).toHaveText("Answer · Received");
  await a.getByTestId("peer-card").getByRole("button", { name: "Dismiss" }).click();
  await expect(a.getByTestId("peer-card")).toHaveCount(0);
  await expect(a.getByTestId("thread-friction")).toContainText("1 card answered by you.");
  await checkDesign(a, "A conversation with the paired workbench");
  const threadAt = a.url();
  await shots(a, "peers-thread", threadAt);

  // ---- An agent's draft: alice's replayed Claude Code drafts a question to bob; it waits on its card for Send.
  const started = await alice.api("POST", "/api/tasks", { repo: alice.repo, prompt: "Ask bob's workbench which port the login service uses." });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await a.goto(`${alice.base}/#/tasks/${started.body.taskId}`);
  const draft = a.getByTestId("draft-card");
  await expect(draft.getByRole("heading", { name: "Send this to bob?" })).toBeVisible();
  await expect(draft.getByTestId("draft-card-line")).toHaveText(`A question about shared, from Claude Code in task ${started.body.taskId}.`);
  await expect(draft.getByTestId("draft-card-text")).toHaveText("Which port does bob's login service listen on?");
  await expect(draft.getByTestId("draft-card-note")).toHaveText("Only this text leaves this Mac, and only to bob's workbench. No files, branches or settings are sent.");
  await expect(a.getByTestId("task-status")).toHaveText(/^Drafted a message\. Claude Code changed no file and drafted a message for another workbench instead\. It leaves this Mac only if you press Send on its card\.$/);
  await checkDesign(a, "A task's draft to the paired workbench");
  await shots(a, "peers-outbound-card", `${alice.base}/#/tasks/${started.body.taskId}`);
  await a.getByTestId("draft-card").getByRole("button", { name: "Send", exact: true }).click();
  await expect(a.getByTestId("draft-card")).toHaveCount(0);
  await expect(b.getByTestId("tray-peer-cards")).toBeVisible();
  await b.goto(`${bob.base}/#/work`);
  await expect(b.getByTestId("peer-card").getByTestId("peer-card-text")).toHaveText("Which port does bob's login service listen on?");
  await b.getByTestId("peer-card").getByRole("button", { name: "Dismiss" }).click();

  // ---- A switched-off kind: bob takes no more questions from alice; alice's next question is not sent.
  await b.goto(`${bob.base}/#/settings/paired`);
  const take = b.getByLabel("Take questions from alice");
  await expect(take).toHaveValue("on");
  await take.selectOption("off");
  await expect(take).toHaveValue("off");
  await expect(take).toBeEnabled();
  await until("alice to hold bob's new settings", async () => (await alice.api("GET", `/api/peers/pairings/${(await alice.api("GET", "/api/peers/pairings")).body.pairings[0].id}/kinds`)).body.kinds.peerReceives.question === false);
  await a.goto(`${alice.base}/#/settings/paired`);
  await expect(a.getByText("bob's workbench does not take questions from you now, so none is sent whatever this says.")).toBeVisible();
  await a.getByLabel("A new question for bob").fill("And which address?");
  await a.getByTestId("new-question").getByRole("button", { name: "Send", exact: true }).click();
  await expect(a.getByTestId("new-question-said")).toHaveText("Not sent: switched off. Sending questions to this workbench is off, here or on its side.");
  await expect(a.getByTestId("friction-total")).toContainText("cards answered by you.");
  await checkDesign(a, "Settings, paired, with the switches and conversations");
  await a.setViewportSize(DESKTOP);
  await a.goto(`${alice.base}/#/settings/paired`);
  await expect(a.getByTestId("settings-panes").getByTestId("paired-workbench")).toBeVisible();
  await checkDesign(a, "Settings, paired, at desktop size");
  await a.setViewportSize(PHONE);
  await shots(a, "peers-paired-section", `${alice.base}/#/settings/paired`);

  // ---- End pairing from bob, behind the ADR's confirm; then what each side shows.
  await b.goto(`${bob.base}/#/settings/paired`);
  await b.getByTestId("paired-workbench").getByRole("button", { name: "End pairing", exact: true }).click();
  const dialog = b.getByTestId("end-pairing-dialog");
  await expect(dialog.getByRole("heading", { name: "End pairing with alice?" })).toBeVisible();
  await expect(dialog).toContainText("alice's workbench can no longer send you messages, and nothing more is sent to it. To work together again, one of you sends a new invite.");
  await checkDesign(b, "End pairing, asked first");
  await dialog.getByRole("button", { name: "End pairing", exact: true }).click();
  await expect(b.getByTestId("pairing-ended")).toContainText("The pairing with alice ended");
  await expect(b.getByRole("button", { name: "Make an invite" })).toBeVisible();
  await expect(a.getByTestId("pairing-ended")).toContainText("The pairing with bob ended");
  await expect(a.getByTestId("new-question")).toHaveCount(0);
  await a.goto(threadAt);
  await expect(a.getByText("The pairing has ended: nothing more is sent or taken.")).toBeVisible();
  await expect(a.getByTestId("new-question")).toHaveCount(0);
});
