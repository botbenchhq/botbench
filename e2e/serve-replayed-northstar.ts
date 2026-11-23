import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { ANTIGRAVITY, AntigravityDriver } from "../src/drivers/antigravity.ts";
import { CODEX } from "../src/drivers/codex.ts";
import { GROK, GrokDriver } from "../src/drivers/grok.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { replayGitHub } from "../test/support/replay-github.ts";
import { replayIssues } from "../test/support/replay-issue.ts";
import { replayPeers } from "../test/support/replay-peers.ts";
import { reviewReplayDriver } from "../test/support/replay-review.ts";

// A test-only way to start Botbench for the North Star test (e2e/northstar.e2e.ts). Claude Code is the real one, as
// src/server.ts starts it. What is replayed, each from output captured once from the real tool (the owner's approved
// exception): gh, for the pull request a delivery opens (test/support/replay-github.ts), an issue read
// (test/support/replay-issue.ts) and a repository's pull requests (test/support/replay-peers.ts); and the reviewer
// Codex, whose first review is the real one of a diff that adds calc.py with `return a - b` (verdict concerns) and
// whose second is the real one of the fixed work that says what it checked (test/support/replay-review.ts). It lives
// under e2e/ and is started only by e2e/botbench.ts when a test names it: src/server.ts, which production runs, has no
// way to reach it. Everything else is the real start: the same settings from the environment, the same store, the
// same server.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const configured = (name: typeof GROK | typeof ANTIGRAVITY) => ({ models: config.drivers[name]?.models ?? [], ...(config.drivers[name]?.model ? { defaultModel: config.drivers[name].model } : {}) });
const github = replayPeers(replayIssues(replayGitHub().github).github).github;
const reviewers = { [CODEX]: reviewReplayDriver(["review", "checked-review"]), [GROK]: new GrokDriver(configured(GROK)), [ANTIGRAVITY]: new AntigravityDriver(configured(ANTIGRAVITY)) };
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, github, reviewers });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (gh and the reviewer replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
