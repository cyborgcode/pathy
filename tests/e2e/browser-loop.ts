/**
 * Headless runner for the browser loop test.
 *
 * Serves the built bundle from an in-process static server and drives Chromium
 * at it. Everything runs inside this one process — no dev server to babysit,
 * and the thing under test is the same bundle the app ships.
 *
 * Failures print the page's own log rather than a bare timeout, because how
 * far it got is the useful part.
 */

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.E2E_PORT ?? 5199);
const DIST = resolve(process.cwd(), 'dist');
const BROWSER =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
};

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let path = decodeURIComponent(url.pathname);
        if (path.endsWith('/')) path += 'index.html';
        // Contain path traversal: this serves the build output and nothing else.
        const target = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
        if (!target.startsWith(DIST)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const info = await stat(target);
        if (!info.isFile()) {
          res.writeHead(404).end('not found');
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

async function main(): Promise<void> {
  let server: Server | null = null;
  let browser;
  let page;

  try {
    try {
      await stat(join(DIST, 'tests/e2e/loop.html'));
    } catch {
      throw new Error('dist/tests/e2e/loop.html missing — run `npm run build` first');
    }

    server = await serve();
    const base = `http://127.0.0.1:${PORT}`;
    console.log(`Serving dist/ at ${base}`);

    browser = await chromium.launch({
      executablePath: BROWSER,
      args: [
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        // The sandbox exports HTTPS_PROXY, which Chromium otherwise applies to
        // loopback too and then cannot reach the local test server.
        '--no-proxy-server',
      ],
    });
    page = await browser.newPage();

    page.on('console', (m) => {
      if (m.type() === 'error') console.error('  [page error]', m.text());
    });
    page.on('pageerror', (e) => console.error('  [page exception]', e.message));
    page.on('requestfailed', (r) =>
      console.error('  [request failed]', r.url(), r.failure()?.errorText),
    );
    page.on('response', (r) => {
      if (!r.ok()) console.error('  [http]', r.status(), r.url());
    });

    // Prove the server is reachable from this process before blaming the page.
    const probe = await fetch(`${base}/tests/e2e/loop.html`);
    console.log(`  self-probe: ${probe.status} ${probe.headers.get('content-type')}`);

    await page.goto(`${base}/tests/e2e/loop.html`, { waitUntil: 'domcontentloaded' });
    console.log('Running loop…');

    await page.waitForFunction(() => Boolean(window.__result), null, { timeout: 90000 });
    const result = (await page.evaluate(() => window.__result)) as {
      ok: boolean;
      detail: string;
    };

    console.log(`\n${result.ok ? 'PASS' : 'FAIL'}: ${result.detail}\n`);
    if (!result.ok) {
      const text = await page.evaluate(() => document.getElementById('log')?.textContent ?? '');
      console.error(text);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('e2e failed:', err);
    // The page's own log says how far it got, which is far more useful than
    // the timeout that surfaced it.
    if (page) {
      try {
        const text = await page.evaluate(() => document.getElementById('log')?.textContent ?? '');
        console.error('--- page log ---\n' + text);
      } catch {
        /* page already gone */
      }
    }
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server?.close();
  }
}

void main();
