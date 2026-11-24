/*
 * The North Star: one GitHub issue becomes a reviewed, refined pull request with no person deciding, while a second
 * workbench that starts on the same issue sees the first one's claim and withdraws. This is Botbench's acceptance test.
 *
 * Run it on the Mac, from the repository's top folder, outside any sandbox:
 *
 *   npx playwright test --config e2e/playwright.config.ts e2e/northstar.e2e.ts
 *
 * Needs: Claude Code installed and signed in (`claude`, with a subscription), and Chrome. gh is not used and need not
 * be signed in: every gh answer is replayed from output captured once from the real gh (test/recordings/gh-delivery.json,
 * gh-issue.json, gh-peers.json). It takes a while (a real plan and three real builder turns on haiku) and does not run
 * in GitHub CI. Set BOTBENCH_SHOTS to a folder to keep its screenshots, at 390x844 and at 1280x800, in dark and light.
 *
 * What is real: two Botbench processes (`node src/server.ts` started through e2e/serve-replayed-northstar.ts), workbench
 * A ("alice") and workbench B ("bob"), each with its own data folder, its own settings, its own workbench name and its
 * own port; one temporary bare repository on disk as the shared remote, and a clone of one temporary repository for
 * each; real git; the built client in Chrome; and on A the owner's real Claude Code on its cheapest model (haiku), which
 * plans the run and builds the task, fixes the failing check, and answers the review. Nothing here touches the owner's
 * own Botbench, data folder or port: every home, folder and port is a temporary one, removed at the end.
 *
 * What is replayed, and why (the owner's approved exception, each a capture of a real session; no file under
 * test/recordings/ is changed or added by this test):
 *   - gh: the pull request a delivery opens (gh-delivery.json), so a pull request is opened, with a number and a link,
 *     against the temporary bare remote without touching GitHub, and a repository's pull requests (gh-peers.json).
 *   - The reviewer, Codex: its first review is the real review of a diff that adds calc.py with `return a - b` (verdict
 *     concerns, test/recordings/codex-review.json), its second the real review of the fixed work that says what it
 *     checked (refine-checked-review.json). A live reviewer may find nothing to raise; the North Star needs a concern.
 *
 * Why the issue is named in the run's message and not attached with "From an issue": Botbench never lets a run that
 * read an issue's text be fully autonomous (CLAUDE.md, the three modes; web/src/app/composer.ts ISSUE_NOT_FULL; the
 * engine refuses it too), since a stranger's text must not lead to an accepted change with nobody looking. A run whose
 * own message names one issue number claims that issue all the same (src/engine/claims.ts runIssueNumber). The issue
 * is #15019 of github.com/cli/cli, the issue of the replayed real gh capture (gh-issue.json), and both clones name that
 * repository as their remote, which their git settings send to the bare repository on disk.
 *
 * How the first check fails every time, and how the fix round mends it: the repository's one check, in Botbench's
 * settings file outside the task's copy, is a changelog rule: CHANGELOG.md must have a line that names calc.py and this
 * change's ticket, a ticket id made fresh for this test. The builder's first turn is never shown the check, so its first
 * result fails; the failure, ticket included, is what Botbench sends the builder in the round of fixes for a failing
 * check, and adding the changelog line is the fix. (An earlier form of this check asked for a file holding a bare
 * token; a careful model refused to write it, as passing a check with no work behind it.) The check names calc.py and
 * CHANGELOG.md, so both are files the plan leads one to expect (src/engine/scope.ts) and a fully autonomous run may
 * accept them. The draft in calc.txt subtracts: the task copies it to calc.py as a first pass, which is the diff the
 * replayed review was recorded on, and the builder fixes it in the round after the review.
 *
 * Tagged MILESTONE: it runs once per batch of work, by the owner, three times in a row before a release is called done.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page } from "@playwright/test";
import { MODE_SENTENCE } from "../web/src/app/run-words.ts";
import { loadGhCapture } from "../test/support/replay-github.ts";
import { ISSUE_ADDRESS, ISSUE_NUMBER, ISSUE_REPO, loadIssueCapture } from "../test/support/replay-issue.ts";
import { parseIssueView } from "../src/github.ts";
import { git, initRepo } from "../test/support/repo.ts";
import { checkDesign, checkScreen, choose, chooseRepository, closeContext, expect, messageBox, openComposer, openRow, openRunId, openWork, runTaskRows, SHOTS, signIn, startRunIn, tallShot, watchRequests } from "./helpers.ts";
import { startBotbench, tempDir, type Botbench } from "./botbench.ts";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const ENTRY = path.resolve(import.meta.dirname, "serve-replayed-northstar.ts");
/** The issue as the replayed real gh answered for it. */
const ISSUE = parseIssueView(loadIssueCapture().outputs.issue.result.stdout, ISSUE_REPO, ISSUE_NUMBER);

