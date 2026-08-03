/**
 * Transfer orchestration.
 *
 * The sender walks windows in order, emitting a generous overshoot of coded
 * frames for each, then wraps around and does it again, forever. The receiver
 * decodes whatever windows it can see, flushes each one to disk the moment it
 * completes, and picks up anything it missed on a later pass.
 *
 * That loop is what makes large files work without a back channel. A receiver
 * that joins late, loses focus for a second, or gets overtaken while the
 * sender moves on does not fail — it just catches the window next time round.
 * Nothing is ever retransmitted on request, because nothing can be.
 */

import { LtWindowEncoder, LtWindowDecoder } from './fountain.js';
import {
  type Manifest,
  type FrameHeader,
  FrameType,
  HEADER_BYTES,
  writeFrame,
  readFrame,
  encodeManifest,
  decodeManifest,
} from './frame.js';
import { type Profile, geometryFor } from './profile.js';

/** Random-access source. Files are read a window at a time, never all at once. */
export interface SourceReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class MemorySource implements SourceReader {
  constructor(private readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.subarray(offset, Math.min(this.bytes.length, offset + length));
  }
}

export const DEFAULT_WINDOW_BYTES = 2 * 1024 * 1024;
/** Windows are 16-bit in the header, so very large files need bigger windows. */
const MAX_WINDOWS = 60000;

export function chooseWindowBytes(fileSize: number, preferred = DEFAULT_WINDOW_BYTES): number {
  let w = preferred;
  while (Math.ceil(fileSize / w) > MAX_WINDOWS) w *= 2;
  return w;
}

export interface SenderOptions {
  profile: Profile;
  name: string;
  mime: string;
  /** SHA-256 of the whole file, for end-to-end verification. */
  hash: Uint8Array;
  windowBytes?: number;
  /**
   * Frames emitted per window as a multiple of K. Above 1.0 the fountain has
   * slack for frames the camera never resolves; the excess is what buys a
   * first-pass completion instead of waiting for the loop to come round.
   */
  overshoot?: number;
  /** Emit a manifest every N frames so late joiners can start. */
  manifestEvery?: number;
  sessionId?: number;
}

export interface SenderStats {
  windowIndex: number;
  windowCount: number;
  seqNo: number;
  framesThisWindow: number;
  framesPerWindow: number;
  pass: number;
}

export class SenderSession {
  readonly profile: Profile;
  readonly manifest: Manifest;
  readonly sessionId: number;
  readonly blockSize: number;
  readonly windowCount: number;
  readonly windowBytes: number;

  private readonly source: SourceReader;
  private readonly overshoot: number;
  private readonly manifestEvery: number;
  private readonly payloadBuf: Uint8Array;
  private readonly blockBuf: Uint8Array;

  private encoder: LtWindowEncoder | null = null;
  private encoderWindow = -1;
  private windowIndex = 0;
  private framesThisWindow = 0;
  private framesPerWindow = 1;
  private seqNo = 0;
  private frameCounter = 0;
  private pass = 0;

  constructor(source: SourceReader, opts: SenderOptions) {
    this.source = source;
    this.profile = opts.profile;
    this.overshoot = opts.overshoot ?? 1.35;
    this.manifestEvery = opts.manifestEvery ?? 32;
    this.sessionId = (opts.sessionId ?? (Math.random() * 0xffffffff) >>> 0) >>> 0;

    const geo = geometryFor(opts.profile);
    this.payloadBuf = new Uint8Array(geo.payloadBytes);
    this.blockSize = geo.payloadBytes - HEADER_BYTES;
    this.blockBuf = new Uint8Array(this.blockSize);

    this.windowBytes = chooseWindowBytes(source.size, opts.windowBytes ?? DEFAULT_WINDOW_BYTES);
    this.windowCount = Math.max(1, Math.ceil(source.size / this.windowBytes));

    this.manifest = {
      fileSize: source.size,
      hash: opts.hash,
      windowBytes: this.windowBytes,
      windowCount: this.windowCount,
      blockSize: this.blockSize,
      name: opts.name,
      mime: opts.mime,
    };
  }

  get stats(): SenderStats {
    return {
      windowIndex: this.windowIndex,
      windowCount: this.windowCount,
      seqNo: this.seqNo,
      framesThisWindow: this.framesThisWindow,
      framesPerWindow: this.framesPerWindow,
      pass: this.pass,
    };
  }

  /** Bytes of file payload each frame carries, before RS overhead. */
  get bytesPerFrame(): number {
    return this.blockSize;
  }

  /** Next frame, RS-coded and ready to hand to the rasteriser. */
  async nextCodedFrame(): Promise<Uint8Array> {
    return geometryFor(this.profile).interleaver.encode(await this.nextFramePayload());
  }

