/**
 * Generates the PWA icons.
 *
 * The icon is a miniature of the thing the app actually puts on screen: four
 * corner markers around a grid of the eight palette colours. It is drawn here
 * rather than hand-authored so it stays in step with the palette, and encoded
 * with a small inline PNG writer so the build needs no image dependency.
 *
 * Run: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [0x0a, 0x0b, 0x0d];
const WHITE = [0xff, 0xff, 0xff];
const BLACK = [0x00, 0x00, 0x00];

/** The eight cell colours: one bit per channel, same as the codec. */
const PALETTE = [];
for (let v = 0; v < 8; v++) {
  PALETTE.push([(v & 1) * 255, ((v >> 1) & 1) * 255, ((v >> 2) & 1) * 255]);
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

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Minimal PNG: 8-bit truecolour, one IDAT, filter type 0 per scanline. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function canvas(size) {
  const px = new Uint8Array(size * size * 3);
  const rect = (x0, y0, x1, y1, [r, g, b]) => {
    const xa = Math.max(0, Math.round(x0));
    const xb = Math.min(size, Math.round(x1));
    const ya = Math.max(0, Math.round(y0));
    const yb = Math.min(size, Math.round(y1));
    for (let y = ya; y < yb; y++) {
      let p = (y * size + xa) * 3;
      for (let x = xa; x < xb; x++) {
        px[p] = r;
        px[p + 1] = g;
        px[p + 2] = b;
        p += 3;
      }
    }
  };
  return { px, rect };
}

/**
 * @param size    output edge in pixels
 * @param inset   fraction of the edge kept clear of content; maskable icons
 *                get cropped to a circle on some launchers, so the artwork has
 *                to stay inside a safe zone.
 */
function drawIcon(size, inset) {
  const { px, rect } = canvas(size);
  rect(0, 0, size, size, BG);

  const pad = size * inset;
  const box = size - pad * 2;
  const n = 8;
  const cell = box / n;
  const at = (i) => pad + i * cell;

  // Colour field. A fixed pattern rather than random, so the icon is stable
  // across regenerations.
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const v = (row * 3 + col * 5 + ((row * col) % 3)) % 8;
      rect(at(col), at(row), at(col + 1), at(row + 1), PALETTE[v]);
    }
  }

  // Four corner markers, the same concentric shape the decoder looks for.
  const marker = (cx, cy) => {
    const u = cell * 0.75;
    rect(cx - u * 1.5, cy - u * 1.5, cx + u * 1.5, cy + u * 1.5, WHITE);
    rect(cx - u * 1.25, cy - u * 1.25, cx + u * 1.25, cy + u * 1.25, BLACK);
    rect(cx - u * 0.85, cy - u * 0.85, cx + u * 0.85, cy + u * 0.85, WHITE);
    rect(cx - u * 0.45, cy - u * 0.45, cx + u * 0.45, cy + u * 0.45, BLACK);
  };
  const lo = pad + cell * 1.2;
  const hi = pad + box - cell * 1.2;
  marker(lo, lo);
  marker(hi, lo);
  marker(lo, hi);
  marker(hi, hi);

  return encodePng(size, size, px);
}

mkdirSync(OUT, { recursive: true });

const files = [
  // Maskable: 12.5% safe zone so a circular mask does not clip the markers.
  ['icon-192.png', 192, 0.125],
  ['icon-512.png', 512, 0.125],
  // iOS applies its own rounding and never masks aggressively, so this one
  // can sit closer to the edge.
  ['apple-touch-icon.png', 180, 0.07],
];

for (const [name, size, inset] of files) {
  const png = drawIcon(size, inset);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(26)} ${size}x${size}  ${png.length} bytes`);
}

/*
 * Android launcher icons, from the same drawing so the app icon and the web
 * icon never drift apart.
 *
 * Adaptive icons are 108dp with only the middle 72dp guaranteed visible — the
 * launcher is free to mask the rest to a circle, squircle or whatever the
 * device prefers. The foreground layer therefore gets a much deeper inset
 * than the legacy square icon, or the corner markers get shaved off.
 */
const ANDROID_RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'android', 'app', 'src', 'main', 'res');

const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

if (existsSync(ANDROID_RES)) {
  for (const [density, scale] of DENSITIES) {
    const dir = join(ANDROID_RES, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });

    // Legacy launcher icon: 48dp base.
    const legacy = drawIcon(Math.round(48 * scale), 0.06);
    writeFileSync(join(dir, 'ic_launcher.png'), legacy);
    writeFileSync(join(dir, 'ic_launcher_round.png'), legacy);

    // Adaptive foreground: 108dp base, artwork kept inside the 72dp safe zone.
    const fg = drawIcon(Math.round(108 * scale), 0.26);
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), fg);

    console.log(`mipmap-${density}`.padEnd(26) + `${Math.round(48 * scale)}px legacy · ${Math.round(108 * scale)}px foreground`);
  }
}
