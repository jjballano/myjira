import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // Quick tunnels get a new random subdomain each run.
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': 'http://localhost:3101' },
  },
});
