import assert from "node:assert/strict";
import test from "node:test";
import { editChanged, fromLines, toLines } from "../web/src/app/plan-edit.ts";

// Whether a plan task being edited holds anything that Cancel would lose (web/src/app/plan-edit.ts), without a browser.

const plan = [{ title: "Write the exporter", criteria: ["It writes a CSV file", "It has a test"] }];

test("an edit that was opened and left as it was has nothing to lose, and neither has an empty new task", () => {
  assert.equal(editChanged({ at: 0, title: "Write the exporter", criteria: toLines(plan[0]!.criteria) }, plan), false);
  assert.equal(editChanged({ at: "new", title: "", criteria: "" }, plan), false);
  // Space around the words and blank lines are not kept when a task is saved, so they are not a change.
  assert.equal(editChanged({ at: 0, title: " Write the exporter ", criteria: "It writes a CSV file\n\n  It has a test\n" }, plan), false);
  assert.equal(editChanged({ at: "new", title: "  ", criteria: "\n" }, plan), false);
});

test("typed words that Cancel would lose are a change: a title, a criterion, a new task with anything in it", () => {
  assert.equal(editChanged({ at: 0, title: "Write the importer", criteria: toLines(plan[0]!.criteria) }, plan), true);
  assert.equal(editChanged({ at: 0, title: "Write the exporter", criteria: "It writes a CSV file" }, plan), true);
  assert.equal(editChanged({ at: "new", title: "Document it", criteria: "" }, plan), true);
  assert.equal(editChanged({ at: "new", title: "", criteria: "The README says how" }, plan), true);
  // The task was taken out of the plan in another window: what was typed is all there is of it.
  assert.equal(editChanged({ at: 3, title: "Write the exporter", criteria: "" }, plan), true);
});

test("criteria are one on each line, without blank lines or space around them", () => {
  assert.deepEqual(fromLines(" a \n\n b\n"), ["a", "b"]);
  assert.equal(toLines(["a", "b"]), "a\nb");
});
