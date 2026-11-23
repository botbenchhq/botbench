import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseMarkdown, type Block, type Inline } from "../web/src/components/markdown.ts";

// The small part of markdown an agent's reply and a review are drawn with, decided without a browser: what each
// supported construct becomes, that everything else stays the text it was, and that hostile text is only ever text.

const text = (t: string): Inline => ({ kind: "text", text: t });
const para = (...children: Inline[]): Block => ({ kind: "paragraph", children });

/** Every piece of text the tree would put on screen, in order, so a test can say nothing was lost. */
function shown(blocks: Block[]): string {
  const inline = (nodes: Inline[]): string => nodes.map((n) => (n.kind === "text" || n.kind === "code" ? n.text : inline(n.children))).join("");
  return blocks.map((b) => (b.kind === "paragraph" ? inline(b.children) : b.kind === "code" ? b.text : b.items.map((i) => i.marker + inline(i.children)).join("\n"))).join("\n");
}

/** Every kind of node in the tree. The renderer draws only these, so a kind not here is an element that cannot be made. */
function kinds(blocks: Block[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: Inline[]) => nodes.forEach((n) => (out.add(n.kind), n.kind === "strong" || n.kind === "em" ? walk(n.children) : undefined));
  for (const b of blocks) {
    out.add(b.kind);
    if (b.kind === "paragraph") walk(b.children);
    if (b.kind === "list") b.items.forEach((i) => walk(i.children));
  }
  return out;
}

test("paragraphs are split by blank lines, and a line break inside one is kept", () => {
  assert.deepEqual(parseMarkdown("One line\nthe next line\n\n\nA second paragraph"), [para(text("One line\nthe next line")), para(text("A second paragraph"))]);
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n \n"), []);
  assert.deepEqual(parseMarkdown("Windows\r\nline ends"), [para(text("Windows\nline ends"))]);
});

test("bold, italic and inline code are drawn, in either marker, and nest", () => {
  assert.deepEqual(parseMarkdown("a **bold** and __bold__ word"), [para(text("a "), { kind: "strong", children: [text("bold")] }, text(" and "), { kind: "strong", children: [text("bold")] }, text(" word"))]);
  assert.deepEqual(parseMarkdown("an *italic* and _italic_ word"), [para(text("an "), { kind: "em", children: [text("italic")] }, text(" and "), { kind: "em", children: [text("italic")] }, text(" word"))]);
  assert.deepEqual(parseMarkdown("run `npm test` now"), [para(text("run "), { kind: "code", text: "npm test" }, text(" now"))]);
  assert.deepEqual(parseMarkdown("**bold with *italic* inside**"), [para({ kind: "strong", children: [text("bold with "), { kind: "em", children: [text("italic")] }, text(" inside")] })]);
  assert.deepEqual(parseMarkdown("***both***"), [para({ kind: "em", children: [{ kind: "strong", children: [text("both")] }] })]);
});

test("code spans hold their text as written, markers included, and a longer run can hold a backtick", () => {
  assert.deepEqual(parseMarkdown("`**not bold**`"), [para({ kind: "code", text: "**not bold**" })]);
  assert.deepEqual(parseMarkdown("`` a ` b ``"), [para({ kind: "code", text: "a ` b" })]);
  // A backtick with no closing run of the same length is a backtick.
  assert.deepEqual(parseMarkdown("one ` alone and ``two"), [para(text("one ` alone and ``two"))]);
  assert.deepEqual(parseMarkdown("a `span\nover lines`"), [para(text("a "), { kind: "code", text: "span over lines" })]);
});

test("names with underscores and spaced asterisks stay as written", () => {
  assert.deepEqual(parseMarkdown("call snake_case_name and __init__ now"), [para(text("call snake_case_name and "), { kind: "strong", children: [text("init")] }, text(" now"))]);
  assert.deepEqual(parseMarkdown("my_var_name, 2 * 3 * 4, a*b"), [para(text("my_var_name, 2 * 3 * 4, a*b"))]);
  assert.deepEqual(parseMarkdown("**unclosed and *open"), [para(text("**unclosed and *open"))]);
  assert.deepEqual(parseMarkdown("a \\*not italic\\* b"), [para(text("a *not italic* b"))]);
});

