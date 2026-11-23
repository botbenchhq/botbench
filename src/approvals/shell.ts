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
  /** Every character of the word stood inside quotes, and none of it is a variable or a substitution: the shell hands it over as written. */
  quoted?: boolean;
  /** The word follows a redirection (`<`, `>`, `>>`, `<>`, `>&`, `&>`, `n>`, `<<<`, a here-document's delimiter): a place, not an argument. */
  redirect?: boolean;
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
 * `asBefore`: read ANSI-C quoting as plain quotes, as this reading did before issue 133 (the floor's earlier reading).
 */
export function quotedPieces(command: string, asBefore = false): { pieces: QuotedWord[][]; substitutes: boolean } | null {
  let substitutes = false;
  /** Inside a backquoted command outside double quotes: the next backquote ends it. They do not nest unescaped. */
  let inBackquotes = false;
  const pieces: QuotedWord[][] = [];
  let piece: QuotedWord[] = [];
  let word: QuotedWord | null = null;
  let i = 0;
  /** A `<` or `>` stood since the last word: the next word is where it leads. */
  let redirect = false;
  // Called with `i` at the first character the part takes and `end` at the last; `inQuotes` when the part stood in quotes.
  const add = (text: string, live: string, end = i, inQuotes = false): void => {
    const started = word === null;
    word = {
      text: (word?.text ?? "") + text,
      live: (word?.live ?? "") + live,
      from: word?.from ?? i,
      to: end + 1,
      quoted: (word?.quoted ?? true) && inQuotes && !/[$`]/.test(live),
      redirect: word?.redirect ?? redirect,
    };
    if (started) redirect = false;
  };
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
    if (!asBefore && c === "$" && (command[i + 1] === "'" || command[i + 1] === '"')) return null;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      add(command.slice(i + 1, end), "", end, true);
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
      add(text, text, j, true);
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
      if (c === "<" || c === ">") redirect = true;
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
  /** The delimiter was quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`): the shell expands nothing in the text. */
  quoted: boolean;
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
 * in braces (`${…}`), arithmetic (`((…))`, `$[…]`) or a bracket outside quotes (zsh reads `$a[1<<X]` as arithmetic) (where `<<` may not be an operator, or the text may become words of another command).
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
    } else if (c === "`" || ((c === "$" || c === "<" || c === ">" || c === "=") && next === "(") || (c === "(" && next === "(") || (c === "$" && (next === "[" || next === "{")) || c === "[") {
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
        bodies.push({ text, quoted: p.quoted, literal: p.quoted || !/[$`\\]/.test(text), before: command.slice(p.pieceStart, p.at), piece: command.slice(p.pieceStart, p.pieceEnd!) });
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

/** One word of a command of the strict shape (`strictShape`), and what kind of word it is. */
export interface StrictWord {
  text: string;
  /** All of it in single quotes, all of it in double quotes, or unquoted. */
  kind: "single" | "double" | "bare";
  /** The word follows a redirection. */
  redirect: boolean;
}

/** The only characters an unquoted word may hold, besides `$NAME`, `${NAME}`, and `*` or `?` alone (never `**`). */
const STRICT_BARE = /[A-Za-z0-9_./:=@%+,-]/;
/** Words that, at the start of a piece, change how what follows is read or run: the shell's own words, prefixes that run another program, and builtins that change the shell's state. */
const NOT_A_PROGRAM = new Set([
  "if", "then", "else", "elif", "fi", "while", "until", "for", "do", "done", "case", "esac", "function", "select", "coproc", "time", "!", "{", "}", "[", "[[", "repeat", "foreach", "end",
  "builtin", "command", "exec", "noglob", "nocorrect", "-", "env", "nice", "nohup", "timeout", "xargs", "sudo", "doas", "su", "stdbuf", "watch", "flock", "caffeinate", "unbuffer", "parallel", "script", "time",
  "export", "declare", "typeset", "local", "readonly", "integer", "float", "set", "setopt", "unsetopt", "shopt", "alias", "unalias", "unset", "hash", "unhash", "rehash", "enable", "disable", "source", ".", "eval", "emulate", "trap", "ulimit", "umask", "cd", "chdir", "pushd", "popd", "dirs", "autoload", "zmodload", "bindkey", "fc", "history", "r", "functions", "vared", "read", "getopts", "let", "shift", "zstyle", "zle",
]);

/**
 * A command of the strict shape, as its pieces of words, or null for anything else. Only a command of this shape may be
 * read more leniently than the floor's earlier reading (floor.ts); every other command gets exactly that reading's
 * verdict. The shape:
 *   - pieces joined by `;`, `&&`, `||`, `|` or a line break; no `&` on its own, no `|&`;
 *   - every word wholly in single quotes, wholly in double quotes with no `$` or backquote (a backslash only as the shell
 *     reads it there), or unquoted and made of letters, digits and `_ . / : = @ % + , -`, `$NAME`, `${NAME}` and `*` or
 *     `?` (never two `*` together); no word that starts with `=` (zsh's `=program`); quoted and unquoted text never glued
 *     in one word;
 *   - redirections `<`, `>`, `>>` with an optional descriptor digit and an unquoted target, `N>&M`, and `<<`/`<<-` with a
 *     quoted delimiter (here-documents found by `hereDocuments`, every one with a quoted delimiter);
 *   - every piece starts with a program, unquoted, after any `NAME=value` words, that is none of `NOT_A_PROGRAM`;
 *     no piece is empty, but for a last one (`npm test;`).
 * `joins` holds the operator after each piece: `|` where the next piece runs at the same time, `;` where it runs after.
 * Anything else anywhere (a backquote, `$(`, `<(`, a brace, a bracket, a parenthesis, `~`, `#`, `!`, a tab-less control
 * character, a character outside ASCII) is no strict shape.
 */
export function strictShape(command: string): { pieces: StrictWord[][]; joins: string[] } | null {
  for (const c of command) if (c !== "\n" && c !== "\t" && !PRINTABLE.test(c)) return null;
  const here = hereDocuments(command);
  if (here === null || here.bodies.some((body) => !body.quoted)) return null;
  const text = here.command;
  const pieces: StrictWord[][] = [[]];
  /** The operator after each piece but the last: `|`, or `;` for any that runs the next piece after it (`;`, `&&`, `||`, a line break). */
  const joins: string[] = [];
  const ends = (at: number): boolean => at >= text.length || /[ \t\n;&|<>]/.test(text[at]!);
  let i = 0;
  let redirect: "none" | "target" | "delimiter" = "none";
  const push = (word: StrictWord): void => void pieces[pieces.length - 1]!.push(word);
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (redirect === "none" && (c === "\n" || c === ";" || (c === "&" && next === "&") || c === "|")) {
      if (c === "|" && next === "&") return null;
      joins.push(c === "|" && next !== "|" ? "|" : ";");
      pieces.push([]);
      i += (c === "&" || c === "|") && next === c ? 2 : 1;
      continue;
    }
    if (c === "&" || c === "\n" || c === ";" || c === "|") return null;
    if (redirect === "none" && (/[<>]/.test(c) || (/[0-9]/.test(c) && /[<>]/.test(next ?? "") && (i === 0 || /[ \t\n;&|]/.test(text[i - 1]!))))) {
      const op = /^[0-9]?(?:<<-?|>>|>&[0-9]|>|<)/.exec(text.slice(i))?.[0];
      if (op === undefined || /^[0-9]?<<</.test(text.slice(i)) || /^[0-9]?(?:<>|>\|)/.test(text.slice(i))) return null;
      i += op.length;
      redirect = op.includes("<<") ? "delimiter" : op.includes(">&") ? "none" : "target";
      if (op.includes(">&") && !ends(i)) return null;
      continue;
    }
    let word: StrictWord;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      word = { text: text.slice(i + 1, end), kind: "single", redirect: redirect !== "none" };
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let value = "";
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "$" || text[j] === "`") return null;
        // Inside double quotes a backslash only takes away the meaning of $, `, ", \ and a line break.
        if (text[j] === "\\" && '$`"\\\n'.includes(text[j + 1] ?? "")) j++;
        value += text[j]!;
      }
      if (j >= text.length) return null;
      word = { text: value, kind: "double", redirect: redirect !== "none" };
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !ends(j)) {
        const d = text[j]!;
        if (STRICT_BARE.test(d)) j++;
        else if (d === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.test(text.slice(j))) j += /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(text.slice(j))![0].length;
        else if ((d === "*" || d === "?") && text[j + 1] !== "*" && text[j - 1] !== "*") j++;
        else return null;
      }
      word = { text: text.slice(i, j), kind: "bare", redirect: redirect !== "none" };
      if (word.text.startsWith("=")) return null;
      i = j;
    }
    // Quoted and unquoted text glued in one word (`'a'{b,c}`, `"x"$Y`) is no strict shape.
    if (!ends(i)) return null;
    if (redirect === "target" && word.kind !== "bare") return null;
    if (redirect === "delimiter" && word.kind === "bare") return null;
    redirect = "none";
    push(word);
  }
  if (redirect !== "none") return null;
  // Empty pieces only at the end (`npm test;`, a last line break); one between operators is not read.
  while (pieces.length > 1 && pieces[pieces.length - 1]!.length === 0) {
    pieces.pop();
    joins.pop();
  }
  if (pieces.some((piece) => piece.length === 0)) return null;
  const kept = pieces;
  for (const piece of kept) {
    const first = piece.find((word) => !word.redirect && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text));
    if (first === undefined || first.kind !== "bare" || /[$*?]/.test(first.text)) return null;
    if (NOT_A_PROGRAM.has(first.text.slice(first.text.lastIndexOf("/") + 1).toLowerCase())) return null;
  }
  return { pieces: kept, joins };
}
