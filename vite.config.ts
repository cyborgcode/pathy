import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// getUserMedia is stripped on insecure origins, so the dev server must be
// HTTPS even though the transfer itself never touches the network. Deploying
// to Pages sidesteps that: it serves HTTPS, so the receiving device gets its
// camera without any certificate ceremony.
//
// BASE_PATH is set by the Pages workflow to the repository name, since project
// pages are served from a subdirectory rather than the domain root. Locally it
// stays '/' so the dev server and the e2e runner are unaffected.
const base = process.env.BASE_PATH ?? '/';

// The headless loop test is only built when it is about to be run. It is a
// self-running 90-second test, which is not something to ship on the site.
const includeE2E = process.env.E2E === '1';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        send: resolve(__dirname, 'send.html'),
        receive: resolve(__dirname, 'receive.html'),
        ...(includeE2E ? { e2e: resolve(__dirname, 'tests/e2e/loop.html') } : {}),
      },
    },
  },
  worker: { format: 'es' },
  server: { host: true },
});
