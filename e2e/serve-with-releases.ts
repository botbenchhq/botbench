import { DEFAULT_CONFIG_FILE, loadConfig } from "../src/config.ts";
import { startServer, startupSettings } from "../src/server.ts";

// A test-only way to start Botbench that looks for releases at a test's own address (a real HTTP server serving
// GitHub's captured latest-release answer, test/support/releases.ts), fetches them from a test's own git repository,
// and updates the test's own installation, never this checkout. It lives under e2e/ and is started only by
// e2e/botbench.ts when a test names it: src/server.ts, which production runs, has no way to reach it. Everything else
// is the real start: the same settings from the environment, the same store, the same server.
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const settings = startupSettings(process.env, (line) => console.log(line));
const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
const server = await startServer({
  config: { ...config, port: settings.port ?? config.port },
  home: settings.homes.home,
  installDir: env("BOTBENCH_TEST_INSTALL"),
  updates: { releasesUrl: env("BOTBENCH_TEST_RELEASES"), gitUrl: env("BOTBENCH_TEST_GIT"), serviceLabel: "dev.botbench.test-no-such-service" },
});
for (const address of server.addresses) console.log(`Botbench is listening on http://${address}:${server.port} (releases from a test's server)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void server.close());
