import fs from "node:fs";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { buildReplayDriver, type AttemptScript } from "./replay-build.ts";

/*
 * One Botbench installation as its own process, for the tests of two workbenches pairing (test/peers/two-workbenches
 * .test.ts). It loads the settings as the entry point does, from the defaults and the settings file the test wrote
 * (which turns the peer listener on), opens the real store in its own data folder and serves the owner's API and the
 * peer listener on loopback. The one thing it sets that the entry point does not is a shorter invite life, so the
 * expiry can be seen without a changed clock.
 *
 * With a builder script, its Claude Code is a replay of recorded real sessions (test/support/replay-build.ts), and the
 * prompts it was sent are written to `promptsFile` as they arrive.
 *
 * Argument: one JSON object { home, settings, inviteLifeMs?, script?, promptsFile? }. Prints "ready <owner port> <peer address>" once
 * listening; SIGTERM closes it as the entry point's signal does.
 */

const order = JSON.parse(process.argv[2] ?? "{}") as { home: string; settings: string; inviteLifeMs?: number; script?: AttemptScript[]; promptsFile?: string };
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: order.settings });
// A builder script: the turns of real Claude Code sessions, replayed through the driver contract (test/support/replay-build.ts).
const builder = order.script === undefined ? undefined : buildReplayDriver(order.script);
if (builder !== undefined && order.promptsFile !== undefined) {
  const file = order.promptsFile;
  setInterval(() => fs.writeFileSync(file, JSON.stringify(builder.prompts)), 100).unref();
}
const server = await startServer({ config, home: order.home, ...(order.inviteLifeMs === undefined ? {} : { peerInviteLifeMs: order.inviteLifeMs }), ...(builder === undefined ? {} : { claudeCode: builder }) });
console.log(`ready ${server.port} ${server.peerAddress}`);
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
