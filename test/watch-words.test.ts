import assert from "node:assert/strict";
import { test } from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import { NO_WATCH, PROPOSALS_ABOUT, proposalLine, startAddress, watchAbout, watchFailure, watchStateWords } from "../web/src/app/watch-words.ts";

// What Work and Settings say about the issue watch (issue #73), decided without a browser, held to docs/product/voice.md.

test("a watched repository's row says the label, how often, and in plain words that the label is not trust", () => {
  const about = watchAbout({ label: "botbench", intervalMinutes: 10, repository: "github.com/jon-lange/botbench" });
  assert.equal(about, "Botbench looks every 10 minutes for open issues of github.com/jon-lange/botbench with the label botbench, and shows each new one on Work for you to start or dismiss. It never starts a run by itself. The label is what makes an issue a proposal, but it is not a reason to trust one: anyone with triage access to the repository can apply it. Each proposal says who wrote the issue, its text is treated as outside text, and a run from it is never fully autonomous.");
  assert.match(watchAbout({ label: "x", intervalMinutes: 1, repository: null }), /^Botbench looks every minute for open issues with the label x,/);
  assert.equal(watchStateWords({ state: "waiting", checkedAt: null }), "Not checked yet");
  assert.equal(watchStateWords({ state: "failed", checkedAt: null }), "Could not check");
  assert.match(watchStateWords({ state: "checked", checkedAt: "2026-11-23T10:00:00Z" }), /^Checked at \d{1,2}:\d\d/);
});

test("a failed look names the repository, why, and when it tries again; what gh said is shown apart from Botbench's words", () => {
  const words = watchFailure({ path: "/Users/o/botbench", problem: "The gh tool is not signed in. Run gh auth login in a terminal on this Mac.", nextAt: "2026-11-23T10:15:00Z" });
  assert.equal(words.lead, "Botbench could not check the issues of botbench. The gh tool is not signed in. Run gh auth login in a terminal on this Mac.");
  // The time of day is this device's own way of writing it: 10:15, or 10:15 AM.
  assert.match(words.after, /^It tries again at \d{1,2}:\d\d( [AP]M)?\.$/);
});

test("a proposal's second line keeps its author apart, as outside text; Start opens the composer on that proposal", () => {
  assert.deepEqual(proposalLine({ number: 73, author: "someone", authorRelation: "NONE", repository: "github.com/jon-lange/botbench" }), { lead: "#73 by ", author: "someone", rest: " (GitHub says: no tie to the repository) · github.com/jon-lange/botbench" });
  assert.deepEqual(proposalLine({ number: 74, author: "jon-lange", authorRelation: "OWNER", repository: "r" }).rest, " (GitHub says: owner of the repository) · r");
  assert.deepEqual(proposalLine({ number: 7, author: null, authorRelation: null, repository: "r" }), { lead: "#7 by an account GitHub no longer has", author: null, rest: " (GitHub did not say how they relate to the repository) · r" });
  assert.equal(startAddress({ id: 12 }), "#/turn?start=run&proposal=12");
});

test("none of the watch's words is one the glossary keeps off the screen", () => {
  const all = [
    PROPOSALS_ABOUT,
    NO_WATCH,
    watchAbout({ label: "botbench", intervalMinutes: 10, repository: "github.com/a/b" }),
    ...(["waiting", "checking", "checked", "failed"] as const).map((state) => watchStateWords({ state, checkedAt: null })),
    watchFailure({ path: "/r", problem: "GitHub asked Botbench to wait before it reads the issues again.", nextAt: "2026-11-23T10:15:00Z" }).lead,
    ...(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE", null] as const).map((authorRelation) => proposalLine({ number: 1, author: "a", authorRelation, repository: "r" }).rest),
    "Issues to start",
    "Watched issues",
  ];
  for (const text of all) assert.deepEqual(bannedIn(text), [], text);
});
