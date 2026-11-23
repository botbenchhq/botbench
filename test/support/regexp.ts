/**
 * `text` as a pattern that matches exactly that text: every character that means something in a regular expression is
 * escaped, the backslash included. The one escape the tests use, so none escapes only the characters its own text
 * happens to hold today.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