/** The run's message, the same on both workbenches: it names the one issue, and asks for one task the planner cannot widen. */
// The builder must leave the subtraction in place until the review raises it (a live model tends to fix it at once,
// and the replayed review was recorded on the copy that subtracts), so the message says so plainly.
const MESSAGE = `Issue #${ISSUE_NUMBER}. Plan exactly one task, titled: Create calc.py as an exact copy of calc.txt in this first pass, then fix what the review finds. Give it exactly these two criteria, word for word: "Until a reviewer asks for a change, calc.py is a byte-for-byte copy of calc.txt, its subtraction included." and "calc.py defines add(a, b)." Read calc.txt only, write with your Write or Edit tool, and run no command.`;

interface World {
  /** The shared remote, a bare repository on disk. */
  bare: string;
  /** Workbench A's clone and workbench B's. */
  alice: string;
  bob: string;
  /** The ticket id the check wants CHANGELOG.md to name, with calc.py, on one line. */
  token: string;
  check: string;
}

const test = base.extend<{ dir: string; world: World; alice: Botbench; bob: Botbench; pageB: Page }>({
  dir: async ({}, use) => {
    const dir = tempDir("botbench-e2e-northstar-");
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  world: async ({ dir }, use) => {
    const bare = path.join(dir, "remote.git");
    const seed = path.join(dir, "seed");
    // Python's bytecode is ignored, as in any Python repository: a builder that imports calc.py to try it must not
    // leave a file the plan does not name.
    initRepo(seed, { "README.md": "# Calculator\n", ".gitignore": "__pycache__/\n", "calc.txt": "def add(a, b):\n    return a - b\n" });
    git(dir, "init", "--quiet", "--bare", "-b", "main", bare);
    git(seed, "push", "--quiet", bare, "main");
    const clone = (name: string): string => {
      const repo = path.join(dir, `${name}-repo`);
      git(dir, "clone", "--quiet", bare, repo);
      // The remote is written as the issue's repository on GitHub; git sends it to the bare repository on disk.
      git(repo, "config", `url.${bare}.insteadOf`, ISSUE_ADDRESS);
      git(repo, "remote", "set-url", "origin", ISSUE_ADDRESS);
      return fs.realpathSync(repo);
    };
    const token = `NS-${randomBytes(4).toString("hex").toUpperCase()}`;
    const check = `grep -q 'def add' calc.py && grep 'calc.py' CHANGELOG.md | grep -q '${token}' || { echo "FAIL: the changelog rule: CHANGELOG.md needs a line that names calc.py and this change's ticket, ${token}"; exit 1; }`;
    await use({ bare, alice: clone("alice"), bob: clone("bob"), token, check });
  },
  alice: async ({ dir, world }, use) => {
    // startBotbench writes the settings file beside the home folder, so the folder that holds both must exist.
    fs.mkdirSync(path.join(dir, "alice"), { recursive: true });
    const botbench = await startBotbench({
      home: path.join(dir, "alice", "home"),
      entry: ENTRY,
      settings: { workbench: "alice", drivers: { "claude-code": { model: "haiku" }, codex: {} }, repositories: { [world.alice]: { checks: [world.check], claimIssues: true } } },
    });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process of workbench A is left after it stops").toEqual([]);
  },
  bob: async ({ dir, world }, use) => {
    // B needs a check too: a fully autonomous run can be started only on a repository that has one.
    // startBotbench writes the settings file beside the home folder, so the folder that holds both must exist.
    fs.mkdirSync(path.join(dir, "bob"), { recursive: true });
    const botbench = await startBotbench({
      home: path.join(dir, "bob", "home"),
      entry: ENTRY,
      settings: { workbench: "bob", drivers: { "claude-code": { model: "haiku" }, codex: {} }, repositories: { [world.bob]: { checks: [world.check], claimIssues: true } } },
    });
    await use(botbench);
    const { leftover } = await botbench.stop();
    expect(leftover, "no CLI process of workbench B is left after it stops").toEqual([]);
  },
  // Workbench B's page: a browser context of its own, as the owner's other Mac would be, at the phone size of the config.
  pageB: async ({ browser }, use) => {
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true });
    await use(await context.newPage());
    await context.close();
  },
});

