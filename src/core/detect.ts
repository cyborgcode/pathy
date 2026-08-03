/**
 * Corner marker detection.
 *
 * The markers use the classic 1:1:3:1:1 concentric-square signature, found by
 * run-length scanning rows and confirming vertically. It is a well-proven
 * shape for exactly this problem — distinctive against arbitrary content,
 * cheap to test, and scale invariant — so there is little reason to invent
 * something new for the one part of the pipeline that everything else depends
 * on.
 *
 * What is different from a QR reader is that we look for *four* of them. The
 * fourth corner is what upgrades the perspective recovery from an
 * approximation to an exact solve.
 */

import type { RgbaImage } from './render.js';

export interface Marker {
  x: number;
  y: number;
  moduleSize: number;
  votes: number;
}

export interface DetectResult {
  /** Ordered TL, TR, BL, BR. */
  corners: Float64Array;
  markers: Marker[];
}

export function toGray(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Integer luma; the exact coefficients matter far less than consistency.
    out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return out;
}

const BLOCK = 8;
const MIN_DYNAMIC_RANGE = 24;

/**
 * Block-adaptive binarisation (the ZXing hybrid scheme).
 *
 * A global threshold fails on a filmed screen: glare, vignetting and uneven
 * backlight all shift the local mean out from under it. Each 8x8 block gets
 * its own black point from its own average, and blocks with no internal
 * contrast — the inside of a marker's core, or blank quiet zone — inherit
 * from their already-computed neighbours instead of guessing.
 *
 * That inheritance step is load-bearing. Deciding a flat block is background
 * on its own turns the solid centre of every marker light, and then nothing
 * downstream can find a thing.
 */
export function binarize(gray: Uint8Array, width: number, height: number): Uint8Array {
  const bw = Math.max(1, width >> 3);
  const bh = Math.max(1, height >> 3);
  const bp = new Int32Array(bw * bh);

  for (let by = 0; by < bh; by++) {
    let yoff = by * BLOCK;
    if (yoff > height - BLOCK) yoff = height - BLOCK;
    for (let bx = 0; bx < bw; bx++) {
      let xoff = bx * BLOCK;
      if (xoff > width - BLOCK) xoff = width - BLOCK;

      let sum = 0;
      let mn = 255;
      let mx = 0;
      for (let yy = 0; yy < BLOCK; yy++) {
        let p = (yoff + yy) * width + xoff;
        for (let xx = 0; xx < BLOCK; xx++, p++) {
          const v = gray[p];
          sum += v;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }

      let average: number;
      if (mx - mn > MIN_DYNAMIC_RANGE) {
        average = sum >> 6;
      } else {
        // Flat block. Default to "all light", but if it is darker than what
        // surrounds it, adopt the neighbourhood's black point so that solid
        // dark regions stay dark.
        average = mn >> 1;
        if (by > 0 && bx > 0) {
          const neighbour =
            (bp[(by - 1) * bw + bx] + 2 * bp[by * bw + bx - 1] + bp[(by - 1) * bw + bx - 1]) >> 2;
          if (mn < neighbour) average = neighbour;
        }
      }
      bp[by * bw + bx] = average;
    }
  }

  const out = new Uint8Array(width * height);
  for (let by = 0; by < bh; by++) {
    let yoff = by * BLOCK;
    if (yoff > height - BLOCK) yoff = height - BLOCK;
    const top = Math.min(Math.max(by, 2), bh - 3 < 2 ? 2 : bh - 3);
    for (let bx = 0; bx < bw; bx++) {
      let xoff = bx * BLOCK;
      if (xoff > width - BLOCK) xoff = width - BLOCK;
      const left = Math.min(Math.max(bx, 2), bw - 3 < 2 ? 2 : bw - 3);

      // Smooth over a 5x5 block window so the threshold varies gently rather
      // than stepping at block boundaries.
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = top + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = left + dx;
          if (xx < 0 || xx >= bw) continue;
          sum += bp[yy * bw + xx];
          n++;
        }
      }
      const threshold = n ? sum / n : 128;

      for (let yy = 0; yy < BLOCK; yy++) {
        let p = (yoff + yy) * width + xoff;
        for (let xx = 0; xx < BLOCK; xx++, p++) {
          out[p] = gray[p] <= threshold ? 1 : 0;
        }
      }
    }
  }
  return out;
}

/** Does a five-run sequence match 1:1:3:1:1 closely enough? */
function matchesFinder(c0: number, c1: number, c2: number, c3: number, c4: number): number {
  const total = c0 + c1 + c2 + c3 + c4;
  if (total < 14) return 0; // too small to be anything but noise
  const mod = total / 7;
  const tol = mod * 0.6;
  if (Math.abs(mod - c0) > tol) return 0;
  if (Math.abs(mod - c1) > tol) return 0;
  if (Math.abs(3 * mod - c2) > 3 * tol) return 0;
  if (Math.abs(mod - c3) > tol) return 0;
  if (Math.abs(mod - c4) > tol) return 0;
  return mod;
}

