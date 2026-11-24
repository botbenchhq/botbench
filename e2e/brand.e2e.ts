import { checkDesign, expect, openWork, signIn, test } from "./helpers.ts";

// The brand marks in the real client, at a phone's size: a real Botbench process serving the built client. No CLI turn.

test("the page names its icons and Botbench serves them before sign-in; the navigation shows the mark beside the name", async ({ page, botbench }) => {
  await page.goto(botbench.base);

  // Before sign-in: the tab icon and the home-screen icon are real files of the right kind.
  const icon = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute("href");
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(icon, "an SVG tab icon is named").toBeTruthy();
  expect(touch, "a home-screen icon is named").toBeTruthy();
  const iconResponse = await page.request.get(new URL(icon!, botbench.base).href);
  expect(iconResponse.status()).toBe(200);
  expect(iconResponse.headers()["content-type"]).toBe("image/svg+xml");
  const touchResponse = await page.request.get(new URL(touch!, botbench.base).href);
  expect(touchResponse.status()).toBe(200);
  expect(touchResponse.headers()["content-type"]).toBe("image/png");
  const touchPng = await touchResponse.body();
  expect(`${touchPng.readUInt32BE(16)}x${touchPng.readUInt32BE(20)}`, "the home-screen icon is 180 by 180").toBe("180x180");
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Botbench");

  await signIn(page, botbench);
  // The mark stands at the head of the navigation's pane, which a window has from 1024px; a phone has the bar at its foot and no room for it.
  await openWork(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const name = page.locator('[data-slot="sidebar-header"] a', { hasText: "Botbench" });
  const mark = name.locator("svg");
  await expect(mark).toBeVisible();
  // 20px in the navigation, on every screen.
  expect(await mark.evaluate((svg) => [svg.getBoundingClientRect().width, svg.getBoundingClientRect().height])).toEqual([20, 20]);
  // Decorative: the link's words already say the name, so the mark is hidden from assistive technology.
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("link", { name: "Botbench", exact: true })).toBeVisible();
  // The mark is two-tone, one drawing for dark and light: its first bracket takes the text colour, its second the
  // brand cyan of the mode shown (#06B6D4 in dark, #03748F in light, as in assets/svg/botbench-mark-two-tone-*.svg).
  const colours = () => name.evaluate((a) => ({ text: getComputedStyle(a).color, fills: [...a.querySelectorAll("path")].map((p) => getComputedStyle(p).fill) }));
  const dark = await colours();
  expect(dark.fills, "the text colour, then the brand cyan, in dark").toEqual([dark.text, "rgb(6, 182, 212)"]);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect.poll(async () => (await colours()).text, { message: "the text colour changes with the mode" }).not.toBe(dark.text);
  const light = await colours();
  expect(light.fills, "the text colour, then the brand cyan, in light").toEqual([light.text, "rgb(3, 116, 143)"]);

  // The tab icon is the same two-tone artwork, with the same two cyans.
  const iconText = await iconResponse.text();
  expect(iconText).toContain("#06B6D4");
  expect(iconText).toContain("#03748F");
  await checkDesign(page, "brand");
});
