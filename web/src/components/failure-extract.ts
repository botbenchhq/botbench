/** One line of a command's output, by its number in the output as stored (from 1). */
export interface ExtractLine {
  line: number;
  text: string;
}

/** Lines that name a cause: an error a program printed, a compiler's error, npm's. */
const CAUSE = [/\b[A-Za-z]*Error\b/, /\berror TS\d+\b/, /^npm (ERR!|error)/];
/** Lines that name what failed: a test runner's failure marks. */
const FAILURE = [/\bFAIL\b/, /^\s*not ok\b/, /✖/];
/** A line is long enough to read on a phone without the rest of the output. */
const MAX_CHARS = 300;

/** The text a line is compared by, so that one cause repeated with another temporary path or number is shown once. */
const sameness = (text: string): string => text.replace(/[A-Za-z0-9]*\d[A-Za-z0-9]*/g, "#").replace(/-[A-Za-z0-9]{6}\b/g, "-#");

/**
 * The first few lines of a failed check's output that look like its failure: up to three that name a cause (an
 * `Error`, `error TS…`, `npm ERR!`), then lines that name what failed (`FAIL`, `not ok`, `✖`), each shown once, in the
 * order they appear. A guess from common markers, not a reading of the output: the screen labels it as an extract.
 */
export function failureExtract(output: string, max = 5): ExtractLine[] {
  const lines = output.split("\n");
  const seen = new Set<string>();
  const pick = (markers: readonly RegExp[], limit: number, into: ExtractLine[]): void => {
    for (const [i, raw] of lines.entries()) {
      if (into.length >= limit) return;
      const text = raw.trimEnd();
      if (!markers.some((marker) => marker.test(text))) continue;
      const key = sameness(text.trim());
      if (seen.has(key)) continue;
      seen.add(key);
      into.push({ line: i + 1, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text });
    }
  };
  const found: ExtractLine[] = [];
  pick(CAUSE, Math.min(3, max), found);
  pick(FAILURE, max, found);
  return found.sort((a, b) => a.line - b.line);
}
