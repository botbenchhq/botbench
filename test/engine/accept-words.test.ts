import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedWords } from "../../src/engine/decision.ts";

// What an accept does with the branch, in the one sentence every record of an accept uses, true for both choices of
// what happens to an accepted task ("Nothing is merged or pushed" was said of runs that open a pull request too).

test("an accept never merges; it pushes only for a run that opens a pull request, and says which", () => {
  assert.equal(acceptedWords("branch"), "Nothing was merged or pushed.");
  assert.equal(acceptedWords("pull_request"), "Nothing was merged; the run then pushes the branch and opens a pull request.");
});
