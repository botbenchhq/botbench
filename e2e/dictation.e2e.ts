import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkDesign, expect, signIn, test as base } from "./helpers.ts";
import { startBotbench, tempDir } from "./botbench.ts";

// Dictation in the Chat screen's message box, with no model turn. Chrome's own fake microphone plays a real recording
// of speech (made here with macOS's `say`), MediaRecorder records it as the page would record the owner, and Botbench
// transcribes it on this Mac with the real engine. Nothing in Botbench is replaced.

const SPOKEN = "Please review the approval card before the build.";

// The recording is made by a worker fixture, and removed in its teardown. Made at the top of this file, it was made
// again each time Playwright loaded the file, the first time only to list its tests, and that copy was never removed.
const test = base.extend<object, { speech: string }>({
  speech: [
    async ({}, use) => {
      const dir = tempDir("botbench-dictation-e2e-");
      try {
        const wav = path.join(dir, "speech.wav");
        if (process.platform === "darwin") {
          execFileSync("say", ["-o", path.join(dir, "speech.aiff"), SPOKEN]);
          // A second of quiet after the sentence, so the looping fake microphone has a clean break between repeats.
          execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", path.join(dir, "speech.aiff"), "-af", "apad=pad_dur=1", "-ar", "48000", "-ac", "1", wav]);
        }
        await use(wav);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  launchOptions: [async ({ speech }, use) => use({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${speech}`] }), { scope: "worker" }],
});

test.use({ permissions: ["microphone"] });

test("pressing the microphone, then pressing it again, puts the spoken words in the message box, unsent and editable", async ({ page, botbench }) => {
  test.skip(process.platform !== "darwin", "dictation is transcribed by macOS's own speech recognition");
  await signIn(page, botbench);
  const box = page.getByLabel("Message Claude Code");
  await box.fill("Note:");
  const mic = page.getByRole("button", { name: "Dictate" });
  await expect(mic).toBeVisible({ timeout: 60_000 });
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await checkDesign(page, "chat, with dictation");

  // Chrome's fake microphone must start before anything about Botbench can be shown with it. On the machine this was
  // written on (macOS 27.2, Chrome 156) it never does: getUserMedia stays pending, headless or not, however Chrome is
  // started. That is said, not hidden, and the rest of the journey is not claimed.
  const fakeMicrophone = await page.evaluate(() =>
    Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => (stream.getTracks().forEach((track) => track.stop()), "started")),
      new Promise<string>((resolve) => setTimeout(() => resolve("Chrome's fake microphone did not start within 10 seconds"), 10_000)),
    ]),
  );
  test.skip(fakeMicrophone !== "started", `${fakeMicrophone}; the recording journey cannot be driven in this Chrome`);

  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();
  await checkDesign(page, "chat, listening");
  // The sentence lasts about four seconds; the fake microphone plays it from the start of the recording.
  await page.waitForTimeout(5000);
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");

  await expect(box).toHaveValue(/approval card/i, { timeout: 60_000 });
  const value = await box.inputValue();
  expect(value.startsWith("Note: "), `what was typed stays first: "${value}"`).toBe(true);
  for (const word of ["review", "approval", "card", "build"]) expect(value.toLowerCase()).toContain(word);
  await expect(page.getByRole("status").filter({ hasText: /Listening|Transcribing/ })).toHaveCount(0);
  // Nothing was sent: no prompt is in the transcript, and the box can still be edited.
  await expect(page.locator('[data-event="user_prompt"]')).toHaveCount(0);
  await box.press("End");
  await box.pressSequentially(" Thanks.");
  await expect(box).toHaveValue(/Thanks\.$/);
  await checkDesign(page, "chat, after dictation");
});

test("with no speech engine on the Mac, there is no microphone button", async ({ page }) => {
  // The service started without Homebrew on its PATH, as a login service can be: ffmpeg cannot be found.
  const claude = execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
  const botbench = await startBotbench({ env: { PATH: `${path.dirname(claude)}:/usr/bin:/bin` } });
  try {
    // The screen's own question, answered, before the button's absence means anything.
    const asked = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/voice", { timeout: 60_000 });
    await signIn(page, botbench);
    const voice = await (await asked).json();
    expect(voice).toEqual({ available: false, reason: expect.stringContaining("brew install ffmpeg") });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dictate" })).toHaveCount(0);
  } finally {
    await botbench.stop();
    fs.rmSync(path.dirname(botbench.home), { recursive: true, force: true });
  }
});
