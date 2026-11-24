import type { Browser, Page } from "@playwright/test";
import { checkDesign, checkWords, expect, messageBox, signIn, test } from "./helpers.ts";

// Adding a device with a one-time code, in the real client at a phone's size, with no model turn: Settings → Add a
// device on a signed-in browser, and the sign-in screen on a second browser, which has no session of its own.

/** The code Settings shows, as its screen-reader text gives it: "Code: ABCD-EFGH". */
async function codeShown(page: Page): Promise<string> {
  const text = (await page.getByTestId("pairing-code").textContent()) ?? "";
  const found = /Code: ([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/.exec(text);
  expect(found, `the code in ${JSON.stringify(text)}`).not.toBeNull();
  return found![1]!;
}

/**
 * What Chrome's own QR reader finds in the QR code as drawn on the screen, from a screenshot of its pixels. The reader
 * now and then finds nothing in a good screenshot (about one run in ten), so callers read it again until it agrees.
 */
async function readQr(page: Page): Promise<string[]> {
  // Centred, so the fixed tab bar at the foot of the screen does not cover part of it in the screenshot.
  const qr = page.getByTestId("pairing-qr");
  await qr.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const png = await qr.screenshot();
  return page.evaluate(async (bytes) => {
    const Detector = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(image: ImageBitmap): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (Detector === undefined) return ["this Chrome has no BarcodeDetector"];
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    return (await new Detector({ formats: ["qr_code"] }).detect(image)).map((found) => found.rawValue);
  }, [...png]);
}

/** A second browser with nothing of the first: no cookie, no storage. */
async function otherDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  return context.newPage();
}

test("Add a device shows a one-time code and its QR code; a second browser signs in with it once, and a used or replaced code is refused", async ({ page, browser, botbench }) => {
  await signIn(page, botbench);
  await page.goto(`${botbench.base}/#/settings`);
  const devices = page.getByTestId("devices");
  await expect(devices.getByTestId("device")).toHaveCount(1);
  await devices.getByRole("button", { name: "Add a device" }).click();
  const pairing = page.getByTestId("pairing");
  await expect(pairing).toBeVisible();
  const first = await codeShown(page);
  await expect(pairing).toContainText(/It works once, for 5 minutes: until \d{1,2}:\d{2}/);
  await expect(pairing).toContainText(botbench.base);
  // The QR code holds the sign-in address with the code in it, after `#`.
  await pairing.getByTestId("pairing-qr").scrollIntoViewIfNeeded();
  await expect.poll(() => readQr(page), { message: "the QR code reads as the sign-in address" }).toEqual([`${botbench.base}/#code=${first}`]);

  // Asking again replaces the code shown, and the QR code with it.
  await devices.getByRole("button", { name: "Make a new code" }).click();
  await expect(page.getByTestId("pairing-code")).not.toContainText(first);
  const code = await codeShown(page);
  await expect.poll(() => readQr(page), { message: "the QR code reads as the sign-in address" }).toEqual([`${botbench.base}/#code=${code}`]);
  await checkDesign(page, "settings, add a device");
  await checkWords(page, "settings, add a device");

  // The second browser opens the address in the QR code: the sign-in screen, with the code chosen and filled in.
  const phone = await otherDevice(browser);
  await phone.goto(`${botbench.base}/#code=${code}`);
  await expect(phone.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(phone.getByRole("radio", { name: "Code" })).toBeChecked();
  await expect(phone.getByRole("textbox", { name: "One-time code" })).toHaveValue(code);
  // The code is taken out of the address once read.
  expect(new URL(phone.url()).hash).toBe("");
  await checkDesign(phone, "sign-in, with a code from the address");
  await checkWords(phone, "sign-in, with a code from the address");

  // The code that was replaced is refused, in words, and no session is made.
  await phone.getByRole("textbox", { name: "One-time code" }).fill(first.toLowerCase());
  await phone.getByRole("button", { name: "Sign in" }).click();
  // The alert names its tone in a word first ("Error"), then says what happened and what to do.
  await expect(phone.getByRole("alert")).toHaveText("ErrorThat code was replaced by a newer one. Use the code Settings shows now, or make a new one.");
  await expect(phone.getByRole("textbox", { name: "One-time code" })).toHaveAttribute("aria-invalid", "true");
  expect((await phone.request.get(`${botbench.base}/api/session`)).status()).toBe(401);
  await checkDesign(phone, "sign-in, a replaced code");

  // The code shown now signs it in, typed as a person might, and Botbench opens on Home.
  await phone.getByRole("textbox", { name: "One-time code" }).fill(` ${code.replace("-", " ").toLowerCase()} `);
  await phone.getByRole("button", { name: "Sign in" }).click();
  await expect(phone.getByTestId("headline")).toBeVisible();
  await expect(phone.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  expect((await phone.request.get(`${botbench.base}/api/session`)).status()).toBe(200);

  // A third browser with the same code: it was used, so it is refused.
  const third = await otherDevice(browser);
  await third.goto(botbench.base);
  await third.getByRole("radio", { name: "Code" }).check();
  await third.getByRole("textbox", { name: "One-time code" }).fill(code);
  await third.getByRole("button", { name: "Sign in" }).click();
  await expect(third.getByRole("alert")).toHaveText("ErrorThat code was already used. A code works once: make a new one in Settings → Signed-in devices on a device that is signed in.");
  expect((await third.request.get(`${botbench.base}/api/session`)).status()).toBe(401);
  await checkDesign(third, "sign-in, a used code");
  await checkWords(third, "sign-in, a used code");

  // The first browser's Settings lists and names the new device without a reload, and takes the used code off the screen.
  await expect(page.getByTestId("devices").getByTestId("device")).toHaveCount(2);
  await expect(page.getByTestId("device-added")).toHaveText(/^Note\S.* was added with the code and is signed in\. If you did not add it, sign it out above\.$/);
  await expect(page.getByTestId("pairing")).toHaveCount(0);
  await checkDesign(page, "settings, a device added");
  await checkWords(page, "settings, a device added");

  // Opened again on the device that is now signed in, the address with the code goes to the first screen, Home.
  await phone.goto(`${botbench.base}/#code=${code}`);
  await expect(phone.getByTestId("headline")).toBeVisible();
  await expect(phone.getByText("There is no screen at")).toHaveCount(0);
  await phone.context().close();
  await third.context().close();
});
