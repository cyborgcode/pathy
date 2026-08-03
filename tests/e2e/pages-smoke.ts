/**
 * Smoke test for the deployed layout.
 *
 * Serves `dist/` under a subdirectory prefix, exactly as GitHub Pages does for
 * a project site, and loads each page in Chromium. The build succeeding proves
 * nothing here: a wrong base path produces a perfectly valid bundle whose
 * assets 404 at runtime, and inter-page links that escape the prefix are
 * invisible until someone clicks one.
 *
 * Checks per page: no console errors, no failed requests, and a signal that
 * the page's own module actually ran.
 */

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT ?? 5200);
const PREFIX = process.env.BASE_PATH ?? '/pathy/';
const DIST = resolve(process.cwd(), 'dist');
const BROWSER =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
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

interface Check {
  page: string;
  /** Runs in the browser; return a short string on success, or throw. */
  probe: () => string;
}

const CHECKS: Check[] = [
  {
    page: '',
    probe: () => {
      const links = Array.from(document.querySelectorAll('a.card')).map((a) =>
        (a as HTMLAnchorElement).getAttribute('href'),
      );
      if (links.length !== 2) throw new Error(`expected 2 cards, got ${links.length}`);
      for (const href of links) {
        if (href?.startsWith('/')) throw new Error(`absolute link would escape base: ${href}`);
      }
      return `cards -> ${links.join(', ')}`;
    },
  },
  {
    page: 'send.html',
    probe: () => {
      // A populated profile dropdown means the module ran and the core
      // imports resolved under the base path.
      const sel = document.getElementById('profile') as HTMLSelectElement | null;
      if (!sel) throw new Error('no #profile');
      if (sel.options.length < 5) throw new Error(`profile list not populated (${sel.options.length})`);
      const back = document.querySelector('.sub a') as HTMLAnchorElement | null;
      if (back?.getAttribute('href')?.startsWith('/')) throw new Error('back link escapes base');
      return `${sel.options.length} profiles, e.g. "${sel.options[2]?.textContent?.trim()}"`;
    },
  },
  {
    page: 'receive.html',
    probe: () => {
      const start = document.getElementById('start') as HTMLButtonElement | null;
      if (!start) throw new Error('no #start');
      if (start.disabled) throw new Error('start button disabled on load');
      const css = getComputedStyle(document.body).backgroundColor;
      if (css === 'rgba(0, 0, 0, 0)') throw new Error('stylesheet did not load');
      return `start enabled, body bg ${css}`;
    },
  },
];

async function main(): Promise<void> {
  let server: Server | null = null;
  let browser;
  let failures = 0;

  try {
    try {
      await stat(join(DIST, 'index.html'));
    } catch {
      throw new Error('dist/ missing — run `BASE_PATH=/pathy/ npm run build` first');
    }

    server = await serve();
    const base = `http://127.0.0.1:${PORT}${PREFIX}`;
    console.log(`Serving dist/ at ${base}\n`);

    browser = await chromium.launch({
      executablePath: BROWSER,
      // The sandbox exports HTTPS_PROXY, which Chromium would otherwise apply
      // to loopback and then fail to reach this server.
      args: ['--no-sandbox', '--no-proxy-server'],
    });

    for (const check of CHECKS) {
      const page = await browser.newPage();
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
      page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
      page.on('response', (r) => {
        if (!r.ok()) problems.push(`HTTP ${r.status()} ${r.url()}`);
      });

      const url = `${base}${check.page}`;
      let detail = '';
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        detail = await page.evaluate(check.probe);
      } catch (err) {
        problems.push(String(err instanceof Error ? err.message : err));
      }

      const label = check.page || '(index)';
      if (problems.length === 0) {
        console.log(`  PASS  ${label.padEnd(14)} ${detail}`);
      } else {
        failures++;
        console.log(`  FAIL  ${label.padEnd(14)} ${detail}`);
        for (const p of problems) console.log(`          ${p}`);
      }
      await page.close();
    }

    console.log(
      failures === 0
        ? `\nAll ${CHECKS.length} pages load correctly under ${PREFIX}\n`
        : `\n${failures} of ${CHECKS.length} pages failed\n`,
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
