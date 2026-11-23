// What the task screen says about how much of a task's diff its reviewer was sent (src/engine/review.ts), in one place,
// so the words test (test/review-diff-words.test.ts) reads the same sentences the screen shows.

/** The part of a review this line is about: the diff's length, whether it was cut, and what the reviewer's message held. */
export interface ReviewDiff {
  diffChars: number;
  diffCut: boolean;
  diffSent: { parts: number; chars: number } | null;
}

const count = (n: number): string => n.toLocaleString("en-US");
const parts = (n: number): string => (n === 1 ? "1 part" : `${count(n)} parts`);

/** One plain sentence on what the reviewer saw of the change; null when it was sent nothing to say it about (it never started, or the change was empty). */
export function reviewDiffLine(review: ReviewDiff): string | null {
  if (review.diffCut) {
    return review.diffSent === null
      ? `The diff was ${count(review.diffChars)} characters long, and the reviewer was sent only its first part.`
      : `The diff was ${count(review.diffChars)} characters long, and the reviewer saw only its first part: ${count(review.diffSent.chars)} characters in ${parts(review.diffSent.parts)}. It did not see the rest.`;
  }
  return review.diffSent === null ? null : `The reviewer was sent the whole change (${count(review.diffChars)} characters in ${parts(review.diffSent.parts)}).`;
}
