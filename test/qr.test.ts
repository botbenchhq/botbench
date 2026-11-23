import assert from "node:assert/strict";
import test from "node:test";
import { byteCapacity, formatBits, MAX_VERSION, qrModules, reedSolomon, versionBits } from "../web/src/app/qr.ts";
import { codeFromAddress, groupCode, signInAddress } from "../web/src/app/sign-in-code.ts";

// The QR encoder Settings → Add a device draws with, checked against the vectors the QR specification (ISO/IEC 18004)
// publishes and the worked example everyone checks against. Chrome's own QR reader decodes the drawn symbol in
// e2e/pairing.e2e.ts.

test("Reed-Solomon error correction matches the specification's example (Annex I, 01234567 at 1-M) and the HELLO WORLD example at 1-M", () => {
  // ISO/IEC 18004 Annex I: the 16 data codewords of "01234567" in numeric mode, version 1-M, and its 10 EC codewords.
  assert.deepEqual(reedSolomon([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17], 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  // "HELLO WORLD" in alphanumeric mode, version 1-M.
  assert.deepEqual(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format and version bits match the specification's tables (Annex C, level M, each mask; Annex D, versions 7 to 10)", () => {
  const formats = ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
  assert.deepEqual(formats.map((_, mask) => formatBits(mask).toString(2).padStart(15, "0")), formats);
  const versions = { 7: "000111110010010100", 8: "001000010110111100", 9: "001001101010011001", 10: "001010010011010011" };
  for (const [version, bits] of Object.entries(versions)) assert.equal(versionBits(Number(version)).toString(2).padStart(18, "0"), bits, `version ${version}`);
});

test("byte-mode capacity at level M matches the specification's table 7 for versions 1 to 10", () => {
  assert.deepEqual(Array.from({ length: MAX_VERSION }, (_, i) => byteCapacity(i + 1)), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
});

/** Read the 15 format bits back from both of their places in a symbol. */
function readFormat(m: boolean[][]): [number, number] {
  const size = m.length;
  const at = (x: number, y: number): number => (m[y]![x] ? 1 : 0);
  const near = [0, 1, 2, 3, 4, 5].map((i) => at(8, i)).concat(at(8, 7), at(8, 8), at(7, 8), ...[9, 10, 11, 12, 13, 14].map((i) => at(14 - i, 8)));
  const far = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(size - 1 - i, 8)).concat([8, 9, 10, 11, 12, 13, 14].map((i) => at(8, size - 15 + i)));
  const value = (bits: number[]): number => bits.reduce((n, bit, i) => n | (bit << i), 0);
  return [value(near), value(far)];
}

test("a symbol has the size of the smallest version that holds the text, its finder and timing patterns, the dark module, and the same format bits in both places", () => {
  for (const [text, version] of [["http://127.0.0.1:7777/#code=ABCD-EFGH", 3], ["a".repeat(14), 1], ["a".repeat(15), 2], ["a".repeat(152), 8], ["a".repeat(153), 9], ["a".repeat(213), 10]] as const) {
    const m = qrModules(text);
    assert.equal(m.length, version * 4 + 17, `${text.length} bytes fit version ${version}`);
    const size = m.length;
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
      for (let d = -3; d <= 3; d++) {
        const ring = (dx: number, dy: number): number => Math.max(Math.abs(dx), Math.abs(dy));
        assert.equal(m[cy + d]![cx - 3], true, "finder's outer ring");
        assert.equal(m[cy - 3]![cx + d], true, "finder's outer ring");
        assert.equal(m[cy + d]![cx + d], ring(d, d) !== 2, "finder's rings along the diagonal");
      }
    }
    for (let i = 8; i < size - 8; i++) assert.equal(m[6]![i], i % 2 === 0, "horizontal timing");
    for (let i = 8; i < size - 8; i++) assert.equal(m[i]![6], i % 2 === 0, "vertical timing");
    assert.equal(m[size - 8]![8], true, "the dark module");
    const [near, far] = readFormat(m);
    assert.equal(near, far);
    assert.ok(Array.from({ length: 8 }, (_, mask) => formatBits(mask)).includes(near), "the format bits are level M with one of the 8 masks");
  }
});

test("text longer than a version-10 symbol holds is refused in words", () => {
  assert.throws(() => qrModules("a".repeat(214)), /214 bytes, longer than the 213/);
});

test("the sign-in address carries the code after # in groups of four, and the sign-in screen reads it back", () => {
  assert.equal(groupCode("abcdefgh"), "ABCD-EFGH");
  assert.equal(groupCode("ABCD-EFGH"), "ABCD-EFGH");
  assert.equal(signInAddress("http://127.0.0.1:7777", "ABCDEFGH"), "http://127.0.0.1:7777/#code=ABCD-EFGH");
  assert.equal(codeFromAddress("#code=ABCD-EFGH"), "ABCD-EFGH");
  assert.equal(codeFromAddress("#code=abcdefgh"), "ABCD-EFGH");
  assert.equal(codeFromAddress("#/settings"), null);
  assert.equal(codeFromAddress("#code=<script>"), null);
});
