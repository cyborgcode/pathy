/**
 * Receiver page.
 *
 * Pulls frames from the camera at display cadence, farms them out to a pool of
 * decode workers, and feeds whatever comes back into the fountain.
 *
 * The pool is deliberately allowed to drop frames. When every worker is busy
 * the incoming frame is discarded rather than queued: a queued frame is a
 * frame decoded late, and with a rateless code a fresh frame is always worth
 * more than a stale one. This is the same reason there is no retransmission
 * anywhere in the design.
 */

import { ReceiverSession, type WindowSink, MemorySink } from '../core/session.js';
import { Sha256, bytesEqual, toHex } from '../core/sha256.js';
import type { DecodeResponse } from './decode-worker.js';
import { registerServiceWorker, ScreenWakeLock } from '../ui/pwa.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const startBtn = $<HTMLButtonElement>('start');
const stopBtn = $<HTMLButtonElement>('stop');
const saveBtn = $<HTMLButtonElement>('save');
const toDisk = $<HTMLInputElement>('todisk');
const resSel = $<HTMLSelectElement>('res');
const workersInput = $<HTMLInputElement>('workers');
const video = $<HTMLVideoElement>('video');
const msg = $<HTMLDivElement>('msg');
const rmsg = $<HTMLDivElement>('r-msg');
const actions = $<HTMLDivElement>('r-actions');
const bar = $<HTMLElement>('r-bar');

/**
 * `requestVideoFrameCallback` is the right hook — it fires once per decoded
 * video frame rather than once per display repaint — but it is not universal,
 * so it is probed rather than assumed.
 */
type VideoFrameCapableElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
};

let stream: MediaStream | null = null;
let workers: Worker[] = [];
let busy: boolean[] = [];
let session: ReceiverSession | null = null;
let running = false;
/**
 * Bumped on every stop. requestVideoFrameCallback callbacks outlive the
 * MediaStream that produced them, so without a generation check a stop and
 * restart leaves the old loop running against a dead stream.
 */
let generation = 0;
let nextId = 1;

let memorySink: MemorySink | null = null;
let diskHandle: FileSystemFileHandle | null = null;
let receivedName = 'received.bin';
let receivedMime = 'application/octet-stream';

const wakeLock = new ScreenWakeLock();

registerServiceWorker();

let framesSeen = 0;
let framesOk = 0;
let bytesAt = 0;
let statsAt = 0;
/** Counters since the last stats tick, for instantaneous rates. */
let seenSinceTick = 0;
let okSinceTick = 0;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', () => void stop());
saveBtn.addEventListener('click', () => void save());

async function makeSink(size: number): Promise<WindowSink> {
  if (diskHandle) {
    // keepExistingData so out-of-order window writes land at the right offset
    // without truncating what is already there.
    const writable = await diskHandle.createWritable({ keepExistingData: true });
    return {
      async write(offset: number, bytes: Uint8Array): Promise<void> {
        // A positioned write, so a window that completes out of order still
        // lands at its correct offset in the file.
        await writable.write({
          type: 'write',
          position: offset,
          data: bytes,
        } as unknown as FileSystemWriteChunkType);
      },
      async close(): Promise<void> {
        await writable.close();
      },
    };
  }
  memorySink = new MemorySink(size);
  return memorySink;
}

async function start(): Promise<void> {
  startBtn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Requesting camera…';

  // The save picker needs a user gesture, and the manifest that carries the
  // real filename has not arrived yet — so ask now with a placeholder name.
  if (toDisk.checked) {
    const picker = (window as unknown as {
      showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;
    if (!picker) {
      msg.className = 'msg bad';
      msg.textContent = 'This browser has no File System Access API; falling back to memory.';
      toDisk.checked = false;
    } else {
      try {
        diskHandle = await picker({ suggestedName: 'photon-received.bin' });
      } catch {
        startBtn.disabled = false;
        msg.textContent = 'Save cancelled.';
        return;
      }
    }
  }

  const want = Number(resSel.value) || 1600;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: want },
        height: { ideal: want },
        // iOS Safari reports 60 for {ideal:60} and then delivers 30. Asking
        // exactly, and falling back when it throws, is the only way to know.
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = `Camera unavailable: ${String(err)}`;
    startBtn.disabled = false;
    return;
  }

  video.srcObject = stream;
  await video.play();

  const count = Math.max(1, Math.min(16, Number(workersInput.value) || 4));
  workers = [];
  busy = [];
  for (let i = 0; i < count; i++) {
    const w = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
    const index = i;
    w.onmessage = (ev: MessageEvent<DecodeResponse>) => void onDecoded(index, ev.data);
    workers.push(w);
    busy.push(false);
  }

  session = new ReceiverSession({ sink: (size) => makeSink(size) });
  framesSeen = 0;
  framesOk = 0;
  bytesAt = 0;
  statsAt = performance.now();
  actions.hidden = true;
  rmsg.className = 'msg';
  rmsg.textContent = 'Looking for a stream…';

  running = true;
  generation++;
  // The receiver is held still and untouched while filming, which is exactly
  // when the screen would otherwise dim and then lock.
  void wakeLock.acquire();
  stopBtn.disabled = false;
  msg.textContent = `Camera running at ${video.videoWidth}x${video.videoHeight}.`;

  pump(generation);
}

