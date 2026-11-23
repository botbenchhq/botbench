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

/**
 * One word of a command read with its quotes: `text` is the word as the program gets it, `live` the part of it a shell
 * still expands (what stood outside quotes or inside double quotes), and `from` and `to` where it stands in the command.
 */
export interface QuotedWord {
  text: string;
  live: string;
  from?: number;
  to?: number;
}

/** What separates the pieces of a command when it stands outside quotes. */
const OPERATORS = new Set([";", "&", "|", "\n", "\r", "(", ")", "{", "}"]);

/**
 * The pieces of a command between its operators, read with its quotes: an operator inside quotes does not split
 * (`grep "a\|b"`, `grep -n "admit("`), and a word's `live` part says what of it a shell may still turn into other
 * text. A substitution (`$(…)` or backquotes) stays in the word it stands in, live, so a program it produces is seen
 * as one the shell builds; outside quotes the command inside it is read as a piece of its own, and `substitutes` says
 * one stood inside double quotes, where this reading does not follow it. Null whenever this reading is not sure of
 * itself: an open quote, a backslash outside quotes, ANSI-C quoting (`$'…'`), or a character that is neither printable ASCII nor a tab or line
 * break. It is used only to find which program each piece starts, and never lets anything through on its own.
 */
export function quotedPieces(command: string): { pieces: QuotedWord[][]; substitutes: boolean } | null {
  let substitutes = false;
  /** Inside a backquoted command outside double quotes: the next backquote ends it. They do not nest unescaped. */
  let inBackquotes = false;
  const pieces: QuotedWord[][] = [];
  let piece: QuotedWord[] = [];
  let word: QuotedWord | null = null;
  let i = 0;
  // Called with `i` at the first character the part takes and `end` at the last.
  const add = (text: string, live: string, end = i): void => void (word = { text: (word?.text ?? "") + text, live: (word?.live ?? "") + live, from: word?.from ?? i, to: end + 1 });
  const endWord = (): void => {
    if (word !== null) piece.push(word);
    word = null;
  };
  const endPiece = (): void => {
    endWord();
    if (piece.length > 0) pieces.push(piece);
    piece = [];
  };
  for (; i < command.length; i++) {
    const c = command[i]!;
    // ANSI-C and locale quoting (`$'…'`, `$"…"`) end where a plain quote would not: not followed.
    if (c === "$" && (command[i + 1] === "'" || command[i + 1] === '"')) return null;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      add(command.slice(i + 1, end), "", end);
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
      add(text, text, j);
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
      add(opening, opening, c === "$" ? i + 1 : i);
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

/** A here-document: its text, whether the shell leaves that text as it is, and the command line part it is given to. */
export interface HereDocument {
  /** The lines between the operator's line and the delimiter line. */
  text: string;
  /**
   * The shell hands the text over as written: the delimiter is quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`), or nothing in
   * the text is one the shell would expand ($, a backquote, a backslash). Otherwise the shell runs what its substitutions hold.
   */
  literal: boolean;
  /** The command's text in front of the operator, back to the operator that began its piece (`;`, `&`, `|`, `(`, `)`, a line break). */
  before: string;
  /** The whole piece the operator stands in, on its line. */
  piece: string;
}

/** What makes a piece end on the operator's line. */
const PIECE_ENDS = new Set([";", "&", "|", "(", ")", "\n"]);

/**
 * The here-documents of a command, found the way the shell finds them, and the command without their text. A command
 * with none comes back as it is. Null whenever this reading is not sure of itself, so that the caller reads the whole
 * text as it always did: a here-document with no end, a quote left open, a delimiter the shell builds, a backslash at the
 * end of the operator's line, ANSI-C quoting (`$'…'`), a control character other than a tab or a line break, and a
 * here-document in a command that also holds a comment, a substitution, a process substitution, a parameter expansion
 * in braces (`${…}`) or arithmetic (`((…))`, `$[…]`) (where `<<` may not be an operator, or the text may become words of another command).
 * It reads `command` as given, before any backslash at the end of a line joins two lines: in a here-document the shell
 * does not join them, so the delimiter line is found where the shell finds it.
 */
export function hereDocuments(command: string): { command: string; bodies: HereDocument[] } | null {
  // A control character other than a tab or a line break (`\r` after a delimiter) is a word character to the shell: not followed.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return null;
  if (!command.includes("<<")) return { command, bodies: [] };
  const bodies: HereDocument[] = [];
  /** The operators of the current line whose text follows it, in order. */
  let pending: { delimiter: string; tabs: boolean; quoted: boolean; at: number; pieceStart: number; pieceEnd: number | null }[] = [];
  let out = "";
  let copied = 0;
  let pieceStart = 0;
  let unsure = false;
  let i = 0;
  const wordStart = (at: number): boolean => at === 0 || /[\s;&|()<>]/.test(command[at - 1]!);
  while (i < command.length) {
    const c = command[i]!;
    const next = command[i + 1];
    if (c === "$" && (next === "'" || next === '"')) {
      // ANSI-C and locale quoting (`$'\''`) end where a plain quote would not.
      return null;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\") j++;
        else if (command[j] === "`" || (command[j] === "$" && command[j + 1] === "(")) unsure = true;
      }
      if (j >= command.length) return null;
      i = j + 1;
    } else if (c === "\\") {
      // A backslash at the end of the operator's line moves the text further down: not followed here.
      if (next === "\n" && pending.length > 0) return null;
      i += 2;
    } else if (c === "`" || ((c === "$" || c === "<" || c === ">" || c === "=") && next === "(") || (c === "(" && next === "(") || (c === "$" && (next === "[" || next === "{"))) {
      unsure = true;
      i += 2;
    } else if (c === "#" && wordStart(i)) {
      unsure = true;
      while (i < command.length && command[i] !== "\n") i++;
    } else if (c === "<" && next === "<" && command[i + 2] === "<") {
      // A here-string: the word after it is the input, on the same line.
      i += 3;
    } else if (c === "<" && next === "<") {
      let j = i + 2;
      const tabs = command[j] === "-";
      if (tabs) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      let delimiter = "";
      let quoted = false;
      while (j < command.length && !/[ \t\n;&|()<>]/.test(command[j]!)) {
        const d = command[j]!;
        if (d === "'" || d === '"') {
          const end = command.indexOf(d, j + 1);
          if (end === -1) return null;
          delimiter += command.slice(j + 1, end);
          quoted = true;
          j = end + 1;
        } else if (d === "\\") {
          if (j + 1 >= command.length) return null;
          delimiter += command[j + 1]!;
          quoted = true;
          j += 2;
        } else if (d === "$" || d === "`") {
          return null;
        } else {
          delimiter += d;
          j++;
        }
      }
      if (delimiter === "" || delimiter.includes("\n")) return null;
      pending.push({ delimiter, tabs, quoted, at: i, pieceStart, pieceEnd: null });
      i = j;
    } else if (c === "\n") {
      for (const p of pending) p.pieceEnd ??= i;
      pieceStart = i + 1;
      i++;
      if (pending.length === 0) continue;
      // The text of each here-document of this line follows it, one after the other.
      out += command.slice(copied, i);
      for (const p of pending) {
        const lines: string[] = [];
        for (;;) {
          if (i >= command.length) return null;
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end + 1;
          if ((p.tabs ? line.replace(/^\t+/, "") : line) === p.delimiter) break;
          lines.push(p.tabs ? line.replace(/^\t+/, "") : line);
        }
        const text = lines.join("\n");
        bodies.push({ text, literal: p.quoted || !/[$`\\]/.test(text), before: command.slice(p.pieceStart, p.at), piece: command.slice(p.pieceStart, p.pieceEnd!) });
      }
      pending = [];
      copied = i;
      pieceStart = i;
    } else {
      if (PIECE_ENDS.has(c)) {
        for (const p of pending) p.pieceEnd ??= i;
        pieceStart = i + 1;
      }
      i++;
    }
  }
  // An operator on the last line has no text after it.
  if (pending.length > 0) return null;
  if (bodies.length > 0 && unsure) return null;
  return { command: out + command.slice(copied), bodies };
}

/** A list of words as one line a person can read and a shell would split the same way. */
export function showWords(words: readonly string[]): string {
  const bare = (word: string): boolean => word !== "" && !word.startsWith("=") && [...word].every((c) => BARE.test(c));
  return words.map((word) => (bare(word) ? word : word.includes("'") ? `"${word}"` : `'${word}'`)).join(" ");
}