/** Confirm a row candidate by finding the same signature down the column. */
function verticalCheck(
  bin: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  moduleSize: number,
): number {
  if (bin[cy * width + cx] !== 1) return -1;
  const counts = [0, 0, 0, 0, 0];
  const maxRun = Math.ceil(moduleSize * 6);

  let y = cy;
  while (y >= 0 && bin[y * width + cx] === 1 && counts[2] <= maxRun) { counts[2]++; y--; }
  if (y < 0) return -1;
  while (y >= 0 && bin[y * width + cx] === 0 && counts[1] <= maxRun) { counts[1]++; y--; }
  if (y < 0 || counts[1] === 0) return -1;
  while (y >= 0 && bin[y * width + cx] === 1 && counts[0] <= maxRun) { counts[0]++; y--; }
  if (counts[0] === 0) return -1;

  y = cy + 1;
  while (y < height && bin[y * width + cx] === 1 && counts[2] <= maxRun * 2) { counts[2]++; y++; }
  if (y >= height) return -1;
  while (y < height && bin[y * width + cx] === 0 && counts[3] <= maxRun) { counts[3]++; y++; }
  if (y >= height || counts[3] === 0) return -1;
  while (y < height && bin[y * width + cx] === 1 && counts[4] <= maxRun) { counts[4]++; y++; }
  if (counts[4] === 0) return -1;

  if (!matchesFinder(counts[0], counts[1], counts[2], counts[3], counts[4])) return -1;
  // Centre of the middle run.
  return y - counts[4] - counts[3] - counts[2] / 2;
}

/**
 * Scan for marker candidates and cluster them. Rows are stepped rather than
 * scanned exhaustively — a marker spans many rows, so every candidate gets
 * found several times over regardless.
 */
export function findMarkers(bin: Uint8Array, width: number, height: number): Marker[] {
  const clusters: Marker[] = [];
  const rowStep = Math.max(1, Math.floor(height / 400));

  const addCandidate = (x: number, y: number, mod: number): void => {
    for (const c of clusters) {
      if (Math.abs(c.x - x) < c.moduleSize * 2 && Math.abs(c.y - y) < c.moduleSize * 2) {
        c.x = (c.x * c.votes + x) / (c.votes + 1);
        c.y = (c.y * c.votes + y) / (c.votes + 1);
        c.moduleSize = (c.moduleSize * c.votes + mod) / (c.votes + 1);
        c.votes++;
        return;
      }
    }
    clusters.push({ x, y, moduleSize: mod, votes: 1 });
  };

  const counts = [0, 0, 0, 0, 0];
  for (let y = 0; y < height; y += rowStep) {
    counts.fill(0);
    let state = 0; // index into counts; even = dark run, odd = light run
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const dark = bin[row + x] === 1;
      const wantDark = (state & 1) === 0;
      if (dark === wantDark) {
        counts[state]++;
        continue;
      }
      if (state < 4) {
        state++;
        counts[state] = 1;
        continue;
      }
      // Five runs complete and the sixth has started: test, then slide the
      // window by two so an adjacent pattern is not missed.
      const mod = matchesFinder(counts[0], counts[1], counts[2], counts[3], counts[4]);
      if (mod > 0) {
        const centerX = Math.round(x - counts[4] - counts[3] - counts[2] / 2);
        if (centerX >= 0 && centerX < width) {
          const cy = verticalCheck(bin, width, height, centerX, y, mod);
          if (cy >= 0) addCandidate(centerX, cy, mod);
        }
      }
      counts[0] = counts[2];
      counts[1] = counts[3];
      counts[2] = counts[4];
      counts[3] = 1;
      counts[4] = 0;
      state = 3;
    }
  }

  return clusters.filter((c) => c.votes >= 2).sort((a, b) => b.votes - a.votes);
}

/**
 * Pick four markers and label them TL / TR / BL / BR.
 *
 * Sums and differences of the coordinates identify the corners under any
 * rotation up to about 45 degrees, which is well past what anyone holds a
 * phone at.
 */
export function orderCorners(markers: Marker[]): Float64Array | null {
  if (markers.length < 4) return null;
  const best = markers.slice(0, 8);

  // Of the strongest candidates, take the four that enclose the largest area:
  // spurious matches inside the data region cluster near real ones, and the
  // true corners are always the extreme set.
  let chosen: Marker[] | null = null;
  let bestArea = 0;
  for (let a = 0; a < best.length; a++) {
    for (let b = a + 1; b < best.length; b++) {
      for (let c = b + 1; c < best.length; c++) {
        for (let d = c + 1; d < best.length; d++) {
          const quad = [best[a], best[b], best[c], best[d]];
          const area = hullArea(quad);
          if (area > bestArea) {
            bestArea = area;
            chosen = quad;
          }
        }
      }
    }
  }
  if (!chosen) return null;

  let tl = chosen[0], tr = chosen[0], bl = chosen[0], br = chosen[0];
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const m of chosen) {
    const s = m.x + m.y;
    const d = m.x - m.y;
    if (s < minSum) { minSum = s; tl = m; }
    if (s > maxSum) { maxSum = s; br = m; }
    if (d > maxDiff) { maxDiff = d; tr = m; }
    if (d < minDiff) { minDiff = d; bl = m; }
  }

  const distinct = new Set([tl, tr, bl, br]);
  if (distinct.size !== 4) return null;

  return Float64Array.of(tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y);
}

function hullArea(q: Marker[]): number {
  // Shoelace over the convex order, obtained by sorting around the centroid.
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const sorted = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = sorted[i];
    const n = sorted[(i + 1) % 4];
    area += p.x * n.y - n.x * p.y;
  }
  return Math.abs(area) / 2;
}

/** Full detection pass: binarise, find markers, order them. */
export function detectCode(img: RgbaImage): DetectResult | null {
  const gray = toGray(img);
  const bin = binarize(gray, img.width, img.height);
  const markers = findMarkers(bin, img.width, img.height);
  const corners = orderCorners(markers);
  if (!corners) return null;
  return { corners, markers };
}