async function stop(): Promise<void> {
  running = false;
  generation++;
  void wakeLock.release();
  stopBtn.disabled = true;
  startBtn.disabled = false;

  for (const w of workers) w.terminate();
  workers = [];
  busy = [];

  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;

  if (session) await session.close();
}

/** Feed frames to whichever worker is free; drop the rest. */
function pump(gen: number): void {
  const el = video as VideoFrameCapableElement;
  const maxSide = Number(resSel.value) || 1600;

  const step = async (): Promise<void> => {
    if (!running || gen !== generation) return;

    const free = busy.indexOf(false);
    if (free >= 0 && video.videoWidth > 0) {
      framesSeen++;
      seenSinceTick++;
      try {
        const bitmap = await createImageBitmap(video);
        if (!running || gen !== generation) {
          bitmap.close();
        } else {
          busy[free] = true;
          workers[free].postMessage({ id: nextId++, bitmap, maxSide }, [bitmap]);
        }
      } catch {
        /* frame not ready; skip it */
      }
    }

    if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(() => void step());
    else requestAnimationFrame(() => void step());
  };

  if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(() => void step());
  else requestAnimationFrame(() => void step());
}

async function onDecoded(index: number, res: DecodeResponse): Promise<void> {
  if (index < busy.length) busy[index] = false;
  if (!running || !session) return;

  if (!res.ok || !res.payload) {
    updateStats();
    return;
  }

  framesOk++;
  okSinceTick++;
  const outcome = await session.ingest(res.payload);

  if (outcome === 'manifest') {
    const m = session.manifest!;
    receivedName = m.name || 'received.bin';
    receivedMime = m.mime || 'application/octet-stream';
    $('r-name').textContent = `${receivedName} · ${fmtBytes(m.fileSize)}`;
    rmsg.className = 'msg';
    rmsg.textContent = `Receiving across ${m.windowCount} window${m.windowCount === 1 ? '' : 's'}.`;
  }

  if (outcome === 'complete') await finish();
  updateStats();
}

function updateStats(): void {
  const now = performance.now();
  if (now - statsAt < 400 || !session) return;

  const p = session.progress;
  const dt = (now - statsAt) / 1000;
  const rate = (p.bytesDone - bytesAt) / dt;
  const decodedPerSec = okSinceTick / dt;
  const hit = seenSinceTick ? Math.min(1, okSinceTick / seenSinceTick) : 0;

  statsAt = now;
  bytesAt = p.bytesDone;
  seenSinceTick = 0;
  okSinceTick = 0;

  $('r-done').textContent = p.manifest
    ? `${fmtBytes(p.bytesDone)} / ${fmtBytes(p.manifest.fileSize)}`
    : '—';
  // Window-granular byte progress makes the instantaneous rate lumpy, so show
  // the frame rate too — it moves smoothly and says the same thing about aim.
  $('r-rate').textContent = rate > 0 ? `${fmtBytes(rate)}/s` : '—';
  $('r-fps').textContent = `${decodedPerSec.toFixed(0)}`;
  $('r-hit').textContent = `${Math.round(hit * 100)}%`;

  if (p.manifest) {
    const frac = p.windowCount ? p.windowsDone / p.windowCount : 0;
    bar.style.width = `${Math.round(frac * 100)}%`;
  }
}

async function finish(): Promise<void> {
  running = false;
  generation++;
  void wakeLock.release();
  for (const w of workers) w.terminate();
  workers = [];
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  stopBtn.disabled = true;
  startBtn.disabled = false;

  const m = session!.manifest!;
  await session!.close();
  bar.style.width = '100%';

  // Verify against the hash the sender put in the manifest. Read it back off
  // disk when streaming, so what is checked is what actually landed.
  let bytes: Uint8Array | null = null;
  if (memorySink) {
    bytes = memorySink.bytes;
  } else if (diskHandle) {
    const file = await diskHandle.getFile();
    bytes = new Uint8Array(await file.arrayBuffer());
  }

  if (!bytes) {
    rmsg.className = 'msg good';
    rmsg.textContent = 'Transfer complete.';
    return;
  }

  const digest = new Sha256().update(bytes).digest();
  if (bytesEqual(digest, m.hash)) {
    rmsg.className = 'msg good';
    rmsg.textContent = `Complete and verified — SHA-256 ${toHex(digest).slice(0, 16)}…`;
    if (memorySink) actions.hidden = false;
  } else {
    rmsg.className = 'msg bad';
    rmsg.textContent = 'Transfer finished but the hash does not match. Something is wrong.';
    if (memorySink) actions.hidden = false;
  }
}

function save(): void {
  if (!memorySink) return;
  const blob = new Blob([memorySink.bytes as BlobPart], { type: receivedMime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = receivedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
