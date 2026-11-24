import fs from "node:fs";
import { chromium } from "@playwright/test";
import { tempDir } from "./botbench.ts";
import { checkDesign, checkScreen, expect, signIn, test, THEME_COLOR } from "./helpers.ts";

// Installing Botbench, in the real client at a phone's size: a real Botbench process serving the built client, and
// Chrome's own installability checks read through its DevTools protocol. No CLI turn.
//
// Not proven here, and said plainly: an automated Chrome cannot subscribe to a real push service (Google's refuses a
// headless browser with no account), so this test never turns notifications on and never receives one. Subscribing,
// delivery through Apple's push service, the notification on the lock screen and tapping it to open the waiting
// approval are proven on the owner's iPhone only. The server's half (stored subscription, one encrypted push per device
// that a real client can decrypt, expiry) is in test/api/push.test.ts.

test("the manifest and service worker pass Chrome's install checks, the worker registers at the root, and Settings shows the true notification state", async ({ botbench }) => {
  // A profile of its own on disk, at the same phone size: Chrome refuses to install from an incognito profile, which is
  // what a test's usual browser context is, so its install check would only ever say that.
  const profile = tempDir("botbench-install-profile-");
  const context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
  await page.goto(botbench.base);

  // Before sign-in: the service worker registers for the whole app.
  const worker = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, script: reg.active?.scriptURL ?? null };
  });
  expect(worker).toEqual({ scope: `${botbench.base}/`, script: `${botbench.base}/sw.js` });

  const cdp = await page.context().newCDPSession(page);
  const manifest = (await cdp.send("Page.getAppManifest")) as { url: string; errors: unknown[]; data?: string };
  expect(manifest.url).toBe(`${botbench.base}/manifest.webmanifest`);
  expect(manifest.errors, "the manifest parses without errors").toEqual([]);
  const parsed = JSON.parse(manifest.data ?? "{}") as { name?: string; display?: string; theme_color?: string; background_color?: string; icons?: { src: string; sizes: string; purpose: string }[] };
  expect(parsed).toMatchObject({ name: "Botbench", display: "standalone", theme_color: THEME_COLOR.dark, background_color: THEME_COLOR.dark });
  expect(parsed.icons?.map((icon) => `${icon.src} ${icon.purpose}`)).toEqual(["/icons/icon-192.png any", "/icons/icon-512.png any", "/icons/icon-maskable-192.png maskable", "/icons/icon-maskable-512.png maskable"]);
  for (const icon of parsed.icons ?? []) {
    const res = await page.request.get(new URL(icon.src, botbench.base).href);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    // A real PNG at the size the manifest declares.
    const png = await res.body();
    expect(png.subarray(1, 4).toString("latin1"), `${icon.src} is a PNG`).toBe("PNG");
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, `${icon.src} is the size it declares`).toBe(icon.sizes);
  }
  // Chrome's own verdict on whether the page can be installed: no reason against it.
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);

  // Settings: notifications are off on a browser that has not been asked, and the one control to allow them is there.
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/settings/connections`);
  const section = page.getByRole("group", { name: "Notifications" });
  await expect(section.getByTestId("notifications-state")).toHaveText("Off");
  await expect(section.getByRole("button", { name: "Allow notifications" })).toBeEnabled();
  await expect(section.getByRole("button", { name: "Send a test notification" })).toHaveCount(0);
  await checkScreen(page, "settings, notifications off");

  // Refused in the browser itself (a real browser setting, made through Chrome's own protocol): said so, and no control offered.
  await cdp.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "denied", origin: botbench.base });
  await page.reload();
  await expect(section.getByTestId("notifications-state")).toHaveText("Not allowed in the browser's settings");
  await expect(section.getByRole("button")).toHaveCount(0);
  await checkScreen(page, "settings, notifications blocked");
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
