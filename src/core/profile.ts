/**
 * Frame geometry and transmission profiles.
 *
 * The physical layer is a colour raster, not a QR code. Three things fall out
 * of that, and together they are most of the speed difference:
 *
 *  - **Three bits per cell instead of one.** Each cell is one of eight
 *    saturated colours, and R/G/B each carry an independent bit. A channel
 *    misread costs exactly one bit, so per-channel thresholding is both the
 *    fastest and the most robust way to decode.
 *
 *  - **No format overhead.** QR spends a quarter of its modules on mandated
 *    ECC, plus version blocks, alignment patterns and mask bookkeeping. Here
 *    the only fixed costs are four corner markers, a control strip and a
 *    colour calibration strip; everything else is payload, and the error
 *    correction is tuned for this channel rather than for print.
 *
 *  - **A decoder that keeps up.** Locating four markers and resampling a grid
 *    is a couple of milliseconds, against tens for a general-purpose QR
 *    reader. The original project dropped frames whenever its WASM workers
 *    fell behind; at 60 fps that is most of them.
 *
 * All geometry lives in normalised code space [0,1]^2 so the layout is
 * resolution independent: the sender picks a pixel size, the receiver
 * recovers the same square through a homography, and both compute an
 * identical cell list from the profile alone.
 */

import { RsInterleaver } from './rs.js';

/** Corner marker box, as a fraction of the code square. */
export const MARKER_BOX = 0.1;
/** The finder pattern proper occupies 7 of the 9 units inside that box. */
export const FINDER_UNITS = 7;
export const MARKER_UNITS = 9;

/** Control strip: profile id, readable before the grid pitch is known. */
export const CONTROL_X0 = 0.3;
export const CONTROL_X1 = 0.7;
export const CONTROL_Y0 = 0.004;
export const CONTROL_Y1 = 0.032;
export const CONTROL_SLOTS = 24;

/** Colour calibration strip: the eight palette colours, in order. */
export const CALIB_X0 = 0.3;
export const CALIB_X1 = 0.7;
export const CALIB_Y0 = 0.968;
export const CALIB_Y1 = 0.996;
export const CALIB_SLOTS = 8;

export interface Profile {
  id: number;
  /** Grid pitch: cells per side. */
  cells: number;
  /** 1 (mono), 2 or 3 bits per cell. */
  bitsPerCell: 1 | 2 | 3;
  /** RS parity bytes per 255-byte shard. */
  shardParity: number;
  label: string;
}

/**
 * Profile 0 is the safe fallback and doubles as the "I could not read the
 * control strip" default. Higher ids are denser; the sender can be told to
 * step down if the link is poor.
 */
export const PROFILES: readonly Profile[] = [
  { id: 0, cells: 96, bitsPerCell: 3, shardParity: 48, label: '96 · colour · robust' },
  { id: 1, cells: 128, bitsPerCell: 3, shardParity: 32, label: '128 · colour' },
  { id: 2, cells: 160, bitsPerCell: 3, shardParity: 32, label: '160 · colour (default)' },
  { id: 3, cells: 192, bitsPerCell: 3, shardParity: 32, label: '192 · colour · dense' },
  { id: 4, cells: 224, bitsPerCell: 3, shardParity: 32, label: '224 · colour · very dense' },
  { id: 5, cells: 256, bitsPerCell: 3, shardParity: 24, label: '256 · colour · extreme' },
  { id: 6, cells: 128, bitsPerCell: 2, shardParity: 48, label: '128 · 2-bit · bright rooms' },
  { id: 7, cells: 160, bitsPerCell: 1, shardParity: 32, label: '160 · mono · worst case' },
  { id: 8, cells: 192, bitsPerCell: 2, shardParity: 32, label: '192 · 2-bit' },
];

export const DEFAULT_PROFILE_ID = 2;

export function profileById(id: number): Profile {
  return PROFILES[id] ?? PROFILES[DEFAULT_PROFILE_ID];
}

/**
 * Palette: value v maps R/G/B to independent bits, so the decoder thresholds
 * each channel separately rather than searching a 3-D colour space.
 *
 * At 2 bits the blue channel mirrors red, giving that bit a free repeat. At
 * 1 bit the cell is plain black or white.
 */
export function cellRgb(v: number, bitsPerCell: 1 | 2 | 3): [number, number, number] {
  if (bitsPerCell === 3) {
    return [(v & 1) * 255, ((v >> 1) & 1) * 255, ((v >> 2) & 1) * 255];
  }
  if (bitsPerCell === 2) {
    return [(v & 1) * 255, ((v >> 1) & 1) * 255, (v & 1) * 255];
  }
  return [(v & 1) * 255, (v & 1) * 255, (v & 1) * 255];
}

