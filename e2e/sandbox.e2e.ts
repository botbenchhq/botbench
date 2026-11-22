import path from "node:path";
import { initRepo } from "../test/support/repo.ts";
import { SHOTS, checkDesign, expect, signIn, startTaskIn, test } from "./helpers.ts";

// U27 in the real client, at a phone's size: a real Botbench process, a real temporary repository, and the owner's
// Claude Code on its cheapest model running, once the owner allows it, a command that tries to reach the network.
// The transcript says in plain words that the command was kept from it; the raw detail stays one level down.

const COMMAND = "curl -sS -m 15 -o /dev/null https://example.com";
const PROMPT = `Run the command \`${COMMAND}\` with your Bash tool, exactly once, even if it fails. Do not retry it. Then reply with the single word: done`;

test("LIVE: a command the owner allowed that tries to reach a host the repository does not allow is shown in the transcript as kept from the network, in plain words, with its output and technical details behind it", async ({ page, botbench }) => {
  const repo = path.join(path.dirname(botbench.home), "sample-repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  await signIn(page, botbench);
  await startTaskIn(page, repo, PROMPT);
  await expect(page.getByTestId("task-name")).toHaveText(/^Task 1 · /);

  // The permission check still asks first, with the sandbox on.
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId("approval-command")).toHaveText(COMMAND);
  const allow = card.getByRole("button", { name: "Allow once" });
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(page.getByTestId("task-status")).toHaveText(/^Ready for review\./, { timeout: 120_000 });

  // One row, the design system's tool call: Failed, a plain verb and the real command, and why in a plain note; open without a tap.
  const row = page.locator('[data-event="tool_call"]').filter({ hasText: COMMAND }).first().locator(".ds-tool-call");
  await expect(row).toHaveAttribute("data-state", "failed");
  await expect(row.locator(".ds-tool-call__title")).toHaveText(new RegExp(`^Failed\\s*Ran\\s*${COMMAND.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`));
  await expect(row.getByTestId("confined")).toHaveText("Kept from the network. Its output says a connection to example.com:443 was not allowed. The agent's commands reach only the hosts allowed for this repository in Botbench's settings file, and none when no host is.");
  await expect(row.locator("details").first()).toHaveAttribute("open", "");
  // The evidence is behind it: the output, with the sandbox's own report, and the raw arguments one level deeper.
  await expect(row.locator('[data-event="tool_result"]')).toContainText("deny network-outbound example.com:443");
  await expect(row).toContainText("Technical details");
  await checkDesign(page, "task, a command kept from the network");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "u27-kept-from-network.png"), fullPage: true });
});
