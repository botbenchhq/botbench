// The shots of every Botbench film, read by film.html. Times are seconds; camera keyframes are [t, cx, cy, w] in the
// source's own pixels, where w is the width of the source the frame shows (the frame never shows more than 1 source
// pixel per output pixel). Every product shot is one of Botbench's own recordings or screenshots (docs/media,
// docs/images, made by `npm run media` from e2e/media.shots.ts); the words on cards and above frames are title text.
window.FPS = 30;
window.XF = 0.4; // a cut: the next shot fades in over the last one, eased in and out
window.TEXT_FADE = 0.15; // title text changes at the middle of a cut: out over 0.15 s, the new words in over 0.15 s
window.CAPTION = "Recorded from Botbench. Agents' parts replayed from recorded sessions.";
window.CAPTION_CARD = "Title card.";

// Sources: a clip's frames are extracted by render.mjs into work/frames/<name>/ at its own 30 fps.
window.SOURCES = {
  demo: { clip: "../botbench-demo.mp4", w: 1440, h: 900, frames: 757 },
  together: { clip: "../check-together.mp4", w: 1440, h: 900, frames: 404 },
  review: { file: "../../images/ready-for-review-proof.png", w: 2880, h: 1800 },
  overlap: { file: "../../images/peers/peers-overlap-desktop.png", w: 2880, h: 1800 },
  passed: { file: "../../images/peers/peers-passed-together-desktop.png", w: 2880, h: 1800 },
  claim: { file: "../../images/peers/peers-claim-warning-desktop.png", w: 2880, h: 1800 },
};

const MARK = "../../../assets/svg/botbench-mark-two-tone-dark.svg";
const LOCKUP = "../../../assets/svg/botbench-lockup-two-tone-dark.svg";
const URL = "botbenchhq.github.io";

window.LAYOUTS = {
  // 1920x1080: the recording at its own size (1440x900) in a dark frame, a line of title text above, the caption below.
  launch: { w: 1920, h: 1080, frame: { x: 240, y: 104, w: 1440, h: 900 }, kicker: { top: 34, size: 34, pad: 120 }, caption: { top: 1030, size: 19 }, card: { head: 96, sub: 40, gap: 26, mark: 96 } },
  // The website loop: the product full-bleed, no text (the page around it carries the caption).
  loop: { w: 1280, h: 800, frame: { x: 0, y: 0, w: 1280, h: 800, bleed: true }, card: { head: 64, sub: 28, gap: 18, mark: 64 } },
  square: { w: 1080, h: 1080, frame: { x: 40, y: 200, w: 1000, h: 800 }, kicker: { top: 52, size: 44, pad: 56 }, caption: { top: 1028, size: 21 }, card: { head: 78, sub: 38, gap: 24, mark: 84 } },
  portrait: { w: 1080, h: 1350, frame: { x: 40, y: 236, w: 1000, h: 1020 }, kicker: { top: 66, size: 48, pad: 56 }, caption: { top: 1290, size: 22 }, card: { head: 84, sub: 40, gap: 26, mark: 90 } },
};

// Reused framings, in source pixels.
const REVIEW_EVIDENCE = [1364, 975, 1560]; // "1 of 1 check passed" and Codex's review, "A model's opinion, not a check."
const OVERLAP_LINE = [1364, 800, 1560]; // the changed files and the overlap line under them
const PASSED_TOGETHER = [1364, 860, 1560]; // "With dev1's pull request #128" … "Passed together:"
const CLAIM_WARNING = [1704, 1060, 1720]; // the composer and "dev1 started on this issue 2 minutes ago."
const push = (from, to, hold, at = 0.9) => [[0, ...from], [at, ...from], [at + 0.75, ...to], [hold, ...to]]; // one 750 ms push, then still