export interface Geometry {
  profile: Profile;
  cells: number;
  /** Data cell indices, row-major (row * cells + col). */
  dataCells: Int32Array;
  dataCellCount: number;
  /** Bytes carried by the raster before error correction. */
  codedBytes: number;
  /** Bytes of frame payload after RS overhead. */
  payloadBytes: number;
  interleaver: RsInterleaver;
}

function boxesOverlap(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): boolean {
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
}

const geometryCache = new Map<number, Geometry>();

/**
 * Cell layout for a profile. Identical on both sides by construction — the
 * receiver derives it from the profile id alone, which is the only thing the
 * control strip has to carry.
 */
export function geometryFor(profile: Profile): Geometry {
  const hit = geometryCache.get(profile.id);
  if (hit) return hit;

  const n = profile.cells;
  const reserved: Array<[number, number, number, number]> = [
    [0, 0, MARKER_BOX, MARKER_BOX],
    [1 - MARKER_BOX, 0, 1, MARKER_BOX],
    [0, 1 - MARKER_BOX, MARKER_BOX, 1],
    [1 - MARKER_BOX, 1 - MARKER_BOX, 1, 1],
    [CONTROL_X0, CONTROL_Y0, CONTROL_X1, CONTROL_Y1],
    [CALIB_X0, CALIB_Y0, CALIB_X1, CALIB_Y1],
  ];

  const list: number[] = [];
  for (let row = 0; row < n; row++) {
    const y0 = row / n;
    const y1 = (row + 1) / n;
    for (let col = 0; col < n; col++) {
      const x0 = col / n;
      const x1 = (col + 1) / n;
      let blocked = false;
      for (let r = 0; r < reserved.length; r++) {
        const b = reserved[r];
        // Whole-cell overlap, not just the centre: a cell half-covered by a
        // marker decodes as noise, and excluding it costs almost nothing.
        if (boxesOverlap(x0, y0, x1, y1, b[0], b[1], b[2], b[3])) {
          blocked = true;
          break;
        }
      }
      if (!blocked) list.push(row * n + col);
    }
  }

  const dataCells = Int32Array.from(list);
  const codedBytes = Math.floor((dataCells.length * profile.bitsPerCell) / 8);
  const shardData = 255 - profile.shardParity;
  const payloadBytes = RsInterleaver.payloadForCoded(codedBytes, shardData, profile.shardParity);
  const interleaver = new RsInterleaver(payloadBytes, shardData, profile.shardParity);

  const geo: Geometry = {
    profile,
    cells: n,
    dataCells,
    dataCellCount: dataCells.length,
    codedBytes,
    payloadBytes,
    interleaver,
  };
  geometryCache.set(profile.id, geo);
  return geo;
}

/** 3-bit CRC (x^3 + x + 1) guarding the 5-bit profile id in the control strip. */
export function crc3(value: number): number {
  let r = value & 0x1f;
  for (let i = 0; i < 5; i++) {
    const msb = r & 0x10;
    r = (r << 1) & 0x1f;
    if (msb) r ^= 0x03;
  }
  return r & 0x07;
}

/**
 * Whitening constant. Without it, profile 0 encodes as an all-zero word and
 * the strip becomes a solid black bar with no light reference to threshold
 * against. XOR-ing a fixed mixed pattern guarantees both levels are present
 * in every strip.
 */
const CONTROL_WHITEN = 0x5a;

/** Control strip bits: profile id + CRC, repeated three times for a vote. */
export function controlBits(profileId: number): Uint8Array {
  const id = profileId & 0x1f;
  const word = (((id << 3) | crc3(id)) ^ CONTROL_WHITEN) & 0xff;
  const bits = new Uint8Array(CONTROL_SLOTS);
  for (let rep = 0; rep < 3; rep++) {
    for (let i = 0; i < 8; i++) bits[rep * 8 + i] = (word >> (7 - i)) & 1;
  }
  return bits;
}

/** Inverse of `controlBits`; returns null when no repetition checks out. */
export function decodeControlBits(bits: ArrayLike<number>): number | null {
  const votes = new Map<number, number>();
  for (let rep = 0; rep < 3; rep++) {
    let word = 0;
    for (let i = 0; i < 8; i++) word = (word << 1) | (bits[rep * 8 + i] & 1);
    word ^= CONTROL_WHITEN;
    const id = (word >> 3) & 0x1f;
    if (crc3(id) === (word & 0x07) && id < PROFILES.length) {
      votes.set(id, (votes.get(id) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [id, count] of votes) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
