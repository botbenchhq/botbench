# Product films

Four silent films made from Botbench's own recordings and screenshots, with typographic title cards:

| File (in `docs/media/`) | Format | Length, size | For |
|---|---|---|---|
| `botbench-launch.mp4` | 1920×1080, H.264, 30 fps | 39.0 s, 3.0 MB | Launch |
| `botbench-loop.mp4` | 1280×800, H.264, 30 fps | 9.8 s, 0.42 MB | Website loop (loops on its first frame) |
| `botbench-social-square.mp4` | 1080×1080, H.264, 30 fps | 26.0 s, 1.4 MB | Social, 1:1 |
| `botbench-social-portrait.mp4` | 1080×1350, H.264, 30 fps | 26.0 s, 1.4 MB | Social, 4:5 |

Each has a poster, `<name>-poster.png`: a frame of the film itself. Every file has `faststart` (the index is at the front).

## What is on screen, and where it comes from

Nothing of the product is drawn or rebuilt. Each product shot is one of the files below, cropped, scaled down (never
up: the page refuses a framing that would enlarge a pixel), framed and panned; its content is not changed. A clip
plays at its own speed, frame for frame.

| Shot | Source | What it is |
|---|---|---|
| Approving the plan; Claude Code at work; Accept | `docs/media/botbench-demo.mp4` | Recorded from the real client and server by `e2e/media.shots.ts` ("the demo"). Claude Code's build of the fix to `add` in `calc.py` and Codex's review of it are replayed from recorded sessions (`e2e/serve-replayed-media.ts`); the repository's check really runs. |
| The task ready for review: the check passed, Codex's review "a model's opinion, not a check" (launch, loop); the same at a phone's size, panning to Accept (social) | `docs/images/ready-for-review-proof.png`, `docs/images/ready-for-review.png` | Screenshots from the same test file ("pictures"), the same replayed sessions. |
| The overlap line under the changed files | `docs/images/peers/peers-overlap-phone.png` | From "between workbenches" in `e2e/media.shots.ts`, at a phone's size (390 wide at 3x, so its lines read in a film). No model turn. The other workbench's open pull request (dev1's #128, its title, branch and listed files) is the list captured once from the real `gh` (`test/recordings/gh-peers-open.json`), replayed by `e2e/serve-replayed-open-peers.ts`. dev1's branch is really pushed to a bare remote on disk. studio-mac's task is set up by the test: put in the store through the engine, its work committed by Botbench in its own copy (as `e2e/home-seed.ts` does for Home); its check really runs. No agent took part, although the task's screen names its configured agent. |
| "Passed together:" | `docs/images/peers/peers-passed-together-phone.png` | Same test: the check together really merges the two in a temporary copy and really runs the check there. |
| "dev1 started on this issue 2 minutes ago." | `docs/images/peers/peers-claim-warning-phone.png` | Same test: dev1's claim on issue #82 is made by the test with Botbench's own claim commit and push to the bare remote. This is the composer's warning before a run starts; the later run's stop ("…so this run stopped") is not shown, because no recording of it exists without a live model turn. |
| Title cards and the headline above each frame | `film.html`, `timelines.js` | Typographic title text in Inter and the Botbench theme (Graphite + Glacier, dark); the mark and lockup are `assets/svg/botbench-mark-two-tone-dark.svg` and `botbench-lockup-two-tone-dark.svg`, unchanged. |

The same test also writes the desktop pictures of those three moments (`peers-*-desktop.png`) and a clip of the check
together (`docs/media/check-together.mp4`); the films use the phone pictures, whose lines are large enough to read.

Each shot says what it is, in the caption under its frame:

- The demo's shots and the opening card: "Recorded from Botbench. Agents' parts replayed from recorded sessions."
- The overlap and the check together: "Recorded from Botbench. The task was set up by a test; the check and the check
  together really ran."
- The claim: "Recorded from Botbench. dev1's claim was pushed by a test, with Botbench's own claim push."
- Other cards: "Title card."

Nothing in the films is marked Early: the overlap warning, issue claims and checking together are in the README's
"What works today"; only questions and answers between paired workbenches are early, and the films do not show them.
The website loop has no text on it: the page that shows it must carry the caption.

Sizes: headlines are Inter 600 at 52 px in the launch film and 56 to 60 px in the social cuts; captions 22 to 24 px.
In the shots between workbenches the key line is shown at 0.91x to 1x of a 3x picture: 13 px type is 35 to 39 px.

## Storyboard

Launch (39.0 s):

1. Opening card: the mark, "Hand work to your agents." / "Walk away. Come back to the branch."
2. "You approve the plan. Claude Code builds it." The demo, 2.9 to 7.7 s.
3. "Walk away. It works on its own branch." The demo, 9.3 to 12.3 s.
4. "Come back to evidence: your check, a second opinion." The review, with a 750 ms push in to the check and Codex's
   review.
5. "The decision is yours: Accept or Reject." The demo, 17.0 to 21.4 s.
6. Card: "With a teammate." / "Your agents. Their agents. One coordinated workflow."
7. "Told before your work collides." The overlap line, a short push in.
8. "Both changes, checked together." With dev1's pull request #128, "Passed together:", a short push in.
9. "Who started on an issue first." The composer's warning, a short push in.
10. End card: the lockup, "Put your agents to work. Together.", botbenchhq.github.io.

Loop (9.8 s): the task ready for review, push in to the evidence, Accept (the demo, 17.4 to 21.8 s), back to the first
frame.

Social, 1:1 and 4:5 (26.0 s): opening card → "Come back to a branch with evidence." (the phone's review) → "The decision
is yours." (a pan down to Accept) → teammate card → overlap → passed together → claim warning → end card.

## Reproduce

From the repository's top folder, with Node 24+, ffmpeg (with libx264) and Playwright's own Chromium:

```sh
npm ci && npm ci --prefix web             # Playwright (dev dependency) and the client's copy of Inter
npx playwright install chromium
node docs/media/film/render.mjs           # every film; or name one: launch, loop, square, portrait
```

`render.mjs` extracts each clip's frames with ffmpeg into `docs/media/film/work/` (ignored by git), opens `film.html`
in Chromium at the film's size and device scale 1, calls `seek(t)` for every frame at 30 fps and saves it as PNG, then
encodes. The encodes, as run:

```sh
ffmpeg -i <clip>.mp4 -fps_mode passthrough -start_number 0 -q:v 1 work/frames/<clip>/f_%05d.jpg
ffmpeg -framerate 30 -i work/render/<film>/f_%05d.png -c:v libx264 -preset slow -crf <20 launch, 27 loop with -maxrate 1800k -bufsize 3600k, 22 social> \
  -pix_fmt yuv420p -r 30 -movflags +faststart -an -map_metadata -1 -bitexact docs/media/<file>.mp4
ffmpeg -i docs/media/<file>.mp4 -vf "fps=1,scale=320:-1,tile=<cols>x<rows>:padding=4:margin=4:color=0x0B0D10" -frames:v 1 <file>-sheet.png
```

Single frames for a look: `AT=2,9.5 OUT=docs/media/film/work/look node docs/media/film/render.mjs launch`.
A frame range: `FRAMES=0:90 OUT=… node docs/media/film/render.mjs launch` (no encode).

`seek(t)` draws each frame from scratch, so a frame does not depend on the ones before it. Chromium's own drawing
made frames differ in their lowest bits between renders, or depending on the frames drawn before. These are switched
off or pinned:

- Deferred decoding of large images: `--disable-checker-imaging`, `decoding="sync"`, and a new address for a still on
  each frame.
- The first frames after a page loads: two frames are drawn and thrown away.
- Text antialiasing that changed with the page's history: `--disable-lcd-text` and
  `--disable-font-subpixel-positioning`, with every layer that fades given `will-change: opacity` from the first frame.
- One colour profile (`--force-color-profile=srgb`), and two animation frames before each screenshot.

Two full renders of every film give byte-identical frames, and frames rendered again from a fresh page (a run from the
middle, and single frames) match the full render. The evidence for this pass is in the pull request.

Cuts: the next shot fades in over the last one in 400 ms, eased in and out, so no frame is empty. The line of title
text and the caption sit in one layer above the shots; when a cut changes them, the old words fade out over 150 ms
before the middle of the cut and the new ones in after it, so words never dissolve into other words, and a card's own
words come in only after its plate has covered the shot before. A shot marked `join` is a plain cut to the next view
of the same moment.

To change a film, edit `timelines.js`: a shot's length, its source and in-point, its line of title text, and its camera
keyframes `[t, cx, cy, w]` in the source's pixels. Camera moves take 750 ms, eased in and out; between moves the camera
does not move.

## Tooling

The pipeline is product-film by display.dev (https://github.com/display-dev/product-film, MIT), at commit
`fd9db88a76945bbd1d678739cad411c1a61bce1e`: a deterministic HTML timeline, frame capture with Playwright, encoding with
ffmpeg. `render.mjs` is adapted from its `templates/walkthrough/render.js` and `assemble.sh`, and `film.html`'s engine
(stateless seek, 2D camera, eased moves) from `templates/walkthrough/beats.html`; its licence is `LICENSE-product-film`,
and `NOTICE` lists the files. Nothing was published to display.dev or any other service: product-film's review page
step was not used.
