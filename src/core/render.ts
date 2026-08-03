/**
 * Frame rasteriser.
 *
 * Writes RGBA pixels directly rather than issuing canvas draw calls. That
 * keeps the encoder free of DOM dependencies (so it is testable and
 * benchmarkable under Node), and more importantly it guarantees hard cell
 * edges: any antialiasing on a cell boundary is a colour the decoder has to
 * throw away.
 */

import {
  type Profile,
  type Geometry,
  geometryFor,
  cellRgb,
  controlBits,
  MARKER_BOX,
  MARKER_UNITS,
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

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export interface RenderOptions {
  /** Overall image side in pixels, quiet zone included. */
  size: number;
  /** Quiet zone in pixels. Needed for the marker run-length scan to close. */
  margin?: number;
}

/** Read `bits` bits for cell `index` out of the packed coded stream. */
function readCellValue(coded: Uint8Array, index: number, bits: number): number {
  const start = index * bits;
  let byte = start >>> 3;
  let off = start & 7;
  let v = 0;
  for (let i = 0; i < bits; i++) {
    v |= ((coded[byte] >> off) & 1) << i;
    if (++off === 8) {
      off = 0;
      byte++;
    }
  }
  return v;
}

function fillRect(
  img: RgbaImage,
  x0: number, y0: number, x1: number, y1: number,
  r: number, g: number, b: number,
): void {
  const { width, height, data } = img;
  const xa = Math.max(0, x0);
  const xb = Math.min(width, x1);
  const ya = Math.max(0, y0);
  const yb = Math.min(height, y1);
  for (let y = ya; y < yb; y++) {
    let p = (y * width + xa) * 4;
    for (let x = xa; x < xb; x++) {
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
      p += 4;
    }
  }
}

function drawMarker(img: RgbaImage, ox: number, oy: number, box: number): void {
  // 9 units: white surround, then the 1:1:3:1:1 finder that the detector's
  // run-length scan locks onto.
  const u = box / MARKER_UNITS;
  const at = (k: number) => Math.round(k * u);
  fillRect(img, ox, oy, ox + box, oy + box, 255, 255, 255);
  fillRect(img, ox + at(1), oy + at(1), ox + at(8), oy + at(8), 0, 0, 0);
  fillRect(img, ox + at(2), oy + at(2), ox + at(7), oy + at(7), 255, 255, 255);
  fillRect(img, ox + at(3), oy + at(3), ox + at(6), oy + at(6), 0, 0, 0);
}

/**
 * Render one frame. Pass `out` to reuse a buffer — at 60 fps the allocation
 * churn of a fresh multi-megabyte image every frame is itself a bottleneck.
 */
export function renderFrame(
  coded: Uint8Array,
  profile: Profile,
  opts: RenderOptions,
  out?: RgbaImage,
): RgbaImage {
  const size = opts.size;
  const margin = opts.margin ?? Math.max(8, Math.round(size * 0.03));
  const img = out && out.width === size && out.height === size ? out : createImage(size, size);

  const geo: Geometry = geometryFor(profile);
  const n = geo.cells;
  const code = size - margin * 2;
  if (code <= n) throw new RangeError('render size too small for this profile');

  // Quiet zone plus a white code background; every reserved region paints
  // over it, and data cells cover the rest.
  fillRect(img, 0, 0, size, size, 255, 255, 255);

  const px = (t: number) => margin + Math.round(t * code);

  // Data cells.
  const cellsList = geo.dataCells;
  const bits = profile.bitsPerCell;
  for (let i = 0; i < cellsList.length; i++) {
    const idx = cellsList[i];
    const row = (idx / n) | 0;
    const col = idx - row * n;
    const v = readCellValue(coded, i, bits);
    const [r, g, b] = cellRgb(v, bits);
    fillRect(
      img,
      margin + Math.round((col * code) / n),
      margin + Math.round((row * code) / n),
      margin + Math.round(((col + 1) * code) / n),
      margin + Math.round(((row + 1) * code) / n),
      r, g, b,
    );
  }

  // Corner markers.
  const box = Math.round(MARKER_BOX * code);
  drawMarker(img, px(0), px(0), box);
  drawMarker(img, px(1 - MARKER_BOX), px(0), box);
  drawMarker(img, px(0), px(1 - MARKER_BOX), box);
  drawMarker(img, px(1 - MARKER_BOX), px(1 - MARKER_BOX), box);

  // Control strip: the profile id, in plain black and white so it survives
  // conditions that the colour grid would not.
  const cbits = controlBits(profile.id);
  const cy0 = px(CONTROL_Y0);
  const cy1 = px(CONTROL_Y1);
  fillRect(img, px(CONTROL_X0), cy0, px(CONTROL_X1), cy1, 255, 255, 255);
  for (let i = 0; i < CONTROL_SLOTS; i++) {
    const t0 = CONTROL_X0 + ((CONTROL_X1 - CONTROL_X0) * i) / CONTROL_SLOTS;
    const t1 = CONTROL_X0 + ((CONTROL_X1 - CONTROL_X0) * (i + 1)) / CONTROL_SLOTS;
    const v = cbits[i] ? 255 : 0;
    fillRect(img, px(t0), cy0, px(t1), cy1, v, v, v);
  }

  // Calibration strip: all eight palette colours, so the receiver can solve
  // for this screen's white balance and this camera's gamma every frame
  // instead of assuming either.
  const gy0 = px(CALIB_Y0);
  const gy1 = px(CALIB_Y1);
  for (let i = 0; i < CALIB_SLOTS; i++) {
    const t0 = CALIB_X0 + ((CALIB_X1 - CALIB_X0) * i) / CALIB_SLOTS;
    const t1 = CALIB_X0 + ((CALIB_X1 - CALIB_X0) * (i + 1)) / CALIB_SLOTS;
    const [r, g, b] = cellRgb(i, 3);
    fillRect(img, px(t0), gy0, px(t1), gy1, r, g, b);
  }

  return img;
}

/** Pack a coded byte stream from cell values (used by tests and the decoder). */
export function packCells(values: ArrayLike<number>, bits: number, byteLen: number): Uint8Array {
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < values.length; i++) {
    const start = i * bits;
    let byte = start >>> 3;
    let off = start & 7;
    const v = values[i];
    for (let k = 0; k < bits; k++) {
      if (byte >= byteLen) return out;
      if ((v >> k) & 1) out[byte] |= 1 << off;
      if (++off === 8) {
        off = 0;
        byte++;
      }
    }
  }
  return out;
}
