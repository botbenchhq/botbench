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
    channel: "chrome",
    headless: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
  },
});
