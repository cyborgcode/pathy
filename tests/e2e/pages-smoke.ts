/**
 * Smoke test for the deployed layout.
 *
 * Serves `dist/` under a subdirectory prefix, exactly as GitHub Pages does for
 * a project site, and loads each page in Chromium at several viewport sizes.
 *
 * Two classes of problem this exists to catch, both of which produce a
 * perfectly valid build and only surface at runtime:
 *
 *  - **Base path.** A wrong `base` yields assets that 404 and inter-page links
 *    that escape the prefix. The server here 404s anything outside the prefix
 *    so those show up as failures rather than silently working.
 *  - **Mobile layout.** Horizontal overflow, tap targets too small to hit, and
 *    inputs under 16px (which makes Safari zoom the page in on focus and never
 *    zoom back out).
 *
 * Caveat worth stating plainly: this is Chromium emulating phone viewports.
 * It catches layout and sizing regressions; it is not a substitute for real
 * Safari, and it cannot verify iOS-specific behaviour like the safe-area
 * insets or the status bar style.
 */

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT ?? 5200);
const PREFIX = process.env.BASE_PATH ?? '/pathy/';
const DIST = resolve(process.cwd(), 'dist');
const BROWSER =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Apple's minimum comfortable touch target, and the one the CSS targets. */
const MIN_TAP = 44;
/** Below this, iOS Safari zooms the viewport when the field takes focus. */
const MIN_INPUT_FONT = 16;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let path = decodeURIComponent(url.pathname);

        // Anything outside the prefix is a 404 here, which is the whole point:
        // it catches links that would escape the project subdirectory.
        if (!path.startsWith(PREFIX)) {
          res.writeHead(404).end('outside base path');
          return;
        }
        path = path.slice(PREFIX.length - 1);
        if (path.endsWith('/')) path += 'index.html';

        const target = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
        if (!target.startsWith(DIST)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const body = await readFile(target);
        res.writeHead(200, {
          'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
          'content-length': String(body.length),
        });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}

const PAGES = ['', 'send.html', 'receive.html'];

interface Device {
  name: string;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

const DEVICES: Device[] = [
  { name: 'desktop', width: 1280, height: 800, scale: 1, mobile: false },
  { name: 'iPhone SE', width: 320, height: 568, scale: 2, mobile: true },
  { name: 'iPhone 14', width: 390, height: 844, scale: 3, mobile: true },
  { name: 'Pixel 7', width: 412, height: 915, scale: 2.6, mobile: true },
  { name: 'landscape', width: 844, height: 390, scale: 3, mobile: true },
];

/** Runs in the browser. Returns a list of layout complaints. */
function auditLayout(limits: { minTap: number; minFont: number }): string[] {
  const { minTap, minFont } = limits;
  const problems: string[] = [];

  const doc = document.documentElement;
  const overflow = doc.scrollWidth - doc.clientWidth;
  if (overflow > 1) {
    // Find what is actually sticking out, so the failure names a culprit.
    let widest = '';
    let worst = 0;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect();
      const past = r.right - doc.clientWidth;
      if (past > worst) {
        worst = past;
        widest = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${
          el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''
        }`;
      }
    }
    problems.push(`horizontal overflow ${overflow}px (worst: ${widest} +${Math.round(worst)}px)`);
  }

  const isVisible = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, summary, a.card'))) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < minTap - 0.5) {
      problems.push(`tap target ${el.tagName.toLowerCase()}#${el.id || '?'} is ${r.height.toFixed(0)}px tall`);
    }
  }

  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('input:not([type=checkbox]), select, textarea'),
  )) {
    if (!isVisible(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < minFont - 0.01) {
      problems.push(`input #${el.id || el.tagName} font-size ${size}px would trigger iOS zoom`);
    }
  }

  return problems;
}

