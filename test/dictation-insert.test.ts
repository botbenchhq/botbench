import assert from "node:assert/strict";
import test from "node:test";
import { insertAt } from "../web/src/app/dictation.ts";

// Dictated text goes in at the cursor of the message box and stays editable; it never replaces what was typed.

test("dictated text is put in at the cursor, spaced from the words around it, and the cursor ends after it", () => {
  assert.deepEqual(insertAt("", 0, 0, "Open a pull request."), { value: "Open a pull request.", cursor: 20 });
  assert.deepEqual(insertAt("Please", 6, 6, "review it."), { value: "Please review it.", cursor: 17 });
  assert.deepEqual(insertAt("Fix it. Thanks", 7, 7, "Then test it."), { value: "Fix it. Then test it. Thanks", cursor: 21 });
  assert.deepEqual(insertAt("Fixnow", 3, 3, "it"), { value: "Fix it now", cursor: 6 });
  assert.deepEqual(insertAt("Fix it now", 4, 6, "this"), { value: "Fix this now", cursor: 8 }, "a selection is replaced");
});
