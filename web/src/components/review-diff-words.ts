// What the task screen says about how much of a task's diff its reviewer was sent (src/engine/review.ts), in one place,
// so the words test (test/review-diff-words.test.ts) reads the same sentences the screen shows.

import { counted, number, type Where } from "../app/format.ts";

/** The part of a review this line is about: the diff's length, whether it was cut, and what the reviewer's message held. */
export interface ReviewDiff {
  diffChars: number;
  diffCut: boolean;
  diffSent: { parts: number; chars: number } | null;
}

/** One plain sentence on what the reviewer saw of the change; null when it was sent nothing to say it about (it never started, or the change was empty). */
export function reviewDiffLine(review: ReviewDiff, where: Where = {}): string | null {
  const count = (n: number): string => number(n, where);
  const parts = (n: number): string => counted(n, "part", "parts", where);
  if (review.diffCut) {
    return review.diffSent === null
      ? `The diff was ${count(review.diffChars)} characters long, and the reviewer was sent only its first part.`
      : `The diff was ${count(review.diffChars)} characters long, and the reviewer saw only its first part: ${count(review.diffSent.chars)} characters in ${parts(review.diffSent.parts)}. It did not see the rest.`;
  }
  return review.diffSent === null ? null : `The reviewer was sent the whole change (${count(review.diffChars)} characters in ${parts(review.diffSent.parts)}).`;
}
