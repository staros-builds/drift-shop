import { defineConfig, loadEnv } from 'vite';
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
        // Stamp the driftshop- placeholder with the build id.
        const src = fs.readFileSync(swPath, 'utf8').replace(/(driftshop|drift|lfdd)-__BUILD_ID__/g, `driftshop-${buildId}`);
        fs.writeFileSync(swPath, src);
      } catch {
        /* sw.js absent — nothing to stamp */
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // The built app must allow connections ONLY to the shop's own backend.
  // The CSP meta in index.html carries %SUPABASE_ORIGIN% / %SUPABASE_ORIGIN_WS%
  // placeholders; pin them here from the build env so pointing a build at a
  // different backend (a buyer's own project, a standby copy) is a
  // one-variable rebuild (VITE_SUPABASE_URL) instead of an ever-growing
  // hardcoded list. Fallback = the current production project.
  const supabaseUrl =
    env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://mkbozzeucotbxilkpapd.supabase.co';
  let supabaseOrigin = supabaseUrl.replace(/\/+$/, '');
  let supabaseWs = supabaseOrigin;
  try {
    const u = new URL(supabaseUrl);
    supabaseOrigin = u.origin;
    supabaseWs = u.origin.replace(/^http/, 'ws');
  } catch { /* keep string forms */ }

  return {
    plugins: [
      react(),
      swCacheBust(),
      {
        name: 'csp-supabase-origin',
        transformIndexHtml(html) {
          return html
            .split('%SUPABASE_ORIGIN_WS%').join(supabaseWs)
            .split('%SUPABASE_ORIGIN%').join(supabaseOrigin);
        },
      },
    ],
    // Relative base ('./'), NOT a fixed subpath: the SAME dist/ must run at
    // any path on any static host — GitHub Pages serves the project site
    // from /drift-shop/, other static hosts serve at the domain root or
    // their own subpath. Absolute asset URLs would 404 everywhere else.
    // (Multi-host redundancy — see docs/api-compat.md.)
    base: './',
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
    // App version from package.json, available as import.meta.env.VITE_APP_VERSION.
    // Settings → About displays this so the visible version can never drift
    // from the release version.
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        (() => { try { return JSON.parse(fs.readFileSync('package.json', 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })()
      ),
    },
  };
});
