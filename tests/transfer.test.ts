import { describe, it, expect } from 'vitest';
import {
  SenderSession,
  ReceiverSession,
  MemorySource,
  MemorySink,
} from '../src/core/session.js';
import { profileById } from '../src/core/profile.js';
import { Rng } from '../src/core/rng.js';
import { sha256, bytesEqual } from '../src/core/sha256.js';

/** Compressible-ish content, so this is not just a random-data benchmark. */
function makeFile(size: number, seed: number): Uint8Array {
  const rng = new Rng(seed);
  const out = new Uint8Array(size);
  let i = 0;
  while (i < size) {
    const kind = rng.nextBelow(3);
    const run = 1 + rng.nextBelow(400);
    if (kind === 0) {
      // A run of zeros: the case that breaks a naive local threshold, and the
      // reason the physical layer whitens.
      i += Math.min(run, size - i);
    } else if (kind === 1) {
      const v = rng.nextBelow(256);
      for (let k = 0; k < run && i < size; k++) out[i++] = v;
    } else {
      for (let k = 0; k < run && i < size; k++) out[i++] = rng.nextBelow(256);
    }
  }
  return out;
}

/**
 * Run a transfer with the optical layer stubbed out, so this exercises the
 * fountain, windowing and framing rather than the camera model. Frame loss is
 * applied directly.
 */
async function transfer(
  fileSize: number,
  opts: { loss: number; windowBytes?: number; maxFrames?: number; joinLate?: number },
): Promise<{
  ok: boolean;
  frames: number;
  accepted: number;
  received: Uint8Array;
  overhead: number;
}> {
  const file = makeFile(fileSize, 0xabc);
  const hash = sha256(file);
  const profile = profileById(2);

  const sender = new SenderSession(new MemorySource(file), {
    profile,
    name: 'test.bin',
    mime: 'application/octet-stream',
    hash,
    windowBytes: opts.windowBytes,
    sessionId: 0x1234,
  });

  const sink = new MemorySink(fileSize);
  const receiver = new ReceiverSession({ sink });

  const rng = new Rng(0xfeed);
  const maxFrames = opts.maxFrames ?? 200000;
  const joinLate = opts.joinLate ?? 0;

  let frames = 0;
  let accepted = 0;

  while (frames < maxFrames && !receiver.isComplete) {
    const payload = await sender.nextFramePayload();
    frames++;

    // The receiver only starts watching after `joinLate` frames, exactly as a
    // person pointing a camera at an already-running stream would.
    if (frames <= joinLate) continue;

    // Simulate frames the camera never resolved.
    if (rng.nextU32() / 0xffffffff < opts.loss) continue;

    const outcome = await receiver.ingest(payload);
    if (outcome === 'accepted' || outcome === 'window-complete' || outcome === 'complete') {
      accepted++;
    }
  }

  const idealFrames = Math.ceil(fileSize / sender.bytesPerFrame);
  return {
    ok: receiver.isComplete,
    frames,
    accepted,
    received: sink.bytes,
    overhead: frames / idealFrames,
  };
}

describe('end-to-end transfer', () => {
  it('delivers a small file bit-exact with no loss', async () => {
    const size = 300 * 1024;
    const r = await transfer(size, { loss: 0 });
    expect(r.ok).toBe(true);
    expect(bytesEqual(r.received, makeFile(size, 0xabc))).toBe(true);
  });

  it('survives 25% frame loss', async () => {
    const size = 512 * 1024;
    const r = await transfer(size, { loss: 0.25 });
    expect(r.ok).toBe(true);
    expect(bytesEqual(r.received, makeFile(size, 0xabc))).toBe(true);
  });

  it('recovers a window it joined too late to finish, on the next pass', async () => {
    const size = 1024 * 1024;
    // Start watching well into the stream, so the first window is already
    // half gone. Without the sender looping this could never complete.
    const r = await transfer(size, { loss: 0.1, windowBytes: 256 * 1024, joinLate: 40 });
    expect(r.ok).toBe(true);
    expect(bytesEqual(r.received, makeFile(size, 0xabc))).toBe(true);
  });

  it('verifies against the transmitted hash', async () => {
    const size = 400 * 1024;
    const r = await transfer(size, { loss: 0.15 });
    expect(r.ok).toBe(true);
    const expected = sha256(makeFile(size, 0xabc));
    expect(bytesEqual(sha256(r.received), expected)).toBe(true);
  });

  it('holds a bounded number of windows open regardless of file size', async () => {
    // 8 MB across 256 KB windows is 32 windows; the receiver must never be
    // holding more than a few of them at once.
    const size = 8 * 1024 * 1024;
    const r = await transfer(size, { loss: 0.1, windowBytes: 256 * 1024 });
    expect(r.ok).toBe(true);
    expect(bytesEqual(sha256(r.received), sha256(makeFile(size, 0xabc)))).toBe(true);
  }, 120000);

  it('reports transmission overhead', async () => {
    const rows: string[] = [];
    for (const loss of [0, 0.1, 0.25, 0.4]) {
      const r = await transfer(512 * 1024, { loss });
      rows.push(
        `  loss ${String(Math.round(loss * 100)).padStart(2)}%  ->  ${r.overhead.toFixed(2)}x frames sent per file-worth of data`,
      );
      expect(r.ok).toBe(true);
    }
    console.log('\n' + rows.join('\n'));
  }, 120000);
});
