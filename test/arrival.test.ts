import assert from "node:assert/strict";
import test from "node:test";
import { tabTitle } from "../web/src/app/arrival.ts";

// What the browser's tab and its history call each screen (web/src/app/arrival.ts), without a browser.

test("the tab is named for the screen, then the product", () => {
  assert.equal(tabTitle("Work"), "Work – Botbench");
  assert.equal(tabTitle("Task 12"), "Task 12 – Botbench");
});
