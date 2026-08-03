/**
 * Full browser loop, run headlessly.
 *
 * The sender renders real frames to a canvas. Those are composited into a
 * "scene" canvas rotated and inset, so the frame the receiver sees is not
 * axis-aligned and does not fill the view — the detector has to actually find
 * the markers and solve a perspective rather than assume one. The scene is
 * captured with `captureStream`, which produces a genuine MediaStream, and
 * from there the real receiver pipeline runs: video element, ImageBitmap,
 * decode workers, fountain, sink.
 *
 * Everything is exercised except the optics themselves, which the channel
 * benchmark covers separately. A pass means bytes went in one side as pixels
 * and came out the other bit-exact.
 */

import { SenderSession, ReceiverSession, MemorySource, MemorySink } from '../../src/core/session.js';
import { renderFrame, type RgbaImage } from '../../src/core/render.js';
import { profileById } from '../../src/core/profile.js';
import { Rng } from '../../src/core/rng.js';
import { sha256, bytesEqual, toHex } from '../../src/core/sha256.js';
import type { DecodeResponse } from '../../src/receiver/decode-worker.js';

declare global {
  interface Window {
    __result?: { ok: boolean; detail: string };
  }
}

const log = document.getElementById('log')!;
const lines: string[] = [];
const say = (s: string): void => {
  lines.push(s);
  log.textContent = lines.join('\n');
};

function finish(ok: boolean, detail: string): void {
  say((ok ? 'PASS ' : 'FAIL ') + detail);
  window.__result = { ok, detail };
}

async function main(): Promise<void> {
  say('main() entered');
  const FILE_SIZE = 220 * 1024;
  const PROFILE = profileById(2);
  const CODE_SIZE = 1100;
  const SCENE = 1280;
  const FPS = 20;

  const rng = new Rng(0xc0ffee);
  const file = new Uint8Array(FILE_SIZE);
  for (let i = 0; i < file.length; i++) file[i] = rng.nextBelow(256);
  const hash = sha256(file);

  const sender = new SenderSession(new MemorySource(file), {
    profile: PROFILE,
    name: 'loop.bin',
    mime: 'application/octet-stream',
    hash,
    windowBytes: 128 * 1024,
    sessionId: 0x5eed,
  });

  // Sender canvas.
  const code = document.createElement('canvas');
  code.width = CODE_SIZE;
  code.height = CODE_SIZE;
  const codeCtx = code.getContext('2d', { alpha: false })!;
  const imageData = codeCtx.createImageData(CODE_SIZE, CODE_SIZE);
  const frameBuf: RgbaImage = { width: CODE_SIZE, height: CODE_SIZE, data: imageData.data };

  // Scene canvas: what the "camera" sees.
  const scene = document.createElement('canvas');
  scene.width = SCENE;
  scene.height = SCENE;
  const sceneCtx = scene.getContext('2d', { alpha: false })!;

  // Paint once before capturing. A captureStream taken from a canvas that has
  // never been drawn to produces no frames, and `video.play()` on a stream
  // with no frames never resolves.
  sceneCtx.fillStyle = '#2b2b2b';
  sceneCtx.fillRect(0, 0, SCENE, SCENE);

  const stream = scene.captureStream(FPS);
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  // Not awaited: play() can stay pending indefinitely on a live stream, and
  // the pump already waits for videoWidth before touching a frame.
  void video.play().catch((e) => say(`play(): ${String(e)}`));
  say('capture stream started');

  const sink = new MemorySink(FILE_SIZE);
  const receiver = new ReceiverSession({ sink });

  const WORKERS = 3;
  const workers: Worker[] = [];
  const busy: boolean[] = [];
  let done = false;
  let seen = 0;
  let ok = 0;

  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(new URL('../../src/receiver/decode-worker.ts', import.meta.url), {
      type: 'module',
    });
    const idx = i;
    w.onmessage = async (ev: MessageEvent<DecodeResponse>): Promise<void> => {
      busy[idx] = false;
      const res = ev.data;
      if (done) return;
      if (!res.ok || !res.payload) return;
      ok++;
      const outcome = await receiver.ingest(res.payload);
      if (outcome === 'complete') {
        done = true;
        const good = bytesEqual(sha256(sink.bytes), hash);
        finish(
          good,
          `${FILE_SIZE} bytes recovered · ${ok}/${seen} frames decoded · sha256 ${toHex(sha256(sink.bytes)).slice(0, 16)}`,
        );
      }
    };
    workers.push(w);
    busy.push(false);
  }

  // Sender loop.
  let angle = 0;
  const paint = async (): Promise<void> => {
    if (done) return;
    const coded = await sender.nextCodedFrame();
    renderFrame(coded, PROFILE, { size: CODE_SIZE }, frameBuf);
    codeCtx.putImageData(imageData, 0, 0);

    // Compose the scene: dark surround, slight rotation, not filling the view.
    sceneCtx.fillStyle = '#2b2b2b';
    sceneCtx.fillRect(0, 0, SCENE, SCENE);
    sceneCtx.save();
    sceneCtx.translate(SCENE / 2, SCENE / 2);
    sceneCtx.rotate(angle);
    const draw = SCENE * 0.86;
    sceneCtx.drawImage(code, -draw / 2, -draw / 2, draw, draw);
    sceneCtx.restore();
    // Drift the angle so no single lucky alignment carries the test.
    angle = Math.sin(performance.now() / 3000) * 0.035;
  };

  const timer = setInterval(() => void paint(), 1000 / FPS);

  // Receiver pump.
  const pump = async (): Promise<void> => {
    if (done) {
      clearInterval(timer);
      for (const w of workers) w.terminate();
      return;
    }
    const free = busy.indexOf(false);
    if (free >= 0 && video.videoWidth > 0) {
      seen++;
      try {
        const bitmap = await createImageBitmap(video);
        busy[free] = true;
        workers[free].postMessage({ id: seen, bitmap, maxSide: SCENE }, [bitmap]);
      } catch {
        /* frame not ready */
      }
    }
    requestAnimationFrame(() => void pump());
  };
  requestAnimationFrame(() => void pump());

  setTimeout(() => {
    if (!done) {
      done = true;
      clearInterval(timer);
      const p = receiver.progress;
      finish(
        false,
        `timed out · ${ok}/${seen} frames decoded · windows ${p.windowsDone}/${p.windowCount}`,
      );
    }
  }, 90000);

  const status = setInterval(() => {
    if (done) {
      clearInterval(status);
      return;
    }
    const p = receiver.progress;
    say(`frames ${ok}/${seen} · windows ${p.windowsDone}/${p.windowCount} · window ${Math.round(p.currentWindowProgress * 100)}%`);
    // Keep the log short but never drop the first few setup lines.
    if (lines.length > 8) lines.splice(4, lines.length - 8);
  }, 1000);
}

main().catch((err) => finish(false, `threw: ${String(err)}`));
