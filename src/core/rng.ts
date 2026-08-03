/**
 * Deterministic PRNG + deterministic transcendentals.
 *
 * Sender and receiver never talk to each other, so they cannot negotiate
 * anything: they must independently derive the *identical* block selection for
 * a given frame sequence number. That makes bit-level reproducibility across
 * JS engines a correctness requirement, not a nicety.
 *
 * Two hazards, both handled here:
 *
 *  1. `Math.random` is obviously out; we use xoshiro128** driven entirely by
 *     uint32 ops (`|0`, `>>>`, `^`, `+`), all of which ECMAScript specifies
 *     exactly.
 *
 *  2. `Math.log` is *not* specified to bit precision. V8 and JavaScriptCore
 *     return results that differ in the low mantissa bits, which is enough to
 *     move a degree-distribution bucket boundary and desynchronise the two
 *     sides. So we never call it: `detLn` below is built from +, -, *, / and
 *     float64 bit surgery, all of which are exactly specified.
 */

/** xoshiro128** — 128 bits of state, uint32 arithmetic only. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix32 expansion so that adjacent seeds produce unrelated streams.
    let z = seed >>> 0;
    const next = (): number => {
      z = (z + 0x9e3779b9) >>> 0;
      let x = z;
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
      return (x ^ (x >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // A seed expanding to all-zero state would lock the generator up.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Next uniform uint32. */
  nextU32(): number {
    const r = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11) >>> 0;
    return r;
  }

  /** Uniform integer in [0, n). Rejection-sampled, so no modulo bias. */
  nextBelow(n: number): number {
    if (n <= 1) return 0;
    const limit = (0x100000000 - (0x100000000 % n)) >>> 0;
    for (;;) {
      const v = this.nextU32();
      if (v < limit || limit === 0) return v % n;
    }
  }

  /**
   * `count` distinct values from [0, n), via partial Fisher-Yates over a
   * sparse map. O(count) time and memory — important because a high-degree
   * fountain frame may reference thousands of blocks out of a large window.
   */
  distinctBelow(count: number, n: number): Uint32Array {
    const k = Math.min(count, n);
    const out = new Uint32Array(k);
    const swapped = new Map<number, number>();
    for (let i = 0; i < k; i++) {
      const j = i + this.nextBelow(n - i);
      out[i] = swapped.get(j) ?? j;
      const tail = swapped.get(i) ?? i;
      swapped.set(j, tail);
    }
    return out;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

const LN2 = 0.6931471805599453;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/**
 * Natural log, bit-identical on every engine.
 *
 * Splits x into mantissa * 2^exp by reading the float64 bits directly, then
 * evaluates ln(m) with the atanh series using a fixed iteration count. Only
 * +, -, *, / are involved, and ECMAScript specifies those exactly, so every
 * engine produces the same bits.
 */
export function detLn(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new RangeError(`detLn domain: ${x}`);

  f64[0] = x;
  const hi = u32[1];
  let exp = ((hi >>> 20) & 0x7ff) - 1023;

  if (exp === -1023) {
    // Subnormal: scale into normal range and correct afterwards.
    f64[0] = x * 4503599627370496; // 2^52
    exp = (((u32[1] >>> 20) & 0x7ff) - 1023) - 52;
    u32[1] = (u32[1] & 0x800fffff) | (1023 << 20);
  } else {
    u32[1] = (hi & 0x800fffff) | (1023 << 20);
  }
  let m = f64[0]; // m in [1, 2)

  // Centring the mantissa on 1 keeps |z| <= 0.1716, so 20 terms is far past
  // the point where the series stops changing the float64 result.
  if (m > 1.4142135623730951) {
    m /= 2;
    exp += 1;
  }

  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = z;
  for (let i = 3; i <= 41; i += 2) {
    term *= z2;
    sum += term / i;
  }
  return 2 * sum + exp * LN2;
}

/** Integer square root — exact, no floating point in the result path. */
export function isqrt(n: number): number {
  if (n < 0) throw new RangeError('isqrt of negative');
  if (n < 2) return n;
  let x = Math.floor(Math.sqrt(n));
  // Correct any last-bit error from the hardware sqrt.
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}
