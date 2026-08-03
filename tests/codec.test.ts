import { describe, it, expect } from 'vitest';
import { renderFrame } from '../src/core/render.js';
import { decodeFrame } from '../src/core/decode.js';
import { PROFILES, profileById, geometryFor } from '../src/core/profile.js';
import { writeFrame, readFrame, FrameType, HEADER_BYTES } from '../src/core/frame.js';
import { Rng } from '../src/core/rng.js';

function randomPayload(n: number, seed: number): Uint8Array {
  const rng = new Rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.nextBelow(256);
  return out;
}

describe('Chroma Grid codec', () => {
  it('round-trips a clean render for every profile', () => {
    for (const profile of PROFILES) {
      const geo = geometryFor(profile);
      const payload = randomPayload(geo.payloadBytes, 1000 + profile.id);
      const coded = geo.interleaver.encode(payload);

      // ~6 px per cell: comfortably inside what a phone camera resolves off a
      // laptop screen at arm's length.
      const size = profile.cells * 6 + 120;
      const img = renderFrame(coded, profile, { size });

      const res = decodeFrame(img);
      expect(res.ok, `profile ${profile.id} (${profile.label}): ${res.ok ? '' : res.reason}`).toBe(true);
      if (!res.ok) continue;
      expect(res.profile.id).toBe(profile.id);
      expect(Array.from(res.payload)).toEqual(Array.from(payload));
    }
  });

  it('auto-detects the profile from the control strip', () => {
    for (const profile of PROFILES) {
      const geo = geometryFor(profile);
      const coded = geo.interleaver.encode(randomPayload(geo.payloadBytes, 7));
      const img = renderFrame(coded, profile, { size: profile.cells * 6 + 120 });
      const res = decodeFrame(img);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.profile.id).toBe(profile.id);
    }
  });

  it('carries a full frame header through the optical layer', () => {
    const profile = profileById(2);
    const geo = geometryFor(profile);
    const body = randomPayload(geo.payloadBytes - HEADER_BYTES, 42);

    const payload = new Uint8Array(geo.payloadBytes);
    writeFrame(payload, {
      type: FrameType.Data,
      sessionId: 0xdeadbeef,
      seqNo: 123456,
      windowIndex: 7,
      windowCount: 900,
      blocks: 512,
      blockSize: body.length,
    }, body);

    const img = renderFrame(geo.interleaver.encode(payload), profile, { size: 1100 });
    const res = decodeFrame(img);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const parsed = readFrame(res.payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.header.sessionId).toBe(0xdeadbeef);
    expect(parsed!.header.seqNo).toBe(123456);
    expect(parsed!.header.windowIndex).toBe(7);
    expect(parsed!.header.blocks).toBe(512);
    expect(Array.from(parsed!.body)).toEqual(Array.from(body));
  });

  it('rejects a frame whose CRC does not hold', () => {
    const payload = new Uint8Array(500);
    writeFrame(payload, {
      type: FrameType.Data,
      sessionId: 1, seqNo: 2, windowIndex: 0, windowCount: 1, blocks: 4, blockSize: 100,
    }, randomPayload(100, 3));
    payload[HEADER_BYTES + 10] ^= 0xff;
    expect(readFrame(payload)).toBeNull();
  });
});

describe('capacity', () => {
  it('reports per-frame payload for each profile', () => {
    const rows = PROFILES.map((p) => {
      const geo = geometryFor(p);
      return `${p.label.padEnd(30)} cells=${String(geo.dataCellCount).padStart(6)} payload=${String(geo.payloadBytes).padStart(6)}B`;
    });
    console.log('\n' + rows.join('\n'));
    expect(geometryFor(profileById(2)).payloadBytes).toBeGreaterThan(4000);
  });
});