/** Page-specific checks that only need to run once. */
const PROBES: Record<string, () => string> = {
  '': () => {
    const links = Array.from(document.querySelectorAll('a.card')).map((a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    );
    if (links.length !== 2) throw new Error(`expected 2 cards, got ${links.length}`);
    for (const href of links) {
      if (href?.startsWith('/')) throw new Error(`absolute link would escape base: ${href}`);
    }
    if (!document.querySelector('main')) throw new Error('no <main> landmark');
    return `cards -> ${links.join(', ')}`;
  },
  'send.html': () => {
    const sel = document.getElementById('profile') as HTMLSelectElement | null;
    if (!sel) throw new Error('no #profile');
    if (sel.options.length < 5) throw new Error(`profile list not populated (${sel.options.length})`);
    return `${sel.options.length} profiles`;
  },
  'receive.html': () => {
    const start = document.getElementById('start') as HTMLButtonElement | null;
    if (!start) throw new Error('no #start');
    if (start.disabled) throw new Error('start button disabled on load');
    const css = getComputedStyle(document.body).backgroundColor;
    if (css === 'rgba(0, 0, 0, 0)') throw new Error('stylesheet did not load');
    return `body bg ${css}`;
  },
};

/** Head tags every page needs for a decent install/mobile experience. */
function auditHead(): string[] {
  const problems: string[] = [];
  const need: Array<[string, string]> = [
    ['meta[name="viewport"][content*="viewport-fit=cover"]', 'viewport-fit=cover'],
    ['meta[name="theme-color"]', 'theme-color'],
    ['meta[name="description"]', 'description'],
    ['link[rel="manifest"]', 'manifest link'],
    ['link[rel="apple-touch-icon"]', 'apple-touch-icon'],
    ['meta[name="apple-mobile-web-app-capable"]', 'apple-mobile-web-app-capable'],
  ];
  for (const [sel, label] of need) {
    if (!document.querySelector(sel)) problems.push(`missing ${label}`);
  }
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest && manifest.getAttribute('href')?.startsWith('/')) {
    problems.push('manifest href is absolute and would escape the base path');
  }
  return problems;
}

