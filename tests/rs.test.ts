import { describe, it, expect } from 'vitest';
import { rsEncode, rsDecodeInPlace, RsInterleaver } from '../src/core/rs.js';
import { Rng } from '../src/core/rng.js';

describe('Reed-Solomon GF(256)', () => {
  it('round-trips a clean shard', () => {
    const data = new Uint8Array(223).map((_, i) => (i * 7) & 0xff);
    const parity = rsEncode(data, 32);
    expect(parity.length).toBe(32);

    const cw = new Uint8Array(255);
    cw.set(data);
    cw.set(parity, 223);
    const res = rsDecodeInPlace(cw, 32);
    expect(res.ok).toBe(true);
    expect(res.corrected).toBe(0);
    expect(Array.from(cw.subarray(0, 223))).toEqual(Array.from(data));
  });

  it('corrects up to nsym/2 byte errors', () => {
    const rng = new Rng(1234);
    for (let trial = 0; trial < 200; trial++) {
      const data = new Uint8Array(223);
      for (let i = 0; i < data.length; i++) data[i] = rng.nextBelow(256);
      const cw = new Uint8Array(255);
      cw.set(data);
      cw.set(rsEncode(data, 32), 223);

      const nerr = rng.nextBelow(17); // 0..16, the correction limit
      const hit = new Set<number>();
      while (hit.size < nerr) hit.add(rng.nextBelow(255));
      for (const p of hit) cw[p] ^= 1 + rng.nextBelow(255);

      const res = rsDecodeInPlace(cw, 32);
      expect(res.ok).toBe(true);
      expect(res.corrected).toBe(nerr);
      expect(Array.from(cw.subarray(0, 223))).toEqual(Array.from(data));
    }
  });

  it('reports failure rather than silently corrupting beyond capacity', () => {
    const rng = new Rng(99);
    let clean = 0;
    for (let trial = 0; trial < 200; trial++) {
      const data = new Uint8Array(223);
      for (let i = 0; i < data.length; i++) data[i] = rng.nextBelow(256);
      const cw = new Uint8Array(255);
      cw.set(data);
      cw.set(rsEncode(data, 32), 223);

      const hit = new Set<number>();
      while (hit.size < 30) hit.add(rng.nextBelow(255)); // way past t=16
      for (const p of hit) cw[p] ^= 1 + rng.nextBelow(255);

      const res = rsDecodeInPlace(cw, 32);
      // Either it refuses, or (astronomically unlikely) it lands on a genuine
      // codeword. What must never happen is ok=true with wrong data.
      if (res.ok) {
        clean++;
        expect(Array.from(cw.subarray(0, 223))).toEqual(Array.from(data));
      }
    }
    expect(clean).toBeLessThan(5);
  });
});

describe('RsInterleaver', () => {
  it('round-trips a full frame with scattered errors', () => {
    const rng = new Rng(7);
    const inter = new RsInterleaver(8000);
    const payload = new Uint8Array(inter.payloadBytes);
    for (let i = 0; i < payload.length; i++) payload[i] = rng.nextBelow(256);

    const coded = inter.encode(payload);
    expect(coded.length).toBe(inter.codedBytes);

    // 1% of bytes corrupted, spread across the frame.
    const nerr = Math.floor(coded.length * 0.01);
    for (let i = 0; i < nerr; i++) {
      const p = rng.nextBelow(coded.length);
      coded[p] ^= 1 + rng.nextBelow(255);
    }

    const res = inter.decode(coded);
    expect(res.ok).toBe(true);
    expect(res.corrected).toBeGreaterThan(0);
    expect(Array.from(res.payload)).toEqual(Array.from(payload));
  });

  it('payloadForCoded is the inverse of the layout', () => {
    const payload = RsInterleaver.payloadForCoded(10000);
    const inter = new RsInterleaver(payload);
    expect(inter.codedBytes).toBeLessThanOrEqual(10000);
  });
});
