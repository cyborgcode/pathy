/**
 * Stream whitening.
 *
 * The receiver thresholds each cell against a local average of its
 * neighbours, which is what lets it ride out glare and vignetting. That only
 * works if the two levels stay roughly balanced across any patch of the
 * frame.
 *
 * Payload bytes do not guarantee that. A fountain frame of degree one carries
 * a raw source block, and a file with a run of zeros then paints a large
 * region of the grid a single colour — exactly the input that makes a local
 * threshold meaningless. XOR-ing against a fixed pseudorandom sequence makes
 * the cell distribution uniform no matter what the file contains.
 *
 * The sequence is fixed and public. It carries no secrecy; it exists purely
 * so the physical layer sees balanced data.
 */

import { Rng } from './rng.js';

const TABLE_BITS = 16;
const TABLE_SIZE = 1 << TABLE_BITS; // 64 KiB, larger than any frame

const TABLE = (() => {
  const t = new Uint8Array(TABLE_SIZE);
  const rng = new Rng(0x50484f54); // "PHOT"
  for (let i = 0; i < TABLE_SIZE; i++) t[i] = rng.nextU32() & 0xff;
  return t;
})();

/** XOR in place. Self-inverse, so the same call undoes it. */
export function whitenInPlace(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= TABLE[i & (TABLE_SIZE - 1)];
}

export function whitened(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  whitenInPlace(out);
  return out;
}
