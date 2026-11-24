import { visibleText } from "../../vendor/design-system/react/approval.tsx";
import { counted } from "../app/format.ts";

/**
 * Text with the characters that cannot be seen, or that reorder what is read (direction overrides, zero-width
 * marks, control codes other than tab and newline), written out by code point, so the card reads as what would run.
 * The design system's own rule, so a command and the facts beside it read alike.
 */
export const visible = (text: string): string => visibleText(text);

/** A count as it is said: "once", "3 times". */
export const times = (n: number): string => (n === 1 ? "once" : counted(n, "time", "times"));

/** Which step of the work asks, in the words of the steps: Plan, Build, Review. Any other name is shown as it is. */
export function stepWord(role: string): string {
  return { planner: "Plan", implementer: "Build", reviewer: "Review" }[role] ?? role;
}
