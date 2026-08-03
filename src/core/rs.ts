/**
 * Reed-Solomon over GF(2^8), primitive polynomial 0x11d.
 *
 * Why an inner code at all, when the fountain layer already tolerates loss?
 * Because the two failure modes are different. The fountain handles *erasures*
 * — whole frames the camera never resolved. RS handles *errors* — a handful of
 * cells inside an otherwise good frame that got misclassified by glare, a
 * moire beat, or chroma subsampling smearing one cell into its neighbour.
 *
 * Without RS those frames are discarded entirely and the fountain has to make
 * up the difference, which is exactly the regime where throughput collapses.
 * With ~13% parity we keep frames that are 96% correct, and frame loss becomes
 * the only thing the fountain has to absorb.
 */

const PRIM = 0x11d;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function inv(a: number): number {
  if (a === 0) throw new Error('GF inverse of zero');
  return EXP[255 - LOG[a]];
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error('GF divide by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function pow(a: number, n: number): number {
  if (a === 0) return 0;
  const e = (((LOG[a] * n) % 255) + 255) % 255;
  return EXP[e];
}

/** Polynomials are big-endian: index 0 is the highest-order coefficient. */
function polyMul(p: Uint8Array | number[], q: Uint8Array | number[]): Uint8Array {
  const out = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    const qj = q[j];
    if (qj === 0) continue;
    const lq = LOG[qj];
    for (let i = 0; i < p.length; i++) {
      const pi = p[i];
      if (pi !== 0) out[i + j] ^= EXP[LOG[pi] + lq];
    }
  }
  return out;
}

function polyAdd(p: Uint8Array | number[], q: Uint8Array | number[]): Uint8Array {
  const out = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i++) out[i + out.length - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) out[i + out.length - q.length] ^= q[i];
  return out;
}

function polyScale(p: Uint8Array | number[], s: number): Uint8Array {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = mul(p[i], s);
  return out;
}

function polyEval(p: Uint8Array | number[], x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

const generatorCache = new Map<number, { poly: Uint8Array; log: Int16Array }>();

function generator(nsym: number): { poly: Uint8Array; log: Int16Array } {
  const hit = generatorCache.get(nsym);
  if (hit) return hit;
  let g: Uint8Array = Uint8Array.of(1);
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, EXP[i]]);
  // Cache the logs too: the encoder inner loop is the hot path for the sender.
  const log = new Int16Array(g.length);
  for (let i = 0; i < g.length; i++) log[i] = g[i] === 0 ? -1 : LOG[g[i]];
  const entry = { poly: g, log };
  generatorCache.set(nsym, entry);
  return entry;
}

/**
 * Systematic RS encode of one shard. Returns `nsym` parity bytes; the data is
 * transmitted unchanged, so a clean frame needs no decode work at all.
 */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const { log: glog } = generator(nsym);
  const work = new Uint8Array(data.length + nsym);
  work.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef === 0) continue;
    const lc = LOG[coef];
    // j starts at 1: the leading generator coefficient is 1, and skipping it
    // leaves the systematic data bytes untouched.
    for (let j = 1; j < glog.length; j++) {
      const lg = glog[j];
      if (lg >= 0) work[i + j] ^= EXP[lg + lc];
    }
  }
  return work.subarray(data.length);
}

function syndromes(codeword: Uint8Array, nsym: number): Uint8Array {
  // Leading zero kept so indices line up with the classical formulation.
  const s = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(codeword, pow(2, i));
  return s;
}

function findErrorLocator(synd: Uint8Array, nsym: number): Uint8Array | null {
  let errLoc: Uint8Array = Uint8Array.of(1);
  let oldLoc: Uint8Array = Uint8Array.of(1);

  for (let i = 0; i < nsym; i++) {
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[i - j]);
    }
    const grown = new Uint8Array(oldLoc.length + 1);
    grown.set(oldLoc);
    oldLoc = grown;

    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }

  let start = 0;
  while (start < errLoc.length && errLoc[start] === 0) start++;
  errLoc = errLoc.subarray(start);
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) return null; // beyond correction capability
  return errLoc;
}

function findErrorPositions(errLoc: Uint8Array, n: number): number[] | null {
  const expected = errLoc.length - 1;
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    // Evaluate at alpha^-i; a root means position (n-1-i) is in error.
    if (polyEval(errLoc, EXP[(255 - (i % 255)) % 255]) === 0) {
      positions.push(n - 1 - i);
    }
  }
  return positions.length === expected ? positions : null;
}

function correctErrata(
  codeword: Uint8Array,
  synd: Uint8Array,
  positions: number[],
): boolean {
  const n = codeword.length;
  const coefPos = positions.map((p) => n - 1 - p);

  let errLoc: Uint8Array = Uint8Array.of(1);
  for (const i of coefPos) errLoc = polyMul(errLoc, polyAdd([1], [pow(2, i), 0]));

  // Error evaluator Omega(x) = S(x) * Lambda(x) mod x^(nsym+1), where here
  // nsym is the errata count. Keeping the low-order tail is the "mod".
  const syndRev = Uint8Array.from(synd).reverse();
  const product = polyMul(syndRev, errLoc);
  const errEval = product.subarray(product.length - errLoc.length);

  const X = coefPos.map((cp) => pow(2, cp - 255));

  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = inv(Xi);

    // Formal derivative of the errata locator, evaluated the product way.
    let denom = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = mul(denom, 1 ^ mul(XiInv, X[j]));
    }
    if (denom === 0) return false;

    let y = polyEval(errEval, XiInv);
    y = mul(Xi, y);
    codeword[positions[i]] ^= div(y, denom);
  }
  return true;
}

