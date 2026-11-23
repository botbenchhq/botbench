import assert from "node:assert/strict";
import test from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import { reviewDiffLine } from "../web/src/components/review-diff-words.ts";

// What the task screen says about how much of the change its reviewer saw (web/src/components/evidence.tsx), in each
// case: sent whole, cut after the most parts, a cut review from before parts, and a reviewer that was sent nothing.

test("the review says the reviewer was sent the whole change, or only when it was cut that it saw only the first part and how much", () => {
  assert.equal(reviewDiffLine({ diffChars: 132_890, diffCut: false, diffSent: { parts: 3, chars: 132_890 } }), "The reviewer was sent the whole change (132,890 characters in 3 parts).");
  assert.equal(reviewDiffLine({ diffChars: 120, diffCut: false, diffSent: { parts: 1, chars: 120 } }), "The reviewer was sent the whole change (120 characters in 1 part).");
  const cut = reviewDiffLine({ diffChars: 420_000, diffCut: true, diffSent: { parts: 6, chars: 359_990 } })!;
  assert.equal(cut, "The diff was 420,000 characters long, and the reviewer saw only its first part: 359,990 characters in 6 parts. It did not see the rest.");
  assert.equal(reviewDiffLine({ diffChars: 70_000, diffCut: true, diffSent: null }), "The diff was 70,000 characters long, and the reviewer was sent only its first part.");
  for (const whole of [{ diffChars: 50, diffCut: false, diffSent: { parts: 1, chars: 50 } }, { diffChars: 200_000, diffCut: false, diffSent: { parts: 4, chars: 200_000 } }]) assert.doesNotMatch(reviewDiffLine(whole)!, /only its first part/);
  // Sent nothing: never started, or the change was empty.
  assert.equal(reviewDiffLine({ diffChars: 0, diffCut: false, diffSent: null }), null);
  for (const line of [cut, reviewDiffLine({ diffChars: 70_000, diffCut: true, diffSent: null })!, reviewDiffLine({ diffChars: 9, diffCut: false, diffSent: { parts: 2, chars: 9 } })!]) assert.deepEqual(bannedIn(line), [], line);
});
