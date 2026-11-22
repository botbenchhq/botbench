# ADR 0003: Voice input is transcribed on the Mac by Apple's on-device speech recognition

Date: 2026-11-22. Status: accepted (owner direction: transcribe on the Mac, nothing sent to a third party).

## Decision
1. The phone's browser records the owner with its own `MediaRecorder` and posts the recording to Botbench. Botbench turns it into text on the Mac that runs it and answers with the text. The text goes into the message box; nothing is sent to an agent until the owner sends it.
2. The speech engine is macOS's own on-device recognition, the Speech framework's `SpeechAnalyzer` with `SpeechTranscriber` (macOS 26 and later), English (US). Botbench reaches it through a small Swift program of its own, `src/dictation/helper.swift`, which it compiles with the Swift compiler of Apple's command line developer tools into `dictation/` in its data folder the first time dictation is asked about, and then runs like `git`: an argument list, its own process group, a time limit.
3. ffmpeg (Homebrew) converts what the browser recorded (AAC in MP4 from iOS Safari, Opus in WebM from Chrome) to 16 kHz mono WAV before recognition, with the reader for the declared format named and only plain files allowed.
4. Neither is an npm dependency. Botbench still has no runtime npm dependencies.

## Why
Measured on the owner's Mac (macOS 27.2, Apple silicon) on 2026-11-22, with speech made by `say`:
- **Apple, `SpeechTranscriber`.** Worked from a plain command-line program with no speech-recognition permission granted (the permission status stayed "not determined"; this API did not ask for it). Worked with an empty environment (`env -i`), under a minimal PATH, and started by a real launchd LaunchAgent in the owner's GUI session. Recognition runs in the system's `localspeechrecognition` service, which had no network sockets open; the English model was already installed by the system. About 0.1 to 0.4 seconds for 4 seconds of speech after start. Reads WAV, AIFF, M4A and fragmented MP4 itself; not WebM. Heard "worktree" as "work tree" and "pull request" as "pool request" or "full request" in the synthetic voices; "Codex", punctuation and numbers ("30 seconds") right.
- **whisper.cpp** (`brew install whisper-cpp`, model `ggml-base.en`, 148 MB, downloaded for the test). About 0.3 seconds for the same audio; worked under `env -i`. "pull request" right; "Codex" heard as "codecs" unless the program was given a prompt listing the words. Reads WAV only (no M4A). Needs a Homebrew package with five dependencies and a model download.
- `SFSpeechRecognizer` (the older Speech API) was not chosen: it needs the speech-recognition privacy permission, which a background service cannot ask for.

Apple's engine needs nothing installed beyond what the Mac already has (the developer tools, which Botbench's owner has for git), no permission click and no model download, and its accuracy on these sentences was comparable. whisper.cpp stays the fallback if Apple's engine stops working from a background service.

## Consequences
- The owner's Mac needs Apple's command line developer tools (`xcode-select --install`) and ffmpeg (`brew install ffmpeg`), and the launchd service's PATH must contain Homebrew's `bin`. When one is missing, `GET /api/voice` says which and how to install it, and the client shows no microphone button.
- If the English model is ever missing, `node src/dictation/dictation.ts install` asks macOS to download it from Apple. That download is the model only; no audio leaves the Mac.
- English (US) only for now.
- The recording and the text exist only in a per-request temporary folder (removed whatever happens) and in memory; never in the database or the log.
- A compiled program in the data folder is new: it is built from the checkout's own source, named by the source's hash, and owner-only.
