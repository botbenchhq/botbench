// Renders Botbench's product films: film.html draws each frame, Playwright's Chromium captures it, ffmpeg encodes.
// Adapted from product-film by display.dev (MIT, commit fd9db88a76945bbd1d678739cad411c1a61bce1e):
// templates/walkthrough/render.js (seek every frame on one page, wait for fonts and images, retry a stalled screenshot)
// and templates/walkthrough/assemble.sh (encode, poster, contact sheet). Licence: LICENSE-product-film beside this file.
//
// From the repository's top folder, after `npm ci` and `npm ci --prefix web` (Inter is the client's own copy):
//   node docs/media/film/render.mjs                 every film: launch, loop, square, portrait
//   node docs/media/film/render.mjs launch          one film
//   FRAMES=0:90 OUT=work/check node docs/media/film/render.mjs launch   frames 0-89 only, into another folder, no encode
//   AT=2,9.5 node docs/media/film/render.mjs launch                    the frames at 2 s and 9.5 s only, no encode
// Writes the films, posters and contact sheets into docs/media/ (sheets into SHEETS, default docs/media/film/work/).
// Needs ffmpeg with libx264 and Playwright's own Chromium (`npx playwright install chromium`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { chromium } from "playwright";

const HERE = import.meta.dirname;
const MEDIA = path.resolve(HERE, "..");
const WORK = path.join(HERE, "work");
const SHEETS = path.resolve(process.env.SHEETS ?? WORK);
const FPS = 30;
const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const probe = (file, entries) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", entries, "-of", "csv=p=0", file], { encoding: "utf8" }).trim();

// Each film's output: its file name in docs/media, and how it is encoded.
const OUTPUTS = {
  launch: { file: "botbench-launch", crf: 20, preset: "slow", tile: "8x6" },
  loop: { file: "botbench-loop", crf: 27, preset: "slow", tile: "6x2", maxrate: "1800k" },
  square: { file: "botbench-social-square", crf: 22, preset: "slow", tile: "6x5" },
  portrait: { file: "botbench-social-portrait", crf: 22, preset: "slow", tile: "6x5" },
};

