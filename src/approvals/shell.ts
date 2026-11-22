/*
 * Reading a shell command the careful way. Botbench never runs what it reads here; it only decides whether a
 * command is plain enough to be compared word by word. The reading is narrower than any shell's: whatever
 * it is not sure a shell would take as ordinary words makes the whole command "not plain", and a command
 * that is not plain is never matched by a grant.
 */

/** What may stand in a word outside quotes: nothing a shell (bash or zsh) expands, globs, splits or runs. */
const BARE = /[A-Za-z0-9_\-./:=@+,~]/;
/** Printable ASCII. Control characters, and every character beyond ASCII (other spaces, look-alikes, invisible ones), are refused everywhere. */
const PRINTABLE = /[\x20-\x7e]/;
/** Inside double quotes a shell still expands and substitutes on these. */
const LIVE_IN_DOUBLE_QUOTES = new Set(["$", "`", "\\", "!"]);

/**
 * The words of `command`, as a shell would hand them to the program, when the command is one plain command:
 * words separated by spaces, with parts in single or double quotes. Null for everything else: an operator
 * that chains, pipes, substitutes, redirects or runs in the background, a variable, a glob, a backslash, a
 * comment, a line break or any other control character, a character outside ASCII, an open quote, or nothing at all.
 */
export function splitPlain(command: string): string[] | null {
  const words: string[] = [];
  /** The word being read; null between words, so that `''` is still a word. */
  let word: string | null = null;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (!PRINTABLE.test(c)) return null;
    if (c === " ") {
      if (word !== null) words.push(word);
      word = null;
      i++;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return null;
      const quoted = command.slice(i + 1, end);
      for (const q of quoted) if (!PRINTABLE.test(q) || (c === '"' && LIVE_IN_DOUBLE_QUOTES.has(q))) return null;
      word = (word ?? "") + quoted;
      i = end + 1;
    } else if (BARE.test(c)) {
      // zsh replaces a word that begins with `=` by the path of the program so named, also after an empty quoted part.
      if (c === "=" && (word === null || word === "")) return null;
      word = (word ?? "") + c;
      i++;
    } else {
      return null;
    }
  }
  if (word !== null) words.push(word);
  return words.length === 0 ? null : words;
}

/**
 * A rough reading of a command that is not plain, for naming what it holds and never for allowing it: the
 * pieces between its operators, each as words with their quotes dropped and `$HOME` written out.
 */
export function roughSegments(command: string, home: string): string[][] {
  return command
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .split(/\$\(|<\(|>\(|[;&|\n\r(){}`]/)
    .map((piece) => piece.replace(/[<>]+/g, " ").replace(/['"\\]/g, "").split(/\s+/).filter((word) => word !== ""))
    .filter((words) => words.length > 0);
}

/** A list of words as one line a person can read and a shell would split the same way. */
export function showWords(words: readonly string[]): string {
  const bare = (word: string): boolean => word !== "" && !word.startsWith("=") && [...word].every((c) => BARE.test(c));
  return words.map((word) => (bare(word) ? word : word.includes("'") ? `"${word}"` : `'${word}'`)).join(" ");
}