/** The branches of the bare remote, by name, with the commit each points at. */
function remoteBranches(bare: string): Map<string, string> {
  return new Map(
    git(bare, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string]),
  );
}

/** Draw the client as the device chooses (Match device), so a screen can be judged in dark and in light without a reload. */
async function matchDevice(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.setItem("botbench.appearance", "auto"));
  await page.reload();
  await expect(messageBox(page).or(page.getByRole("heading", { level: 1 })).first()).toBeAttached();
}

/**
 * The design check on one screen of the journey at 390x844 and at 1280x800, in dark and in light, with a screenshot of
 * each under BOTBENCH_SHOTS (`northstar-<name>-phone-dark.png`, `northstar-<name>-desktop-light.png`, …). The page is
 * left at the phone's size, in dark.
 */
/**
 * The design checks and screenshots of one screen at 390x844 and 1280x800, dark and light. `reopen` puts back what a
 * change of size closed (the Add context sheet does not stay open across a resize). `check` is the design system's
 * rendered check, or, for a screen rebuilt on shadcn/ui (Work), which is not drawn with its classes, the words check.
 */
async function judge(page: Page, screen: string, name: string, ready: Locator, reopen?: () => Promise<void>, check: (page: Page, screen: string) => Promise<void> = checkDesign): Promise<void> {
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    for (const mode of ["dark", "light"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: mode });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "auto");
      // A change between the phone and the desktop layout draws the page anew a moment later: wait for it to settle first.
      await page.waitForTimeout(1_000);
      if (reopen !== undefined && !(await ready.isVisible())) await reopen();
      await expect(ready).toBeVisible();
      // Colours change with a short transition after the mode changes: judge the settled page, not one in between.
      await page.waitForTimeout(500);
      await check(page, `${screen}, ${size}, ${mode}`);
      if (SHOTS) await tallShot(page, path.join(SHOTS, `northstar-${name}-${size}-${mode}.png`));
    }
  }
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ colorScheme: "dark" });
}

