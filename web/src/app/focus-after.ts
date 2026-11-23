/**
 * Where the focus goes once the row at position `at` of a list was removed, of the rows `left`: the row that took its
 * place, or the last row when the removed one was last. Undefined when no row is left: the caller then focuses the
 * list's heading.
 */
export const takesItsPlace = <T>(left: readonly T[], at: number): T | undefined => left[Math.min(at, left.length - 1)];
