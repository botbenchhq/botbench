import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { replayIssues } from "../test/support/replay-issue.ts";
import { replayWatchGh, replayWatchIssue } from "../test/support/replay-watch.ts";

// A test-only way to start Botbench whose issue watch and issue reads are replayed from output captured once from the
// real gh for jon-lange/botbench (test/support/replay-watch.ts: the owner's approved exception). It lives under e2e/
// and is started only by e2e/botbench.ts when a test names it: src/server.ts, which production runs, has no way to
// reach it. Everything else is the real start: the same settings from the environment, the same store, the same server.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, watchGh: replayWatchGh().run, github: replayWatchIssue(replayIssues().github) });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (gh replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
