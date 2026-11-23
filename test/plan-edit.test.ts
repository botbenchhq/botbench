import assert from "node:assert/strict";
import test from "node:test";
import { editChanged, editStands, fromLines, NEW_EDIT, openEdit, toLines } from "../web/src/app/plan-edit.ts";

// Whether a plan task being edited holds anything that leaving would lose (web/src/app/plan-edit.ts), without a browser.

const task = { title: "Write the exporter", criteria: ["It writes a CSV file", "It has a test"] };

test("an edit that was opened and left as it was has nothing to lose, and neither has an empty new task", () => {
  assert.equal(editChanged(openEdit(0, task)), false);
  assert.equal(editChanged(NEW_EDIT), false);
  // Space around the words and blank lines are not kept when a task is saved, so they are not a change.
  assert.equal(editChanged({ ...openEdit(0, task), title: " Write the exporter ", criteria: "It writes a CSV file\n\n  It has a test\n" }), false);
  assert.equal(editChanged({ ...NEW_EDIT, title: "  ", criteria: "\n" }), false);
});

test("typed words that leaving would lose are a change: a title, a criterion, a new task with anything in it", () => {
  assert.equal(editChanged({ ...openEdit(0, task), title: "Write the importer" }), true);
  assert.equal(editChanged({ ...openEdit(0, task), criteria: "It writes a CSV file" }), true);
  assert.equal(editChanged({ ...NEW_EDIT, title: "Document it" }), true);
  assert.equal(editChanged({ ...NEW_EDIT, criteria: "The README says how" }), true);
});

test("the editor is compared with the task as it was opened, so a plan changed in another window does not make an untouched editor a changed one", () => {
  const opened = openEdit(0, task);
  task.criteria.push("Added elsewhere");
  assert.equal(editChanged(opened), false);
  task.criteria.pop();
});

test("an editor stands while the run waits for its plan and its task is still in it", () => {
  assert.equal(editStands(openEdit(0, task), [task], true), true);
  assert.equal(editStands(NEW_EDIT, [task], true), true);
  // The plan was approved or the run cancelled elsewhere; or the task was taken out of the plan.
  assert.equal(editStands(openEdit(0, task), [task], false), false);
  assert.equal(editStands(openEdit(1, task), [task], true), false);
});

test("criteria are one on each line, without blank lines or space around them", () => {
  assert.deepEqual(fromLines(" a \n\n b\n"), ["a", "b"]);
  assert.equal(toLines(["a", "b"]), "a\nb");
});
