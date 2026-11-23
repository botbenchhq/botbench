/**
 * The small part of markdown an agent's reply and a review are drawn with: paragraphs, bold, italic, inline code,
 * fenced code blocks, and bullet and numbered lists. Everything else (headings, quotes, tables, links, images, rules,
 * raw HTML) stays the text it was. The result is a plain data tree with no HTML in it; `markdown-view.tsx` turns it
 * into React elements, so model output is only ever text on screen: no element it names is made, no link it writes is
 * live, and no image it points at is fetched.
 *
 * Every step is linear in the length of the text, whatever it holds, so a hostile reply (a megabyte of asterisks, a
 * run of backticks of every length) cannot stall the screen. Nesting of bold and italic is capped; past the cap the
 * markers are shown as written.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] };

export interface ListItem {
  /**
   * What the row shows before the item, as a list row draws no mark of its own: a numbered item's number and mark as
   * written, with its space ("3. "); a bullet item's is a bullet ("• "), whichever of - * + it was written with.
   */
  marker: string;
  children: Inline[];
}

const BULLET_MARK = "• ";

export type Block = { kind: "paragraph"; children: Inline[] } | { kind: "code"; text: string } | { kind: "list"; ordered: boolean; items: ListItem[] };

/** How deep bold and italic may nest before further markers are shown as written. */
const MAX_DEPTH = 8;

/** `[^]*` (not `.*`): a line separator such as U+2028 after a long marker run must not make the run backtrack length by length. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BULLET = /^[ \t]*[-*+][ \t]+(\S.*)$/;
const NUMBERED = /^[ \t]*(\d{1,9})([.)])[ \t]+(\S.*)$/;
/** A thematic break (---, * * *) is not supported, so it must not be read as a bullet item either. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HTML_BLOCK = /^ {0,3}<[A-Za-z/!?]/;
/** A heading, a quote or a table row: not supported, so the whole line is kept as written, markers inside it included. */
const LITERAL_LINE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|\|)/;

/** The fence a line opens, or null. A backtick fence's info string may hold no backtick, so ```a``` stays inline code. */
function fenceOpened(line: string): string | null {
  const m = FENCE_OPEN.exec(line);
  if (m === null) return null;
  const marker = m[1]!;
  return marker[0] === "`" && m[2]!.includes("`") ? null : marker;
}

