import { ApiError, transcribe } from "../api/client.ts";

/*
 * Dictation in the browser: the microphone is recorded with the browser's own MediaRecorder, and the recording is sent
 * to Botbench, which transcribes it on the Mac. Nothing is sent anywhere else, and nothing is sent to the agent: the
 * text comes back for the owner to read and edit in the message box.
 */

export type DictationState = { kind: "idle" } | { kind: "listening" } | { kind: "transcribing" } | { kind: "error"; message: string };

/** Why this page cannot record, or null when it can. */
export function cannotRecord(): string | null {
  if (!window.isSecureContext) return "Dictation is not available on this page: the browser allows the microphone only over HTTPS.";
  if (navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === "undefined") return "Dictation is not available in this browser.";
  return null;
}

/** The recording formats Botbench takes, in the order a browser is asked for them: iOS Safari records MP4, Chrome WebM. */
const FORMATS = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

function microphoneWords(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is not allowed for this page. Allow it in the browser's settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return "The microphone could not be started.";
}

export interface Dictation {
  /** Ask for the microphone and start recording. */
  start(): Promise<void>;
  /** Stop recording, send the recording, and resolve with the text; null when nothing came of it (the state says why). */
  stop(): Promise<string | null>;
  /** Stop recording and let the microphone go, sending nothing: the screen is going away. */
  cancel(): void;
}

/** A recorder that reports its state through `onState`. One recording at a time. */
export function createDictation(onState: (state: DictationState) => void, onSignedOut: () => void): Dictation {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stopped: Promise<Blob> | null = null;

  const start = async (): Promise<void> => {
    if (recorder !== null) return;
    const why = cannotRecord();
    if (why !== null) return onState({ kind: "error", message: why });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      return onState({ kind: "error", message: microphoneWords(err) });
    }
    const mimeType = FORMATS.find((type) => MediaRecorder.isTypeSupported(type));
    const active = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
    recorder = active;
    chunks = [];
    active.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    stopped = new Promise((resolve) => {
      active.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        resolve(new Blob(chunks, { type: active.mimeType || mimeType || "" }));
      };
    });
    active.start();
    onState({ kind: "listening" });
  };

  const stop = async (): Promise<string | null> => {
    if (recorder === null || stopped === null) return null;
    const done = stopped;
    recorder.stop();
    recorder = null;
    stopped = null;
    onState({ kind: "transcribing" });
    const recording = await done;
    if (recording.size === 0) {
      onState({ kind: "error", message: "Nothing was recorded. Try again." });
      return null;
    }
    try {
      const text = await transcribe(recording);
      if (text === "") {
        onState({ kind: "error", message: "No speech was heard. Try again, closer to the microphone." });
        return null;
      }
      onState({ kind: "idle" });
      return text;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      onState({ kind: "error", message: err instanceof ApiError ? `What you said was not transcribed. ${err.message}` : "What you said was not transcribed: Botbench could not be reached." });
      return null;
    }
  };

  const cancel = (): void => {
    if (recorder === null) return;
    recorder.ondataavailable = null;
    recorder.stop();
    recorder = null;
    stopped = null;
  };

  return { start, stop, cancel };
}

/** `text` put into `value` at the cursor, with a space on either side where the words would otherwise run together. */
export function insertAt(value: string, start: number, end: number, text: string): { value: string; cursor: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return { value: before + inserted + after, cursor: before.length + lead.length + text.length };
}
