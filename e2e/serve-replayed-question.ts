import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { buildReplayDriver } from "../test/support/replay-build.ts";
import { questionTurn } from "../test/support/replay-question.ts";

// A test-only way to start Botbench whose Claude Code replays the real session in which it asked its user one question
// (test/recordings/ask-question.json, made by test/support/capture-question.ts: the owner's approved exception), for a
// browser test of the question's card with no model turn. Its one attempt plays that turn: the question reaches the real
// broker, waits for the owner, and goes on once answered. It lives under e2e/ and is started only by e2e/botbench.ts
// when a test names it: src/server.ts, which production runs, has no way to reach it. Everything else is the real start.

const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const claudeCode = buildReplayDriver([questionTurn()]);
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, claudeCode });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (builder replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