  /** Next frame before error-correction coding. Split out for testing. */
  async nextFramePayload(): Promise<Uint8Array> {
    if (this.manifestEvery > 0 && this.frameCounter % this.manifestEvery === 0) {
      this.frameCounter++;
      return this.buildManifestFrame();
    }
    this.frameCounter++;

    await this.ensureEncoder();
    const enc = this.encoder!;
    enc.encodeInto(this.seqNo, this.blockBuf);

    const header: FrameHeader = {
      type: FrameType.Data,
      sessionId: this.sessionId,
      seqNo: this.seqNo,
      windowIndex: this.windowIndex,
      windowCount: this.windowCount,
      blocks: enc.k,
      blockSize: this.blockSize,
    };
    writeFrame(this.payloadBuf, header, this.blockBuf);

    this.seqNo = (this.seqNo + 1) >>> 0;
    this.framesThisWindow++;
    if (this.framesThisWindow >= this.framesPerWindow) this.advanceWindow();

    return this.payloadBuf;
  }

  private buildManifestFrame(): Uint8Array {
    const body = encodeManifest(this.manifest);
    const header: FrameHeader = {
      type: FrameType.Manifest,
      sessionId: this.sessionId,
      seqNo: this.seqNo,
      windowIndex: this.windowIndex,
      windowCount: this.windowCount,
      blocks: 1,
      blockSize: this.blockSize,
    };
    writeFrame(this.payloadBuf, header, body);
    return this.payloadBuf;
  }

  private advanceWindow(): void {
    this.windowIndex++;
    this.framesThisWindow = 0;
    if (this.windowIndex >= this.windowCount) {
      this.windowIndex = 0;
      this.pass++;
    }
  }

  private async ensureEncoder(): Promise<void> {
    if (this.encoder && this.encoderWindow === this.windowIndex) return;
    const offset = this.windowIndex * this.windowBytes;
    const length = Math.min(this.windowBytes, this.source.size - offset);
    const bytes = await this.source.read(offset, Math.max(0, length));
    this.encoder = new LtWindowEncoder(bytes, this.blockSize, this.sessionId, this.windowIndex);
    this.encoderWindow = this.windowIndex;

    // LT overhead is not a fixed multiple: the ripple is proportional to
    // sqrt(K), so a small window needs proportionally more slack than a large
    // one. A relative term alone under-serves small windows badly, and they
    // are exactly the ones a big file ends up with a lot of.
    const k = this.encoder.k;
    const margin = Math.max(6, Math.ceil(Math.sqrt(k) / 2));
    this.framesPerWindow = Math.max(1, Math.ceil(k * this.overshoot) + margin);
  }
}

/** Destination for completed windows. Writes may arrive out of order. */
export interface WindowSink {
  write(offset: number, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class MemorySink implements WindowSink {
  readonly bytes: Uint8Array;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }
  async write(offset: number, data: Uint8Array): Promise<void> {
    this.bytes.set(data, offset);
  }
  async close(): Promise<void> {}
}

export interface ReceiverOptions {
  sink: WindowSink | ((size: number) => WindowSink | Promise<WindowSink>);
  /**
   * Windows held open at once. Two is the natural minimum: the sender may
   * move on while a window is still partially decoded, and abandoning it
   * would waste everything collected so far.
   */
  maxOpenWindows?: number;
}

export interface ReceiverProgress {
  manifest: Manifest | null;
  windowsDone: number;
  windowCount: number;
  /** Bytes of the file confirmed decoded and written. */
  bytesDone: number;
  complete: boolean;
  framesAccepted: number;
  framesSeen: number;
  currentWindow: number;
  currentWindowProgress: number;
}

export type IngestOutcome =
  | 'manifest'
  | 'accepted'
  | 'duplicate'
  | 'window-complete'
  | 'complete'
  | 'ignored'
  | 'awaiting-manifest';

export class ReceiverSession {
  private manifestData: Manifest | null = null;
  private sessionId: number | null = null;
  private sink: WindowSink | null = null;
  private readonly sinkFactory: ReceiverOptions['sink'];
  private readonly maxOpen: number;

  private decoders = new Map<number, LtWindowDecoder>();
  private touch = new Map<number, number>();
  private done: Uint8Array = new Uint8Array(0);
  private doneCount = 0;
  private clock = 0;
  private framesAccepted = 0;
  private framesSeen = 0;
  private lastWindow = 0;

  constructor(opts: ReceiverOptions) {
    this.sinkFactory = opts.sink;
    this.maxOpen = Math.max(2, opts.maxOpenWindows ?? 3);
  }

