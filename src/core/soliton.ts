/**
 * Robust soliton degree distribution, quantised to an integer CDF.
 *
 * The distribution is what makes a fountain code actually terminate: mostly
 * degree-1 and degree-2 frames to keep the peeling cascade fed, with a thin
 * tail of high-degree frames so no block is left unreferenced.
 *
 * Everything here is derived through `detLn` and exactly-specified float
 * arithmetic, then frozen into a Uint32 CDF. Sampling is a binary search over
 * integers, so the sender and receiver agree on every degree with no shared
 * state beyond (K, c, delta).
 */

import { Rng, detLn } from './rng.js';

export interface SolitonParams {
  /** Tuning constant; smaller c means a larger ripple. */
  c: number;
  /** Target failure probability for the decoder. */
  delta: number;
}

export const DEFAULT_SOLITON: SolitonParams = { c: 0.03, delta: 0.05 };

export class DegreeSampler {
  readonly k: number;
  /** cdf[i] = P(degree <= i+1) scaled to uint32. */
  private readonly cdf: Uint32Array;

  constructor(k: number, params: SolitonParams = DEFAULT_SOLITON) {
    if (k < 1) throw new RangeError('k must be >= 1');
    this.k = k;

    if (k === 1) {
      this.cdf = Uint32Array.of(0xffffffff);
      return;
    }

    const { c, delta } = params;

    // R ~ the expected ripple size. Forced to an integer so that the spike
    // position below is a discrete, reproducible choice rather than something
    // that can land on either side of a float comparison.
    let r = Math.floor(c * detLn(k / delta) * Math.sqrt(k));
    if (r < 1) r = 1;
    if (r > k) r = k;
    const spike = Math.floor(k / r); // degree carrying the extra tau mass

    const w = new Float64Array(k + 1); // 1-indexed by degree

    // Ideal soliton.
    w[1] = 1 / k;
    for (let d = 2; d <= k; d++) w[d] = 1 / (d * (d - 1));

    // Robust component.
    for (let d = 1; d < spike && d <= k; d++) w[d] += r / (d * k);
    if (spike >= 1 && spike <= k) w[spike] += (r * detLn(r / delta)) / k;

    let total = 0;
    for (let d = 1; d <= k; d++) total += w[d];

    const cdf = new Uint32Array(k);
    let acc = 0;
    for (let d = 1; d <= k; d++) {
      acc += w[d] / total;
      // 4294967296 = 2^32; floor is exact, so quantisation is reproducible.
      const q = Math.floor(acc * 4294967296);
      cdf[d - 1] = q >= 4294967296 ? 0xffffffff : q >>> 0;
    }
    cdf[k - 1] = 0xffffffff; // guarantee the search always terminates
    this.cdf = cdf;
  }

  /** Draw a degree in [1, k]. */
  sample(rng: Rng): number {
    const u = rng.nextU32();
    const cdf = this.cdf;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (u < cdf[mid]) hi = mid;
      else lo = mid + 1;
    }
    return lo + 1;
  }
}

/**
 * The block indices combined into a given frame.
 *
 * Derived purely from (windowSeed, seqNo), so a receiver that tunes in
 * mid-stream can interpret any frame it catches without having seen a single
 * one before it.
 */
export function blocksForFrame(
  sampler: DegreeSampler,
  windowSeed: number,
  seqNo: number,
): Uint32Array {
  const rng = new Rng((Math.imul(windowSeed, 0x9e3779b1) ^ Math.imul(seqNo + 1, 0x85ebca6b)) >>> 0);
  // Burn one draw so that low sequence numbers do not correlate.
  rng.nextU32();
  const degree = sampler.sample(rng);
  return rng.distinctBelow(degree, sampler.k);
}
