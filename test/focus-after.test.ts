import assert from "node:assert/strict";
import test from "node:test";
import { takesItsPlace } from "../web/src/app/focus-after.ts";

// Where the focus goes once a list's row is removed (Settings → Memory's Forget, Permissions' Take back).

test("the row that took the removed one's place gets the focus; the one before it when the last row went", () => {
  assert.equal(takesItsPlace(["a", "c"], 1), "c");
  assert.equal(takesItsPlace(["b", "c"], 0), "b");
  assert.equal(takesItsPlace(["a", "b"], 2), "b");
});

test("a list that shrank by more than the one row gives its last row, and an empty list gives none", () => {
  assert.equal(takesItsPlace(["a"], 5), "a");
  assert.equal(takesItsPlace([], 0), undefined);
});