/** Parse markdown text into blocks. Never throws; text it does not support comes back as text. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  // Kept from narrowing to null, as flush() sets them back from inside a closure.
  // A paragraph is a run of chunks: lines drawn with the inline subset, and lines kept as written.
  let paragraph = null as { literal: boolean; lines: string[] }[] | null;
  let list = null as { ordered: boolean; items: { marker: string; lines: string[] }[] } | null;
  const addLine = (line: string, literal: boolean) => {
    paragraph ??= [];
    const last = paragraph.at(-1);
    if (last?.literal === literal) last.lines.push(line);
    else paragraph.push({ literal, lines: [line] });
  };
  const flush = () => {
    if (paragraph !== null) {
      const pieces: Piece[] = [];
      paragraph.forEach((chunk, i) => {
        if (i > 0) pieces.push({ kind: "text", text: "\n" });
        const whole = chunk.lines.join("\n");
        if (chunk.literal) pieces.push({ kind: "text", text: whole });
        // One push at a time: spreading a very long paragraph's nodes into push() would overflow the stack.
        else for (const node of parseInline(whole)) pieces.push(node);
      });
      blocks.push({ kind: "paragraph", children: finish(pieces) });
    }
    if (list !== null) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map((i) => ({ marker: i.marker, children: parseInline(i.lines.join("\n")) })) });
    paragraph = null;
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = fenceOpened(line);
    if (fence !== null) {
      flush();
      // Only the same marker, of the same length, ends the block: a longer one or the other kind inside it is code,
      // so a fence nested in the text cannot close the block early. With no end, the block runs to the end of the text.
      const body: string[] = [];
      for (i++; i < lines.length && FENCE_CLOSE.exec(lines[i]!)?.[1] !== fence; i++) body.push(lines[i]!);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (paragraph === null && HTML_BLOCK.test(line)) {
      // An HTML block, which this subset does not draw: every line up to a blank one is kept as written, so a list
      // marker or a fence inside it is text too.
      flush();
      const body = [line];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") body.push(lines[++i]!);
      blocks.push({ kind: "paragraph", children: [{ kind: "text", text: body.join("\n") }] });
      continue;
    }
    if (LITERAL_LINE.test(line)) {
      if (list !== null) flush();
      addLine(line, true);
      continue;
    }
    if (!RULE.test(line)) {
      const bullet = BULLET.exec(line);
      const numbered = bullet === null ? NUMBERED.exec(line) : null;
      // A numbered line other than 1 does not break into a paragraph: "built in\n1999. Then" is one sentence.
      if (bullet !== null || (numbered !== null && (paragraph === null || numbered[1] === "1"))) {
        const ordered = numbered !== null;
        if (paragraph !== null || (list !== null && list.ordered !== ordered)) flush();
        list ??= { ordered, items: [] };
        list.items.push(numbered !== null ? { marker: `${numbered[1]}${numbered[2]} `, lines: [numbered[3]!] } : { marker: BULLET_MARK, lines: [bullet![1]!] });
        continue;
      }
    }
    // A line under an item, without a blank line between, goes on with that item.
    if (list !== null) list.items.at(-1)!.lines.push(line.trimStart());
    else addLine(line, false);
  }
  flush();
  return blocks;
}

/** A piece of a paragraph while it is parsed: drawn inline nodes, and groups past the depth cap shown as written. */
type Piece = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "strong" | "em" | "plain"; children: Piece[] };

/** One entry of the doubly linked list a paragraph is parsed into, so wrapping a stretch of it costs only its length. */
interface Entry {
  prev: Entry | null;
  next: Entry | null;
  piece: Piece | null;
  depth: number;
  /** A run of * or _ still able to open or close. */
  delim: { char: string; count: number; canOpen: boolean; canClose: boolean } | null;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const kindOf = (ch: string | undefined) => (ch === undefined || SPACE.test(ch) ? "space" : PUNCTUATION.test(ch) ? "punct" : "other");

/** The code spans of a text: a backtick run ends at the next run of exactly its length, found with one pointer per length. */
function codeSpans(text: string, escaped: Set<number>): { start: number; end: number; open: number }[] {
  const runs: { start: number; len: number }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`" || escaped.has(i)) {
      i++;
      continue;
    }
    const start = i;
    while (text[i] === "`") i++;
    runs.push({ start, len: i - start });
  }
  const byLength = new Map<number, number[]>();
  runs.forEach((r, i) => (byLength.get(r.len) ?? byLength.set(r.len, []).get(r.len)!).push(i));
  const next = new Map<number, number>();
  const spans: { start: number; end: number; open: number }[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const same = byLength.get(run.len)!;
    let at = next.get(run.len) ?? 0;
    while (at < same.length && same[at]! <= i) at++;
    next.set(run.len, at);
    if (at === same.length) continue;
    const close = same[at]!;
    spans.push({ start: run.start, end: runs[close]!.start + run.len, open: run.len });
    i = close;
  }
  return spans;
}

/**
 * The stretches of a text that are links, images or HTML tags, which this subset does not draw: each is shown as
 * written, so no marker or code span inside one is drawn either. In order and apart; a link inside a link is part of
 * the outer. A code span that starts outside any of them is passed over whole, so `<div>` and `[a](b)` written as code
 * stay code. One pass: brackets are matched with a stack, and the next ")" or ">" is found by a search that only moves
 * forward.
 */
