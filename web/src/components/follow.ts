/**
 * The rule a transcript follows its newest row by, as the design system's jump-to-latest gives it: follow while the
 * reader is within about 60px of the bottom, stop when they scroll up, count the rows added since, and follow again
 * when they jump to the latest or reach the bottom themselves.
 */
export const FOLLOW_WITHIN_PX = 60;

export interface Follow {
  following: boolean;
  /** Rows added since the reader scrolled up. */
  unseen: number;
}

export type FollowEvent = { kind: "rows"; added: number } | { kind: "scrolled"; nearBottom: boolean } | { kind: "jumped" };

export const nearBottom = (box: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean => box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_WITHIN_PX;

export function follow(state: Follow, event: FollowEvent): Follow {
  if (event.kind === "jumped") return { following: true, unseen: 0 };
  if (event.kind === "scrolled") return event.nearBottom ? { following: true, unseen: 0 } : { ...state, following: false };
  // Rows can fold into fewer (calls grouped into one step group), which is never a negative count.
  return state.following ? state : { ...state, unseen: state.unseen + Math.max(0, event.added) };
}

/** The count on the jump button, in the unit the transcript shows. Empty with nothing to count. */
export const jumpCount = (n: number): string => (n === 0 ? "" : n === 1 ? "1 new step" : `${n} new steps`);
