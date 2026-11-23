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

/** One word of a command read with its quotes: `text` is the word as the program gets it, `live` the part of it a shell still expands (what stood outside quotes or inside double quotes). */
export interface QuotedWord {
  text: string;
  live: string;
}

/** What separates the pieces of a command when it stands outside quotes. */
const OPERATORS = new Set([";", "&", "|", "\n", "\r", "(", ")", "{", "}"]);

/**
 * The pieces of a command between its operators, read with its quotes: an operator inside quotes does not split
 * (`grep "a\|b"`, `grep -n "admit("`), and a word's `live` part says what of it a shell may still turn into other
 * text. A substitution (`$(…)` or backquotes) stays in the word it stands in, live, so a program it produces is seen
 * as one the shell builds; outside quotes the command inside it is read as a piece of its own, and `substitutes` says
 * one stood inside double quotes, where this reading does not follow it. Null whenever this reading is not sure of
 * itself: an open quote, a backslash outside quotes, or a character that is neither printable ASCII nor a tab or line
 * break. It is used only to find which program each piece starts, and never lets anything through on its own.
 */
export function quotedPieces(command: string): { pieces: QuotedWord[][]; substitutes: boolean } | null {
  let substitutes = false;
  /** Inside a backquoted command outside double quotes: the next backquote ends it. They do not nest unescaped. */
  let inBackquotes = false;
  const pieces: QuotedWord[][] = [];
  let piece: QuotedWord[] = [];
  let word: QuotedWord | null = null;
  const add = (text: string, live: string): void => void (word = { text: (word?.text ?? "") + text, live: (word?.live ?? "") + live });
  const endWord = (): void => {
    if (word !== null) piece.push(word);
    word = null;
  };
  const endPiece = (): void => {
    endWord();
    if (piece.length > 0) pieces.push(piece);
    piece = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      add(command.slice(i + 1, end), "");
      i = end;
    } else if (c === '"') {
      let text = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const q = command[j]!;
        // A substitution inside double quotes runs a command of its own: it stays live in the word, and the caller reads the rest as before.
        if (q === "`" || (q === "$" && command[j + 1] === "(")) substitutes = true;
        // Inside double quotes a backslash only takes away the meaning of $, `, ", \ and a line break.
        if (q === "\\" && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1]!)) j++;
        text += command[j]!;
      }
      if (j >= command.length) return null;
      add(text, text);
      i = j;
    } else if (c === "\\") {
      return null;
    } else if (c === "`" && inBackquotes) {
      // The end of a backquoted command: what it prints already stands, live, in the word it was opened in.
      inBackquotes = false;
      endPiece();
    } else if ((c === "$" && command[i + 1] === "(") || c === "`") {
      // What the substitution prints becomes (part of) this word: live. The command inside it is a piece of its own.
      const opening = c === "`" ? "`" : "$(";
      add(opening, opening);
      endPiece();
      if (c === "$") i++;
      else inBackquotes = true;
    } else if ((c === "<" || c === ">") && command[i + 1] === "(") {
      endPiece();
      i++;
    } else if (OPERATORS.has(c)) {
      endPiece();
    } else if (c === " " || c === "\t" || c === "<" || c === ">") {
      endWord();
    } else if (PRINTABLE.test(c)) {
      add(c, c);
    } else {
      return null;
    }
  }
  endPiece();
  return { pieces, substitutes };
}

/** A list of words as one line a person can read and a shell would split the same way. */
export function showWords(words: readonly string[]): string {
  const bare = (word: string): boolean => word !== "" && !word.startsWith("=") && [...word].every((c) => BARE.test(c));
  return words.map((word) => (bare(word) ? word : word.includes("'") ? `"${word}"` : `'${word}'`)).join(" ");
}
