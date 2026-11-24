import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";
import { buildReplayDriver } from "../test/support/replay-build.ts";

// A test-only way to start Botbench whose Claude Code replays turns recorded from real Claude Code sessions
// (test/support/replay-build.ts: the owner's approved exception), for a task screen test that needs no model turn. Its
// first attempt plays the recorded "done" turn twice, as two messages of one session: the task's own prompt and the
// owner's note. The first is held once its prompt is recorded, so the task stays building while the test acts, until the
// test writes the file `release-builder` beside the data folder. Each recorded call is put to the real permission gate.
// It lives under e2e/ and is started only by e2e/botbench.ts when a test names it: src/server.ts, which production runs,
// has no way to reach it. Everything else is the real start.
const RELEASE_FILE = "release-builder";

const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
// A second attempt, for a test that stops the first and resumes the task (e2e/task-screens.e2e.ts): the same recorded turn, once.
const claudeCode = buildReplayDriver([["done", "done"], ["done"]], { hold: [0] });
const release = path.join(path.dirname(settings.homes.home), RELEASE_FILE);
const watch = setInterval(() => {
  if (!fs.existsSync(release)) return;
  clearInterval(watch);
  claudeCode.release(0);
}, 50);
const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home: settings.homes.home, claudeCode });
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (builder replayed, for tests)`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(watch);
    void server.close();
  });
