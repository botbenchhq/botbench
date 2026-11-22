import fs from "node:fs";
import path from "node:path";

// The words Smelt never shows, read from the one place they are kept: the glossary table of docs/product/voice.md.
// The browser tests and the server's unit test both import this module, so the list is never written twice.

const VOICE = path.resolve(import.meta.dirname, "..", "docs", "product", "voice.md");

/** Every term in backticks in the third column of the glossary table. */
export function readBanned(markdown: string): string[] {
  const terms: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length !== 3) continue;
    for (const match of cells[2]!.matchAll(/`([^`]+)`/g)) terms.push(match[1]!.toLowerCase());
  }
  return [...new Set(terms)];
}

export const BANNED: readonly string[] = readBanned(fs.readFileSync(VOICE, "utf8"));

/**
 * What is let through: the one phrase in which a banned word may be shown (the git term, in helper text); a file
 * path inside a sentence, which is a fact about the machine and not Smelt's wording; and what a sentence quotes,
 * in double quotes or backticks, which is somebody else's text (a command, a name) and not Smelt's.
 */
const ALLOWED_PHRASES = [/\bgit worktrees?\b/gi, /"[^"\n]*"/g, /`[^`\n]*`/g, /(?<![\w.])~?\/[^\s"'`)]+/g];

const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A term as a whole word, in any case, with or without a final "s". A term of several words matches across any white space. */
const pattern = (term: string): RegExp => new RegExp(`(?<![\\w-])${escape(term).replace(/ /g, "\\s+")}s?(?![\\w-])`, "i");
const PATTERNS = BANNED.map((term) => ({ term, test: pattern(term) }));

/** The banned terms a piece of Smelt's own text holds. */
export function bannedIn(text: string): string[] {
  const cleared = ALLOWED_PHRASES.reduce((left, phrase) => left.replace(phrase, " "), text);
  return PATTERNS.filter(({ test }) => test.test(cleared)).map(({ term }) => term);
}
