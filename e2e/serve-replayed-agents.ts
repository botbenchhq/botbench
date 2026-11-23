import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { chatReplayDriver } from "../test/support/replay-chat.ts";

// A test-only way to start Botbench whose Codex, Grok and Antigravity replay sessions captured from their real CLIs
// (test/recordings/chat-turns.json, test/support/replay-chat.ts: the owner's approved exception): each chat message to
// one of them plays its recorded answer, through Botbench's own reader for that CLI. Everything Botbench does around
// them is the real thing: the request's checks, the repository a chat reads, the store and the screen. It lives under
// e2e/ and is started only by e2e/botbench.ts when a test names it: src/server.ts, which production runs, cannot reach it.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const reviewers = { codex: chatReplayDriver("codex"), grok: chatReplayDriver("grok"), antigravity: chatReplayDriver("antigravity") };
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, reviewers });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (chat agents replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
