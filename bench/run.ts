/**
 * Throughput benchmark.
 *
 * Two questions, measured rather than argued:
 *
 *   1. Per profile and per condition, what fraction of frames survive the
 *      channel? Multiply by payload and display rate and that is goodput.
 *   2. How long does a decode take? If it exceeds the frame interval the
 *      receiver is the bottleneck, and sender density stops mattering. This
 *      is precisely where a QR-based receiver runs out of road at 60 fps.
 */

import { renderFrame, type RgbaImage } from '../src/core/render.js';
import { decodeFrame } from '../src/core/decode.js';
import { PROFILES, geometryFor, type Profile } from '../src/core/profile.js';
import { Rng } from '../src/core/rng.js';
import { PRESETS, channelOptions, simulateCapture, type ChannelPreset } from './channel.js';

const CAPTURE_W = Number(process.env.CAP_W ?? 1280);
const CAPTURE_H = Number(process.env.CAP_H ?? 1280);
const TRIALS = Number(process.env.TRIALS ?? 12);
/** Screen-side render resolution; a phone or laptop panel's short side. */
const RENDER = Number(process.env.RENDER ?? 1200);
/** Decode workers the receiver runs. Frames decode independently of one another. */
const WORKERS = Number(process.env.WORKERS ?? 4);

interface Row {
  profile: Profile;
  preset: string;
  ok: number;
  trials: number;
  corrected: number;
  decodeMs: number;
  payload: number;
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rng = new Rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.nextBelow(256);
  return out;
}

function runCase(profile: Profile, preset: ChannelPreset, trials: number): Row {
  const geo = geometryFor(profile);
  let ok = 0;
  let corrected = 0;
  let decodeMs = 0;

  let renderBuf: RgbaImage | undefined;
  let capBuf: RgbaImage | undefined;

  for (let t = 0; t < trials; t++) {
    const payload = randomBytes(geo.payloadBytes, 0x1000 + t * 31 + profile.id);
    const coded = geo.interleaver.encode(payload);
    renderBuf = renderFrame(coded, profile, { size: RENDER }, renderBuf);

    const opts = channelOptions(preset, CAPTURE_W, CAPTURE_H, 0x9e37 + t * 7919 + profile.id * 131);
    capBuf = simulateCapture(renderBuf, opts, capBuf);

    const t0 = performance.now();
    const res = decodeFrame(capBuf);
    decodeMs += performance.now() - t0;

    if (res.ok) {
      // Only count it if the bytes actually came back intact.
      let same = res.payload.length === payload.length;
      if (same) {
        for (let i = 0; i < payload.length; i++) {
          if (payload[i] !== res.payload[i]) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        ok++;
        corrected += res.corrected;
      }
    }
  }

  return {
    profile,
    preset: preset.name,
    ok,
    trials,
    corrected,
    decodeMs: decodeMs / trials,
    payload: geo.payloadBytes,
  };
}

function fmtRate(bytesPerSec: number): string {
  return bytesPerSec >= 1024 * 1024
    ? `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`
    : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

function main(): void {
  console.log(`\nChannel: capture ${CAPTURE_W}x${CAPTURE_H}, render ${RENDER}px, ${TRIALS} trials/case`);
  console.log(`Receiver: ${WORKERS} decode workers. Goodput counts only frames that decoded bit-exact.`);
  console.log('"max fps" is the receiver decode ceiling; goodput is capped by it.\n');

  const rows: Row[] = [];
  for (const preset of PRESETS) {
    for (const profile of PROFILES) {
      rows.push(runCase(profile, preset, TRIALS));
    }
  }

  for (const preset of PRESETS) {
    console.log(`\n=== ${preset.name} ===`);
    console.log(
      'profile'.padEnd(30) +
        'frame ok'.padStart(10) +
        'decode'.padStart(10) +
        'max fps'.padStart(9) +
        '@30fps'.padStart(12) +
        '@60fps'.padStart(12),
    );
    for (const r of rows.filter((x) => x.preset === preset.name)) {
      const rate = r.ok / r.trials;
      // Frames decode independently, so N workers decode N at a time. The
      // receiver still cannot use frames faster than it can decode them.
      const maxFps = r.decodeMs > 0 ? (1000 / r.decodeMs) * WORKERS : Infinity;
      const at30 = rate * r.payload * Math.min(30, maxFps);
      const at60 = rate * r.payload * Math.min(60, maxFps);
      console.log(
        r.profile.label.padEnd(30) +
          `${(rate * 100).toFixed(0)}%`.padStart(10) +
          `${r.decodeMs.toFixed(1)}ms`.padStart(10) +
          `${maxFps.toFixed(0)}`.padStart(9) +
          fmtRate(at30).padStart(12) +
          fmtRate(at60).padStart(12),
      );
    }
  }

  console.log('\nReference: the QR-based original reports ~129 KB/s typical, ~186 KB/s propped still.\n');
}

main();