/** A clip's frames, every one at its own 30 fps, once: work/frames/<name>/f_00000.jpg … The count must be the timeline's. */
function extractClip(name, src) {
  const dir = path.join(WORK, "frames", name);
  const clip = path.resolve(HERE, src.clip);
  const fps = probe(clip, "stream=r_frame_rate").replace(/,$/, "");
  if (fps !== "30/1") throw new Error(`${src.clip} is ${fps} fps, not 30`);
  if (!fs.existsSync(path.join(dir, "done"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    ff("-i", clip, "-fps_mode", "passthrough", "-start_number", "0", "-q:v", "1", path.join(dir, "f_%05d.jpg"));
    fs.writeFileSync(path.join(dir, "done"), "");
  }
  const n = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
  if (n !== src.frames) throw new Error(`${src.clip} has ${n} frames; timelines.js says ${src.frames}`);
}

async function render(browser, film, range, outDir) {
  const page = await browser.newPage({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { throw new Error(`film.html: ${e.message}`); });
  const url = `${pathToFileURL(path.join(HERE, "film.html")).href}?film=${film}`;
  const load = async () => {
    await page.goto(url);
    const size = await page.evaluate(() => ({ w: window.LAYOUTS[window.FILMS[new URLSearchParams(location.search).get("film")].layout].w, h: window.LAYOUTS[window.FILMS[new URLSearchParams(location.search).get("film")].layout].h }));
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.evaluate(() => Promise.all([window.READY, document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]));
    // Warm up: the first frames drawn after a load came out a bit differently from the same frames drawn later. Draw
    // and screenshot two frames to throw away, then wait (product-film waits 300 ms), so every kept frame is drawn warm.
    for (const t of [0, 1]) (await page.evaluate((x) => window.seek(x), t), await page.screenshot({ type: "png" }));
    await page.waitForTimeout(300);
  };
  await load();
  const info = await page.evaluate(() => ({ frames: window.FILM_FRAMES, duration: window.FILM_DURATION, poster: window.FILM_POSTER }));
  const [from, to] = range ?? [0, info.frames];
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const list = process.env.AT ? process.env.AT.split(",").map((t) => Math.round(Number(t) * FPS)) : Array.from({ length: Math.max(0, Math.min(to, info.frames) - from) }, (_, k) => from + k);
  for (const i of list) {
    for (let attempt = 1; ; attempt++) {
      // A stalled screenshot under load reloads the page and retries the frame (product-film render.js).
      try {
        await page.evaluate((t) => window.seek(t), i / FPS);
        await page.screenshot({ path: path.join(outDir, `f_${String(i).padStart(5, "0")}.png`), type: "png", timeout: 120_000 });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        console.log(film, "frame", i, "retry", attempt, String(e.message).split("\n")[0]);
        await load();
      }
    }
  }
  await page.close();
  return info;
}

function encode(film, info, framesDir) {
  const o = OUTPUTS[film];
  const out = path.join(MEDIA, `${o.file}.mp4`);
  const rate = o.maxrate ? ["-maxrate", o.maxrate, "-bufsize", String(parseInt(o.maxrate) * 2) + "k"] : [];
  ff("-framerate", String(FPS), "-i", path.join(framesDir, "f_%05d.png"), "-c:v", "libx264", "-preset", o.preset, "-crf", String(o.crf), ...rate,
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", "-an", "-map_metadata", "-1", "-bitexact", out);
  // The poster is a frame of the film itself, at the time the timeline names.
  fs.copyFileSync(path.join(framesDir, `f_${String(Math.round(info.poster * FPS)).padStart(5, "0")}.png`), path.join(MEDIA, `${o.file}-poster.png`));
  fs.mkdirSync(SHEETS, { recursive: true });
  ff("-i", out, "-vf", `fps=1,scale=320:-1,tile=${o.tile}:padding=4:margin=4:color=0x0B0D10`, "-frames:v", "1", path.join(SHEETS, `${o.file}-sheet.png`));
  const size = fs.statSync(out).size;
  console.log(`${path.relative(process.cwd(), out)}  ${Number(probe(out, "format=duration").replace(/,$/, "") || info.duration).toFixed(2)} s  ${(size / 1048576).toFixed(2)} MB`);
}

const films = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(OUTPUTS);
// FRAMES=a:b renders frames a to b-1 only; AT=1.5,7 renders the frames at those times only (a look at single frames).
const range = process.env.FRAMES ? process.env.FRAMES.split(":").map(Number) : process.env.AT ? [0, 0] : null;
// The timelines name every clip; extract each one's frames first.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(HERE, "timelines.js"), "utf8"), sandbox);
const sources = sandbox.window.SOURCES;
for (const [name, src] of Object.entries(sources)) if (src.clip) extractClip(name, src);
// Large images are otherwise decoded off the main thread and drawn a frame later ("checker-imaging"), which made a few
// frames differ from one render to the next; one colour profile so a frame is the same on any display; text drawn with
// the same antialiasing whatever the page drew before (LCD text and subpixel positioning made glyph edges vary).
const browser = await chromium.launch({ args: ["--disable-checker-imaging", "--force-color-profile=srgb", "--disable-gpu-rasterization", "--disable-partial-raster", "--disable-lcd-text", "--disable-font-subpixel-positioning"] });
try {
  for (const film of films) {
    if (!OUTPUTS[film]) throw new Error(`no film ${film}: ${Object.keys(OUTPUTS).join(", ")}`);
    const dir = process.env.OUT ? path.resolve(process.env.OUT, film) : path.join(WORK, "render", film);
    const info = await render(browser, film, range, dir);
    console.log(`${film}: ${info.frames} frames, ${info.duration} s${range ? ` (frames ${range.join("-")} only)` : ""}`);
    if (!range) encode(film, info, dir);
  }
} finally {
  await browser.close();
}
