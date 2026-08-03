/**
 * Camera frame -> payload bytes.
 *
 * The whole path is: find four markers, solve the perspective, read the
 * control strip to learn the grid pitch, read the calibration strip to learn
 * what this screen's idea of "red" looks like through this camera, then
 * resample every cell and threshold each channel independently.
 *
 * Cost is dominated by the resample, which is a bilinear lookup per cell and
 * nothing more. That is the point: decode has to fit inside a frame interval
 * at 60 fps, or the receiver silently becomes the bottleneck and no amount of
 * density on the sender helps.
 */

import { applyHomography, solveHomography } from './homography.js';
import { detectCode } from './detect.js';
import type { RgbaImage } from './render.js';
import { packCells } from './render.js';
import {
  type Profile,
  profileById,
  geometryFor,
  decodeControlBits,
  DEFAULT_PROFILE_ID,
  MARKER_BOX,
  CONTROL_X0,
  CONTROL_X1,
  CONTROL_Y0,
  CONTROL_Y1,
  CONTROL_SLOTS,
  CALIB_X0,
  CALIB_X1,
  CALIB_Y0,
  CALIB_Y1,
  CALIB_SLOTS,
} from './profile.js';

/** Marker centres in code space, matching the render layout. */
const CODE_CORNERS = Float64Array.of(
  MARKER_BOX / 2, MARKER_BOX / 2,
  1 - MARKER_BOX / 2, MARKER_BOX / 2,
  MARKER_BOX / 2, 1 - MARKER_BOX / 2,
  1 - MARKER_BOX / 2, 1 - MARKER_BOX / 2,
);

export const enum DecodeFailure {
  NoMarkers = 'no-markers',
  Degenerate = 'degenerate-homography',
  NoControl = 'unreadable-control-strip',
  NoCalibration = 'unreadable-calibration',
  RsFailed = 'rs-unrecoverable',
}

export interface DecodeSuccess {
  ok: true;
  profile: Profile;
  payload: Uint8Array;
  /** Byte errors repaired by RS; a useful proxy for link quality. */
  corrected: number;
}

export interface DecodeFailureResult {
  ok: false;
  reason: DecodeFailure;
}

export type DecodeResult = DecodeSuccess | DecodeFailureResult;

const tmp = new Float64Array(2);

/** Average colour over a normalised rectangle, sampled through `h`. */
function sampleRect(
  img: RgbaImage,
  h: Float64Array,
  x0: number, y0: number, x1: number, y1: number,
  steps = 3,
): [number, number, number] {
  const { width, height, data } = img;
  // Inset so the sample never straddles the region's own edge.
  const ix0 = x0 + (x1 - x0) * 0.25;
  const ix1 = x1 - (x1 - x0) * 0.25;
  const iy0 = y0 + (y1 - y0) * 0.25;
  const iy1 = y1 - (y1 - y0) * 0.25;

  let r = 0, g = 0, b = 0, n = 0;
  for (let sy = 0; sy < steps; sy++) {
    const ty = steps === 1 ? 0.5 : sy / (steps - 1);
    for (let sx = 0; sx < steps; sx++) {
      const tx = steps === 1 ? 0.5 : sx / (steps - 1);
      applyHomography(h, ix0 + (ix1 - ix0) * tx, iy0 + (iy1 - iy0) * ty, tmp);
      const px = Math.round(tmp[0]);
      const py = Math.round(tmp[1]);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const p = (py * width + px) * 4;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      n++;
    }
  }
  if (n === 0) return [0, 0, 0];
  return [r / n, g / n, b / n];
}

interface Calibration {
  thr: [number, number, number];
  /** Channel separation; low values mean the colour link is marginal. */
  margin: [number, number, number];
  lumaThreshold: number;
}

function readCalibration(img: RgbaImage, h: Float64Array): Calibration | null {
  const lo: [number, number, number] = [0, 0, 0];
  const hi: [number, number, number] = [0, 0, 0];
  const loN: [number, number, number] = [0, 0, 0];
  const hiN: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < CALIB_SLOTS; i++) {
    const t0 = CALIB_X0 + ((CALIB_X1 - CALIB_X0) * i) / CALIB_SLOTS;
    const t1 = CALIB_X0 + ((CALIB_X1 - CALIB_X0) * (i + 1)) / CALIB_SLOTS;
    const rgb = sampleRect(img, h, t0, CALIB_Y0, t1, CALIB_Y1);
    for (let c = 0; c < 3; c++) {
      // Patch i has channel c set iff bit c of i is set.
      if ((i >> c) & 1) {
        hi[c] += rgb[c];
        hiN[c]++;
      } else {
        lo[c] += rgb[c];
        loN[c]++;
      }
    }
  }

  const thr: [number, number, number] = [128, 128, 128];
  const margin: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    if (!loN[c] || !hiN[c]) return null;
    const l = lo[c] / loN[c];
    const hgh = hi[c] / hiN[c];
    margin[c] = hgh - l;
    // Too little separation means glare or a blown exposure has flattened the
    // channel; fall back to the neutral point rather than trusting it.
    thr[c] = margin[c] > 12 ? (l + hgh) / 2 : 128;
  }

  const black = sampleRect(img, h, CALIB_X0, CALIB_Y0, CALIB_X0 + (CALIB_X1 - CALIB_X0) / CALIB_SLOTS, CALIB_Y1);
  const white = sampleRect(
    img, h,
    CALIB_X1 - (CALIB_X1 - CALIB_X0) / CALIB_SLOTS, CALIB_Y0, CALIB_X1, CALIB_Y1,
  );
  const blackLuma = (black[0] + black[1] + black[2]) / 3;
  const whiteLuma = (white[0] + white[1] + white[2]) / 3;
  const lumaThreshold = whiteLuma - blackLuma > 20 ? (blackLuma + whiteLuma) / 2 : 128;

  return { thr, margin, lumaThreshold };
}