function literalStretches(text: string, spans: { start: number; end: number }[]): { start: number; end: number }[] {
  const to = text.length;
  const spanEnd = new Map(spans.map((s) => [s.start, s.end]));
  const out: { start: number; end: number }[] = [];
  const brackets: number[] = [];
  // Where the last search for each character ended (`to` when there is none left), so no stretch is searched twice.
  const found = { ")": -1, ">": -1 };
  const next = (ch: ")" | ">", after: number) => {
    if (found[ch] < after) {
      let j = after;
      while (j < to && text[j] !== ch) j = spanEnd.get(j) ?? j + 1;
      found[ch] = j;
    }
    return found[ch] >= to ? -1 : found[ch];
  };
  const add = (start: number, end: number) => {
    while (out.length > 0 && out.at(-1)!.start >= start) out.pop();
    out.push({ start, end });
  };
  for (let i = 0; i < to; i++) {
    const end = spanEnd.get(i);
    if (end !== undefined) {
      i = end - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "[") brackets.push(i);
    else if (ch === "]" && brackets.length > 0) {
      const open = brackets.pop()!;
      const close = text[i + 1] === "(" ? next(")", i + 2) : -1;
      if (close === -1) continue;
      add(open > 0 && text[open - 1] === "!" ? open - 1 : open, close + 1);
      i = close;
    } else if (ch === "<" && /[A-Za-z/!?]/.test(text[i + 1] ?? "")) {
      const close = next(">", i + 1);
      if (close === -1) continue;
      add(i, close + 1);
      i = close;
    }
  }
  return out;
}

