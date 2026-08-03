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
import { whitenInPlace } from './whiten.js';
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
 * Unsharp strength, applied separately to luma and chroma.
 *
 * The camera does not degrade these equally: 4:2:0 subsampling and chroma
 * denoise smear Cb/Cr across several pixels while luma keeps most of its
 * detail. Sharpening them by the same amount either leaves chroma smeared or
 * over-amplifies luma noise, so they get separate gains.
 */
const SHARPEN_LUMA = 0.6;
const SHARPEN_CHROMA = 1.7;
/** Half-width, in cells, of the window a cell is thresholded against. */
const LOCAL_RADIUS = 10;

/**
 * Resample the data grid.
 *
 * Three things happen here, and each one is load-bearing:
 *
 *  - **Projected once, interpolated after.** Grid intersections go through
 *    the homography; cells bilinearly interpolate between them. Perspective
 *    within a single cell is negligible, so this turns four homography
 *    evaluations per cell into four multiply-adds.
 *
 *  - **Sharpening.** Optical blur mixes each cell with its neighbours, and at
 *    five or six pixels per cell that crosstalk is easily enough to flip a
 *    channel. A 3x3 unsharp mask in *cell* space — not pixel space — inverts
 *    most of it, because after resampling the blur has become a small,
 *    well-conditioned kernel.
 *
 *  - **Local thresholds.** Each cell is compared against the average of the
 *    data cells around it rather than one number for the whole frame. Glare,
 *    vignetting and white-balance drift are all slowly varying, so a local
 *    average tracks them for free. Whitening upstream is what makes the
 *    average meaningful.
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
  const cellCount = n * n;
  // Three interleaved channel planes at cell resolution.
  const planes = new Float32Array(cellCount * 3);

  // Sample tight to the cell centre: under blur, the further out the sample
  // sits the more of the neighbour's colour it collects.
  const off = [0.4, 0.6];

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const o00 = (row * (n + 1) + col) * 2;
      const o01 = o00 + 2;
      const o10 = ((row + 1) * (n + 1) + col) * 2;
      const o11 = o10 + 2;

      let r = 0, g = 0, b = 0, cnt = 0;
      for (let a = 0; a < 2; a++) {
        const v = off[a];
        for (let c = 0; c < 2; c++) {
          const u = off[c];
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
      const o = (row * n + col) * 3;
      if (cnt === 0) {
        planes[o] = cal.thr[0];
        planes[o + 1] = cal.thr[1];
        planes[o + 2] = cal.thr[2];
      } else {
        planes[o] = r / cnt;
        planes[o + 1] = g / cnt;
        planes[o + 2] = b / cnt;
      }
    }
  }

  sharpenPlanes(planes, n);

  // Threshold statistics come only from data cells; markers and the strips
  // are strongly biased and would drag the local average around.
  const mask = new Uint8Array(cellCount);
  for (let i = 0; i < dataCells.length; i++) mask[dataCells[i]] = 1;

  const thresholds = localThresholds(planes, mask, n, cal);

  const values = new Uint8Array(dataCells.length);
  for (let i = 0; i < dataCells.length; i++) {
    const idx = dataCells[i];
    const o = idx * 3;
    const t = idx * 3;
    const r = planes[o];
    const g = planes[o + 1];
    const b = planes[o + 2];
    const tr = thresholds[t];
    const tg = thresholds[t + 1];
    const tb = thresholds[t + 2];

    if (bits === 3) {
      values[i] = (r > tr ? 1 : 0) | (g > tg ? 2 : 0) | (b > tb ? 4 : 0);
    } else if (bits === 2) {
      // Blue mirrors red at this density, so bit 0 is a soft vote across both
      // channels: whichever is further from its threshold carries more weight.
      values[i] = (r - tr + (b - tb) > 0 ? 1 : 0) | (g > tg ? 2 : 0);
    } else {
      values[i] = r + g + b > tr + tg + tb ? 1 : 0;
    }
  }
  return values;
}

/** 3x3 unsharp mask in cell space, undoing inter-cell optical bleed. */
function sharpenPlanes(planes: Float32Array, n: number): void {
  const blurred = new Float32Array(planes.length);
  for (let row = 0; row < n; row++) {
    const y0 = row > 0 ? row - 1 : 0;
    const y1 = row < n - 1 ? row + 1 : n - 1;
    for (let col = 0; col < n; col++) {
      const x0 = col > 0 ? col - 1 : 0;
      const x1 = col < n - 1 ? col + 1 : n - 1;
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const o = (y * n + x) * 3;
          r += planes[o];
          g += planes[o + 1];
          b += planes[o + 2];
          cnt++;
        }
      }
      const o = (row * n + col) * 3;
      blurred[o] = r / cnt;
      blurred[o + 1] = g / cnt;
      blurred[o + 2] = b / cnt;
    }
  }
  // Sharpen in YCbCr so the two components can take different gains, then
  // convert straight back to RGB for thresholding.
  for (let i = 0; i < planes.length; i += 3) {
    const r = planes[i];
    const g = planes[i + 1];
    const b = planes[i + 2];
    const br = blurred[i];
    const bg = blurred[i + 1];
    const bb = blurred[i + 2];

    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = b - y;
    const cr = r - y;
    const by = 0.299 * br + 0.587 * bg + 0.114 * bb;
    const bcb = bb - by;
    const bcr = br - by;

    const ys = y + SHARPEN_LUMA * (y - by);
    const cbs = cb + SHARPEN_CHROMA * (cb - bcb);
    const crs = cr + SHARPEN_CHROMA * (cr - bcr);

    const rr = ys + crs;
    const bbv = ys + cbs;
    planes[i] = rr;
    planes[i + 1] = (ys - 0.299 * rr - 0.114 * bbv) / 0.587;
    planes[i + 2] = bbv;
  }
}

