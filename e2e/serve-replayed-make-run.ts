import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { buildReplayDriver } from "../test/support/replay-build.ts";
import { claudeChatReplay } from "../test/support/replay-chat.ts";

// A test-only way to start Botbench for "Make this a run" (e2e/make-run.e2e.ts), whose Claude Code replays turns recorded
// from real Claude Code sessions (the owner's approved exception), read as they are: as a task's builder, the real turn
// that changed `a - b` to `a + b` in calc.py with its Edit tool (test/support/replay-build.ts "refine"), so a task really
// is ready for review; and in a chat the real turn the owner allowed to fetch a page (test/support/replay-chat.ts
// "allowed"). Each recorded call is put to the real permission gate. No run is planned: the test never presses Send.
// It lives under e2e/ and is started only by e2e/botbench.ts when a test names it: src/server.ts, which production runs,
// has no way to reach it. Everything else is the real start.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, claudeCode: buildReplayDriver(["refine"]), chatClaude: claudeChatReplay(["allowed"]) });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (builder and chat replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
