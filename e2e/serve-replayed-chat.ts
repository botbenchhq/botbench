import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { claudeChatReplay } from "../test/support/replay-chat.ts";

// A test-only way to start Botbench whose Claude Code, in a chat only, replays real chat turns that asked to fetch
// https://example.com (test/recordings/chat-fetch.json, test/support/replay-chat.ts: the owner's approved exception):
// the first chat turn plays the one the owner allowed, every later one the one the owner denied. Each recorded call is
// put to the real permission gate. It lives under e2e/ and is started only by e2e/botbench.ts when a test names it:
// src/server.ts, which production runs, has no way to reach it. Everything else is the real start.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, chatClaude: claudeChatReplay(["allowed", "declined"]) });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (chat replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
