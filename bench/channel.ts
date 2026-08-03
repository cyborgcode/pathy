/**
 * Screen-to-camera channel simulation.
 *
 * Every claim about throughput on this kind of link is really a claim about
 * how much abuse the frames survive, so the abuse needs to be modelled rather
 * than assumed away. This applies, in the order the physics does:
 *
 *   geometry (the camera is never square-on) -> optical blur (defocus, hand
 *   tremor, rolling shutter) -> chroma subsampling (the camera pipeline
 *   throws away colour resolution long before you see the frame) -> display
 *   and sensor response (gamma, white balance) -> glare -> sensor noise.
 *
 * Chroma subsampling is the one that matters most here and the one that is
 * easiest to forget: a colour code that ignores it looks great in a unit test
 * and falls apart on a phone.
 */

import { Rng } from '../src/core/rng.js';
import { solveHomography, applyHomography } from '../src/core/homography.js';
import { createImage, type RgbaImage } from '../src/core/render.js';

export interface ChannelOptions {
  outWidth: number;
  outHeight: number;
  /** Destination quad for the screen, as [x,y] * 4 (TL, TR, BL, BR). */
  quad: Float64Array;
  /** Optical blur radius in output pixels. */
  blur: number;
  /**
   * Chroma-only box radius, emulating 4:2:0 subsampling plus the ISP's chroma
   * denoise. Radius 1 is a 3px kernel, which is about what plain 4:2:0 costs;
   * higher values stand in for aggressive noise reduction.
   */
  chromaBlur: number;
  /** Display + sensor gamma. 1.0 is linear. */
  gamma: number;
  /** Per-channel gain, i.e. white balance error. */
  gain: [number, number, number];
  /** Uniform sensor noise amplitude, 0-255. */
  noise: number;
  /** Peak brightness added by a glare blob, 0-255. 0 disables. */
  glare: number;
  /** Ambient level of the area around the screen. */
  background: number;
  seed: number;
}

export interface ChannelPreset extends Omit<ChannelOptions, 'outWidth' | 'outHeight' | 'quad' | 'seed'> {
  name: string;
  /** How much of the frame width the screen occupies. */
  fill: number;
  /** Perspective skew, as a fraction of the screen size. */
  skew: number;
  /** Probability the camera resolves nothing usable at all. */
  frameLoss: number;
}

/**
 * Conditions from "propped on a book" to "held badly in a bright room".
 * The tripod case is the honest ceiling; handheld is what people actually do.
 */
export const PRESETS: readonly ChannelPreset[] = [
  {
    name: 'tripod',
    fill: 0.94, skew: 0.006, blur: 0.8, chromaBlur: 1, gamma: 1.05,
    gain: [1.02, 1.0, 0.97], noise: 3, glare: 0, background: 40, frameLoss: 0.02,
  },
  {
    name: 'handheld',
    fill: 0.86, skew: 0.035, blur: 1.6, chromaBlur: 2, gamma: 1.15,
    gain: [1.06, 1.0, 0.92], noise: 7, glare: 30, background: 55, frameLoss: 0.08,
  },
  {
    name: 'rough',
    fill: 0.74, skew: 0.075, blur: 2.6, chromaBlur: 3, gamma: 1.3,
    gain: [1.12, 1.0, 0.85], noise: 13, glare: 70, background: 70, frameLoss: 0.18,
  },
];

export function quadFor(
  preset: ChannelPreset,
  outWidth: number,
  outHeight: number,
  rng: Rng,
): Float64Array {
  const side = Math.min(outWidth, outHeight) * preset.fill;
  const cx = outWidth / 2;
  const cy = outHeight / 2;
  const h = side / 2;
  const jitter = (): number => (rng.nextU32() / 0xffffffff - 0.5) * 2 * preset.skew * side;

  return Float64Array.of(
    cx - h + jitter(), cy - h + jitter(),
    cx + h + jitter(), cy - h + jitter(),
    cx - h + jitter(), cy + h + jitter(),
    cx + h + jitter(), cy + h + jitter(),
  );
}

/**
 * Box blur. Three passes approximate a gaussian, which is the right shape for
 * optical defocus and hand tremor. Chroma subsampling is a genuine box
 * average, though, so that path uses a single pass — modelling it as a
 * gaussian of the same radius would roughly double the kernel width and
 * overstate the penalty on any colour code.
 */
function boxBlur(
  buf: Float32Array, width: number, height: number, radius: number,
  channels = 3, passes = 3,
): void {
  if (radius < 0.5) return;
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(buf.length);

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal.
    for (let y = 0; y < height; y++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        const row = y * width;
        for (let x = -r; x <= r; x++) {
          const xx = Math.min(width - 1, Math.max(0, x));
          acc += buf[(row + xx) * 4 + c];
        }
        const norm = 1 / (2 * r + 1);
        for (let x = 0; x < width; x++) {
          tmp[(row + x) * 4 + c] = acc * norm;
          const outX = Math.min(width - 1, Math.max(0, x - r));
          const inX = Math.min(width - 1, Math.max(0, x + r + 1));
          acc += buf[(row + inX) * 4 + c] - buf[(row + outX) * 4 + c];
        }
      }
    }
    // Vertical.
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) {
          const yy = Math.min(height - 1, Math.max(0, y));
          acc += tmp[(yy * width + x) * 4 + c];
        }
        const norm = 1 / (2 * r + 1);
        for (let y = 0; y < height; y++) {
          buf[(y * width + x) * 4 + c] = acc * norm;
          const outY = Math.min(height - 1, Math.max(0, y - r));
          const inY = Math.min(height - 1, Math.max(0, y + r + 1));
          acc += tmp[(inY * width + x) * 4 + c] - tmp[(outY * width + x) * 4 + c];
        }
      }
    }
  }
}

