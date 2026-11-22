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
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Botbench");

  await signIn(page, botbench);
  const name = page.locator("header a", { hasText: "Botbench" });
  const mark = name.locator("img");
  await expect(mark).toBeVisible();
  // Decorative: the link's words already say the name, so the mark is not announced a second time.
  await expect(mark).toHaveAttribute("alt", "");
  expect(await mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), "the mark loaded").toBe(true);
  await expect(page.getByRole("link", { name: "Botbench", exact: true })).toBeVisible();
  await checkDesign(page, "brand");
});
