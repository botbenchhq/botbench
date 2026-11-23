import { execFileSync } from "node:child_process";
import path from "node:path";

// Real recorded speech for the dictation tests: macOS's own `say` speaks a sentence into a file, and ffmpeg turns it
// into what a phone's browser records (AAC in a fragmented MP4, as iOS Safari's MediaRecorder writes; Opus in WebM, as
// Chrome's does) or into plain 16 kHz WAV. Nothing here is a stand-in for the speech engine: the engine hears this audio.

/** Why the dictation tests cannot run here, or null when they can: they need macOS, `say` and ffmpeg. */
export const NO_SPEECH: string | null = (() => {
  if (process.platform !== "darwin") return "dictation is transcribed by macOS's own speech recognition; these tests run only on a Mac";
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    return "ffmpeg is not installed (brew install ffmpeg); the dictation tests convert speech with it";
  }
  // GitHub's macOS runners are virtual machines, and there macOS's speech recognition is not available: the helper's
  // check answered "unsupported" on macOS 26 (the macOS job of .github/workflows/ci.yml, run 45148799886). A Mac that is
  // not a virtual machine runs these tests, and a speech engine that fails there fails them.
  try {
    if (execFileSync("sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" }).trim() === "1") return "this Mac is a virtual machine (kern.hv_vmm_present is 1), where macOS's speech recognition is not available";
  } catch {
    // No such sysctl on this macOS: not taken as a virtual machine, so the tests run.
  }
  return null;
})();

export const SENTENCES = {
  codex: "Please create a new worktree for the pull request and ask Codex to review it.",
  build: "The build failed because the test for the approval card timed out after thirty seconds.",
};

export type Recording = "mp4" | "webm" | "wav";

/** Speak `text` into `dir`, then convert it to the given recording format. Returns the file's path. */
export function speak(dir: string, name: string, text: string, as: Recording): string {
  const aiff = path.join(dir, `${name}.aiff`);
  execFileSync("say", ["-o", aiff, text]);
  const out = path.join(dir, `${name}.${as}`);
  const codec = as === "mp4" ? ["-c:a", "aac", "-b:a", "64k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"] : as === "webm" ? ["-c:a", "libopus", "-f", "webm"] : ["-ar", "16000", "-ac", "1", "-f", "wav"];
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", aiff, ...codec, out]);
  return out;
}

/** The words of a transcript, lower case, without punctuation, so "Codex," and "codex" match. */
export const words = (text: string): string => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
