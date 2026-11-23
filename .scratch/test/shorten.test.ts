import assert from "node:assert/strict";
import test from "node:test";
import { firstLine } from "../src/shorten.ts";

// The task card's title and the commit subject both come from the first line of the prompt.

test("a short first line is kept whole, and only the first line is used", () => {
  assert.equal(firstLine("  Add a README\nthen more  "), "Add a README");
  assert.equal(firstLine("x".repeat(60)), "x".repeat(60));
});

test("a long first line is cut at a word boundary and ends with an ellipsis, never mid-word", () => {
  const prompt = "Create a file named hello.txt containing hi, then run ls to show the files";
  const cut = firstLine(prompt);
  assert.equal(cut, "Create a file named hello.txt containing hi, then run ls to…");
  assert.ok(cut.length <= 61);
  // A word that ends exactly at the limit is kept.
  assert.equal(firstLine("aaaa bbbb cccc", 9), "aaaa bbbb…");
  // Punctuation left at the cut is dropped.
  assert.equal(firstLine("one, two, three, four", 10), "one, two…");
});

test("one word longer than the limit is cut where it is", () => {
  assert.equal(firstLine("a".repeat(70)), `${"a".repeat(60)}…`);
});
