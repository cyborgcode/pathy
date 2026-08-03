/**
 * Four-point projective transform.
 *
 * Four corner markers give a full homography, which recovers the code square
 * from any angle the camera happens to be held at. QR's three finders plus
 * scattered alignment patterns approximate the same correction piecewise;
 * solving it exactly is both cheaper and more accurate, and it is what lets
 * cells stay readable down to a few pixels across.
 */

export type Matrix3 = Float64Array;

/**
 * Homography mapping the four `src` points onto the four `dst` points.
 * Points are [x0,y0, x1,y1, x2,y2, x3,y3]. Returns null if degenerate.
 */
export function solveHomography(src: ArrayLike<number>, dst: ArrayLike<number>): Matrix3 | null {
  // 8x9 augmented system for h0..h7, with h8 fixed at 1.
  const a = new Float64Array(8 * 9);
  for (let i = 0; i < 4; i++) {
    const x = src[i * 2];
    const y = src[i * 2 + 1];
    const u = dst[i * 2];
    const v = dst[i * 2 + 1];

    const r0 = i * 2 * 9;
    a[r0 + 0] = x; a[r0 + 1] = y; a[r0 + 2] = 1;
    a[r0 + 6] = -x * u; a[r0 + 7] = -y * u; a[r0 + 8] = u;

    const r1 = (i * 2 + 1) * 9;
    a[r1 + 3] = x; a[r1 + 4] = y; a[r1 + 5] = 1;
    a[r1 + 6] = -x * v; a[r1 + 7] = -y * v; a[r1 + 8] = v;
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    let best = Math.abs(a[col * 9 + col]);
    for (let r = col + 1; r < 8; r++) {
      const m = Math.abs(a[r * 9 + col]);
      if (m > best) {
        best = m;
        pivot = r;
      }
    }
    if (best < 1e-12) return null;

    if (pivot !== col) {
      for (let k = col; k < 9; k++) {
        const t = a[col * 9 + k];
        a[col * 9 + k] = a[pivot * 9 + k];
        a[pivot * 9 + k] = t;
      }
    }

    const inv = 1 / a[col * 9 + col];
    for (let k = col; k < 9; k++) a[col * 9 + k] *= inv;

    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r * 9 + col];
      if (f === 0) continue;
      for (let k = col; k < 9; k++) a[r * 9 + k] -= f * a[col * 9 + k];
    }
  }

  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = a[i * 9 + 8];
  h[8] = 1;
  return h;
}

/** Apply `h` to (x, y), writing the result into `out`. */
export function applyHomography(h: Matrix3, x: number, y: number, out: Float64Array): void {
  const w = h[6] * x + h[7] * y + h[8];
  const iw = w === 0 ? 0 : 1 / w;
  out[0] = (h[0] * x + h[1] * y + h[2]) * iw;
  out[1] = (h[3] * x + h[4] * y + h[5]) * iw;
}