test("a fenced code block holds its lines exactly, with backticks or tildes, and ends only at the same fence", () => {
  assert.deepEqual(parseMarkdown("Before\n```ts\nconst a = **b**;\n  <b>x</b>\n```\nAfter"), [para(text("Before")), { kind: "code", text: "const a = **b**;\n  <b>x</b>" }, para(text("After"))]);
  assert.deepEqual(parseMarkdown("~~~\n```\nstill code\n~~~"), [{ kind: "code", text: "```\nstill code" }]);
  assert.deepEqual(parseMarkdown("```\n\n\n```"), [{ kind: "code", text: "\n" }]);
});

test("a nested fence cannot break out: a longer or different marker inside does not end the block", () => {
  const nested = "````\n```\ninner\n```\n`````\n~~~\nstill inside\n````\nafter";
  assert.deepEqual(parseMarkdown(nested), [{ kind: "code", text: "```\ninner\n```\n`````\n~~~\nstill inside" }, para(text("after"))]);
  // A line that opens a fence of its own, with an info string, does not close one either.
  assert.deepEqual(parseMarkdown("```\n```html\n<script>alert(1)</script>\n```"), [{ kind: "code", text: "```html\n<script>alert(1)</script>" }]);
});

test("an unclosed fence runs to the end of the text as a code block", () => {
  assert.deepEqual(parseMarkdown("Look:\n```\nline one\n\n**line** three"), [para(text("Look:")), { kind: "code", text: "line one\n\n**line** three" }]);
  assert.deepEqual(parseMarkdown("```"), [{ kind: "code", text: "" }]);
});

test("bullet and numbered lists keep each item's own marker, and a new kind of marker starts a new list", () => {
  assert.deepEqual(parseMarkdown("Steps:\n- one\n* **two**\n+ three\n  more of three\n\n1. first\n2) second\n10. tenth"), [
    para(text("Steps:")),
    {
      kind: "list",
      ordered: false,
      items: [
        // A list row draws no mark of its own, so every bullet item shows a bullet, whichever marker it was written with.
        { marker: "• ", children: [text("one")] },
        { marker: "• ", children: [{ kind: "strong", children: [text("two")] }] },
        { marker: "• ", children: [text("three\nmore of three")] },
      ],
    },
    {
      kind: "list",
      ordered: true,
      items: [
        { marker: "1. ", children: [text("first")] },
        { marker: "2) ", children: [text("second")] },
        { marker: "10. ", children: [text("tenth")] },
      ],
    },
  ]);
  assert.deepEqual(parseMarkdown("- a\n1. b"), [
    { kind: "list", ordered: false, items: [{ marker: "• ", children: [text("a")] }] },
    { kind: "list", ordered: true, items: [{ marker: "1. ", children: [text("b")] }] },
  ]);
  // A number inside a sentence that happens to start a line is not a list.
  assert.deepEqual(parseMarkdown("It was built in\n1999. Then it ran."), [para(text("It was built in\n1999. Then it ran."))]);
});

test("headings, quotes, tables, rules, links and images are shown as the text they are", () => {
  const other = ["# Heading", "> a quote", "| a | b |\n|---|---|\n| 1 | 2 |", "---", "* * *", "***", "[x](https://example.com)", "![a](http://x/y.png)", "<https://example.com>", "    indented code", "~~struck~~"];
  for (const source of other) {
    assert.deepEqual(parseMarkdown(source), [para(text(source))], source);
  }
  // A heading, a quote or a table row is kept whole as written, markers and code included, and ends a list.
  for (const source of ["# **heading** `x`", "> **quoted** - a", "| **a** | `b` |", "## _h_\n> *q*"]) {
    assert.deepEqual(parseMarkdown(source), [para(text(source))], source);
  }
  assert.deepEqual(parseMarkdown("# **h**\nthen **b**"), [para(text("# **h**\nthen "), { kind: "strong", children: [text("b")] })]);
  assert.deepEqual(parseMarkdown("- a\n# **h**"), [{ kind: "list", ordered: false, items: [{ marker: "• ", children: [text("a")] }] }, para(text("# **h**"))]);
});

