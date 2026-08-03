# Photon — file transfer over light

Send a file between two devices using nothing but a screen and a camera. One
page paints the file as an endless run of colour grids; the other points its
camera at them and rebuilds the file. No network path between the devices, no
pairing, no app, no permission beyond the camera.

This is a rebuild of the idea behind
[decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer),
aimed at the two things that limited it: **speed** and **file size**.

|                        | Original (QR)              | Photon                                    |
| ---------------------- | -------------------------- | ----------------------------------------- |
| Bits per cell          | 1 (black/white)            | **3** (eight colours, one bit per channel) |
| Payload per frame      | 2 953 B (QR v40-L)         | **7 805 B** default, up to 20 559 B       |
| Decode cost per frame  | tens of ms (zxing-cpp WASM)| **12–30 ms**, 4 workers → 130–320 fps ceiling |
| Receiver bundle        | ~2.1 MB WASM               | **~50 kB**, no WASM                       |
| Practical file size    | 2 MB ("go make coffee" past that) | **bounded RAM at any size** — GB-scale |
| Measured goodput       | ~129 KB/s typical          | **457 KB/s** handheld @60 fps             |

## Measured throughput

Numbers below come from `npm run bench`, which pushes rendered frames through a
simulated screen-to-camera channel — perspective, optical blur, 4:2:0 chroma
subsampling, gamma, white-balance error, glare, sensor noise — and counts only
frames that came back **bit-exact**.

Goodput at 60 fps display, receiver running 4 decode workers:

| Conditions | Profile         | Frames OK | Goodput      |
| ---------- | --------------- | --------- | ------------ |
| tripod     | 224 · dense     | 100%      | **889 KB/s** |
| tripod     | 160 · default   | 100%      | 457 KB/s     |
| handheld   | 160 · default   | 100%      | **457 KB/s** |
| handheld   | 128             | 100%      | 287 KB/s     |
| rough      | 96 · robust     | 100%      | 146 KB/s     |

Against the original's reported ~129 KB/s typical and ~186 KB/s propped still,
that is roughly **3.5× handheld** and **4.8× at the ceiling** — and the worst
case here still beats the original's typical case.

**These are simulated-channel numbers, not real-device numbers.** The channel
model is in `bench/channel.ts` and is deliberately explicit about what it
assumes; real phones vary, and the honest way to read the table is as a
comparison between profiles under identical conditions rather than as a
promise about your hardware. What is *not* simulated is the browser plumbing —
that is covered separately by a headless end-to-end test that moves a real
file through a real `MediaStream` and verifies SHA-256.

## Where the speed comes from

**Three bits per cell instead of one.** Each cell is one of eight saturated
colours, with R, G and B each carrying an independent bit — so a misread
channel costs exactly one bit, and per-channel thresholding is both the
fastest and the most robust way to decode. QR also spends about a quarter of
its modules on ECC that was designed for print, plus version blocks, alignment
patterns and mask bookkeeping. Here the only fixed costs are four corner
markers, a control strip and a colour calibration strip.

**A decoder that keeps up.** This is the part that quietly caps the original:
its receiver drops frames whenever its WASM workers fall behind, which at
60 fps is most of them. Finding four markers and resampling a grid costs
12–30 ms, so with a handful of workers the *display* becomes the bottleneck
rather than the camera. Denser frames actually translate into throughput.

**Error correction sized for this channel.** Reed–Solomon over GF(256),
interleaved across the frame so a glare blob becomes a byte or two in each of
many shards instead of a burst that destroys one. Frames that are 96% correct
get repaired rather than thrown away — and with the fountain layer above it,
frame loss becomes the only thing left to absorb.

Three decoder details turned out to matter as much as the encoding, all found
by the benchmark rather than guessed at:

- **Local thresholds.** Each cell is compared against an average of the data
  cells around it, not one number for the whole frame. Glare and vignetting
  vary slowly, so a local average tracks them for free.
- **Whitening.** Local thresholds need a balanced cell distribution. A
  degree-1 fountain frame carrying a run of zeros does not provide one, so the
  coded stream is XOR-ed against a fixed pseudorandom sequence first.
- **Sharpening in cell space, harder on chroma than luma.** At five pixels per
  cell, optical bleed alone flips channels. Cameras degrade chroma far more
  than luma (4:2:0 plus chroma denoise), so the two get different gains.

## Where the volume comes from

The original holds the whole file as one block set, so decoder memory scales
with file size and a 2 MB payload is about the practical limit.

