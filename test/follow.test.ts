import assert from "node:assert/strict";
import test from "node:test";
import { FOLLOW_WITHIN_PX, follow, jumpCount, nearBottom, type Follow } from "../web/src/components/follow.ts";

// The chat follows its newest row only while the reader is at the bottom (the design system's jump-to-latest rule).

const at = (fromBottom: number) => ({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - fromBottom });
const start: Follow = { following: true, unseen: 0 };

test("the reader is at the bottom within about 60px of it, and not further up", () => {
  assert.equal(FOLLOW_WITHIN_PX, 60);
  assert.equal(nearBottom(at(0)), true);
  assert.equal(nearBottom(at(60)), true);
  assert.equal(nearBottom(at(61)), false);
  assert.equal(nearBottom(at(500)), false);
  // A transcript shorter than its box is at the bottom.
  assert.equal(nearBottom({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 }), true);
});

test("while following, new rows are followed and nothing is counted", () => {
  assert.deepEqual(follow(start, { kind: "rows", added: 3 }), { following: true, unseen: 0 });
});

test("scrolled up, new rows are counted and not followed; rows that fold into fewer are never a negative count", () => {
  const up = follow(start, { kind: "scrolled", nearBottom: false });
  assert.deepEqual(up, { following: false, unseen: 0 });
  const two = follow(follow(up, { kind: "rows", added: 1 }), { kind: "rows", added: 1 });
  assert.deepEqual(two, { following: false, unseen: 2 });
  assert.deepEqual(follow(two, { kind: "rows", added: -4 }), { following: false, unseen: 2 });
});

test("jumping, or scrolling back to the bottom, follows again and clears the count", () => {
  const away: Follow = { following: false, unseen: 5 };
  assert.deepEqual(follow(away, { kind: "jumped" }), { following: true, unseen: 0 });
  assert.deepEqual(follow(away, { kind: "scrolled", nearBottom: true }), { following: true, unseen: 0 });
  // Scrolling while still away keeps the count.
  assert.deepEqual(follow(away, { kind: "scrolled", nearBottom: false }), away);
});

test("the count in words, singular for one, empty for none", () => {
  assert.equal(jumpCount(0), "");
  assert.equal(jumpCount(1), "1 new step");
  assert.equal(jumpCount(12), "12 new steps");
});