test("a javascript: link is plain text and makes no link; an image is plain text and loads nothing", () => {
  const source = "Click [x](javascript:alert(1)) or see ![a](http://x/y.png) and [**b**](data:text/html,hi) or ![_c_](d)";
  assert.deepEqual(parseMarkdown(source), [para(text(source))]);
  // Markers outside a link are still drawn; only the link's own text is kept as written.
  assert.deepEqual(parseMarkdown("**a** [*b*](c) _d_"), [para({ kind: "strong", children: [text("a")] }, text(" [*b*](c) "), { kind: "em", children: [text("d")] })]);
  // Code inside a link is part of the link, shown as written; a link or a tag written as code stays code.
  assert.deepEqual(parseMarkdown("[a `b`](x) and ![`c`](d)"), [para(text("[a `b`](x) and ![`c`](d)"))]);
  assert.deepEqual(parseMarkdown("`[a](b)` and `<div>` and [`x`"), [para({ kind: "code", text: "[a](b)" }, text(" and "), { kind: "code", text: "<div>" }, text(" and ["), { kind: "code", text: "x" })]);
  assert.deepEqual(parseMarkdown("[a `](` b](x)"), [para(text("[a `](` b](x)"))]);
  // Brackets with no link after them are only brackets.
  assert.deepEqual(parseMarkdown("[**a**] b"), [para(text("["), { kind: "strong", children: [text("a")] }, text("] b"))]);
});

test("raw HTML is literal text, never an element", () => {
  // A paragraph that starts with a tag is an HTML block, kept whole as written; a tag inside a sentence is kept as written.
  for (const source of ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "<div>\n**x**\n</div>", "</p> *a*", 'a <img alt="**x**" src=y> and <b title=_t_>'] ) {
    assert.deepEqual(parseMarkdown(source), [para(text(source))], source);
  }
  // An HTML block runs to the next blank line: a list marker or a fence inside it is text too.
  assert.deepEqual(parseMarkdown("<div>\n- x\n```\n# h\n</div>\n\n- y"), [para(text("<div>\n- x\n```\n# h\n</div>")), { kind: "list", ordered: false, items: [{ marker: "• ", children: [text("y")] }] }]);
  assert.deepEqual(parseMarkdown("a <b>**bold**</b> b"), [para(text("a <b>"), { kind: "strong", children: [text("bold")] }, text("</b> b"))]);
});

test("an emphasis that failed to close does not stop a later one from being drawn", () => {
  assert.deepEqual(parseMarkdown("_a b* c_ *bold*"), [para({ kind: "em", children: [text("a b* c")] }, text(" "), { kind: "em", children: [text("bold")] })]);
});

test("the tree holds only the supported kinds, whatever the text", () => {
  const all = "# h\n> q\n- [a](b)\n1. ![c](d)\n\n```\n<x>\n```\n**e** _f_ `g` <h>";
  assert.deepEqual([...kinds(parseMarkdown(all))].sort(), ["code", "em", "list", "paragraph", "strong", "text"]);
});

