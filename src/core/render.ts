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
import { whitenInPlace } from './whiten.js';

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

// Pixels are written as packed 32-bit words rather than four byte stores.
// The sender has to produce a frame every display interval; at 60 Hz and a
// million-odd pixels a frame, the difference is most of the budget.
const LITTLE_ENDIAN = (() => {
  const probe = new Uint32Array(1);
  new Uint8Array(probe.buffer)[0] = 1;
  return probe[0] === 1;
})();

function packRgba(r: number, g: number, b: number): number {
  return (
    LITTLE_ENDIAN
      ? ((255 << 24) | (b << 16) | (g << 8) | r)
      : ((r << 24) | (g << 16) | (b << 8) | 255)
  ) >>> 0;
}

const WHITE = packRgba(255, 255, 255);

function fillRect32(
  px: Uint32Array,
  width: number, height: number,
  x0: number, y0: number, x1: number, y1: number,
  colour: number,
): void {
  const xa = Math.max(0, x0);
  const xb = Math.min(width, x1);
  const ya = Math.max(0, y0);
  const yb = Math.min(height, y1);
  for (let y = ya; y < yb; y++) {
    px.fill(colour, y * width + xa, y * width + xb);
  }
}

let whiteBuf = new Uint8Array(0);

/** Whiten into a reusable buffer; at 60 fps a per-frame copy is not free. */
function whitenScratch(coded: Uint8Array): Uint8Array {
  if (whiteBuf.length < coded.length) whiteBuf = new Uint8Array(coded.length);
  const view = whiteBuf.subarray(0, coded.length);
  view.set(coded);
  whitenInPlace(view);
  return view;
}

function drawMarker(
  px: Uint32Array, w: number, h: number,
  ox: number, oy: number, box: number,
): void {
  // 9 units: white surround, then the 1:1:3:1:1 finder that the detector's
  // run-length scan locks onto.
  const u = box / MARKER_UNITS;
  const at = (k: number): number => Math.round(k * u);
  const BLACK = packRgba(0, 0, 0);
  fillRect32(px, w, h, ox, oy, ox + box, oy + box, WHITE);
  fillRect32(px, w, h, ox + at(1), oy + at(1), ox + at(8), oy + at(8), BLACK);
  fillRect32(px, w, h, ox + at(2), oy + at(2), ox + at(7), oy + at(7), WHITE);
  fillRect32(px, w, h, ox + at(3), oy + at(3), ox + at(6), oy + at(6), BLACK);
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

  const pixels = new Uint32Array(img.data.buffer, img.data.byteOffset, size * size);

  // Quiet zone plus a white code background; every reserved region paints
  // over it, and data cells cover the rest.
  pixels.fill(WHITE);

  const px = (t: number): number => margin + Math.round(t * code);

  // Cell edges precomputed once: rounding per cell inside the hot loop is
  // measurable at this cell count.
  const edge = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) edge[i] = margin + Math.round((i * code) / n);

  // Palette lookup, so the inner loop is a single indexed store.
  const bits = profile.bitsPerCell;
  const palette = new Uint32Array(8);
  for (let v = 0; v < 8; v++) {
    const [r, g, b] = cellRgb(v, bits);
    palette[v] = packRgba(r, g, b);
  }

  // Data cells. Whitening keeps the cell distribution balanced whatever the
  // file contains, which is what the receiver's local thresholds rely on.
  const cellsList = geo.dataCells;
  const white = whitenScratch(coded);
  for (let i = 0; i < cellsList.length; i++) {
    const idx = cellsList[i];
    const row = (idx / n) | 0;
    const col = idx - row * n;
    const colour = palette[readCellValue(white, i, bits)];
    const x0 = edge[col];
    const x1 = edge[col + 1];
    for (let y = edge[row], y1 = edge[row + 1]; y < y1; y++) {
      pixels.fill(colour, y * size + x0, y * size + x1);
    }
  }

  // Corner markers.
  const box = Math.round(MARKER_BOX * code);
  drawMarker(pixels, size, size, px(0), px(0), box);
  drawMarker(pixels, size, size, px(1 - MARKER_BOX), px(0), box);
  drawMarker(pixels, size, size, px(0), px(1 - MARKER_BOX), box);
  drawMarker(pixels, size, size, px(1 - MARKER_BOX), px(1 - MARKER_BOX), box);

  // Control strip: the profile id, in plain black and white so it survives
  // conditions that the colour grid would not.
  const cbits = controlBits(profile.id);
  const cy0 = px(CONTROL_Y0);
  const cy1 = px(CONTROL_Y1);
  for (let i = 0; i < CONTROL_SLOTS; i++) {
    const t0 = CONTROL_X0 + ((CONTROL_X1 - CONTROL_X0) * i) / CONTROL_SLOTS;
    const t1 = CONTROL_X0 + ((CONTROL_X1 - CONTROL_X0) * (i + 1)) / CONTROL_SLOTS;
    fillRect32(pixels, size, size, px(t0), cy0, px(t1), cy1, cbits[i] ? WHITE : packRgba(0, 0, 0));
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
    fillRect32(pixels, size, size, px(t0), gy0, px(t1), gy1, packRgba(r, g, b));
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
