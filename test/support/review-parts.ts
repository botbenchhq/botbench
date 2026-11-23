/**
 * The parts of a diff as a reviewer's prompt holds them, in order, each between its `<diff-… part="i of n">` line and
 * the closing line with the same marker (src/engine/roles.ts, `reviewerPrompt`), with the marker and label of each.
 */
export function sentParts(prompt: string): { marker: string; label: string; text: string }[] {
  return [...prompt.matchAll(/<(diff-[0-9a-f]{12}) part="(\d+ of \d+)">\n([\s\S]*?)\n<\/\1>/g)].map((m) => ({ marker: m[1]!, label: m[2]!, text: m[3]! }));
}
