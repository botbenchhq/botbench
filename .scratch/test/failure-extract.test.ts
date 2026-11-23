import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { failureExtract } from "../web/src/components/failure-extract.ts";

// A failed check's output opens at its tail, and the cause can be hundreds of lines up. The extract shown above it is
// the first lines that look like the failure, with their line numbers. Fixtures are real captured outputs: this
// repository's own `npm test` run under the profile from before local ports were allowed (paths shortened), a
// TypeScript error, and node's test runner in TAP form.

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "check-output", name), "utf8");

test("the real npm test failure: the cause, hundreds of lines up, is in the extract once, with its line number, beside the first failed tests", () => {
  const output = fixture("npm-test-listen-eperm.txt");
  const extract = failureExtract(output);
  assert.ok(extract.length <= 5);
  const causes = extract.filter((l) => /Error/.test(l.text));
  assert.equal(causes[0]!.line, 400, JSON.stringify(extract));
  assert.match(causes[0]!.text, /listen EPERM: operation not permitted/);
  assert.equal(output.split("\n")[causes[0]!.line - 1]!.startsWith(causes[0]!.text.replace(/…$/, "")), true, "the line number is the line's own");
  assert.equal(extract.filter((l) => /permission socket could not be opened/.test(l.text)).length, 1, "one cause repeated with other temporary paths is shown once");
  assert.ok(extract.some((l) => l.line === 436 && /SyntaxError/.test(l.text)), JSON.stringify(extract));
  assert.ok(extract.some((l) => /^✖ every approval route refuses/.test(l.text)), "a failed test's name is there too");
  assert.deepEqual(extract.map((l) => l.line), [...extract.map((l) => l.line)].sort((a, b) => a - b), "in the order they appear");
  assert.ok(extract.every((l) => l.text.length <= 301), "long lines are cut");
});

test("a TypeScript error and a TAP failure are found by their own markers", () => {
  assert.deepEqual(
    failureExtract(fixture("tsc.txt")).map((l) => l.line),
    [1, 2],
  );
  assert.match(failureExtract(fixture("tsc.txt"))[0]!.text, /error TS2322/);
  const tap = failureExtract(fixture("node-test-tap.txt"));
  assert.ok(tap.some((l) => l.text === "not ok 2 - subtracts"), JSON.stringify(tap));
  assert.ok(tap.some((l) => /AssertionError/.test(l.text)), JSON.stringify(tap));
  assert.equal(tap.some((l) => /^ok 1/.test(l.text)), false);
});

test("output with no marker gives no extract, and stack lines that only mention an error function are not causes", () => {
  assert.deepEqual(failureExtract("building\nall good\nexit 1\n"), []);
  assert.deepEqual(failureExtract("    at emitErrorNT (node:net:2478:8)\n"), []);
});