Here the file is cut into **windows** of a couple of MB, each with its own
fountain, block count and seed. The decoder only ever holds a few windows at
once and writes each one to disk the moment it completes, so **peak memory is
a function of window size, not file size**. The sender reads with
`File.slice()` and hashes incrementally, so it never holds the file either.

The sender loops over windows forever. That is what makes it self-healing:
a receiver that joins late, loses focus mid-window, or gets overtaken while
the sender moves on simply completes that window on the next pass. Nothing is
ever retransmitted on request, because on a one-way optical link nothing can
be.

## Running it

**→ [cyborgcode.github.io/pathy](https://cyborgcode.github.io/pathy/)**

Open that on both devices — **Send** on the one holding the file, **Receive**
on the one with the camera — and point the second at the first. Nothing to
install, and the page is static, so once it has loaded neither device needs
the network again for the transfer itself.

Hosting it matters more than it sounds: `getUserMedia` is stripped on insecure
origins, so running locally means an HTTPS dev server and a certificate
exception on the receiving device — a lot of ceremony for a transfer that
never touches the network. Pages serves HTTPS, so that all goes away.

**Install it.** It is a PWA: add it to the home screen on either device and it
opens standalone, with its own icon and no browser chrome. More to the point,
it works with the network off. An app whose whole premise is moving files
between devices that cannot reach each other, but which needs a connection to
load the page that does it, would be missing the plot — so the service worker
precaches the shell and both devices can be in airplane mode from then on.

Locally:

```bash
npm install
npm run dev          # https dev server, --host so a phone on the LAN can reach it
```

```bash
npm test             # unit + end-to-end transfer tests
npm run bench        # throughput across profiles and conditions
npm run e2e          # headless Chromium: real MediaStream, real workers
npm run smoke        # base path, mobile viewports, PWA assets, offline load
npm run build        # typecheck + production bundle
```

### Deployment

`.github/workflows/pages.yml` typechecks, runs the test suite, builds with
`BASE_PATH` set to the repository name, and force-pushes `dist/` to the
`gh-pages` branch on every push.

**One-time setup:** Settings → Pages → Source → *Deploy from a branch*, branch
`gh-pages`, folder `/ (root)`. Until that is set, the workflow publishes the
branch successfully but nothing is served.

It publishes a branch rather than uploading a Pages artifact because the
artifact route goes through the Pages REST API, and the Actions token is
refused by it — `Resource not accessible by integration`, i.e. it cannot
create or configure a Pages site. Pushing a branch needs only
`contents: write`.

Two things about a project-pages deploy are easy to get wrong and invisible
until someone clicks: assets need the `/<repo>/` prefix, and inter-page links
must be relative or they escape it. `npm run smoke` serves the build under a
subdirectory and loads every page in Chromium to check exactly that — a wrong
base path still produces a perfectly valid bundle.

## Interface

An instrument panel for an optical link, built like one: monospace throughout,
terse field labels over fixed-width figures, compartments ruled off by
hairlines, right angles only. The index carries a spec sheet rather than
paragraphs describing the same facts in sentences.

Dark is the operating condition rather than a preference. The sender's screen
is a light source aimed at the other device's camera, and every bright pixel
of interface chrome is stray light in that camera's exposure metering — a dark
panel lets the code's own contrast dominate the frame. There is deliberately
no light variant.

Colour is down to two accents with one job each: aviation red for hazard and
focus, terminal green only for a transfer that completed and verified. Type is
system-stacked; a blocking webfont is the last thing an offline-first app
should ask for on a cold install.

The CRT scanline layer is held strictly below the transmit stage in the
stacking order. An overlay across the code canvas would be modulating the very
signal the receiving camera is trying to read.

Built following [taste-skill](https://github.com/Leonxlnx/taste-skill)'s
`industrial-brutalist-ui`, with the mobile pass before it following the same
repo's `redesign-existing-projects`.

## Mobile

Both devices in a transfer are usually phones, so the phone case is the main
case rather than an afterthought.

What actually bites on a phone, and what was done about it:

- **`100vh` is wrong on iOS.** Safari resolves it against the tallest possible
  viewport, so the bottom of the code sat under the toolbars until you
  scrolled. Now `dvh`, which tracks the toolbars as they collapse. The sender
  canvas also sizes itself from `visualViewport` rather than `innerHeight`,
  for the same reason, and re-lays out on rotate.
- **Safe areas.** The pages ship `viewport-fit=cover` to reach edge-to-edge,
  which puts content under the notch and the home indicator unless it is
  padded back out with `env(safe-area-inset-*)`.
- **Safari zooms in on focused inputs under 16px and never zooms back out.**
  Every field is 16px exactly, not inherited.
- **Tap targets.** Everything touchable is at least 44px, with pressed-state
  feedback — on a phone there is no hover to preview an action with.
- **Pull-to-refresh mid-transfer** reloads the tab and discards everything
  decoded so far. `overscroll-behavior-y: none`.
- **Screen dimming.** Neither device is touched while a transfer runs, which
  is exactly what a phone reads as idle. Both pages hold a screen wake lock,
  and re-acquire it on becoming visible again, because the lock is dropped
  whenever the page is hidden.

`npm run smoke` checks the measurable parts across five viewports — no
horizontal overflow, tap target sizes, input font sizes, the head tags, the
manifest and icons, and an offline load with the network cut. It is Chromium
emulating phone viewports, so it catches layout regressions but is not a
substitute for real Safari, and it cannot verify the safe-area insets.

One deliberate departure from the skill's advice: it opens with "swap the
font" as the highest-impact change. Not here. A webfont is a blocking download
that the offline-first goal has to pay for on every cold install, for a
utility whose screen time is mostly a colour grid. System fonts stay.

## How a frame is put together

```
┌───────────────────────────────────────────┐
│ ▣                  control              ▣ │   corner markers: 1:1:3:1:1,
│                                           │   four of them, so perspective
│        160 × 160 data cells               │   is solved exactly rather than
│        8 colours = 3 bits each            │   approximated
│                                           │
│ ▣               calibration             ▣ │   control strip: profile id
└───────────────────────────────────────────┘   calibration: all 8 colours
```

Every frame is self-describing — session id, sequence number, window index,
block count, block size, CRC — so a receiver can lock onto a stream already in
flight from the first frame it happens to catch. Restarting the sender mints a
new session id, which the receiver notices and resets itself on. That is the
whole of the "protocol"; there is no handshake because there is no back
channel to handshake over.

The sender emits a manifest frame every 32 frames carrying the filename, MIME
type, total size and SHA-256, so a late joiner does not have to wait long to
learn what is arriving.

### Profiles

The receiver reads the profile out of the control strip, so the sender can
change density mid-stream and the receiver follows without being told.

| id | grid | bits/cell | payload/frame | for                        |
| -- | ---- | --------- | ------------- | -------------------------- |
| 0  | 96   | 3         | 2 484 B       | worst conditions           |
| 2  | 160  | 3         | 7 805 B       | **default**                |
| 3  | 192  | 3         | 11 150 B      | steady hold, close camera  |
| 5  | 256  | 3         | 20 559 B      | tripod only                |
| 7  | 160  | 1         | 2 453 B       | mono fallback              |

If the receiver stalls, step *down* a profile before changing anything else.

## Layout

```
src/core/      physical + coding layers, no DOM — all of it runs under Node
  rng.ts       xoshiro128** + detLn (see below)
  soliton.ts   robust soliton degree distribution, integer CDF
  rs.ts        Reed-Solomon GF(256), interleaved across the frame
  fountain.ts  windowed LT encode/decode with incremental peeling
  profile.ts   frame geometry and density profiles
  render.ts    rasteriser (packed 32-bit writes)
  detect.ts    marker search, adaptive binarisation
  decode.ts    resample, sharpen, threshold, correct
  session.ts   window scheduling, manifests, sinks
src/sender/    sender page
src/receiver/  receiver page + decode worker
src/ui/        stylesheet, service worker registration, screen wake lock
public/        manifest, service worker, generated icons
tools/         icon generator
bench/         channel simulation and throughput benchmark
tests/         unit, transfer, and headless browser tests
```

### One inherited bug worth keeping fixed

`Math.log` is not specified to bit precision, and V8 and JavaScriptCore
disagree in the low mantissa bits. That is enough to move a degree-distribution
bucket boundary, which desynchronises sender and receiver — a file that
accumulates frames forever and never decodes. The original hit this and worked
around it; here `detLn` in `src/core/rng.ts` avoids `Math.log` entirely,
building the logarithm from operations ECMAScript does specify exactly.

## Prior art

The idea is old and has been done well several times. Worth reading:

- [bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) — the direct inspiration for this rebuild
- [divan/txqr](https://github.com/divan/txqr) (2018) — animated QR + fountain codes, with two excellent write-ups
- [sz3/libcimbar](https://github.com/sz3/libcimbar) — abandons QR for a purpose-built colour code, and gets there first
- Timex Data Link (1994) — data over CRT flicker

## Licence

MIT.
