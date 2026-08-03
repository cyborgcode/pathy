/**
 * Decode worker.
 *
 * The main thread hands over an ImageBitmap and gets back either a frame
 * payload or a reason it failed. Pixel readback happens here rather than on
 * the main thread, because `getImageData` on a 1600px frame is several
 * milliseconds and the main thread has a video element and a UI to keep
 * smooth.
 *
 * Workers are stateless and interchangeable. A busy pool simply means some
 * frames are never looked at, and the fountain does not care which ones.
 */

import { decodeFrame } from '../core/decode.js';
import type { RgbaImage } from '../core/render.js';

export interface DecodeRequest {
  id: number;
  bitmap: ImageBitmap;
  /** Longest side to decode at; larger frames are scaled down. */
  maxSide: number;
}

export interface DecodeResponse {
  id: number;
  ok: boolean;
  payload?: Uint8Array;
  profileId?: number;
  corrected?: number;
  reason?: string;
  ms: number;
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function surface(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  return ctx!;
}

self.onmessage = (ev: MessageEvent<DecodeRequest>): void => {
  const { id, bitmap, maxSide } = ev.data;
  const t0 = performance.now();

  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const c = surface(w, h);
    c.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const data = c.getImageData(0, 0, w, h);
    const img: RgbaImage = { width: w, height: h, data: data.data };
    const res = decodeFrame(img);

    const ms = performance.now() - t0;
    if (res.ok) {
      const payload = res.payload;
      const reply: DecodeResponse = {
        id, ok: true, payload, profileId: res.profile.id, corrected: res.corrected, ms,
      };
      (self as unknown as Worker).postMessage(reply, [payload.buffer]);
    } else {
      const reply: DecodeResponse = { id, ok: false, reason: res.reason, ms };
      (self as unknown as Worker).postMessage(reply);
    }
  } catch (err) {
    try {
      bitmap.close();
    } catch {
      /* already closed */
    }
    const reply: DecodeResponse = {
      id, ok: false, reason: String(err), ms: performance.now() - t0,
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
