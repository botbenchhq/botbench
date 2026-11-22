import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { BANNED, bannedIn, readBanned } from "../e2e/voice.ts";
import { stepWords } from "../src/engine/roles.ts";

// The words the server sends to a screen, checked against docs/product/voice.md. The server has no catalogue of
// messages: its sentences are written where they are built, as string and template literals. So this test reads
// every literal in src/ that is a sentence and fails when one holds a word the voice bans. What is not for a screen
// is left out below, each with its reason.

const SRC = path.resolve(import.meta.dirname, "..", "src");

/** Files whose sentences are not for a screen. */
const NOT_FOR_A_SCREEN: Record<string, string> = {
  "engine/roles.ts": "prompts written for the agent, in the plan's own terms",
  "config.ts": "errors about the settings file, printed in the terminal when Smelt starts, which must name the file's own keys",
  "store/schema.ts": "SQL and errors raised inside the database",
  "store/db.ts": "errors about the data directory, printed in the terminal when Smelt starts",
};
/** Calls whose arguments go to Smelt's own log on stdout, for whoever runs the process. */
const LOG_CALLS = /^(console\.(log|error|warn)|report|log)$/;
/** A literal on a line that carries this marker, or on the line after it, is not for a screen; the marker says why. */
const MARKER = /voice: not on screen/;

/** A literal that reads as a sentence or a phrase: at least two words, the first of them a word. */
function prose(literal: string): boolean {
  // A template that starts with a value starts, as a sentence, at its first words.
  const text = literal.replace(/^(\s*…\s*)+/, "").trim();
  return /^[A-Za-z"'(][A-Za-z'’]*[ ,.:]/.test(text) && /\s[a-z]/.test(text) && !/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|WITH)\b/.test(text);
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));
}

/** Every sentence literal of a source file that is for a screen, with its line. */
function sentences(file: string): { line: number; text: string }[] {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split("\n");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node, logged: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    const inLog = logged || (ts.isCallExpression(node) && LOG_CALLS.test(node.expression.getText(tree)));
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" … ") : null;
    // A role's name in code (planner, implementer) is not a word for a screen: a sentence says the step, through stepWords().
    if (ts.isTemplateExpression(node) && !inLog && prose(text ?? "") && node.templateSpans.some((span) => /(^|\.)role$/.test(span.expression.getText(tree)))) {
      found.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text: `attempt: a role's name is put into this sentence as it is in code: ${text}` });
    }
    if (text !== null && !inLog && prose(text)) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
      if (!MARKER.test(lines[line] ?? "") && !MARKER.test(lines[line - 1] ?? "")) found.push({ line: line + 1, text });
    }
    ts.forEachChild(node, (child) => visit(child, inLog));
  };
  visit(tree, false);
  return found;
}

test("the banned words are read from the glossary of docs/product/voice.md", () => {
  assert.deepEqual(readBanned("| On screen | Means | Never shown |\n|---|---|---|\n| Chat | a turn | `turn`, `Attempt` |\n| Task | the same | |\nA `stray` word outside the table."), ["turn", "attempt"]);
  for (const term of ["turn", "attempt", "worktree", "driver", "cli", "broker", "gate", "floor", "hook", "station", "parked", "superseded", "resume cursor", "pgid", "admission", "schema", "migration", "stream", "sse", "standing permission", "pre-approved", "implementer", "blocked", "interrupted", "decline"]) {
    assert.ok(BANNED.includes(term), `${term} is on the list`);
  }
});

test("a banned word is found as a whole word, in any case, singular or plural, and only the git term may hold one", () => {
  assert.deepEqual(bannedIn("The Turn was stopped."), ["turn"]);
  assert.deepEqual(bannedIn("Two attempts were made."), ["attempt"]);
  assert.deepEqual(bannedIn("It returned, and the upstream branch is a gateway."), []);
  assert.deepEqual(bannedIn("You gave it standing\npermission."), ["standing permission"]);
  assert.deepEqual(bannedIn("It works in a separate copy of the project (a git worktree)."), []);
  assert.deepEqual(bannedIn("The task's worktree is gone."), ["worktree"]);
  assert.deepEqual(bannedIn("Claude Code's default"), []);
  // What a sentence quotes is somebody else's text: a command the owner typed, a name a program gave.
  assert.deepEqual(bannedIn('"npm run gate && git stream" cannot be allowed in advance.'), []);
  assert.deepEqual(bannedIn("Claude Code is signed out. Run `claude hook` in a terminal."), []);
  assert.deepEqual(bannedIn('The gate refused "npm test".'), ["gate"]);
  // A path inside a sentence is a fact about the machine, not Smelt's wording.
  assert.deepEqual(bannedIn("The folder /Users/me/.smelt/worktrees/run-1/task-1 already exists."), []);
  assert.deepEqual(bannedIn("The worktree at /Users/me/.smelt/worktrees/run-1 is gone."), ["worktree"]);
  assert.deepEqual(bannedIn("the CLI default"), ["cli"]);
});

test("no sentence the server builds for a screen holds an internal word", () => {
  const findings: string[] = [];
  for (const file of files(SRC)) {
    const name = path.relative(SRC, file);
    if (name in NOT_FOR_A_SCREEN) continue;
    for (const { line, text } of sentences(file)) for (const term of bannedIn(text)) findings.push(`src/${name}:${line} "${term}" in: ${text.slice(0, 140)}`);
  }
  assert.deepEqual(findings, []);
});

test("a role is said as its step of the work, never by its name in code", () => {
  assert.equal(stepWords("planner"), "Plan step");
  assert.equal(stepWords("implementer"), "Build step");
  assert.equal(stepWords("reviewer"), "Review step");
  // A role Smelt has no step for is not given one.
  assert.equal(stepWords("auditor"), "auditor");
  for (const role of ["planner", "implementer", "reviewer"]) assert.deepEqual(bannedIn(`For the ${stepWords(role)} in /tmp/repo.`), []);
});

test("every file left out of the check exists", () => {
  for (const name of Object.keys(NOT_FOR_A_SCREEN)) assert.ok(fs.existsSync(path.join(SRC, name)), name);
});
