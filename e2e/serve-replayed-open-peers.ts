import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { replayIssues } from "../test/support/replay-issue.ts";
import { replayOpenPeers } from "../test/support/replay-peers.ts";

// A test-only way to start Botbench whose list of open pull requests is the one captured once from the real gh while
// pull requests from named workbenches' task branches were open (test/recordings/gh-peers-open.json, replayed by
// test/support/replay-peers.ts: the owner's approved exception). It lives under e2e/ and is started only by
// e2e/botbench.ts when a test names it (e2e/media.shots.ts): src/server.ts, which production runs, has no way to reach
// it. Everything else is the real start: the same settings from the environment, the same store, the same server.
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, github: replayOpenPeers(replayIssues().github).github });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (open pull requests replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
