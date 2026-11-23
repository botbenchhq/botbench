import assert from "node:assert/strict";
import { MAX_WAITING_SIGN_INS } from "../../src/api/auth.ts";

// The bounded line of sign-ins (src/api/auth.ts), filled for the tests that show what a full one does.

/**
 * Send `guess` until one is answered 429: the line of sign-ins is full. A guess not answered within a second has joined
 * the line (it waits there behind the others) and the next is sent; at most one line's worth can join.
 */
export async function fillLine(guess: () => Promise<number>): Promise<void> {
  for (let i = 0; i <= MAX_WAITING_SIGN_INS; i++) {
    const status = await Promise.race([guess().catch(() => 0), new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1000))]);
    if (status === 429) return;
  }
  assert.fail("the line of sign-ins never filled up");
}