/** Parse one paragraph's or one item's text into inline nodes. */
function parseInline(text: string): Inline[] {
  // A backslash before a marker shows the marker; any other backslash is a backslash.
  const escaped = new Set<number>();
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "\\" && "*_`".includes(text[i + 1]!)) escaped.add(++i);
  }

  const head: Entry = { prev: null, next: null, piece: null, depth: 0, delim: null };
  let tail = head;
  const append = (piece: Piece | null, depth: number, delim: Entry["delim"] = null): Entry => {
    const entry: Entry = { prev: tail, next: null, piece, depth, delim };
    tail.next = entry;
    tail = entry;
    return entry;
  };
  let pending = "";
  const flushText = () => {
    if (pending !== "") append({ kind: "text", text: pending }, 0);
    pending = "";
  };

  const openers: Entry[] = [];
  const bottom = new Map<string, number>();

  /** Wrap the entries between an opener and a closer in one node, and unlink them. */
  const wrap = (opener: Entry, closer: Entry, kind: "strong" | "em", markers: string) => {
    const children: Piece[] = [];
    let depth = 0;
    for (let e = opener.next; e !== closer; e = e!.next) {
      children.push(e!.delim !== null ? { kind: "text", text: e!.delim.char.repeat(e!.delim.count) } : e!.piece!);
      depth = Math.max(depth, e!.depth);
    }
    const node: Entry = { prev: opener, next: closer, piece: null, depth: depth + 1, delim: null };
    if (node.depth > MAX_DEPTH) {
      node.piece = { kind: "plain", children: [{ kind: "text", text: markers }, ...children, { kind: "text", text: markers }] };
      node.depth = depth;
    } else node.piece = { kind, children };
    opener.next = node;
    closer.prev = node;
  };
  const unlink = (e: Entry) => {
    e.prev!.next = e.next;
    if (e.next !== null) e.next.prev = e.prev;
    if (tail === e) tail = e.prev!;
  };

  /** A run of * or _ just read: close what it can, then keep it as an opener if it can open. */
  const delimiter = (char: string, count: number, before: string | undefined, after: string | undefined) => {
    const b = kindOf(before);
    const a = kindOf(after);
    const left = a !== "space" && (a !== "punct" || b !== "other");
    const right = b !== "space" && (b !== "punct" || a !== "other");
    const canOpen = char === "*" ? left : left && (!right || b === "punct");
    const canClose = char === "*" ? right : right && (!left || a === "punct");
    flushText();
    const closer = append(null, 0, { char, count, canOpen, canClose });
    const d = closer.delim!;
    if (canClose) {
      while (d.count > 0) {
        const floor = Math.min(bottom.get(char) ?? 0, openers.length);
        let k = openers.length - 1;
        while (k >= floor && openers[k]!.delim!.char !== char) k--;
        if (k < floor) {
          bottom.set(char, openers.length);
          break;
        }
        // Runs between the two are left as text.
        openers.length = k + 1;
        const opener = openers[k]!;
        const o = opener.delim!;
        const use = o.count >= 2 && d.count >= 2 ? 2 : 1;
        o.count -= use;
        d.count -= use;
        wrap(opener, closer, use === 2 ? "strong" : "em", char.repeat(use));
        if (o.count === 0) {
          openers.pop();
          unlink(opener);
        }
        // A floor above the shrunken stack would hide openers pushed later in the places it no longer covers.
        for (const [c, f] of bottom) if (f > openers.length) bottom.set(c, openers.length);
      }
    }
    if (d.count === 0) unlink(closer);
    else if (canOpen) openers.push(closer);
  };

  // A code span inside a link is part of the link, shown as written; the stretches and the spans left never overlap.
  const allSpans = codeSpans(text, escaped);
  const literal = literalStretches(text, allSpans);
  let s = 0;
  const spans = allSpans.filter((span) => {
    while (s < literal.length && literal[s]!.end <= span.start) s++;
    return !(s < literal.length && literal[s]!.start <= span.start);
  });
  let r = 0;
  let at = 0;
  const plainUntil = (end: number) => {
    for (let i = at; i < end; ) {
      const ch = text[i]!;
      const stretch = literal[r];
      if (stretch !== undefined && stretch.start === i) {
        // A link, an image or a tag is shown as written, markers inside it included.
        pending += text.slice(i, stretch.end);
        i = stretch.end;
        r++;
      } else if (escaped.has(i + 1) && ch === "\\") {
        pending += text[i + 1];
        i += 2;
      } else if ((ch === "*" || ch === "_") && !escaped.has(i)) {
        const start = i;
        while (i < end && text[i] === ch && !escaped.has(i)) i++;
        delimiter(ch, i - start, text[start - 1], text[i]);
      } else {
        // Copy a stretch of plain text in one slice.
        const stop = Math.min(end, stretch?.start ?? end);
        let j = i + 1;
        while (j < stop && text[j] !== "*" && text[j] !== "_" && text[j] !== "\\") j++;
        pending += text.slice(i, j);
        i = j;
      }
    }
    at = end;
  };
  for (const span of spans) {
    plainUntil(span.start);
    flushText();
    let code = text.slice(span.start + span.open, span.end - span.open).replace(/\n/g, " ");
    if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
    append({ kind: "code", text: code }, 0);
    at = span.end;
  }
  plainUntil(text.length);
  flushText();

  const top: Piece[] = [];
  for (let e = head.next; e !== null; e = e.next) top.push(e.delim !== null ? { kind: "text", text: e.delim.char.repeat(e.delim.count) } : e.piece!);
  return finish(top);
}

/**
 * Turn pieces into inline nodes: groups past the depth cap are spread into their parent (with a stack, as they can
 * nest without limit), and neighbouring text is joined. Bold and italic recurse, at most MAX_DEPTH deep.
 */
function finish(pieces: Piece[]): Inline[] {
  const out: Inline[] = [];
  const stack: { list: Piece[]; at: number }[] = [{ list: pieces, at: 0 }];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.at === frame.list.length) {
      stack.pop();
      continue;
    }
    const piece = frame.list[frame.at++]!;
    if (piece.kind === "plain") stack.push({ list: piece.children, at: 0 });
    else if (piece.kind === "text") {
      if (piece.text === "") continue;
      const last = out.at(-1);
      if (last?.kind === "text") last.text += piece.text;
      else out.push({ kind: "text", text: piece.text });
    } else if (piece.kind === "code") out.push({ kind: "code", text: piece.text });
    else out.push({ kind: piece.kind, children: finish(piece.children) });
  }
  return out;
}
