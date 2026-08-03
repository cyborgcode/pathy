/**
 * Wire format.
 *
 * Every frame is fully self-describing. There is no handshake and no back
 * channel, so a receiver that points its camera at a stream already in flight
 * must be able to interpret the very first frame it happens to catch. The
 * header carries everything needed for that: which session, which window, how
 * that window is cut into blocks, and where the frame sits in the sequence.
 *
 * Restarting the sender mints a new session id, which the receiver notices and
 * uses to reset itself. That is the whole of the "protocol".
 */

export const FRAME_MAGIC = 0xa7;
export const FRAME_VERSION = 1;
export const HEADER_BYTES = 22;

export const enum FrameType {
  Data = 0,
  Manifest = 1,
}

export interface FrameHeader {
  type: FrameType;
  sessionId: number;
  seqNo: number;
  windowIndex: number;
  windowCount: number;
  /** Blocks in this window (K). */
  blocks: number;
  blockSize: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Write header + body into `out`, which must be the full RS payload buffer.
 * The CRC spans the header and the body, so an RS mis-decode that happens to
 * land on a valid codeword still gets caught before it can poison a block.
 */
export function writeFrame(out: Uint8Array, header: FrameHeader, body: Uint8Array): void {
  if (out.length < HEADER_BYTES + body.length) throw new RangeError('frame buffer too small');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = FRAME_MAGIC;
  out[1] = ((FRAME_VERSION & 0x0f) << 4) | (header.type & 0x0f);
  dv.setUint32(2, header.sessionId >>> 0, true);
  dv.setUint32(6, header.seqNo >>> 0, true);
  dv.setUint16(10, header.windowIndex, true);
  dv.setUint16(12, header.windowCount, true);
  dv.setUint16(14, header.blocks, true);
  dv.setUint16(16, header.blockSize, true);
  dv.setUint16(18, body.length, true);

  out.set(body, HEADER_BYTES);
  // Any slack beyond the body is zeroed so the CRC is reproducible.
  out.fill(0, HEADER_BYTES + body.length);

  const crc = crc32(out.subarray(0, 20)) ^ crc32(out.subarray(HEADER_BYTES));
  dv.setUint16(20, crc & 0xffff, true);
}

export interface ParsedFrame {
  header: FrameHeader;
  body: Uint8Array;
}

/** Returns null for anything that is not a valid, intact frame. */
export function readFrame(payload: Uint8Array): ParsedFrame | null {
  if (payload.length < HEADER_BYTES) return null;
  if (payload[0] !== FRAME_MAGIC) return null;
  if ((payload[1] >>> 4) !== FRAME_VERSION) return null;

  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const bodyLen = dv.getUint16(18, true);
  if (HEADER_BYTES + bodyLen > payload.length) return null;

  const stored = dv.getUint16(20, true);
  const check = (crc32(payload.subarray(0, 20)) ^ crc32(payload.subarray(HEADER_BYTES))) & 0xffff;
  if (stored !== check) return null;

  const type = (payload[1] & 0x0f) as FrameType;
  if (type !== FrameType.Data && type !== FrameType.Manifest) return null;

  const header: FrameHeader = {
    type,
    sessionId: dv.getUint32(2, true),
    seqNo: dv.getUint32(6, true),
    windowIndex: dv.getUint16(10, true),
    windowCount: dv.getUint16(12, true),
    blocks: dv.getUint16(14, true),
    blockSize: dv.getUint16(16, true),
  };
  if (header.blocks === 0 || header.blockSize === 0) return null;

  return { header, body: payload.subarray(HEADER_BYTES, HEADER_BYTES + bodyLen) };
}

export interface Manifest {
  fileSize: number;
  /** SHA-256 of the original file bytes. */
  hash: Uint8Array;
  windowBytes: number;
  windowCount: number;
  blockSize: number;
  name: string;
  mime: string;
}

export function encodeManifest(m: Manifest): Uint8Array {
  const enc = new TextEncoder();
  const name = enc.encode(m.name);
  const mime = enc.encode(m.mime);
  const out = new Uint8Array(52 + name.length + mime.length);
  const dv = new DataView(out.buffer);

  out[0] = 1; // manifest version
  out[1] = 0; // flags, reserved
  dv.setBigUint64(2, BigInt(m.fileSize), true);
  out.set(m.hash, 10);
  dv.setUint32(42, m.windowBytes, true);
  dv.setUint16(46, m.windowCount, true);
  dv.setUint16(48, m.blockSize, true);
  dv.setUint8(50, Math.min(255, name.length));
  dv.setUint8(51, Math.min(255, mime.length));
  out.set(name.subarray(0, 255), 52);
  out.set(mime.subarray(0, 255), 52 + Math.min(255, name.length));
  return out;
}

export function decodeManifest(body: Uint8Array): Manifest | null {
  if (body.length < 52 || body[0] !== 1) return null;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const nameLen = dv.getUint8(50);
  const mimeLen = dv.getUint8(51);
  if (body.length < 52 + nameLen + mimeLen) return null;

  const dec = new TextDecoder();
  const fileSize = Number(dv.getBigUint64(2, true));
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) return null;

  return {
    fileSize,
    hash: body.slice(10, 42),
    windowBytes: dv.getUint32(42, true),
    windowCount: dv.getUint16(46, true),
    blockSize: dv.getUint16(48, true),
    name: dec.decode(body.subarray(52, 52 + nameLen)),
    mime: dec.decode(body.subarray(52 + nameLen, 52 + nameLen + mimeLen)),
  };
}