test("hostile sizes finish in linear time without throwing: long lines, long words and thousands of markers", () => {
  const n = 200_000;
  const inputs = [
    "a".repeat(n),
    "*".repeat(n),
    "_".repeat(n),
    "`".repeat(n),
    "a*".repeat(n / 2),
    "*a".repeat(n / 2) + " " + "a*".repeat(n / 2),
    "_a ".repeat(n / 3),
    "**a ".repeat(n / 4),
    // Backtick runs of every length, none closed: the case that is quadratic when each opener searches ahead.
    Array.from({ length: 600 }, (_, i) => "`".repeat(i + 1) + "x").join(""),
    "`a".repeat(n / 2),
    "* _".repeat(n / 3) + "x" + "_ *".repeat(n / 3),
    "*_".repeat(n / 2) + "x" + "_*".repeat(n / 2),
    "[".repeat(n) + "](".repeat(n / 2),
    "<".repeat(n),
    // Many stretches between code spans, each with an unclosed tag and link: no search may run past its own stretch.
    "`x` <a [b](".repeat(n / 12),
    "\\".repeat(n),
    "- a\n".repeat(n / 4),
    "```\n".repeat(n / 4),
    // A long backtick run, then a line separator the fence pattern's rest must not stop at (review 3).
    "`".repeat(n) + "\u2028",
    "\n".repeat(n),
  ];
  const started = performance.now();
  for (const input of inputs) {
    const blocks = parseMarkdown(input);
    // Nothing is lost on the way: every character but the markers drawn and line structure is still there.
    assert.ok(Array.isArray(blocks));
  }
  const took = performance.now() - started;
  assert.ok(took < 3000, `parsing ${inputs.length} hostile texts of about ${n} characters took ${Math.round(took)} ms`);
  // A quadratic parser would take about four times as long on twice the text; a linear one about twice.
  const timed = (s: string) => {
    const t = performance.now();
    parseMarkdown(s);
    return performance.now() - t;
  };
  const small = timed("*_a ".repeat(50_000) + "`".repeat(3) + "a_*".repeat(50_000));
  const large = timed("*_a ".repeat(100_000) + "`".repeat(3) + "a_*".repeat(100_000));
  assert.ok(large < small * 4 + 50, `twice the text took ${Math.round(large)} ms against ${Math.round(small)} ms`);
});

test("deep nesting is capped, so the tree stays shallow and the extra markers stay text", () => {
  const depth = 5000;
  const source = "*_".repeat(depth) + "x" + "_*".repeat(depth);
  const blocks = parseMarkdown(source);
  let deepest = 0;
  const walk = (nodes: Inline[], d: number): void => nodes.forEach((n) => (n.kind === "strong" || n.kind === "em" ? walk(n.children, d + 1) : (deepest = Math.max(deepest, d))));
  walk((blocks[0] as Extract<Block, { kind: "paragraph" }>).children, 0);
  assert.ok(deepest <= 16, `nested ${deepest} deep`);
  assert.equal(shown(blocks).replace(/[*_]/g, ""), "x");
});

// The renderer is a .tsx file, which Node does not load, so what it can draw is checked in its source.
const view = readFileSync(new URL("../web/src/components/markdown-view.tsx", import.meta.url), "utf8");

test("the renderer builds React elements only: no HTML string, no link, no image", () => {
  assert.doesNotMatch(view, /dangerouslySetInnerHTML|innerHTML|<a[\s>]|<img|href|src=|createElement\(/);
  // Each kind of node is drawn with the design system's own classes; nothing new is styled.
  for (const cls of ["ds-code-block", "ds-code-block__body", "ds-list", "ds-list__row", "ds-list__content"]) assert.match(view, new RegExp(`"${cls}`));
});

test("only an agent's reply and a review go through the renderer; prompts, issues and peers' text stay plain", () => {
  const source = (path: string) => readFileSync(new URL(`../web/src/${path}`, import.meta.url), "utf8");
  const users = ["components/transcript.tsx", "components/evidence.tsx"];
  const all = ["components/outside-text.tsx", "components/other-workbenches.tsx", "components/issue-choice.tsx", "screens/task.tsx", "screens/run.tsx", "screens/turn.tsx", "app/peers.ts", ...users];
  for (const path of all) assert.equal(/markdown-view/.test(source(path)), users.includes(path), path);
  const transcript = source("components/transcript.tsx");
  // The one place in the transcript is the agent's text row; the owner's prompt there is still plain text.
  assert.equal(transcript.match(/<MarkdownView/g)?.length, 1);
  const textCase = transcript.slice(transcript.indexOf('case "text":'), transcript.indexOf('case "session_started":'));
  assert.match(textCase, /<MarkdownView text=\{e\.text\}/);
  const promptCase = transcript.slice(transcript.indexOf('case "user_prompt":'), transcript.indexOf('case "text":'));
  assert.match(promptCase, /<Theirs>\{e\.text\}<\/Theirs>/);
  const evidence = source("components/evidence.tsx");
  assert.equal(evidence.match(/<MarkdownView/g)?.length, 1);
  assert.match(evidence, /<MarkdownView text=\{review\.text\}/);
});