  get manifest(): Manifest | null {
    return this.manifestData;
  }

  get isComplete(): boolean {
    return this.manifestData !== null && this.doneCount === this.manifestData.windowCount;
  }

  get progress(): ReceiverProgress {
    const m = this.manifestData;
    const current = this.decoders.get(this.lastWindow);
    return {
      manifest: m,
      windowsDone: this.doneCount,
      windowCount: m?.windowCount ?? 0,
      bytesDone: m ? Math.min(m.fileSize, this.doneCount * m.windowBytes) : 0,
      complete: this.isComplete,
      framesAccepted: this.framesAccepted,
      framesSeen: this.framesSeen,
      currentWindow: this.lastWindow,
      currentWindowProgress: current ? current.progress : 0,
    };
  }

  /** Feed one decoded frame payload. */
  async ingest(payload: Uint8Array): Promise<IngestOutcome> {
    const parsed = readFrame(payload);
    if (!parsed) return 'ignored';
    this.framesSeen++;

    const { header, body } = parsed;

    // A new session id means the sender restarted — most likely with different
    // settings or a different file, so everything collected so far is stale.
    if (this.sessionId !== null && header.sessionId !== this.sessionId) this.reset();
    this.sessionId = header.sessionId;

    if (header.type === FrameType.Manifest) {
      if (this.manifestData) return 'duplicate';
      const m = decodeManifest(body);
      if (!m) return 'ignored';
      this.manifestData = m;
      this.done = new Uint8Array(m.windowCount);
      this.sink =
        typeof this.sinkFactory === 'function' ? await this.sinkFactory(m.fileSize) : this.sinkFactory;
      return 'manifest';
    }

    // Data frames are useless until the manifest arrives, and the manifest
    // comes round every 32 frames, so this is a short wait at worst.
    if (!this.manifestData) return 'awaiting-manifest';
    if (header.windowIndex >= this.manifestData.windowCount) return 'ignored';
    if (this.done[header.windowIndex]) return 'duplicate';

    this.lastWindow = header.windowIndex;
    const dec = this.decoderFor(header.windowIndex, header.blocks, header.blockSize);
    if (!dec) return 'ignored';

    const res = dec.addFrame(header.seqNo, body);
    if (!res.useful) return 'duplicate';
    this.framesAccepted++;

    if (res.complete) {
      await this.flushWindow(header.windowIndex, dec);
      return this.isComplete ? 'complete' : 'window-complete';
    }
    return 'accepted';
  }

  private decoderFor(index: number, blocks: number, blockSize: number): LtWindowDecoder | null {
    let dec = this.decoders.get(index);
    if (dec) {
      // Guard against a stale decoder from different sender settings.
      if (dec.k !== blocks || dec.blockSize !== blockSize) {
        this.decoders.delete(index);
        dec = undefined;
      } else {
        this.touch.set(index, ++this.clock);
        return dec;
      }
    }

    if (this.decoders.size >= this.maxOpen) {
      // Evict on least progress, not least recently used. Everything a
      // decoder holds is lost when it goes, and discarding a window that is
      // nearly solved — only to have to collect it all again next pass — is
      // the most expensive choice available. Age breaks ties.
      let victim = -1;
      let worstProgress = Infinity;
      let worstAt = Infinity;
      for (const [k, dec] of this.decoders) {
        const p = dec.progress;
        const at = this.touch.get(k) ?? 0;
        if (p < worstProgress || (p === worstProgress && at < worstAt)) {
          worstProgress = p;
          worstAt = at;
          victim = k;
        }
      }
      if (victim >= 0) {
        this.decoders.delete(victim);
        this.touch.delete(victim);
      }
    }

    dec = new LtWindowDecoder(blocks, blockSize, this.sessionId!, index);
    this.decoders.set(index, dec);
    this.touch.set(index, ++this.clock);
    return dec;
  }

  private async flushWindow(index: number, dec: LtWindowDecoder): Promise<void> {
    const m = this.manifestData!;
    const offset = index * m.windowBytes;
    const length = Math.min(m.windowBytes, m.fileSize - offset);
    if (length > 0 && this.sink) {
      await this.sink.write(offset, dec.data.subarray(0, length));
    }
    this.done[index] = 1;
    this.doneCount++;
    dec.compact();
    this.decoders.delete(index);
    this.touch.delete(index);
  }

  async close(): Promise<void> {
    if (this.sink) await this.sink.close();
  }

  private reset(): void {
    this.manifestData = null;
    this.decoders.clear();
    this.touch.clear();
    this.done = new Uint8Array(0);
    this.doneCount = 0;
    this.framesAccepted = 0;
    this.framesSeen = 0;
  }
}
