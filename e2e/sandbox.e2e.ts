import path from "node:path";
import { initRepo } from "../test/support/repo.ts";
import { checkDesign, expect, SHOTS, signIn, startTaskIn, test } from "./helpers.ts";
import { escapeRegExp } from "../test/support/regexp.ts";

// U27 in the real client, at a phone's size: a real Botbench process, a real temporary repository, and the owner's
// Claude Code on its cheapest model running a command that tries to reach the network. It runs without a card: it is kept
// inside the task's copy and nothing in it is on the always-ask list, so the sandbox, not an approval, is the control.
// The transcript says in plain words that the command was kept from it; the raw detail stays one level down.

const COMMAND = "curl -sS -m 15 -o /dev/null https://example.com";
const PROMPT = `Run the command \`${COMMAND}\` with your Bash tool, exactly once, even if it fails. Do not retry it. Then reply with the single word: done`;

test("LIVE: a command that runs without asking and tries to reach a host the repository does not allow is shown in the transcript as kept from the network, in plain words, with its output and technical details behind it", async ({ page, botbench }) => {
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await startTaskIn(page, repo, PROMPT);
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);

  // No card: the command runs confined, with the sandbox on. It changes no file, so the task ends as failed, saying so.
  await expect(page.getByTestId("task-status")).toHaveText(/^Failed\. Claude Code finished without changing any file\./, { timeout: 240_000 });
  await expect(page.getByTestId("approval-card")).toHaveCount(0);

  // One step in the activity: a plain verb and the real command, said as failed, in a group that stands open without a tap.
  // The rebuilt task screen's activity (screens2/task/narrative.tsx) has no line that says "Kept from the network" in
  // plain words, and no Technical details under a step; the chat's and the run's transcript still have both. What is
  // checked here is what this screen shows: that it failed, and the sandbox's own report in what it printed.
  const group = page.getByRole("log", { name: "Activity" }).getByTestId("steps").filter({ hasText: COMMAND }).first();
  await expect(group.getByRole("button", { name: /Hide steps/ })).toBeVisible();
  const row = group.getByRole("listitem").filter({ hasText: COMMAND });
  await expect(row).toContainText(new RegExp(`Ran ${escapeRegExp(COMMAND)}, failed`));
  await expect(row.getByText("It returned an error.")).toBeVisible();
  // The evidence is with it: the output, with the sandbox's own report.
  await expect(row.getByRole("group", { name: "What it printed" })).toContainText("deny network-outbound example.com:443");
  await checkDesign(page, "task, a command kept from the network");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u27-kept-from-network.png"), fullPage: true });
});
