import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// Stamp the service worker's cache version with the build id so every
// deploy installs a fresh service worker, drops stale caches, and stops
// serving old JS bundles. Without this, the hardcoded cache name meant
// clients could stay pinned to an outdated build indefinitely.
function swCacheBust() {
  return {
    name: 'sw-cache-bust',
    writeBundle(options) {
      const buildId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const swPath = path.join(options.dir, 'sw.js');
      try {
        // NOTE: the placeholder prefix changed from drift- to lfdd- when the
        // app was forked; match either so the stamp actually lands.
        const src = fs.readFileSync(swPath, 'utf8').replace(/(drift|lfdd)-__BUILD_ID__/g, `lfdd-${buildId}`);
        fs.writeFileSync(swPath, src);
      } catch {
        /* sw.js absent — nothing to stamp */
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), swCacheBust()],
  // GitHub Pages serves this build from the /lfdd/ subdirectory, so all
  // asset URLs must be relative to that base or the app loads blank.
  base: '/lfdd/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Replit (and similar sandboxed hosts) serve previews on changing hostnames;
    // dev-only: allow any host so the preview isn't blocked by Vite's host check.
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