/** Push a frame through the channel and return what the camera would see. */
export function simulateCapture(src: RgbaImage, opts: ChannelOptions, out?: RgbaImage): RgbaImage {
  const { outWidth: W, outHeight: H } = opts;
  const img = out && out.width === W && out.height === H ? out : createImage(W, H);
  const rng = new Rng(opts.seed);

  // Map output pixels back into the rendered frame.
  const srcQuad = Float64Array.of(0, 0, src.width, 0, 0, src.height, src.width, src.height);
  const inv = solveHomography(opts.quad, srcQuad);
  if (!inv) throw new Error('degenerate channel quad');

  const buf = new Float32Array(W * H * 4);
  const p = new Float64Array(2);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      applyHomography(inv, x + 0.5, y + 0.5, p);
      const sx = p[0];
      const sy = p[1];

      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) {
        buf[o] = opts.background;
        buf[o + 1] = opts.background;
        buf[o + 2] = opts.background;
        continue;
      }

      // Bilinear: the camera does not sample screen pixels on a grid.
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * src.width + x0) * 4;
      const i01 = i00 + 4;
      const i10 = i00 + src.width * 4;
      const i11 = i10 + 4;
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      const d = src.data;
      buf[o] = d[i00] * w00 + d[i01] * w01 + d[i10] * w10 + d[i11] * w11;
      buf[o + 1] = d[i00 + 1] * w00 + d[i01 + 1] * w01 + d[i10 + 1] * w10 + d[i11 + 1] * w11;
      buf[o + 2] = d[i00 + 2] * w00 + d[i01 + 2] * w01 + d[i10 + 2] * w10 + d[i11 + 2] * w11;
    }
  }

  boxBlur(buf, W, H, opts.blur);

  // Chroma subsampling: blur Cb/Cr well past luma, exactly as a 4:2:0
  // pipeline does. This is the dominant penalty on a colour code.
  if (opts.chromaBlur > 0.5) {
    const chroma = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      const r = buf[o];
      const g = buf[o + 1];
      const b = buf[o + 2];
      const yv = 0.299 * r + 0.587 * g + 0.114 * b;
      chroma[o] = yv;
      chroma[o + 1] = b - yv;
      chroma[o + 2] = r - yv;
    }
    // Blur only the two chroma planes.
    const planes = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      planes[i * 4] = chroma[i * 4 + 1];
      planes[i * 4 + 1] = chroma[i * 4 + 2];
    }
    boxBlur(planes, W, H, opts.chromaBlur, 2, 1);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      const yv = chroma[o];
      const cb = planes[o];
      const cr = planes[o + 1];
      buf[o] = yv + cr;
      buf[o + 2] = yv + cb;
      buf[o + 1] = (yv - 0.299 * (yv + cr) - 0.114 * (yv + cb)) / 0.587;
    }
  }

  const gx = opts.quad[0] + (opts.quad[6] - opts.quad[0]) * 0.32;
  const gy = opts.quad[1] + (opts.quad[7] - opts.quad[1]) * 0.22;
  const gr = Math.min(W, H) * 0.18;
  const invGamma = 1 / opts.gamma;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;

      let r = buf[o] * opts.gain[0];
      let g = buf[o + 1] * opts.gain[1];
      let b = buf[o + 2] * opts.gain[2];

      if (opts.gamma !== 1) {
        r = 255 * Math.pow(Math.max(0, r) / 255, invGamma);
        g = 255 * Math.pow(Math.max(0, g) / 255, invGamma);
        b = 255 * Math.pow(Math.max(0, b) / 255, invGamma);
      }

      if (opts.glare > 0) {
        const dx = x - gx;
        const dy = y - gy;
        const d2 = (dx * dx + dy * dy) / (gr * gr);
        if (d2 < 4) {
          const add = opts.glare * Math.exp(-d2);
          r += add;
          g += add;
          b += add;
        }
      }

      if (opts.noise > 0) {
        const n = opts.noise;
        r += (rng.nextU32() / 0xffffffff - 0.5) * 2 * n;
        g += (rng.nextU32() / 0xffffffff - 0.5) * 2 * n;
        b += (rng.nextU32() / 0xffffffff - 0.5) * 2 * n;
      }

      img.data[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      img.data[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      img.data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      img.data[o + 3] = 255;
    }
  }

  return img;
}

export function channelOptions(
  preset: ChannelPreset,
  outWidth: number,
  outHeight: number,
  seed: number,
): ChannelOptions {
  const rng = new Rng(seed);
  return {
    outWidth,
    outHeight,
    quad: quadFor(preset, outWidth, outHeight, rng),
    blur: preset.blur,
    chromaBlur: preset.chromaBlur,
    gamma: preset.gamma,
    gain: preset.gain,
    noise: preset.noise,
    glare: preset.glare,
    background: preset.background,
    seed: seed ^ 0x5bf03635,
  };
}