function readProfileId(img: RgbaImage, h: Float64Array, lumaThreshold: number): number | null {
  const bits = new Uint8Array(CONTROL_SLOTS);
  for (let i = 0; i < CONTROL_SLOTS; i++) {
    const t0 = CONTROL_X0 + ((CONTROL_X1 - CONTROL_X0) * i) / CONTROL_SLOTS;
    const t1 = CONTROL_X0 + ((CONTROL_X1 - CONTROL_X0) * (i + 1)) / CONTROL_SLOTS;
    const rgb = sampleRect(img, h, t0, CONTROL_Y0, t1, CONTROL_Y1);
    const luma = (rgb[0] + rgb[1] + rgb[2]) / 3;
    bits[i] = luma > lumaThreshold ? 1 : 0;
  }
  return decodeControlBits(bits);
}

/**
 * Resample the data grid.
 *
 * Grid intersections are projected once and cells interpolate between them:
 * perspective within a single cell is negligible, and this turns four
 * homography evaluations per cell into four multiply-adds.
 */
function readCells(
  img: RgbaImage,
  h: Float64Array,
  n: number,
  dataCells: Int32Array,
  bits: 1 | 2 | 3,
  cal: Calibration,
): Uint8Array {
  const grid = new Float32Array((n + 1) * (n + 1) * 2);
  for (let row = 0; row <= n; row++) {
    for (let col = 0; col <= n; col++) {
      applyHomography(h, col / n, row / n, tmp);
      const o = (row * (n + 1) + col) * 2;
      grid[o] = tmp[0];
      grid[o + 1] = tmp[1];
    }
  }

  const { width, height, data } = img;
  const values = new Uint8Array(dataCells.length);
  const [tr, tg, tb] = cal.thr;

  // Four samples in the cell interior, away from the edges where a
  // neighbouring colour bleeds in through the camera's chroma filtering.
  const offsets = [0.3, 0.7];

  for (let i = 0; i < dataCells.length; i++) {
    const idx = dataCells[i];
    const row = (idx / n) | 0;
    const col = idx - row * n;

    const o00 = (row * (n + 1) + col) * 2;
    const o01 = o00 + 2;
    const o10 = ((row + 1) * (n + 1) + col) * 2;
    const o11 = o10 + 2;

    let r = 0, g = 0, b = 0, cnt = 0;
    for (let a = 0; a < 2; a++) {
      const v = offsets[a];
      for (let c = 0; c < 2; c++) {
        const u = offsets[c];
        const w00 = (1 - u) * (1 - v);
        const w01 = u * (1 - v);
        const w10 = (1 - u) * v;
        const w11 = u * v;
        const x = (grid[o00] * w00 + grid[o01] * w01 + grid[o10] * w10 + grid[o11] * w11) | 0;
        const y = (grid[o00 + 1] * w00 + grid[o01 + 1] * w01 + grid[o10 + 1] * w10 + grid[o11 + 1] * w11) | 0;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const p = (y * width + x) * 4;
        r += data[p];
        g += data[p + 1];
        b += data[p + 2];
        cnt++;
      }
    }
    if (cnt === 0) {
      values[i] = 0;
      continue;
    }
    r /= cnt; g /= cnt; b /= cnt;

    if (bits === 3) {
      values[i] = (r > tr ? 1 : 0) | (g > tg ? 2 : 0) | (b > tb ? 4 : 0);
    } else if (bits === 2) {
      // Blue mirrors red at this density, so bit 0 is a soft vote across both
      // channels: whichever is further from its threshold carries more weight.
      values[i] = (r - tr + (b - tb) > 0 ? 1 : 0) | (g > tg ? 2 : 0);
    } else {
      values[i] = (r + g + b) / 3 > cal.lumaThreshold ? 1 : 0;
    }
  }
  return values;
}

export interface DecodeOptions {
  /** Assume this profile instead of reading the control strip. */
  forceProfile?: Profile;
}

export function decodeFrame(img: RgbaImage, opts: DecodeOptions = {}): DecodeResult {
  const found = detectCode(img);
  if (!found) return { ok: false, reason: DecodeFailure.NoMarkers };

  const h = solveHomography(CODE_CORNERS, found.corners);
  if (!h) return { ok: false, reason: DecodeFailure.Degenerate };

  const cal = readCalibration(img, h);
  if (!cal) return { ok: false, reason: DecodeFailure.NoCalibration };

  let profile = opts.forceProfile;
  if (!profile) {
    const id = readProfileId(img, h, cal.lumaThreshold);
    if (id === null) return { ok: false, reason: DecodeFailure.NoControl };
    profile = profileById(id);
  }

  const geo = geometryFor(profile);
  const values = readCells(img, h, geo.cells, geo.dataCells, profile.bitsPerCell, cal);
  const coded = packCells(values, profile.bitsPerCell, geo.interleaver.codedBytes);

  const res = geo.interleaver.decode(coded);
  if (!res.ok) return { ok: false, reason: DecodeFailure.RsFailed };

  return { ok: true, profile, payload: res.payload, corrected: res.corrected };
}

export { DEFAULT_PROFILE_ID };
