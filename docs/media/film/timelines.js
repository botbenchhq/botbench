// The shots of every Botbench film, read by film.html. Times are seconds; camera keyframes are [t, cx, cy, w] in the
// source's own pixels, where w is the width of the source the frame shows (the frame never shows more than 1 source
// pixel per output pixel). Every product shot is one of Botbench's own recordings or screenshots (docs/media,
// docs/images, made by `npm run media` from e2e/media.shots.ts); the words on cards and above frames are title text.
window.FPS = 30;
window.XF = 0.4; // a cut: the next shot fades in over the last one, eased in and out
window.TEXT_FADE = 0.15; // title text changes at the middle of a cut: out over 0.15 s, the new words in over 0.15 s

// What each shot is, said on it. The agents' parts of the demo are replayed from recorded sessions; the screens between
// workbenches have no agent part: their task was set up by the test, and the checks really ran.
window.CAPTION = "Recorded from Botbench. Agents' parts replayed from recorded sessions.";
window.CAPTION_CARD = "Title card.";
const SEEDED = "Recorded from Botbench. The task was set up by a test; the check and the check together really ran.";
const CLAIMED = "Recorded from Botbench. dev1's claim was pushed by a test, with Botbench's own claim push.";

// Sources: a clip's frames are extracted by render.mjs into work/frames/<name>/ at its own 30 fps.
window.SOURCES = {
  demo: { clip: "../botbench-demo.mp4", w: 1440, h: 900, frames: 757 },
  review: { file: "../../images/ready-for-review-proof.png", w: 2880, h: 1800 },
  // The same screens at a phone's size (390 wide at 3x): their lines are large enough for a 1080-wide film.
  reviewPhone: { file: "../../images/ready-for-review.png", w: 1170, h: 2532 },
  overlapPhone: { file: "../../images/peers/peers-overlap-phone.png", w: 1170, h: 2532 },
  passedPhone: { file: "../../images/peers/peers-passed-together-phone.png", w: 1170, h: 2532 },
  claimPhone: { file: "../../images/peers/peers-claim-warning-phone.png", w: 1170, h: 2532 },
};

const MARK = "../../../assets/svg/botbench-mark-two-tone-dark.svg";
const LOCKUP = "../../../assets/svg/botbench-lockup-two-tone-dark.svg";
const URL = "botbenchhq.github.io";

window.LAYOUTS = {
  // 1920x1080: a headline above (52 px, Inter 600), the recording in a dark frame below, the caption at the foot.
  launch: { w: 1920, h: 1080, frame: { x: 256, y: 128, w: 1408, h: 880 }, kicker: { top: 36, size: 52, pad: 120 }, caption: { top: 1032, size: 24 }, card: { head: 96, sub: 40, gap: 26, mark: 96 } },
  // The website loop: the product full-bleed, no text (the page around it carries the caption).
  loop: { w: 1280, h: 800, frame: { x: 0, y: 0, w: 1280, h: 800, bleed: true }, card: { head: 64, sub: 28, gap: 18, mark: 64 } },
  square: { w: 1080, h: 1080, frame: { x: 40, y: 196, w: 1000, h: 790 }, kicker: { top: 40, size: 56, pad: 48 }, caption: { top: 1010, size: 22 }, card: { head: 78, sub: 38, gap: 24, mark: 84 } },
  portrait: { w: 1080, h: 1350, frame: { x: 40, y: 236, w: 1000, h: 1000 }, kicker: { top: 60, size: 60, pad: 48 }, caption: { top: 1262, size: 24 }, card: { head: 84, sub: 40, gap: 26, mark: 90 } },
};

// One 750 ms camera move, eased in and out, then still: from `from` to `to`, starting at `at`, held until `hold`.
const push = (from, to, hold, at = 0.6) => [[0, ...from], [at, ...from], [at + 0.75, ...to], [hold, ...to]];
const still = (view, hold) => [[0, ...view], [hold, ...view]];

// Framing of the desktop picture of the review (2880x1800), in source pixels.
const REVIEW_EVIDENCE = [1364, 975, 1560]; // "1 of 1 check passed" and Codex's review, "A model's opinion, not a check."

// Framings of the phone pictures (1170x2532): each shown at 1100 px wide in a 1000-wide frame, so text is 0.91x its
// 3x size (13 px type is 35 px on screen).
const PHONE_EVIDENCE = [585, 935, 1100]; // branch, commit, "Ready for review", "1 of 1 check passed"
const PHONE_DECISION = [585, 1880, 1100]; // the check, "Accept keeps the branch. Nothing is pushed or merged.", Reject and Accept
// The overlap view must fit between the diff's line 5 and the "Check together" heading (y 790 to 1505): 715 px at most.
const PHONE_OVERLAP = [585, 1152, 1100], PHONE_OVERLAP_WIDE = [585, 1152, 1115], PHONE_OVERLAP_FRAME = { w: 1000, h: 640 };
const PHONE_PASSED = [585, 1045, 1100], PHONE_PASSED_WIDE = [585, 1045, 1170], PHONE_PASSED_FRAME = { w: 1000, h: 740 };
const PHONE_CLAIM = [585, 1650, 1100], PHONE_CLAIM_WIDE = [585, 1650, 1170], PHONE_CLAIM_FRAME = { w: 1000, h: 640 };

