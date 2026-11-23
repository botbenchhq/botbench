import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killProcessGroup, launch } from "../drivers/launch.ts";

/**
 * Dictation: what the owner says into the phone, turned into text on the Mac that runs Botbench
 * (`docs/adr/0003-voice-input-on-the-mac.md`). ffmpeg reads what the browser recorded and writes 16 kHz mono WAV;
 * Botbench's Swift helper (`helper.swift`, compiled once into the data folder) hands that to macOS's on-device speech
 * recognition and prints the text. Both run as programs with an argument list, never through a shell, in their own
 * process group, with a time limit. The recording and the text live only in a per-request temporary folder and in
 * memory: they are never written to the database or the log, and the folder is removed whatever happens.
 */

/** The recording formats a browser's MediaRecorder makes, by content type, each with the one ffmpeg reader that opens it. */
const AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": "mov", // iOS Safari: AAC in (fragmented) MP4
  "audio/x-m4a": "mov",
  "audio/webm": "matroska", // Chrome and Firefox
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** The ffmpeg reader for a request's content type, or null when it is not a recording format Botbench takes. */
export function audioFormat(contentType: string | undefined): string | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return Object.hasOwn(AUDIO_TYPES, type) ? AUDIO_TYPES[type]! : null;
}

export const MAX_AUDIO_SECONDS = 300;
const TIME_LIMIT_MS = 90_000;
const CHECK_LIMIT_MS = 15_000;
const COMPILE_LIMIT_MS = 180_000;
/** ffmpeg's WAV: 16 000 samples a second, 2 bytes each, after a header that is well under this. */
const WAV_BYTES_PER_SECOND = 32_000;
const WAV_HEADER_ALLOWANCE = 4096;
const MAX_OUTPUT = 1024 * 1024;
const HELPER_SOURCE = path.join(import.meta.dirname, "helper.swift");

export type DictationStatus = { available: true } | { available: false; reason: string };

/** A transcription that did not give text. `status` is the HTTP answer for it; the message is for the owner. */
export class DictationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DictationOptions {
  /** Botbench's data folder; the compiled helper is kept in `dictation/` under it. */
  home: string;
  /** The Swift compiler; Apple's command line developer tools put it at /usr/bin/swiftc. */
  swiftc?: string;
  /** ffmpeg, found on the PATH when left out. */
  ffmpeg?: string;
  /** Where per-request folders are made; the system's temporary folder when left out. */
  tempRoot?: string;
  /** How long one transcription may take, conversion included. */
  timeLimitMs?: number;
  /** The longest recording taken. */
  maxSeconds?: number;
}

export interface Dictation {
  /** Whether dictation works on this Mac now, and if not, why and what to do, in plain words. */
  status(): Promise<DictationStatus>;
  /** The text spoken in `file`, read with the ffmpeg reader `format` (from `audioFormat`). Throws `DictationError`. */
  transcribe(file: string, format: string): Promise<string>;
  /** The same for a recording that is still arriving (a request body), refused once it passes `maxBytes`. */
  transcribeUpload(body: AsyncIterable<Buffer>, format: string, maxBytes: number): Promise<string>;
}

interface Ran {
  started: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run a program with an argument list in its own process group; the whole group is killed at `limitMs`. */
function run(command: string, args: readonly string[], limitMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const { child, pgid } = launch(command, args, { cwd: os.tmpdir() });
    let stdout = "";
    let stderr = "";
    let started = true;
    let timedOut = false;
    child.stdin.on("error", () => {});
    child.stdin.end();
    const take = (to: "out" | "err") => (chunk: string) => {
      if (to === "out") stdout = (stdout + chunk).slice(0, MAX_OUTPUT);
      else stderr = (stderr + chunk).slice(0, MAX_OUTPUT);
    };
    child.stdout.setEncoding("utf8").on("data", take("out"));
    child.stderr.setEncoding("utf8").on("data", take("err"));
    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid) void killProcessGroup(pgid, { graceMs: 500 }).catch(() => {});
    }, limitMs);
    child.on("error", () => (started = false));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ started, timedOut, exitCode, stdout, stderr });
    });
  });
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

