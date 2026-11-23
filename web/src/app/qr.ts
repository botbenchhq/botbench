/**
 * A QR code encoder, small enough to keep in the repository: byte mode only, error correction level M only (15% of the
 * symbol can be lost), versions 1 to 10 (up to 213 bytes), and the mask with the lowest penalty. Enough for the sign-in
 * address with a one-time code in it, with no dependency.
 *
 * After Project Nayuki's QR Code generator library (https://www.nayuki.io/page/qr-code-generator-library, MIT License,
 * Copyright (c) Project Nayuki; see NOTICE), cut down to the one mode and the one level. The tables and the layout are
 * those of ISO/IEC 18004:2015.
 */

export const MAX_VERSION = 10;
/** Error correction codewords in each block, and the number of blocks, at level M for versions 1 to 10 (ISO/IEC 18004 table 9). */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;
/** The mask patterns, by number, for the module in column x and row y. */
const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const at = <T>(list: readonly T[], i: number): T => list[i] as T;

/** Modules that carry data or error correction: everything but the function patterns, format and version. */
function rawModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

export const dataCodewords = (version: number): number => Math.floor(rawModules(version) / 8) - at(ECC_PER_BLOCK, version - 1) * at(BLOCKS, version - 1);
/** How many bytes a symbol of this version holds in byte mode at level M. */
export const byteCapacity = (version: number): number => Math.floor((dataCodewords(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The `degree` Reed-Solomon error correction codewords of `data`. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) divisor[j] = multiply(at(divisor, j), root) ^ (j + 1 < degree ? at(divisor, j + 1) : 0);
    root = multiply(root, 2);
  }
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number);
    remainder.push(0);
    divisor.forEach((coefficient, i) => (remainder[i] = at(remainder, i) ^ multiply(coefficient, factor)));
  }
  return remainder;
}

/** The 15 format bits for level M and this mask: 5 data bits, 10 BCH bits, masked with 101010000010010. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** The 18 version bits of a version from 7 on: 6 data bits, 12 BCH bits. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

/** The centres of the alignment patterns along each axis. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

/** The bytes as data codewords with padding, split into blocks, each with its error correction, then interleaved. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version);
  put(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = at(BLOCKS, version - 1);
  const ecc = at(ECC_PER_BLOCK, version - 1);
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const split: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const part = data.slice(k, k + shortLength - ecc + (i < short ? 0 : 1));
    k += part.length;
    // A short block gets a placeholder where a long block has its last data codeword; it is skipped when interleaving.
    split.push([...part, ...(i < short ? [0] : []), ...reedSolomon(part, ecc)]);
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    split.forEach((block, j) => {
      if (i !== shortLength - ecc || j >= short) out.push(at(block, i));
    });
  }
  return out;
}

/** The penalty of a finished symbol (ISO/IEC 18004 7.8.3): runs, 2×2 blocks, finder-like patterns, dark balance. */
function penalty(dark: readonly boolean[][]): number {
  const size = dark.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) lines.push(at(dark, i), dark.map((row) => at(row, i)));
  const light = new Array<boolean>(4).fill(false);
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // Outside the symbol counts as light.
    const padded = [...light, ...line, ...light].map((on) => (on ? "1" : "0")).join("");
    for (let i = 0; i + 11 <= padded.length; i++) {
      const window = padded.slice(i, i + 11);
      if (window === "10111010000" || window === "00001011101") score += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = at(at(dark, y), x);
      if (c === at(at(dark, y), x + 1) && c === at(at(dark, y + 1), x) && c === at(at(dark, y + 1), x + 1)) score += 3;
    }
  }
  const total = size * size;
  const darkCount = dark.flat().filter(Boolean).length;
  return score + Math.max(0, Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
}

/** The symbol for `text` as rows of modules, true for dark, without the quiet zone. Throws when the text is too long. */
export function qrModules(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (byteCapacity(version) < bytes.length) {
    if (++version > MAX_VERSION) throw new Error(`The text is ${bytes.length} bytes, longer than the ${byteCapacity(MAX_VERSION)} a QR code here can hold.`);
  }
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean): void => {
    at(dark, y)[x] = on;
    at(fixed, y)[x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (cx + dx >= 0 && cx + dx < size && cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = alignmentPositions(version);
  const last = centres.length - 1;
  centres.forEach((ax, i) =>
    centres.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // under a finder
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number): void => {
    const bits = formatBits(mask);
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // the dark module
  };
  drawFormat(0); // reserves the format areas before the data goes in
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) !== 0;
      set(size - 11 + (i % 3), Math.floor(i / 3), on);
      set(Math.floor(i / 3), size - 11 + (i % 3), on);
    }
  }

  // The data in two-module columns from the right, up and down in turn, skipping the vertical timing pattern.
  const data = codewords(bytes, version);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - step : step;
        if (at(at(fixed, y), x) || bit >= data.length * 8) continue;
        at(dark, y)[x] = ((at(data, bit >>> 3) >>> (7 - (bit & 7))) & 1) !== 0;
        bit++;
      }
    }
  }

  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!at(at(fixed, y), x) && at(MASKS, mask)(x, y)) at(dark, y)[x] = !at(at(dark, y), x);
  };
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(dark);
    if (score < lowest) [best, lowest] = [mask, score];
    applyMask(mask); // masking twice undoes it
  }
  applyMask(best);
  drawFormat(best);
  return dark;
}