async function checkPwaAssets(base: string): Promise<string[]> {
  const problems: string[] = [];

  const manifestRes = await fetch(`${base}manifest.webmanifest`);
  if (!manifestRes.ok) {
    problems.push(`manifest.webmanifest -> HTTP ${manifestRes.status}`);
  } else {
    const m = (await manifestRes.json()) as Record<string, unknown>;
    for (const key of ['name', 'start_url', 'display', 'icons', 'theme_color']) {
      if (!(key in m)) problems.push(`manifest missing "${key}"`);
    }
    const icons = (m.icons ?? []) as Array<{ src: string; sizes: string; purpose?: string }>;
    if (!icons.some((i) => i.sizes === '512x512')) problems.push('manifest has no 512x512 icon');
    if (!icons.some((i) => i.purpose?.includes('maskable'))) {
      problems.push('manifest has no maskable icon');
    }
    for (const icon of icons) {
      if (icon.src.startsWith('/')) problems.push(`icon src is absolute: ${icon.src}`);
    }
    if (typeof m.start_url === 'string' && m.start_url.startsWith('/')) {
      problems.push('manifest start_url is absolute and would escape the base path');
    }
  }

  for (const asset of ['sw.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    const res = await fetch(`${base}${asset}`);
    if (!res.ok) problems.push(`${asset} -> HTTP ${res.status}`);
  }

  return problems;
}

/**
 * The headline PWA claim, actually exercised: install the service worker, cut
 * the network, and check the app still loads.
 *
 * This is the one that matters most for this project. An app whose entire
 * premise is moving files with no network between the devices, but which needs
 * a connection to load the page that does it, is not much use.
 */
async function checkOffline(browser: Browser, base: string): Promise<string[]> {
  const problems: string[] = [];
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'load' });

    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'no serviceWorker API';
      const reg = await Promise.race([
        navigator.serviceWorker.ready.then(() => 'ready'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 10000)),
      ]);
      return reg;
    });
    if (registered !== 'ready') {
      problems.push(`service worker never activated (${registered})`);
      return problems;
    }

    // Give the install handler a moment to finish precaching before pulling
    // the network out from under it.
    await page.waitForTimeout(1200);
    await context.setOffline(true);

    for (const path of ['', 'send.html', 'receive.html']) {
      try {
        await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 15000 });
        const ok = await page.evaluate(() => {
          const main = document.querySelector('main');
          return Boolean(main && main.textContent && main.textContent.trim().length > 20);
        });
        if (!ok) problems.push(`offline ${path || '(index)'} loaded but rendered no content`);
      } catch (err) {
        problems.push(`offline ${path || '(index)'} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // And the JS actually has to run offline, not just the HTML shell arrive.
    try {
      await page.goto(`${base}send.html`, { waitUntil: 'load', timeout: 15000 });
      const opts = await page.evaluate(
        () => (document.getElementById('profile') as HTMLSelectElement | null)?.options.length ?? 0,
      );
      if (opts < 5) problems.push(`offline send.html did not run its module (${opts} profiles)`);
    } catch (err) {
      problems.push(`offline module check failed: ${err instanceof Error ? err.message : err}`);
    }
  } finally {
    await context.setOffline(false);
    await context.close();
  }
  return problems;
}

async function main(): Promise<void> {
  let server: Server | null = null;
  let browser: Browser | undefined;
  let failures = 0;
  const pass = (label: string, detail: string): void =>
    console.log(`  PASS  ${label.padEnd(26)} ${detail}`);
  const fail = (label: string, problems: string[]): void => {
    failures++;
    console.log(`  FAIL  ${label}`);
    for (const p of problems) console.log(`          ${p}`);
  };

  try {
    try {
      await stat(join(DIST, 'index.html'));
    } catch {
      throw new Error('dist/ missing — run `npm run smoke` (it builds first)');
    }

    server = await serve();
    const base = `http://127.0.0.1:${PORT}${PREFIX}`;
    console.log(`Serving dist/ at ${base}\n`);

    console.log('PWA assets');
    const pwa = await checkPwaAssets(base);
    if (pwa.length === 0) pass('manifest + sw + icons', 'all present and base-relative');
    else fail('PWA assets', pwa);

    browser = await chromium.launch({
      executablePath: BROWSER,
      // The sandbox exports HTTPS_PROXY, which Chromium would otherwise apply
      // to loopback and then fail to reach this server.
      args: ['--no-sandbox', '--no-proxy-server'],
    });

    for (const device of DEVICES) {
      console.log(`\n${device.name} (${device.width}x${device.height} @${device.scale}x)`);
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.scale,
        isMobile: device.mobile,
        hasTouch: device.mobile,
      });

      for (const pagePath of PAGES) {
        const page = await context.newPage();
        // tsx compiles through esbuild with keepNames on, which wraps every
        // function in a `__name` helper. That helper does not exist inside the
        // page, so any serialised function throws on arrival unless it is
        // provided.
        await page.addInitScript(() => {
          (window as unknown as { __name: <T>(fn: T) => T }).__name = (fn) => fn;
        });
        const problems: string[] = [];
        page.on('console', (m) => {
          if (m.type() === 'error') problems.push(`console: ${m.text()}`);
        });
        page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
        page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
        page.on('response', (r) => {
          if (!r.ok()) problems.push(`HTTP ${r.status()} ${r.url()}`);
        });

        let detail = '';
        try {
          await page.goto(`${base}${pagePath}`, { waitUntil: 'load', timeout: 30000 });
          problems.push(...(await page.evaluate(auditLayout, { minTap: MIN_TAP, minFont: MIN_INPUT_FONT })));
          problems.push(...(await page.evaluate(auditHead)));
          if (!device.mobile && PROBES[pagePath]) {
            detail = await page.evaluate(PROBES[pagePath]);
          }
          // Settings panels are collapsed by default; the inputs inside them
          // are exactly the ones at risk of the iOS zoom bug, so open them and
          // re-audit rather than declaring victory over hidden elements.
          const summary = await page.$('details summary');
          if (summary) {
            await summary.click();
            await page.waitForTimeout(120);
            problems.push(
              ...(await page.evaluate(auditLayout, { minTap: MIN_TAP, minFont: MIN_INPUT_FONT })),
            );
          }
        } catch (err) {
          problems.push(String(err instanceof Error ? err.message : err));
        }

        const label = `${pagePath || '(index)'}`;
        if (problems.length === 0) pass(label, detail || 'clean');
        else fail(`${device.name} / ${label}`, [...new Set(problems)]);
        await page.close();
      }
      await context.close();
    }

    console.log('\nOffline (service worker)');
    const offline = await checkOffline(browser, base);
    if (offline.length === 0) pass('airplane mode', 'all three pages load and run with no network');
    else fail('offline', offline);

    console.log(
      failures === 0
        ? `\nAll pages clean across ${DEVICES.length} viewports under ${PREFIX}\n`
        : `\n${failures} check(s) failed\n`,
    );
    if (failures > 0) process.exitCode = 1;
  } catch (err) {
    console.error('smoke test failed:', err);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server?.close();
  }
}

void main();