// In the launch film the same pictures are shown at 1:1 (13 px type is 39 px), after a short push from 0.94x.
const LAUNCH_OVERLAP_WIDE = [585, 1152, 1170], LAUNCH_OVERLAP_FRAME = { w: 1100, h: 640 }, LAUNCH_PASSED_FRAME = { w: 1100, h: 800 }, LAUNCH_CLAIM_FRAME = { w: 1100, h: 704 };

const opening = { kind: "card", mark: MARK, head: "Hand work to your agents.", sub: "Walk away. Come back to the branch.", caption: window.CAPTION };
const teammate = { kind: "card", head: "With a teammate.", sub: "Your agents. Their agents. One coordinated workflow." };
const ending = { kind: "card", mark: LOCKUP, head: "Put your agents to work. Together.", url: URL };

window.FILMS = {
  launch: {
    layout: "launch",
    poster: 13.0,
    shots: [
      { ...opening, dur: 3.0 },
      { kind: "clip", src: "demo", from: 2.9, dur: 4.8, kicker: "You approve the plan. Claude Code builds it." },
      { kind: "clip", src: "demo", from: 9.3, dur: 3.0, kicker: "Walk away. It works on its own branch." },
      { kind: "still", src: "review", dur: 6.2, kicker: "Come back to evidence: your check, a second opinion.", cam: push([1440, 900, 2880], REVIEW_EVIDENCE, 6.2, 0.9) },
      { kind: "clip", src: "demo", from: 17.0, dur: 4.4, kicker: "The decision is yours: Accept or Reject." },
      { ...teammate, dur: 2.8 },
      { kind: "still", src: "overlapPhone", dur: 5.0, frame: LAUNCH_OVERLAP_FRAME, kicker: "Told before your work collides.", caption: SEEDED, cam: push(LAUNCH_OVERLAP_WIDE, PHONE_OVERLAP, 5.0) },
      { kind: "still", src: "passedPhone", dur: 4.6, frame: LAUNCH_PASSED_FRAME, kicker: "Both changes, checked together.", caption: SEEDED, cam: push(PHONE_PASSED_WIDE, PHONE_PASSED, 4.6) },
      { kind: "still", src: "claimPhone", dur: 4.6, frame: LAUNCH_CLAIM_FRAME, kicker: "Who started on an issue first.", caption: CLAIMED, cam: push(PHONE_CLAIM_WIDE, PHONE_CLAIM, 4.6) },
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
    poster: 4.5,
    shots: [
      { ...opening, dur: 2.8 },
      { kind: "still", src: "reviewPhone", dur: 3.2, kicker: "Come back to a branch with evidence.", cam: still(PHONE_EVIDENCE, 3.2) },
      { kind: "still", src: "reviewPhone", dur: 3.4, join: true, kicker: "The decision is yours.", cam: push(PHONE_EVIDENCE, PHONE_DECISION, 3.4, 0.25) },
      { ...teammate, dur: 2.6 },
      { kind: "still", src: "overlapPhone", dur: 4.4, frame: PHONE_OVERLAP_FRAME, kicker: "Told before your work collides.", caption: SEEDED, cam: push(PHONE_OVERLAP_WIDE, PHONE_OVERLAP, 4.4, 0.5) },
      { kind: "still", src: "passedPhone", dur: 4.2, frame: PHONE_PASSED_FRAME, kicker: "Both changes, checked together.", caption: SEEDED, cam: push(PHONE_PASSED_WIDE, PHONE_PASSED, 4.2, 0.5) },
      { kind: "still", src: "claimPhone", dur: 4.2, frame: PHONE_CLAIM_FRAME, kicker: "Who started on an issue first.", caption: CLAIMED, cam: push(PHONE_CLAIM_WIDE, PHONE_CLAIM, 4.2, 0.5) },
      { ...ending, dur: 3.6 },
    ],
  },
};
// The 4:5 cut is the square cut's shots in a taller frame; the review's views move up, and the decision view stops
// above the phone's tab bar.
window.FILMS.portrait = {
  ...window.FILMS.square,
  layout: "portrait",
  shots: window.FILMS.square.shots.map((s) => {
    if (s.src !== "reviewPhone") return s;
    // A frame a little shorter than the layout's, so the view runs from under the task's title to above its check.
    const frame = { w: 1000, h: 900 }, evidence = [585, 895, 1100];
    return s.join ? { ...s, frame, cam: push(evidence, [585, 1868, 1100], 3.4, 0.25) } : { ...s, frame, cam: still(evidence, s.dur) };
  }),
};
