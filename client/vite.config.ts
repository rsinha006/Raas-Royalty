import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error — plain JS, shared with tests/service-worker.test.js
import { serviceWorkerPlugin } from './vite-plugin-sw.js';

const API = process.env.API_ORIGIN || 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  server: {
    port: 5173,
    host: true, // reachable from a phone on the same wifi during testing
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/socket.io': { target: API, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
