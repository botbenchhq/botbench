/**
 * The first line of a text, cut at the last whole word that fits in `max` characters and ended with a real ellipsis
 * when something was left out. A single word longer than `max` is cut where it is.
 */
export function firstLine(text: string, max = 60): string {
  const line = text.trim().split("\n")[0]!.trim();
  if (line.length <= max) return line;
  const fits = line.slice(0, max + 1);
  const space = fits.search(/\s\S*$/);
  const cut = (space > 0 ? fits.slice(0, space) : line.slice(0, max)).replace(/[\s,;:]+$/, "");
  return `${cut}…`;
}
