/**
 * Service worker.
 *
 * Offline is not a nice-to-have here. The entire premise is moving a file
 * between two devices with no network path between them, and a version that
 * needs a working connection to load the page it does that with is a bit of a
 * joke. Once installed, both devices can go into airplane mode and the app
 * still opens.
 *
 * Two strategies, split by what the resource is:
 *
 *  - **Navigations: network-first.** HTML filenames are stable, so
 *    cache-first would pin users to whatever version they installed and never
 *    let go. Network-first serves fresh pages when there is a connection and
 *    the cached copy when there is not.
 *
 *  - **Everything else: cache-first.** Built assets carry a content hash in
 *    the filename, so a given URL's bytes never change. Going to the network
 *    for them would be wasted latency.
 */

const VERSION = 'photon-v1';
const CACHE = `${VERSION}`;

// Resolved against the worker's own scope, so this is correct whether the app
// is served from a domain root or a project subdirectory.
const PRECACHE = [
  './',
  './index.html',
  './send.html',
  './receive.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, not addAll: addAll rejects the whole install if any one
      // request fails, and losing offline support over a single icon is a bad
      // trade.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            const url = new URL(path, self.registration.scope);
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline at install time, or the path does not exist */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Range requests (media seeking) must not be served from the cache as a
  // whole response; let the network handle them.
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = (await caches.match(req)) ?? (await caches.match(new URL('./index.html', self.registration.scope)));
          if (cached) return cached;
          return new Response('Offline, and this page was never cached.', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
