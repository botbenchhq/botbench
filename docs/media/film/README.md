# Product films

Four silent films made from Botbench's own recordings and screenshots, with typographic title cards:

| File (in `docs/media/`) | Format | Length, size | For |
|---|---|---|---|
| `botbench-launch.mp4` | 1920×1080, H.264, 30 fps | 42.3 s, 4.1 MB | Launch |
| `botbench-loop.mp4` | 1280×800, H.264, 30 fps | 9.8 s, 0.41 MB | Website loop (loops on its first frame) |
| `botbench-social-square.mp4` | 1080×1080, H.264, 30 fps | 28.2 s, 1.7 MB | Social, 1:1 |
| `botbench-social-portrait.mp4` | 1080×1350, H.264, 30 fps | 28.2 s, 2.0 MB | Social, 4:5 |

Each has a poster, `<name>-poster.png`: a frame of the film itself. Every file has `faststart` (the index is at the front).

## What is on screen, and where it comes from

Nothing of the product is drawn or rebuilt. Each product shot is one of the files below, cropped, scaled down (never
up: the page refuses a framing that would enlarge a pixel), framed and panned; its content is not changed. A clip
plays at its own speed, frame for frame.

| Shot | Source | What it is |
|---|---|---|
| Approving the plan; Claude Code at work; Accept | `docs/media/botbench-demo.mp4` | Recorded from the real client and server by `e2e/media.shots.ts` ("the demo"). Claude Code's build of the fix to `add` in `calc.py` and Codex's review of it are replayed from recorded sessions (`e2e/serve-replayed-media.ts`); the repository's check really runs. |
| The task ready for review: the check passed, Codex's review "a model's opinion, not a check" | `docs/images/ready-for-review-proof.png` | A screenshot from the same test file ("pictures"), the same replayed sessions. |
| The overlap line under the changed files | `docs/images/peers/peers-overlap-desktop.png` | From "between workbenches" in `e2e/media.shots.ts`. No model turn. The other workbench's open pull request (dev1's #128, its title, branch and listed files) is the list captured once from the real `gh` (`test/recordings/gh-peers-open.json`), replayed by `e2e/serve-replayed-open-peers.ts`. dev1's branch is really pushed to a bare remote on disk. studio-mac's task is put in the store through the engine with its work committed by Botbench in its own copy (as `e2e/home-seed.ts` does for Home); its check really runs. |
| Checking together until "Passed together:" | `docs/media/check-together.mp4`, `docs/images/peers/peers-passed-together-desktop.png` | Same test: the check together really merges the two in a temporary copy and really runs the check there. |
| "dev1 started on this issue 2 minutes ago." | `docs/images/peers/peers-claim-warning-desktop.png` | Same test: dev1's claim on issue #82 is made with Botbench's own claim commit and push to the bare remote. This is the composer's warning before a run starts; the later run's stop ("…so this run stopped") is not shown, because no recording of it exists without a live model turn. |
| Title cards and the line above each frame | `film.html`, `timelines.js` | Typographic title text in Inter and the Botbench theme (Graphite + Glacier, dark); the mark and lockup are `assets/svg/botbench-mark-two-tone-dark.svg` and `botbench-lockup-two-tone-dark.svg`, unchanged. |

Each product shot carries the caption "Recorded from Botbench. Agents' parts replayed from recorded sessions."; the
opening card carries it too, and the other cards say "Title card." The shots between workbenches are marked Early, as
the README marks coordination between workbenches. The website loop has no text on it: the page that shows it must
carry the caption.

## Storyboard

Launch (42.3 s): opening card "Hand work to your agents. / Walk away. Come back to the branch." → 1 approving the
plan (demo 2.9–7.7 s) → 2 Claude Code working in its own copy (demo 9.3–12.1 s) → 3 the task ready for review, a 750 ms
push in to the check and Codex's review → 4 Accept (demo 17.0–21.4 s) → card "With a teammate. / Your agents. Their
agents. One coordinated workflow. Early" → the overlap line, push in → Check together with pull request #128
(check-together 3.8–8.8 s), cut to "Passed together:" → the claim warning in the composer, push in → end card: the
lockup, "Put your agents to work. Together.", botbenchhq.github.io.

Loop (9.8 s): the task ready for review, push in to the evidence, Accept (demo 17.4–21.8 s), back to the first frame.

Social, 1:1 and 4:5 (28.2 s): opening card → evidence → the decision (a crop of the demo at its own size) → teammate
card → overlap → passed together → claim warning → end card.

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

`seek(t)` draws each frame from scratch, so a frame does not depend on the ones before it. Two things made frames differ
by their lowest bit between renders, and are switched off: Chromium's deferred decoding of large images
(`--disable-checker-imaging`, with `decoding="sync"` and a new address for a still on each frame), and drawing the
first frames before the page has warmed up (two frames are drawn and thrown away after each load). `render.mjs` also
forces one colour profile (`--force-color-profile=srgb`) and waits two animation frames before each screenshot. Two
full renders of every film then give byte-identical frames.

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