const opening = { kind: "card", mark: MARK, head: "Hand work to your agents.", sub: "Walk away. Come back to the branch." };
const teammate = { kind: "card", head: "With a teammate.", sub: "Your agents. Their agents. One coordinated workflow.", early: true };
const ending = { kind: "card", mark: LOCKUP, head: "Put your agents to work. Together.", url: URL };

window.FILMS = {
  launch: {
    layout: "launch",
    poster: 14.0,
    shots: [
      { ...opening, dur: 3.0, cardCaption: window.CAPTION },
      { kind: "clip", src: "demo", from: 2.9, dur: 4.8, step: "1", kicker: "You approve the plan. Claude Code builds it." },
      { kind: "clip", src: "demo", from: 9.3, dur: 2.8, step: "2", kicker: "Walk away. It works in its own copy, on its own branch." },
      { kind: "still", src: "review", dur: 6.2, step: "3", kicker: "Come back to evidence: your check, and a second opinion.", cam: push([1440, 900, 2880], REVIEW_EVIDENCE, 6.2) },
      { kind: "clip", src: "demo", from: 17.0, dur: 4.4, step: "4", kicker: "The decision is yours: Accept or Reject." },
      { ...teammate, dur: 2.6 },
      { kind: "still", src: "overlap", dur: 4.8, kicker: "Botbench tells you before your work collides.", early: true, cam: push([1440, 900, 2880], OVERLAP_LINE, 4.8) },
      { kind: "clip", src: "together", from: 3.8, dur: 5.0, kicker: "Check both changes together, in a temporary copy.", early: true },
      { kind: "still", src: "passed", dur: 3.8, join: true, kicker: "Check both changes together, in a temporary copy.", early: true, cam: [[0, ...PASSED_TOGETHER], [3.8, ...PASSED_TOGETHER]] },
      { kind: "still", src: "claim", dur: 4.3, kicker: "And who started on an issue first.", early: true, cam: push([1440, 900, 2880], CLAIM_WARNING, 4.3, 0.7) },
      { ...ending, dur: 4.2 },
    ],
  },
  loop: {
    layout: "loop",
    loop: true,
    poster: 3.0,
    shots: [
      { kind: "still", src: "review", dur: 5.8, cam: push([1440, 900, 2880], REVIEW_EVIDENCE, 5.8, 0.8) },
      { kind: "clip", src: "demo", from: 17.4, dur: 4.4 },
    ],
  },
  square: {
    layout: "square",
    poster: 5.0,
    shots: [
      { ...opening, dur: 2.8, cardCaption: window.CAPTION },
      { kind: "still", src: "review", dur: 5.2, kicker: "Come back to a branch with evidence.", cam: push([1364, 830, 1760], REVIEW_EVIDENCE, 5.2, 0.7) },
      { kind: "clip", src: "demo", from: 17.4, dur: 4.2, kicker: "The decision is yours.", cam: [[0, 940, 400, 1000]] },
      { ...teammate, dur: 2.6 },
      { kind: "still", src: "overlap", dur: 4.4, kicker: "Told before your work collides.", early: true, cam: push([1364, 900, 1760], OVERLAP_LINE, 4.4, 0.6) },
      { kind: "still", src: "passed", dur: 4.0, kicker: "Both changes, checked together.", early: true, cam: [[0, ...PASSED_TOGETHER]] },
      { kind: "still", src: "claim", dur: 4.2, kicker: "Who started on an issue first.", early: true, cam: [[0, ...CLAIM_WARNING]] },
      { ...ending, dur: 3.6 },
    ],
  },
};
// The 4:5 cut is the square cut's shots in a taller frame. Its taller view of the review would cut through the task's
// title at the top edge, so that one push ends a little higher, with the title whole and the evidence below it.
window.FILMS.portrait = {
  ...window.FILMS.square,
  layout: "portrait",
  shots: window.FILMS.square.shots.map((s) => (s.src === "review" ? { ...s, cam: push([1364, 900, 1760], [1364, 915, 1560], 5.2, 0.7) } : s)),
};