export interface RsDecodeResult {
  ok: boolean;
  /** Number of byte errors corrected (0 for an already-clean shard). */
  corrected: number;
}

/** Decode one shard in place. Returns ok=false if it is beyond repair. */
export function rsDecodeInPlace(codeword: Uint8Array, nsym: number): RsDecodeResult {
  const synd = syndromes(codeword, nsym);
  let clean = true;
  for (let i = 1; i <= nsym; i++) {
    if (synd[i] !== 0) {
      clean = false;
      break;
    }
  }
  if (clean) return { ok: true, corrected: 0 };

  const errLoc = findErrorLocator(synd.subarray(1), nsym);
  if (!errLoc) return { ok: false, corrected: 0 };

  const positions = findErrorPositions(errLoc, codeword.length);
  if (!positions || positions.length === 0) return { ok: false, corrected: 0 };
  for (const p of positions) {
    if (p < 0 || p >= codeword.length) return { ok: false, corrected: 0 };
  }

  if (!correctErrata(codeword, synd, positions)) return { ok: false, corrected: 0 };

  // Re-derive syndromes: a decode that lands outside the code's distance can
  // "succeed" arithmetically while producing garbage, and silently corrupting
  // a block would poison every fountain frame that references it.
  const check = syndromes(codeword, nsym);
  for (let i = 1; i <= nsym; i++) {
    if (check[i] !== 0) return { ok: false, corrected: 0 };
  }
  return { ok: true, corrected: positions.length };
}

/**
 * Interleaved RS across a whole frame.
 *
 * Cells are laid out so that consecutive bytes land far apart on screen (see
 * the grid codec), which means a localised smudge becomes one or two byte
 * errors in each of many shards rather than a burst that swamps a single one.
 */
export class RsInterleaver {
  readonly shardData: number;
  readonly shardParity: number;
  readonly shards: number;
  readonly payloadBytes: number;
  readonly codedBytes: number;

  constructor(payloadBytes: number, shardData = 223, shardParity = 32) {
    if (shardData + shardParity > 255) throw new RangeError('shard exceeds GF(256) block length');
    this.shardData = shardData;
    this.shardParity = shardParity;
    this.shards = Math.ceil(payloadBytes / shardData);
    this.payloadBytes = payloadBytes;
    this.codedBytes = this.shards * (shardData + shardParity);
  }

  /** Largest payload that fits a given coded budget. */
  static payloadForCoded(codedBytes: number, shardData = 223, shardParity = 32): number {
    const shards = Math.floor(codedBytes / (shardData + shardParity));
    return shards * shardData;
  }

  encode(payload: Uint8Array): Uint8Array {
    if (payload.length !== this.payloadBytes) {
      throw new RangeError(`expected ${this.payloadBytes} payload bytes, got ${payload.length}`);
    }
    const out = new Uint8Array(this.codedBytes);
    const scratch = new Uint8Array(this.shardData);
    const shards = this.shards;
    for (let s = 0; s < shards; s++) {
      const from = s * this.shardData;
      const len = Math.min(this.shardData, payload.length - from);
      scratch.fill(0);
      scratch.set(payload.subarray(from, from + len));
      const parity = rsEncode(scratch, this.shardParity);
      // Transposed layout: byte j of every shard sits next to byte j of the
      // others. A glare blob or a smudged screen region covers a run of
      // consecutive cells, which this scatters into one or two byte errors
      // per shard instead of a burst that swamps a single one.
      for (let j = 0; j < this.shardData; j++) out[j * shards + s] = scratch[j];
      for (let j = 0; j < this.shardParity; j++) {
        out[(this.shardData + j) * shards + s] = parity[j];
      }
    }
    return out;
  }

  /**
   * Decode a full frame. `ok` is false if any shard was unrecoverable, in
   * which case the frame is dropped and the fountain absorbs it.
   */
  decode(coded: Uint8Array): { ok: boolean; payload: Uint8Array; corrected: number } {
    const stride = this.shardData + this.shardParity;
    const payload = new Uint8Array(this.payloadBytes);
    const shards = this.shards;
    const shard = new Uint8Array(stride);
    let corrected = 0;
    for (let s = 0; s < shards; s++) {
      for (let j = 0; j < stride; j++) shard[j] = coded[j * shards + s];
      const res = rsDecodeInPlace(shard, this.shardParity);
      if (!res.ok) return { ok: false, payload, corrected };
      corrected += res.corrected;
      const from = s * this.shardData;
      const len = Math.min(this.shardData, this.payloadBytes - from);
      if (len > 0) payload.set(shard.subarray(0, len), from);
    }
    return { ok: true, payload, corrected };
  }
}