/**
 * Per-cell thresholds from a box average of nearby data cells, via integral
 * images so the window size costs nothing.
 */
function localThresholds(
  planes: Float32Array,
  mask: Uint8Array,
  n: number,
  cal: Calibration,
): Float32Array {
  const stride = n + 1;
  const sum = new Float64Array(stride * stride * 3);
  const cnt = new Float64Array(stride * stride);

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      const o = i * 3;
      const m = mask[i];
      const a = (row + 1) * stride + (col + 1);
      const up = row * stride + (col + 1);
      const left = (row + 1) * stride + col;
      const diag = row * stride + col;

      cnt[a] = cnt[up] + cnt[left] - cnt[diag] + m;
      for (let c = 0; c < 3; c++) {
        sum[a * 3 + c] =
          sum[up * 3 + c] + sum[left * 3 + c] - sum[diag * 3 + c] + (m ? planes[o + c] : 0);
      }
    }
  }

  const out = new Float32Array(n * n * 3);
  const R = LOCAL_RADIUS;
  for (let row = 0; row < n; row++) {
    const r0 = Math.max(0, row - R);
    const r1 = Math.min(n - 1, row + R);
    for (let col = 0; col < n; col++) {
      const c0 = Math.max(0, col - R);
      const c1 = Math.min(n - 1, col + R);

      const a = (r1 + 1) * stride + (c1 + 1);
      const b = r0 * stride + (c1 + 1);
      const c = (r1 + 1) * stride + c0;
      const d = r0 * stride + c0;

      const count = cnt[a] - cnt[b] - cnt[c] + cnt[d];
      const o = (row * n + col) * 3;
      if (count < 24) {
        // Not enough data cells nearby to average; fall back to the
        // calibration strip's global reading.
        out[o] = cal.thr[0];
        out[o + 1] = cal.thr[1];
        out[o + 2] = cal.thr[2];
        continue;
      }
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] =
          (sum[a * 3 + ch] - sum[b * 3 + ch] - sum[c * 3 + ch] + sum[d * 3 + ch]) / count;
      }
    }
  }
  return out;
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
  whitenInPlace(coded);

  const res = geo.interleaver.decode(coded);
  if (!res.ok) return { ok: false, reason: DecodeFailure.RsFailed };

  return { ok: true, profile, payload: res.payload, corrected: res.corrected };
}

export { DEFAULT_PROFILE_ID };
