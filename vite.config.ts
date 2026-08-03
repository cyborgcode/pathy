import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// getUserMedia is stripped on insecure origins, so the dev server must be HTTPS
// even though the transfer itself never touches the network. `--host` plus a
// self-signed cert is the standard ceremony for testing on a real phone.
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        send: resolve(__dirname, 'send.html'),
        receive: resolve(__dirname, 'receive.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: { host: true },
});
