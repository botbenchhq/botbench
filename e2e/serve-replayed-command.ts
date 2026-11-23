import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { buildReplayDriver } from "../test/support/replay-build.ts";

// A test-only way to start Botbench whose Claude Code replays a turn recorded from a real Claude Code session
// (test/support/replay-build.ts: the owner's approved exception): the "ask" turn, in which the real CLI asked to run
// `sh other.sh`, was allowed, and returned. With `run`, the replay runs that command for real in the task's copy and plays
// the CLI's result only once it has exited, so the task stays at work, printing nothing, for as long as the test's own
// other.sh runs: what the task screen shows while a quiet command runs (#198). It lives under e2e/ and is started only by
// e2e/botbench.ts when a test names it: src/server.ts, which production runs, has no way to reach it.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const claudeCode = buildReplayDriver(["ask"], { run: {} });
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, claudeCode });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (builder replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
