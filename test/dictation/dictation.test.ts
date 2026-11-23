import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { audioFormat, createDictation, DictationError } from "../../src/dictation/dictation.ts";
import { NO_PROCESS_LIST } from "../support/confined.ts";
import { tempDir } from "../support/repo.ts";
import { NO_SPEECH, SENTENCES, speak, words } from "../support/speech.ts";

// The dictation module with the real engine: macOS's on-device speech recognition through Botbench's Swift helper,
// compiled here for real, and the real ffmpeg. The audio is real speech made with `say`.

const skip = NO_SPEECH ?? false;

function setUp(t: { after: (fn: () => void) => void }, options: { maxSeconds?: number; timeLimitMs?: number; swiftc?: string; ffmpeg?: string } = {}) {
  const dir = tempDir("botbench-dictation-");
  const tempRoot = path.join(dir, "tmp");
  fs.mkdirSync(tempRoot);
  const dictation = createDictation({ home: path.join(dir, "home"), tempRoot, ...options });
  return { dir, tempRoot, dictation, leftovers: () => fs.readdirSync(tempRoot) };
}

test("only the recording formats a browser makes are accepted, each read with its own reader", () => {
  assert.equal(audioFormat("audio/mp4"), "mov");
  assert.equal(audioFormat("audio/webm;codecs=opus"), "matroska");
  assert.equal(audioFormat("Audio/WebM; codecs=opus"), "matroska");
  assert.equal(audioFormat("audio/ogg; codecs=opus"), "ogg");
  assert.equal(audioFormat("audio/wav"), "wav");
  for (const refused of [undefined, "", "application/json", "text/plain", "video/mp4", "audio/x-mpegurl", "application/vnd.apple.mpegurl", "audio/mp4x", "audio/*"]) assert.equal(audioFormat(refused), null, String(refused));
});

test("speech recorded as an iPhone records it is transcribed on this Mac, and its temporary files are gone afterwards", { skip }, async (t) => {
  const { dir, dictation, leftovers } = setUp(t);
  assert.deepEqual(await dictation.status(), { available: true });
  const started = Date.now();
  const codex = words(await dictation.transcribe(speak(dir, "codex", SENTENCES.codex, "mp4"), "mov"));
  const build = words(await dictation.transcribe(speak(dir, "build", SENTENCES.build, "webm"), "matroska"));
  t.diagnostic(`heard: "${codex}" / "${build}" in ${Date.now() - started} ms`);
  for (const word of ["create", "codex", "review"]) assert.match(codex, new RegExp(`\\b${word}\\b`), `"${word}" in "${codex}"`);
  for (const word of ["build", "failed", "approval", "card", "seconds"]) assert.match(build, new RegExp(`\\b${word}\\b`), `"${word}" in "${build}"`);
  assert.deepEqual(leftovers(), []);
});

test("a recording longer than the limit is refused, and nothing is left behind", { skip }, async (t) => {
  const { dir, dictation, leftovers } = setUp(t, { maxSeconds: 2 });
  await assert.rejects(dictation.transcribe(speak(dir, "long", SENTENCES.build, "wav"), "wav"), (err: unknown) => err instanceof DictationError && err.status === 413 && /longer than 2 seconds/.test(err.message));
  assert.deepEqual(leftovers(), []);
});

test("a file that is not audio is refused in words, and nothing is left behind", { skip }, async (t) => {
  const { dir, dictation, leftovers } = setUp(t);
  const file = path.join(dir, "notes.mp4");
  fs.writeFileSync(file, "This is not a recording.\n".repeat(100));
  await assert.rejects(dictation.transcribe(file, "mov"), (err: unknown) => err instanceof DictationError && err.status === 422 && /could not be read as audio/.test(err.message));
  assert.deepEqual(leftovers(), []);
});

test("a recording that never finishes arriving is given up on at the time limit, the converter is stopped and nothing is left behind", { skip: skip || NO_PROCESS_LIST }, async (t) => {
  const { dir, dictation, leftovers } = setUp(t, { timeLimitMs: 1500 });
  // A named pipe nobody writes to: the converter waits on it for ever, as on a stalled read.
  const pipe = path.join(dir, "stalled.webm");
  execFileSync("mkfifo", [pipe]);
  await dictation.status();
  const started = Date.now();
  await assert.rejects(dictation.transcribe(pipe, "matroska"), (err: unknown) => err instanceof DictationError && err.status === 504 && /took longer than/.test(err.message));
  assert.ok(Date.now() - started < 8000, "it gave up near the limit");
  assert.deepEqual(leftovers(), []);
  const deadline = Date.now() + 5000;
  const left = (): string => {
    try {
      return execFileSync("pgrep", ["-f", pipe], { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  while (left() !== "" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(left(), "", "no converter process is left reading the pipe");
});

test("dictation reports itself unavailable, with what to install, when a program it needs is not there", { skip: process.platform === "darwin" ? false : "the reasons are for a Mac" }, async (t) => {
  const noCompiler = setUp(t, { swiftc: "/nonexistent/swiftc" });
  const tools = await noCompiler.dictation.status();
  assert.equal(tools.available, false);
  assert.match(tools.available ? "" : tools.reason, /command line developer tools.*xcode-select --install/);
  const noFfmpeg = setUp(t, { ffmpeg: "/nonexistent/ffmpeg" });
  const ffmpeg = await noFfmpeg.dictation.status();
  assert.equal(ffmpeg.available, false);
  assert.match(ffmpeg.available ? "" : ffmpeg.reason, /needs ffmpeg.*brew install ffmpeg/);
  await assert.rejects(noFfmpeg.dictation.transcribe("/nonexistent/audio.wav", "wav"), (err: unknown) => err instanceof DictationError && err.status === 503);
});
