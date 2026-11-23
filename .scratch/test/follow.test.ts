import assert from "node:assert/strict";
import test from "node:test";
import { jumpCount } from "../web/src/components/follow.ts";

// The chat follows its newest row with the design system's useTranscript; the count on its jump button is Botbench's words.

test("the count in words, singular for one, empty for none", () => {
  assert.equal(jumpCount(0), "");
  assert.equal(jumpCount(1), "1 new step");
  assert.equal(jumpCount(12), "12 new steps");
});
