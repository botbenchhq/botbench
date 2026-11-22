import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type StartOptions } from "../../src/server.ts";
import { tempDir } from "../support/repo.ts";
import { NO_SPEECH, SENTENCES, speak, words } from "../support/speech.ts";

// The dictation routes over real HTTP against a real Botbench server, real SQLite and the real speech engine (macOS's
// on-device recognition through Botbench's helper, and ffmpeg). The recordings are real speech made with `say`.

const skip = NO_SPEECH ?? false;
const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} };

async function setUp(t: { after: (fn: () => unknown) => void }, dictation: StartOptions["dictation"] = {}) {
  const dir = tempDir("botbench-dictation-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const tempRoot = path.join(dir, "tmp");
  fs.mkdirSync(tempRoot);
  const server = await startServer({ config, home, signInDelayMs: 1, dictation: { tempRoot, ...dictation } });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  await signIn.arrayBuffer();
  const cookie = signIn.headers.getSetCookie()[0]!.split(";")[0]!;
  const post = (body: Uint8Array<ArrayBuffer> | string, type: string, headers: Record<string, string> = {}) => fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { cookie, "content-type": type, ...headers }, body });
  return { dir, home, base, cookie, port: server.port, post, leftovers: () => fs.readdirSync(tempRoot) };
}

/** Everything the server writes to its log while `during` runs. */
async function logOf(during: () => Promise<void>): Promise<string> {
  let log = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((log += String(chunk)), out(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((log += String(chunk)), err(chunk, ...rest))) as typeof process.stderr.write;
  try {
    await during();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return log;
}

/** Every file under `dir`, read as text. */
const allText = (dir: string): string =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name)).toString("latin1"))
    .join("\n");

test("the dictation routes need the owner's sign-in", async (t) => {
  const { base } = await setUp(t);
  const status = await fetch(`${base}/api/voice`);
  assert.equal(status.status, 401);
  await status.arrayBuffer();
  const upload = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/mp4" }, body: new Uint8Array(100) });
  assert.equal(upload.status, 401);
  await upload.arrayBuffer();
});

test("a recording posted as an iPhone sends it comes back as text, and neither the audio nor the text is kept anywhere", { skip }, async (t) => {
  const { dir, home, base, cookie, post, leftovers } = await setUp(t);
  const status = await fetch(`${base}/api/voice`, { headers: { cookie } });
  assert.deepEqual(await status.json(), { available: true });
  const recording = fs.readFileSync(speak(dir, "build", SENTENCES.build, "mp4"));
  let text = "";
  const log = await logOf(async () => {
    const res = await post(recording, "audio/mp4");
    assert.equal(res.status, 200);
    text = ((await res.json()) as { text: string }).text;
  });
  for (const word of ["build", "failed", "approval", "card", "seconds"]) assert.match(words(text), new RegExp(`\\b${word}\\b`));
  assert.deepEqual(leftovers(), []);
  const kept = allText(home).toLowerCase();
  for (const word of ["approval card", "timed out"]) {
    assert.ok(!kept.includes(word), `"${word}" is not in the data folder (database included)`);
    assert.ok(!log.toLowerCase().includes(word), `"${word}" is not in the log`);
  }
  assert.ok(!kept.includes(recording.subarray(1000, 1064).toString("latin1").toLowerCase()), "the recording's bytes are not in the data folder");
});

test("a body that is not a recording is refused: another content type before it is read, and bytes that are not audio after", { skip }, async (t) => {
  const { post, leftovers } = await setUp(t);
  for (const type of ["text/plain", "application/json", "application/octet-stream", "video/mp4", "audio/x-mpegurl"]) {
    const res = await post("#EXTM3U\nfile:///etc/passwd\n", type);
    assert.equal(res.status, 415, type);
    assert.match(((await res.json()) as { error: string }).error, /body must be/);
  }
  const res = await post("#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n".repeat(20), "audio/mp4");
  assert.equal(res.status, 422);
  assert.match(((await res.json()) as { error: string }).error, /could not be read as audio/);
  assert.deepEqual(leftovers(), []);
});

test("a recording larger than the cap is refused while it is read, and nothing is left behind", { skip }, async (t) => {
  const { post, leftovers } = await setUp(t, { maxBytes: 64 * 1024 });
  const res = await post(new Uint8Array(1024 * 1024), "audio/webm");
  assert.equal(res.status, 413);
  assert.match(((await res.json()) as { error: string }).error, /larger than/);
  assert.deepEqual(leftovers(), []);
});

test("a recording from another site is refused", async (t) => {
  const { post } = await setUp(t);
  const res = await post(new Uint8Array(10), "audio/mp4", { origin: "https://elsewhere.example" });
  assert.equal(res.status, 403);
  await res.arrayBuffer();
});

test("one transcription at a time per signed-in device: a second while the first is arriving gets 409", { skip }, async (t) => {
  const { port, cookie, post, leftovers } = await setUp(t);
  // The first recording is still arriving: its body is not finished.
  const first = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/voice/transcribe", headers: { cookie, "content-type": "audio/webm", "transfer-encoding": "chunked" } });
  const firstDone = new Promise<number>((resolve, reject) => {
    first.on("response", (res) => (res.resume(), resolve(res.statusCode!)));
    first.on("error", reject);
  });
  first.write(new Uint8Array(1024));
  const deadline = Date.now() + 5000;
  while (leftovers().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(leftovers().length, 1, "the first recording is being received");
  const second = await post(new Uint8Array(10), "audio/webm");
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /already being transcribed/);
  first.end();
  assert.equal(await firstDone, 422, "the first is answered for itself");
  assert.deepEqual(leftovers(), []);
  const after = await post(new Uint8Array(10), "audio/webm");
  assert.equal(after.status, 422, "the next one is taken once the first is done");
  await after.arrayBuffer();
});

test("dictation is reported unavailable, in words, when the speech engine cannot be built, and a recording is then refused unread", { skip: process.platform === "darwin" ? false : "the reasons are for a Mac" }, async (t) => {
  const { base, cookie, post, leftovers } = await setUp(t, { swiftc: "/nonexistent/swiftc" });
  const status = await fetch(`${base}/api/voice`, { headers: { cookie } });
  const body = (await status.json()) as { available: boolean; reason: string };
  assert.equal(body.available, false);
  assert.match(body.reason, /command line developer tools.*xcode-select --install/);
  const res = await post(new Uint8Array(10), "audio/mp4");
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /xcode-select --install/);
  assert.deepEqual(leftovers(), []);
});