const TOOLS_MISSING = "Dictation needs Apple's command line developer tools on the Mac that runs Botbench. Install them there with: xcode-select --install";
const FFMPEG_MISSING = "Dictation needs ffmpeg on the Mac that runs Botbench, to read what the phone records. Install it there with: brew install ffmpeg";
const MODEL_MISSING = "The English speech model is not on this Mac yet. Install it once: in the Botbench folder on the Mac, run: node src/dictation/dictation.ts install";
const OS_TOO_OLD = "Dictation needs macOS 26 or later on the Mac that runs Botbench.";

export function createDictation(options: DictationOptions): Dictation {
  const swiftc = options.swiftc ?? "/usr/bin/swiftc";
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const timeLimitMs = options.timeLimitMs ?? TIME_LIMIT_MS;
  const maxSeconds = options.maxSeconds ?? MAX_AUDIO_SECONDS;
  let built: Promise<string> | null = null;

  /** The compiled helper, built from `helper.swift` the first time it is needed; its name carries the source's hash. */
  const helper = (): Promise<string> => {
    built ??= (async () => {
      const source = fs.readFileSync(HELPER_SOURCE);
      const dir = path.join(options.home, "dictation");
      const file = path.join(dir, `helper-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`);
      if (fs.existsSync(file)) return file;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const partial = `${file}.${process.pid}.partial`;
      const compiled = await run(swiftc, ["-O", "-o", partial, HELPER_SOURCE], COMPILE_LIMIT_MS);
      if (!compiled.started) throw new DictationError(503, TOOLS_MISSING);
      if (compiled.exitCode !== 0) {
        fs.rmSync(partial, { force: true });
        // xcrun's own words when the tools are missing; anything else is the compiler's first line.
        if (/xcode-select|developer tools|invalid active developer path/i.test(compiled.stderr)) throw new DictationError(503, TOOLS_MISSING);
        throw new DictationError(503, compiled.timedOut ? "The speech helper could not be built in time on the Mac." : `The speech helper could not be built on the Mac: ${firstLine(compiled.stderr) || `exit code ${compiled.exitCode}`}`);
      }
      fs.chmodSync(partial, 0o700);
      fs.renameSync(partial, file);
      return file;
    })();
    // A failed build is tried again next time: the owner may have installed what was missing.
    built.catch(() => (built = null));
    return built;
  };

  const problem = async (): Promise<string | null> => {
    if (process.platform !== "darwin") return "Dictation works only when Botbench runs on a Mac.";
    const version = await run(ffmpeg, ["-version"], CHECK_LIMIT_MS);
    if (!version.started || version.exitCode !== 0) return FFMPEG_MISSING;
    let file: string;
    try {
      file = await helper();
    } catch (err) {
      if (err instanceof DictationError) return err.message;
      throw err;
    }
    const check = await run(file, ["check"], CHECK_LIMIT_MS);
    const answer = check.stdout.trim();
    if (answer === "ready") return null;
    if (answer === "no-model") return MODEL_MISSING;
    if (answer === "unsupported") return OS_TOO_OLD;
    return `The speech helper did not answer as expected: ${firstLine(check.stderr) || (check.timedOut ? "it took too long" : `exit code ${check.exitCode}`)}`;
  };

  const status = async (): Promise<DictationStatus> => {
    const reason = await problem();
    return reason === null ? { available: true } : { available: false, reason };
  };

  /** Check the engine, make a per-request folder, and remove it whatever happens. */
  const inFolder = async (format: string, work: (dir: string) => Promise<string>): Promise<string> => {
    if (!Object.values(AUDIO_TYPES).includes(format)) throw new DictationError(415, "Botbench takes recordings as MP4, WebM, Ogg or WAV audio.");
    const reason = await problem();
    if (reason !== null) throw new DictationError(503, reason);
    const dir = fs.mkdtempSync(path.join(tempRoot, "botbench-dictation-"));
    try {
      return await work(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const transcribeIn = async (dir: string, file: string, format: string): Promise<string> => {
    const deadline = Date.now() + timeLimitMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    const tooSlow = (): DictationError => new DictationError(504, `Transcribing took longer than ${Math.round(timeLimitMs / 1000)} seconds and was stopped. Try a shorter recording.`);
    const wav = path.join(dir, "speech.wav");
    // The reader is named, so a file that says it is a playlist or a list of other files is not followed;
    // and only plain files may be opened. The recording is cut a little past the limit, then measured.
    const converted = await run(
      ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-f", format, "-i", file, "-vn", "-t", String(maxSeconds + 1), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav],
      left(),
    );
    if (converted.timedOut) throw tooSlow();
    if (!converted.started) throw new DictationError(503, FFMPEG_MISSING);
    if (converted.exitCode !== 0 || !fs.existsSync(wav)) throw new DictationError(422, "The recording could not be read as audio. Record again.");
    if (fs.statSync(wav).size > maxSeconds * WAV_BYTES_PER_SECOND + WAV_HEADER_ALLOWANCE) throw new DictationError(413, `The recording is longer than ${maxSeconds === 300 ? "5 minutes" : `${maxSeconds} seconds`}. Dictate in shorter parts.`);
    const heard = await run(await helper(), ["transcribe", wav], left());
    if (heard.timedOut) throw tooSlow();
    if (heard.exitCode === 5) throw new DictationError(422, "The recording could not be read as audio. Record again.");
    if (heard.exitCode !== 0) throw new DictationError(500, firstLine(heard.stderr) || `Speech recognition stopped with exit code ${heard.exitCode}.`);
    return heard.stdout.trim();
  };

  const transcribe = (file: string, format: string): Promise<string> => inFolder(format, (dir) => transcribeIn(dir, file, format));

  const transcribeUpload = (body: AsyncIterable<Buffer>, format: string, maxBytes: number): Promise<string> =>
    inFolder(format, async (dir) => {
      // The file's name is Botbench's own, never one from the request; only the owner can read it.
      const file = path.join(dir, "recording");
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        let size = 0;
        for await (const chunk of body) {
          size += chunk.length;
          if (size > maxBytes) throw new DictationError(413, `The recording is larger than ${maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))} MB` : `${Math.round(maxBytes / 1024)} KB`}. Dictate in shorter parts.`);
          fs.writeSync(fd, chunk);
        }
      } finally {
        fs.closeSync(fd);
      }
      return transcribeIn(dir, file, format);
    });

  return { status, transcribe, transcribeUpload };
}

// `node src/dictation/dictation.ts install`: download the English speech model through macOS, once, on the owner's Mac.
// The helper it builds for this is a throwaway in the temporary folder; the server builds its own in its data folder.
const runDirectly = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === import.meta.filename;
if (runDirectly && process.argv[2] === "install") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-dictation-install-"));
  // Removed whether the install worked, failed or threw.
  try {
    const before = await createDictation({ home }).status();
    if (before.available || before.reason !== MODEL_MISSING) {
      console.log(before.available ? "Dictation is ready: the English speech model is already on this Mac." : before.reason);
    } else {
      const dir = path.join(home, "dictation");
      const helperFile = path.join(dir, fs.readdirSync(dir).find((name) => /^helper-[0-9a-f]{16}$/.test(name))!);
      const installed = await run(helperFile, ["install"], 30 * 60_000);
      console.log(installed.stdout.trim() === "ready" ? "The English speech model is installed. Dictation is ready." : `The model was not installed: ${firstLine(installed.stderr) || installed.stdout.trim()}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
