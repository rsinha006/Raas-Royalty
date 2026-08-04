import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.API_ORIGIN || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
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
