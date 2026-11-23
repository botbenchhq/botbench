import { defineConfig } from "@playwright/test";

// The tests start their own Botbench processes (see botbench.ts) and drive the built
// client in the Chrome installed on this machine, at a phone's size.
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  outputDir: "../test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    // An action waits for its element at most this long, not until the test's own time limit: a stale locator or a
    // select option the screen no longer offers (`selectOption` waits for it to appear) fails here, saying what it
    // waited for, instead of hanging a live journey that gives itself 20 minutes. Waiting on a model is done with
    // `expect`, never with an action.
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    channel: "chrome",
    headless: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
  },
  projects: [
    // The whole *.e2e.ts suite, with the settings above: a phone's size, 390x844.
    { name: "phone" },
    // The design checks at a desktop's size, 1280x800: only design-checks.desktop.ts, which the phone project's
    // *.e2e.ts does not match, so no test runs in both projects.
    { name: "desktop", testMatch: "design-checks.desktop.ts", use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false } },
  ],
});
