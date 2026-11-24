import { checkDesign, expect, goTo, signIn, test } from "./helpers.ts";
import { checkNext, openSettingsGroup } from "./settings-helpers.ts";

// Staying signed in, in the real client at a phone's size, with no model turn: a real Botbench process that is
// stopped and started again on the same data, and the Settings list of signed-in devices.

test("a device stays signed in across a restart; Settings lists it as this device, and Sign out returns to the sign-in screen", async ({ page, botbench }) => {
  await signIn(page, botbench);
  await botbench.restart();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);

  await openSettingsGroup(page, "connections");
  const devices = page.getByTestId("devices");
  await expect(devices.getByRole("heading", { name: "Signed-in devices" })).toBeVisible();
  const rows = devices.getByTestId("device");
  await expect(rows).toHaveCount(1);
  // Headless Chrome on this Mac.
  await expect(rows.first()).toContainText("Mac · Chrome");
  await expect(rows.first()).toContainText("This device");
  await expect(rows.first()).toContainText(/Signed in .+\. Last used .+\./);
  await expect(devices.getByRole("button", { name: "Sign out everywhere else" })).toHaveCount(0);
  await devices.scrollIntoViewIfNeeded();
  await checkNext(page, "settings, signed-in devices");

  await devices.getByRole("button", { name: "Sign out this device" }).click();
  const dialog = page.getByTestId("sign-out-dialog");
  await expect(dialog).toBeVisible();
  await checkNext(page, "settings, sign out this device?");
  await dialog.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // The session is gone on the server, not only on this screen.
  expect((await page.request.get(`${botbench.base}/api/session`)).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await checkNext(page, "sign-in, after signing out");
});
