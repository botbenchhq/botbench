import { checkDesign, expect, signIn, test } from "./helpers.ts";

// The brand marks in the real client, at a phone's size: a real Botbench process serving the built client. No CLI turn.

test("the page names its icons and Botbench serves them before sign-in; the header shows the mark beside the name", async ({ page, botbench }) => {
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
  const name = page.locator("header a", { hasText: "Botbench" });
  const mark = name.locator("svg");
  await expect(mark).toBeVisible();
  // Decorative: the link's words already say the name, so the mark is hidden from assistive technology.
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("link", { name: "Botbench", exact: true })).toBeVisible();
  // The mark is drawn in the text colour, in dark and in light, with no second drawing for either.
  const colours = () => name.evaluate((a) => ({ text: getComputedStyle(a).color, fills: [...a.querySelectorAll("path")].map((p) => getComputedStyle(p).fill) }));
  const dark = await colours();
  expect(dark.fills, "both brackets take the text colour in dark").toEqual([dark.text, dark.text]);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect.poll(async () => (await colours()).text, { message: "the text colour changes with the mode" }).not.toBe(dark.text);
  const light = await colours();
  expect(light.fills, "both brackets take the text colour in light").toEqual([light.text, light.text]);
  await checkDesign(page, "brand");
});
