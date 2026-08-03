/**
 * Sender page.
 *
 * Reads the file a window at a time (never all of it), keeps a small queue of
 * rendered frames ahead of the display, and paints one per animation frame.
 *
 * The queue matters: producing a frame means an RS encode and a rasterise, and
 * for the first frame of a window also a disk read. Doing that inline with the
 * paint would drop frames at exactly the moment the receiver is trying to lock
 * on. Filling ahead keeps the display cadence flat.
 */

import { SenderSession, type SourceReader, chooseWindowBytes } from '../core/session.js';
import { renderFrame, type RgbaImage } from '../core/render.js';
import { PROFILES, profileById, geometryFor, DEFAULT_PROFILE_ID } from '../core/profile.js';
import { Sha256 } from '../core/sha256.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('file');
const startBtn = $<HTMLButtonElement>('start');
const stopBtn = $<HTMLButtonElement>('stop');
const fullBtn = $<HTMLButtonElement>('full');
const profileSel = $<HTMLSelectElement>('profile');
const fpsInput = $<HTMLInputElement>('fps');
const windowInput = $<HTMLInputElement>('window');
const msg = $<HTMLDivElement>('msg');
const setup = $<HTMLDivElement>('setup');
const live = $<HTMLDivElement>('live');
const stage = $<HTMLDivElement>('stage');
const canvas = $<HTMLCanvasElement>('code');

for (const p of PROFILES) {
  const opt = document.createElement('option');
  opt.value = String(p.id);
  opt.textContent = `${p.label} — ${geometryFor(p).payloadBytes} B/frame`;
  if (p.id === DEFAULT_PROFILE_ID) opt.selected = true;
  profileSel.appendChild(opt);
}

class FileSource implements SourceReader {
  constructor(private readonly file: File) {}
  get size(): number {
    return this.file.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }
}

/** Hash without ever holding the whole file, so size is not a constraint. */
async function hashFile(file: File, onProgress: (done: number) => void): Promise<Uint8Array> {
  const CHUNK = 4 * 1024 * 1024;
  const h = new Sha256();
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = await file.slice(off, Math.min(file.size, off + CHUNK)).arrayBuffer();
    h.update(new Uint8Array(buf));
    onProgress(Math.min(file.size, off + CHUNK));
    // Yield so the page stays responsive on a multi-gigabyte file.
    await new Promise((r) => setTimeout(r, 0));
  }
  return h.digest();
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

let running = false;
let session: SenderSession | null = null;
let raf = 0;

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  startBtn.disabled = !f;
  msg.className = 'msg';
  msg.textContent = f ? `${f.name} · ${fmtBytes(f.size)}` : '';
});

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', stop);
fullBtn.addEventListener('click', () => {
  stage.classList.toggle('fullscreen');
  if (stage.classList.contains('fullscreen')) void stage.requestFullscreen?.().catch(() => {});
  else void document.exitFullscreen?.().catch(() => {});
});

async function start(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) return;

  startBtn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Hashing…';

  const hash = await hashFile(file, (done) => {
    msg.textContent = `Hashing… ${Math.round((done / Math.max(1, file.size)) * 100)}%`;
  });

  const profile = profileById(Number(profileSel.value));
  const wantWindow = Math.max(1, Number(windowInput.value) || 2) * 1024 * 1024;

  session = new SenderSession(new FileSource(file), {
    profile,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    hash,
    windowBytes: chooseWindowBytes(file.size, wantWindow),
  });

  setup.hidden = true;
  live.hidden = false;
  $('s-name').textContent = `${file.name} · ${fmtBytes(file.size)}`;

  running = true;
  void runLoop(profile);
}

function stop(): void {
  running = false;
  cancelAnimationFrame(raf);
  session = null;
  setup.hidden = false;
  live.hidden = true;
  startBtn.disabled = false;
  stage.classList.remove('fullscreen');
  void document.exitFullscreen?.().catch(() => {});
}

async function runLoop(profile: ReturnType<typeof profileById>): Promise<void> {
  const ctx = canvas.getContext('2d', { alpha: false })!;

  // Render at device pixels: a cell that lands between two physical pixels is
  // a cell the camera sees as a blend of two colours.
  const dpr = window.devicePixelRatio || 1;
  const cssSide = Math.min(window.innerWidth, window.innerHeight * 0.92);
  const side = Math.max(profile.cells * 3, Math.min(2048, Math.round(cssSide * dpr)));

  canvas.width = side;
  canvas.height = side;
  canvas.style.width = `${Math.round(side / dpr)}px`;
  canvas.style.height = `${Math.round(side / dpr)}px`;

  const imageData = ctx.createImageData(side, side);
  const frameBuf: RgbaImage = { width: side, height: side, data: imageData.data };

  // Two frames deep: enough to hide a window read, not so deep that a settings
  // change takes visible effect late.
  const queue: Uint8Array[] = [];
  let filling = false;

  const fill = async (): Promise<void> => {
    if (filling || !session) return;
    filling = true;
    try {
      while (running && session && queue.length < 3) {
        queue.push(await session.nextCodedFrame());
      }
    } finally {
      filling = false;
    }
  };

  await fill();

  let last = 0;
  let shown = 0;
  let fpsAt = performance.now();
  let fpsCount = 0;

  const tick = (now: number): void => {
    if (!running || !session) return;
    raf = requestAnimationFrame(tick);

    const target = Math.max(1, Math.min(120, Number(fpsInput.value) || 30));
    const interval = 1000 / target;
    if (now - last < interval - 1) return;
    last = now;

    const coded = queue.shift();
    void fill();
    if (!coded) return;

    renderFrame(coded, profile, { size: side }, frameBuf);
    ctx.putImageData(imageData, 0, 0);

    shown++;
    fpsCount++;
    if (now - fpsAt >= 500) {
      const fps = (fpsCount * 1000) / (now - fpsAt);
      fpsAt = now;
      fpsCount = 0;

      const st = session.stats;
      $('s-fps').textContent = `${fps.toFixed(0)} fps`;
      $('s-rate').textContent = `${fmtBytes(fps * session.bytesPerFrame)}/s`;
      $('s-window').textContent = `${st.windowIndex + 1} / ${st.windowCount}`;
      $('s-pass').textContent = String(st.pass + 1);
    }
  };

  raf = requestAnimationFrame(tick);
  void shown;
}
