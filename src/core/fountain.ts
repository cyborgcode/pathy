/**
 * Windowed Luby-transform fountain coding.
 *
 * The classic formulation treats the whole file as one block set. That is fine
 * for a 2 MB demo and hopeless past it: the decoder has to hold every
 * unsolved frame in memory, so peak RAM scales with file size, and a single
 * unlucky window of the transfer stalls the entire payload.
 *
 * Here the file is cut into independent windows (a couple of MB each). Each
 * window gets its own fountain, its own block count, and its own seed. The
 * decoder therefore only ever holds a handful of windows at once, and finished
 * windows are flushed straight to disk. Peak RAM is a function of window size,
 * not file size, which is what makes multi-gigabyte payloads possible.
 *
 * It also makes the transfer self-healing across passes: the sender loops over
 * windows forever, so a window the receiver joined too late to finish simply
 * completes on the next time round.
 */

import { DegreeSampler, blocksForFrame, type SolitonParams, DEFAULT_SOLITON } from './soliton.js';

export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = dst.length;
  // Word-at-a-time where alignment allows; this is the decoder's hot loop.
  const head = (4 - (dst.byteOffset & 3)) & 3;
  const aligned = head === ((4 - (src.byteOffset & 3)) & 3);
  if (!aligned || n < 32) {
    for (let i = 0; i < n; i++) dst[i] ^= src[i];
    return;
  }
  let i = 0;
  for (; i < head; i++) dst[i] ^= src[i];
  const words = (n - head) >>> 2;
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset + head, words);
  const s32 = new Uint32Array(src.buffer, src.byteOffset + head, words);
  for (let w = 0; w < words; w++) d32[w] ^= s32[w];
  i = head + (words << 2);
  for (; i < n; i++) dst[i] ^= src[i];
}

/** Deterministic per-window seed, so both sides agree with no negotiation. */
export function windowSeed(sessionId: number, windowIndex: number): number {
  return (Math.imul(sessionId, 0x27d4eb2f) ^ Math.imul(windowIndex + 1, 0x165667b1)) >>> 0;
}

/** Encoder for a single window, held entirely in memory. */
export class LtWindowEncoder {
  readonly k: number;
  readonly blockSize: number;
  private readonly sampler: DegreeSampler;
  private readonly seed: number;
  private readonly source: Uint8Array;

  constructor(
    windowBytes: Uint8Array,
    blockSize: number,
    sessionId: number,
    windowIndex: number,
    params: SolitonParams = DEFAULT_SOLITON,
  ) {
    this.blockSize = blockSize;
    this.k = Math.max(1, Math.ceil(windowBytes.length / blockSize));
    // Zero-pad the tail so every block is full width; the true length is
    // carried in the manifest and trimmed on reassembly.
    this.source = new Uint8Array(this.k * blockSize);
    this.source.set(windowBytes);
    this.sampler = new DegreeSampler(this.k, params);
    this.seed = windowSeed(sessionId, windowIndex);
  }

  /** Build the coded block for a sequence number, into `out`. */
  encodeInto(seqNo: number, out: Uint8Array): void {
    const blocks = blocksForFrame(this.sampler, this.seed, seqNo);
    out.fill(0);
    for (let i = 0; i < blocks.length; i++) {
      const off = blocks[i] * this.blockSize;
      xorInto(out, this.source.subarray(off, off + this.blockSize));
    }
  }
}

interface PendingFrame {
  data: Uint8Array;
  /** Blocks still unsolved for this frame. */
  rem: Set<number>;
}

export interface AddFrameResult {
  /** The frame contributed new information. */
  useful: boolean;
  /** The window is now fully decoded. */
  complete: boolean;
}

/**
 * Incremental peeling decoder for one window.
 *
 * Frames are reduced against already-solved blocks on arrival, and solving a
 * block cascades into every pending frame that referenced it. Work is spread
 * across arrivals rather than saved up, so completion is not a stall.
 */
export class LtWindowDecoder {
  readonly k: number;
  readonly blockSize: number;
  readonly data: Uint8Array;
  private readonly solved: Uint8Array;
  private readonly sampler: DegreeSampler;
  private readonly seed: number;
  private readonly pending: (PendingFrame | null)[] = [];
  private readonly refs: Map<number, number[]> = new Map();
  private readonly seen = new Set<number>();
  private solvedCount = 0;
  private framesUsed = 0;

  constructor(
    k: number,
    blockSize: number,
    sessionId: number,
    windowIndex: number,
    params: SolitonParams = DEFAULT_SOLITON,
  ) {
    this.k = k;
    this.blockSize = blockSize;
    this.data = new Uint8Array(k * blockSize);
    this.solved = new Uint8Array(k);
    this.sampler = new DegreeSampler(k, params);
    this.seed = windowSeed(sessionId, windowIndex);
  }

  get isComplete(): boolean {
    return this.solvedCount === this.k;
  }

  get progress(): number {
    return this.solvedCount / this.k;
  }

  get framesAccepted(): number {
    return this.framesUsed;
  }

  /** Fraction of K received; the honest progress signal mid-transfer. */
  get coverage(): number {
    return this.framesUsed / this.k;
  }

  addFrame(seqNo: number, payload: Uint8Array): AddFrameResult {
    if (this.isComplete) return { useful: false, complete: true };
    // Duplicate sequence numbers carry no new information — the same frame
    // decoded twice is the common case when the camera outruns the display.
    if (this.seen.has(seqNo)) return { useful: false, complete: false };
    this.seen.add(seqNo);

    const blocks = blocksForFrame(this.sampler, this.seed, seqNo);
    const data = new Uint8Array(this.blockSize);
    data.set(payload.subarray(0, this.blockSize));

    const rem = new Set<number>();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (this.solved[b]) {
        xorInto(data, this.data.subarray(b * this.blockSize, (b + 1) * this.blockSize));
      } else {
        rem.add(b);
      }
    }

    if (rem.size === 0) return { useful: false, complete: this.isComplete };
    this.framesUsed++;

    if (rem.size === 1) {
      const b = rem.values().next().value as number;
      this.solveBlock(b, data);
      return { useful: true, complete: this.isComplete };
    }

    const id = this.pending.length;
    this.pending.push({ data, rem });
    for (const b of rem) {
      let list = this.refs.get(b);
      if (!list) this.refs.set(b, (list = []));
      list.push(id);
    }
    return { useful: true, complete: this.isComplete };
  }

  /** Solve one block and cascade through everything that referenced it. */
  private solveBlock(first: number, firstData: Uint8Array): void {
    const queue: Array<[number, Uint8Array]> = [[first, firstData]];

    while (queue.length > 0) {
      const [b, value] = queue.pop()!;
      if (this.solved[b]) continue;
      this.data.set(value, b * this.blockSize);
      this.solved[b] = 1;
      this.solvedCount++;

      const list = this.refs.get(b);
      if (!list) continue;
      this.refs.delete(b);

      for (let i = 0; i < list.length; i++) {
        const frame = this.pending[list[i]];
        if (!frame || !frame.rem.has(b)) continue;
        xorInto(frame.data, value);
        frame.rem.delete(b);
        if (frame.rem.size === 1) {
          const nb = frame.rem.values().next().value as number;
          this.pending[list[i]] = null;
          if (!this.solved[nb]) queue.push([nb, frame.data]);
        } else if (frame.rem.size === 0) {
          this.pending[list[i]] = null;
        }
      }
    }
  }

  /** Release pending-frame memory once the window is finished. */
  compact(): void {
    this.pending.length = 0;
    this.refs.clear();
    this.seen.clear();
  }
}
