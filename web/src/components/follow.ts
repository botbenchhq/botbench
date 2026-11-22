/** The count on the jump-to-latest button, in the unit the transcript shows. Empty with nothing to count. The following itself is the design system's useTranscript. */
export const jumpCount = (n: number): string => (n === 0 ? "" : n === 1 ? "1 new step" : `${n} new steps`);