test("MILESTONE North Star: an issue becomes a reviewed, refined pull request with no person deciding, and a second workbench on the same issue sees the claim and withdraws", async ({ page, pageB, alice, bob, world }) => {
  test.setTimeout(2_400_000);
  const created = loadGhCapture().outputs.prCreate.result.stdout.trim();
  const prNumber = /\/pull\/(\d+)$/.exec(created)![1];
  const lock = `botbench/claims/issue-${ISSUE_NUMBER}`;

  // Workbench A: signed in, the composer judged, then a fully autonomous run with Codex reviewing that opens a pull request.
  const foreignA = watchRequests(page, alice);
  await signIn(page, alice);
  await matchDevice(page);
  await openComposer(page);
  await judge(page, "A, the composer", "a-composer", messageBox(page));
  // The issue is read through the replayed real gh and shown to the owner, then not attached: a run that read an
  // issue's text cannot be fully autonomous (see the header), so the run names it in its message instead.
  await chooseRepository(page, world.alice);
  // "From an issue" is a row of a run only.
  await choose(page, "What to do", "Plan a run");
  const intake = await openRow(page, "From an issue");
  await intake.getByLabel("Issue number or address").fill(String(ISSUE_NUMBER));
  await intake.getByRole("button", { name: "Look it up" }).click();
  await expect(intake.getByTestId("issue-preview").getByRole("heading", { name: ISSUE.title })).toBeVisible();
  await expect(intake.getByTestId("issue-preview")).toContainText(`#${ISSUE_NUMBER} of github.com/cli/cli`);
  // The composer is drawn anew when the window changes between the phone and the desktop layout, and what was chosen
  // in it is not kept: choose the repository and the run again, and look the issue up again.
  const lookUp = async (): Promise<void> => {
    await chooseRepository(page, world.alice);
    await choose(page, "What to do", "Plan a run");
    const sheet = await openRow(page, "From an issue");
    if (!(await sheet.getByTestId("issue-preview").isVisible())) {
      await sheet.getByLabel("Issue number or address").fill(String(ISSUE_NUMBER));
      await sheet.getByRole("button", { name: "Look it up" }).click();
    }
  };
  await judge(page, "A, the issue as read", "a-issue-read", intake.getByTestId("issue-preview"), lookUp);
  // After the changes of size the sheet can be left open but not drawn; the run is set up afresh below, so start clean.
  await page.reload();
  await expect(messageBox(page)).toBeVisible();
  await startRunIn(page, world.alice, MESSAGE, { mode: "Fully autonomous", review: "codex ?default", delivery: "Open a pull request" });
  const runA = await openRunId(page);
  await expect(page.getByTestId("run-mode")).toHaveText(MODE_SENTENCE.full);
  await expect(page.getByTestId("run-delivery")).toHaveText("Botbench pushes its branch and opens a pull request");

  // A's claim on the issue is on the shared remote as soon as the run starts: its lock and its named branch, one commit.
  // The claim/withdraw assertions below follow the approach from paperclip .reference/paperclip/server/src/services/heartbeat/:
  // a run that finds the work already held by another gives way at once and says who holds it, instead of working on.
  const claimA = page.getByTestId("run-claim");
  await expect(claimA).toHaveText(new RegExp(`^Botbench pushed the branches (botbench/alice/run-${runA}/issue-${ISSUE_NUMBER}-at-\\d{8}T\\d{9}Z) and ${lock} to the remote origin, so other workbenches can see you started on issue #${ISSUE_NUMBER}\\. The claim holds no files, and is deleted if the run ends without a pull request\\.$`));
  const claimBranch = new RegExp(`(botbench/alice/run-${runA}/issue-${ISSUE_NUMBER}-at-\\d{8}T\\d{9}Z)`).exec((await claimA.textContent()) ?? "")![1]!;
  const claimed = remoteBranches(world.bare);
  expect(claimed.get(lock), "the issue's lock is on the remote").toBeDefined();
  expect(claimed.get(claimBranch), "A's named claim is at the lock's commit").toBe(claimed.get(lock));
  await judge(page, "A, the run, its claim pushed", "a-run-claimed", claimA, undefined, (shown, name) => checkScreen(shown, name, { least: true }));

  // Workbench B, on its own clone, starts on the same issue while A's claim is on the remote.
  const foreignB = watchRequests(pageB, bob);
  await signIn(pageB, bob);
  await matchDevice(pageB);
  // B's run, set up in the composer. The draft does not survive a change of the window's size (the composer is drawn
  // anew between the phone and the desktop layout), so the screens are judged first and the run is set up again after.
  const setUpB = async (): Promise<void> => {
    await openComposer(pageB);
    await chooseRepository(pageB, world.bob);
    await choose(pageB, "What to do", "Plan a run");
    await choose(pageB, "Mode", "Fully autonomous");
    await choose(pageB, "When accepted", "Open a pull request");
    await closeContext(pageB);
    await messageBox(pageB).fill(MESSAGE);
  };
  await setUpB();
  await judge(pageB, "B, the composer, with A's claim", "b-composer-claim", pageB.getByTestId("peer-warning"), setUpB);
  await pageB.reload();
  await setUpB();
  // B shows A's claim before Send: a warning only, and Send stays enabled.
  await expect(pageB.getByTestId("peer-warning")).toHaveText(new RegExp(`^A best-effort match on #${ISSUE_NUMBER} in your message: alice started on this issue (less than a minute|\\d+ minutes?) ago\\.$`));
  await expect(pageB.getByRole("button", { name: "Send" })).toBeEnabled();
  await pageB.getByRole("button", { name: "Send" }).click();
  const runB = await openRunId(pageB);

  // B withdraws: its claim names A and A's earlier time, the run is stopped, and nothing of it was built or pushed.
  await expect(pageB.getByTestId("run-claim")).toHaveText(
    new RegExp(`^alice started on issue #${ISSUE_NUMBER} at \\d{2}:\\d{2}:\\d{2} UTC on \\d{4}-\\d{2}-\\d{2}, before this workbench did \\(\\d{2}:\\d{2}:\\d{2} UTC on \\d{4}-\\d{2}-\\d{2}\\), so this run stopped: when two workbenches start on one issue, the earliest claim goes ahead\\. The remote refused this workbench's claim, so nothing of this run was pushed\\.$`),
  );
  await expect(pageB.getByTestId("run-status")).toHaveText("Cancelled. Nothing was built, and no task was made from this run.");
  await expect(runTaskRows(pageB)).toHaveCount(0);
  const withdrawn = (await (await pageB.request.get(`${bob.base}/api/runs/${runB}`)).json()) as { status: string; claim: { state: string } };
  expect([withdrawn.status, withdrawn.claim.state]).toEqual(["cancelled", "withdrawn"]);
  const afterB = remoteBranches(world.bare);
  expect([...afterB.keys()].filter((branch) => branch.startsWith("botbench/bob/")), "nothing of B's is on the remote").toEqual([]);
  expect(afterB.get(lock), "A still holds the issue's lock").toBe(claimed.get(lock));
  await judge(pageB, "B, the run, withdrawn", "b-run-withdrawn", pageB.getByTestId("run-claim"), undefined, (shown, name) => checkScreen(shown, name, { least: true }));

  // Back on A: the planner's one task appears, and is built, checked, fixed, reviewed and fixed again with nobody asked.
  await expect(runTaskRows(page)).toHaveCount(1, { timeout: 600_000 });
  await page.getByTestId("run-tasks").getByRole("link").first().click();
  await expect(page.getByTestId("task-name")).toHaveText(/^Task \d+ · /);
  const taskId = Number(/Task (\d+)/.exec((await page.getByTestId("task-name").textContent()) ?? "")![1]);
  await expect(page.getByTestId("task-status")).toBeVisible();

  // The end of the loop: accepted without the owner, or handed to the owner, which fails here, saying why.
  // The task's state says which: "Accepted without you" once the mode decided, "Ready for review" while it waits for
  // the owner, which fails below, saying why. The decision's panel is a sheet at a phone's width, opened from the foot
  // of the window: "Decision" as its heading once a mode decided, and the result in place of the buttons.
  await expect(page.getByTestId("task-status")).toHaveText(/^(Accepted|Ready for review)/, { timeout: 1_800_000 });
  await expect(page.getByTestId("task-status"), `the task was not accepted by the mode: ${await page.getByTestId("task-status").textContent()}`).toHaveText(/^Accepted without you, as its run is fully autonomous\. /);
  await expect(page.getByTestId("foot-actions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Accept|Reject)$/ })).toHaveCount(0);
  await page.getByTestId("foot").getByRole("button", { name: "The decision" }).click();
  const decision = page.getByRole("dialog", { name: "Decision" }).getByTestId("decision");
  await expect(decision.getByRole("heading", { name: "Decision", level: 2 })).toBeVisible();
  await expect(decision.getByTestId("decision-result").getByText("Accepted without you", { exact: true })).toBeVisible();
  await expect(decision.getByTestId("decision-actions")).toHaveCount(0);
  await expect(decision.getByTestId("decision-result").getByText(/^Accepted without you, as this run is fully autonomous: every check passed, the reviewer said it looks right and what it checked, and /)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Decision" })).toHaveCount(0);

  // The checks: the first build's failed, the round of fixes for it passed, and so did the work after the review's round.
  // The verification card holds the latest round; every round is behind one disclosure under it.
  await expect(page.getByTestId("verification").getByTestId("verification-heading")).toHaveText("1 of 1 check passed");
  const checks = page.getByTestId("check-rounds");
  await checks.locator(":scope > summary").click();
  const firstBuild = checks.locator("details.ds-disclosure", { has: page.locator("summary", { hasText: /^Checks of the first build$/ }) });
  await firstBuild.locator(":scope > summary").click();
  await expect(firstBuild.locator(".ds-check-list__summary")).toHaveText("0 of 1 check passed. 1 failed.");
  await expect(firstBuild.locator(".ds-check-list__result")).toHaveText("Failed, exit code 1");
  await expect(firstBuild.locator(".ds-check-list__name")).toHaveText(world.check);
  await firstBuild.locator(".ds-check-list__toggle").click();
  await expect(firstBuild.locator(".ds-check-list__log")).toContainText(`FAIL: the changelog rule: CHANGELOG.md needs a line that names calc.py and this change's ticket, ${world.token}`);
  // The failure went back to the builder as a round of fixes, and the checks on its fix passed.
  const afterFix = checks.locator("details.ds-disclosure", { has: page.locator("summary", { hasText: /^Checks after round 1 of fixes$/ }) });
  await afterFix.locator(":scope > summary").click();
  await expect(afterFix.locator(".ds-check-list__summary")).toHaveText("1 of 1 check passed.");
  await expect(afterFix.locator(".ds-check-list__result")).toHaveText("Passed");

  // The review: Codex raised a concern on the first version, Claude Code answered it with a change, and Codex was satisfied.
  // The verification card names the reviewer with the outcome; each review and round of fixes is one tap away.
  const review = page.getByTestId("verification");
  await expect(review.getByTestId("review-by")).toHaveText(/^Codex, /);
  await expect(review.getByTestId("review-outcome")).toHaveText(/^Codex raised (concerns|\d+ concerns?)\. Claude Code (addressed \d+( and explained \d+)?|replied to them)\. Codex is satisfied\.$/);
  await review.getByTestId("review-detail").click();
  await expect(page.getByTestId("review-round")).toHaveCount(2);
  await expect(page.getByTestId("review-round").nth(0).getByTestId("review-verdict")).toHaveText(/^Verdict: concerns, in /);
  await expect(page.getByTestId("fixes-round")).toHaveCount(1);
  await expect(page.getByTestId("fixes-summary")).toHaveText(/^(Addressed \d+(, explained \d+)?|Changed the work)(\. Committed as [0-9a-f]{7}, and the checks ran again on it\.)?$/);
  await expect(page.getByTestId("review-round").nth(1).getByTestId("review-verdict")).toHaveText(/^Verdict: looks right, in /);
  await expect(page.getByTestId("review-round").nth(1).getByTestId("review-checked")).toBeVisible();

  // Its pull request, through the replayed real gh: a number and a link, the branch on the shared remote, nothing merged.
  await expect(page.getByTestId("pull-request-state")).toHaveText(`The branch is on origin, and Botbench opened pull request #${prNumber} into main. Nothing was merged.`, { timeout: 120_000 });
  const link = page.getByRole("link", { name: `Pull request #${prNumber} on GitHub (opens in a new tab)` });
  await expect(link).toHaveAttribute("href", created);
  await judge(page, "A, the task, accepted without you, with its pull request", "a-task-accepted", page.getByTestId("pull-request-state"));

  const task = (await (await page.request.get(`${alice.base}/api/tasks/${taskId}`)).json()) as { branch: string; headCommit: string; decision: { decision: string; decidedBy: string } };
  expect([task.decision.decision, task.decision.decidedBy], "no decision was made by the owner").toEqual(["accept", "mode"]);
  expect(task.branch).toMatch(new RegExp(`^botbench/alice/run-${runA}/task-${taskId}$`));
  const delivered = remoteBranches(world.bare);
  expect(delivered.get(task.branch), "the task's branch is on the shared remote at its head commit").toBe(task.headCommit);
  // What was delivered fixes the review's concern and the check's failure, not only a summary that says so.
  const deliveredCalc = git(world.bare, "show", `${task.headCommit}:calc.py`);
  expect(deliveredCalc, "the delivered add adds").toMatch(/return a \+ b/);
  expect(deliveredCalc, "the delivered add no longer subtracts").not.toMatch(/return a - b/);
  expect(git(world.bare, "show", `${task.headCommit}:CHANGELOG.md`).split("\n").some((line) => line.includes("calc.py") && line.includes(world.token)), "the delivered changelog has the line the check wants").toBe(true);
  expect(delivered.get(lock), "A's claim stays, as its run opened a pull request").toBe(claimed.get(lock));
  expect(delivered.get(claimBranch)).toBe(claimed.get(lock));
  expect([...delivered.keys()].filter((branch) => branch.startsWith("botbench/bob/")), "nothing of B's is on the remote").toEqual([]);

  // The run's screen: done, its one task with its pull request.
  await page.goto(`${alice.base}/#/runs/${runA}`);
  await expect(page.getByTestId("run-task-pull-request")).toHaveText(`The branch is on origin, and Botbench opened pull request #${prNumber} into main. Nothing was merged.`);
  await judge(page, "A, the run, done with its pull request", "a-run-done", page.getByTestId("run-task-pull-request"), undefined, (shown, name) => checkScreen(shown, name, { least: true }));
  // On a phone the run screen's navigation is behind its menu button; the bar's own link leads to Work.
  await page.getByRole("navigation", { name: "Where this is" }).getByRole("link", { name: "Work" }).click();
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
  await judge(page, "A, Work", "a-work", page.getByRole("heading", { name: "Work", level: 1 }), undefined, (shown, name) => checkScreen(shown, name, { least: true }));

  // B's Work lists A's claim and A's pushed branch under Other workbenches; B built nothing of its own.
  await pageB.goto(`${bob.base}/#/work`);
  const others = pageB.getByTestId("other-workbenches");
  await expect(others.getByTestId("peer-claim").filter({ hasText: `issue #${ISSUE_NUMBER}` })).toContainText(`alice · Started on issue #${ISSUE_NUMBER}`);
  // The view of a repository is kept for a minute (src/engine/peers.ts): read again until it lists A's pushed branch.
  await expect(async () => {
    await pageB.reload();
    await expect(others).toContainText(task.branch, { timeout: 5_000 });
  }).toPass({ timeout: 180_000, intervals: [5_000] });
  await judge(pageB, "B, Work, with A's claim and branch", "b-work", others, undefined, (shown, name) => checkScreen(shown, name, { least: true }));
  expect(git(world.bob, "for-each-ref", "--format=%(refname:short)", "refs/heads/botbench/").trim(), "B made no task branch").toBe("");

  expect(foreignA).toEqual([]);
  expect(foreignB).toEqual([]);
});
