import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { ANTIGRAVITY, AntigravityDriver } from "../src/drivers/antigravity.ts";
import { CODEX } from "../src/drivers/codex.ts";
import { GROK, GrokDriver } from "../src/drivers/grok.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { buildReplayDriver } from "../test/support/replay-build.ts";
import { claudeChatReplay } from "../test/support/replay-chat.ts";
import { reviewReplayDriver } from "../test/support/replay-review.ts";

// A start of Botbench for the pictures and clips of the README and the website (e2e/media.shots.ts), with no model
// turn. Claude Code, as a builder, replays the turn recorded from a real session in which it read calc.py and changed
// `a - b` to `a + b` (test/support/replay-build.ts "refine"); Codex, as the reviewer, replays its recorded review of
// that fixed work, the one that says what it checked (test/support/replay-review.ts "checked-review"). Both are the
// owner's approved exception. In a chat, Claude Code replays the recorded turn that asked to fetch https://example.com
// (test/support/replay-chat.ts). Each build is held once its session has opened, so the task is at work while a picture
// is taken, until the file `release-builder-<n>` (n from 0, in the order the builds started) is written beside the
// data folder. It lives under e2e/ and is started only by e2e/botbench.ts when media.shots.ts names it: src/server.ts,
// which production runs, has no way to reach it. Everything else is the real start.
const BUILDS = 6;

const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const configured = (name: typeof GROK | typeof ANTIGRAVITY) => ({ models: config.drivers[name]?.models ?? [], ...(config.drivers[name]?.model ? { defaultModel: config.drivers[name].model } : {}) });
const builds = Array.from({ length: BUILDS }, (_, n) => n);
const claudeCode = buildReplayDriver(builds.map(() => "refine" as const), { hold: builds, holdAt: "session" });
const reviewers = { [CODEX]: reviewReplayDriver(builds.map(() => "checked-review" as const)), [GROK]: new GrokDriver(configured(GROK)), [ANTIGRAVITY]: new AntigravityDriver({ dataDir: settings.homes.home, ...configured(ANTIGRAVITY) }) };
const waiting = new Set(builds);
const watch = setInterval(() => {
  for (const n of waiting) {
    if (!fs.existsSync(path.join(path.dirname(settings.homes.home), `release-builder-${n}`))) continue;
    waiting.delete(n);
    claudeCode.release(n);
  }
}, 50);
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, claudeCode, chatClaude: claudeChatReplay(["allowed"]), reviewers });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (builder and reviewer replayed, for pictures)`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(watch);
    void server.close();
  });
